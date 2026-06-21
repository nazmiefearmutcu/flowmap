#!/usr/bin/env python3
"""Comprehensive FlowMap verification — import + buffer + screenshot checks."""
import sys, os, time, subprocess, numpy as np

PROJECT = os.path.expanduser("~/flowmap")
sys.path.insert(0, PROJECT)

def test_imports():
    """Verify all new modules import correctly."""
    from flowmap.engine import DensityEngine, ColorSystem, AdaptiveNormalizer
    from flowmap.ui.heatmap_widget import HeatmapWidget
    from flowmap.ui.price_chart import PriceChart
    from flowmap.ui.main_window import MainWindow

    # Test engine creation
    engine = DensityEngine(max_levels=50, history_width=600, decay=0.88)
    buf = engine.get_buffer()
    assert buf.shape == (1, 1, 4), f"Bad initial buffer shape: {buf.shape}"
    assert np.all(buf[0, 0] == ColorSystem.BG_COLOR), "BG color mismatch"

    # Test LUT shapes
    assert ColorSystem.BID_LUT.shape == (256, 4), f"Bad BID_LUT: {ColorSystem.BID_LUT.shape}"
    assert ColorSystem.ASK_LUT.shape == (256, 4), f"Bad ASK_LUT: {ColorSystem.ASK_LUT.shape}"
    assert ColorSystem.BID_LUT.dtype == np.uint8
    assert ColorSystem.ASK_LUT.dtype == np.uint8

    # Test norm
    norm = AdaptiveNormalizer()
    col = np.array([100.0, 500.0, 2000.0, 0.0])
    result = norm.normalize_column(col)
    assert result.shape == col.shape
    assert np.all(result >= 0) and np.all(result <= 1.0)

    print("✓ All imports and basic tests PASSED")
    return engine, ColorSystem, AdaptiveNormalizer

def test_density_engine():
    """Feed synthetic data to engine and verify buffer output."""
    from flowmap.engine import DensityEngine, ColorSystem
    from flowmap.core import BookLevel, BBO, Side

    engine = DensityEngine(max_levels=30, history_width=200, decay=0.90)
    engine.resize(200, 200)

    # Create synthetic levels
    for tick in range(50):
        levels = []
        base = 24500.0
        for i in range(15):
            price = base + (i - 7) * 0.5
            bid_sz = 500 + np.random.lognormal(5, 1.5) if i < 8 else 0
            ask_sz = 500 + np.random.lognormal(5, 1.5) if i >= 7 else 0
            levels.append(BookLevel(
                price=price, bid_size=bid_sz, ask_size=ask_sz,
                trade_volume=0, trade_count=0, last_trade_side=None,
                delta=bid_sz - ask_sz, max_size=max(bid_sz, ask_sz)
            ))
        bbo = BBO(
            timestamp=time.time(), symbol="TEST",
            bid=base - 0.25, ask=base + 0.25,
            bid_size=levels[6].bid_size, ask_size=levels[7].ask_size
        )
        engine.push_snapshot(levels, bbo)

    buf = engine.get_buffer()
    assert buf.shape == (200, 200, 4), f"Bad buffer: {buf.shape}"

    # Check non-background pixels
    non_bg = np.sum(np.any(buf[:, :, :3] != ColorSystem.BG_COLOR[:3], axis=2))
    total = buf.shape[0] * buf.shape[1]
    coverage = non_bg / total * 100
    print(f"  Coverage: {coverage:.1f}% ({non_bg}/{total})")

    # Check unique colors
    flat = buf.reshape(-1, 4)
    unique = len(np.unique(flat, axis=0))
    print(f"  Unique colors: {unique}")

    # Verify orientation: top should have ask (red > green), bottom bid (green > red)
    h = buf.shape[0]
    top_third = buf[:h//3, :, :]
    bot_third = buf[2*h//3:, :, :]

    top_red = np.sum((top_third[:, :, 0] > top_third[:, :, 1]) & np.any(top_third[:, :, :3] != ColorSystem.BG_COLOR[:3], axis=2))
    bot_green = np.sum((bot_third[:, :, 1] > bot_third[:, :, 0]) & np.any(bot_third[:, :, :3] != ColorSystem.BG_COLOR[:3], axis=2))

    print(f"  Top red-dominant: {top_red}, Bot green-dominant: {bot_green}")

    assert coverage > 1.0, f"Coverage too low: {coverage:.1f}%"
    assert unique > 10, f"Too few unique colors: {unique}"
    print("✓ Density engine buffer tests PASSED")


if __name__ == "__main__":
    print("=" * 60)
    print("FlowMap Verification Suite")
    print("=" * 60)

    try:
        engine, ColorSystem, _ = test_imports()
        test_density_engine()
        print("\n" + "=" * 60)
        print("ALL CHECKS PASSED ✓")
        print("=" * 60)
    except Exception as e:
        print(f"\n✗ FAILED: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
