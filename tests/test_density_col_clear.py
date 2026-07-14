"""Regression: col_idx path clears column to BG before paint (FIND-P208-01).

Historical / drag fill uses push_snapshot(..., col_idx=N). Without clearing
the column first, rows that had density on a prior paint and are empty on the
next paint leave ghost pixels.
"""

from __future__ import annotations

import unittest

import numpy as np

from flowmap.core import BBO, BookLevel
from flowmap.engine.color_system import ColorSystem
from flowmap.engine.density_engine import DensityEngine


def _row_for_price(engine: DensityEngine, price: float) -> int:
    buf_h = engine._buffer.shape[0]
    ticks = int(round(price / engine.render_tick_size))
    return (buf_h // 2) - (ticks - engine.center_price_ticks)


class TestDensityColIdxClear(unittest.TestCase):
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

    def test_col_idx_repaint_does_not_ghost_vanished_level(self):
        e = self._make_engine()
        bbo = BBO(0.0, "T", 99.95, 100.05, 1.0, 1.0)
        # Wall away from BBO rows so BBO tick paint cannot mask the ghost check
        wall_price = 99.5
        col = 5

        levels_with_wall = [
            BookLevel(price=wall_price, bid_size=5000.0, ask_size=0.0),
            BookLevel(price=99.9, bid_size=100.0, ask_size=0.0),
            BookLevel(price=100.1, bid_size=0.0, ask_size=100.0),
        ]
        # Live push establishes center_price_ticks
        e.push_snapshot(levels_with_wall, bbo, auto_follow=True, vis_rows=40)

        # Paint historical column with the wall
        e.push_snapshot(
            levels_with_wall,
            bbo,
            auto_follow=False,
            vis_rows=40,
            col_idx=col,
            detect_tick_size=False,
        )
        row = _row_for_price(e, wall_price)
        self.assertGreaterEqual(row, 0)
        self.assertLess(row, e._buffer.shape[0])
        bg = np.asarray(ColorSystem.BG_COLOR, dtype=np.uint8)
        painted = e._buffer[row, col, :]
        self.assertFalse(
            np.array_equal(painted, bg),
            f"first col_idx paint should show wall, got BG pixel={painted.tolist()}",
        )

        # Same col_idx, wall gone — only normal TOB levels
        levels_no_wall = [
            BookLevel(price=99.9, bid_size=100.0, ask_size=0.0),
            BookLevel(price=100.1, bid_size=0.0, ask_size=100.0),
        ]
        e.push_snapshot(
            levels_no_wall,
            bbo,
            auto_follow=False,
            vis_rows=40,
            col_idx=col,
            detect_tick_size=False,
        )
        after = e._buffer[row, col, :]
        self.assertTrue(
            np.array_equal(after, bg),
            f"old density must not ghost: expected BG, got {after.tolist()} at row={row} col={col}",
        )

    def test_col_idx_clear_matches_live_edge_bg(self):
        """Cleared empty rows use the same BG as live right-edge clear."""
        e = self._make_engine()
        bbo = BBO(0.0, "T", 99.95, 100.05, 1.0, 1.0)
        levels = [
            BookLevel(price=99.9, bid_size=1000.0, ask_size=0.0),
            BookLevel(price=100.1, bid_size=0.0, ask_size=1000.0),
        ]
        e.push_snapshot(levels, bbo, auto_follow=True, vis_rows=40)
        bg = np.asarray(ColorSystem.BG_COLOR, dtype=np.uint8)
        col = 3
        e.push_snapshot(
            levels,
            bbo,
            auto_follow=False,
            vis_rows=40,
            col_idx=col,
            detect_tick_size=False,
        )
        # A row far from mid with no liquidity must be BG after col_idx paint
        far_price = 98.0
        far_row = _row_for_price(e, far_price)
        self.assertGreaterEqual(far_row, 0)
        self.assertLess(far_row, e._buffer.shape[0])
        self.assertTrue(
            np.array_equal(e._buffer[far_row, col, :], bg),
            "empty row after col_idx paint must equal ColorSystem.BG_COLOR",
        )


if __name__ == "__main__":
    unittest.main()
