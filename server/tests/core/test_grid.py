"""Density grid tests (design spec §8.1–8.2).

The first six tests are the frozen contract from the M1 plan (verbatim).
The rest pin down trade/bar semantics, ring wraparound, history slicing,
partial emission, out-of-range handling, and re-anchor behavior.
"""

import math
import time
import warnings

import numpy as np
import pytest

from flowmap_server.core.grid import FinalizedColumn, Grid, GridCfg
from flowmap_server.proto import wire
from flowmap_server.proto.events import (
    SIDE_BUY,
    SIDE_SELL,
    SIDE_UNKNOWN,
    BarColumn,
    DepthColumn,
)

CFG = GridCfg(tick=0.5, tick_multiple=1, dt_ns=1_000_000_000, p0=90.0, rows=64,
              ring_columns=128, mode=0)

def book(mid, sz):  # 3-level symmetric book helper
    px = np.array([mid-1.0, mid-0.5, mid], dtype=np.float64)
    return (px - 0.0, np.full(3, sz), px + 0.5, np.full(3, sz))

def test_time_weighted_identical_across_cadence():
    g1, g2 = Grid(CFG), Grid(CFG)
    t0 = 0
    g1.on_book(t0, *book(100.0, 5.0))
    g2.on_book(t0, *book(100.0, 5.0))
    for i in range(1, 11):
        g2.on_book(t0 + i * 100_000_000, *book(100.0, 5.0))
    c1 = g1.on_book(t0 + 1_000_000_000, *book(100.0, 5.0))
    c2 = g2.on_book(t0 + 1_000_000_000, *book(100.0, 5.0))
    assert len(c1) == len(c2) == 1
    assert np.array_equal(c1[0].bid, c2[0].bid) and np.array_equal(c1[0].ask, c2[0].ask)

def test_half_interval_weighting():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 4.0))
    g.on_book(500_000_000, *book(100.0, 8.0))
    (col,) = g.on_book(1_000_000_000, *book(100.0, 8.0))
    row = round((100.0 - 0.5 - CFG.p0) / 0.5)
    assert col.bid[row] == np.float16(6.0)

def test_gap_emits_empty_columns():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    cols = g.on_book(3_500_000_000, *book(100.0, 5.0))
    assert len(cols) == 3
    assert cols[1].bid.max() > 0

def test_reanchor_preserves_history():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    g.on_book(1_000_000_000, *book(100.0, 5.0))
    before = g.history(before_t_ns=2_000_000_000, n=10)
    params = g.maybe_reanchor(mid=140.0)
    assert params is not None and params.epoch == 1
    assert params.p0 % (CFG.tick * CFG.tick_multiple) == 0
    after = g.history(before_t_ns=2_000_000_000, n=10)
    assert all(np.array_equal(a.bid, b.bid) for a, b in zip(before, after))
    assert after[0].epoch == 0

def test_no_reanchor_inside_band():
    assert Grid(CFG).maybe_reanchor(mid=106.0) is None

def test_update_cost_under_2ms():
    g = Grid(GridCfg(tick=0.5, tick_multiple=1, dt_ns=250_000_000, p0=0.0, rows=4096,
                     ring_columns=1024, mode=0))
    rng = np.random.default_rng(0)
    px = np.sort(rng.uniform(10, 2000, 2000)); sz = rng.uniform(0.1, 50, 2000)
    g.on_book(0, px, sz, px + 0.5, sz)
    t = time.perf_counter()
    for i in range(1, 101):
        g.on_book(i * 10_000_000, px, sz, px + 0.5, sz)
    assert (time.perf_counter() - t) / 100 < 0.002


# --------------------------------------------------------------------------
# Additional tests (own): trade/bar semantics
# --------------------------------------------------------------------------


def test_trade_side_routing_and_cumulative_bars():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    g.on_trade(100_000_000, 100.0, 2.0, SIDE_BUY)
    g.on_trade(200_000_000, 101.0, 1.0, SIDE_SELL)
    g.on_trade(300_000_000, 102.0, 4.0, SIDE_UNKNOWN)
    (col0,) = g.on_book(1_000_000_000, *book(100.0, 5.0))
    b0 = col0.bar
    assert isinstance(b0, BarColumn)
    assert (b0.epoch, b0.col_seq, b0.t0_ns) == (0, 0, 0)
    assert (b0.o, b0.h, b0.l, b0.c) == (100.0, 102.0, 100.0, 102.0)
    assert b0.vol_buy == 2.0 and b0.vol_sell == 1.0
    # unknown side: neither vol bucket, cvd unchanged, but vwap sums count it
    assert b0.cvd_cum == 1.0  # +2 (buy) - 1 (sell) + 0 (unknown)
    assert b0.vwap_num_cum == 2 * 100.0 + 1 * 101.0 + 4 * 102.0  # 709.0
    assert b0.vwap_den_cum == 7.0

    # second interval: per-interval fields reset, *_cum fields carry forward
    g.on_trade(1_500_000_000, 103.0, 3.0, SIDE_BUY)
    (col1,) = g.on_book(2_000_000_000, *book(100.0, 5.0))
    b1 = col1.bar
    assert (b1.epoch, b1.col_seq, b1.t0_ns) == (0, 1, 1_000_000_000)
    assert (b1.o, b1.h, b1.l, b1.c) == (103.0, 103.0, 103.0, 103.0)
    assert b1.vol_buy == 3.0 and b1.vol_sell == 0.0
    assert b1.cvd_cum == 4.0
    assert b1.vwap_num_cum == 709.0 + 3 * 103.0  # 1018.0
    assert b1.vwap_den_cum == 10.0


def test_bar_carry_forward_close_on_empty_intervals():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    g.on_trade(100_000_000, 102.0, 1.0, SIDE_BUY)
    cols = g.on_book(3_500_000_000, *book(100.0, 5.0))
    assert len(cols) == 3
    # intervals 1 and 2 have no trades: o=h=l=c=prev_close, zero volume
    for col in cols[1:]:
        b = col.bar
        assert (b.o, b.h, b.l, b.c) == (102.0, 102.0, 102.0, 102.0)
        assert b.vol_buy == 0.0 and b.vol_sell == 0.0
        assert b.cvd_cum == 1.0 and b.vwap_den_cum == 1.0  # cums frozen, not reset


def test_bar_nan_before_any_trade():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    (col,) = g.on_book(1_000_000_000, *book(100.0, 5.0))
    b = col.bar
    assert math.isnan(b.o) and math.isnan(b.h) and math.isnan(b.l) and math.isnan(b.c)
    assert b.vol_buy == 0.0 and b.vol_sell == 0.0
    assert b.cvd_cum == 0.0 and b.vwap_num_cum == 0.0 and b.vwap_den_cum == 0.0


# --------------------------------------------------------------------------
# Additional tests (own): ring wraparound + history slicing
# --------------------------------------------------------------------------


def test_ring_wraparound_retains_only_last_columns():
    cfg = GridCfg(tick=0.5, tick_multiple=1, dt_ns=1_000_000_000, p0=90.0, rows=64,
                  ring_columns=4, mode=0)
    g = Grid(cfg)
    g.on_book(0, *book(100.0, 5.0))
    # two sub-cap jumps (<= ring_columns + 1 intervals each) so every column
    # is genuinely emitted and the ring wraps; the capped path has its own test
    cols = g.on_book(5_000_000_000, *book(100.0, 5.0))
    cols += g.on_book(10_000_000_000, *book(100.0, 5.0))
    assert len(cols) == 10  # col_seq 0..9 finalized; ring keeps only the last 4
    h = g.history(before_t_ns=10_000_000_000, n=100)
    assert [c.col_seq for c in h] == [6, 7, 8, 9]
    assert [c.t0_ns for c in h] == [6_000_000_000, 7_000_000_000,
                                    8_000_000_000, 9_000_000_000]
    row = round((99.5 - cfg.p0) / 0.5)
    assert all(c.bid[row] == np.float16(5.0) for c in h)


def test_history_before_t_is_exclusive_and_n_takes_most_recent():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    g.on_book(2_000_000_000, *book(100.0, 5.0))  # finalizes t0=0 and t0=1e9
    # before_t_ns is EXCLUSIVE: a column with t0_ns == before_t_ns is not returned
    h = g.history(before_t_ns=1_000_000_000, n=10)
    assert [c.t0_ns for c in h] == [0]
    h = g.history(before_t_ns=1_000_000_001, n=10)
    assert [c.t0_ns for c in h] == [0, 1_000_000_000]  # chronological order
    # n limits to the MOST RECENT n qualifying columns
    h = g.history(before_t_ns=2_000_000_000, n=1)
    assert [c.t0_ns for c in h] == [1_000_000_000]
    assert g.history(before_t_ns=0, n=10) == []


# --------------------------------------------------------------------------
# Additional tests (own): partial emission
# --------------------------------------------------------------------------


def test_current_partial_depth_column():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 4.0))
    g.on_book(500_000_000, *book(100.0, 8.0))
    p = g.current_partial()
    assert isinstance(p, DepthColumn)
    assert p.final is False
    assert p.mode == CFG.mode
    assert (p.epoch, p.col_seq, p.t0_ns) == (0, 0, 0)
    assert p.bid.dtype == np.float32 and p.ask.dtype == np.float32
    row = round((99.5 - CFG.p0) / 0.5)
    # partial integral so far: 4 sz * 0.5 s / 1.0 s dt = 2.0
    assert p.bid[row] == np.float32(2.0)


def test_bar_partial_reflects_current_interval():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    g.on_trade(100_000_000, 100.0, 2.0, SIDE_BUY)
    b = g.bar_partial()
    assert isinstance(b, BarColumn)
    assert (b.epoch, b.col_seq, b.t0_ns) == (0, 0, 0)
    assert (b.o, b.c) == (100.0, 100.0)
    assert b.vol_buy == 2.0 and b.cvd_cum == 2.0


# --------------------------------------------------------------------------
# Additional tests (own): out-of-range levels
# --------------------------------------------------------------------------


def test_out_of_range_levels_dropped_without_error():
    g = Grid(CFG)  # span [90.0, 122.0)
    px = np.array([50.0, 100.0, 500.0])
    sz = np.array([7.0, 3.0, 9.0])
    g.on_book(0, px, sz, px, sz)
    (col,) = g.on_book(1_000_000_000, px, sz, px, sz)
    row = round((100.0 - CFG.p0) / 0.5)
    assert col.bid[row] == np.float16(3.0)
    assert float(col.bid.astype(np.float64).sum()) == 3.0  # 50 and 500 dropped
    assert float(col.ask.astype(np.float64).sum()) == 3.0


# --------------------------------------------------------------------------
# Additional tests (own): re-anchor
# --------------------------------------------------------------------------


def test_reanchor_p0_value_and_params():
    params = Grid(CFG).maybe_reanchor(mid=140.0)
    assert params is not None
    # span=32.0, p0_new = snap(140 - 16) = 124.0 on the tick*multiple grid
    assert params.p0 == 124.0
    assert params.epoch == 1
    assert params.tick == CFG.tick
    assert params.tick_multiple == CFG.tick_multiple
    assert params.dt_ns == CFG.dt_ns
    assert params.rows == CFG.rows


def test_post_reanchor_columns_carry_new_epoch_and_new_mapping():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    g.on_book(1_000_000_000, *book(100.0, 5.0))
    params = g.maybe_reanchor(mid=140.0)
    assert params.p0 == 124.0
    # old book (mid 100) is entirely below the new span [124, 156): empty column
    (col1,) = g.on_book(2_000_000_000, *book(140.0, 5.0))
    assert col1.epoch == 1 and col1.bar.epoch == 1
    assert col1.bid.max() == 0
    # new book maps against the new p0
    (col2,) = g.on_book(3_000_000_000, *book(140.0, 5.0))
    assert col2.epoch == 1
    assert col2.col_seq == 2  # monotonic across epochs, never resets
    bid_row = round((139.5 - 124.0) / 0.5)
    ask_row = round((140.5 - 124.0) / 0.5)
    assert col2.bid[bid_row] == np.float16(5.0)
    assert col2.ask[ask_row] == np.float16(5.0)
    assert col2.bar.t0_ns == col2.t0_ns


def test_reanchor_shifts_partial_accumulator():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    g.on_book(1_500_000_000, *book(100.0, 5.0))  # interval 1 holds 0.5 s of book@5
    params = g.maybe_reanchor(mid=94.0)  # below central band [94.8, 117.2)
    assert params is not None and params.p0 == 78.0  # snap(94 - 16)
    (col1,) = g.on_book(2_000_000_000, *book(100.0, 5.0))
    assert col1.epoch == 1
    row = round((99.5 - 78.0) / 0.5)
    # 0.5 s accumulated pre-reanchor (shifted) + 0.5 s post = full 5.0
    assert col1.bid[row] == np.float16(5.0)


# --------------------------------------------------------------------------
# Additional tests (own): gap cap, robustness, API polish
# --------------------------------------------------------------------------


def test_gap_finalization_capped_at_ring_columns():
    """A 1-hour gap at dt=250ms (14 400 intervals) must not return 14 400
    columns: the cap finalizes the current partial + the last ring_columns
    intervals, with col_seq advanced across the skip so col_seq == t0/dt."""
    dt = 250_000_000
    cfg = GridCfg(tick=0.5, tick_multiple=1, dt_ns=dt, p0=90.0, rows=64,
                  ring_columns=128, mode=0)
    g = Grid(cfg)
    g.on_book(0, *book(100.0, 5.0))
    cols = g.on_book(3_600_000_000_000, *book(100.0, 5.0))  # +1 hour
    assert len(cols) <= 129
    assert len(cols) == 129  # 1 partial + ring_columns persisted-book columns
    assert cols[0].col_seq == 0 and cols[0].t0_ns == 0
    assert cols[1].col_seq == 14_400 - 128  # skip jumps straight to ring window
    assert cols[-1].col_seq == 14_399
    assert cols[-1].t0_ns == 3_600_000_000_000 - dt
    # col_seq <-> t0 stays consistent across the skipped range
    assert all(c.col_seq == c.t0_ns // dt for c in cols)
    # ring intact: exactly the last ring_columns columns retained, book persisted
    h = g.history(before_t_ns=10**18, n=10_000)
    assert len(h) == 128
    assert [c.col_seq for c in h] == [c.col_seq for c in cols[-128:]]
    assert all(c.bid.max() > 0 for c in h)
    assert g.oldest_retained_t0_ns() == (14_400 - 128) * dt


def test_nonfinite_levels_dropped_cleanly():
    g = Grid(CFG)
    px = np.array([99.0, np.nan, 100.0, np.inf])
    sz = np.array([2.0, 3.0, np.nan, 1.0])
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # any RuntimeWarning fails the test
        g.on_book(0, px, sz, px, sz)
        (col,) = g.on_book(1_000_000_000, px, sz, px, sz)
    # only (99.0, 2.0) survives: NaN price, NaN size and inf price are dropped
    row = round((99.0 - CFG.p0) / 0.5)
    assert col.bid[row] == np.float16(2.0)
    assert float(col.bid.astype(np.float64).sum()) == 2.0
    assert float(col.ask.astype(np.float64).sum()) == 2.0


def test_to_depth_roundtrips_through_wire():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    (col,) = g.on_book(1_000_000_000, *book(100.0, 5.0))
    d = g.to_depth(col)
    assert isinstance(d, DepthColumn)
    assert d.final is True and d.mode == CFG.mode
    assert d.bid.dtype == np.float32 and d.ask.dtype == np.float32
    out, _ = wire.decode(wire.encode(d), 0)
    assert (out.epoch, out.col_seq, out.t0_ns) == (col.epoch, col.col_seq, col.t0_ns)
    assert out.final is True
    assert np.array_equal(out.bid, d.bid) and np.array_equal(out.ask, d.ask)
    # f16 ring values are exactly representable in f32: no further loss
    assert np.array_equal(out.bid, col.bid.astype(np.float32))


def test_current_partial_none_before_any_event():
    assert Grid(CFG).current_partial() is None


def test_oldest_retained_t0_ns():
    cfg = GridCfg(tick=0.5, tick_multiple=1, dt_ns=1_000_000_000, p0=90.0, rows=64,
                  ring_columns=4, mode=0)
    g = Grid(cfg)
    assert g.oldest_retained_t0_ns() is None
    g.on_book(0, *book(100.0, 5.0))
    assert g.oldest_retained_t0_ns() is None  # nothing finalized yet
    g.on_book(2_000_000_000, *book(100.0, 5.0))  # finalizes t0=0, t0=1e9
    assert g.oldest_retained_t0_ns() == 0
    g.on_book(6_000_000_000, *book(100.0, 5.0))  # 6 columns total, ring keeps 4
    assert g.oldest_retained_t0_ns() == 2_000_000_000


def test_reanchor_after_ring_wraparound_mixed_epoch_history():
    cfg = GridCfg(tick=0.5, tick_multiple=1, dt_ns=1_000_000_000, p0=90.0, rows=64,
                  ring_columns=4, mode=0)
    g = Grid(cfg)
    g.on_book(0, *book(100.0, 5.0))
    g.on_book(6_000_000_000, *book(100.0, 5.0))  # cols 0..5; ring wrapped to 2..5
    params = g.maybe_reanchor(mid=140.0)
    assert params is not None and params.epoch == 1 and params.p0 == 124.0
    g.on_book(7_000_000_000, *book(140.0, 5.0))  # col 6: old book out of range
    g.on_book(8_000_000_000, *book(140.0, 5.0))  # col 7: new book, new mapping
    h = g.history(before_t_ns=10**18, n=10)
    assert [c.col_seq for c in h] == [4, 5, 6, 7]
    assert [c.epoch for c in h] == [0, 0, 1, 1]  # history NEVER rewritten
    old_row = round((99.5 - 90.0) / 0.5)
    new_row = round((139.5 - 124.0) / 0.5)
    assert h[0].bid[old_row] == np.float16(5.0)  # epoch-0 rows still vs p0=90
    assert h[2].bid.max() == 0                   # gap column right after re-anchor
    assert h[3].bid[new_row] == np.float16(5.0)  # epoch-1 rows vs p0=124


def test_on_trade_before_any_on_book_anchors_interval():
    g = Grid(CFG)
    g.on_trade(1_500_000_000, 100.0, 2.0, SIDE_BUY)  # anchors interval 1
    b = g.bar_partial()
    assert b.t0_ns == 1_000_000_000 and b.vol_buy == 2.0 and b.c == 100.0
    p = g.current_partial()
    assert p is not None and p.t0_ns == 1_000_000_000
    assert float(p.bid.max()) == 0.0  # no book yet: zero density
    (col,) = g.on_book(2_000_000_000, *book(100.0, 5.0))
    assert col.t0_ns == 1_000_000_000 and col.col_seq == 0
    assert col.bid.max() == 0  # book arrived at the boundary: zero state integrated
    assert col.bar.vol_buy == 2.0 and col.bar.c == 100.0


def test_non_monotonic_ts_clamped_to_zero_span():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 4.0))
    g.on_book(500_000_000, *book(100.0, 8.0))
    # late update: clamped to zero span (nothing integrated at size 8),
    # but the book state IS replaced
    assert g.on_book(400_000_000, *book(100.0, 2.0)) == []
    (col,) = g.on_book(1_000_000_000, *book(100.0, 2.0))
    row = round((99.5 - CFG.p0) / 0.5)
    # [0, 0.5s) at size 4, [0.5s, 1.0s) at size 2 -> time-weighted mean 3.0
    assert col.bid[row] == np.float16(3.0)


# --------------------------------------------------------------------------
# Additional tests (own): duplicate-timestamp boundary idempotency
# --------------------------------------------------------------------------


def test_duplicate_ts_at_boundary_reemits_same_column():
    """A zero-span on_book at exactly the just-finalized boundary re-returns
    that column (same col_seq; ring/state untouched). Callers dedup by col_seq.
    A zero-span call NOT at a boundary returns nothing."""
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    (a,) = g.on_book(1_000_000_000, *book(100.0, 5.0))
    (b,) = g.on_book(1_000_000_000, *book(100.0, 5.0))
    assert isinstance(a, FinalizedColumn) and isinstance(b, FinalizedColumn)
    assert a.col_seq == b.col_seq == 0
    assert np.array_equal(a.bid, b.bid)
    assert g.history(before_t_ns=10**18, n=10)[0].col_seq == 0  # stored once
    assert g.on_book(1_200_000_000, *book(100.0, 5.0)) == []
    assert g.on_book(1_200_000_000, *book(100.0, 5.0)) == []


def test_epoch_params_table_survives_reanchors():
    """Per-epoch params table (spec §6.3): epoch 0 present at construction,
    every re-anchor recorded, old epochs retrievable, current matches."""
    g = Grid(CFG)
    p_zero = g.epoch_params_for(0)
    assert p_zero.epoch == 0 and p_zero.p0 == CFG.p0 and p_zero.dt_ns == CFG.dt_ns
    assert g.current_epoch_params() is p_zero

    g.on_book(0, *book(100.0, 5.0))
    p_one = g.maybe_reanchor(mid=140.0)
    assert p_one is not None and p_one.epoch == 1
    p_two = g.maybe_reanchor(mid=190.0)
    assert p_two is not None and p_two.epoch == 2

    assert g.epoch_params_for(0) is p_zero  # old epochs stay retrievable
    assert g.epoch_params_for(1) is p_one
    assert g.epoch_params_for(2) is p_two
    assert g.current_epoch_params() is p_two

    try:
        g.epoch_params_for(99)
    except KeyError:
        pass
    else:  # pragma: no cover
        raise AssertionError("expected KeyError for an unknown epoch")


# --- preload (spec §8.1 rehydration; M1 T11) ---------------------------------

DT = CFG.dt_ns


def _driven_cols(n=10, with_trades=True):
    """Drive a source grid and harvest its finalized columns + epoch params."""
    src = Grid(CFG)
    src.on_book(0, *book(100.0, 5.0))
    cols = []
    for i in range(1, n + 1):
        if with_trades:
            src.on_trade(i * DT - 1, 100.0, 2.0, SIDE_BUY)
        cols += src.on_book(i * DT, *book(100.0, 5.0))
    return src, cols


def test_preload_restores_ring_counters_and_continuity():
    src, cols = _driven_cols(10)
    g = Grid(CFG)
    g.preload(cols, [src.epoch_params_for(0)])

    hist = g.history(before_t_ns=10**18, n=100)
    assert [c.col_seq for c in hist] == [c.col_seq for c in cols]
    assert all(np.array_equal(a.bid, b.bid) and np.array_equal(a.ask, b.ask)
               for a, b in zip(hist, cols))
    assert [g.to_depth(c).final for c in hist] == [True] * len(cols)
    assert g.oldest_retained_t0_ns() == cols[0].t0_ns
    assert g.current_epoch_params().epoch == 0
    assert g.current_partial() is None  # not anchored until live on_book

    # Live continues: fresh wall-anchored t0, col_seq = last + 1 (no overlap;
    # the seq<->t0 affinity intentionally breaks across the restart gap).
    t_live = cols[-1].t0_ns + 100 * DT
    g.on_book(t_live, *book(100.0, 5.0))
    (col,) = g.on_book(t_live + DT, *book(100.0, 5.0))
    assert col.col_seq == cols[-1].col_seq + 1
    assert col.t0_ns == (t_live // DT) * DT > cols[-1].t0_ns
    # Session-cumulative accumulators continue from the tail's last bar.
    assert col.bar.cvd_cum == cols[-1].bar.cvd_cum
    assert col.bar.vwap_den_cum == cols[-1].bar.vwap_den_cum
    # prev_close carries across the restart (no-trade interval keeps o==c).
    assert col.bar.o == cols[-1].bar.c
    # history now interleaves tail + live chronologically.
    hist2 = g.history(before_t_ns=10**18, n=100)
    assert [c.col_seq for c in hist2] == [*(c.col_seq for c in cols), col.col_seq]


def test_preload_mid_sequence_tail_never_serves_unwritten_slots():
    """A tail that starts mid-sequence (limit_cols cut its head) must not make
    history()/oldest_retained dereference never-written ring slots."""
    src, cols = _driven_cols(10)
    g = Grid(CFG)
    g.preload(cols[6:], [src.epoch_params_for(0)])
    hist = g.history(before_t_ns=10**18, n=100)
    assert [c.col_seq for c in hist] == [c.col_seq for c in cols[6:]]
    assert g.oldest_retained_t0_ns() == cols[6].t0_ns


def test_preload_restores_multi_epoch_table_and_frame():
    src = Grid(CFG)
    src.on_book(0, *book(100.0, 5.0))
    cols = list(src.on_book(DT, *book(100.0, 5.0)))
    p_one = src.maybe_reanchor(mid=140.0)
    assert p_one is not None
    # Capture EVERY finalized column: a real re-anchored tail is contiguous
    # (re-anchor never skips a col_seq), which preload now requires.
    cols += src.on_book(2 * DT, *book(140.0, 5.0))
    cols += src.on_book(3 * DT, *book(140.0, 5.0))
    assert {c.epoch for c in cols} == {0, 1}
    assert [c.col_seq for c in cols] == list(
        range(cols[0].col_seq, cols[-1].col_seq + 1)
    )

    g = Grid(CFG)
    g.preload(cols, [src.epoch_params_for(0), p_one])
    assert g.current_epoch_params() is not None
    assert g.current_epoch_params().epoch == 1
    assert g.current_epoch_params().p0 == p_one.p0  # live frame = tail's frame
    assert g.epoch_params_for(0).p0 == CFG.p0  # old epoch retrievable
    # A live re-anchor continues the epoch numbering past the tail's.
    g.on_book(10 * DT, *book(140.0, 5.0))
    p_two = g.maybe_reanchor(mid=190.0)
    assert p_two is not None and p_two.epoch == 2


def test_preload_validation():
    src, cols = _driven_cols(3)
    ep0 = src.epoch_params_for(0)

    # Only valid on a virgin grid.
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    with pytest.raises(RuntimeError):
        g.preload(cols, [ep0])
    g2 = Grid(CFG)
    g2.on_trade(5, 100.0, 1.0, SIDE_BUY)  # trade-anchored counts too
    with pytest.raises(RuntimeError):
        g2.preload(cols, [ep0])

    # Every referenced epoch must be provided.
    with pytest.raises(ValueError):
        Grid(CFG).preload(cols, [])

    # Epoch params must match the grid cfg (dt/rows/tick/multiple).
    import msgspec
    bad = msgspec.structs.replace(ep0, dt_ns=CFG.dt_ns * 2)
    with pytest.raises(ValueError):
        Grid(CFG).preload(cols, [bad])

    # Strictly increasing col_seq/t0.
    with pytest.raises(ValueError):
        Grid(CFG).preload([cols[1], cols[0]], [ep0])

    # Non-contiguous (increasing but gapped) col_seq is rejected — history()
    # would otherwise dereference the unwritten slot between them. This is the
    # cross-restart hazard when a prior gap-cap skip leaves a hole; _apply_tail
    # turns this ValueError into a §8.1 cold start rather than crashing attach.
    src5, cols5 = _driven_cols(5)
    ep0b = src5.epoch_params_for(0)
    with pytest.raises(ValueError, match="contiguous"):
        Grid(CFG).preload([cols5[0], cols5[2], cols5[3]], [ep0b])

    # Row-count mismatch.
    short = FinalizedColumn(epoch=0, col_seq=99, t0_ns=99 * DT,
                            bid=np.zeros(8, np.float16), ask=np.zeros(8, np.float16),
                            bar=cols[0].bar)
    with pytest.raises(ValueError):
        Grid(CFG).preload([short], [ep0])

    # Empty tail is a no-op, grid stays virgin.
    g3 = Grid(CFG)
    g3.preload([], [ep0])
    assert g3.history(before_t_ns=10**18, n=10) == []
    assert g3.oldest_retained_t0_ns() is None
