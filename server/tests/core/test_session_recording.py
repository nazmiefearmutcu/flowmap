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
    orig_flush = SessionRecorder.flush

    def counting_flush(self):
        flush_sizes.append(len(self._columns))
        return orig_flush(self)

    monkeypatch.setattr(SessionRecorder, "flush", counting_flush)

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

    # Cadence flushes happened DURING the run (≥2 with ≥8 buffered columns),
    # plus the feed-end flush from run()'s finally.
    cadence = [n for n in flush_sizes if n >= 8]
    assert len(cadence) >= 2
    assert len(flush_sizes) >= len(cadence) + 1

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
# b. flush failure: logged, disabled, feed loop survives


async def test_flush_failure_disables_recording_but_session_continues(
    tmp_path, monkeypatch, caplog
):
    monkeypatch.setattr(session_mod, "REC_FLUSH_COLS", 4)
    monkeypatch.setattr(
        SessionRecorder,
        "flush",
        lambda self: (_ for _ in ()).throw(OSError("disk full")),
    )

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
        await _wait_for(lambda: sess._rec is None)

    assert any("recording flush failed" in r.getMessage() for r in caplog.records)
    assert not sess.run_task.done()  # the feed loop survived

    # Broadcasting continues after the failure.
    _drain(client)
    feed.q.put_nowait(BookState(6 * DT, *_book(100.0)))
    feed.q.put_nowait(BookState(7 * DT, *_book(100.0)))
    later = await _wait_for(
        lambda: [e for e in _drain(client) if isinstance(e, DepthColumn) and e.final]
        or None
    )
    assert later
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
