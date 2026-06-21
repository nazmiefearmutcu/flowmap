#!/usr/bin/env python3
"""Headless render test — creates engine + simulator, renders heatmap to PNG."""
import sys
import numpy as np
from PyQt6.QtGui import QImage, QPainter, QColor
from PyQt6.QtCore import Qt
from flowmap.engine.density_engine import DensityEngine
from flowmap.data.simulator import MarketSimulator
from flowmap.core import BookLevel, BBO

print("Creating engine...")
engine = DensityEngine(max_levels=50, history_width=600, decay=0.92)
engine.resize(600, 400)  # 600 visible rows, 400 col history

print(f"Ref: bid={engine._bid_norm.global_ref:.0f} ask={engine._ask_norm.global_ref:.0f}")

print("Creating simulator...")
sim = MarketSimulator(symbol="TEST", base_price=24500, tick_size=0.05,
                      depth_levels=15, volume_per_tick=0.25)

print("Feeding 60 ticks...")
for tick in range(60):
    r = sim.tick()
    snap = r['snapshot']
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
    
    engine.push_snapshot(level_list, BBO(timestamp=tick, symbol="TEST",
                          bid=snap.bids[0][0], ask=snap.asks[0][0],
                          bid_size=snap.bids[0][1], ask_size=snap.asks[0][1]))

# Render buffer to QImage (simulating paintEvent)
buf = engine.get_buffer()
bh, bw = buf.shape[:2]

# Upscale: simulate 900px tall widget
sim_h = 900
sim_w = 1300
row_scale = max(1, sim_h // bh)
col_scale = max(1, sim_w // bw)

buf_scaled = np.repeat(np.repeat(buf, row_scale, axis=0), col_scale, axis=1)
sh, sw = buf_scaled.shape[:2]

qimg = QImage(buf_scaled.data, sw, sh, sw * 4, QImage.Format.Format_RGBA8888)
qimg.save("flowmap_headless_render.png")
print(f"Saved: flowmap_headless_render.png ({sw}x{sh})")

# Analyze the render
img = QImage("flowmap_headless_render.png")
ptr = img.bits()
ptr.setsize(sw * sh * 4)
arr = np.frombuffer(ptr, dtype=np.uint8).reshape(sh, sw, 4)

data_mask = np.any(arr[:,:,:3] > 5, axis=2)
dark_pct = (1 - np.sum(data_mask)/(sh*sw)) * 100
data_px = arr[data_mask]

g = int(np.sum((data_px[:,1] > data_px[:,0]) & (data_px[:,1] > 50)))
r = int(np.sum((data_px[:,0] > data_px[:,1]) & (data_px[:,0] > 50)))

# Count lines
lines = 0
in_line = False
for y in range(sh):
    colored = int(np.sum(np.any(arr[y,:,:3] > 10, axis=1)))
    if colored > 10 and not in_line:
        in_line = True; lines += 1
    elif colored <= 3:
        in_line = False

print(f"\n=== RENDER ANALYSIS ===")
print(f"Dark: {dark_pct:.1f}%")
print(f"Green: {g} Red: {r}")
print(f"Discrete lines: {lines}")

# Top vs bottom
h3 = sh // 3
top_mask = data_mask[:h3, :]
bot_mask = data_mask[2*h3:, :]
top_red = int(np.sum(top_mask & (arr[:h3,:,0] > arr[:h3,:,1])))
bot_green = int(np.sum(bot_mask & (arr[2*h3:,:,1] > arr[2*h3:,:,0])))
print(f"Top third red: {top_red}  Bottom third green: {bot_green}")

# Sample lines
print("\nFirst 20 discrete lines:")
in_line = False
ln = 0
for y in range(sh):
    row = arr[y, :, :3]
    colored = int(np.sum(np.any(row > 10, axis=1)))
    if colored > 10 and not in_line:
        in_line = True; ln += 1
        mask = np.any(row > 10, axis=1)
        px = row[mask]
        avg = np.mean(px, axis=0)
        dom = 'GREEN' if avg[1] > avg[0] and avg[1] > 50 else 'RED' if avg[0] > avg[1] and avg[0] > 50 else 'GRAY'
        print(f"  L{ln:2d} y={y:4d}: {colored:4d}px avg=({avg[0]:3.0f},{avg[1]:3.0f},{avg[2]:3.0f}) {dom}")
        if ln >= 30:
            break
    elif colored <= 3:
        in_line = False

# Check for purple/gray anomalies
blue_anomalies = int(np.sum((arr[:,:,2] > arr[:,:,0] + arr[:,:,1]) & (arr[:,:,2] > 30)))
print(f"\nBlue anomalies (B > R+G): {blue_anomalies}")

# Density stats
print(f"\n=== DENSITY STATS ===")
bid_items = sorted(engine._bid_density.items(), key=lambda x: x[1], reverse=True)
ask_items = sorted(engine._ask_density.items(), key=lambda x: x[1], reverse=True)
print(f"Bid: {len(bid_items)} entries, max={bid_items[0][1]:.0f}, min={bid_items[-1][1]:.0f}")
print(f"Ask: {len(ask_items)} entries, max={ask_items[0][1]:.0f}, min={ask_items[-1][1]:.0f}")

# Alpha spread from buffer (NOT screen)
buf_data = buf[np.any(buf[:,:,:3] > 0, axis=2), 3]
if len(buf_data) > 0:
    print(f"Buffer alpha: <25={np.sum(buf_data<25)/len(buf_data)*100:.0f}% 25-90={np.sum((buf_data>=25)&(buf_data<90))/len(buf_data)*100:.0f}% 90-170={np.sum((buf_data>=90)&(buf_data<170))/len(buf_data)*100:.0f}% >170={np.sum(buf_data>=170)/len(buf_data)*100:.0f}%")
