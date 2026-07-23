"""Session lifecycle, subscriptions and per-client backpressure (M1 T7).

Design spec §6.3 and §11. The load-bearing semantics:

- A :class:`Session` is one per ``(market, symbol, mode[, source])`` key. It
  owns the feed task and the :class:`~flowmap_server.core.grid.Grid`; send
  queues, lag and drop state are strictly per-client (:class:`ClientTx`).
- **Snapshot on attach** (§6.3): ``Hello`` first, then an ``EpochStart`` for
  EVERY distinct epoch present in the snapshot's columns (plus the current
  one, ascending), then the last ≤512 finalized depth+bar columns chunked
  into ≤64-column frames, then Markers in that column range, then the last
  ≤500 trades (tape warm-up), then the current BBO if known. All frames are
  pre-encoded bytes; a frame is the ``b"".join`` of its messages. History
  responses announce their epochs the same way.
- **Backpressure** (§6.3): FINALIZED depth/bar column frames are never
  coalesced; PARTIAL right-edge re-emissions coalesce latest-wins per
  ``t0_ns``. When the oldest queued column has sat unsent for >2 s
  (injectable monotonic clock), whole columns are dropped oldest-first and
  ONE ``Marker{kind=gap}`` is enqueued per contiguous drop run (runs merge
  across offers while the drop point stays adjacent to the previous run's
  marker). The marker count is real COLUMNS: the depth+bar pair sharing a
  ``t0_ns`` counts once, and dropped stale partials never count (their final
  frame may still be delivered). Dropped columns remain in the grid ring,
  recoverable via ``HistoryRequest``. Non-column messages
  (tape/BBO/markers/status) are capped at 1000 with silent drop-oldest —
  latest-wins is acceptable at M1.
- **Lifecycle** (§11): sessions are refcounted by subscribers; teardown fires
  after the last detach plus a 60 s grace (injectable timer). A crashed feed
  restarts with exponential backoff (cap 30 s) and reports transitions via
  ``Status``; other sessions are unaffected.
- **Recording + rehydration** (§7/§8.1, M1 T11): a live-mode session with a
  :class:`~flowmap_server.core.record.Recorder` self-records epoch params
  (initial + every re-anchor), every finalized column, trades and markers.
  Flush cadence: every ``REC_FLUSH_COLS`` recorded columns, when the feed
  loop exits (server shutdown), and on teardown (``close()``); each flush is
  followed by ``enforce_retention()``. Every recorder call is wrapped: on
  exception it is logged and recording is disabled for the session —
  recording failures NEVER kill the feed loop. Before the feed task starts,
  ``start()`` rehydrates the grid ring from the newest recording via
  ``load_tail`` (run in the default executor so the event loop — and other
  sessions' attaches — never block on Parquet IO) and emits a
  ``Marker{kind=gap}`` between the recorded tail and live; a stale/absent/
  unusable tail means a cold start. Because rehydration only happens when a
  Recorder is wired in (SessionManager default: none), deterministic sim
  tests never depend on a previous run's recordings.

Everything is asyncio, single-threaded, no locks (the only lock serializes
``start()``'s boot phase): attach/snapshot/broadcast never await between
observing grid state and enqueueing, so per-client frame order is exactly
stream order.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import deque
from collections.abc import Callable
from typing import Protocol

import msgspec
import numpy as np

from flowmap_server.config import Config
from flowmap_server.core.grid import FinalizedColumn, Grid, GridCfg
from flowmap_server.core.record import Recorder, SessionRecorder, TailData
from flowmap_server.feeds.base import BookState, Feed
from flowmap_server.feeds.crypto import CRYPTO_MARKETS, CryptoFeed
from flowmap_server.feeds.equity import EQUITY_MARKETS, EquityFeed
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto import events, wire

__all__ = ["ClientTx", "Session", "SessionLimitError", "SessionManager"]

logger = logging.getLogger(__name__)

# --- spec §6.3 / §11 constants --------------------------------------------------
SNAPSHOT_COLS = 512  # last N finalized columns in the attach snapshot
SNAPSHOT_CHUNK_COLS = 64  # ≤N columns per snapshot frame
SNAPSHOT_TAPE = 500  # tape warm-up depth
HISTORY_MAX_COLS = 256  # per-HistoryRequest clamp
LAG_DROP_NS = 2_000_000_000  # oldest-unsent column age that triggers drops
NONCOL_CAP = 1000  # bounded non-column queue (latest-wins)
GRACE_S = 60.0  # teardown grace after last detach
FLUSH_INTERVAL_NS = 50_000_000  # right-edge partial re-send cadence (20 Hz)
REC_FLUSH_COLS = 64  # recording flush cadence (finalized columns)
_BACKOFF_CAP_S = 30.0
# Backoff resets to base only once a restarted feed proves stable: it has run
# for >=5 s (injectable clock) or delivered >=100 events, whichever first. A
# yield-one-then-crash flapper therefore keeps escalating to the 30 s cap.
_STABLE_NS = 5_000_000_000
_STABLE_EVENTS = 100
_MARKERS_CAP = 1024  # bounded marker memory for snapshot/history
_T_MAX = 2**63 - 1
# big_trades note: HistoryResponse.big_trades stays [] at M1 — the rolling-
# percentile large-lot threshold that selects them arrives with the feature
# engines (T10); the wire field and this serving path are already in place.

Clock = Callable[[], int]  # monotonic ns


class TimerHandle(Protocol):
    def cancel(self) -> None: ...


Timer = Callable[[float, Callable[[], None]], TimerHandle]


def _default_timer(delay_s: float, cb: Callable[[], None]) -> TimerHandle:
    return asyncio.get_running_loop().call_later(delay_s, cb)


# --- per-client bounded queue ---------------------------------------------------


class _Frame:
    __slots__ = ("col", "data", "enq_ns", "is_partial", "protected", "t0_ns")

    def __init__(
        self,
        data: bytes,
        col: bool,
        t0_ns: int | None,
        enq_ns: int,
        protected: bool = False,
        is_partial: bool = False,
    ) -> None:
        self.data = data
        self.col = col
        self.t0_ns = t0_ns
        self.enq_ns = enq_ns
        self.protected = protected
        self.is_partial = is_partial


class _Gap:
    """Placeholder for a contiguous run of dropped columns; encoded lazily at
    drain time so a run growing across offers still yields ONE Marker.

    ``count`` is real COLUMNS, not frames: a finalized column arrives as two
    frames (depth+bar sharing ``t0_ns``) and is counted once, via the
    ``last_t0_ns`` dedup in ``_evict_lagged``. Partial re-emissions never
    reach a gap run at all."""

    __slots__ = ("count", "first_t0_ns", "last_t0_ns")

    def __init__(self, t0_ns: int) -> None:
        self.first_t0_ns = t0_ns
        self.last_t0_ns = t0_ns
        self.count = 1


class ClientTx:
    """Per-client bounded send queue with lag/drop state (spec §6.3).

    Entries stay FIFO across column and non-column frames. FINALIZED column
    frames are never coalesced; they are dropped whole (oldest-first) once
    their unsent age exceeds ``lag_ns``, leaving one gap Marker per contiguous
    drop run whose count is real columns (a depth+bar pair sharing ``t0_ns``
    counts once). PARTIAL column frames (``is_partial=True``, the 20 Hz
    right-edge re-emissions) coalesce latest-wins per ``t0_ns``: at most one
    undrained depth+bar partial pair stays queued per column, and a
    lag-dropped partial is never counted as a lost column (its final frame
    may still be delivered).
    Non-column frames are capped at ``noncol_cap`` with silent drop-oldest.
    """

    def __init__(
        self,
        clock: Clock = time.monotonic_ns,
        *,
        lag_ns: int = LAG_DROP_NS,
        noncol_cap: int = NONCOL_CAP,
    ) -> None:
        self._clock = clock
        self._lag_ns = lag_ns
        self._noncol_cap = noncol_cap
        self._q: list[_Frame | _Gap] = []
        self._noncol = 0

    def __len__(self) -> int:
        return len(self._q)

    def offer(
        self,
        msg_bytes: bytes,
        *,
        col_msg: bool,
        t0_ns: int | None = None,
        protected: bool = False,
        is_partial: bool = False,
    ) -> None:
        now = self._clock()
        if col_msg:
            if t0_ns is None:
                raise ValueError("column frames must carry t0_ns")
            self._evict_lagged(now)
            if is_partial:
                # Latest-wins per t0: at most one partial pair (depth+bar)
                # stays queued per column. Beyond two frames the oldest is
                # superseded and removed — flushes always emit depth-then-bar,
                # so FIFO eviction keeps replacements kind-paired.
                first_i: int | None = None
                n_same = 0
                for i, e in enumerate(self._q):
                    if isinstance(e, _Frame) and e.is_partial and e.t0_ns == t0_ns:
                        if first_i is None:
                            first_i = i
                        n_same += 1
                if n_same >= 2 and first_i is not None:
                    del self._q[first_i]
            self._q.append(_Frame(msg_bytes, True, t0_ns, now, protected, is_partial))
            return
        self._q.append(_Frame(msg_bytes, False, t0_ns, now, protected))
        if protected:
            # Snapshot frames: exempt from (and not counted toward) the
            # non-column cap — a tape/BBO flood must never evict Hello.
            return
        self._noncol += 1
        if self._noncol > self._noncol_cap:
            for i, e in enumerate(self._q):
                if isinstance(e, _Frame) and not e.col and not e.protected:
                    del self._q[i]
                    self._noncol -= 1
                    break

    def _evict_lagged(self, now_ns: int) -> None:
        """Drop whole columns whose unsent age exceeds ``lag_ns``.

        Entries are enqueue-ordered, so lagged frames form a prefix; the scan
        stops at the first fresh frame. A dropped column merges into an
        immediately preceding gap run (one Marker per contiguous run, even
        when the run grows across many offers); gap markers themselves and
        non-column frames are never lag-dropped.

        Gap accounting is per COLUMN, not per frame: consecutive finalized
        frames sharing ``t0_ns`` (the depth+bar pair) bump the run count once.
        Evicted PARTIAL frames are stale right-edge re-emissions — superseded
        data, not lost columns (the final may still be delivered) — so they
        are dropped silently and never counted toward a gap run.
        """
        threshold = now_ns - self._lag_ns
        q = self._q
        out: list[_Frame | _Gap] = []
        idx = 0
        dropped = False
        while idx < len(q):
            e = q[idx]
            if isinstance(e, _Frame):
                if e.enq_ns >= threshold:
                    break  # everything after is newer
                if e.col:
                    assert e.t0_ns is not None
                    dropped = True
                    idx += 1
                    if e.is_partial:
                        continue  # stale partial: drop, never a gap column
                    tail = out[-1] if out else None
                    if isinstance(tail, _Gap):
                        if tail.last_t0_ns != e.t0_ns:  # depth+bar: count once
                            tail.last_t0_ns = e.t0_ns
                            tail.count += 1
                    else:
                        out.append(_Gap(e.t0_ns))
                    continue
            out.append(e)
            idx += 1
        if dropped:
            self._q = out + q[idx:]

    def drain(self, max_bytes: int) -> list[bytes]:
        """Pop frames FIFO up to ``max_bytes`` total.

        Always returns at least one frame when the queue is non-empty, so a
        single frame larger than the budget cannot wedge the queue. Gap runs
        encode to their Marker frame here.
        """
        out: list[bytes] = []
        total = 0
        taken = 0
        for e in self._q:
            if isinstance(e, _Frame):
                data = e.data
            else:
                data = wire.encode(
                    events.Marker(
                        ts_ns=e.first_t0_ns,
                        kind="gap",
                        text=f"backpressure: dropped {e.count} columns",
                    )
                )
            if out and total + len(data) > max_bytes:
                break
            out.append(data)
            total += len(data)
            taken += 1
            if isinstance(e, _Frame) and not e.col and not e.protected:
                self._noncol -= 1
        del self._q[:taken]
        return out


# --- session --------------------------------------------------------------------


class Session:
    """One live stream per (market, symbol, mode[, source]): feed + grid.

    Broadcast fan-out pre-encodes each message once and offers the same bytes
    to every attached client; lag/drop bookkeeping happens inside each
    :class:`ClientTx`.
    """

    def __init__(
        self,
        session_id: str,
        *,
        feed: Feed,
        grid: Grid,
        clock: Clock = time.monotonic_ns,
        timer: Timer = _default_timer,
        on_teardown: Callable[[], None] | None = None,
        flush_interval_ns: int = FLUSH_INTERVAL_NS,
        restart_backoff_base_s: float = 1.0,
        grace_s: float = GRACE_S,
        recorder: Recorder | None = None,
        wall_clock: Clock = time.time_ns,
    ) -> None:
        self.session_id = session_id
        self.run_task: asyncio.Task | None = None
        self._feed = feed
        self._grid = grid
        self._clock = clock
        self._timer = timer
        self._on_teardown = on_teardown
        self._flush_interval_ns = flush_interval_ns
        self._backoff_base_s = restart_backoff_base_s
        self._backoff_s = restart_backoff_base_s
        self._grace_s = grace_s

        # Recording (module docstring): the root opens the per-symbol writer
        # and serves load_tail at boot; wall_clock (injectable) is the §8.1
        # freshness reference — recorded timestamps are UTC wall ns.
        self._recorder_root = recorder
        self._wall_clock = wall_clock
        self._rec: SessionRecorder | None = None
        self._cols_since_flush = 0
        self._boot_done = False
        self._start_lock = asyncio.Lock()

        self._clients: set[ClientTx] = set()
        self._grace_handle: TimerHandle | None = None
        self._closed = False

        self._last_col_seq: int | None = None  # dedup: grid may re-return a column
        self._last_flush_ns = clock()
        self._feed_state: str = "live"
        self._recovery_start_ns = clock()
        self._recovery_events = 0
        self._tape: deque[events.Trade] = deque(maxlen=SNAPSHOT_TAPE)
        self._markers: deque[events.Marker] = deque(maxlen=_MARKERS_CAP)
        self._bbo: events.BBO | None = None

    # -- lifecycle -------------------------------------------------------------

    async def start(self) -> asyncio.Task:
        """Boot (open recorder + rehydrate, once) and start the feed task.

        Idempotent and restart-safe. The boot phase runs BEFORE the run task
        exists and before the caller attaches, so the first subscriber's
        snapshot already contains the rehydrated tail; the lock makes a
        concurrent second subscriber wait for the same boot instead of racing
        it. ``load_tail`` executes in the default executor — the event loop
        (other sessions, other clients) never blocks on Parquet IO.
        """
        async with self._start_lock:
            if self.run_task is None or self.run_task.done():
                if not self._boot_done:
                    # Set the flag only AFTER boot returns: if the awaiting
                    # subscriber is cancelled inside the load_tail executor
                    # (CancelledError bypasses _boot's except Exception), the
                    # flag stays False so a later subscriber retries boot
                    # instead of running with recording/rehydration silently off.
                    await self._boot()
                    self._boot_done = True
                self.run_task = asyncio.create_task(
                    self.run(), name=f"session-{self.session_id}"
                )
        return self.run_task

    async def _boot(self) -> None:
        """Open the session recorder and rehydrate the grid (spec §8.1).

        Any failure here is logged and degrades to a cold start with
        recording disabled — never propagated into subscribe/attach.
        """
        if self._recorder_root is None:
            return
        try:
            loop = asyncio.get_running_loop()
            rec, tail = await loop.run_in_executor(None, self._boot_blocking)
        except Exception:
            logger.exception(
                "recording boot failed; recording disabled for session %s",
                self.session_id,
            )
            return
        self._rec = rec
        if tail is not None:
            self._apply_tail(tail)
        # Initial epoch params (cold: epoch 0; rehydrated: the tail's current
        # epoch — duplicates across part files are fine, load dedups by key).
        params = self._grid.current_epoch_params()
        self._record(lambda r: r.record_epoch(params))

    def _boot_blocking(self) -> tuple[SessionRecorder, TailData | None]:
        """Blocking recorder IO for :meth:`_boot` (runs in the executor)."""
        assert self._recorder_root is not None
        market, symbol = self._feed.market, self._feed.symbol
        rec = self._recorder_root.open_session(market, symbol)
        cfg = self._grid.cfg
        tail = self._recorder_root.load_tail(
            market,
            symbol,
            max_age_ns=cfg.ring_columns * cfg.dt_ns,
            now_ns=self._wall_clock(),
            limit_cols=cfg.ring_columns,
        )
        return rec, tail

    def _apply_tail(self, tail: TailData) -> None:
        """Seed grid/tape/markers from a recorded tail + emit the gap Marker."""
        try:
            self._grid.preload(tail.columns, tail.epochs)
        except Exception:
            # Unusable tail (e.g. grid shape changed between runs): §8.1
            # says cold start — never fail the session over it.
            logger.exception(
                "rehydration preload failed; cold start for session %s",
                self.session_id,
            )
            return
        self._tape.extend(tail.trades)
        self._markers.extend(tail.markers)
        dt = self._grid.cfg.dt_ns
        end_ns = tail.newest_t0_ns + dt
        # ts is the last ns of the recorded range so the marker is inside the
        # snapshot's [first_t0, last_t0+dt) marker window from the very first
        # attach (live columns only ever extend that window rightward).
        gap = events.Marker(
            ts_ns=end_ns - 1,
            kind="gap",
            text=f"restart: recording ends {end_ns}, live resumes ~{self._wall_clock()}",
        )
        self._markers.append(gap)
        self._record(lambda r: r.record_marker(gap))
        logger.info(
            "session %s rehydrated %d columns (tail t0 %d..%d)",
            self.session_id,
            len(tail.columns),
            tail.columns[0].t0_ns,
            tail.newest_t0_ns,
        )

    # -- recording (all wrapped: failures disable recording, never the feed) ---

    def _record(self, op: Callable[[SessionRecorder], None]) -> None:
        if self._rec is None:
            return
        try:
            op(self._rec)
        except Exception:
            logger.exception(
                "recording failed; disabled for session %s", self.session_id
            )
            self._rec = None

    def _flush_recording(self) -> None:
        if self._rec is None:
            return
        try:
            self._rec.flush()
        except Exception:
            logger.exception(
                "recording flush failed; disabled for session %s", self.session_id
            )
            self._rec = None
            return
        self._cols_since_flush = 0
        self._enforce_retention()

    def _close_recording(self) -> None:
        if self._rec is None:
            return
        rec, self._rec = self._rec, None
        try:
            rec.close()
        except Exception:
            logger.exception(
                "recording close failed for session %s", self.session_id
            )
            return
        self._enforce_retention()

    def _enforce_retention(self) -> None:
        # Retention failure is non-fatal: recording itself stays enabled.
        if self._recorder_root is None:
            return
        try:
            self._recorder_root.enforce_retention()
        except Exception:
            logger.exception("recording retention enforcement failed")

    def attach(self, client: ClientTx) -> list[bytes]:
        """Register a client and return the pre-encoded snapshot frames.

        The caller delivers the frames (SessionManager enqueues them; the T8
        ws layer may send them directly). No await happens between snapshot
        capture and registration, so live broadcasts cannot interleave.
        """
        if self._closed:
            raise RuntimeError(f"session {self.session_id} is torn down")
        if self._grace_handle is not None:
            self._grace_handle.cancel()
            self._grace_handle = None
        self._clients.add(client)
        return self._snapshot_frames()

    @property
    def client_count(self) -> int:
        """Attached clients (the session's refcount)."""
        return len(self._clients)

    def teardown_now(self) -> None:
        """Tear down immediately, skipping the detach grace period.

        Used when a session is being REPLACED (a price-band switch on the same
        symbol): waiting out ``GRACE_S`` would pin a whole ring
        (``ring_columns*2*rows*2`` bytes) for a minute and can trip
        ``max_sessions``. Safe on an already-closed or still-watched session —
        ``_teardown`` returns early in both cases.
        """
        if self._grace_handle is not None:
            self._grace_handle.cancel()
            self._grace_handle = None
        self._teardown()

    def detach(self, client: ClientTx) -> None:
        # Idempotent: the refcount IS len(_clients), so a double-detach of the
        # same client cannot decrement twice and orphan a live subscriber.
        if client not in self._clients:
            return
        self._clients.discard(client)
        if not self._clients and not self._closed:
            if self._grace_handle is not None:
                self._grace_handle.cancel()
            self._grace_handle = self._timer(self._grace_s, self._teardown)

    def _teardown(self) -> None:
        if self._clients or self._closed:  # re-attached during grace / already down
            return
        self._closed = True
        self._grace_handle = None
        if self.run_task is not None:
            self.run_task.cancel()
        # Teardown closes the recorder (flushes any buffered rows). The
        # cancelled run task's finally also flushes — idempotent, whichever
        # runs second sees an already-cleared recorder.
        self._close_recording()
        if self._on_teardown is not None:
            self._on_teardown()

    # -- feed loop -------------------------------------------------------------

    async def run(self) -> None:
        """Drain ``feed.events()`` into the grid and broadcast; restart the
        feed with exponential backoff (cap 30 s) on crash, reporting
        transitions via ``Status``. Returns when the feed ends normally.

        On ANY exit (normal end, cancellation — teardown or server shutdown)
        buffered recording rows are flushed so the on-disk tail stays fresh
        for the next §8.1 rehydration. The flush is synchronous; it only
        runs when the loop is stopping anyway."""
        try:
            while True:
                try:
                    await self._consume()
                    self._emit_closed_if_needed()
                    return
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("feed crashed, restarting in %.1fs", self._backoff_s)
                    try:
                        self._set_feed_state("degraded")
                    except Exception:
                        # A broadcast/encode failure must not kill the restart loop.
                        logger.exception("failed to broadcast degraded Status")
                    await asyncio.sleep(self._backoff_s)
                    self._backoff_s = min(self._backoff_s * 2.0, _BACKOFF_CAP_S)
        finally:
            if self._closed:
                self._close_recording()
            else:
                self._flush_recording()

    async def _consume(self) -> None:
        async for ev in self._feed.events():
            if self._feed_state != "live":  # first event after a restart
                self._recovery_start_ns = self._clock()
                self._recovery_events = 0
                self._set_feed_state("live")
            if self._backoff_s != self._backoff_base_s:
                # Reset only after the restarted feed proves stable (see
                # _STABLE_NS/_STABLE_EVENTS): flappers must keep escalating.
                self._recovery_events += 1
                if (
                    self._recovery_events >= _STABLE_EVENTS
                    or self._clock() - self._recovery_start_ns >= _STABLE_NS
                ):
                    self._backoff_s = self._backoff_base_s
            if isinstance(ev, BookState):
                self._on_book(ev)
            elif isinstance(ev, events.Trade):
                self._grid.on_trade(ev.ts_ns, ev.price, ev.size, ev.side)
                self._tape.append(ev)
                self._record(lambda r, t=ev: r.record_trade(t))
                self._broadcast(wire.encode(ev), col=False)
            elif isinstance(ev, events.Marker):
                self._markers.append(ev)
                self._record(lambda r, m=ev: r.record_marker(m))
                self._broadcast(wire.encode(ev), col=False)
            elif isinstance(ev, events.BBO):
                self._bbo = ev
                self._broadcast(wire.encode(ev), col=False)
            else:
                # Forward-compat: a feed speaking a newer FeedEvent dialect
                # must not crash the session — log and skip.
                logger.warning("ignoring unknown feed event type %s", type(ev).__name__)
            now = self._clock()
            if now - self._last_flush_ns >= self._flush_interval_ns:
                self._flush_partial(now)

    def _on_book(self, ev: BookState) -> None:
        cols = self._grid.on_book(ev.ts_ns, ev.bid_px, ev.bid_sz, ev.ask_px, ev.ask_sz)
        self._emit_finalized(cols)
        anchor = self._reanchor_ref(ev)
        if anchor is not None:
            params = self._grid.maybe_reanchor(anchor)
            if params is not None:
                # EpochStart FIRST: broadcast before any new-epoch column
                # message (the columns emitted above carry the old epoch).
                self._record(lambda r, p=params: r.record_epoch(p))
                start = events.EpochStart(epoch=params.epoch, epoch_params=params)
                self._broadcast(wire.encode(start), col=False)

    @staticmethod
    def _reanchor_ref(ev: BookState) -> float | None:
        """Price the grid re-anchors around for this book (None to skip).

        Two-sided books (L2 crypto/sim, and keyed L1_BAND equity) use the BBO
        mid — the exact expression the L2 path has always used, so crypto/sim
        stay byte-identical. A one-sided density (only bid, or — for a two-sided
        synthetic split whose reference price sits at/below every occupied bucket
        during a sustained decline — only ask) has no BBO, so it re-anchors around
        that side's price-span center instead: this is what lets an equity grid
        started at a nominal $100 p0 recentre on the symbol's real price (e.g. an
        AAPL profile near $180) regardless of which side the split leaves
        populated."""
        if len(ev.bid_px) and len(ev.ask_px):
            return (float(np.max(ev.bid_px)) + float(np.min(ev.ask_px))) / 2.0
        if len(ev.bid_px):
            return (float(np.min(ev.bid_px)) + float(np.max(ev.bid_px))) / 2.0
        if len(ev.ask_px):
            return (float(np.min(ev.ask_px)) + float(np.max(ev.ask_px))) / 2.0
        return None

    def _emit_finalized(self, cols: list[FinalizedColumn]) -> None:
        emitted = False
        for col in cols:
            # The grid re-returns the last column on a zero-span boundary
            # call — dedup by col_seq (grid docstring; test 6).
            if self._last_col_seq is not None and col.col_seq <= self._last_col_seq:
                continue
            self._last_col_seq = col.col_seq
            self._record(lambda r, c=col: r.record_column(c))
            self._cols_since_flush += 1
            self._broadcast(wire.encode(self._grid.to_depth(col)), col=True, t0_ns=col.t0_ns)
            self._broadcast(wire.encode(col.bar), col=True, t0_ns=col.t0_ns)
            emitted = True
        if self._rec is not None and self._cols_since_flush >= REC_FLUSH_COLS:
            self._flush_recording()
        if emitted:
            # Re-seed the right edge immediately after a column closes so the
            # client always has the in-progress column (plus the periodic
            # clock-based flush below).
            self._flush_partial()

    def _flush_partial(self, now_ns: int | None = None) -> None:
        partial = self._grid.current_partial()
        if partial is None:
            return
        self._last_flush_ns = self._clock() if now_ns is None else now_ns
        # is_partial: re-emissions coalesce latest-wins per t0 in each ClientTx
        # (always depth then bar, so FIFO replacement stays kind-paired).
        self._broadcast(wire.encode(partial), col=True, t0_ns=partial.t0_ns, is_partial=True)
        self._broadcast(
            wire.encode(self._grid.bar_partial()),
            col=True,
            t0_ns=partial.t0_ns,
            is_partial=True,
        )

    def _emit_closed_if_needed(self) -> None:
        """After a feed loop ends *normally*, an equity feed may report a
        closed RTH window (``feed.feed_state == 'closed'``; spec §7.1). When it
        does, broadcast a terminal ``Status{feed_state='closed', next_open_ts}``
        so the client shows the closed banner + countdown, then leave the run
        task ended. This is distinct from the crash path in :meth:`run`, which
        restarts with backoff on EXCEPTIONS — a normal 'closed' end must NOT
        hot-loop restart. Feeds with no ``feed_state`` attribute (sim/crypto)
        end normally and emit nothing here.

        The session stays registered (refcounted) while a client is attached;
        a later re-subscribe restarts the feed (``start()`` is idempotent), so
        the client wakes the stream after the next open. M3 limitation
        (documented for T4 live verification): the wake at ``next_open_ts`` is
        client-driven, not a server-scheduled timer. The weekend demo is a
        closed banner + last-session SYNTH warmup that resumes on re-subscribe.
        """
        if getattr(self._feed, "feed_state", None) != "closed":
            return
        # Direct broadcast (not _set_feed_state) so next_open_ts rides along; a
        # later restart's first event flips _feed_state back to live.
        self._feed_state = "closed"
        status = events.Status(
            feed_state="closed",
            capability=self._feed.capability,
            latency_ms=0.0,
            clock_skew_ms=0.0,
            next_open_ts=getattr(self._feed, "next_open_ts", None),
        )
        self._broadcast(wire.encode(status), col=False)

    def _set_feed_state(self, state: str) -> None:
        if state == self._feed_state:
            return
        self._feed_state = state
        status = events.Status(
            feed_state=state,  # type: ignore[arg-type]
            capability=self._feed.capability,
            latency_ms=0.0,
            clock_skew_ms=0.0,
        )
        self._broadcast(wire.encode(status), col=False)

    def _broadcast(
        self,
        frame: bytes,
        *,
        col: bool,
        t0_ns: int | None = None,
        is_partial: bool = False,
    ) -> None:
        for client in self._clients:
            client.offer(frame, col_msg=col, t0_ns=t0_ns, is_partial=is_partial)

    # -- snapshot / history ----------------------------------------------------

    def _norm_seed(self) -> float:
        """Percentile hint for client normalization: p99 of the nonzero
        densities over the most recent ≤64 columns, or 1.0 when empty."""
        cols = self._grid.history(_T_MAX, 64)
        if not cols:
            return 1.0
        vals = np.concatenate([c.bid for c in cols] + [c.ask for c in cols]).astype(np.float64)
        vals = vals[vals > 0.0]
        if vals.size == 0:
            return 1.0
        return float(np.percentile(vals, 99.0))

    def _epoch_start_msgs(self, epochs: set[int]) -> list[bytes]:
        """One encoded EpochStart per epoch, ascending. Duplicate EpochStarts
        across snapshot/history responses are harmless: the client's epoch
        table is idempotent (spec §6.3)."""
        return [
            wire.encode(
                events.EpochStart(epoch=e, epoch_params=self._grid.epoch_params_for(e))
            )
            for e in sorted(epochs)
        ]

    def _snapshot_frames(self) -> list[bytes]:
        ep = self._grid.current_epoch_params()
        cols = self._grid.history(_T_MAX, SNAPSHOT_COLS)
        hello = events.Hello(
            protocol_version=wire.PROTO_VER,
            session_id=self.session_id,
            grid_epoch=ep.epoch,
            epoch_params=ep,
            capability=self._feed.capability,
            norm_seed=self._norm_seed(),
        )
        # Hello first, then EpochStart for EVERY distinct epoch appearing in
        # the snapshot's columns (plus the current one), ascending — the
        # client must hold params for each epoch before decoding its columns.
        announce = self._epoch_start_msgs({c.epoch for c in cols} | {ep.epoch})
        frames = [b"".join([wire.encode(hello), *announce])]
        for i in range(0, len(cols), SNAPSHOT_CHUNK_COLS):
            chunk = cols[i : i + SNAPSHOT_CHUNK_COLS]
            frames.append(
                b"".join(
                    wire.encode(self._grid.to_depth(c)) + wire.encode(c.bar) for c in chunk
                )
            )

        tail: list[bytes] = []
        if cols:
            lo, hi = cols[0].t0_ns, cols[-1].t0_ns + ep.dt_ns
            tail.extend(wire.encode(m) for m in self._markers if lo <= m.ts_ns < hi)
        tail.extend(wire.encode(t) for t in self._tape)
        if self._bbo is not None:
            tail.append(wire.encode(self._bbo))
        if tail:
            frames.append(b"".join(tail))
        return frames

    def handle_history(self, req: events.HistoryRequest) -> bytes:
        """Serve a HistoryRequest from the grid ring as ONE encoded frame.

        The frame batches an EpochStart for every distinct epoch in the
        response (ascending) ahead of the HistoryResponse — batched messages
        per WS frame are protocol-valid (§6.2), and this lets the client
        reconstruct columns of epochs it never saw live.
        """
        n = max(0, min(req.n_cols, HISTORY_MAX_COLS))
        cols = self._grid.history(req.before_t, n)
        ep = self._grid.current_epoch_params()
        markers: list[events.Marker] = []
        if cols:
            lo, hi = cols[0].t0_ns, cols[-1].t0_ns + ep.dt_ns
            markers = [m for m in self._markers if lo <= m.ts_ns < hi]
        resp = events.HistoryResponse(
            req_id=req.req_id,
            epoch=ep.epoch,
            oldest_available_t_ns=self._grid.oldest_retained_t0_ns() or 0,
            depth_cols=[self._grid.to_depth(c) for c in cols],
            bar_cols=[c.bar for c in cols],
            markers=markers,
            big_trades=[],  # M1: see big_trades note at module top
        )
        announce = self._epoch_start_msgs({c.epoch for c in cols})
        return b"".join([*announce, wire.encode(resp)])


# --- manager --------------------------------------------------------------------


class SessionLimitError(RuntimeError):
    """Raised when a new session key would exceed ``Config.max_sessions``."""


# Sim grid shape (mirrors feeds.sim private constants: mid starts at 100.0,
# tick 0.5; kept local so this module does not reach into sim internals).
_SIM_MID0 = 100.0
_SIM_TICK = 0.5
_SIM_ROWS = 2048

# Equity grid shape (spec §7/§7.1): a cent tick (SEC Rule 612, >=$1 stocks),
# a ~$41 vertical span at 4096 rows, and a nominal $100 p0 that the grid
# re-anchors to the symbol's real price on the first book. mode + cadence are
# derived from the feed's honest capability so the grid can never claim more
# than the feed delivers (SYNTH_PROFILE keyless / L1_BAND keyed).
_EQUITY_TICK = 0.01
_EQUITY_ROWS = 4096
_EQUITY_P0_NOMINAL = 100.0
# Depth-capability string -> grid render mode. Two-sided equity depth (synthetic
# volume-at-price split at the reference price, or real Alpaca L1 top-of-book)
# renders two-channel via MODE_L1_BAND; the honest tier lives in the capability
# badge (SYNTH vs L1), decoupled from the render shape. Legacy one-sided
# SYNTH_PROFILE kept for compatibility.
_EQUITY_DEPTH_MODE: dict[object, int] = {
    "SYNTH": events.MODE_L1_BAND,
    "L1": events.MODE_L1_BAND,
    "SYNTH_PROFILE": events.MODE_SYNTH_PROFILE,
    "L1_BAND": events.MODE_L1_BAND,
}
# Synthetic (keyless) depth tiers run the slower Yahoo-friendly cadence.
_EQUITY_SYNTH_DEPTHS = frozenset({"SYNTH", "SYNTH_PROFILE"})

# Price-grid coverage presets, as (band_up, band_down) fractions of the
# reference price. ``None`` = the legacy fixed-absolute-span grid.
#
# The grid is a LINEAR affine over a FIXED row count, so range and resolution
# are the SAME knob — a wider band can only make every row coarser. Concretely,
# on BTC at $60k with 2048 rows and a $0.5 tick:
#   native  fixed $1024 span   -> $0.50/row   (about +/-0.85% around mid)
#   wide    +/-50%             -> ~$43.5/row  (about $89k of coverage)
#   full    -100% / +1000%     -> ~$403/row   (the live book collapses into a
#                                 couple of rows: a range SCAN mode for finding
#                                 far-out walls, NOT a ladder-reading view)
# Because tick_multiple = ceil(span / (rows*tick)) can only round UP, a preset
# is a literal no-op for any symbol cheap enough that the native span already
# covers the band.
class BandSpec(msgspec.Struct, frozen=True):
    """Coverage around the reference price, and how the rows are spent.

    ``hybrid=False`` keeps the LINEAR grid, where range and resolution are the
    same knob. ``hybrid=True`` switches to the piecewise scale
    (``core/price_scale.py``): a linear CORE at the instrument's native step
    surrounded by logarithmic wings, so the tradeable ladder near the money is
    unchanged AND the far field is covered. That is the only preset for which a
    -99%/+1000% band is a trading view rather than a range scan.
    """

    up: float
    down: float
    hybrid: bool = False
    #: Rows for the linear core; 0 => rows // 2.
    core_rows: int = 0
    #: Grid height override for this band (0 => the market default).
    rows: int = 0


BANDS: dict[str, BandSpec | None] = {
    "native": None,
    "wide": BandSpec(up=0.5, down=0.5),
    "full": BandSpec(up=10.0, down=1.0),
    # -99%/+1000% with the ladder INTACT: 4096 rows, half of them a native-step
    # core. On BTC at $60k that is +/-0.853% at $0.50/row — the coverage AND
    # resolution of the `native` grid — plus wings reaching -99%/+1000% at
    # ~0.34%/row. Registered as a NEW name rather than re-pointing `full`:
    # priceBand is persisted in localStorage, so re-pointing would silently move
    # every existing `full` user onto a piecewise scale on their next load.
    "deep": BandSpec(up=10.0, down=0.99, hybrid=True, core_rows=2048, rows=4096),
}

DEFAULT_BAND = "native"


def canonical_band(band: str | None) -> str:
    """Coerce a wire ``band`` to a known preset name.

    Done at the WS boundary so an arbitrary string can never reach the
    SessionManager key: ``band`` is unvalidated client text, and each distinct
    value would otherwise mint its own Session — four junk subscribes would
    exhaust ``max_sessions`` at 256 MiB (crypto) / 512 MiB (equity) of ring
    apiece.
    """
    return band if band in BANDS else DEFAULT_BAND


class SessionManager:
    """Owns sessions keyed by (market, symbol, mode, source); refcounted."""

    def __init__(
        self,
        cfg: Config,
        *,
        clock: Clock = time.monotonic_ns,
        timer: Timer = _default_timer,
        feed_factory: Callable[[events.Subscribe], Feed] | None = None,
        recorder: Recorder | None = None,
        wall_clock: Clock = time.time_ns,
    ) -> None:
        self._cfg = cfg
        self._clock = clock
        self._timer = timer
        self._feed_factory = feed_factory or self._default_feed_factory
        # Recording root shared by all live sessions (None: no recording and
        # no rehydration — the default for deterministic tests; create_app
        # wires one in from Config for the real server).
        self._recorder = recorder
        self._wall_clock = wall_clock
        # Keyed by (market, symbol, mode, source, band) — the band is part of
        # the grid geometry, so two bands are genuinely two grids.
        self._sessions: dict[tuple[str, str, str, str | None, str], Session] = {}

    def _default_feed_factory(self, sub: events.Subscribe) -> Feed:
        if sub.market == "sim":
            return SimFeed(seed=42, dt_ns=self._cfg.dt_crypto_ns, start_ns=0)
        if sub.market in CRYPTO_MARKETS:
            # "<exchange>-<market>" ("binance-usdm") or bare "<exchange>" ("okx").
            exchange, _, market = sub.market.partition("-")
            return CryptoFeed(exchange=exchange, symbol=sub.symbol, market=market, cfg=self._cfg)
        if sub.market in EQUITY_MARKETS:
            # Tier (keyless SYNTH / Alpaca / Finnhub) auto-selected from cfg keys.
            return EquityFeed(sub.symbol, self._cfg)
        raise NotImplementedError(
            f"market {sub.market!r} has no feed "
            f"(sim + crypto {sorted(CRYPTO_MARKETS)} + equity {sorted(EQUITY_MARKETS)})"
        )

    def _grid_for(self, feed: Feed, band: str = DEFAULT_BAND) -> Grid:
        if feed.market in EQUITY_MARKETS:
            return self._equity_grid_for(feed, band)
        rows = min(_SIM_ROWS, self._cfg.max_rows)
        step = _SIM_TICK  # tick_multiple 1
        p0 = round((_SIM_MID0 - rows * step / 2.0) / step) * step
        spec = BANDS.get(band)
        if spec is not None and spec.rows > 0:
            rows = min(spec.rows, self._cfg.max_rows)
            p0 = round((_SIM_MID0 - rows * step / 2.0) / step) * step
        return Grid(
            GridCfg(
                tick=_SIM_TICK,
                tick_multiple=1,
                dt_ns=self._cfg.dt_crypto_ns,
                p0=p0,
                rows=rows,
                ring_columns=self._cfg.ring_columns,
                mode=events.MODE_L2,
                band_up=spec.up if spec else None,
                band_down=spec.down if spec else None,
                band_hybrid=spec.hybrid if spec else False,
                core_rows=spec.core_rows if spec else 0,
            )
        )

    def _equity_grid_for(self, feed: Feed, band: str = DEFAULT_BAND) -> Grid:
        """Equity-appropriate grid (spec §7): mode and column cadence honestly
        derived from the feed's capability. Keyless SYNTH_PROFILE runs a
        single-channel (bid-only) density at the 10 s keyless cadence; keyed
        tiers (L1_BAND) run at the 1 s equity cadence. Cent tick; a nominal
        $100 p0 that the grid re-anchors to the symbol's real price on the
        first book (a >=$1 stock's profile near $180 pulls p0 up)."""
        depth = feed.capability.get("depth")
        mode = _EQUITY_DEPTH_MODE.get(depth, events.MODE_L1_BAND)
        dt = (
            self._cfg.dt_equity_keyless_ns
            if depth in _EQUITY_SYNTH_DEPTHS
            else self._cfg.dt_equity_keyed_ns
        )
        rows = min(_EQUITY_ROWS, self._cfg.max_rows)
        tick = _EQUITY_TICK
        p0 = round((_EQUITY_P0_NOMINAL - rows * tick / 2.0) / tick) * tick
        spec = BANDS.get(band)
        return Grid(
            GridCfg(
                tick=tick,
                tick_multiple=1,
                dt_ns=dt,
                p0=p0,
                rows=rows,
                ring_columns=self._cfg.ring_columns,
                mode=mode,
                band_up=spec.up if spec else None,
                band_down=spec.down if spec else None,
                band_hybrid=spec.hybrid if spec else False,
                core_rows=spec.core_rows if spec else 0,
            )
        )

    async def subscribe(self, sub: events.Subscribe, client: ClientTx) -> Session:
        """Attach ``client`` to the session for ``sub``'s key, creating and
        starting the session if needed (≤ ``cfg.max_sessions`` distinct keys).
        The snapshot frames are enqueued into ``client`` before returning, so
        they precede every live broadcast."""
        band = canonical_band(sub.band)
        key = (sub.market, sub.symbol, sub.mode, sub.source, band)
        # The band is part of the key (two clients on the same symbol with
        # different bands must NOT silently share one grid — the second would
        # inherit the first's step and never know). But a band switch on an
        # otherwise-identical key must EVICT the old variant immediately rather
        # than wait out GRACE_S: each session holds a
        # ring_columns*2*rows*2-byte ring (256 MiB crypto / 512 MiB equity), and
        # flipping the preset three times would otherwise pin ~1 GiB for a
        # minute and trip max_sessions.
        session = self._sessions.get(key)
        if session is None:
            self._evict_other_bands(key)
            if len(self._sessions) >= self._cfg.max_sessions:
                raise SessionLimitError(
                    f"session limit reached ({self._cfg.max_sessions}); "
                    f"cannot open {key!r}"
                )
            feed = self._feed_factory(sub)
            session = Session(
                f"{sub.market}:{sub.symbol}:{sub.mode}:{uuid.uuid4().hex[:12]}",
                feed=feed,
                grid=self._grid_for(feed, band),
                clock=self._clock,
                timer=self._timer,
                # Live mode only: replay sessions (M3) never self-record.
                recorder=self._recorder if sub.mode == "live" else None,
                wall_clock=self._wall_clock,
            )
            session._on_teardown = self._make_remover(key, session)
            self._sessions[key] = session
        # Unconditional (start() is idempotent/restart-safe): a session whose
        # feed ended normally must not be handed out as a zombie — a new
        # subscriber restarts the run task. First start boots (rehydrates)
        # BEFORE attach below, so the snapshot includes the recorded tail.
        await session.start()
        frames = session.attach(client)
        for frame in frames:
            # Snapshot frames ride the non-column path (no column lag-drops)
            # and are protected: cap eviction must never drop Hello.
            client.offer(frame, col_msg=False, t0_ns=None, protected=True)
        return session

    def _evict_other_bands(self, key: tuple[str, str, str, str | None, str]) -> None:
        """Tear down sessions that differ from ``key`` ONLY in the band.

        Called before creating a new band variant. Idle variants (no attached
        clients) are torn down at once; a variant someone else is still watching
        is left alone — it is a legitimate concurrent session, not a leak.
        """
        market, symbol, mode, source, _band = key
        for other in list(self._sessions):
            if other == key or other[:4] != (market, symbol, mode, source):
                continue
            sess = self._sessions.get(other)
            if sess is None or sess.client_count > 0:
                continue
            self._sessions.pop(other, None)
            sess.teardown_now()

    def _make_remover(
        self, key: tuple[str, str, str, str | None, str], session: Session
    ) -> Callable[[], None]:
        def _remove() -> None:
            # Identity-guarded: a stale grace timer from a torn-down session
            # must never evict a fresh session that reused the key.
            if self._sessions.get(key) is session:
                del self._sessions[key]

        return _remove

    async def unsubscribe(self, session: Session, client: ClientTx) -> None:
        session.detach(client)
