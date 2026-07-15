"""Unit tests for live channel parity (FIND-P217-07).

Covers:
- LIVE_CHANNELS / CHANNELS include book_ticker and liquidation
- Core channels (trade, book_snapshot, book_delta) remain present
- _dispatch_record maps book_ticker → BBO and liquidation → Trade(is_liquidation)
"""

from __future__ import annotations

import types
import unittest

from flowmap.core import BBO, Trade
from flowmap.data.crypcodile_live import CHANNELS, LIVE_CHANNELS
from flowmap.data.crypcodile_replay import (
    _cryp_book_ticker_to_flowmap,
    _cryp_liquidation_to_flowmap,
    _dispatch_record,
)


class TestLiveChannels(unittest.TestCase):
    def test_channels_alias_matches_live_channels(self):
        self.assertIs(CHANNELS, LIVE_CHANNELS)

    def test_includes_book_ticker_and_liquidation(self):
        self.assertIn("book_ticker", LIVE_CHANNELS)
        self.assertIn("liquidation", LIVE_CHANNELS)

    def test_includes_core_book_and_trade_channels(self):
        for name in ("trade", "book_snapshot", "book_delta"):
            self.assertIn(name, LIVE_CHANNELS, msg=name)

    def test_is_tuple_of_strings(self):
        self.assertIsInstance(LIVE_CHANNELS, tuple)
        self.assertTrue(all(isinstance(c, str) for c in LIVE_CHANNELS))
        self.assertEqual(len(LIVE_CHANNELS), len(set(LIVE_CHANNELS)))


class TestLiveChannelConverters(unittest.TestCase):
    """Smoke: book_ticker / liquidation converters used by live _on_record."""

    def _fake_record(self, tag: str, **fields):
        rec = types.SimpleNamespace(**fields)
        rec.__struct_config__ = types.SimpleNamespace(tag=tag)
        return rec

    def test_book_ticker_dispatch_yields_bbo(self):
        rec = self._fake_record(
            "book_ticker",
            local_ts=1_700_000_000_000_000_000,
            symbol="BTCUSDT",
            bid_px=100.0,
            ask_px=100.5,
            bid_sz=1.5,
            ask_sz=2.0,
        )
        objs = _dispatch_record(rec)
        self.assertEqual(len(objs), 1)
        self.assertIsInstance(objs[0], BBO)
        self.assertEqual(objs[0].bid, 100.0)
        self.assertEqual(objs[0].ask, 100.5)

    def test_liquidation_dispatch_yields_trade_flagged(self):
        from flowmap.core import Side

        rec = self._fake_record(
            "liquidation",
            local_ts=1_700_000_000_000_000_000,
            symbol="BTCUSDT",
            price=50_000.0,
            amount=0.25,
            side="sell",
            id="liq-1",
        )
        objs = _dispatch_record(rec)
        self.assertEqual(len(objs), 1)
        self.assertIsInstance(objs[0], Trade)
        self.assertTrue(objs[0].is_liquidation)
        self.assertEqual(objs[0].price, 50_000.0)
        self.assertEqual(objs[0].size, 0.25)
        self.assertEqual(objs[0].side, Side.SELL)

    def test_pure_helpers_exportable(self):
        self.assertTrue(callable(_cryp_book_ticker_to_flowmap))
        self.assertTrue(callable(_cryp_liquidation_to_flowmap))


if __name__ == "__main__":
    unittest.main()
