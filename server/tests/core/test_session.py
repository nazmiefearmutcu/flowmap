"""Session / subscription / backpressure tests (M1 plan Task 7).

Covers the eight frozen behaviors from the plan: snapshot shape, refcount +
grace teardown, column lag-dropping with gap markers, the non-column cap,
max_sessions, col_seq dedup, the live loop end-to-end, and handle_history.
Plus one bonus: feed crash -> degraded Status -> recovery.
"""

from __future__ import annotations

import asyncio
import logging

import numpy as np
import pytest

from flowmap_server.config import Config
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.session import (
    LAG_DROP_NS,
    ClientTx,
    Session,
    SessionLimitError,
    SessionManager,
)
from flowmap_server.feeds.base import BookState
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto import wire
from flowmap_server.proto.events import (
    BBO,
    MODE_L2,
    BarColumn,
    DepthColumn,
    EpochStart,
    Hello,
    HistoryRequest,
    HistoryResponse,
    Marker,
    Status,
    Subscribe,
    Trade,
)

DT = 250_000_000  # 250 ms

# ---------------------------------------------------------------------------
# helpers


class FakeClock:
    """Injectable monotonic-ns clock."""

    def __init__(self, t_ns: int = 0) -> None:
        self.t_ns = t_ns

    def __call__(self) -> int:
        return self.t_ns

    def advance(self, ns: int) -> None:
        self.t_ns += ns


class _FakeHandle:
    def __init__(self, delay_s: float, cb) -> None:
        self.delay_s = delay_s
        self.cb = cb
        self.cancelled = False

    def cancel(self) -> None:
        self.cancelled = True

    def fire(self) -> None:
        if not self.cancelled:
            self.cb()


class FakeTimer:
    """Injectable timer: records (delay, cb) pairs; fired manually."""

    def __init__(self) -> None:
        self.entries: list[_FakeHandle] = []

    def __call__(self, delay_s: float, cb) -> _FakeHandle:
        h = _FakeHandle(delay_s, cb)
        self.entries.append(h)
        return h


class IdleFeed:
    """Feed that never yields (for lifecycle tests: no event flood)."""

    market = "sim"
    symbol = "IDLE"
    capability: dict[str, object] = {"depth": "L2"}

    async def events(self):
        await asyncio.sleep(3600)
        if False:  # pragma: no cover - makes this an async generator
            yield None


class CappedFeed:
    """Wraps a feed, stopping after ``max_events`` (deterministic e2e cap)."""

    def __init__(self, inner, max_events: int) -> None:
        self._inner = inner
        self._max = max_events
        self.market = inner.market
        self.symbol = inner.symbol
        self.capability = inner.capability

    async def events(self):
        n = 0
        async for ev in self._inner.events():
            yield ev
            n += 1
            if n >= self._max:
                return


def _mk_grid(rows: int = 256, ring_columns: int = 1024, p0: float | None = None) -> Grid:
    tick = 0.5
    if p0 is None:
        p0 = 100.0 - rows * tick / 2  # sim mid ~100 centered
    return Grid(
        GridCfg(
            tick=tick,
            tick_multiple=1,
            dt_ns=DT,
            p0=p0,
            rows=rows,
            ring_columns=ring_columns,
            mode=MODE_L2,
        )
    )


async def _predrive_grid(grid: Grid, seed: int, n_cols: int) -> None:
    """Drive ``grid`` from SimFeed events until ``n_cols`` columns finalized."""
    feed = SimFeed(seed=seed, dt_ns=DT, start_ns=0)
    done = 0
    async for ev in feed.events():
        if isinstance(ev, BookState):
            done += len(grid.on_book(ev.ts_ns, ev.bid_px, ev.bid_sz, ev.ask_px, ev.ask_sz))
        elif isinstance(ev, Trade):
            grid.on_trade(ev.ts_ns, ev.price, ev.size, ev.side)
        if done >= n_cols:
            return


def _decode_frame(buf: bytes) -> list:
    out = []
    off = 0
    while off < len(buf):
        ev, off = wire.decode(buf, off)
        out.append(ev)
    return out


def _drain_all(client: ClientTx) -> list:
    msgs = []
    while True:
        frames = client.drain(1 << 30)
        if not frames:
            return msgs
        for f in frames:
            msgs.extend(_decode_frame(f))


_BOOK = (
    np.array([100.0]),
    np.array([2.0]),
    np.array([100.5]),
    np.array([3.0]),
)


def _drive_synthetic(grid: Grid, n_cols: int, start_idx: int = 0) -> list:
    """Finalize ``n_cols`` columns with a fixed one-level book."""
    cols = []
    for i in range(start_idx, start_idx + n_cols + 1):
        cols.extend(grid.on_book(i * DT, *_BOOK))
    return cols[:n_cols]


# ---------------------------------------------------------------------------
# 1. Snapshot shape


async def test_snapshot_shape_over_sim_history():
    grid = _mk_grid(rows=256, ring_columns=1024)
    await _predrive_grid(grid, seed=1, n_cols=700)

    feed = SimFeed(seed=1, dt_ns=DT, start_ns=0)  # capability donor; never started
    sess = Session("snap-test", feed=feed, grid=grid)
    client = ClientTx()
    frames = sess.attach(client)

    # First frame's first message is Hello.
    first = _decode_frame(frames[0])
    hello = first[0]
    assert isinstance(hello, Hello)
    assert hello.protocol_version == 1
    assert hello.session_id == "snap-test"
    assert hello.grid_epoch == 0
    assert hello.epoch_params.rows == 256
    assert hello.epoch_params.dt_ns == DT
    assert hello.capability == feed.capability
    assert hello.norm_seed > 0.0  # non-empty history -> percentile hint

    # EpochStart precedes any DepthColumn (flattened across frames, in order).
    flat = [m for f in frames for m in _decode_frame(f)]
    kinds = [type(m) for m in flat]
    assert EpochStart in kinds and DepthColumn in kinds
    assert kinds.index(EpochStart) < kinds.index(DepthColumn)

    # 512 depth columns total (700 available), <=64 per chunk frame.
    depth_total = 0
    for f in frames:
        msgs = _decode_frame(f)  # decodes cleanly end-to-end (raises otherwise)
        n_depth = sum(isinstance(m, DepthColumn) for m in msgs)
        assert n_depth <= 64
        depth_total += n_depth
    assert depth_total == 512
    assert len(frames) == 1 + 8  # hello frame + 8 chunk frames (no tape/markers/bbo)

    # Columns are final, consecutive, and each is paired with its BarColumn.
    depths = [m for m in flat if isinstance(m, DepthColumn)]
    bars = [m for m in flat if isinstance(m, BarColumn)]
    assert all(d.final for d in depths)
    seqs = [d.col_seq for d in depths]
    assert all(b - a == 1 for a, b in zip(seqs, seqs[1:]))
    assert [b.col_seq for b in bars] == seqs


async def test_snapshot_empty_grid_norm_seed_is_one():
    sess = Session("empty", feed=IdleFeed(), grid=_mk_grid(rows=64, ring_columns=128))
    frames = sess.attach(ClientTx())
    hello = _decode_frame(frames[0])[0]
    assert isinstance(hello, Hello)
    assert hello.norm_seed == 1.0


# ---------------------------------------------------------------------------
# 2. Refcount / grace teardown


async def test_refcount_grace_teardown_and_fresh_session():
    cfg = Config(max_sessions=4, ring_columns=256, max_rows=64, dt_crypto_ns=DT)
    timer = FakeTimer()
    mgr = SessionManager(cfg, timer=timer, feed_factory=lambda sub: IdleFeed())
    sub = Subscribe(market="sim", symbol="IDLE", mode="live", source=None, start_t=None)
    c1, c2 = ClientTx(), ClientTx()

    sess = await mgr.subscribe(sub, c1)
    assert await mgr.subscribe(sub, c2) is sess  # same key -> same session

    await mgr.unsubscribe(sess, c1)
    assert not timer.entries  # one ref left: no grace scheduled
    await mgr.unsubscribe(sess, c2)
    assert len(timer.entries) == 1 and timer.entries[0].delay_s == 60.0

    # Alive during grace: run task still pending, still registered.
    assert sess.run_task is not None and not sess.run_task.done()
    assert sess in mgr._sessions.values()

    # Re-attach during grace cancels the pending teardown.
    assert await mgr.subscribe(sub, c1) is sess
    assert timer.entries[0].cancelled
    await mgr.unsubscribe(sess, c1)
    assert len(timer.entries) == 2

    # Grace fires -> feed task cancelled, session deregistered.
    timer.entries[1].fire()
    await asyncio.gather(sess.run_task, return_exceptions=True)
    assert sess.run_task.cancelled()
    assert sess not in mgr._sessions.values()

    # Re-subscribe after teardown creates a FRESH session.
    fresh = await mgr.subscribe(sub, c1)
    assert fresh is not sess
    assert fresh.session_id != sess.session_id
    fresh.run_task.cancel()
    await asyncio.gather(fresh.run_task, return_exceptions=True)


def test_detach_is_idempotent_refcount_is_membership():
    timer = FakeTimer()
    sess = Session(
        "idem", feed=IdleFeed(), grid=_mk_grid(rows=64, ring_columns=128), timer=timer
    )
    a, b = ClientTx(), ClientTx()
    sess.attach(a)
    sess.attach(b)
    sess.detach(a)
    sess.detach(a)  # double detach of the same client: must be a no-op
    assert not timer.entries  # B still attached -> no grace scheduled
    assert not sess._closed and b in sess._clients
    sess.detach(b)
    assert len(timer.entries) == 1  # grace only after the LAST client leaves


# ---------------------------------------------------------------------------
# 3. Backpressure: column lag-drop + gap markers + recoverability


def test_backpressure_lag_drop_gap_markers_recoverable():
    grid = _mk_grid(rows=64, ring_columns=8192, p0=84.0)
    cols = _drive_synthetic(grid, 5000)
    assert len(cols) == 5000
    frames = {c.col_seq: wire.encode(grid.to_depth(c)) for c in cols}

    clock = FakeClock()
    client = ClientTx(clock=clock)

    def offer_range(lo: int, hi: int) -> None:
        for c in cols[lo:hi]:
            clock.advance(DT)  # 250 ms of "transmission lag" per column
            client.offer(frames[c.col_seq], col_msg=True, t0_ns=c.t0_ns)
            assert len(client) <= 16  # queue stays bounded throughout

    # Phase A: two drop runs separated by a full drain.
    offer_range(0, 3000)
    msgs_a = _drain_all(client)
    offer_range(3000, 5000)
    msgs_b = _drain_all(client)

    def split(msgs):
        gaps = [m for m in msgs if isinstance(m, Marker) and m.kind == "gap"]
        kept = {m.col_seq for m in msgs if isinstance(m, DepthColumn)}
        return gaps, kept

    gaps_a, kept_a = split(msgs_a)
    gaps_b, kept_b = split(msgs_b)

    # ONE gap Marker per contiguous drop run.
    assert len(gaps_a) == 1 and len(gaps_b) == 1
    assert gaps_a[0].ts_ns == cols[0].t0_ns  # first dropped column of run A
    assert gaps_b[0].ts_ns == cols[3000].t0_ns  # first dropped column of run B

    dropped = (set(range(0, 3000)) - kept_a) | (set(range(3000, 5000)) - kept_b)
    assert dropped  # lag really dropped columns
    # Dropped set is contiguous-prefix per phase (oldest-first drops).
    assert kept_a == set(range(max(dropped & set(range(3000))) + 1, 3000))

    # Every dropped column remains recoverable from the grid ring.
    sample = sorted(dropped)[:: max(1, len(dropped) // 7)][:7]
    for seq in sample:
        got = grid.history(seq * DT + 1, 1)
        assert len(got) == 1 and got[0].col_seq == seq


# ---------------------------------------------------------------------------
# 3b. Gap accounting is per COLUMN; partials coalesce and never count


def test_gap_marker_counts_columns_not_frames():
    """10 dropped columns offered as depth+bar pairs (plus stacked partial
    re-emissions) must yield ONE gap Marker counting 10 columns, not 20+
    frames — and the stale partials of the surviving column never count."""
    clock = FakeClock()
    client = ClientTx(clock=clock)
    n = 10
    for i in range(n):
        t0 = i * DT
        client.offer(b"d%d" % i, col_msg=True, t0_ns=t0)
        client.offer(b"b%d" % i, col_msg=True, t0_ns=t0)
        # 20 Hz re-emissions of the NEXT in-progress column stack frames on
        # one t0; they coalesce latest-wins to a single depth+bar pair.
        nxt = (i + 1) * DT
        for _ in range(3):
            client.offer(b"pd", col_msg=True, t0_ns=nxt, is_partial=True)
            client.offer(b"pb", col_msg=True, t0_ns=nxt, is_partial=True)

    clock.advance(LAG_DROP_NS + 1)  # everything queued is now lagged out
    client.offer(b"dF", col_msg=True, t0_ns=n * DT)  # final of column n arrives
    client.offer(b"bF", col_msg=True, t0_ns=n * DT)

    frames = client.drain(1 << 30)
    assert frames[1:] == [b"dF", b"bF"]  # final pair delivered after the gap
    (gap,) = _decode_frame(frames[0])
    assert isinstance(gap, Marker) and gap.kind == "gap"
    assert gap.ts_ns == 0  # first REAL dropped column
    # 10 columns: depth+bar pairs counted once each; the dropped stale
    # partials of column n (whose final was just delivered) count zero.
    assert "dropped 10 columns" in gap.text


def test_partial_reemissions_coalesce_latest_wins():
    client = ClientTx(clock=FakeClock())
    client.offer(b"final", col_msg=True, t0_ns=0)
    for k in range(5):
        client.offer(b"pd%d" % k, col_msg=True, t0_ns=DT, is_partial=True)
        client.offer(b"pb%d" % k, col_msg=True, t0_ns=DT, is_partial=True)
    assert len(client) == 3  # final + ONE coalesced partial pair
    assert client.drain(1 << 30) == [b"final", b"pd4", b"pb4"]


def test_dropped_stale_partial_yields_no_gap_marker():
    """A lag-dropped partial whose final is later delivered is superseded
    data, not a lost column: the client must see NO gap Marker."""
    clock = FakeClock()
    client = ClientTx(clock=clock)
    client.offer(b"partial", col_msg=True, t0_ns=0, is_partial=True)
    clock.advance(LAG_DROP_NS + 1)
    client.offer(b"final-d", col_msg=True, t0_ns=0)
    client.offer(b"final-b", col_msg=True, t0_ns=0)
    assert client.drain(1 << 30) == [b"final-d", b"final-b"]


# ---------------------------------------------------------------------------
# 3c. drain() byte budget


def test_drain_byte_budget_fifo_and_anti_wedge():
    client = ClientTx(clock=FakeClock())
    frames = [bytes([65 + i]) * 100 for i in range(4)]  # four 100-byte frames
    for i, f in enumerate(frames):
        client.offer(f, col_msg=True, t0_ns=i * DT)

    assert client.drain(250) == frames[:2]  # 2.5-frame budget -> exactly 2, FIFO
    assert client.drain(50) == [frames[2]]  # budget < one frame -> 1 (anti-wedge)
    assert client.drain(1 << 30) == [frames[3]]
    assert client.drain(1 << 30) == []


# ---------------------------------------------------------------------------
# 4. Non-column cap


def test_noncolumn_cap_keeps_newest_1000():
    client = ClientTx(clock=FakeClock())
    for i in range(2000):
        frame = wire.encode(BBO(ts_ns=i, bid_px=1.0, bid_sz=1.0, ask_px=2.0, ask_sz=1.0))
        client.offer(frame, col_msg=False, t0_ns=None)
    msgs = _drain_all(client)
    bbos = [m for m in msgs if isinstance(m, BBO)]
    assert len(bbos) == 1000  # cap
    assert bbos[0].ts_ns == 1000 and bbos[-1].ts_ns == 1999  # newest kept, FIFO order


def test_column_offer_requires_t0():
    client = ClientTx(clock=FakeClock())
    with pytest.raises(ValueError):
        client.offer(b"x", col_msg=True, t0_ns=None)


# ---------------------------------------------------------------------------
# 5. max_sessions


async def test_max_sessions_limit_and_existing_key_reuse():
    cfg = Config(max_sessions=2, ring_columns=256, max_rows=64, dt_crypto_ns=DT)
    mgr = SessionManager(cfg, timer=FakeTimer(), feed_factory=lambda sub: IdleFeed())
    c = ClientTx()

    def sub(sym: str) -> Subscribe:
        return Subscribe(market="sim", symbol=sym, mode="live", source=None, start_t=None)

    s_a = await mgr.subscribe(sub("A"), c)
    s_b = await mgr.subscribe(sub("B"), c)
    with pytest.raises(SessionLimitError):
        await mgr.subscribe(sub("C"), ClientTx())
    # Re-subscribing an existing key does not count as a new session.
    assert await mgr.subscribe(sub("A"), ClientTx()) is s_a

    for s in (s_a, s_b):
        s.run_task.cancel()
    await asyncio.gather(s_a.run_task, s_b.run_task, return_exceptions=True)


async def test_unknown_market_raises_not_implemented():
    cfg = Config(max_sessions=4, ring_columns=256, max_rows=64, dt_crypto_ns=DT)
    mgr = SessionManager(cfg, timer=FakeTimer())
    bad = Subscribe(market="crypto", symbol="BTCUSDT", mode="live", source=None, start_t=None)
    with pytest.raises(NotImplementedError):
        await mgr.subscribe(bad, ClientTx())


# ---------------------------------------------------------------------------
# 6. Dedup by col_seq


def test_broadcast_dedups_boundary_reemitted_columns():
    grid = _mk_grid(rows=64, ring_columns=128, p0=84.0)
    (col,) = _drive_synthetic(grid, 1)
    sess = Session("dedup", feed=IdleFeed(), grid=grid)
    client = ClientTx()
    sess.attach(client)

    sess._emit_finalized([col, col])  # boundary re-emission within one batch
    sess._emit_finalized([col])  # ... and across batches
    msgs = _drain_all(client)

    finals = [m for m in msgs if isinstance(m, DepthColumn) and m.final]
    assert len(finals) == 1 and finals[0].col_seq == col.col_seq
    assert sum(isinstance(m, BarColumn) and m.col_seq == col.col_seq for m in msgs) >= 1


# ---------------------------------------------------------------------------
# 7. Live loop e2e


async def test_live_loop_end_to_end_sim():
    cfg = Config(max_sessions=4, ring_columns=2048, max_rows=128, dt_crypto_ns=DT)
    mgr = SessionManager(
        cfg,
        feed_factory=lambda sub: CappedFeed(SimFeed(seed=42, dt_ns=DT, start_ns=0), 1500),
    )
    client = ClientTx()
    sub = Subscribe(market="sim", symbol="SIM-DEMO", mode="live", source=None, start_t=None)
    sess = await mgr.subscribe(sub, client)
    await asyncio.wait_for(sess.run_task, timeout=5)

    msgs = _drain_all(client)
    assert isinstance(msgs[0], Hello)
    assert msgs[0].norm_seed == 1.0  # grid empty at subscribe time
    kinds = [type(m) for m in msgs]
    assert kinds.index(EpochStart) < len(kinds)

    first_depth = next(i for i, m in enumerate(msgs) if isinstance(m, DepthColumn))
    assert kinds.index(EpochStart) < first_depth  # EpochStart precedes columns

    finals = [m for m in msgs if isinstance(m, DepthColumn) and m.final]
    partials = [m for m in msgs if isinstance(m, DepthColumn) and not m.final]
    assert len(finals) >= 1
    assert len(partials) >= 1
    fseqs = [m.col_seq for m in finals]
    assert all(b > a for a, b in zip(fseqs, fseqs[1:]))  # strictly increasing

    # Bars: cumulative vwap denominator is non-decreasing in stream order.
    # (The plan says "non-decreasing cvd", but cvd_cum is signed and
    # non-monotone by design — grid docstring; vwap_den_cum is the monotone
    # cumulative bar field.)
    bars = [m for m in msgs if isinstance(m, BarColumn)]
    assert bars
    dens = [b.vwap_den_cum for b in bars]
    assert all(b >= a for a, b in zip(dens, dens[1:]))
    assert any(isinstance(m, Trade) for m in msgs)


# ---------------------------------------------------------------------------
# 8. handle_history


def test_handle_history_serves_cols_before_t():
    grid = _mk_grid(rows=64, ring_columns=1024, p0=84.0)
    _drive_synthetic(grid, 300)
    sess = Session("hist", feed=IdleFeed(), grid=grid)

    before = 150 * DT  # exclusive: col 150's own t0
    frame = sess.handle_history(HistoryRequest(req_id=9, before_t=before, n_cols=64))
    msgs = _decode_frame(frame)
    # ONE frame: EpochStart announcements batched ahead of the response.
    assert all(isinstance(m, EpochStart) for m in msgs[:-1])
    resp = msgs[-1]
    assert isinstance(resp, HistoryResponse)
    assert resp.req_id == 9
    assert resp.epoch == 0
    assert resp.oldest_available_t_ns == grid.oldest_retained_t0_ns()
    assert 0 < len(resp.depth_cols) <= 64
    assert all(d.t0_ns < before for d in resp.depth_cols)
    assert resp.depth_cols[-1].t0_ns == before - DT  # ends strictly before before_t
    assert [b.col_seq for b in resp.bar_cols] == [d.col_seq for d in resp.depth_cols]
    assert resp.big_trades == []

    # n_cols is clamped to 256.
    resp2 = _decode_frame(sess.handle_history(
        HistoryRequest(req_id=10, before_t=2**62, n_cols=500)))[-1]
    assert len(resp2.depth_cols) == 256


# ---------------------------------------------------------------------------
# multi-epoch snapshot / history announcements


def _reanchored_grid() -> Grid:
    """20 epoch-0 columns, a re-anchor, then ~21 epoch-1 columns."""
    grid = _mk_grid(rows=64, ring_columns=1024, p0=84.0)
    _drive_synthetic(grid, 20)
    params = grid.maybe_reanchor(115.0)  # outside central band [88.8, 111.2]
    assert params is not None and params.epoch == 1
    _drive_synthetic(grid, 20, start_idx=21)
    return grid


def test_snapshot_announces_all_epochs_present():
    grid = _reanchored_grid()
    sess = Session("epochs", feed=IdleFeed(), grid=grid)
    frames = sess.attach(ClientTx())
    flat = [m for f in frames for m in _decode_frame(f)]

    hello = flat[0]
    assert isinstance(hello, Hello) and hello.grid_epoch == 1

    starts = [m for m in flat if isinstance(m, EpochStart)]
    assert [s.epoch for s in starts] == [0, 1]  # every epoch, ascending
    for s in starts:
        assert s.epoch_params == grid.epoch_params_for(s.epoch)

    # Client-side reconstruction possible: each EpochStart precedes the
    # first column of its epoch, and both epochs really appear as columns.
    col_epochs = {m.epoch for m in flat if isinstance(m, DepthColumn)}
    assert col_epochs == {0, 1}
    for e in (0, 1):
        i_start = next(
            i for i, m in enumerate(flat) if isinstance(m, EpochStart) and m.epoch == e
        )
        i_col = next(
            i for i, m in enumerate(flat) if isinstance(m, DepthColumn) and m.epoch == e
        )
        assert i_start < i_col


def test_handle_history_announces_epochs_in_range():
    grid = _reanchored_grid()
    sess = Session("hist-epochs", feed=IdleFeed(), grid=grid)
    frame = sess.handle_history(HistoryRequest(req_id=1, before_t=2**62, n_cols=256))
    msgs = _decode_frame(frame)
    assert [type(m) for m in msgs] == [EpochStart, EpochStart, HistoryResponse]
    assert msgs[0].epoch == 0 and msgs[1].epoch == 1
    assert msgs[0].epoch_params == grid.epoch_params_for(0)
    assert msgs[1].epoch_params == grid.epoch_params_for(1)
    assert {d.epoch for d in msgs[2].depth_cols} == {0, 1}


# ---------------------------------------------------------------------------
# protected snapshot frames


async def test_snapshot_frames_survive_noncolumn_cap_flood():
    cfg = Config(max_sessions=4, ring_columns=256, max_rows=64, dt_crypto_ns=DT)
    mgr = SessionManager(cfg, timer=FakeTimer(), feed_factory=lambda sub: IdleFeed())
    client = ClientTx(clock=FakeClock())
    sub = Subscribe(market="sim", symbol="IDLE", mode="live", source=None, start_t=None)
    sess = await mgr.subscribe(sub, client)

    for i in range(1001):  # one over the cap: eviction must hit BBOs, not Hello
        frame = wire.encode(BBO(ts_ns=i, bid_px=1.0, bid_sz=1.0, ask_px=2.0, ask_sz=1.0))
        client.offer(frame, col_msg=False, t0_ns=None)

    msgs = _drain_all(client)
    assert isinstance(msgs[0], Hello)  # snapshot frame still first out of drain
    bbos = [m for m in msgs if isinstance(m, BBO)]
    assert len(bbos) == 1000 and bbos[0].ts_ns == 1  # oldest unprotected evicted

    sess.run_task.cancel()
    await asyncio.gather(sess.run_task, return_exceptions=True)


# ---------------------------------------------------------------------------
# feed crash -> degraded -> recovery, and backoff reset guard


class FlakyFeed:
    """Crashes after one event, then delivers a stable run (>=100 events)."""

    market = "sim"
    symbol = "FLAKY"
    capability: dict[str, object] = {"depth": "L2"}

    def __init__(self) -> None:
        self.calls = 0

    async def events(self):
        self.calls += 1
        if self.calls == 1:
            yield BookState(0, *_BOOK)
            raise RuntimeError("boom")
        for i in range(1, 102):
            yield BookState(i * DT, *_BOOK)


class FlapperFeed:
    """Yields exactly one event then crashes, every restart, forever."""

    market = "sim"
    symbol = "FLAP"
    capability: dict[str, object] = {"depth": "L2"}

    def __init__(self) -> None:
        self.calls = 0

    async def events(self):
        self.calls += 1
        yield BookState(self.calls * DT, *_BOOK)
        raise RuntimeError("flap")


async def test_feed_crash_degraded_then_recovered_status():
    grid = _mk_grid(rows=64, ring_columns=256, p0=84.0)
    sess = Session("flaky", feed=FlakyFeed(), grid=grid, restart_backoff_base_s=0.001)
    client = ClientTx()
    sess.attach(client)
    await sess.start()
    await asyncio.wait_for(sess.run_task, timeout=5)

    statuses = [m for m in _drain_all(client) if isinstance(m, Status)]
    assert [s.feed_state for s in statuses] == ["degraded", "live"]
    # The restarted feed ran >=100 events: backoff reset to base.
    assert sess._backoff_s == 0.001


async def test_flapping_feed_keeps_escalating_backoff():
    grid = _mk_grid(rows=64, ring_columns=128, p0=84.0)
    feed = FlapperFeed()
    sess = Session("flap", feed=feed, grid=grid, restart_backoff_base_s=0.005)
    sess.attach(ClientTx())
    await sess.start()
    while feed.calls < 5:
        await asyncio.sleep(0.005)
    sess.run_task.cancel()
    await asyncio.gather(sess.run_task, return_exceptions=True)

    # Every restart yielded an event, but never reached stability (>=5 s or
    # >=100 events) — backoff must keep escalating, never reset to base.
    assert sess._backoff_s >= 0.005 * 2**4


async def test_feed_crash_is_logged_and_restarts(caplog):
    feed = FlakyFeed()
    sess = Session(
        "log",
        feed=feed,
        grid=_mk_grid(rows=64, ring_columns=256, p0=84.0),
        restart_backoff_base_s=0.001,
    )
    sess.attach(ClientTx())
    with caplog.at_level(logging.ERROR, logger="flowmap_server.core.session"):
        await sess.start()
        await asyncio.wait_for(sess.run_task, timeout=5)
    recs = [r for r in caplog.records if "feed crashed" in r.getMessage()]
    assert recs and recs[0].exc_info is not None  # full traceback attached
    assert feed.calls == 2  # crashed once, restarted, ran to completion


async def test_degraded_broadcast_failure_still_restarts(monkeypatch, caplog):
    feed = FlakyFeed()
    sess = Session(
        "robust",
        feed=feed,
        grid=_mk_grid(rows=64, ring_columns=256, p0=84.0),
        restart_backoff_base_s=0.001,
    )
    sess.attach(ClientTx())

    def boom(state: str) -> None:
        raise RuntimeError("encode exploded")

    monkeypatch.setattr(sess, "_set_feed_state", boom)
    with caplog.at_level(logging.ERROR, logger="flowmap_server.core.session"):
        await sess.start()
        await asyncio.wait_for(sess.run_task, timeout=5)
    assert feed.calls == 2  # the failed Status broadcast did not kill the restart
    assert any("degraded Status" in r.getMessage() for r in caplog.records)


# ---------------------------------------------------------------------------
# zombie session: feed ended normally -> new subscriber restarts it


class EndingFeed:
    """Ends normally after one book event; counts ``events()`` calls."""

    market = "sim"
    symbol = "END"
    capability: dict[str, object] = {"depth": "L2"}

    def __init__(self) -> None:
        self.calls = 0

    async def events(self):
        self.calls += 1
        yield BookState(self.calls * DT, *_BOOK)


async def test_ended_feed_session_restarts_on_new_subscriber():
    cfg = Config(max_sessions=4, ring_columns=256, max_rows=64, dt_crypto_ns=DT)
    feed = EndingFeed()
    mgr = SessionManager(cfg, timer=FakeTimer(), feed_factory=lambda sub: feed)
    sub = Subscribe(market="sim", symbol="END", mode="live", source=None, start_t=None)

    sess = await mgr.subscribe(sub, ClientTx())
    await asyncio.wait_for(sess.run_task, timeout=5)  # feed ends normally
    assert feed.calls == 1 and sess.run_task.done()

    # A new subscriber to the existing key must NOT get a zombie session:
    # subscribe() restarts the run task (start() is idempotent).
    assert await mgr.subscribe(sub, ClientTx()) is sess
    assert not sess.run_task.done()
    await asyncio.wait_for(sess.run_task, timeout=5)
    assert feed.calls == 2


# ---------------------------------------------------------------------------
# unknown FeedEvent type: warn, never raise (forward-compat)


class AlienEventFeed:
    market = "sim"
    symbol = "ALIEN"
    capability: dict[str, object] = {"depth": "L2"}

    async def events(self):
        yield "not-a-feed-event"
        yield BookState(DT, *_BOOK)


async def test_unknown_feed_event_warns_and_continues(caplog):
    sess = Session(
        "alien", feed=AlienEventFeed(), grid=_mk_grid(rows=64, ring_columns=128, p0=84.0)
    )
    sess.attach(ClientTx())
    with caplog.at_level(logging.WARNING, logger="flowmap_server.core.session"):
        await sess.start()
        await asyncio.wait_for(sess.run_task, timeout=5)  # no crash: ends normally
    assert any(
        "unknown feed event type str" in r.getMessage() for r in caplog.records
    )
