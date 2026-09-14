"""Crypto grid tick resolution (FLOWMAP_CRYPTO_TICK / preferred_tick).

The default crypto grid tick is the sim-shaped 0.5, scaled by tick_multiple
on re-anchor — correct for majors, but a sub-cent coin collapses into 1-2
rows. These tests pin the resolution order: an explicit config override
wins, a feed-declared ``preferred_tick`` comes next, the fallback last;
invalid values are treated as "no answer", never trusted.

The second half pins the price-ADAPTIVE fallback (QA20 C1/H2): when neither
override answers and the feed opts in (CryptoFeed's ``price_adaptive_tick``),
the grid replaces a fallback tick too coarse for the instrument with the 5th
significant digit of its own price at the first real mid — DOGEUSDT gets a
frame above zero with the book across >20 rows, while BTC/ETH keep $0.50 and
a byte-identical frame.
"""

from __future__ import annotations

import math
from types import SimpleNamespace

import numpy as np

from flowmap_server.config import Config
from flowmap_server.core.backfill import Candle, columns_from_candles
from flowmap_server.core.grid import FinalizedColumn, Grid, GridCfg, adaptive_tick_for
from flowmap_server.core.session import (
    SessionManager,
    _crypto_tick_auto,
    _crypto_tick_for,
)
from flowmap_server.proto.events import SIDE_BUY, BarColumn, EpochParams

import pytest


class FakeTimer:
    """SessionManager only needs a monotonic-ish clock for these tests."""

    def now_ns(self) -> int:  # pragma: no cover - name matches the real seam
        return 0


def _crypto_feed(**attrs: object) -> SimpleNamespace:
    base = {"market": "binance-spot", "symbol": "PEPEUSDT", "capability": {}}
    base.update(attrs)
    return SimpleNamespace(**base)


def _adaptive_feed(**attrs: object) -> SimpleNamespace:
    """The CryptoFeed shape: fallback tick is open to price adaptation."""
    return _crypto_feed(price_adaptive_tick=True, **attrs)


def test_fallback_is_the_sim_shaped_tick_when_nothing_declares() -> None:
    assert _crypto_tick_for(_crypto_feed(), 0.0) == 0.5


def test_feed_declared_preferred_tick_wins_over_fallback() -> None:
    assert _crypto_tick_for(_crypto_feed(preferred_tick=1e-6), 0.0) == 1e-6


def test_config_override_wins_over_feed_declaration() -> None:
    assert _crypto_tick_for(_crypto_feed(preferred_tick=1e-6), 0.01) == 0.01


@pytest.mark.parametrize("bad", [0, -1.0, float("nan"), float("inf")])
def test_invalid_values_are_never_trusted(bad: float) -> None:
    assert _crypto_tick_for(_crypto_feed(preferred_tick=bad), 0.0) == 0.5
    assert _crypto_tick_for(_crypto_feed(), bad) == 0.5


def test_grid_for_builds_with_the_declared_tick() -> None:
    cfg = Config()
    mgr = SessionManager(cfg, timer=FakeTimer())
    grid = mgr._grid_for(_crypto_feed(preferred_tick=1e-6))
    assert grid._cfg.tick == 1e-6
    # The nominal p0 anchor still sits on the tick grid.
    step = grid._step
    assert math.isclose(grid._p0 / step, round(grid._p0 / step), abs_tol=1e-9)


def test_grid_for_default_matches_the_old_fallback() -> None:
    cfg = Config()
    mgr = SessionManager(cfg, timer=FakeTimer())
    grid = mgr._grid_for(_crypto_feed())
    assert grid._cfg.tick == 0.5


# ---------------------------------------------------------------------------
# Price-adaptive fallback (QA20 C1/H2): no declared tick + opt-in feed
# ---------------------------------------------------------------------------

# What QA20 measured live: DOGEUSDT ~$0.0825 with the fallback $0.50 step put
# the whole book inside one row and the axis frame at ±1.5 (negative prices).
DOGE_MID = 0.0825
DOGE_VENUE_TICK = 1e-5


def _book(mid: float, n: int = 90, step: float = DOGE_VENUE_TICK):
    """A venue-tick book around *mid*: n levels per side, 100 units each."""
    offsets = step * np.arange(1, n + 1)
    sz = np.full(n, 100.0)
    return (mid - offsets, sz, mid + offsets, sz)


def _first_mid(grid: Grid, mid: float, n: int = 90, step: float = DOGE_VENUE_TICK):
    """Feed the first book (no column) and re-anchor around its mid."""
    bids, sz, asks, _ = _book(mid, n, step)
    assert grid.on_book(0, bids, sz, asks, sz) == []
    return grid.maybe_reanchor(mid)


def _doge_columns(rows: int, close: float = DOGE_MID):
    """Two zero-density columns + a bar at *close*, as load_tail returns."""
    cols = []
    for seq in range(2):
        bar = BarColumn(
            epoch=0,
            col_seq=seq,
            t0_ns=seq,
            o=close,
            h=close,
            l=close,
            c=close,
            vol_buy=0.0,
            vol_sell=0.0,
            cvd_cum=0.0,
            vwap_num_cum=0.0,
            vwap_den_cum=0.0,
        )
        cols.append(
            FinalizedColumn(
                epoch=0,
                col_seq=seq,
                t0_ns=seq,
                bid=np.zeros(rows, dtype=np.float16),
                ask=np.zeros(rows, dtype=np.float16),
                bar=bar,
            )
        )
    return cols


def test_adaptive_tick_is_the_fifth_significant_digit_when_coarse() -> None:
    assert adaptive_tick_for(DOGE_MID, 0.5) == pytest.approx(1e-6)
    assert adaptive_tick_for(99.64, 0.5) == pytest.approx(1e-3)
    # decade floors: 0.0999 -> 1e-6, 0.105 -> 1e-5 — still a positive frame.
    assert adaptive_tick_for(0.0999, 0.5) == pytest.approx(1e-6)
    assert adaptive_tick_for(0.105, 0.5) == pytest.approx(1e-5)
    # the boundary itself: 0.5 >= 500*1e-3 trips, 999 does not.
    assert adaptive_tick_for(500.0, 0.5) == pytest.approx(0.01)
    assert adaptive_tick_for(999.0, 0.5) == 0.5


def test_adaptive_tick_leaves_majors_fine_ticks_and_garbage_untouched() -> None:
    for mid in (2486.0, 60_000.0):
        assert adaptive_tick_for(mid, 0.5) == 0.5
    assert adaptive_tick_for(DOGE_MID, 1e-5) == 1e-5  # never coarsened
    assert adaptive_tick_for(float("nan"), 0.5) == 0.5
    assert adaptive_tick_for(float("inf"), 0.5) == 0.5
    assert adaptive_tick_for(0.0, 0.5) == 0.5
    assert adaptive_tick_for(-1.0, 0.5) == 0.5
    assert adaptive_tick_for(DOGE_MID, 0.0) == 0.0


def test_grid_opts_in_only_without_a_declared_tick() -> None:
    mgr = SessionManager(Config(recording_enabled=False), timer=FakeTimer())
    assert mgr._grid_for(_adaptive_feed()).cfg.auto_tick is True
    assert mgr._grid_for(_crypto_feed()).cfg.auto_tick is False
    # A feed declaration or the env override IS an answer: never second-guessed.
    assert mgr._grid_for(_adaptive_feed(preferred_tick=1e-5)).cfg.auto_tick is False
    mgr_override = SessionManager(
        Config(recording_enabled=False, crypto_tick=0.5), timer=FakeTimer()
    )
    assert mgr_override._grid_for(_adaptive_feed()).cfg.auto_tick is False
    assert _crypto_tick_auto(_adaptive_feed(), 0.0) is True
    assert _crypto_tick_auto(_adaptive_feed(), 0.25) is False
    assert _crypto_tick_auto(_adaptive_feed(preferred_tick=1e-5), 0.0) is False
    assert _crypto_tick_auto(_crypto_feed(), 0.0) is False


def test_crypto_replays_opt_in_but_sim_replays_do_not() -> None:
    """A replay grid is virgin, so a DOGE replay must adapt too — while the
    sim replay (mid ~100, the shape the fallback was built for) stays fixed."""
    from flowmap_server.core.record import TailData
    from flowmap_server.feeds.replay import ReplayFeed

    cols = _doge_columns(rows=2048)
    epoch = EpochParams(
        epoch=0, tick=1e-6, tick_multiple=1, dt_ns=250_000_000,
        p0=DOGE_MID - 2048 * 1e-6 / 2.0, rows=2048,
    )
    tail = TailData(
        epochs=[epoch], columns=cols, trades=[], markers=[],
        newest_t0_ns=cols[-1].t0_ns,
    )
    mgr = SessionManager(Config(recording_enabled=False), timer=FakeTimer())
    crypto = ReplayFeed(market="binance-spot", symbol="DOGEUSDT", tail=tail)
    sim = ReplayFeed(market="sim", symbol="SIM-DEMO", tail=tail)
    assert mgr._grid_for(crypto).cfg.auto_tick is True
    assert mgr._grid_for(sim).cfg.auto_tick is False


def test_doge_first_book_gets_a_sane_frame_with_no_negative_prices() -> None:
    """QA20 C1: DOGE must not collapse into <1 row with a negative axis."""
    mgr = SessionManager(Config(recording_enabled=False), timer=FakeTimer())
    grid = mgr._grid_for(_adaptive_feed())
    assert grid.cfg.tick == 0.5 and grid._step == 0.5  # nominal until the mid

    ep = _first_mid(grid, DOGE_MID)
    assert ep is not None and ep.epoch == 1
    assert ep.tick == pytest.approx(1e-6)
    assert grid._step == pytest.approx(1e-6)
    assert ep.rows == grid.cfg.rows
    # The whole frame is above zero (no negative prices) and centred on mid.
    frame_lo = grid._p0
    frame_hi = grid._p0 + ep.rows * grid._step
    assert 0.0 < frame_lo < DOGE_MID < frame_hi
    # ... and the book is resolvable across rows, not a single smear: every
    # one of the 90+90 venue-tick levels lands on its own row.
    occupied = int(np.count_nonzero(grid._state[0])) + int(
        np.count_nonzero(grid._state[1])
    )
    assert occupied > 20
    assert occupied == 180
    assert grid.current_partial() is not None


def test_btc_and_eth_keep_the_legacy_tick_and_frame() -> None:
    """The mandate: a major's grid is byte-identical with the opt-in feed."""
    mgr = SessionManager(Config(recording_enabled=False), timer=FakeTimer())
    for mid in (60_000.0, 2486.0):
        adaptive = mgr._grid_for(_adaptive_feed())
        plain = mgr._grid_for(_crypto_feed())
        ep_adaptive = _first_mid(adaptive, mid, n=4, step=1.0)
        ep_plain = _first_mid(plain, mid, n=4, step=1.0)
        assert ep_adaptive == ep_plain
        assert adaptive._tick == 0.5 and adaptive._step == 0.5
        assert adaptive._p0 == pytest.approx(
            mid - adaptive.cfg.rows * 0.5 / 2.0
        )


def test_adaptation_fires_once_then_the_tick_is_frozen() -> None:
    mgr = SessionManager(Config(recording_enabled=False), timer=FakeTimer())
    grid = mgr._grid_for(_adaptive_feed())
    bids, sz, asks, _ = _book(DOGE_MID)
    grid.on_book(0, bids, sz, asks, sz)
    grid.maybe_reanchor(DOGE_MID)
    assert grid._step == pytest.approx(1e-6)
    # A column now exists; a decade-hopping mid may only shift p0 (resident
    # columns share ONE row affine), never re-scale the tick.
    cols = grid.on_book(grid.cfg.dt_ns, bids, sz, asks, sz)
    assert cols
    ep = grid.maybe_reanchor(0.105)
    assert ep is not None and ep.tick == pytest.approx(1e-6)
    assert grid._step == pytest.approx(1e-6)
    assert grid.epoch_params_for(ep.epoch).tick == pytest.approx(1e-6)


def test_adaptation_survives_pre_book_trade_intervals() -> None:
    """A live venue streams trades while its depth snapshot is still being
    fetched: the trade anchors time, an all-zero column finalizes before the
    first real book, and the adaptive tick must STILL fire (nothing was
    painted yet)."""
    mgr = SessionManager(Config(recording_enabled=False), timer=FakeTimer())
    grid = mgr._grid_for(_adaptive_feed())
    grid.on_trade(0, DOGE_MID, 1.0, SIDE_BUY)
    bids, sz, asks, _ = _book(DOGE_MID)
    cols = grid.on_book(grid.cfg.dt_ns, bids, sz, asks, sz)
    assert cols and float(cols[0].bid.max()) == 0.0  # pre-book column: empty
    ep = grid.maybe_reanchor(DOGE_MID)
    assert ep is not None and ep.tick == pytest.approx(1e-6)
    assert grid._step == pytest.approx(1e-6)
    assert grid._p0 > 0.0


def test_backfill_bins_reconstructed_history_in_the_adapted_frame() -> None:
    mgr = SessionManager(Config(recording_enabled=False), timer=FakeTimer())
    grid = mgr._grid_for(_adaptive_feed())
    assert grid.cfg.auto_tick is True
    candles = [
        Candle(
            t0_ns=i * 60_000_000_000,
            o=DOGE_MID,
            h=DOGE_MID * 1.005,
            l=DOGE_MID * 0.995,
            c=DOGE_MID,
            volume=1e6,
            buy_volume=5e5,
            sell_volume=5e5,
        )
        for i in range(3)
    ]
    result = columns_from_candles(candles, grid.cfg, stretch=1)
    assert result is not None
    columns, epoch = result
    assert epoch.tick == pytest.approx(1e-6)
    assert epoch.p0 > 0.0
    grid.preload(columns, [epoch])
    assert grid._tick == pytest.approx(1e-6)  # adopted from the tail ...
    assert grid._tick_anchored is True  # ... and frozen
    # The first live book under the same mid must not change the frame at all.
    ep = _first_mid(grid, DOGE_MID)
    assert ep is None
    assert grid._step == pytest.approx(1e-6)


def test_backfill_leaves_non_adaptive_grids_byte_identical() -> None:
    mgr = SessionManager(Config(recording_enabled=False), timer=FakeTimer())
    grid = mgr._grid_for(_crypto_feed())
    candles = [
        Candle(
            t0_ns=0,
            o=DOGE_MID,
            h=DOGE_MID,
            l=DOGE_MID,
            c=DOGE_MID,
            volume=1.0,
        )
    ]
    result = columns_from_candles(candles, grid.cfg, stretch=1)
    assert result is not None
    _, epoch = result
    assert epoch.tick == grid.cfg.tick == 0.5


def test_preload_adopts_an_adaptive_tail_and_frozen_tick() -> None:
    mgr = SessionManager(Config(recording_enabled=False), timer=FakeTimer())
    grid = mgr._grid_for(_adaptive_feed())
    cols = _doge_columns(rows=grid.cfg.rows)
    epoch = EpochParams(
        epoch=0,
        tick=1e-6,
        tick_multiple=1,
        dt_ns=grid.cfg.dt_ns,
        p0=DOGE_MID - grid.cfg.rows * 1e-6 / 2.0,
        rows=grid.cfg.rows,
    )
    grid.preload(cols, [epoch])
    assert grid._tick == pytest.approx(1e-6)
    assert grid._step == pytest.approx(1e-6)
    # A decade-moved mid re-centres p0 ONLY (tick frozen, no re-adaptation).
    ep = _first_mid(grid, 0.105)
    assert ep is not None and ep.tick == pytest.approx(1e-6)
    assert grid._tick == pytest.approx(1e-6)
    assert grid._p0 > 0.0


def test_preload_rejects_a_recorded_frame_its_price_has_outgrown() -> None:
    """A pre-fix DOGE recording ($0.50 rows on a $0.08 asset) must cold-start
    (the backfill then re-bins the history) instead of perpetuating the
    sub-row collapse."""
    mgr = SessionManager(Config(recording_enabled=False), timer=FakeTimer())
    grid = mgr._grid_for(_adaptive_feed())
    cols = _doge_columns(rows=grid.cfg.rows)
    epoch = EpochParams(
        epoch=0,
        tick=0.5,
        tick_multiple=1,
        dt_ns=grid.cfg.dt_ns,
        p0=DOGE_MID - grid.cfg.rows * 0.5 / 2.0,
        rows=grid.cfg.rows,
    )
    with pytest.raises(ValueError, match="too coarse"):
        grid.preload(cols, [epoch])
    # Rejected => the grid stays virgin so the caller's cold start can run.
    assert grid._count == 0
    assert grid._tick_anchored is False


def test_preload_still_rejects_a_foreign_shape() -> None:
    """The adaptive relaxation must not admit arbitrary ticks/rows."""
    mgr = SessionManager(Config(recording_enabled=False), timer=FakeTimer())
    grid = mgr._grid_for(_adaptive_feed())
    cols = _doge_columns(rows=grid.cfg.rows)
    wrong_rows = EpochParams(
        epoch=0,
        tick=1e-6,
        tick_multiple=1,
        dt_ns=grid.cfg.dt_ns,
        p0=0.0,
        rows=grid.cfg.rows // 2,
    )
    with pytest.raises(ValueError, match="do not match grid cfg"):
        grid.preload(cols, [wrong_rows])
