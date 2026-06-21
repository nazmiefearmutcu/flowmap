#!/usr/bin/env python3
"""Diagnose _draw_column classification: why ask rows are sparse."""

import sys
import numpy as np
from flowmap.engine.density_engine import DensityEngine
from flowmap.engine.color_system import ColorSystem
from flowmap.data.simulator import MarketSimulator
from flowmap.core import BBO, BookLevel

print("=" * 70)
print("CLASSIFICATION DIAGNOSTIC: Bid vs Ask in _draw_column")
print("=" * 70)

engine = DensityEngine(max_levels=50, history_width=600, decay=0.92)
engine.resize(430, 200)
print(f"Buffer shape: {engine.get_buffer().shape}")
print(f"Normalizer refs: bid={engine._bid_norm.global_ref:.0f} ask={engine._ask_norm.global_ref:.0f}")

sim = MarketSimulator(symbol="TEST", base_price=24500, tick_size=0.05,
                      depth_levels=15, volume_per_tick=0.25)

# Run 60 ticks and collect classification stats per tick
classification_stats = []

for tick in range(60):
    r = sim.tick()
    snap = r['snapshot']
    bbo_data = r['bbo']

    levels = {}
    for price, size in snap.bids:
        levels[price] = [size, 0.0]
    for price, size in snap.asks:
        if price in levels:
            levels[price][1] = size
        else:
            levels[price] = [0.0, size]

    level_list = [BookLevel(price=p, bid_size=s[0], ask_size=s[1],
                            trade_volume=0, trade_count=0,
                            last_trade_side=None, delta=s[0]-s[1],
                            max_size=max(s))
                  for p, s in sorted(levels.items())]

    bbo = BBO(timestamp=tick, symbol="TEST",
              bid=bbo_data.bid, ask=bbo_data.ask,
              bid_size=bbo_data.bid_size, ask_size=bbo_data.ask_size)

    engine.push_snapshot(level_list, bbo)

    # Check what _draw_column would classify
    level_prices = sorted([lv.price for lv in level_list])
    if not level_prices:
        continue

    mid = 0.0
    if bbo.bid > 0 and bbo.ask > 0:
        mid = (bbo.bid + bbo.ask) / 2.0

    if mid > 0:
        selected = sorted(level_prices, key=lambda p: abs(p - mid))[:15]
    else:
        selected = level_prices[:15]
    selected.sort()

    level_by_price = {lv.price: lv for lv in level_list}

    # CLASSIFICATION BASED ON SNAPSHOT SIZE (current code)
    bid_snap = []
    ask_snap = []
    for price in selected:
        lv = level_by_price.get(price)
        if lv is None:
            continue
        if lv.bid_size > lv.ask_size and lv.bid_size > 0:
            bid_snap.append(price)
        elif lv.ask_size > 0:
            ask_snap.append(price)
        elif lv.bid_size > 0:
            bid_snap.append(price)

    # CLASSIFICATION BASED ON ACCUMULATED DENSITY (proposed fix)
    bid_den = []
    ask_den = []
    for price in selected:
        bd = engine._bid_density.get(price, 0.0)
        ad = engine._ask_density.get(price, 0.0)
        if bd > ad and bd > 0:
            bid_den.append(price)
        elif ad > 0:
            ask_den.append(price)
        elif bd > 0:
            bid_den.append(price)

    classification_stats.append({
        'tick': tick,
        'selected': len(selected),
        'bid_snap': len(bid_snap),
        'ask_snap': len(ask_snap),
        'bid_den': len(bid_den),
        'ask_den': len(ask_den),
    })

    if tick == 59:
        # On last tick, print detailed comparison
        print(f"\n{'='*70}")
        print(f"TICK {tick}: DETAILED CLASSIFICATION COMPARISON")
        print(f"{'='*70}")
        print(f"Mid price: {mid:.2f}")
        print(f"Selected prices: {len(selected)}")
        print(f"\n{'Price':>12s}  {'bid_sz':>10s}  {'ask_sz':>10s}  {'bid_den':>10s}  {'ask_den':>10s}  {'SNAP=>':>6s}  {'DEN=>':>6s}")
        print("-" * 85)
        for price in selected:
            lv = level_by_price.get(price)
            bs = lv.bid_size if lv else 0
            as_ = lv.ask_size if lv else 0
            bd = engine._bid_density.get(price, 0.0)
            ad = engine._ask_density.get(price, 0.0)

            snap_side = "BID" if price in bid_snap else ("ASK" if price in ask_snap else "---")
            den_side = "BID" if price in bid_den else ("ASK" if price in ask_den else "---")

            print(f"{price:12.2f}  {bs:10.1f}  {as_:10.1f}  {bd:10.1f}  {ad:10.1f}  {snap_side:>6s}  {den_side:>6s}")

# Summary across all ticks
print(f"\n{'='*70}")
print(f"SUMMARY ACROSS {len(classification_stats)} TICKS")
print(f"{'='*70}")

avg_bid_snap = np.mean([s['bid_snap'] for s in classification_stats])
avg_ask_snap = np.mean([s['ask_snap'] for s in classification_stats])
avg_bid_den = np.mean([s['bid_den'] for s in classification_stats])
avg_ask_den = np.mean([s['ask_den'] for s in classification_stats])

print(f"Snapshot-based classification:  avg bid={avg_bid_snap:.1f}  avg ask={avg_ask_snap:.1f}  ratio={avg_bid_snap/avg_ask_snap if avg_ask_snap else 'inf'}")
print(f"Density-based classification:   avg bid={avg_bid_den:.1f}  avg ask={avg_ask_den:.1f}  ratio={avg_bid_den/avg_ask_den if avg_ask_den else 'inf'}")

# Show imbalanced ticks
imbalanced = [s for s in classification_stats if abs(s['bid_snap'] - s['ask_snap']) > 4]
print(f"\nTicks with imbalanced classification (|bid-ask| > 4): {len(imbalanced)}/{len(classification_stats)}")
for s in imbalanced[:5]:
    print(f"  tick={s['tick']:3d}: snap bid={s['bid_snap']} ask={s['ask_snap']}  |  den bid={s['bid_den']} ask={s['ask_den']}")

# Also print rightmost column colors
buf = engine.get_buffer()
col = buf.shape[1] - 1
col_pixels = buf[:, col, :]
bg = ColorSystem.BG_COLOR
non_bg_mask = ~np.all(col_pixels == bg, axis=1)
red_rows = int(np.sum((col_pixels[:, 0] > col_pixels[:, 1]) & non_bg_mask))
green_rows = int(np.sum((col_pixels[:, 1] > col_pixels[:, 0]) & non_bg_mask))

print(f"\nRightmost column: {red_rows} red rows, {green_rows} green rows, {buf.shape[0] - red_rows - green_rows} gap rows")

print("\nDIAGNOSIS COMPLETE")
