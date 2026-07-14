"""CVP/SVP price binning onto heatmap row grid."""

from __future__ import annotations

import os
import sys
import unittest
from types import SimpleNamespace

# Headless-friendly Qt app for QWidget subclass under test.
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PyQt6.QtWidgets import QApplication

_APP = QApplication.instance() or QApplication(sys.argv)


class TestVolumeProfileBinning(unittest.TestCase):
    def _make_overlay(self, tick: float = 0.02, levels=None):
        from flowmap.ui.overlays.volume_profile import VolumeProfileOverlay

        ov = VolumeProfileOverlay(heatmap=None)
        eng = SimpleNamespace(render_tick_size=tick)
        hm = SimpleNamespace(_engine=eng)
        ov._heatmap = hm
        if levels is None:
            levels = [SimpleNamespace(price=p) for p in (75.80, 75.82, 75.84)]
        ov._levels = levels
        return ov

    def test_bin_price_snaps_to_tick(self):
        ov = self._make_overlay(0.02)
        self.assertEqual(ov._bin_price(75.81), 75.80)
        self.assertEqual(ov._bin_price(75.819), 75.82)
        self.assertEqual(ov._bin_price(75.83), 75.84)

    def test_add_trade_bins_to_row(self):
        ov = self._make_overlay(0.02)
        ov.add_trade(75.81, 10.0)
        ov.add_trade(75.809, 5.0)
        # both snap to 75.80
        self.assertAlmostEqual(ov._svp_volumes[75.80], 15.0)
        self.assertAlmostEqual(ov._volume_on_level(ov._svp_volumes, 75.80), 15.0)
        self.assertEqual(ov._volume_on_level(ov._svp_volumes, 75.82), 0.0)

    def test_volume_on_level_rebins_legacy_keys(self):
        ov = self._make_overlay(0.02)
        # legacy unbinned keys that both snap onto 75.82 with tick=0.02
        ov._svp_volumes[75.82] = 3.0
        ov._svp_volumes[75.829] = 2.0  # → 75.82
        self.assertAlmostEqual(ov._volume_on_level(ov._svp_volumes, 75.82), 5.0)
        # 75.81 bins to 75.80, not 75.82
        ov2 = self._make_overlay(0.02)
        ov2._svp_volumes[75.81] = 4.0
        self.assertAlmostEqual(ov2._volume_on_level(ov2._svp_volumes, 75.80), 4.0)
        self.assertEqual(ov2._volume_on_level(ov2._svp_volumes, 75.82), 0.0)

    def test_bar_len_sqrt_keeps_mid_visible(self):
        from flowmap.ui.overlays.volume_profile import VolumeProfileOverlay

        # mid = 25% of max → linear would be 0.25*col; sqrt → 0.5*col
        mid = VolumeProfileOverlay._bar_len(25.0, 100.0, 100)
        full = VolumeProfileOverlay._bar_len(100.0, 100.0, 100)
        tiny = VolumeProfileOverlay._bar_len(1.0, 100.0, 100)
        self.assertEqual(full, 100)
        self.assertGreaterEqual(mid, 45)  # ~50 with sqrt
        self.assertGreaterEqual(tiny, 2)  # min_px floor
        self.assertEqual(VolumeProfileOverlay._bar_len(0.0, 100.0, 100), 0)

    def test_rebinned_collapses_keys(self):
        ov = self._make_overlay(0.02)
        raw = {75.81: 1.0, 75.809: 2.0, 75.82: 5.0}
        b = ov._rebinned(raw)
        self.assertAlmostEqual(b[75.80], 3.0)
        self.assertAlmostEqual(b[75.82], 5.0)


if __name__ == "__main__":
    unittest.main()
