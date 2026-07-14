"""GUI tick column-paint policy (continuous timeline without 60 Hz waste)."""

from __future__ import annotations

import unittest

from flowmap.ui.main_window import decide_column_paint


class TestDecideColumnPaint(unittest.TestCase):
    def test_always_paint_on_updates(self) -> None:
        paint, idle = decide_column_paint(True, 99, idle_every=3)
        self.assertTrue(paint)
        self.assertEqual(idle, 0)

    def test_idle_throttled(self) -> None:
        paint, idle = decide_column_paint(False, 0, idle_every=3)
        self.assertFalse(paint)
        self.assertEqual(idle, 1)
        paint, idle = decide_column_paint(False, idle, idle_every=3)
        self.assertFalse(paint)
        self.assertEqual(idle, 2)
        paint, idle = decide_column_paint(False, idle, idle_every=3)
        self.assertTrue(paint)
        self.assertEqual(idle, 0)

    def test_idle_every_one_paints_each(self) -> None:
        paint, idle = decide_column_paint(False, 0, idle_every=1)
        self.assertTrue(paint)
        self.assertEqual(idle, 0)


if __name__ == "__main__":
    unittest.main()
