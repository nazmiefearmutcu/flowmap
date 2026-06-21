#!/usr/bin/env python3
"""
Diagnostic: Simulator density vs normalizer ref mismatch.
Tests whether ref=5000 is too high for the current simulator tuning.
"""
import sys
import random
import numpy as np

from PyQt6.QtWidgets import QApplication

# ── Seed for reproducibility ──
random.seed(42)
np.random.seed(42)

# Create QApplication (needed for QObject base class)
app = QApplication(sys.argv)

from flowmap.data.simulator import MarketSimulator
from flowmap.engine.density_engine import DensityEngine
from flowmap.engine.normalizer import AdaptiveNormalizer
from flowmap.engine.color_system import ColorSystem
from flowmap.core import BookLevel, BBO

# ── Simulator parameters (current defaults) ──
SIM_PARAMS = dict(
    symbol="SYNTH.NIFTY",
    base_price=24500.0,
    tick_size=0.05,
    min_size=30.0,
    max_size=2000.0,
    depth_levels=15,
    spread_bps=0.5,
    volatility=0.02,
    volume_per_tick=0.25,
    tick_interval_ms=200,
)

def build_booklevels(snapshot) -> list[BookLevel]:
    """Merge bids and asks at each price level into BookLevel objects."""
    bid_map = {}
    ask_map = {}
    for price, size in snapshot.bids:
        bid_map[price] = bid_map.get(price, 0.0) + size
    for price, size in snapshot.asks:
        ask_map[price] = ask_map.get(price, 0.0) + size

    all_prices = sorted(set(bid_map.keys()) | set(ask_map.keys()))
    levels = []
    for price in all_prices:
        levels.append(BookLevel(
            price=price,
            bid_size=bid_map.get(price, 0.0),
            ask_size=ask_map.get(price, 0.0),
        ))
    return levels


def compute_lut_alpha(norm_value: float) -> int:
    """Compute what alpha the LUT would give for a normalized value."""
    t = max(0.0, min(1.0, norm_value))
    idx = int(np.clip(t * 255, 0, 255))
    return int(ColorSystem.BID_LUT[idx][3])  # alpha channel


def test_ref(ref_value: float, ticks: int = 30):
    """Run simulation with a specific ref value and report diagnostics."""
    sim = MarketSimulator(**SIM_PARAMS)
    engine = DensityEngine(
        max_levels=50,
        history_width=600,
        decay=0.92,
    )
    # Override the normalizers with our test ref
    engine._bid_norm = AdaptiveNormalizer(fixed_ref=ref_value)
    engine._ask_norm = AdaptiveNormalizer(fixed_ref=ref_value)

    print(f"\n{'='*70}")
    print(f"  TEST: ref = {ref_value}")
    print(f"{'='*70}")
    print(f"{'Tick':>4} | {'MaxBidDens':>10} | {'MaxAskDens':>10} | {'#NonZero':>8} | "
          f"{'MaxBidNorm':>10} | {'MaxAskNorm':>10} | {'MaxBidAlpha':>11} | {'MaxAskAlpha':>11}")
    print("-" * 70)

    for i in range(ticks):
        data = sim.tick()
        snapshot = data['snapshot']
        bbo = data['bbo']

        levels = build_booklevels(snapshot)
        engine.push_snapshot(levels, bbo)

        # ── Analyze current density state ──
        bid_vals = list(engine._bid_density.values())
        ask_vals = list(engine._ask_density.values())

        max_bid = max(bid_vals) if bid_vals else 0.0
        max_ask = max(ask_vals) if ask_vals else 0.0
        n_nonzero = len([v for v in bid_vals if v > 0.01]) + len([v for v in ask_vals if v > 0.01])

        # Normalized values
        max_bid_norm = engine._bid_norm.normalize(np.array([max_bid]))[0] if max_bid > 0 else 0.0
        max_ask_norm = engine._ask_norm.normalize(np.array([max_ask]))[0] if max_ask > 0 else 0.0

        # LUT alpha
        max_bid_alpha = compute_lut_alpha(max_bid_norm) if max_bid_norm > 0 else 0
        max_ask_alpha = compute_lut_alpha(max_ask_norm) if max_ask_norm > 0 else 0

        print(f"{i+1:4d} | {max_bid:10.1f} | {max_ask:10.1f} | {n_nonzero:8d} | "
              f"{max_bid_norm:10.4f} | {max_ask_norm:10.4f} | {max_bid_alpha:11d} | {max_ask_alpha:11d}")

    # ── Summary stats ──
    all_vals = list(engine._bid_density.values()) + list(engine._ask_density.values())
    if all_vals:
        arr = np.array(all_vals)
        arr_nz = arr[arr > 0.01]
        print(f"\n  Density summary ({len(arr_nz)} non-zero entries):")
        print(f"    min={arr_nz.min():.1f}, p25={np.percentile(arr_nz,25):.1f}, "
              f"p50={np.percentile(arr_nz,50):.1f}, p75={np.percentile(arr_nz,75):.1f}, "
              f"p90={np.percentile(arr_nz,90):.1f}, p95={np.percentile(arr_nz,95):.1f}, "
              f"p99={np.percentile(arr_nz,99):.1f}, max={arr_nz.max():.1f}")

        # What alpha values does this produce?
        norms = arr_nz / ref_value
        norms_clipped = np.clip(norms, 0.0, 1.0)
        alphas = np.array([compute_lut_alpha(n) for n in norms_clipped])
        print(f"\n  Resulting alpha distribution (ref={ref_value}):")
        print(f"    min={alphas.min()}, p25={np.percentile(alphas,25):.1f}, "
              f"p50={np.percentile(alphas,50):.1f}, p75={np.percentile(alphas,75):.1f}, "
              f"p90={np.percentile(alphas,90):.1f}, p95={np.percentile(alphas,95):.1f}, "
              f"max={alphas.max()}")

        visible_count = np.sum(alphas >= 10)
        bright_count = np.sum(alphas >= 64)
        print(f"    Entries with alpha >=10 (visible): {visible_count}/{len(alphas)} "
              f"({100*visible_count/len(alphas):.1f}%)")
        print(f"    Entries with alpha >=64 (bright):  {bright_count}/{len(alphas)} "
              f"({100*bright_count/len(alphas):.1f}%)")
    else:
        print("\n  Density summary: NO NON-ZERO DENSITY ENTRIES (all decayed)")

    # ── Full density dict dump (top 20 entries) ──
    print(f"\n  Top 20 bid density entries:")
    bid_sorted = sorted(engine._bid_density.items(), key=lambda x: -x[1])[:20]
    for price, density in bid_sorted:
        norm = density / ref_value
        alpha = compute_lut_alpha(min(norm, 1.0))
        print(f"    price={price:10.2f}  density={density:10.1f}  norm={norm:.4f}  alpha={alpha}")

    print(f"\n  Top 20 ask density entries:")
    ask_sorted = sorted(engine._ask_density.items(), key=lambda x: -x[1])[:20]
    for price, density in ask_sorted:
        norm = density / ref_value
        alpha = compute_lut_alpha(min(norm, 1.0))
        print(f"    price={price:10.2f}  density={density:10.1f}  norm={norm:.4f}  alpha={alpha}")

    return engine


# ── Run tests ──
print("=" * 70)
print("  DENSITY vs REFERENCE DIAGNOSTIC")
print("=" * 70)
print(f"  Simulator: volume_per_tick={SIM_PARAMS['volume_per_tick']}, "
      f"decay=0.92, depth={SIM_PARAMS['depth_levels']}")
print(f"  Steady-state per-level per-tick: {SIM_PARAMS['volume_per_tick']}/0.08 = "
      f"{SIM_PARAMS['volume_per_tick']/0.08:.1f}")
print(f"  After 30 ticks un-decayed: ~{SIM_PARAMS['volume_per_tick']/0.08 * 30:.0f}")
print()

for ref in [1000, 2000, 3000, 5000]:
    # Re-seed for fair comparison
    random.seed(42)
    np.random.seed(42)
    test_ref(float(ref), ticks=30)

print("\n" + "=" * 70)
print("  VERDICT")
print("=" * 70)
print("""
  Alpha values for reference:
    alpha >= 10  → barely visible on black background
    alpha >= 64  → clearly visible (mid glow)
    alpha >= 128 → bright
    alpha >= 200 → very bright / saturated
  
  The ref value should be chosen so that the P50-P90 density values
  produce alpha in the 20-180 range for good visual spread.
""")
