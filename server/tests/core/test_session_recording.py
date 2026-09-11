"""Session recording + rehydration wiring tests (M1 T11; spec §7, §8.1).

Pins the five behaviors deferred from T10 into the session layer:

a. a live session records epochs/columns/trades and flushes at the
   REC_FLUSH_COLS cadence, at feed end, and on teardown (close()),
b. a flush failure is logged, disables recording for the session, and the
   session keeps broadcasting (recording NEVER kills the feed loop),
c. rehydration: a fresh session for a previously recorded (market, symbol)
   serves the recorded tail in its attach snapshot, with a gap Marker, and
   live columns continue with non-overlapping col_seq,
d. a stale tail (older than one ring span) means a cold start, no crash,
e. an unusable tail (grid shape changed between runs) degrades to a cold
   start via the wrapped preload, never a crashed subscribe.

All sessions here force recording on via an explicit ``recorder=`` argument
(the sim market records like any live session when a Recorder is wired in);
wall clocks are injected so freshness is deterministic. Grid-level
``preload`` validation lives in tests/core/test_grid.py.
"""

from __future__ import annotations

import asyncio
import logging
import time

import numpy as np

import flowmap_server.core.session as session_mod
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.record import Recorder, SessionRecorder
from flowmap_server.core.session import ClientTx, Session
from flowmap_server.feeds.base import BookState
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto import wire
from flowmap_server.proto.events import (
    MODE_L2,
    SIDE_BUY,
    SIDE_SRC_EXCHANGE,
    DepthColumn,
    EpochStart,
    Hello,
    Marker,
    Trade,
)

DT = 250_000_000
ROWS = 256
TICK = 0.5
P0 = 100.0 - ROWS * TICK / 2  # sim mid ~100 centered

MARKET, SYMBOL = "sim", "SIM-DEMO"

# ---------------------------------------------------------------------------
# helpers


def _cfg(rows: int = ROWS, ring_columns: int = 1024) -> GridCfg:
    return GridCfg(
        tick=TICK,
        tick_multiple=1,
        dt_ns=DT,
        p0=100.0 - rows * TICK / 2,
        rows=rows,
        ring_columns=ring_columns,
        mode=MODE_L2,
    )


def _book(mid: float, sz: float = 5.0):
    px = np.array([mid - 1.0, mid - 0.5, mid], dtype=np.float64)
    return (px, np.full(3, sz), px + 0.5, np.full(3, sz))


class _FakeHandle:
    def __init__(self, delay_s, cb):
        self.delay_s, self.cb, self.cancelled = delay_s, cb, False

    def cancel(self):
        self.cancelled = True

    def fire(self):
        if not self.cancelled:
            self.cb()


class FakeTimer:
    def __init__(self):
        self.entries: list[_FakeHandle] = []

    def __call__(self, delay_s, cb):
        h = _FakeHandle(delay_s, cb)
        self.entries.append(h)
        return h


class DrivenFeed:
    """Feed driven by the test: push events, push None to end normally."""

    market = MARKET
    symbol = SYMBOL
    capability: dict[str, object] = {"depth": "L2"}

    def __init__(self):
        self.q: asyncio.Queue = asyncio.Queue()

    async def events(self):
        while True:
            ev = await self.q.get()
            if ev is None:
                return
            yield ev


class CappedFeed:
    """Wraps a feed, stopping after ``max_events`` (deterministic end)."""

    def __init__(self, inner, max_events: int):
        self._inner, self._max = inner, max_events
        self.market, self.symbol = inner.market, inner.symbol
        self.capability = inner.capability

    async def events(self):
        n = 0
        async for ev in self._inner.events():
            yield ev
            n += 1
            if n >= self._max:
                return


def _decode_frames(frames: list[bytes]) -> list:
    out = []
    for frame in frames:
        off = 0
        while off < len(frame):
            ev, off = wire.decode(frame, off)
            if ev is not None:
                out.append(ev)
    return out


def _drain(client: ClientTx) -> list:
    return _decode_frames(client.drain(1 << 30))


def _prerecord_tail(root: Recorder, cfg: GridCfg, n_cols: int = 20):
    """Record ``n_cols`` finalized columns (+ trades, epoch 0) for MARKET/SYMBOL
    with a source grid of exactly ``cfg`` — what a previous run would leave."""
    src = Grid(cfg)
    src.on_book(0, *_book(100.0))
    cols, trades = [], []
    for i in range(1, n_cols + 1):
        t = Trade(
            ts_ns=i * DT - 5,
            price=100.0,
            size=1.5,
            side=SIDE_BUY,
            side_src=SIDE_SRC_EXCHANGE,
            venue="sim",
        )
        src.on_trade(t.ts_ns, t.price, t.size, t.side)
        trades.append(t)
        cols += src.on_book(i * DT, *_book(100.0))
    rec = root.open_session(MARKET, SYMBOL)
    rec.record_epoch(src.epoch_params_for(0))
    for c in cols:
        rec.record_column(c)
    for t in trades:
        rec.record_trade(t)
    rec.close()
    return cols


async def _wait_for(predicate, timeout=10.0):
    async with asyncio.timeout(timeout):
        while True:
            r = predicate()
            if r:
                return r
            await asyncio.sleep(0.01)


# ---------------------------------------------------------------------------
# a. recording + flush cadence


async def test_live_session_records_columns_epochs_trades_with_cadence(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(session_mod, "REC_FLUSH_COLS", 8)
    flush_sizes: list[int] = []
    orig_flush = SessionRecorder.flush_buffers

    def counting_flush(self, bufs):
        # bufs = (columns, trades, markers, epochs) — the snapshot the
        # cadence flush task hands to the writer thread.
        flush_sizes.append(len(bufs[0]))
        return orig_flush(self, bufs)

    monkeypatch.setattr(SessionRecorder, "flush_buffers", counting_flush)

    root = Recorder(tmp_path / "rec", 20.0)
    feed = CappedFeed(SimFeed(seed=42, dt_ns=DT, start_ns=0), 400)
    sess = Session(
        "rec-a", feed=feed, grid=Grid(_cfg()), recorder=root, timer=FakeTimer()
    )
    client = ClientTx()
    sess.attach(client)
    await sess.start()
    await asyncio.wait_for(sess.run_task, timeout=15)

    finals = [
        e for e in _drain(client) if isinstance(e, DepthColumn) and e.final
    ]
    assert len(finals) >= 16  # enough columns to cross the cadence twice

    # Cadence flush happened DURING the run (≥8 buffered columns in one
    # snapshot), plus the feed-end flush from run()'s finally. With the
    # off-loop flush an unpaced feed can drain faster than its single
    # in-flight flush — extra cadence ticks are then skipped by design and
    # the rows ride the end flush; the round-trip below pins that nothing
    # is lost or duplicated.
    cadence = [n for n in flush_sizes if n >= 8]
    assert len(cadence) >= 1
    assert len(flush_sizes) >= 2

    # Round-trip: everything broadcast is on disk (columns, epoch 0, trades).
    tail = root.load_tail(
        MARKET, SYMBOL, max_age_ns=10**18, now_ns=10**18, limit_cols=10_000
    )
    assert tail is not None
    assert [c.col_seq for c in tail.columns] == [c.col_seq for c in finals]
    assert tail.epochs[0].epoch == 0 and tail.epochs[0].rows == ROWS
    assert tail.trades  # sim emits trades; they were recorded


async def test_teardown_closes_recorder_and_flushes_buffered_rows(tmp_path):
    root = Recorder(tmp_path / "rec", 20.0)
    feed = DrivenFeed()
    timer = FakeTimer()
    sess = Session(
        "rec-close", feed=feed, grid=Grid(_cfg()), recorder=root, timer=timer
    )
    client = ClientTx()
    sess.attach(client)
    await sess.start()

    # 3 finalized columns — far below the 64-column cadence: everything
    # stays buffered until teardown's close().
    for i in range(4):
        feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
    finals = await _wait_for(
        lambda: [e for e in _drain(client) if isinstance(e, DepthColumn) and e.final]
        or None
    )
    await _wait_for(lambda: sess._cols_since_flush >= 3)
    assert not list((tmp_path / "rec").rglob("*-columns-*.parquet"))

    sess.detach(client)
    (grace,) = timer.entries
    grace.fire()  # teardown: close() flushes buffered rows
    await asyncio.gather(sess.run_task, return_exceptions=True)

    assert sess._rec is None
    tail = root.load_tail(
        MARKET, SYMBOL, max_age_ns=10**18, now_ns=10**18, limit_cols=100
    )
    assert tail is not None and len(tail.columns) == 3
    del finals


# ---------------------------------------------------------------------------
# b. flush failure: logged, counted, RETRIED after a cooldown; feed survives


async def test_transient_flush_failure_retries_and_session_continues(
    tmp_path, monkeypatch, caplog
):
    """A transient flush failure (disk full, AV scan lock) must NOT end
    recording: the failed snapshot's rows are restored to the buffers and the
    flush retries after the cooldown — the rows land on the retry, and the
    feed loop keeps broadcasting throughout."""
    monkeypatch.setattr(session_mod, "REC_FLUSH_COLS", 4)
    monkeypatch.setattr(session_mod, "_REC_RETRY_BASE_S", 0.05)  # fast cooldown
    orig = SessionRecorder.flush_buffers
    state = {"n": 0}

    def failing_once(self, bufs):
        state["n"] += 1
        if state["n"] == 1:
            raise OSError("disk full")
        return orig(self, bufs)

    monkeypatch.setattr(SessionRecorder, "flush_buffers", failing_once)

    root = Recorder(tmp_path / "rec", 20.0)
    feed = DrivenFeed()
    sess = Session(
        "rec-b", feed=feed, grid=Grid(_cfg()), recorder=root, timer=FakeTimer()
    )
    client = ClientTx()
    sess.attach(client)
    with caplog.at_level(logging.ERROR, logger="flowmap_server.core.session"):
        await sess.start()
        for i in range(6):  # 5 finalized columns -> crosses the cadence of 4
            feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
        await _wait_for(lambda: state["n"] >= 1)

    assert any("recording flush failed" in r.getMessage() for r in caplog.records)
    assert not sess.run_task.done()  # the feed loop survived
    assert sess._rec is not None  # recording NOT disabled by the transient error

    # Let the cooldown elapse, then more events drive the cadence check into
    # the retry: the restored rows plus the new ones land on disk.
    await asyncio.sleep(0.1)
    feed.q.put_nowait(BookState(6 * DT, *_book(100.0)))
    feed.q.put_nowait(BookState(7 * DT, *_book(100.0)))

    async def _wait_flushed():
        while state["n"] < 2:
            await asyncio.sleep(0.01)
        return True

    await asyncio.wait_for(_wait_flushed(), timeout=5)
    # Wait on the RESET STATE, not the parquet file: the flush thread writes the
    # file before the loop resumes the coroutine that clears the retry counters
    # (races on slower runners — pin order on the event loop's own state).
    await _wait_for(lambda: sess._rec_failures == 0 and sess._rec_retry_at is None)
    assert list((tmp_path / "rec").rglob("*-columns-*.parquet"))

    # Broadcasting continued after the failure the whole time.
    later = [e for e in _drain(client) if isinstance(e, DepthColumn) and e.final]
    assert later
    feed.q.put_nowait(None)
    await asyncio.wait_for(sess.run_task, timeout=5)

    # Round-trip: every broadcast column is on disk exactly once (nothing was
    # lost by the failed flush, nothing duplicated by the retry).
    tail = root.load_tail(
        MARKET, SYMBOL, max_age_ns=10**18, now_ns=10**18, limit_cols=100
    )
    assert tail is not None
    finals = [
        e
        for e in later
        if isinstance(e, DepthColumn) and e.final
    ]
    disk_seqs = sorted(c.col_seq for c in tail.columns)
    assert disk_seqs == sorted({c.col_seq for c in later})


async def test_flush_failure_cooldown_skips_immediate_retry(tmp_path, monkeypatch):
    """Inside the cooldown the cadence must NOT re-enter the flush (the
    backoff ladder is why the delay exists); after it expires, the retry
    proceeds."""
    monkeypatch.setattr(session_mod, "REC_FLUSH_COLS", 2)
    calls = {"n": 0}

    def failing(self, bufs):
        calls["n"] += 1
        raise OSError("still broken")

    monkeypatch.setattr(SessionRecorder, "flush_buffers", failing)

    root = Recorder(tmp_path / "rec", 20.0)
    feed = DrivenFeed()
    clock_ns = {"now": 0}

    def fake_clock():
        return clock_ns["now"]

    sess = Session(
        "cooldown",
        feed=feed,
        grid=Grid(_cfg()),
        recorder=root,
        clock=fake_clock,
        timer=FakeTimer(),
    )
    sess.attach(ClientTx())
    await sess.start()
    for i in range(4):  # crosses the cadence of 2 -> first flush attempt
        feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
    await _wait_for(lambda: sess._rec_failures == 1 and sess._rec_retry_at is not None)
    cooldown_end = sess._rec_retry_at
    assert cooldown_end > clock_ns["now"]

    attempts = calls["n"]
    # More columns arrive while the cooldown is active: no new flush attempt.
    for i in range(4, 8):
        feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
    await asyncio.sleep(0.05)
    assert calls["n"] == attempts  # cooldown held

    # Advance the clock past the cooldown: the next cadence crossing retries
    # (and fails again, escalating the backoff).
    clock_ns["now"] = cooldown_end + 1
    feed.q.put_nowait(BookState(8 * DT, *_book(100.0)))
    await _wait_for(lambda: sess._rec_failures == 2)  # backoff escalated
    feed.q.put_nowait(None)
    await asyncio.wait_for(sess.run_task, timeout=5)


async def test_broken_recorder_still_disables_recording(
    tmp_path, monkeypatch, caplog
):
    """Only a recorder that cannot even take its rows BACK (restore fails)
    permanently disables recording — the old last-resort contract."""
    monkeypatch.setattr(session_mod, "REC_FLUSH_COLS", 2)

    def failing(self, bufs):
        raise OSError("disk gone")

    monkeypatch.setattr(SessionRecorder, "flush_buffers", failing)
    monkeypatch.setattr(
        SessionRecorder,
        "restore_buffers",
        lambda self, bufs: (_ for _ in ()).throw(RuntimeError("recorder wedged")),
    )

    root = Recorder(tmp_path / "rec", 20.0)
    feed = DrivenFeed()
    sess = Session(
        "rec-dead", feed=feed, grid=Grid(_cfg()), recorder=root, timer=FakeTimer()
    )
    client = ClientTx()
    sess.attach(client)
    caplog.set_level(logging.ERROR, logger="flowmap_server.core.session")
    await sess.start()
    for i in range(4):
        feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
    await _wait_for(lambda: sess._rec is None)
    assert not sess.run_task.done()  # the feed loop STILL survives
    _drain(client)
    feed.q.put_nowait(None)
    await asyncio.wait_for(sess.run_task, timeout=5)


# ---------------------------------------------------------------------------
# c. rehydration: snapshot = recorded tail + gap marker; live seq continues


async def test_rehydration_snapshot_gap_marker_and_live_continuation(tmp_path):
    root = Recorder(tmp_path / "rec", 20.0)
    cols = _prerecord_tail(root, _cfg(), n_cols=20)
    newest_t0 = cols[-1].t0_ns

    # "Now" is just after the tail: comfortably fresher than one ring span.
    now_ns = newest_t0 + 40 * DT
    feed = DrivenFeed()
    sess = Session(
        "rec-c",
        feed=feed,
        grid=Grid(_cfg()),
        recorder=root,
        wall_clock=lambda: now_ns,
        timer=FakeTimer(),
    )
    await sess.start()
    client = ClientTx()
    snap = _decode_frames(sess.attach(client))

    assert isinstance(snap[0], Hello)
    snap_cols = [e for e in snap if isinstance(e, DepthColumn)]
    assert [c.col_seq for c in snap_cols] == [c.col_seq for c in cols]
    assert all(c.final for c in snap_cols)
    gap_markers = [e for e in snap if isinstance(e, Marker) and e.kind == "gap"]
    assert len(gap_markers) == 1
    assert gap_markers[0].text.startswith("restart:")
    assert newest_t0 <= gap_markers[0].ts_ns < newest_t0 + DT
    assert any(isinstance(e, Trade) for e in snap)  # tape warm-up from tail

    # Live events resume at "now": col_seq continues past the tail with a
    # strictly newer t0 (no overlap; the gap marker covers the discontinuity).
    feed.q.put_nowait(BookState(now_ns, *_book(100.0)))
    feed.q.put_nowait(BookState(now_ns + DT, *_book(100.0)))
    live = await _wait_for(
        lambda: [e for e in _drain(client) if isinstance(e, DepthColumn) and e.final]
        or None
    )
    assert live[0].col_seq == cols[-1].col_seq + 1
    assert live[0].t0_ns == (now_ns // DT) * DT > newest_t0
    feed.q.put_nowait(None)
    await asyncio.wait_for(sess.run_task, timeout=5)


# ---------------------------------------------------------------------------
# d. stale tail -> cold start, no crash


async def test_stale_tail_cold_start(tmp_path):
    cfg = _cfg(ring_columns=64)  # ring span = 64 * DT = 16 s
    root = Recorder(tmp_path / "rec", 20.0)
    cols = _prerecord_tail(root, cfg, n_cols=10)

    # Everything recorded is older than one ring span before "now".
    now_ns = cols[-1].t0_ns + 1000 * DT
    feed = DrivenFeed()
    sess = Session(
        "rec-d",
        feed=feed,
        grid=Grid(cfg),
        recorder=root,
        wall_clock=lambda: now_ns,
        timer=FakeTimer(),
    )
    await sess.start()
    client = ClientTx()
    snap = _decode_frames(sess.attach(client))
    assert isinstance(snap[0], Hello)
    assert not any(isinstance(e, DepthColumn) for e in snap)  # cold: no tail

    feed.q.put_nowait(BookState(now_ns, *_book(100.0)))
    feed.q.put_nowait(BookState(now_ns + DT, *_book(100.0)))
    live = await _wait_for(
        lambda: [e for e in _drain(client) if isinstance(e, DepthColumn) and e.final]
        or None
    )
    assert live[0].col_seq == 0  # fresh grid: sequence starts over
    feed.q.put_nowait(None)
    await asyncio.wait_for(sess.run_task, timeout=5)


# ---------------------------------------------------------------------------
# e. unusable tail (grid shape changed): wrapped preload -> cold start


async def test_mismatched_tail_degrades_to_cold_start(tmp_path, caplog):
    root = Recorder(tmp_path / "rec", 20.0)
    cols = _prerecord_tail(root, _cfg(rows=ROWS), n_cols=5)

    # The new session runs a DIFFERENT grid shape: the recorded epochs no
    # longer match -> preload raises -> logged cold start, session usable.
    feed = DrivenFeed()
    sess = Session(
        "rec-e",
        feed=feed,
        grid=Grid(_cfg(rows=128)),
        recorder=root,
        wall_clock=lambda: cols[-1].t0_ns + DT,
        timer=FakeTimer(),
    )
    with caplog.at_level(logging.ERROR, logger="flowmap_server.core.session"):
        await sess.start()
    assert any(
        "rehydration preload failed" in r.getMessage() for r in caplog.records
    )
    client = ClientTx()
    snap = _decode_frames(sess.attach(client))
    assert isinstance(snap[0], Hello)
    assert not any(isinstance(e, DepthColumn) for e in snap)
    assert sess._rec is not None  # recording itself is still on
    feed.q.put_nowait(None)
    await asyncio.wait_for(sess.run_task, timeout=5)


# ---------------------------------------------------------------------------
# f. live re-anchor is recorded and rehydrates as a multi-epoch tail


async def test_live_reanchor_recorded_and_rehydrated(tmp_path):
    """A re-anchor fired by the live feed (mid drifts out of band) records
    epoch 1, and a fresh session rehydrates BOTH epochs — the exact path the
    live Binance run exercised (epochs [0, 1])."""
    root = Recorder(tmp_path / "rec", 20.0)
    feed = DrivenFeed()
    sess = Session(
        "rec-f", feed=feed, grid=Grid(_cfg()), recorder=root, timer=FakeTimer()
    )
    client = ClientTx()
    sess.attach(client)
    await sess.start()

    # Band for _cfg() is ~[55.2, 144.8); mid 160 forces a re-anchor to epoch 1.
    feed.q.put_nowait(BookState(0, *_book(100.0)))
    feed.q.put_nowait(BookState(DT, *_book(100.0)))  # finalize epoch-0 col
    feed.q.put_nowait(BookState(2 * DT, *_book(160.0)))  # triggers re-anchor
    feed.q.put_nowait(BookState(3 * DT, *_book(160.0)))  # finalize epoch-1 col
    feed.q.put_nowait(BookState(4 * DT, *_book(160.0)))
    feed.q.put_nowait(None)
    await asyncio.wait_for(sess.run_task, timeout=5)

    # Recorded tail spans both epochs.
    now = 5 * DT
    tail = root.load_tail(
        MARKET, SYMBOL, max_age_ns=10**18, now_ns=now, limit_cols=100
    )
    assert tail is not None
    assert {c.epoch for c in tail.columns} == {0, 1}
    assert {e.epoch for e in tail.epochs} == {0, 1}

    # A brand-new session rehydrates the multi-epoch tail: its snapshot
    # announces EpochStart for BOTH epochs before their columns.
    newest_t0 = tail.columns[-1].t0_ns
    sess2 = Session(
        "rec-f2",
        feed=DrivenFeed(),
        grid=Grid(_cfg()),
        recorder=Recorder(tmp_path / "rec", 20.0),
        wall_clock=lambda: newest_t0 + 10 * DT,
        timer=FakeTimer(),
    )
    await sess2.start()
    c2 = ClientTx()
    snap = _decode_frames(sess2.attach(c2))
    epochs_announced = [e.epoch for e in snap if isinstance(e, EpochStart)]
    assert set(epochs_announced) == {0, 1}
    snap_cols = [e for e in snap if isinstance(e, DepthColumn)]
    assert {c.epoch for c in snap_cols} == {0, 1}
    # Every column's epoch was announced before that column in the stream.
    seen: set[int] = set()
    for e in snap:
        if isinstance(e, EpochStart):
            seen.add(e.epoch)
        elif isinstance(e, DepthColumn):
            assert e.epoch in seen


# ---------------------------------------------------------------------------
# g. a feed-delivered Marker is recorded


async def test_feed_marker_is_recorded(tmp_path):
    root = Recorder(tmp_path / "rec", 20.0)
    feed = DrivenFeed()
    sess = Session(
        "rec-g", feed=feed, grid=Grid(_cfg()), recorder=root, timer=FakeTimer()
    )
    client = ClientTx()
    sess.attach(client)
    await sess.start()

    feed.q.put_nowait(BookState(0, *_book(100.0)))
    liq = Marker(ts_ns=DT // 2, kind="liquidation", price=100.0, size=3.0, text="")
    feed.q.put_nowait(liq)
    feed.q.put_nowait(BookState(DT, *_book(100.0)))
    feed.q.put_nowait(BookState(2 * DT, *_book(100.0)))
    feed.q.put_nowait(None)
    await asyncio.wait_for(sess.run_task, timeout=5)

    tail = root.load_tail(
        MARKET, SYMBOL, max_age_ns=10**18, now_ns=3 * DT, limit_cols=100
    )
    assert tail is not None
    assert any(m.kind == "liquidation" and m.size == 3.0 for m in tail.markers)


# ---------------------------------------------------------------------------
# h. cadence flush + retention run off the event loop


async def test_cadence_flush_runs_off_loop(tmp_path, monkeypatch):
    """The cadence Parquet write must run in a thread: the synchronous write
    stalled the event loop for the whole part write, every REC_FLUSH_COLS
    columns, per session. While the write is in flight a concurrent
    event-loop task keeps ticking."""
    monkeypatch.setattr(session_mod, "REC_FLUSH_COLS", 4)
    orig = SessionRecorder.flush_buffers

    def slow_flush(self, bufs):
        time.sleep(0.3)  # blocking write stand-in
        return orig(self, bufs)

    monkeypatch.setattr(SessionRecorder, "flush_buffers", slow_flush)

    root = Recorder(tmp_path / "rec", 20.0)
    feed = DrivenFeed()
    sess = Session(
        "off-loop", feed=feed, grid=Grid(_cfg()), recorder=root, timer=FakeTimer()
    )
    client = ClientTx()
    sess.attach(client)
    await sess.start()

    ticks = 0

    async def ticker():
        nonlocal ticks
        while True:
            ticks += 1
            await asyncio.sleep(0.005)

    spawner = asyncio.create_task(ticker())
    try:
        for i in range(6):  # 5 finalized columns -> crosses the cadence of 4
            feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
        await _wait_for(
            lambda: sess._flush_task is not None and not sess._flush_task.done()
        )
        ticks_before = ticks
        await asyncio.sleep(0.2)  # inside the 0.3 s blocking-write window
        assert ticks - ticks_before >= 10, "event loop stalled during the flush"
    finally:
        spawner.cancel()

    feed.q.put_nowait(None)
    await asyncio.wait_for(sess.run_task, timeout=10)


async def test_rows_recorded_during_flush_land_in_next_flush(tmp_path, monkeypatch):
    """Buffers are swapped out on the loop before the thread write: rows
    recorded WHILE a flush is in flight stay buffered and land later —
    nothing is lost or double-written by the off-loop flush."""
    monkeypatch.setattr(session_mod, "REC_FLUSH_COLS", 2)
    orig = SessionRecorder.flush_buffers
    calls = {"n": 0}

    def slow_first_flush(self, bufs):
        calls["n"] += 1
        if calls["n"] == 1:
            time.sleep(0.3)  # the first flush is still writing...
        return orig(self, bufs)

    monkeypatch.setattr(SessionRecorder, "flush_buffers", slow_first_flush)

    root = Recorder(tmp_path / "rec", 20.0)
    feed = DrivenFeed()
    sess = Session(
        "during-flush", feed=feed, grid=Grid(_cfg()), recorder=root, timer=FakeTimer()
    )
    client = ClientTx()
    sess.attach(client)
    await sess.start()

    for i in range(4):  # 3 finalized columns -> the first cadence flush fires
        feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
    await _wait_for(lambda: calls["n"] >= 1)
    for i in range(4, 8):  # ...these are recorded while it is in flight
        feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
    feed.q.put_nowait(None)
    await asyncio.wait_for(sess.run_task, timeout=10)

    tail = root.load_tail(
        MARKET, SYMBOL, max_age_ns=10**18, now_ns=10**18, limit_cols=100
    )
    assert tail is not None
    seqs = [c.col_seq for c in tail.columns]
    # 8 books at t0 = 0..7*DT finalize columns 0..6; every one on disk once.
    assert sorted(seqs) == list(range(7))


async def test_retention_walks_serialize(tmp_path, monkeypatch):
    """Every flushing session runs its own retention walk in a thread: two
    overlapping rglob/stat/unlink passes over the shared root must never
    happen (serialized inside Recorder.enforce_retention)."""
    root = Recorder(tmp_path / "rec", 20.0)
    _prerecord_tail(root, _cfg(), n_cols=3)  # something real for the walk

    real = Recorder._enforce_retention_locked
    state = {"cur": 0, "max": 0}

    def slow(self):
        state["cur"] += 1
        state["max"] = max(state["max"], state["cur"])
        try:
            time.sleep(0.05)  # widen the race window
            return real(self)
        finally:
            state["cur"] -= 1

    # Patch the CRITICAL SECTION: the public method wraps it in the lock, so
    # two concurrent walks must enter it one at a time.
    monkeypatch.setattr(Recorder, "_enforce_retention_locked", slow)
    await asyncio.gather(
        asyncio.to_thread(root.enforce_retention),
        asyncio.to_thread(root.enforce_retention),
    )
    assert state["max"] == 1


# ---------------------------------------------------------------------------
# i. time-based flush cadence (FLOWMAP_FLUSH_INTERVAL_S; Windows hard close)


async def test_time_based_flush_lands_rows_below_column_cadence(tmp_path):
    """Below REC_FLUSH_COLS, buffered rows must still reach disk once the
    TIME cadence passes: a hard app close (TerminateProcess - no lifespan
    flush) loses at most ~the cadence in seconds, not a whole 64-column
    part. The cadence check rides per consumed event."""
    clock = {"now": 0}
    root = Recorder(tmp_path / "rec", 20.0)
    feed = DrivenFeed()
    sess = Session(
        "time-flush",
        feed=feed,
        grid=Grid(_cfg()),
        recorder=root,
        timer=FakeTimer(),
        clock=lambda: clock["now"],
        rec_flush_interval_s=0.05,
    )
    client = ClientTx()
    sess.attach(client)
    await sess.start()
    for i in range(3):  # 2 finalized columns - far below REC_FLUSH_COLS
        feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
    await _wait_for(lambda: sess._cols_since_flush >= 2)
    assert not list((tmp_path / "rec").rglob("*-columns-*.parquet"))

    # Advance the (injectable) clock past the cadence: the next event drives
    # the flush.
    clock["now"] = int(0.06 * 1e9)
    feed.q.put_nowait(BookState(3 * DT, *_book(100.0)))
    await _wait_for(
        lambda: bool(list((tmp_path / "rec").rglob("*-columns-*.parquet"))) or None
    )
    # The cadence anchor restarted at the successful flush.
    assert sess._rec_cadence_ns == clock["now"] or sess._cols_since_flush == 0
    feed.q.put_nowait(None)
    await asyncio.wait_for(sess.run_task, timeout=5)
    tail = root.load_tail(MARKET, SYMBOL, max_age_ns=10**18, now_ns=10**18, limit_cols=100)
    assert tail is not None and len(tail.columns) >= 2


# ---------------------------------------------------------------------------
# j. retention walk gated by a wall-clock min-interval


async def test_retention_walk_gated_by_min_interval(tmp_path, monkeypatch):
    """The rglob/stat retention walk runs at most once per
    ``retention_min_interval_s`` of session clock - not after EVERY cadence
    flush (per-flush walks over a multi-GB tree were pure disk churn)."""
    monkeypatch.setattr(session_mod, "REC_FLUSH_COLS", 2)
    calls = {"retention": 0, "flushes": 0}
    real_ret = Recorder.enforce_retention

    def counting_ret(self):
        calls["retention"] += 1
        return real_ret(self)

    monkeypatch.setattr(Recorder, "enforce_retention", counting_ret)
    real_flush = SessionRecorder.flush_buffers

    def counting_flush(self, bufs):
        calls["flushes"] += 1
        return real_flush(self, bufs)

    monkeypatch.setattr(SessionRecorder, "flush_buffers", counting_flush)

    clock = {"now": 0}
    root = Recorder(tmp_path / "rec", 20.0)
    feed = DrivenFeed()
    sess = Session(
        "ret-gate",
        feed=feed,
        grid=Grid(_cfg()),
        recorder=root,
        timer=FakeTimer(),
        clock=lambda: clock["now"],
        retention_min_interval_s=60.0,
    )
    sess.attach(ClientTx())
    await sess.start()

    # Flush #1 -> retention walk #1 (first ever: never gated).
    for i in range(3):
        feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
    await _wait_for(lambda: calls["retention"] >= 1)

    # Flush #2 immediately after (clock unchanged) -> still ONE walk.
    for i in range(3, 6):
        feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
    await _wait_for(lambda: calls["flushes"] >= 2)
    await asyncio.sleep(0.05)  # any ungated walk would have fired by now
    assert calls["retention"] == 1

    # Clock past the min-interval -> the next flush walks again.
    clock["now"] += int(61 * 1e9)
    for i in range(6, 9):
        feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
    await _wait_for(lambda: calls["retention"] >= 2)

    feed.q.put_nowait(None)
    await asyncio.wait_for(sess.run_task, timeout=5)


# ---------------------------------------------------------------------------
# k. restart backoff: deterministic escalation, jittered sleep


async def test_restart_backoff_doubles_with_full_jitter():
    """Full-jitter backoff: the backoff STATE still doubles deterministically
    (1 -> 2 -> 4 ... cap 30), and each sleep draws from [0, backoff) via the
    rng seam (pinned by call ORDER, never by wall timing - campaign rule 6)."""
    class _FakeRng:
        def __init__(self):
            self.calls: list[float] = []

        def uniform(self, lo: float, hi: float) -> float:
            self.calls.append(hi)
            return 0.001  # tiny, deterministic sleep

    class CrashTwiceFeed(DrivenFeed):
        def __init__(self):
            super().__init__()
            self.crashes = 0

        async def events(self):
            if self.crashes < 2:
                self.crashes += 1
                raise RuntimeError("venue died")
            while True:
                ev = await self.q.get()
                if ev is None:
                    return
                yield ev

    feed = CrashTwiceFeed()
    sess = Session(
        "jitter",
        feed=feed,
        grid=Grid(_cfg()),
        timer=FakeTimer(),
        restart_backoff_base_s=1.0,
    )
    rng = _FakeRng()
    sess._rng = rng
    sess.attach(ClientTx())
    await sess.start()
    await asyncio.sleep(0.05)  # two crashes -> two jittered restarts
    assert rng.calls == [1.0, 2.0]  # base, then doubled (exact: 1*2, 2*2)
    assert sess._backoff_s == 4.0
    feed.q.put_nowait(None)
    await asyncio.wait_for(sess.run_task, timeout=5)
