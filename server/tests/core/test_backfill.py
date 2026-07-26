"""First-launch history backfill tests (GOAL 1) — canned candles, NO network.

Covers the two layers:

1. ``columns_from_candles`` — the pure candle -> FinalizedColumn conversion:
   contiguity/monotonicity that ``Grid.preload`` requires, an epoch frame
   centered so densities land (and live continues in-epoch), the two-sided
   volume-at-price split, a reconstructed CVD from the crypto taker split,
   float16-bounded density, and a real ``Grid.preload`` round-trip.
2. ``Session`` wiring — a cold subscribe seeds the ring through the injectable
   ``backfill_fn`` seam, the first snapshot carries the reconstructed columns +
   a gap marker, and Hello badges ``history: 'reconstructed'``; a missing seam
   or a failing fetch degrades cleanly to a cold start.
"""

from __future__ import annotations

import asyncio

import numpy as np

from flowmap_server.config import Config
from flowmap_server.core.backfill import PEAK_TARGET, Candle, columns_from_candles
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.session import ClientTx, Session, SessionManager
from flowmap_server.proto import wire
from flowmap_server.proto.events import (
    MODE_L2,
    DepthColumn,
    Hello,
    Marker,
    Subscribe,
)

DT = 250_000_000  # 250 ms
_MINUTE = 60 * 10**9


def _cfg(rows: int = 256, ring_columns: int = 1024) -> GridCfg:
    return GridCfg(
        tick=0.5,
        tick_multiple=1,
        dt_ns=DT,
        p0=100.0 - rows * 0.5 / 2.0,
        rows=rows,
        ring_columns=ring_columns,
        mode=MODE_L2,
    )


def _candles(n: int, *, base_price: float = 100.0, with_split: bool = True) -> list[Candle]:
    base_ts = 1_700_000_000 * 10**9  # some real-ish wall ns, minute-aligned enough
    out: list[Candle] = []
    for i in range(n):
        c = base_price + (i % 5) * 0.5  # walk within the grid span
        lo, hi = c - 1.0, c + 1.0
        out.append(
            Candle(
                t0_ns=base_ts + i * _MINUTE,
                o=c,
                h=hi,
                l=lo,
                c=c,
                volume=100.0 + i,
                buy_volume=(60.0 if with_split else None),
                sell_volume=(40.0 if with_split else None),
            )
        )
    return out


# --- 1. columns_from_candles ---------------------------------------------------


def test_columns_contiguous_and_monotonic():
    cfg = _cfg()
    result = columns_from_candles(_candles(8), cfg)
    assert result is not None
    cols, epoch = result
    assert len(cols) == 8
    # col_seq strictly contiguous from 0 (Grid.preload requires it).
    assert [c.col_seq for c in cols] == list(range(8))
    # t0 strictly increasing and dt-aligned.
    for a, b in zip(cols, cols[1:]):
        assert b.t0_ns > a.t0_ns
    assert all(c.t0_ns % DT == 0 for c in cols)
    # rows match cfg; density is float16 and finite/bounded.
    f16_max = float(np.finfo(np.float16).max)
    for c in cols:
        assert len(c.bid) == cfg.rows and len(c.ask) == cfg.rows
        assert c.bid.dtype == np.float16 and c.ask.dtype == np.float16
        assert np.isfinite(c.bid.astype(np.float64)).all()
        assert float(c.bid.astype(np.float64).max()) <= f16_max
    # epoch frame: linear params match cfg, p0 centered on the last close.
    assert (epoch.tick, epoch.tick_multiple, epoch.dt_ns, epoch.rows) == (
        cfg.tick,
        cfg.tick_multiple,
        cfg.dt_ns,
        cfg.rows,
    )
    ref = cols[-1].bar.c
    assert abs(epoch.p0 - (ref - cfg.rows * cfg.tick / 2.0)) <= cfg.tick


def test_density_bounded_peak_and_two_sided_split():
    cfg = _cfg()
    cols, _ = columns_from_candles(_candles(6), cfg)
    combined_peak = max(
        max(float(c.bid.astype(np.float64).max()), float(c.ask.astype(np.float64).max()))
        for c in cols
    )
    # one global scale normalizes the densest bucket to the target (f16-safe).
    assert abs(combined_peak - PEAK_TARGET) < 1.0
    # split at the candle close leaves mass on BOTH channels for a ranged candle.
    assert any(float(c.ask.astype(np.float64).max()) > 0.0 for c in cols)
    assert any(float(c.bid.astype(np.float64).max()) > 0.0 for c in cols)


def test_reconstructed_cvd_from_taker_split():
    cfg = _cfg()
    cols, _ = columns_from_candles(_candles(4, with_split=True), cfg)
    # buy 60 / sell 40 per candle -> cvd rises by 20 each column.
    assert [round(c.bar.cvd_cum, 6) for c in cols] == [20.0, 40.0, 60.0, 80.0]
    assert all(c.bar.vol_buy == 60.0 and c.bar.vol_sell == 40.0 for c in cols)


def test_equity_no_split_leaves_cvd_flat():
    cfg = _cfg()
    cols, _ = columns_from_candles(_candles(4, with_split=False), cfg)
    assert all(c.bar.cvd_cum == 0.0 for c in cols)
    assert all(c.bar.vol_buy == 0.0 and c.bar.vol_sell == 0.0 for c in cols)
    # vwap sums still accumulate from candle typical price (both markets).
    assert cols[-1].bar.vwap_den_cum > 0.0


def test_preload_roundtrip_accepts_backfill_columns():
    cfg = _cfg()
    cols, epoch = columns_from_candles(_candles(10), cfg)
    grid = Grid(cfg)
    grid.preload(cols, [epoch])  # must not raise: contiguity contract honored
    served = grid.history(2**62, 100)
    assert len(served) == 10
    assert [c.col_seq for c in served] == list(range(10))
    # live continues in the SAME epoch (mid in range -> no immediate re-anchor).
    ref = cols[-1].bar.c
    params = grid.maybe_reanchor(ref)
    assert params is None
    assert grid.current_epoch_params().epoch == 0


def test_banded_grid_declines_backfill():
    cfg = GridCfg(
        tick=0.5, tick_multiple=1, dt_ns=DT, p0=0.0, rows=256, ring_columns=512,
        mode=MODE_L2, band_up=0.5, band_down=0.5,
    )
    assert columns_from_candles(_candles(4), cfg) is None


def test_empty_and_nonfinite_candles_return_none():
    cfg = _cfg()
    assert columns_from_candles([], cfg) is None
    bad = [Candle(t0_ns=0, o=float("nan"), h=1.0, l=1.0, c=1.0, volume=1.0)]
    assert columns_from_candles(bad, cfg) is None


# --- 2. Session wiring ---------------------------------------------------------


class _IdleFeed:
    """Feed that never yields; a capability donor for backfill wiring tests."""

    def __init__(self, market: str, symbol: str, capability: dict[str, object]) -> None:
        self.market = market
        self.symbol = symbol
        self.capability = capability

    async def events(self):
        await asyncio.sleep(3600)
        if False:  # pragma: no cover
            yield None


def _decode(buf: bytes) -> list:
    out, off = [], 0
    while off < len(buf):
        ev, off = wire.decode(buf, off)
        out.append(ev)
    return out


def _flatten(frames: list[bytes]) -> list:
    return [m for f in frames for m in _decode(f)]


def _backfill_fn(candles):
    async def fn(market, symbol, *, max_cols, now_ns):
        assert max_cols > 0
        return list(candles)

    return fn


async def test_session_backfill_seeds_ring_and_badges_history():
    grid = Grid(_cfg())
    feed = _IdleFeed("binance-spot", "BTCUSDT", {"depth": "L2", "cvd": "exchange"})
    sess = Session(
        "bf", feed=feed, grid=grid,
        backfill_fn=_backfill_fn(_candles(12)), backfill_max_cols=12,
    )
    await sess.start()
    try:
        client = ClientTx()
        frames = sess.attach(client)
        flat = _flatten(frames)
        hello = flat[0]
        assert isinstance(hello, Hello)
        # honesty badge (GOAL 1): reconstructed history flagged in capability.
        assert hello.capability.get("history") == "reconstructed"
        # the reconstructed columns are in the snapshot.
        assert sum(isinstance(m, DepthColumn) for m in flat) > 0
        # a gap marker separates the reconstructed tail from live.
        assert any(isinstance(m, Marker) and m.kind == "gap" for m in flat)
        # grid ring actually holds them.
        assert len(grid.history(2**62, 100)) == 12
    finally:
        sess.teardown_now()


async def test_session_without_backfill_is_unchanged():
    grid = Grid(_cfg())
    feed = _IdleFeed("sim", "SIM-DEMO", {"depth": "L2"})
    sess = Session("nobf", feed=feed, grid=grid)  # no backfill_fn
    await sess.start()
    try:
        hello = _flatten(sess.attach(ClientTx()))[0]
        assert isinstance(hello, Hello)
        assert "history" not in hello.capability
        assert hello.capability == feed.capability
        assert grid.history(2**62, 100) == []
    finally:
        sess.teardown_now()


async def test_session_backfill_failure_degrades_to_cold_start():
    async def boom(market, symbol, *, max_cols, now_ns):
        raise RuntimeError("provider down")

    grid = Grid(_cfg())
    feed = _IdleFeed("binance-spot", "BTCUSDT", {"depth": "L2"})
    sess = Session("bf-fail", feed=feed, grid=grid, backfill_fn=boom, backfill_max_cols=12)
    await sess.start()  # must not raise
    try:
        hello = _flatten(sess.attach(ClientTx()))[0]
        assert "history" not in hello.capability  # cold start, no false badge
        assert grid.history(2**62, 100) == []
    finally:
        sess.teardown_now()


async def test_manager_threads_backfill_for_live_only():
    cfg = Config()
    feed = _IdleFeed("binance-spot", "BTCUSDT", {"depth": "L2", "cvd": "exchange"})
    mgr = SessionManager(
        cfg, feed_factory=lambda sub: feed, backfill_fn=_backfill_fn(_candles(9))
    )
    # The manager builds the crypto grid; backfill recenters its epoch p0 on the
    # candles' last close, so the ~100-priced canned candles land in-range.
    sub = Subscribe(market="binance-spot", symbol="BTCUSDT", mode="live")
    client = ClientTx()
    sess = await mgr.subscribe(sub, client)
    try:
        # backfill ran (history badge present or ring seeded).
        hello = _flatten([f for f in _drain(client)])[0]
        assert isinstance(hello, Hello)
        assert hello.capability.get("history") == "reconstructed"
    finally:
        sess.teardown_now()


def _drain(client: ClientTx) -> list[bytes]:
    out: list[bytes] = []
    while True:
        frames = client.drain(1 << 30)
        if not frames:
            return out
        out.extend(frames)
