"""Regression tests for order-book correctness fixes (Phase-4).

Covers:
- NaN-free CVD / get_volume_delta (FIND-P206-01)
- absorb default off (FIND-P201-01)
- zero-size BBO does not insert empty levels (FIND-P202-02)
- crossed book keeps one side (FIND-P202-01 iterative uncross)
- snapshot resets max bid/ask size peaks (FIND-P201-02)
- NaN/Inf prices rejected at mutator entry (FIND-P202-05)
"""

from __future__ import annotations

import math
import unittest

from flowmap.core import BBO, Level2Snapshot, Level2Update, Side, Trade
from flowmap.core.order_book import OrderBook


class TestVolumeDeltaNoNaN(unittest.TestCase):
    def test_empty_book_cvd_is_zero_not_nan(self):
        ob = OrderBook(symbol="TEST")
        cvd = ob.get_volume_delta()
        self.assertEqual(cvd, 0.0)
        self.assertFalse(math.isnan(cvd))
        # Status-bar style format must not produce "nan"
        self.assertNotIn("nan", f"CVD: {cvd:+.0f}".lower())

    def test_after_trades_and_reset(self):
        ob = OrderBook(symbol="TEST")
        ob.record_trade(Trade(1.0, "TEST", 100.0, 2.0, Side.BUY))
        ob.record_trade(Trade(2.0, "TEST", 100.0, 3.0, Side.SELL))
        self.assertEqual(ob.get_volume_delta(), -1.0)
        ob.reset()
        cvd = ob.get_volume_delta()
        self.assertEqual(cvd, 0.0)
        self.assertFalse(math.isnan(cvd))


class TestAbsorbDefaultOff(unittest.TestCase):
    def test_record_trade_does_not_absorb_by_default(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=1.0,
                symbol="TEST",
                bids=((99.0, 10.0),),
                asks=((101.0, 10.0),),
            )
        )
        # Aggressive buy hits the ask at 101
        ob.record_trade(Trade(2.0, "TEST", 101.0, 3.0, Side.BUY))
        self.assertEqual(ob._asks[101.0], 10.0)  # unchanged without absorb
        self.assertEqual(ob.total_buy_volume, 3.0)

    def test_absorb_true_subtracts_size(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=1.0,
                symbol="TEST",
                bids=((99.0, 10.0),),
                asks=((101.0, 10.0),),
            )
        )
        ob.record_trade(Trade(2.0, "TEST", 101.0, 3.0, Side.BUY), absorb=True)
        self.assertEqual(ob._asks[101.0], 7.0)


class TestZeroSizeBBO(unittest.TestCase):
    def test_zero_size_quote_does_not_insert_empty_level(self):
        ob = OrderBook(symbol="TEST")
        # Seed a real book so BBO fields can update
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=1.0,
                symbol="TEST",
                bids=((100.0, 5.0), (99.0, 2.0)),
                asks=((101.0, 5.0), (102.0, 2.0)),
            )
        )
        bbo = BBO(
            timestamp=2.0,
            symbol="TEST",
            bid=100.5,
            ask=101.5,
            bid_size=0.0,
            ask_size=0.0,
        )
        ob.apply_bbo(bbo)
        # Zero-size TOB must not become empty dict entries
        if 100.5 in ob._bids:
            self.assertGreater(ob._bids[100.5], 0.0)
        if 101.5 in ob._asks:
            self.assertGreater(ob._asks[101.5], 0.0)
        # Book still has positive sizes from the snapshot residual
        self.assertTrue(any(s > 0 for s in ob._bids.values()) or len(ob._bids) == 0)
        self.assertTrue(all(s > 0 for s in ob._bids.values()))
        self.assertTrue(all(s > 0 for s in ob._asks.values()))


class TestCrossedBookKeepsOneSide(unittest.TestCase):
    def test_tob_cross_does_not_wipe_both_sides(self):
        ob = OrderBook(symbol="TEST")
        # Fully crossed: best bid > best ask
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=1.0,
                symbol="TEST",
                bids=((100.0, 1.0),),
                asks=((99.0, 1.0),),
            )
        )
        # Iterative uncross: at least one side survives (not dual-wipe)
        surviving = len(ob._bids) + len(ob._asks)
        self.assertGreater(surviving, 0, "crossed book dual-prune wiped both sides")
        # If both remain, book must not still be crossed at BBO
        if ob._best_bid > 0 and ob._best_ask > 0:
            self.assertLess(ob._best_bid, ob._best_ask)

    def test_locked_book_uncross(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=1.0,
                symbol="TEST",
                bids=((100.0, 1.0),),
                asks=((100.0, 1.0),),
            )
        )
        surviving = len(ob._bids) + len(ob._asks)
        self.assertGreater(surviving, 0)
        if ob._best_bid > 0 and ob._best_ask > 0:
            self.assertLess(ob._best_bid, ob._best_ask)


class TestSnapshotResetsMaxSize(unittest.TestCase):
    """FIND-P201-02: apply_snapshot must recompute max sizes from new levels."""

    def test_snapshot_with_smaller_sizes_resets_max(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=1.0,
                symbol="TEST",
                bids=((99.0, 100.0),),
                asks=((101.0, 50.0),),
            )
        )
        self.assertEqual(ob._max_bid_size, 100.0)
        self.assertEqual(ob._max_ask_size, 50.0)

        # Smaller book replaces previous peaks
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=2.0,
                symbol="TEST",
                bids=((99.0, 1.0), (98.0, 3.0)),
                asks=((101.0, 2.0), (102.0, 4.0)),
            )
        )
        self.assertEqual(ob._max_bid_size, 3.0)
        self.assertEqual(ob._max_ask_size, 4.0)
        # Normalization via get_levels must also reflect new peaks
        levels = {lv.price: lv for lv in ob.get_levels()}
        self.assertEqual(levels[99.0].max_size, 3.0)
        self.assertEqual(levels[101.0].max_size, 4.0)

    def test_empty_snapshot_zeros_max(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=1.0,
                symbol="TEST",
                bids=((99.0, 10.0),),
                asks=((101.0, 10.0),),
            )
        )
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=2.0,
                symbol="TEST",
                bids=(),
                asks=(),
            )
        )
        self.assertEqual(ob._max_bid_size, 0.0)
        self.assertEqual(ob._max_ask_size, 0.0)


class TestNaNPriceGuard(unittest.TestCase):
    """FIND-P202-05: NaN/Inf prices must not enter the book."""

    def test_nan_price_in_update_is_ignored(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=1.0,
                symbol="TEST",
                bids=((99.0, 1.0),),
                asks=((101.0, 1.0),),
            )
        )
        before_bids = dict(ob._bids)
        before_asks = dict(ob._asks)
        ob.apply_update(
            Level2Update(
                timestamp=2.0,
                symbol="TEST",
                side=Side.BID,
                price=float("nan"),
                size=5.0,
            )
        )
        self.assertEqual(dict(ob._bids), before_bids)
        self.assertFalse(
            any(isinstance(k, float) and math.isnan(k) for k in ob._bids.keys())
        )
        self.assertEqual(dict(ob._asks), before_asks)

    def test_inf_price_in_update_is_ignored(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=1.0,
                symbol="TEST",
                bids=((99.0, 1.0),),
                asks=((101.0, 1.0),),
            )
        )
        ob.apply_update(
            Level2Update(
                timestamp=2.0,
                symbol="TEST",
                side=Side.ASK,
                price=float("inf"),
                size=5.0,
            )
        )
        self.assertNotIn(float("inf"), ob._asks)
        self.assertFalse(any(not math.isfinite(k) for k in ob._asks.keys()))

    def test_nan_price_in_snapshot_is_ignored(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=1.0,
                symbol="TEST",
                bids=((99.0, 2.0), (float("nan"), 9.0)),
                asks=((101.0, 3.0), (float("inf"), 8.0)),
            )
        )
        self.assertIn(99.0, ob._bids)
        self.assertEqual(ob._bids[99.0], 2.0)
        self.assertFalse(
            any(isinstance(k, float) and not math.isfinite(k) for k in ob._bids.keys())
        )
        self.assertIn(101.0, ob._asks)
        self.assertEqual(ob._asks[101.0], 3.0)
        self.assertFalse(
            any(isinstance(k, float) and not math.isfinite(k) for k in ob._asks.keys())
        )
        self.assertEqual(ob._max_bid_size, 2.0)
        self.assertEqual(ob._max_ask_size, 3.0)

    def test_nan_price_in_batch_updates_is_ignored(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=1.0,
                symbol="TEST",
                bids=((99.0, 1.0),),
                asks=((101.0, 1.0),),
            )
        )
        ob.apply_updates(
            [
                Level2Update(2.0, "TEST", Side.BID, float("nan"), 5.0),
                Level2Update(2.0, "TEST", Side.BID, 98.0, 4.0),
                Level2Update(2.0, "TEST", Side.ASK, float("-inf"), 7.0),
            ]
        )
        self.assertEqual(ob._bids.get(98.0), 4.0)
        self.assertFalse(any(not math.isfinite(k) for k in ob._bids.keys()))
        self.assertFalse(any(not math.isfinite(k) for k in ob._asks.keys()))

    def test_nan_inf_bbo_prices_are_ignored(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=1.0,
                symbol="TEST",
                bids=((99.0, 1.0),),
                asks=((101.0, 1.0),),
            )
        )
        before_bids = dict(ob._bids)
        before_asks = dict(ob._asks)
        # NaN bid / Inf ask must not insert or corrupt BBO book levels
        ob.apply_bbo(
            BBO(
                timestamp=2.0,
                symbol="TEST",
                bid=float("nan"),
                ask=float("inf"),
                bid_size=5.0,
                ask_size=5.0,
            )
        )
        self.assertFalse(any(not math.isfinite(k) for k in ob._bids.keys()))
        self.assertFalse(any(not math.isfinite(k) for k in ob._asks.keys()))
        # Finite residual levels from snapshot still present
        self.assertEqual(dict(ob._bids), before_bids)
        self.assertEqual(dict(ob._asks), before_asks)


class TestUnknownSideCVD(unittest.TestCase):
    """FIND-NUM-05 / FIND-P203-03: unknown aggressor side is CVD-neutral."""

    def test_unknown_side_does_not_change_buy_or_sell_totals(self):
        ob = OrderBook(symbol="TEST")
        ob.record_trade(Trade(1.0, "TEST", 100.0, 5.0, Side.UNKNOWN))
        self.assertEqual(ob.total_volume, 5.0)
        self.assertEqual(ob.total_buy_volume, 0.0)
        self.assertEqual(ob.total_sell_volume, 0.0)
        self.assertEqual(ob.get_volume_delta(), 0.0)
        self.assertEqual(ob.trade_count, 1)

    def test_unknown_side_between_known_trades_is_neutral(self):
        ob = OrderBook(symbol="TEST")
        ob.record_trade(Trade(1.0, "TEST", 100.0, 2.0, Side.BUY))
        ob.record_trade(Trade(2.0, "TEST", 100.0, 7.0, Side.UNKNOWN))
        ob.record_trade(Trade(3.0, "TEST", 100.0, 3.0, Side.SELL))
        self.assertEqual(ob.total_volume, 12.0)
        self.assertEqual(ob.total_buy_volume, 2.0)
        self.assertEqual(ob.total_sell_volume, 3.0)
        self.assertEqual(ob.get_volume_delta(), -1.0)

    def test_is_buy_and_sell_side_false_for_unknown(self):
        from flowmap.core import is_buy_side, is_sell_side

        self.assertFalse(is_buy_side(Side.UNKNOWN))
        self.assertFalse(is_sell_side(Side.UNKNOWN))
        self.assertFalse(is_buy_side(None))
        self.assertFalse(is_sell_side(None))

    def test_unknown_side_absorb_does_not_hit_book(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_snapshot(
            Level2Snapshot(
                timestamp=1.0,
                symbol="TEST",
                bids=((99.0, 10.0),),
                asks=((101.0, 10.0),),
            )
        )
        ob.record_trade(Trade(2.0, "TEST", 101.0, 3.0, Side.UNKNOWN), absorb=True)
        self.assertEqual(ob._asks[101.0], 10.0)
        self.assertEqual(ob._bids[99.0], 10.0)


class TestL2SideMapping(unittest.TestCase):
    """FIND-P203-04: L2 BUY→bids (BID), SELL→asks (ASK)."""

    def test_l2_buy_maps_to_bids(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_update(Level2Update(1.0, "TEST", Side.BUY, 100.0, 1.5))
        self.assertEqual(ob._bids.get(100.0), 1.5)
        self.assertNotIn(100.0, ob._asks)

    def test_l2_sell_maps_to_asks(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_update(Level2Update(1.0, "TEST", Side.SELL, 101.0, 2.0))
        self.assertEqual(ob._asks.get(101.0), 2.0)
        self.assertNotIn(101.0, ob._bids)

    def test_l2_bid_ask_unchanged(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_updates(
            [
                Level2Update(1.0, "TEST", Side.BID, 99.0, 3.0),
                Level2Update(1.0, "TEST", Side.ASK, 102.0, 4.0),
            ]
        )
        self.assertEqual(ob._bids.get(99.0), 3.0)
        self.assertEqual(ob._asks.get(102.0), 4.0)

    def test_l2_unknown_side_skipped(self):
        ob = OrderBook(symbol="TEST")
        ob.apply_update(Level2Update(1.0, "TEST", Side.UNKNOWN, 100.0, 9.0))
        self.assertEqual(len(ob._bids), 0)
        self.assertEqual(len(ob._asks), 0)

    def test_l2_book_side_helper(self):
        from flowmap.core import l2_book_side

        self.assertEqual(l2_book_side(Side.BUY), Side.BID)
        self.assertEqual(l2_book_side(Side.SELL), Side.ASK)
        self.assertEqual(l2_book_side(Side.BID), Side.BID)
        self.assertEqual(l2_book_side(Side.ASK), Side.ASK)
        self.assertIsNone(l2_book_side(Side.UNKNOWN))
        self.assertIsNone(l2_book_side(None))


class TestTradeSideConversion(unittest.TestCase):
    """Producer maps: empty/unknown → Side.UNKNOWN (not silent BUY)."""

    def test_crypcodile_unknown_side(self):
        from flowmap.data.crypcodile_replay import _get_flowmap_side

        self.assertEqual(_get_flowmap_side(None), Side.UNKNOWN)
        self.assertEqual(_get_flowmap_side(""), Side.UNKNOWN)
        self.assertEqual(_get_flowmap_side("  "), Side.UNKNOWN)
        self.assertEqual(_get_flowmap_side("garbage"), Side.UNKNOWN)
        self.assertEqual(_get_flowmap_side("buy"), Side.BUY)
        self.assertEqual(_get_flowmap_side("SELL"), Side.SELL)
        self.assertEqual(_get_flowmap_side("bid"), Side.BID)
        self.assertEqual(_get_flowmap_side("ask"), Side.ASK)

    def test_ccxt_unknown_side(self):
        from flowmap.data.crypto import _side_from_ccxt, _trades_from_ccxt

        self.assertEqual(_side_from_ccxt(None), Side.UNKNOWN)
        self.assertEqual(_side_from_ccxt(""), Side.UNKNOWN)
        self.assertEqual(_side_from_ccxt("mystery"), Side.UNKNOWN)
        self.assertEqual(_side_from_ccxt("buy"), Side.BUY)
        self.assertEqual(_side_from_ccxt("sell"), Side.SELL)

        trades = _trades_from_ccxt(
            [
                {"timestamp": 1_700_000_000_000, "price": 1.0, "amount": 2.0},
                {
                    "timestamp": 1_700_000_000_000,
                    "price": 1.0,
                    "amount": 3.0,
                    "side": "sell",
                },
            ],
            "BTC/USDT",
        )
        self.assertEqual(trades[0].side, Side.UNKNOWN)
        self.assertEqual(trades[1].side, Side.SELL)


if __name__ == "__main__":
    unittest.main()
