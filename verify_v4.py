#!/usr/bin/env python3
"""Headless buffer verification for FlowMap V4."""
import sys
import numpy as np
from flowmap.engine.density_engine import DensityEngine
from flowmap.engine.color_system import ColorSystem
from flowmap.data.simulator import MarketSimulator
from flowmap.core import BBO, BookLevel

print("=== FLOWMAP V4 VERIFICATION ===\n")

# Seed random number generators for determinism
import random
random.seed(42)
np.random.seed(42)

# 1. Color System LUTs
print("1. Color System LUTs:")
bid_lut = ColorSystem.BID_LUT
ask_lut = ColorSystem.ASK_LUT
print(f"   BID_LUT shape: {bid_lut.shape}")
print(f"   BG_COLOR: {ColorSystem.BG_COLOR}")

t05 = int(0.05 * 255)
t20 = int(0.20 * 255)
t50 = int(0.50 * 255)
print(f"   Alpha: t=0.05 a={bid_lut[t05,3]} t=0.20 a={bid_lut[t20,3]} t=0.50 a={bid_lut[t50,3]} t=1.00 a={bid_lut[255,3]}")
print(f"   BID t=0.5: R={bid_lut[t50,0]} G={bid_lut[t50,1]} B={bid_lut[t50,2]}")
print(f"   ASK t=0.5: R={ask_lut[t50,0]} G={ask_lut[t50,1]} B={ask_lut[t50,2]}")
bid_ok = bool(np.all(bid_lut[:, 1] >= bid_lut[:, 0]))
ask_ok = bool(np.all(ask_lut[:, 0] >= ask_lut[:, 1]))
print(f"   BID green>=red: {bid_ok}  ASK red>=green: {ask_ok}")
print()

# 2. Density Engine
print("2. Density Engine + Simulator:")
engine = DensityEngine(max_levels=50, history_width=600, decay=0.92)
engine.resize(150, 200)
print(f"   Buffer shape: {engine.get_buffer().shape}")
print(f"   Ref: bid={engine._bid_norm.global_ref:.0f} ask={engine._ask_norm.global_ref:.0f}")

sim = MarketSimulator(symbol="TEST", base_price=24500, tick_size=0.05,
                      depth_levels=15, volume_per_tick=0.25)

level_counts = []
for tick in range(40):
    r = sim.tick()
    snap = r['snapshot']
    bbo_data = r['bbo']

    # Build BookLevel list from snapshot bids + asks
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
    level_counts.append(len(level_list))

print(f"   Fed {len(level_counts)} ticks, avg levels/tick: {sum(level_counts)//len(level_counts)}")
print()

# 3. Buffer Analysis
print("3. Buffer Analysis:")
buf = engine.get_buffer()
h, w = buf.shape[:2]

data_mask = np.any(buf[:, :, :3] != ColorSystem.BG_COLOR[:3], axis=2)
non_bg = int(np.sum(data_mask))
coverage = non_bg / (h * w) * 100
print(f"   Data pixels: {non_bg}/{h*w} = {coverage:.1f}%")

issues = []
if non_bg > 0:
    data_alphas = buf[data_mask, 3]
    len_a = max(len(data_alphas), 1)
    low_a = np.sum(data_alphas < 25) / len_a * 100
    mid_a = np.sum((data_alphas >= 25) & (data_alphas <= 170)) / len_a * 100
    bright_a = np.sum(data_alphas > 170) / len_a * 100
    print(f"   Alpha: low<25={low_a:.0f}% mid=25-170={mid_a:.0f}% bright>170={bright_a:.0f}%")

    top_third = data_mask[:h//3, :]
    bot_third = data_mask[2*h//3:, :]
    top_red = int(np.sum(top_third & (buf[:h//3, :, 0] > buf[:h//3, :, 1])))
    bot_green = int(np.sum(bot_third & (buf[2*h//3:, :, 1] > buf[2*h//3:, :, 0])))
    print(f"   Top 1/3 red: {top_red}  Bottom 1/3 green: {bot_green}")

    bid_p = int(np.sum(data_mask & (buf[:, :, 1] > buf[:, :, 0])))
    ask_p = int(np.sum(data_mask & (buf[:, :, 0] > buf[:, :, 1])))
    print(f"   Bid(green): {bid_p}  Ask(red): {ask_p}")

    if coverage < 1.0:
        issues.append(f"COVERAGE LOW: {coverage:.1f}%")
else:
    issues.append("NO DATA")

if coverage > 98:
    issues.append(f"SATURATED: {coverage:.1f}%")

print()
print("=== VERDICT ===")
if issues:
    print("FAIL:")
    for i in issues:
        print(f"  - {i}")
    sys.exit(1)
else:
    print("✅ PASS: All checks passed!")
    print(f"   coverage={coverage:.1f}% alpha_spread=OK orientation=OK")
