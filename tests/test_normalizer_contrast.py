"""Heatmap normalizer must keep mid-book levels visible."""

from __future__ import annotations

import unittest

import numpy as np

from flowmap.engine.normalizer import AdaptiveNormalizer


class TestNormalizerContrast(unittest.TestCase):
    def test_mid_level_not_crushed(self) -> None:
        n = AdaptiveNormalizer(fixed_ref=1000.0)
        # One wall + typical mid sizes
        col = np.array([50.0, 100.0, 200.0, 500.0, 8000.0], dtype=np.float64)
        n.update(col)
        out = n.normalize(col)
        # Mid size 200 should remain clearly above noise floor
        mid = float(out[2])  # 200
        wall = float(out[-1])  # 8000
        self.assertGreater(mid, 0.15, msg=f"mid intensity too low: {mid}")
        self.assertGreater(wall, mid)
        self.assertLessEqual(wall, 1.0)

    def test_gamma_soft(self) -> None:
        self.assertLess(AdaptiveNormalizer.GAMMA, 1.0)
        self.assertGreater(AdaptiveNormalizer.GAMMA, 0.3)

    def test_zeros_stay_zero(self) -> None:
        n = AdaptiveNormalizer(fixed_ref=100.0)
        out = n.normalize(np.array([0.0, 50.0, 100.0]))
        self.assertEqual(float(out[0]), 0.0)


if __name__ == "__main__":
    unittest.main()
