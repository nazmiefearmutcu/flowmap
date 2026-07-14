"""Regression: density coloring uses side-of-book sizes, not mid half-plane.

FIND-P207-01 — old mid-mask dropped bid liquidity above mid and ask liquidity
below mid. Coloring now follows bid_arr / ask_arr (max-side on overlap).
"""

from __future__ import annotations

import unittest

import numpy as np

from flowmap.core import BBO, BookLevel
from flowmap.engine.density_engine import DensityEngine
from flowmap.engine.color_system import ColorSystem


def _row_for_price(engine: DensityEngine, price: float) -> int:
    buf_h = engine._buffer.shape[0]
    ticks = int(round(price / engine.render_tick_size))
    return (buf_h // 2) - (ticks - engine.center_price_ticks)


class TestDensityNoMidMask(unittest.TestCase):
    def _make_engine(self) -> DensityEngine:
        e = DensityEngine(history_width=32, max_levels=50, decay=0.92)
        e.tick_size = 0.1
        e._tick_size_detected = True
        e.ticks_per_row = 1
        e.vertical_smoothing = 0.0
        e.centering_mode = "immediate"
        e.min_order_size = 0.0
        e.resize(40, 32)
        return e

    def test_bid_above_mid_paints_bid_color(self):
        e = self._make_engine()
        # Bid wall ABOVE mid (crossed residual / stale) must still paint green
        levels = [
            BookLevel(price=100.2, bid_size=5000.0, ask_size=0.0),
            BookLevel(price=99.8, bid_size=100.0, ask_size=0.0),
            BookLevel(price=100.1, bid_size=0.0, ask_size=100.0),
        ]
        bbo = BBO(0.0, "T", 99.95, 100.05, 1.0, 1.0)
        e.push_snapshot(levels, bbo, auto_follow=True, vis_rows=40)

        row = _row_for_price(e, 100.2)
        self.assertGreaterEqual(row, 0)
        self.assertLess(row, e._buffer.shape[0])
        pixel = e._buffer[row, -1, :]
        bg = np.asarray(ColorSystem.BG_COLOR, dtype=np.uint8)
        self.assertFalse(
            np.array_equal(pixel, bg),
            f"bid above mid should paint, got BG pixel={pixel.tolist()}",
        )
        # Bid LUT is green-dominant (G > R)
        self.assertGreater(int(pixel[1]), int(pixel[0]))

    def test_ask_below_mid_paints_ask_color(self):
        e = self._make_engine()
        levels = [
            BookLevel(price=99.8, bid_size=0.0, ask_size=5000.0),  # ask below mid
            BookLevel(price=100.2, bid_size=0.0, ask_size=100.0),
            BookLevel(price=99.9, bid_size=100.0, ask_size=0.0),
        ]
        bbo = BBO(0.0, "T", 99.95, 100.05, 1.0, 1.0)
        e.push_snapshot(levels, bbo, auto_follow=True, vis_rows=40)

        row = _row_for_price(e, 99.8)
        self.assertGreaterEqual(row, 0)
        self.assertLess(row, e._buffer.shape[0])
        pixel = e._buffer[row, -1, :]
        bg = np.asarray(ColorSystem.BG_COLOR, dtype=np.uint8)
        self.assertFalse(
            np.array_equal(pixel, bg),
            f"ask below mid should paint, got BG pixel={pixel.tolist()}",
        )
        # Ask LUT is red-dominant (R > G)
        self.assertGreater(int(pixel[0]), int(pixel[1]))

    def test_normal_side_planes_still_paint(self):
        e = self._make_engine()
        levels = [
            BookLevel(price=99.9, bid_size=1000.0, ask_size=0.0),
            BookLevel(price=100.1, bid_size=0.0, ask_size=1000.0),
        ]
        bbo = BBO(0.0, "T", 99.95, 100.05, 1.0, 1.0)
        e.push_snapshot(levels, bbo, auto_follow=True, vis_rows=40)

        bid_px = e._buffer[_row_for_price(e, 99.9), -1, :]
        ask_px = e._buffer[_row_for_price(e, 100.1), -1, :]
        self.assertGreater(int(bid_px[1]), int(bid_px[0]))
        self.assertGreater(int(ask_px[0]), int(ask_px[1]))


if __name__ == "__main__":
    unittest.main()
