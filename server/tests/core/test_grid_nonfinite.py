"""Non-finite trade-price hardening (A2-1).

A ``+inf`` price used to slip past the malformed-trade guard (``price > 0`` is
true for inf) and poison the session-cumulative ``vwap_num_cum`` — and every
later recorded bar with it — permanently. NaN/−inf were already rejected; the
guard now rejects every non-finite price explicitly. Huge-but-FINITE prices
must still be accepted (they are venue truth).
"""

import math

import numpy as np

from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.proto.events import SIDE_BUY, SIDE_SELL

CFG = GridCfg(tick=0.5, tick_multiple=1, dt_ns=1_000_000_000, p0=90.0, rows=64,
              ring_columns=128, mode=0)


def book(mid, sz):  # same 3-level symmetric helper as test_grid.py
    px = np.array([mid - 1.0, mid - 0.5, mid], dtype=np.float64)
    return (px, np.full(3, sz), px + 0.5, np.full(3, sz))


def _finalize(g, at_ts_ns: int):
    """Close the current interval with a boundary book; return its bar."""
    cols = g.on_book(at_ts_ns, *book(100.0, 5.0))
    assert len(cols) == 1
    return cols[0].bar


def test_on_trade_rejects_non_finite_prices():
    """+inf, NaN and -inf prices are refused like any other malformed print."""
    for bad_price in (float("inf"), float("nan"), float("-inf")):
        g = Grid(CFG)
        g.on_book(0, *book(100.0, 5.0))
        # One GOOD print paints the bar's OHLC; the bad print must contribute
        # nothing to OHLC, volume, cvd or the vwap sums.
        g.on_trade(400_000_000, 100.0, 1.0, SIDE_BUY)
        g.on_trade(500_000_000, bad_price, 2.0, SIDE_BUY)
        bar = _finalize(g, 1_000_000_000)
        # A leaked +inf would show up here first: vwap_num_cum stays inf
        # forever after, and OHLC would carry the non-finite price.
        assert (bar.o, bar.h, bar.l, bar.c) == (100.0, 100.0, 100.0, 100.0)
        assert bar.vwap_num_cum == 100.0 and bar.vwap_den_cum == 1.0
        assert bar.vol_buy == 1.0 and bar.cvd_cum == 1.0


def test_non_finite_price_does_not_poison_later_bars():
    """The session-cumulative sums stay clean into the NEXT interval — the
    old +inf leak permanently poisoned vwap_num_cum from the bad print on."""
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    g.on_trade(500_000_000, float("inf"), 2.0, SIDE_BUY)
    bar = _finalize(g, 1_000_000_000)
    assert math.isfinite(bar.vwap_num_cum)
    g.on_trade(1_500_000_000, 101.0, 3.0, SIDE_SELL)
    bar2 = _finalize(g, 2_000_000_000)
    assert bar2.cvd_cum == -3.0
    assert bar2.vwap_den_cum == 3.0
    assert math.isfinite(bar2.vwap_num_cum)
    assert bar2.vwap_num_cum == 101.0 * 3.0


def test_non_finite_price_trade_does_not_anchor_time():
    """Same refusal path as the existing malformed prints: not even the
    interval clock may be anchored by a poisoned print."""
    g = Grid(CFG)
    g.on_trade(500_000_000, float("inf"), 1.0, SIDE_BUY)
    assert g.current_partial() is None  # time never anchored
    g.on_trade(500_000_000, 100.0, 2.0, SIDE_BUY)
    p = g.current_partial()
    assert p is not None and p.t0_ns == 0  # a good print anchors normally


def test_huge_but_finite_price_is_kept():
    """Finite venue truth — however large — must not be refused: only true
    non-finites (NaN/±inf) are malformed."""
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    huge = 1e300
    g.on_trade(500_000_000, huge, 2.0, SIDE_BUY)
    g.on_trade(600_000_000, huge, 1.0, SIDE_SELL)
    bar = _finalize(g, 1_000_000_000)
    assert bar.o == huge and bar.h == huge and bar.l == huge and bar.c == huge
    assert bar.vol_buy == 2.0 and bar.vol_sell == 1.0
    assert bar.vwap_den_cum == 3.0
    assert math.isfinite(bar.vwap_num_cum)
    assert bar.vwap_num_cum == huge * 3.0
