"""SimFeed tests (M1 plan Task 6).

The first six tests are the frozen contract from the plan: determinism,
wall persistence through a Grid, generate_history speed/shape, trade
semantics + stream hygiene, liquidation marker, and no-sleep consumption.
"""

import asyncio
import time

import numpy as np

from flowmap_server.core.grid import FinalizedColumn, Grid, GridCfg
from flowmap_server.feeds.base import BookState, Feed, FeedEvent
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto.events import SIDE_BUY, SIDE_SELL, Marker, Trade

DT_NS = 250_000_000

# ---------------------------------------------------------------------------
# helpers


async def _collect(feed: SimFeed, n: int) -> list[FeedEvent]:
    out: list[FeedEvent] = []
    async for ev in feed.events():
        out.append(ev)
        if len(out) >= n:
            break
    return out


def _events_equal(a: FeedEvent, b: FeedEvent) -> bool:
    if type(a) is not type(b):
        return False
    if isinstance(a, BookState):
        assert isinstance(b, BookState)
        return a.ts_ns == b.ts_ns and all(
            np.array_equal(getattr(a, f), getattr(b, f))
            for f in ("bid_px", "bid_sz", "ask_px", "ask_sz")
        )
    return a == b  # Trade / Marker: msgspec field equality (scalars only)


async def _drive_through_grid(seed: int, n_cols: int, rows: int = 512) -> list[FinalizedColumn]:
    tick = 0.5
    p0 = 100.0 - rows * tick / 2  # mid ~100 centered in the span
    g = Grid(
        GridCfg(
            tick=tick,
            tick_multiple=1,
            dt_ns=DT_NS,
            p0=p0,
            rows=rows,
            ring_columns=max(n_cols, 128),
            mode=0,
        )
    )
    cols: list[FinalizedColumn] = []
    feed = SimFeed(seed=seed, dt_ns=DT_NS, start_ns=0)
    async for ev in feed.events():
        if isinstance(ev, BookState):
            cols.extend(g.on_book(ev.ts_ns, ev.bid_px, ev.bid_sz, ev.ask_px, ev.ask_sz))
        elif isinstance(ev, Trade):
            g.on_trade(ev.ts_ns, ev.price, ev.size, ev.side)
        if len(cols) >= n_cols:
            break
    return cols[:n_cols]


def _max_true_run(mask: np.ndarray) -> int:
    best = cur = 0
    for v in mask:
        cur = cur + 1 if v else 0
        best = max(best, cur)
    return best


# ---------------------------------------------------------------------------
# 1. determinism


async def test_same_seed_identical_first_100_events():
    a = await _collect(SimFeed(seed=42, dt_ns=DT_NS, start_ns=0), 100)
    b = await _collect(SimFeed(seed=42, dt_ns=DT_NS, start_ns=0), 100)
    assert len(a) == len(b) == 100
    for i, (x, y) in enumerate(zip(a, b, strict=True)):
        assert _events_equal(x, y), f"event {i} differs between identical seeds"


async def test_different_seed_differs_within_100_events():
    a = await _collect(SimFeed(seed=42, dt_ns=DT_NS, start_ns=0), 100)
    c = await _collect(SimFeed(seed=43, dt_ns=DT_NS, start_ns=0), 100)
    assert any(not _events_equal(x, y) for x, y in zip(a, c, strict=True))


# ---------------------------------------------------------------------------
# 2. wall persistence through a Grid


async def test_liquidity_walls_persist_across_columns():
    n_cols = 100
    cols = await _drive_through_grid(seed=42, n_cols=n_cols)
    assert len(cols) == n_cols
    bids = np.stack([c.bid.astype(np.float64) for c in cols])  # [n, rows]
    asks = np.stack([c.ask.astype(np.float64) for c in cols])
    density = np.concatenate([bids, asks], axis=1)  # [n, 2*rows]
    med = np.array([np.median(col[col > 0]) for col in density])
    assert np.all(med > 0)
    hot = density >= 5.0 * med[:, None]
    runs = [_max_true_run(hot[:, r]) for r in range(hot.shape[1])]
    assert max(runs) >= 50, f"no wall row persisted >=50 consecutive columns (max run {max(runs)})"


# ---------------------------------------------------------------------------
# 3. generate_history: shape + speed


def test_generate_history_10k_columns_fast():
    t0 = time.perf_counter()
    cols = SimFeed.generate_history(seed=1, n_cols=10_000)
    elapsed = time.perf_counter() - t0
    assert len(cols) == 10_000
    assert elapsed < 2.0, f"generate_history took {elapsed:.2f}s (budget 2s)"
    seqs = [c.col_seq for c in cols]
    assert seqs == list(range(seqs[0], seqs[0] + 10_000)), "col_seq not contiguous"
    t0s = np.array([c.t0_ns for c in cols], dtype=np.int64)
    assert np.all(np.diff(t0s) == DT_NS), "t0 spacing != dt_ns"
    assert all(isinstance(c, FinalizedColumn) for c in cols[:5])
    # spot-check finiteness of the densities (full scan on a sample)
    for c in cols[::500]:
        assert np.isfinite(c.bid.astype(np.float64)).all()
        assert np.isfinite(c.ask.astype(np.float64)).all()


def test_generate_history_deterministic():
    a = SimFeed.generate_history(seed=7, n_cols=50)
    b = SimFeed.generate_history(seed=7, n_cols=50)
    for x, y in zip(a, b, strict=True):
        assert x.col_seq == y.col_seq and x.t0_ns == y.t0_ns and x.epoch == y.epoch
        assert np.array_equal(x.bid, y.bid) and np.array_equal(x.ask, y.ask)
        assert x.bar == y.bar


# ---------------------------------------------------------------------------
# 4. trade semantics + stream hygiene


async def test_trades_sides_prices_ts_and_finiteness():
    events = await _collect(SimFeed(seed=42, dt_ns=DT_NS, start_ns=0), 1_000)
    sides: set[int] = set()
    last_ts = -1
    book: BookState | None = None
    n_trades = 0
    for ev in events:
        assert ev.ts_ns >= last_ts, "ts_ns went backwards"
        last_ts = ev.ts_ns
        if isinstance(ev, BookState):
            for f in ("bid_px", "bid_sz", "ask_px", "ask_sz"):
                arr = getattr(ev, f)
                assert np.isfinite(arr).all(), f"non-finite values in {f}"
            assert (ev.bid_sz >= 0).all() and (ev.ask_sz >= 0).all()
            book = ev
        elif isinstance(ev, Trade):
            n_trades += 1
            sides.add(ev.side)
            assert np.isfinite(ev.price) and np.isfinite(ev.size) and ev.size > 0
            assert book is not None, "trade before any book state"
            assert book.bid_px.min() <= ev.price <= book.ask_px.max()
        elif isinstance(ev, Marker):
            assert ev.price is not None and np.isfinite(ev.price)
            assert ev.size is not None and np.isfinite(ev.size)
    assert n_trades > 0
    assert SIDE_BUY in sides and SIDE_SELL in sides, "both trade sides must appear"


async def test_buy_hits_ask_sell_hits_bid():
    events = await _collect(SimFeed(seed=42, dt_ns=DT_NS, start_ns=0), 1_000)
    book: BookState | None = None
    checked = 0
    for ev in events:
        if isinstance(ev, BookState):
            book = ev
        elif isinstance(ev, Trade) and book is not None:
            best_bid = book.bid_px.max()
            best_ask = book.ask_px.min()
            if ev.side == SIDE_BUY:
                assert ev.price >= best_bid, "buy should trade at/above best bid (hits ask)"
            elif ev.side == SIDE_SELL:
                assert ev.price <= best_ask, "sell should trade at/below best ask (hits bid)"
            checked += 1
    assert checked > 10


# ---------------------------------------------------------------------------
# 5. liquidation marker


async def test_liquidation_marker_within_2000_intervals():
    feed = SimFeed(seed=42, dt_ns=DT_NS, start_ns=0)
    horizon_ns = 2_000 * DT_NS
    found: Marker | None = None
    async for ev in feed.events():
        if ev.ts_ns >= horizon_ns:
            break
        if isinstance(ev, Marker):
            found = ev
            break
    assert found is not None, "no liquidation marker within 2000 intervals"
    assert found.kind == "liquidation"


# ---------------------------------------------------------------------------
# 6. no sleeping unless realtime=True


async def test_no_sleep_when_not_realtime(monkeypatch):
    calls = {"n": 0}
    real_sleep = asyncio.sleep

    async def counting_sleep(delay, *args, **kwargs):
        calls["n"] += 1
        return await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", counting_sleep)

    await _collect(SimFeed(seed=3, dt_ns=DT_NS, start_ns=0), 100)
    assert calls["n"] == 0, "realtime=False must never sleep"

    await _collect(SimFeed(seed=3, dt_ns=DT_NS, start_ns=0, realtime=True), 40)
    assert calls["n"] > 0, "realtime=True should pace with asyncio.sleep"


# ---------------------------------------------------------------------------
# protocol conformance


def test_simfeed_satisfies_feed_protocol():
    feed = SimFeed(seed=0)
    assert isinstance(feed, Feed)
    assert feed.market == "sim"
    assert feed.symbol == "SIM-DEMO"
    assert isinstance(feed.capability, dict)
