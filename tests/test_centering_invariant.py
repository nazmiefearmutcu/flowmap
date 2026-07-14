"""Hard centering invariant under auto_follow (FIND-HIST-01/02/03/05).

When auto_follow=True, mid must stay within ± deadband_pct * vis_rows of
center (≈ 15–85% of the visible band). ticks_per_row changes must rescale
center so mid remains mapped to approximately the same row.
"""

from __future__ import annotations

import unittest

from flowmap.core import BBO, BookLevel
from flowmap.engine.config import EngineConfig
from flowmap.engine.density_engine import DensityEngine


def _levels_around(mid: float, tick: float = 0.01) -> list[BookLevel]:
    return [
        BookLevel(price=mid - tick, bid_size=100.0, ask_size=0.0),
        BookLevel(price=mid + tick, bid_size=0.0, ask_size=100.0),
    ]


def _bbo(mid: float, tick: float = 0.01, t: float = 0.0) -> BBO:
    half = tick / 2.0
    return BBO(t, "TEST", mid - half, mid + half, 1.0, 1.0)


class TestCenteringHardInvariant(unittest.TestCase):
    def _make_engine(
        self,
        *,
        vis_rows: int = 100,
        history_width: int = 64,
        tick_size: float = 0.01,
        ticks_per_row: int = 1,
        centering_mode: str = "smooth_deadband",
        deadband_pct: float = 0.35,
        ema_alpha: float = 0.05,
    ) -> DensityEngine:
        cfg = EngineConfig(
            history_width=history_width,
            centering_mode=centering_mode,
            centering_deadband_pct=deadband_pct,
            centering_ema_alpha=ema_alpha,
            ticks_per_row=ticks_per_row,
        )
        e = DensityEngine(config=cfg)
        e.tick_size = tick_size
        e._tick_size_detected = True
        e.vertical_smoothing = 0.0
        e.resize(vis_rows * 5, history_width)  # buf taller than vis band
        return e

    def test_smooth_deadband_hard_snaps_when_mid_drifts_past_deadband(self):
        """Drift mid far past 0.35*vis_rows → center hard-snaps to mid."""
        vis_rows = 100
        deadband_pct = 0.35
        e = self._make_engine(vis_rows=vis_rows, deadband_pct=deadband_pct)
        mid0 = 100.0
        e.push_snapshot(
            _levels_around(mid0), _bbo(mid0), auto_follow=True, vis_rows=vis_rows
        )
        self.assertIsNotNone(e.center_price_ticks)
        center0 = e.center_price_ticks

        # Jump mid by >> deadband rows in render-tick space (tpr=1, tick=0.01).
        # deadband = 0.35 * 100 = 35 rows → 35 * 0.01 = $0.35; jump $2.00.
        mid1 = mid0 + 2.0
        e.push_snapshot(
            _levels_around(mid1), _bbo(mid1, t=1.0), auto_follow=True, vis_rows=vis_rows
        )

        mid_ticks = mid1 / e.render_tick_size
        max_lag = max(1, int(deadband_pct * vis_rows))
        dist = abs(mid_ticks - e.center_price_ticks)
        self.assertLessEqual(
            dist,
            max_lag,
            f"mid must stay within {max_lag} render rows of center; "
            f"dist={dist}, center={e.center_price_ticks}, mid_ticks={mid_ticks}",
        )
        # Hard snap should land near mid, not leave center at seed.
        self.assertNotEqual(e.center_price_ticks, center0)
        self.assertAlmostEqual(e.center_price_ticks, round(mid_ticks), delta=1)

    def test_ema_mode_also_respects_hard_band(self):
        """Slow EMA cannot leave mid outside ±0.35*vis (post-EMA hard snap)."""
        vis_rows = 100
        deadband_pct = 0.35
        e = self._make_engine(
            vis_rows=vis_rows,
            centering_mode="ema",
            deadband_pct=deadband_pct,
            ema_alpha=0.02,
        )
        mid0 = 50000.0
        e.push_snapshot(
            _levels_around(mid0), _bbo(mid0), auto_follow=True, vis_rows=vis_rows
        )

        # 40 render rows: past deadband (35) but under half-viewport (50).
        # Old EMA would lag; hard invariant must snap.
        mid1 = mid0 + 0.40  # tick=0.01 → 40 render ticks
        e.push_snapshot(
            _levels_around(mid1), _bbo(mid1, t=1.0), auto_follow=True, vis_rows=vis_rows
        )

        mid_ticks = mid1 / e.render_tick_size
        max_lag = max(1, int(deadband_pct * vis_rows))
        self.assertLessEqual(abs(mid_ticks - e.center_price_ticks), max_lag)
        self.assertAlmostEqual(e.center_price_ticks, round(mid_ticks), delta=1)

    def test_btc_style_tpr_deadband_not_tens_of_dollars_off_screen(self):
        """BTC tpr=100: jump past 0.35*vis ($~49) hard-snaps (was half-viewport/EMA lag)."""
        vis_rows = 139
        tick = 0.01
        tpr = 100  # render_tick_size = $1 per row
        e = self._make_engine(
            vis_rows=vis_rows,
            tick_size=tick,
            ticks_per_row=tpr,
            centering_mode="smooth_deadband",
        )
        mid0 = 65656.0
        e.push_snapshot(
            _levels_around(mid0, tick),
            _bbo(mid0, tick),
            auto_follow=True,
            vis_rows=vis_rows,
        )

        # $55 jump: deadband ≈ 48 rows; old half-snap was 69 — this sat in EMA lag.
        mid1 = mid0 + 55.0
        e.push_snapshot(
            _levels_around(mid1, tick),
            _bbo(mid1, tick, t=1.0),
            auto_follow=True,
            vis_rows=vis_rows,
        )

        mid_ticks = mid1 / e.render_tick_size
        max_lag = max(1, int(e.centering_deadband_pct * vis_rows))
        self.assertLessEqual(
            abs(mid_ticks - e.center_price_ticks),
            max_lag,
            "BTC-scale move past deadband must hard-snap so BBO stays in band",
        )
        self.assertAlmostEqual(e.center_price_ticks, round(mid_ticks), delta=1)

    def test_ticks_per_row_rescale_maps_mid_to_same_grid(self):
        """Changing tpr rescales center: new_center ≈ round(mid / new_rts)."""
        vis_rows = 80
        tick = 0.01
        e = self._make_engine(
            vis_rows=vis_rows, tick_size=tick, ticks_per_row=1, centering_mode="immediate"
        )
        mid = 65700.58
        e.push_snapshot(
            _levels_around(mid, tick),
            _bbo(mid, tick),
            auto_follow=True,
            vis_rows=vis_rows,
        )
        # Poison scenario: tpr 1 → 100 without rescale would leave center huge.
        e.ticks_per_row = 100
        new_rts = e.render_tick_size
        expected = int(round(mid / new_rts))
        self.assertEqual(e.center_price_ticks, expected)
        self.assertEqual(e._center_price_ticks_float, float(expected))

        # Mid still within hard band under auto_follow after a follow-up push.
        e.push_snapshot(
            _levels_around(mid, tick),
            _bbo(mid, tick, t=2.0),
            auto_follow=True,
            vis_rows=vis_rows,
        )
        mid_ticks = mid / e.render_tick_size
        max_lag = max(1, int(e.centering_deadband_pct * vis_rows))
        self.assertLessEqual(abs(mid_ticks - e.center_price_ticks), max_lag)

    def test_ticks_per_row_rescale_without_bbo_uses_center_price(self):
        """If no BBO/history mid, rescale via center * old_rts / new_rts."""
        e = self._make_engine(ticks_per_row=1, tick_size=0.01)
        e.center_price_ticks = 1_000_000  # price 10000 at tpr=1, tick=0.01
        e._center_price_ticks_float = float(e.center_price_ticks)
        e._bbo = None
        e._price_history.clear()

        e.ticks_per_row = 100
        # price = 1_000_000 * 0.01 = 10000; new_rts=1.0 → center=10000
        self.assertEqual(e.center_price_ticks, 10_000)

    def test_auto_follow_false_does_not_force_snap(self):
        """Hard invariant only applies when auto_follow=True."""
        vis_rows = 100
        e = self._make_engine(vis_rows=vis_rows, centering_mode="smooth_deadband")
        mid0 = 100.0
        e.push_snapshot(
            _levels_around(mid0), _bbo(mid0), auto_follow=True, vis_rows=vis_rows
        )
        frozen = e.center_price_ticks

        mid1 = mid0 + 5.0
        e.push_snapshot(
            _levels_around(mid1),
            _bbo(mid1, t=1.0),
            auto_follow=False,
            vis_rows=vis_rows,
        )
        self.assertEqual(e.center_price_ticks, frozen)


if __name__ == "__main__":
    unittest.main()
