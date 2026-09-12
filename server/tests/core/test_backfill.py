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
import pytest

from flowmap_server.config import Config
from flowmap_server.core.backfill import (
    BACKFILL_DENSITY_GAIN,
    BAND_WEIGHT_FLOOR,
    DEFAULT_BACKFILL_STRETCH,
    DENSITY_SAFETY_MAX,
    Candle,
    _band_weights,
    columns_from_candles,
)
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


@pytest.fixture(autouse=True)
def _shape_env_default(monkeypatch):
    """Tests run with the shaping gate at its shipped default unless they opt in."""
    monkeypatch.delenv("FLOWMAP_BACKFILL_SHAPE", raising=False)


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
    result = columns_from_candles(_candles(8), cfg, stretch=1)
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


def _band_rows(cd: Candle, epoch, cfg: GridCfg) -> tuple[int, int, int]:
    """Mirror of the converter's row math: (lo_r, hi_r, close_r)."""
    step = cfg.tick * cfg.tick_multiple
    lo_r = int(round((min(cd.l, cd.h) - epoch.p0) / step))
    hi_r = int(round((max(cd.l, cd.h) - epoch.p0) / step))
    lo_r, hi_r = max(lo_r, 0), min(hi_r, cfg.rows - 1)
    close_r = int(round((cd.c - epoch.p0) / step))
    return lo_r, hi_r, close_r


def _combined_peak(cols) -> float:
    return max(
        max(float(c.bid.astype(np.float64).max()), float(c.ask.astype(np.float64).max()))
        for c in cols
    )


def test_density_bounded_peak_and_two_sided_split():
    cfg = _cfg()
    candles = _candles(6)
    cols, epoch = columns_from_candles(candles, cfg)
    combined_peak = _combined_peak(cols)
    # TRUE size units scaled by the documented display gain (no old fixed-1000
    # inflation). Shape-aware: the erode band's peak row carries
    # volume x max(_band_weights), then rides the SAME scale x gain pipeline;
    # these candles stay far below DENSITY_SAFETY_MAX, so scale == 1 here.
    expected = (
        max(
            float(cd.volume) * float(_band_weights(*_band_rows(cd, epoch, cfg)).max())
            for cd in candles
        )
        * BACKFILL_DENSITY_GAIN
    )
    assert 0.5 * expected < combined_peak < 2.0 * expected
    assert combined_peak == pytest.approx(expected, rel=0.005)  # f16 cast only
    # split at the candle close leaves mass on BOTH channels for a ranged candle.
    assert any(float(c.ask.astype(np.float64).max()) > 0.0 for c in cols)
    assert any(float(c.bid.astype(np.float64).max()) > 0.0 for c in cols)


def test_band_weights_exact_profile_floor_and_monotone_erosion():
    # Symmetric 5-row band with the close at the centre: hand-computable weights
    # (kernel [0, .5, 1, .5, 0], floor .15 -> unnormalized sum 2.45).
    w = _band_weights(100, 104, 102)
    assert w.shape == (5,)
    assert w.sum() == pytest.approx(1.0, rel=0, abs=1e-12)
    assert w == pytest.approx(
        [0.15 / 2.45, 0.575 / 2.45, 1.0 / 2.45, 0.575 / 2.45, 0.15 / 2.45],
        rel=1e-12,
    )
    peak = int(np.argmax(w))
    assert peak == 2  # profile peak row == close row
    # erosion monotone away from the peak (rising to it, falling after it);
    # the floor keeps every in-band row strictly positive.
    assert np.all(np.diff(w[: peak + 1]) >= 0.0)
    assert np.all(np.diff(w[peak:]) <= 0.0)
    assert (w > 0.0).all()
    assert w.min() == pytest.approx(BAND_WEIGHT_FLOOR / 2.45, rel=1e-12)
    # asymmetric band: the peak index tracks the close row (index = row - lo_r).
    assert int(np.argmax(_band_weights(100, 110, 104))) == 104 - 100
    # close outside the band clamps to the nearest edge; single row == mass 1.
    assert int(np.argmax(_band_weights(100, 104, 200))) == 104 - 100
    assert _band_weights(105, 105, 100) == pytest.approx([1.0], rel=1e-12)


def test_erode_profile_peaks_at_close_row():
    cfg = _cfg()
    candles = [Candle(t0_ns=0, o=100.0, h=101.0, l=99.0, c=100.0, volume=100.0)]
    cols, epoch = columns_from_candles(candles, cfg, stretch=1)
    _, _, close_r = _band_rows(candles[0], epoch, cfg)
    combined = cols[0].bid.astype(np.float64) + cols[0].ask.astype(np.float64)
    assert int(np.argmax(combined)) == close_r
    # mass lands on both channels: the close row is bid, rows above it ask.
    assert combined[close_r] > 0.0
    assert combined[:close_r].sum() > 0.0
    assert combined[close_r + 1 :].sum() > 0.0


def test_erode_mass_preserved_before_gain_scale(monkeypatch):
    # The converter casts to float16 for the ring; patch that cast so the raw
    # float64 band masses are directly observable — this asserts the shaping's
    # mass preservation (volume x sum(w) == volume), not the storage format.
    monkeypatch.setattr(np, "float16", np.float64)
    cfg = _cfg()
    candles = [Candle(t0_ns=0, o=100.0, h=101.0, l=99.0, c=100.0, volume=100.0)]
    cols, _ = columns_from_candles(candles, cfg, stretch=1)
    total = float(cols[0].bid.astype(np.float64).sum() + cols[0].ask.astype(np.float64).sum())
    # scale == 1 on these small volumes; divide the display gain back out.
    assert total / BACKFILL_DENSITY_GAIN == pytest.approx(100.0, rel=1e-6)


def test_flat_env_restores_legacy_flat_fill_exactly(monkeypatch):
    cfg = _cfg()
    candles = _candles(6)
    shaped, _ = columns_from_candles(candles, cfg)
    monkeypatch.setenv("FLOWMAP_BACKFILL_SHAPE", "flat")
    flat, _ = columns_from_candles(candles, cfg)
    # Legacy formula: volume / band-row-count on every in-band row. The densest
    # candle is the last (volume 105 over a 5-row band) -> 21 per row x gain;
    # 21 x 12 = 252 is exactly representable in float16, so this pins the old
    # BYTES, not a tolerance band.
    assert _combined_peak(flat) == 21.0 * BACKFILL_DENSITY_GAIN
    assert _combined_peak(shaped) > _combined_peak(flat)
    # unknown/unset values fall back to erode (shipped default).
    monkeypatch.setenv("FLOWMAP_BACKFILL_SHAPE", "bogus")
    again, _ = columns_from_candles(candles, cfg)
    assert np.array_equal(again[-1].bid, shaped[-1].bid)
    assert np.array_equal(again[-1].ask, shaped[-1].ask)


def test_pathological_doji_is_scaled_below_f16_max():
    cfg = _cfg()
    # h == l == c == a single row and an absurd volume: the whole volume lands
    # in one row, so the safety scale must pull it below f16's finite max.
    candles = [Candle(t0_ns=0, o=100.0, h=100.0, l=100.0, c=100.0, volume=1e9)]
    cols, _ = columns_from_candles(candles, cfg)
    peak = max(float(c.bid.astype(np.float64).max()) for c in cols)
    assert peak <= DENSITY_SAFETY_MAX
    assert np.isfinite(cols[0].bid.astype(np.float64)).all()


def test_stretch_repeats_each_candle_as_a_contiguous_band():
    """Default layout: each candle becomes a run of columns whose t0s span the
    candle's minute on the dt grid, so history paints as a CONTINUOUS band (the
    density repeats; one bar per candle keyed to the group's first column)."""
    cfg = _cfg()
    cols, _ = columns_from_candles(_candles(4), cfg, stretch=4)
    assert len(cols) == 16
    assert [c.col_seq for c in cols] == list(range(16))
    for a, b in zip(cols, cols[1:]):
        assert b.t0_ns > a.t0_ns
    assert all(c.t0_ns % DT == 0 for c in cols)
    for g in range(4):
        group = cols[g * 4 : (g + 1) * 4]
        base = group[0]
        for c in group:
            assert np.array_equal(c.bid, base.bid) and np.array_equal(c.ask, base.ask)
            assert c.bar.col_seq == base.col_seq  # one bar per candle (dedupes client-side)
        # t0 spans the minute in equal dt-aligned steps (15 s each at stretch 4).
        assert [c.t0_ns - base.t0_ns for c in group] == [0, 60 * DT, 120 * DT, 180 * DT]
    assert [cols[i].bar.col_seq for i in range(0, 16, 4)] == [0, 4, 8, 12]
    # Shipped default (stretch 16 on a 1 m candle) -> 3.75 s column steps: the
    # exact delta the reconstructed-history e2e pin (chart-reconstructed.spec)
    # tolerates as >= dt and < 60 s.
    cols16, _ = columns_from_candles(_candles(2), cfg, stretch=DEFAULT_BACKFILL_STRETCH)
    assert len(cols16) == 32
    assert cols16[1].t0_ns - cols16[0].t0_ns == 15 * DT  # 3_750_000_000 ns


def test_reconstructed_cvd_from_taker_split():
    cfg = _cfg()
    cols, _ = columns_from_candles(_candles(4, with_split=True), cfg, stretch=1)
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
    cols, epoch = columns_from_candles(_candles(10), cfg, stretch=1)
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
        # grid ring actually holds the full stretched reconstruction.
        assert len(grid.history(2**62, 500)) == 12 * DEFAULT_BACKFILL_STRETCH
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
        # replay:True is a SERVER-level badge merged into every Hello.
        assert hello.capability == {**feed.capability, "replay": True}
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


def test_same_slot_candles_both_kept_with_forced_t0():
    """Two candles snapping onto one dt slot are BOTH kept (one column per
    candle, per the module doc): the later candle is forced onto
    ``prev_t0 + dt`` so the col_seq/t0 sequence stays strictly increasing for
    ``Grid.preload`` — nothing is silently dropped."""
    cs = [
        Candle(t0_ns=0, o=100.0, h=101.0, l=99.0, c=100.0, volume=10.0),
        Candle(t0_ns=DT // 2, o=100.0, h=101.0, l=99.0, c=100.5, volume=5.0),
    ]
    out = columns_from_candles(cs, _cfg(), stretch=1)
    assert out is not None
    cols, _epoch = out
    assert [c.t0_ns for c in cols] == [0, DT]
    assert [c.col_seq for c in cols] == [0, 1]
    # The forced slot still carries the second candle's real data.
    assert cols[1].bar.c == 100.5
    assert cols[1].bar.vwap_den_cum == 15.0
