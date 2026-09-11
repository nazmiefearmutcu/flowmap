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
  restarts with exponential backoff (cap 30 s) slept with FULL JITTER (a
  uniform draw from ``[0, backoff)`` — sessions of a venue that died together
  no longer restart in lockstep) and reports transitions via ``Status``;
  other sessions are unaffected.
- **Recording + rehydration** (§7/§8.1, M1 T11): a live-mode session with a
  :class:`~flowmap_server.core.record.Recorder` self-records epoch params
  (initial + every re-anchor), every finalized column, trades and markers.
  Flush cadence: every ``REC_FLUSH_COLS`` recorded columns OR once the
  time-based cadence (``rec_flush_interval_s``, default 10 s) is reached
  (a Windows hard close loses at most ~the cadence, not a whole part), when
  the feed loop exits (server shutdown), and on teardown (``close()``); a
  successful flush is followed by ``enforce_retention()``, which runs at
  most once per ``retention_min_interval_s`` (default 60 s) of wall clock.
  The cadence Parquet write and the retention walk run in executor threads
  (buffers are swapped out on the loop first, and only one flush is ever in
  flight, so order and content are exactly what the synchronous version
  produced); the teardown close stays synchronous so data is on disk before
  the session dies. Every recorder call is wrapped: recording failures NEVER
  kill the feed loop. A FAILED cadence flush is no longer permanent: the
  unwritten rows are restored to the buffers and the flush retries after a
  cooldown (exponential backoff 5 s → 300 s cap; only a broken recorder that
  cannot even take its rows back disables recording). Before the feed task
  starts, ``start()`` rehydrates the grid ring from the newest recording via
  ``load_tail`` (run in the default executor so the event loop — and other
  sessions' attaches — never block on Parquet IO) and emits a
  ``Marker{kind=gap}`` between the recorded tail and live; a stale/absent/
  unusable tail means a cold start. Because rehydration only happens when a
  Recorder is wired in (SessionManager default: none), deterministic sim
  tests never depend on a previous run's recordings.
- **Telemetry** (campaign C1): every drop/restart/flush-failure counter on
  this path feeds the shared :class:`~flowmap_server.core.stats.SessionStats`
  aggregate (mounted as ``SessionManager.stats``); per-connection latency/
  skew reach Status broadcasts through the ``Session.conn_stats`` hook the
  WS layer installs. All hooks are optional — a bare ``Session`` (tests)
  behaves exactly as before.

Everything is asyncio, single-threaded, no locks (the only lock serializes
``start()``'s boot phase): attach/snapshot/broadcast never await between
observing grid state and enqueueing, so per-client frame order is exactly
stream order.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import time
import uuid
from collections import OrderedDict, deque
from collections.abc import Callable
from typing import Protocol

import msgspec
import numpy as np

from flowmap_server.config import Config
from flowmap_server.core.backfill import BackfillFn, columns_from_candles
from flowmap_server.core.grid import FinalizedColumn, Grid, GridCfg
from flowmap_server.core.record import Recorder, SessionRecorder, TailData
from flowmap_server.core.stats import SessionStats
from flowmap_server.feeds.base import BookState, Feed
from flowmap_server.feeds.equity import EQUITY_MARKETS
from flowmap_server.feeds.replay import ReplayFeed
from flowmap_server.feeds.router import build_feed
from flowmap_server.proto import events, wire

__all__ = [
    "ClientTx",
    "ReplayStaleError",
    "Session",
    "SessionLimitError",
    "SessionManager",
]

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
# Recording flush-failure retry (cooldown with exponential backoff). One
# transient failure (disk full, AV scan lock, USB hiccup) must NOT permanently
# disable recording: the failed snapshot's rows are restored to the buffers and
# the next attempt waits base * 2**(consecutive_failures-1) seconds, capped.
# Success resets the ladder. Failures are counted in stats.flush_failures.
_REC_RETRY_BASE_S = 5.0
_REC_RETRY_CAP_S = 300.0
# Backoff resets to base only once a restarted feed proves stable: it has run
# for >=5 s (injectable clock) or delivered >=100 events, whichever first. A
# yield-one-then-crash flapper therefore keeps escalating to the 30 s cap.
_STABLE_NS = 5_000_000_000
_STABLE_EVENTS = 100
_MARKERS_CAP = 1024  # bounded marker memory for snapshot/history
_T_MAX = 2**63 - 1
# Parked-replay freshness policy (handoff §6): a re-attach to an EXISTING
# replay session re-validates the recording on disk. Growth past the
# session's tail by more than this much RECORDED time is "stale" — a replay
# feed can never serve columns recorded after the tail it was built from, so
# accepting would present an outdated replay as current. 2 s absorbs the
# one-column flush race (any dt) between the tail load and the attach.
REPLAY_STALE_TOL_NS = 2_000_000_000
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
        # Telemetry hook (campaign C1), installed by Session.attach: called
        # with the number of COLUMNs dropped by each lag eviction so the
        # server-wide stats aggregate can count tx lag drops at the source.
        # Public and default-None — the WS layer constructs ClientTx bare.
        self.on_lag_drop: Callable[[int], None] | None = None

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
        n_cols = 0  # real columns lost (depth+bar pair sharing t0 counts once)
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
                            n_cols += 1
                    else:
                        out.append(_Gap(e.t0_ns))
                        n_cols += 1
                    continue
            out.append(e)
            idx += 1
        if dropped:
            self._q = out + q[idx:]
            if n_cols and self.on_lag_drop is not None:
                try:
                    self.on_lag_drop(n_cols)
                except Exception:  # noqa: BLE001 — telemetry must never kill the queue
                    pass

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
        backfill_fn: BackfillFn | None = None,
        backfill_max_cols: int = 0,
        stats: SessionStats | None = None,
        rec_flush_interval_s: float = 10.0,
        retention_min_interval_s: float = 60.0,
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
        # Server-wide telemetry aggregate (campaign C1). None (bare tests)
        # simply skips every counter — behavior is identical without it.
        self._stats = stats
        # Full-jitter source for restart backoff: all sessions of a venue that
        # died together used to restart in lockstep every backoff step.
        self._rng = random.Random()

        # Recording (module docstring): the root opens the per-symbol writer
        # and serves load_tail at boot; wall_clock (injectable) is the §8.1
        # freshness reference — recorded timestamps are UTC wall ns.
        self._recorder_root = recorder
        self._wall_clock = wall_clock
        self._rec: SessionRecorder | None = None
        # Flush-failure retry state (see _REC_RETRY_* above): consecutive
        # failures size the cooldown; the retry is skipped while the cooldown
        # is active. Both reset on any successful flush.
        self._rec_failures = 0
        self._rec_retry_at: int | None = None
        # Time-based flush cadence (FLOWMAP_FLUSH_INTERVAL_S): buffers are
        # flushed once they have been accumulating this long even below the
        # REC_FLUSH_COLS column cadence, so a hard close loses seconds, not a
        # whole part. _rec_cadence_ns restarts at every successful flush.
        self._rec_flush_interval_ns = max(0, int(rec_flush_interval_s * 1e9))
        self._rec_cadence_ns = clock()
        # Retention walk min-interval (FLOWMAP_RETENTION_MIN_INTERVAL_S): the
        # rglob+stat pass over the recording root runs at most this often.
        self._retention_min_interval_ns = max(0, int(retention_min_interval_s * 1e9))
        self._last_retention_ns: int | None = None
        # Newest t0_ns of the recording this session's replay feed was built
        # from. None for live sessions; SessionManager sets it when it builds
        # a replay session and re-checks it on every re-attach to the same
        # key (parked-replay freshness policy, handoff §6).
        self.replay_tail_t0: int | None = None
        # Exclusive end of a WINDOWED replay ([start_t, end_t)); None for an
        # unbounded one. A bounded window is immutable history — growth of the
        # recording past its end is expected, so the parked-replay freshness
        # re-check is a no-op for such sessions (see _recheck_replay_freshness).
        self.replay_window_end_ns: int | None = None
        # Per-connection stats hook (NEEDS-CORE #1): the WS layer installs a
        # callable returning {"latency_ms": float, "clock_skew_ms": float}
        # measured on THIS connection; Status broadcasts consume it for real
        # values instead of hardcoded 0.0. Default None — never read unset.
        self.conn_stats: Callable[[], dict] | None = None
        self._cols_since_flush = 0
        self._flush_task: asyncio.Task | None = None
        self._boot_done = False
        self._start_lock = asyncio.Lock()

        # First-launch history backfill (GOAL 1): a cold subscribe seeds the ring
        # with reconstructed candle history so the client's eager requestHistory
        # returns real data. Runs in _boot only when no Parquet tail rehydrated.
        # When it seeds columns the session badges Hello/Status capability with
        # ``history: 'reconstructed'`` (candle volume-at-price, not resting L2).
        self._backfill_fn = backfill_fn
        self._backfill_max_cols = backfill_max_cols
        self._history_reconstructed = False

        self._clients: set[ClientTx] = set()
        self._grace_handle: TimerHandle | None = None
        self._closed = False

        # Pre-encoded finalized columns (col_seq -> joined depth+bar frame
        # bytes), LRU-capped at the snapshot window. _snapshot_frames serves
        # attaches from this cache instead of re-encoding up to 512 columns
        # (~8-16 MB) inline on the event loop per attach; entries are written
        # ONCE at finalize time by the exact encoder calls the snapshot path
        # used to make, so the wire bytes are identical.
        self._enc_cache: OrderedDict[int, bytes] = OrderedDict()

        self._last_col_seq: int | None = None  # dedup: grid may re-return a column
        self._last_flush_ns = clock()
        self._feed_state: str = "live"
        self._recovery_start_ns = clock()
        self._recovery_events = 0
        self._tape: deque[events.Trade] = deque(maxlen=SNAPSHOT_TAPE)
        self._markers: deque[events.Marker] = deque(maxlen=_MARKERS_CAP)
        self._bbo: events.BBO | None = None

    # -- lifecycle -------------------------------------------------------------

    async def start(self) -> asyncio.Task | None:
        """Boot (open recorder + rehydrate, once) and start the feed task.

        Idempotent and restart-safe. The boot phase runs BEFORE the run task
        exists and before the caller attaches, so the first subscriber's
        snapshot already contains the rehydrated tail; the lock makes a
        concurrent second subscriber wait for the same boot instead of racing
        it. ``load_tail`` executes in the default executor — the event loop
        (other sessions, other clients) never blocks on Parquet IO.

        Returns ``None`` when the session was torn down while booting (a
        grace-timer or band-replacement teardown fires during the seconds-long
        boot await — boot holds no clients, so it is teardown-eligible). In
        that case ``_teardown`` has already run and can NEVER run again
        (``_closed`` is a one-way latch), so starting ``run()`` here would leak
        a live feed task plus a full ring, broadcasting to zero clients
        forever; the caller re-subscribes instead.
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
                if self._closed:
                    return None
                self.run_task = asyncio.create_task(
                    self.run(), name=f"session-{self.session_id}"
                )
        return self.run_task

    async def _boot(self) -> None:
        """Open the session recorder, rehydrate (spec §8.1) or backfill the grid.

        Any failure here is logged and degrades to a cold start (recording
        disabled on a recorder error) — never propagated into subscribe/attach.
        Precedence: a fresh Parquet tail wins; only a cold ring (no tail) is
        seeded from the first-launch candle backfill (GOAL 1).
        """
        tail_applied = False
        if self._recorder_root is not None:
            try:
                loop = asyncio.get_running_loop()
                rec, tail = await loop.run_in_executor(None, self._boot_blocking)
            except Exception:
                logger.exception(
                    "recording boot failed; recording disabled for session %s",
                    self.session_id,
                )
            else:
                self._rec = rec
                if self._stats is not None:
                    self._stats.note_recording(self.session_id, True)
                if tail is not None:
                    # _apply_tail reports success: a tail that failed preload
                    # (grid shape changed, corrupt arrays) leaves the ring
                    # genuinely virgin, so the candle backfill below must run
                    # — otherwise the session gets NO history at all even
                    # though both sources were available (M2).
                    tail_applied = self._apply_tail(tail)

        # Backfill only a genuinely cold ring — never on top of a rehydrated tail
        # (the grid is no longer virgin; preload would raise).
        if not tail_applied:
            await self._run_backfill()

        # Initial epoch params (cold: epoch 0; rehydrated/backfilled: the
        # seeded current epoch — duplicates across part files are fine, load
        # dedups by key). No-op without a recorder.
        params = self._grid.current_epoch_params()
        self._record(lambda r: r.record_epoch(params))

    async def _run_backfill(self) -> None:
        """Seed the ring with reconstructed candle history (GOAL 1).

        Behind the injectable ``backfill_fn`` seam (pytest feeds canned candles;
        no network). Any failure degrades cleanly to cold start. Reconstructed
        columns are seeded but NOT recorded — only live columns persist to
        Parquet. On success, marks the session so Hello/Status advertise
        ``history: 'reconstructed'`` and emits a gap Marker to live.
        """
        if self._backfill_fn is None or self._backfill_max_cols <= 0:
            return
        try:
            candles = await self._backfill_fn(
                self._feed.market,
                self._feed.symbol,
                max_cols=self._backfill_max_cols,
                now_ns=self._wall_clock(),
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning(
                "backfill fetch failed; cold start for session %s",
                self.session_id,
                exc_info=True,
            )
            return
        if not candles:
            return
        try:
            result = columns_from_candles(candles, self._grid.cfg)
            if result is None:
                return
            columns, epoch = result
            self._grid.preload(columns, [epoch])
        except Exception:
            logger.warning(
                "backfill conversion/preload failed; cold start for session %s",
                self.session_id,
                exc_info=True,
            )
            return
        self._history_reconstructed = True
        dt = self._grid.cfg.dt_ns
        end_ns = columns[-1].t0_ns + dt
        gap = events.Marker(
            ts_ns=end_ns - 1,
            kind="gap",
            text=(
                f"backfill: reconstructed history ends {end_ns}, "
                f"live resumes ~{self._wall_clock()}"
            ),
        )
        self._markers.append(gap)
        # Record the gap marker (live provenance) but NOT the reconstructed
        # columns — only genuine live columns should persist for rehydration.
        self._record(lambda r: r.record_marker(gap))
        logger.info(
            "session %s backfilled %d reconstructed columns (t0 %d..%d)",
            self.session_id,
            len(columns),
            columns[0].t0_ns,
            columns[-1].t0_ns,
        )

    def _capability(self) -> dict[str, object]:
        """Feed capability, plus server-level badges: ``history:
        'reconstructed'`` when the ring was seeded from candle backfill
        (GOAL 1/3 honesty badge), and ``replay: True`` — this build serves the
        replay engine, and the client gates its Replay toggle on that flag
        independent of the mode it is currently subscribed to.

        Always returns a fresh dict (never the feed's own object): the badges
        must not leak back into the feed descriptor."""
        cap: dict[str, object] = dict(self._feed.capability)
        cap["replay"] = True
        if self._history_reconstructed:
            cap["history"] = "reconstructed"
        return cap

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

    def _apply_tail(self, tail: TailData) -> bool:
        """Seed grid/tape/markers from a recorded tail + emit the gap Marker.

        Returns True only when the grid actually took the tail; a False return
        (unusable recording) leaves the grid virgin so the caller still runs
        the candle backfill."""
        try:
            self._grid.preload(tail.columns, tail.epochs)
        except Exception:
            # Unusable tail (e.g. grid shape changed between runs): §8.1
            # says cold start — never fail the session over it.
            logger.exception(
                "rehydration preload failed; cold start for session %s",
                self.session_id,
            )
            return False
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
        return True

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
            if self._stats is not None:
                self._stats.note_recording(self.session_id, False)

    def _flush_recording(self) -> None:
        """Cadence flush (every REC_FLUSH_COLS recorded columns, or once the
        time-based cadence is reached): hand the current buffers to a
        background flush task.

        The Parquet write runs in a thread (``asyncio.to_thread``) — the
        synchronous write used to stall the event loop for the whole part
        write, every 64 columns, per session. Buffers are swapped out HERE,
        on the loop thread, so rows recorded while the thread writes stay in
        the live buffers and land in the next flush; only one flush may be
        in flight (a tick that arrives mid-write is picked up by the next
        cadence check), so snapshots can never race each other.

        After a flush FAILURE the retry waits out a cooldown (exponential
        backoff, see _REC_RETRY_*): rows keep buffering and nothing is lost,
        so a transient disk/AV hiccup costs a delayed part, not the recording."""
        if self._rec is None:
            return
        if self._rec_retry_at is not None and self._clock() < self._rec_retry_at:
            return  # cooldown after a failed flush: keep buffering, retry later
        if self._flush_task is not None and not self._flush_task.done():
            return  # previous flush still writing; next cadence catches up
        rec, bufs = self._rec, self._rec.take_buffers()
        if bufs is None:
            return
        self._flush_task = asyncio.get_running_loop().create_task(
            self._flush_buffers_async(rec, bufs)
        )

    async def _flush_buffers_async(
        self, rec: SessionRecorder, bufs: tuple[list, list, list, list]
    ) -> None:
        """Write one buffer snapshot in a thread (see :meth:`_flush_recording`).

        ``rec`` is captured at snapshot time on purpose: if the session tears
        down while this task is queued, the snapshot still lands instead of
        being dropped (teardown's close() can no longer see those rows).

        On failure the rows are restored to the live buffers (they never
        landed on disk) and a cooldown is armed — recording is NOT disabled
        for the session on a transient IO failure anymore; only a failure of
        the restore itself (a broken recorder) still disables."""
        try:
            await asyncio.to_thread(rec.flush_buffers, bufs)
        except Exception:
            if self._stats is not None:
                self._stats.inc_flush_failure()
            self._rec_failures += 1
            delay_s = min(
                _REC_RETRY_BASE_S * 2.0 ** (self._rec_failures - 1),
                _REC_RETRY_CAP_S,
            )
            self._rec_retry_at = self._clock() + int(delay_s * 1e9)
            logger.exception(
                "recording flush failed; will retry in %.0fs for session %s "
                "(%d consecutive failures)",
                delay_s,
                self.session_id,
                self._rec_failures,
            )
            try:
                rec.restore_buffers(bufs)
            except Exception:
                logger.exception(
                    "recording buffer restore failed; disabled for session %s",
                    self.session_id,
                )
                self._rec = None
                if self._stats is not None:
                    self._stats.note_recording(self.session_id, False)
            return
        self._rec_failures = 0
        self._rec_retry_at = None
        self._cols_since_flush = 0
        self._rec_cadence_ns = self._clock()
        if self._stats is not None:
            self._stats.note_flush()
        await self._enforce_retention_async()

    async def flush_recording_now(self) -> None:
        """Flush buffered recording rows and WAIT for the Parquet write.

        Runs on every run-loop exit and from the server-shutdown flush
        (:meth:`SessionManager.flush_all`): buffered columns/trades must be
        on disk before the session counts as ended — the §8.1 restart
        rehydrates from these files. Awaits any in-flight cadence flush
        first, so two flushes can never touch the recorder concurrently.

        A failure here (shutdown path — no time to wait out a cooldown)
        counts, restores the rows so the teardown close() retries them, and
        leaves the recorder open: recording is not permanently disabled by a
        transient write error."""
        task, self._flush_task = self._flush_task, None
        if task is not None and not task.done():
            try:
                await task
            except asyncio.CancelledError:
                pass
        if self._rec is None:
            return
        bufs = self._rec.take_buffers()
        if bufs is None:
            return
        try:
            await asyncio.to_thread(self._rec.flush_buffers, bufs)
        except asyncio.CancelledError:
            raise
        except Exception:
            if self._stats is not None:
                self._stats.inc_flush_failure()
            logger.exception(
                "recording flush failed at close; rows restored for session %s",
                self.session_id,
            )
            try:
                self._rec.restore_buffers(bufs)
            except Exception:
                logger.exception(
                    "recording buffer restore failed; disabled for session %s",
                    self.session_id,
                )
                self._rec = None
                if self._stats is not None:
                    self._stats.note_recording(self.session_id, False)
            return
        self._rec_failures = 0
        self._rec_retry_at = None
        self._cols_since_flush = 0
        self._rec_cadence_ns = self._clock()
        if self._stats is not None:
            self._stats.note_flush()
        await self._enforce_retention_async()

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
            if self._stats is not None:
                self._stats.note_recording(self.session_id, False)
            return
        if self._stats is not None:
            self._stats.note_recording(self.session_id, False)
        self._enforce_retention()

    def _enforce_retention(self) -> None:
        # Retention failure is non-fatal: recording itself stays enabled.
        # (Synchronous: only the rare teardown path uses this; the cadence
        # path after every flush is _enforce_retention_async below.)
        if self._recorder_root is None:
            return
        try:
            self._recorder_root.enforce_retention()
        except Exception:
            logger.exception("recording retention enforcement failed")

    async def _enforce_retention_async(self) -> None:
        """Off-loop retention walk, gated by a wall-clock min-interval.

        The rglob/stat pass over the whole recording root used to run after
        EVERY cadence flush (~every 16 s per active session — continuous disk
        churn over a tree whose cap moves at GB scales). It now runs at most
        once per ``retention_min_interval_s`` (default 60, env-tunable; 0
        restores the walk-after-every-flush behavior), still in an executor
        thread; concurrent walks serialize inside
        ``Recorder.enforce_retention``."""
        if self._recorder_root is None:
            return
        now = self._clock()
        if (
            self._retention_min_interval_ns > 0
            and self._last_retention_ns is not None
            and now - self._last_retention_ns < self._retention_min_interval_ns
        ):
            return
        self._last_retention_ns = now
        try:
            await asyncio.to_thread(self._recorder_root.enforce_retention)
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
        # Route this client's lag drops into the server-wide stats aggregate
        # (campaign C1). Overwritten on every attach — a resubscribe moves the
        # client (and its counter) to the new session's stats, which is the
        # same aggregate for manager-built sessions.
        client.on_lag_drop = (
            self._stats.inc_tx_lag_drops if self._stats is not None else None
        )
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

    def feed_control(self, ev) -> None:
        """Forward a replay transport control (Seek/SetSpeed/Pause/Resume) to
        the feed. Feeds without a control surface — every live feed — ignore
        it, so this is safe to call on any session."""
        ctrl = getattr(self._feed, "control", None)
        if ctrl is not None:
            ctrl(ev)

    async def run(self) -> None:
        """Drain ``feed.events()`` into the grid and broadcast; restart the
        feed with exponential backoff (cap 30 s) on crash, reporting
        transitions via ``Status``. Returns when the feed ends normally.

        On ANY exit (normal end, cancellation — teardown or server shutdown)
        buffered recording rows are flushed so the on-disk tail stays fresh
        for the next §8.1 rehydration. The final flush is awaited (off-loop
        Parquet write) so the data is on disk before the run task is
        considered done."""
        flush_task = asyncio.create_task(
            self._partial_flusher(), name=f"session-{self.session_id}-partial-flush"
        )
        try:
            while True:
                try:
                    await self._consume()
                    self._emit_closed_if_needed()
                    return
                except asyncio.CancelledError:
                    raise
                except Exception:
                    if self._stats is not None:
                        self._stats.inc_restart()
                    # Full jitter (AWS-style): sleep a UNIFORM draw from
                    # [0, backoff) instead of the bare backoff. Sessions of a
                    # venue that died together used to restart in lockstep
                    # every step (thundering herd at 1-2-4..30 s); the backoff
                    # STATE still doubles deterministically below — only the
                    # sleep is de-synchronized.
                    delay_s = self._rng.uniform(0.0, self._backoff_s)
                    logger.exception(
                        "feed crashed, restarting in %.1fs (backoff %.1fs)",
                        delay_s,
                        self._backoff_s,
                    )
                    try:
                        self._set_feed_state("degraded")
                    except Exception:
                        # A broadcast/encode failure must not kill the restart loop.
                        logger.exception("failed to broadcast degraded Status")
                    await asyncio.sleep(delay_s)
                    self._backoff_s = min(self._backoff_s * 2.0, _BACKOFF_CAP_S)
        finally:
            flush_task.cancel()
            try:
                await flush_task
            except asyncio.CancelledError:
                pass
            await self.flush_recording_now()
            if self._closed:
                self._close_recording()

    async def _partial_flusher(self) -> None:
        """Clock-driven right-edge flush (FLUSH_INTERVAL_NS, 20 Hz default).

        ``_consume`` only flushed partials while it was draining feed events,
        so a quiet or bursty feed (equity keyless polls every 10 s; sim/crypto
        burst every 250 ms and then sleep) froze the forming column between
        events — the heatmap right edge looked stalled even though the DOM
        board updated instantly. This task re-emits the in-progress column on a
        fixed cadence so the right edge animates continuously; it is a no-op
        while no client is attached and when the grid has no in-flight column.
        Cancelled by :meth:`run` on every exit (crash/restart keeps one task
        alive across feed restarts)."""
        interval_s = self._flush_interval_ns / 1e9
        while True:
            await asyncio.sleep(interval_s)
            if not self._clients:
                continue
            try:
                self._flush_partial()
            except Exception:  # noqa: BLE001 — a flush must never kill the session
                logger.exception(
                    "periodic partial flush failed for session %s", self.session_id
                )

    async def _consume(self) -> None:
        async for ev in self._feed.events():
            if self._stats is not None:
                # Liveness: age of the last feed-event ARRIVAL (wall clock, so
                # venue stamps can't fake freshness) feeds stats.staleness_ms.
                self._stats.note_live_sample(self.session_id)
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
            # Time-based recording flush cadence (FLOWMAP_FLUSH_INTERVAL_S):
            # buffers that have been accumulating longer than the cadence are
            # flushed even below REC_FLUSH_COLS, so a Windows hard close
            # (TerminateProcess — no lifespan flush_all) loses at most ~the
            # cadence in seconds, not a whole 64-column part. A stalled feed
            # buffers no rows, so per-event checking bounds the loss window.
            if self._rec is not None and (
                self._cols_since_flush >= REC_FLUSH_COLS
                or now - self._rec_cadence_ns >= self._rec_flush_interval_ns
            ):
                self._flush_recording()

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

    def _cache_encoded(self, col_seq: int, data: bytes) -> None:
        """LRU-store one finalized column's joined wire bytes (see
        ``_enc_cache``); capped at the snapshot window so entries evicted from
        the ring age out of the cache too."""
        enc = self._enc_cache
        enc[col_seq] = data
        enc.move_to_end(col_seq)
        while len(enc) > SNAPSHOT_COLS:
            enc.popitem(last=False)

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
            # Encode ONCE here (finalize time) and reuse the bytes for both
            # the broadcast and the attach snapshot — the snapshot used to
            # re-encode every column (~8-16 MB) inline on the event loop per
            # attach.
            depth_b = wire.encode(self._grid.to_depth(col))
            bar_b = wire.encode(col.bar)
            self._cache_encoded(col.col_seq, depth_b + bar_b)
            self._broadcast(depth_b, col=True, t0_ns=col.t0_ns)
            self._broadcast(bar_b, col=True, t0_ns=col.t0_ns)
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

    def _conn_latency_skew(self) -> tuple[float, float]:
        """Real per-connection latency/skew for Status frames.

        The WS layer installs ``conn_stats`` (campaign NEEDS-CORE #1): a
        callable returning ``{"latency_ms": float, "clock_skew_ms": float}``
        measured on THIS connection. Both Status fields used to be hardcoded
        0.0 while the measurement sat unused in the WS layer. Fully
        defensive: no hook (bare-core tests) or a raising/malformed hook
        yields the historical 0.0 values. The latest skew also feeds the
        manager-wide stats aggregate so /api/health carries it even before
        the WS layer calls ``record_clock_skew`` itself."""
        fn = self.conn_stats
        if fn is None:
            return 0.0, 0.0
        try:
            d = fn()
            latency = float(d.get("latency_ms", 0.0))
            skew = float(d.get("clock_skew_ms", 0.0))
        except Exception:  # noqa: BLE001 — a bad hook must not kill the broadcast
            logger.debug("conn_stats hook failed", exc_info=True)
            return 0.0, 0.0
        if self._stats is not None:
            self._stats.record_clock_skew(skew)
        return latency, skew

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
        latency_ms, skew_ms = self._conn_latency_skew()
        status = events.Status(
            feed_state="closed",
            capability=self._capability(),
            latency_ms=latency_ms,
            clock_skew_ms=skew_ms,
            next_open_ts=getattr(self._feed, "next_open_ts", None),
        )
        self._broadcast(wire.encode(status), col=False)

    def _set_feed_state(self, state: str) -> None:
        if state == self._feed_state:
            return
        self._feed_state = state
        latency_ms, skew_ms = self._conn_latency_skew()
        status = events.Status(
            feed_state=state,  # type: ignore[arg-type]
            capability=self._capability(),
            latency_ms=latency_ms,
            clock_skew_ms=skew_ms,
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
        densities over the most recent ≤64 columns, or 1.0 when empty.

        Non-finite values are filtered before the percentile: a ``+inf``
        texel rehydrated from a pre-clamp recording would otherwise make the
        p99 — and with it the wire ``norm_seed`` — infinite."""
        cols = self._grid.history(_T_MAX, 64)
        if not cols:
            return 1.0
        vals = np.concatenate([c.bid for c in cols] + [c.ask for c in cols]).astype(np.float64)
        vals = vals[np.isfinite(vals) & (vals > 0.0)]
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
            capability=self._capability(),
            norm_seed=self._norm_seed(),
        )
        # Hello first, then EpochStart for EVERY distinct epoch appearing in
        # the snapshot's columns (plus the current one), ascending — the
        # client must hold params for each epoch before decoding its columns.
        announce = self._epoch_start_msgs({c.epoch for c in cols} | {ep.epoch})
        frames = [b"".join([wire.encode(hello), *announce])]
        for i in range(0, len(cols), SNAPSHOT_CHUNK_COLS):
            chunk = cols[i : i + SNAPSHOT_CHUNK_COLS]
            # Served from the finalize-time encode cache where available (the
            # live path): zero re-encode, byte-identical (the cache holds the
            # exact bytes this session's finalize step produced). A miss
            # (rehydrated tail, backfill/replay seed, ring wrap) encodes once
            # with the SAME encoder calls and warms the cache.
            parts: list[bytes] = []
            for c in chunk:
                enc = self._enc_cache.get(c.col_seq)
                if enc is None:
                    enc = wire.encode(self._grid.to_depth(c)) + wire.encode(c.bar)
                    self._cache_encoded(c.col_seq, enc)
                parts.append(enc)
            frames.append(b"".join(parts))

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


class ReplayUnavailableError(RuntimeError):
    """Raised for ``mode='replay'`` subscriptions.

    This build has no replay engine: no feed reads a recording and the
    Seek/SetSpeed/Pause/Resume controls are not consumed. Refusing explicitly
    (instead of silently serving the LIVE feed under a replay label) is the
    honest behaviour — the client hides its Replay toggle unless a server
    advertises ``capability.replay``."""


class ReplayStaleError(ReplayUnavailableError):
    """Re-attach to an existing replay session whose recording moved on.

    A replay session's feed is a SNAPSHOT of the recording taken when the
    session was created; it can never serve columns recorded after its tail.
    When the on-disk recording has grown past that tail by more than
    :data:`REPLAY_STALE_TOL_NS`, a re-attach to the same key is refused
    instead of presenting the outdated replay as current (handoff §6).

    Subclasses :class:`ReplayUnavailableError` deliberately: the WS layer's
    existing honest-replay refusal (``Status{degraded}`` + close 1003) covers
    it with no new wiring, and the message carries the machine-checkable
    ``replay_stale`` token plus both tail positions."""


# Crypto grid shape FALLBACK (mirrors feeds.sim private constants: mid starts
# at 100.0, tick 0.5; kept local so this module does not reach into sim
# internals). Despite the names this shape prices REAL crypto books too: the
# first book re-anchors p0 to the real mid and a re-anchor scales via
# tick_multiple, which is correct for majors — but a sub-cent coin collapses
# into 1-2 rows at a 0.5 tick. The honest escapes, in priority order, are
# FLOWMAP_CRYPTO_TICK and a feed-declared ``preferred_tick`` (see
# :func:`_crypto_tick_for`); wiring venue tick metadata automatically is
# parked (needs the ccxt markets table at grid-build time).
_SIM_MID0 = 100.0
_SIM_TICK = 0.5
_SIM_ROWS = 2048


def _crypto_tick_for(feed: Feed, cfg_tick: float) -> float:
    """Resolve the crypto grid tick: config override, feed declaration, fallback.

    A venue's true tick is the right quantum for its own prices — the sim-shaped
    fallback cannot know it. Priority: an explicit server override wins (the
    operator can see what the venue lists), then a feed that declares
    ``preferred_tick``, then the fallback. Anything non-positive or non-finite
    is treated as "no answer" rather than trusted.
    """
    for candidate in (cfg_tick, getattr(feed, "preferred_tick", None)):
        if isinstance(candidate, (int, float)) and math.isfinite(candidate) and candidate > 0:
            return float(candidate)
    return _SIM_TICK

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
        backfill_fn: BackfillFn | None = None,
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
        # First-launch history backfill seam (GOAL 1). None disables it — the
        # default for deterministic tests; create_app wires the network seam in.
        self._backfill_fn = backfill_fn
        # Server-wide telemetry producer (campaign contract C1), mounted at
        # ``stats`` — the api layer resolves it via ``manager.stats.snapshot()``
        # and renders the dict verbatim. Always present (cheap); the getattr
        # guard on the SB side is pure future-proofing. Shares the manager's
        # injectable wall clock so staleness ages are deterministic in tests.
        self.stats = SessionStats(
            wall_clock=wall_clock, active_sessions=lambda: len(self._sessions)
        )
        # Keyed by (market, symbol, mode, source, band) — live sessions; a
        # replay key additionally carries (start_t, end_t) because the
        # window is identity (see _subscribe). The band is part of the grid
        # geometry, so two bands are genuinely two grids.
        self._sessions: dict[tuple, Session] = {}

    def _default_feed_factory(self, sub: events.Subscribe) -> Feed:
        # Test path: the sim feed is unpaced so tests own the clock. Routing
        # itself lives in feeds.router — see the note there about the copy this
        # replaced. The stats aggregate rides along so live feeds count their
        # drops at the source.
        return build_feed(sub, self._cfg, realtime_sim=False, stats=self.stats)

    def _grid_for(self, feed: Feed, band: str = DEFAULT_BAND) -> Grid:
        if feed.market in EQUITY_MARKETS:
            return self._equity_grid_for(feed, band)
        tick = _crypto_tick_for(feed, self._cfg.crypto_tick)
        rows = min(_SIM_ROWS, self._cfg.max_rows)
        step = tick  # tick_multiple 1
        p0 = round((_SIM_MID0 - rows * step / 2.0) / step) * step
        spec = BANDS.get(band)
        if spec is not None and spec.rows > 0:
            rows = min(spec.rows, self._cfg.max_rows)
            p0 = round((_SIM_MID0 - rows * step / 2.0) / step) * step
        return Grid(
            GridCfg(
                tick=tick,
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
        derived from the feed's capability. Keyless SYNTH_PROFILE runs at the
        1 s keyless grid cadence (the feed re-asserts the resting profile every
        ``dt_equity_keyless_grid_ns`` while polling price every 10 s); keyed
        tiers (L1_BAND) run at the 1 s equity cadence. Cent tick; a nominal
        $100 p0 that the grid re-anchors to the symbol's real price on the
        first book (a >=$1 stock's profile near $180 pulls p0 up)."""
        depth = feed.capability.get("depth")
        mode = _EQUITY_DEPTH_MODE.get(depth, events.MODE_L1_BAND)
        dt = (
            self._cfg.dt_equity_keyless_grid_ns
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

    async def subscribe(
        self, sub: events.Subscribe, client: ClientTx, _retry: bool = True
    ) -> Session:
        """Attach ``client`` to the session for ``sub``'s key, creating and
        starting the session if needed (≤ ``cfg.max_sessions`` distinct keys).
        The snapshot frames are enqueued into ``client`` before returning, so
        they precede every live broadcast. Refused subscribes (session limit,
        replay unavailable/stale, invalid symbol) are counted in the stats
        aggregate before the error propagates to the WS layer's honest
        refusal path."""
        try:
            return await self._subscribe(sub, client, _retry)
        except (SessionLimitError, ReplayUnavailableError, ValueError):
            if self.stats is not None:
                self.stats.inc_rejected()
            raise

    async def _subscribe(
        self, sub: events.Subscribe, client: ClientTx, _retry: bool = True
    ) -> Session:
        """The subscribe body (see :meth:`subscribe`). ``_retry`` is internal:
        it bounds the single teardown-during-boot re-subscribe so a
        pathological teardown that keeps winning surfaces as an error instead
        of recursing forever."""
        band = canonical_band(sub.band)
        key = (sub.market, sub.symbol, sub.mode, sub.source, band)
        if sub.mode == "replay":
            # The requested recording window is part of the key: W1 and W2
            # are two different replays of the same symbol. Without this the
            # second re-attach silently inherited the FIRST session's window
            # (survey-1 #2 — silent wrong-data). Distinct windows open
            # distinct sessions; an idle parked variant of the same
            # symbol/mode is evicted on the new key (see _evict_other_bands).
            key = key + (sub.start_t, sub.end_t)
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
            if sub.mode == "replay":
                # The recording-backed replay engine: the recorder IS the data
                # source, so a replay session opens NO recorder of its own and
                # runs no backfill (both already gated on mode == "live").
                feed, replay_tail = await self._replay_feed(sub)
            else:
                feed, replay_tail = self._feed_factory(sub), None
            session = Session(
                f"{sub.market}:{sub.symbol}:{sub.mode}:{uuid.uuid4().hex[:12]}",
                feed=feed,
                grid=self._grid_for(feed, band),
                clock=self._clock,
                timer=self._timer,
                # Live mode only: replay sessions (M3) never self-record.
                recorder=self._recorder if sub.mode == "live" else None,
                wall_clock=self._wall_clock,
                # Live mode only: a replay session reads its own recording, never
                # a live candle backfill.
                backfill_fn=self._backfill_fn if sub.mode == "live" else None,
                backfill_max_cols=self._cfg.backfill_max_cols
                if self._cfg.backfill_enabled
                else 0,
                stats=self.stats,
                rec_flush_interval_s=self._cfg.rec_flush_interval_s,
                retention_min_interval_s=self._cfg.retention_min_interval_s,
            )
            session._on_teardown = self._make_remover(key, session)
            if replay_tail is not None:
                session.replay_tail_t0 = replay_tail.newest_t0_ns
                # A WINDOWED replay ([start_t, end_t)) is immutable history:
                # record the window end so the parked-replay freshness check
                # knows growth past it is expected, not staleness.
                session.replay_window_end_ns = sub.end_t
            if self.stats is not None:
                self.stats.note_session(session.session_id)
            self._sessions[key] = session
        elif sub.mode == "replay":
            # Parked-replay freshness policy (handoff §6): re-validate the
            # recording before handing the existing session out again. Raises
            # ReplayStaleError — refusing leaves the parked session untouched.
            # The disk probe runs off-loop (see the method): it used to parse
            # the newest part file inline in subscribe, stalling the loop.
            await self._recheck_replay_freshness(session, sub)
        # Unconditional (start() is idempotent/restart-safe): a session whose
        # feed ended normally must not be handed out as a zombie — a new
        # subscriber restarts the run task. First start boots (rehydrates)
        # BEFORE attach below, so the snapshot includes the recorded tail.
        # A boot can take seconds (executor Parquet load, backfill seam) and
        # holds zero clients, so a grace teardown (or `_evict_other_bands` from
        # a rival band) may fire mid-boot; `_teardown` then runs to completion
        # and can never run again. start() now declines to spawn the run task
        # on that dead session, and attach() raises — retry ONCE on the fresh
        # session the remover already installed under the key (L2).
        started = await session.start()
        if started is not None:
            try:
                frames = session.attach(client)
            except RuntimeError:
                if self._sessions.get(key) is session:
                    self._sessions.pop(key, None)
                if not _retry:
                    raise
                return await self.subscribe(sub, client, _retry=False)
        else:
            if self._sessions.get(key) is session:
                self._sessions.pop(key, None)
            if not _retry:
                raise RuntimeError(
                    f"session for {key!r} was torn down during boot twice; "
                    f"refusing to hand out a dead session"
                )
            return await self.subscribe(sub, client, _retry=False)
        for frame in frames:
            # Snapshot frames ride the non-column path (no column lag-drops)
            # and are protected: cap eviction must never drop Hello.
            client.offer(frame, col_msg=False, t0_ns=None, protected=True)
        return session

    async def _replay_feed(self, sub: events.Subscribe) -> tuple[ReplayFeed, TailData]:
        """Build the recording-backed replay feed for ``sub``, or refuse.

        Returns the feed and the tail it was built from (the manager records
        the tail's newest ``t0_ns`` on the session so re-attaches can detect a
        recording that has moved on). The recorder is the replay data source:
        a store-less manager (tests) or a symbol with no recording raises
        :class:`ReplayUnavailableError`, which the WS layer turns into an
        explicit refusal — never a live feed under a replay label.

        Honoring ``Subscribe.start_t`` / ``end_t`` (NEEDS-CORE #2): a
        windowed subscription loads only ``[start_t, end_t)`` through the
        recorder's public ranged read (:meth:`Recorder.load_tail`, capped at
        the ring).

        A no-window subscription — which used to materialize the ENTIRE
        recording via ``load_all`` (multi-GB RAM for long recordings, survey-1
        #1) — now serves the NEWEST bounded window: the same ``ring_columns``
        cap the windowed path uses, overridable via
        ``FLOWMAP_REPLAY_MAX_COLS``. When the recording is longer, the load is
        truncated to that window and a warning is logged; an explicit
        [start_t, end_t) window is never affected by this bound.

        The load runs in the default executor exactly like boot rehydration:
        doing it inline stalled the event loop — and every other session and
        client — for the whole Parquet read."""
        if self._recorder is None:
            raise ReplayUnavailableError(
                "replay needs a recording store; this manager has none"
            )
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None, self._replay_feed_blocking, sub.market, sub.symbol, sub.start_t, sub.end_t
        )

    def _replay_feed_blocking(
        self, market: str, symbol: str, start_t: int | None, end_t: int | None
    ) -> tuple[ReplayFeed, TailData]:
        """Blocking recorder IO + feed construction for :meth:`_replay_feed`
        (runs in the executor)."""
        assert self._recorder is not None
        if start_t is None and end_t is None:
            # Bounded newest-window read (survey-1 #1): the client asked for
            # "the replay", not "every byte ever recorded". Default cap = the
            # same ring_columns the windowed path applies; the env knob may
            # deepen it deliberately. Truncation is NOT silent: it is flagged
            # by TailData.truncated and logged here; callers that need older
            # data must send an explicit [start_t, end_t) window.
            limit_cols = self._cfg.replay_max_cols or self._cfg.ring_columns
            tail = self._recorder.load_tail(
                market,
                symbol,
                max_age_ns=2**62,
                now_ns=2**62,
                limit_cols=limit_cols,
            )
            if tail is not None and (
                tail.truncated or tail.trades_truncated or tail.markers_truncated
            ):
                logger.warning(
                    "replay load for %s:%s truncated to the newest %d columns "
                    "(columns=%s trades=%s markers=%s); send a "
                    "[start_t, end_t) window for older data or raise "
                    "FLOWMAP_REPLAY_MAX_COLS",
                    market,
                    symbol,
                    limit_cols,
                    tail.truncated,
                    tail.trades_truncated,
                    tail.markers_truncated,
                )
        else:
            if start_t is not None and end_t is not None and end_t <= start_t:
                raise ReplayUnavailableError(
                    f"empty replay window [{start_t}, {end_t}) for "
                    f"{market}:{symbol} — replay unavailable"
                )
            # Ranged read over [start_t, end_t): ``now_ns - max_age_ns`` yields
            # the window's start cutoff, ``end_ns`` bounds it above, and the
            # cap is the ring — a window can never serve more than the newest
            # ring_columns of data anyway. An open-ended start_t uses the
            # sentinel "now" so the cutoff lands exactly on start_t.
            now_ns = end_t if end_t is not None else 2**62
            max_age_ns = now_ns - (start_t if start_t is not None else 0)
            tail = self._recorder.load_tail(
                market,
                symbol,
                max_age_ns=max_age_ns,
                now_ns=now_ns,
                limit_cols=self._cfg.ring_columns,
                end_ns=end_t,
            )
        if tail is None or not tail.columns:
            raise ReplayUnavailableError(
                f"no recording for {market}:{symbol} — replay unavailable"
            )
        return ReplayFeed(market=market, symbol=symbol, tail=tail), tail

    async def _recheck_replay_freshness(
        self, session: Session, sub: events.Subscribe
    ) -> None:
        """Re-validate an existing replay session's recording on re-attach.

        The replay feed replays the recording AS IT WAS when the session was
        created; columns recorded after its tail are unreachable from the
        parked feed. When the recording on disk has grown past the session's
        tail by more than :data:`REPLAY_STALE_TOL_NS` of recorded time, the
        subscribe is REFUSED with :class:`ReplayStaleError` instead of
        accepting (handoff §6: never present a stale replay as valid).

        A WINDOWED replay (``replay_window_end_ns`` set) is exempt: its
        ``[start_t, end_t)`` content is immutable history, so growth of the
        recording past the window's end is expected — refusing would demand a
        rebuild that returns the same window. (Growth BEFORE ``start_t`` is
        equally irrelevant: it can never enter the window.)

        The refusal touches nothing: the parked session keeps its clients and
        run task, and once the recording stops growing — or the session
        retires after its grace and a fresh one is built from the new tail —
        a re-subscribe succeeds again. An unreadable/absent recording counts
        as NOT stale: the probe must never invent staleness it cannot see.

        The probe (``newest_column_t0`` — open + parse of one Parquet part,
        up to ~4 MB) runs in the default executor: it used to run inline in
        subscribe, re-introducing exactly the event-loop stall the replay
        load itself was moved off-loop for."""
        if self._recorder is None or session.replay_tail_t0 is None:
            return
        if session.replay_window_end_ns is not None:
            return  # bounded window: immutable history, growth is expected
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None,
            self._recheck_replay_freshness_blocking,
            session,
            sub.market,
            sub.symbol,
        )

    def _recheck_replay_freshness_blocking(
        self, session: Session, market: str, symbol: str
    ) -> None:
        """Blocking probe + staleness verdict for
        :meth:`_recheck_replay_freshness` (runs in the executor)."""
        assert self._recorder is not None
        tail_t0 = session.replay_tail_t0
        assert tail_t0 is not None
        disk_t0 = self._recorder.newest_column_t0(market, symbol)
        if disk_t0 is None or disk_t0 <= tail_t0 + REPLAY_STALE_TOL_NS:
            return
        raise ReplayStaleError(
            f"replay_stale: recording for {market}:{symbol} has grown "
            f"past the parked session's tail (recorded through {disk_t0}, "
            f"session tail {tail_t0}, tolerance {REPLAY_STALE_TOL_NS} ns) — "
            f"re-subscribe once the old session retires"
        )

    def _evict_other_bands(self, key: tuple) -> None:
        """Tear down idle sessions that share ``key``'s symbol/mode/source.

        Called before creating a new variant of the same stream. For a live
        key the variants are bands; for a replay key they are bands AND
        [start_t, end_t) windows. Idle variants (no attached clients) are
        torn down at once — a client cycling preset bands or replay windows
        must not pin one ring per variant for the grace period; a variant
        someone else is still watching is left alone — it is a legitimate
        concurrent session, not a leak.
        """
        market, symbol, mode, source = key[:4]
        for other in list(self._sessions):
            if other == key or other[:4] != (market, symbol, mode, source):
                continue
            sess = self._sessions.get(other)
            if sess is None or sess.client_count > 0:
                continue
            self._sessions.pop(other, None)
            sess.teardown_now()

    def _make_remover(self, key: tuple, session: Session) -> Callable[[], None]:
        def _remove() -> None:
            # Identity-guarded: a stale grace timer from a torn-down session
            # must never evict a fresh session that reused the key.
            if self._sessions.get(key) is session:
                del self._sessions[key]
                # Drop the session's staleness entry too — a dead session must
                # not linger in the stats as an "active" staleness subject.
                if self.stats is not None:
                    self.stats.forget_session(session.session_id)

        return _remove

    async def unsubscribe(self, session: Session, client: ClientTx) -> None:
        session.detach(client)

    async def flush_all(self) -> None:
        """Server-shutdown hook (the api.app lifespan): flush every active
        session's buffered recording rows to disk. Without it, up to
        REC_FLUSH_COLS buffered columns plus trades are lost on every
        sidecar kill. ``return_exceptions`` so one broken session cannot
        skip the others'; ``flush_recording_now`` already logs and contains
        its own failures."""
        sessions = list(self._sessions.values())
        if sessions:
            await asyncio.gather(
                *(s.flush_recording_now() for s in sessions),
                return_exceptions=True,
            )
