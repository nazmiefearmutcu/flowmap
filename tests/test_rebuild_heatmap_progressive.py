"""FIND-P226-01: progressive rebuild_heatmap freeze mitigation.

Pure helpers need no display. Optional offscreen Qt path exercises
immediate vs progressive completion when PyQt6 + offscreen is available.
"""

from __future__ import annotations

import os
import unittest

# Offscreen before any Qt import (module-level heatmap_widget pull).
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("FLOWMAP_RENDERER", "cpu")

from flowmap.ui.heatmap_widget import (
    REBUILD_CHUNK_SIZE,
    REBUILD_IMMEDIATE_MAX_COLS,
    iter_rebuild_column_chunks,
    should_rebuild_immediate,
)


class TestRebuildColumnChunks(unittest.TestCase):
    def test_empty_and_nonpositive(self):
        self.assertEqual(iter_rebuild_column_chunks(0), [])
        self.assertEqual(iter_rebuild_column_chunks(-3), [])
        self.assertEqual(iter_rebuild_column_chunks(10, chunk_size=0), [])
        self.assertEqual(iter_rebuild_column_chunks(10, chunk_size=-1), [])

    def test_exact_multiples(self):
        chunks = iter_rebuild_column_chunks(192, chunk_size=96)
        self.assertEqual(chunks, [(0, 96), (96, 192)])
        self.assertEqual(sum(e - s for s, e in chunks), 192)

    def test_remainder_last_chunk(self):
        chunks = iter_rebuild_column_chunks(250, chunk_size=96)
        self.assertEqual(chunks, [(0, 96), (96, 192), (192, 250)])
        self.assertEqual(chunks[-1][1] - chunks[-1][0], 58)
        # Full coverage, no overlap
        covered = []
        for s, e in chunks:
            covered.extend(range(s, e))
        self.assertEqual(covered, list(range(250)))

    def test_default_chunk_size_in_range(self):
        self.assertGreaterEqual(REBUILD_CHUNK_SIZE, 64)
        self.assertLessEqual(REBUILD_CHUNK_SIZE, 128)
        chunks = iter_rebuild_column_chunks(500)
        self.assertTrue(all(e - s <= REBUILD_CHUNK_SIZE for s, e in chunks))
        self.assertEqual(chunks[0][0], 0)
        self.assertEqual(chunks[-1][1], 500)

    def test_single_column(self):
        self.assertEqual(iter_rebuild_column_chunks(1, chunk_size=96), [(0, 1)])

    def test_immediate_threshold(self):
        self.assertTrue(should_rebuild_immediate(0))
        self.assertTrue(should_rebuild_immediate(REBUILD_IMMEDIATE_MAX_COLS))
        self.assertTrue(should_rebuild_immediate(100))
        self.assertFalse(should_rebuild_immediate(REBUILD_IMMEDIATE_MAX_COLS + 1))
        self.assertFalse(should_rebuild_immediate(1000))


class TestProgressiveRebuildWidget(unittest.TestCase):
    """Offscreen Qt integration: progressive path completes without raise."""

    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        os.environ.setdefault("FLOWMAP_RENDERER", "cpu")
        try:
            from PyQt6.QtWidgets import QApplication
            from flowmap.ui.heatmap_widget import HeatmapWidget
            from flowmap.core import BBO, BookLevel
        except Exception as e:
            cls._skip_reason = f"Qt/Heatmap unavailable: {e}"
            cls.app = None
            cls.HeatmapWidget = None
            cls.BBO = None
            cls.BookLevel = None
            return
        cls._skip_reason = None
        cls.HeatmapWidget = HeatmapWidget
        cls.BBO = BBO
        cls.BookLevel = BookLevel
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        if self._skip_reason:
            self.skipTest(self._skip_reason)

    def _make_history_entry(self, mid: float, ts: float):
        bid = mid - 0.05
        ask = mid + 0.05
        levels = [
            self.BookLevel(price=bid, bid_size=5.0, ask_size=0.0),
            self.BookLevel(price=ask, bid_size=0.0, ask_size=4.0),
        ]
        bbo = self.BBO(timestamp=ts, symbol="T", bid=bid, ask=ask, bid_size=5.0, ask_size=4.0)
        import numpy as np
        bid_p = np.array([bid], dtype=np.float64)
        bid_v = np.array([5.0], dtype=np.float64)
        ask_p = np.array([ask], dtype=np.float64)
        ask_v = np.array([4.0], dtype=np.float64)
        return (levels, bbo, bid_p, bid_v, ask_p, ask_v, 0.0, ts)

    def _pump_until_idle(self, w, max_iters: int = 5000):
        """Drive singleShot(0) progressive continue until rebuild finishes."""
        for _ in range(max_iters):
            self.app.processEvents()
            if not w._rebuild_in_progress:
                return
        self.fail("progressive rebuild did not finish within max_iters")

    def test_immediate_path_small_history(self):
        w = self.HeatmapWidget()
        w.resize(800, 400)
        w.column_width = 1.0
        w.row_height = 4
        w.auto_follow = True
        n = 50  # well under REBUILD_IMMEDIATE_MAX_COLS
        for i in range(n):
            w._history.append(self._make_history_entry(100.0 + i * 0.01, float(i)))
        w.rebuild_heatmap()
        self.assertFalse(w._rebuild_in_progress)
        self.assertIsNone(w._rebuild_state)
        buf = w._engine.get_buffer()
        self.assertGreater(buf.shape[0], 0)
        self.assertGreater(buf.shape[1], 0)
        w.deleteLater()
        self.app.processEvents()

    def test_progressive_path_large_history_completes(self):
        w = self.HeatmapWidget()
        # Wide enough that target_bw can hold many columns
        w.resize(1200, 400)
        w.column_width = 1.0
        w.row_height = 4
        w.auto_follow = True
        # Force progressive: more columns than immediate threshold
        n = REBUILD_IMMEDIATE_MAX_COLS + 50
        for i in range(n):
            w._history.append(self._make_history_entry(100.0, float(i)))
        # target_bw may still cap slice; ensure history_slice is large
        hm_w = max(1, w.width() - w.price_axis_w)
        timeline_w = max(1, hm_w - w.right_margin_w)
        target_bw = max(1, int(timeline_w / w.column_width))
        # If viewport is narrow, shrink column_width so target_bw exceeds threshold
        if target_bw <= REBUILD_IMMEDIATE_MAX_COLS:
            w.column_width = 0.25
            target_bw = max(1, int(timeline_w / w.column_width))
        self.assertGreater(
            min(n, target_bw),
            REBUILD_IMMEDIATE_MAX_COLS,
            "fixture must yield progressive path",
        )
        w.rebuild_heatmap()
        # First chunk runs sync; remainder scheduled
        if w._rebuild_in_progress:
            self._pump_until_idle(w)
        self.assertFalse(w._rebuild_in_progress)
        self.assertIsNone(w._rebuild_state)
        buf = w._engine.get_buffer()
        self.assertEqual(buf.shape[1], target_bw)
        # Non-background pixels present after full fill
        import numpy as np
        from flowmap.engine.color_system import ColorSystem
        bg = np.array(ColorSystem.BG_COLOR, dtype=buf.dtype)
        non_bg = np.any(buf != bg, axis=-1)
        self.assertTrue(bool(np.any(non_bg)))
        w.deleteLater()
        self.app.processEvents()

    def test_coalesce_cancels_previous_generation(self):
        w = self.HeatmapWidget()
        w.resize(1200, 400)
        w.column_width = 0.25
        w.row_height = 4
        w.auto_follow = True
        n = REBUILD_IMMEDIATE_MAX_COLS + 80
        for i in range(n):
            w._history.append(self._make_history_entry(100.0, float(i)))
        w.rebuild_heatmap()
        gen1 = w._rebuild_generation
        # Second rebuild must bump generation and supersede
        w.rebuild_heatmap()
        gen2 = w._rebuild_generation
        self.assertGreater(gen2, gen1)
        self._pump_until_idle(w)
        self.assertFalse(w._rebuild_in_progress)
        self.assertEqual(w._rebuild_generation, gen2)
        w.deleteLater()
        self.app.processEvents()


if __name__ == "__main__":
    unittest.main()
