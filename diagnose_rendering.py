#!/usr/bin/env python3
"""Diagnose rendering: buffer row-by-row analysis, LUT color verification, _draw_column blending check."""

import sys
import numpy as np
from flowmap.engine.density_engine import DensityEngine
from flowmap.engine.color_system import ColorSystem
from flowmap.data.simulator import MarketSimulator
from flowmap.core import BBO, BookLevel

# =========================================================================
# PART 1: Buffer Row-by-Row Analysis
# =========================================================================
print("=" * 70)
print("PART 1: BUFFER ROW-BY-ROW ANALYSIS")
print("=" * 70)

# Create engine and simulator (exactly as verify_v4.py)
engine = DensityEngine(max_levels=50, history_width=600, decay=0.92)
engine.resize(150, 200)
print(f"Buffer shape: {engine.get_buffer().shape}")
print(f"Normalizer refs: bid={engine._bid_norm.global_ref:.0f} ask={engine._ask_norm.global_ref:.0f}")

sim = MarketSimulator(symbol="TEST", base_price=24500, tick_size=0.05,
                      depth_levels=15, volume_per_tick=0.25)

level_counts = []
for tick in range(40):
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
    level_counts.append(len(level_list))

print(f"Fed {len(level_counts)} ticks, avg levels/tick: {sum(level_counts)//len(level_counts)}")
print()

# Row-by-row buffer analysis
buf = engine.get_buffer()
vis_rows, hm_width = buf.shape[0], buf.shape[1]
print(f"Buffer: {vis_rows} rows × {hm_width} columns")

# For each row, check: is there data? what dominant color?
print(f"\n{'Row':>4s}  {'Data?':>5s}  {'Dominant':>8s}  {'R':>4s} {'G':>4s} {'B':>4s} {'A':>4s}  {'Type':>8s}")
print("-" * 60)

gap_rows = 0
data_rows = 0
bid_rows = 0
ask_rows = 0
purple_rows = 0
all_data_rgbs = []

for row in range(vis_rows):
    # Check if ANY column in this row has non-background data
    row_pixels = buf[row, :, :]
    bg_color = ColorSystem.BG_COLOR  # [0, 0, 0, 255]
    is_bg = np.all(row_pixels == bg_color, axis=1)
    has_data = not np.all(is_bg)

    if has_data:
        data_rows += 1
        # Get only data pixels (non-background)
        data_pixels = row_pixels[~is_bg]
        mean_rgb = data_pixels[:, :3].mean(axis=0).astype(int)
        all_data_rgbs.append(mean_rgb)

        r, g, b = mean_rgb
        if g > r:
            dom = "GREEN"
            row_type = "BID"
            bid_rows += 1
        elif r > g:
            dom = "RED"
            row_type = "ASK"
            ask_rows += 1
        else:
            dom = "EQUAL"
            row_type = "???"
            purple_rows += 1

        alpha_mean = int(data_pixels[:, 3].mean())
        print(f"{row:4d}  {'YES':>5s}  {dom:>8s}  {r:4d} {g:4d} {b:4d} {alpha_mean:4d}  {row_type:>8s}")
    else:
        gap_rows += 1

print("-" * 60)
print(f"\nSUMMARY:")
print(f"  Data rows: {data_rows}/{vis_rows} ({data_rows/vis_rows*100:.1f}%)")
print(f"  Gap rows (BG_COLOR): {gap_rows}/{vis_rows} ({gap_rows/vis_rows*100:.1f}%)")
print(f"  Bid (green) rows: {bid_rows}")
print(f"  Ask (red) rows: {ask_rows}")
print(f"  Purple/ambiguous rows: {purple_rows}")

if all_data_rgbs:
    all_rgbs = np.array(all_data_rgbs)
    print(f"\n  Data-row RGB stats:")
    print(f"    R: min={all_rgbs[:,0].min():.0f} max={all_rgbs[:,0].max():.0f} mean={all_rgbs[:,0].mean():.1f}")
    print(f"    G: min={all_rgbs[:,1].min():.0f} max={all_rgbs[:,1].max():.0f} mean={all_rgbs[:,1].mean():.1f}")
    print(f"    B: min={all_rgbs[:,2].min():.0f} max={all_rgbs[:,2].max():.0f} mean={all_rgbs[:,2].mean():.1f}")

# Check if R=124 G=114 B=151 exists anywhere
print(f"\n  Checking for purple/gray (R≈124,G≈114,B≈151):")
purple_mask = (buf[:, :, 0] > 100) & (buf[:, :, 0] < 150) & \
              (buf[:, :, 1] > 90) & (buf[:, :, 1] < 140) & \
              (buf[:, :, 2] > 130) & (buf[:, :, 2] < 170)
purple_count = int(np.sum(purple_mask))
print(f"  Pixels with R 100-150, G 90-140, B 130-170: {purple_count}")
if purple_count > 0:
    purple_pixels = buf[purple_mask]
    print(f"  Sample purple pixel: R={purple_pixels[0,0]} G={purple_pixels[0,1]} B={purple_pixels[0,2]} A={purple_pixels[0,3]}")

# =========================================================================
# PART 2: Color LUT Correctness
# =========================================================================
print("\n\n" + "=" * 70)
print("PART 2: COLOR LUT CORRECTNESS")
print("=" * 70)

bid_lut = ColorSystem.BID_LUT
ask_lut = ColorSystem.ASK_LUT

# Print LUT at specified indices
indices = [0, 50, 100, 150, 200, 255]
print(f"\nBID_LUT (green-dominant):")
print(f"  {'Idx':>4s}  {'t':>7s}  {'R':>4s} {'G':>4s} {'B':>4s} {'A':>4s}")
for i in indices:
    t = i / 255.0
    r, g, b, a = bid_lut[i]
    print(f"  {i:4d}  {t:7.4f}  {r:4d} {g:4d} {b:4d} {a:4d}")

print(f"\nASK_LUT (red-dominant):")
print(f"  {'Idx':>4s}  {'t':>7s}  {'R':>4s} {'G':>4s} {'B':>4s} {'A':>4s}")
for i in indices:
    t = i / 255.0
    r, g, b, a = ask_lut[i]
    print(f"  {i:4d}  {t:7.4f}  {r:4d} {g:4d} {b:4d} {a:4d}")

# Verify ALL 256 indices: BID always G > R, ASK always R > G
bid_g_gt_r = bool(np.all(bid_lut[:, 1] >= bid_lut[:, 0]))
ask_r_gt_g = bool(np.all(ask_lut[:, 0] >= ask_lut[:, 1]))

print(f"\nLUT invariants (all 256 indices):")
print(f"  BID: G >= R for all entries: {bid_g_gt_r}")
print(f"  ASK: R >= G for all entries: {ask_r_gt_g}")

# Find any violations
if not bid_g_gt_r:
    bad = np.where(bid_lut[:, 1] < bid_lut[:, 0])[0]
    print(f"  BID violations at indices: {bad[:10].tolist()}...")
    for i in bad[:5]:
        print(f"    idx={i}: R={bid_lut[i,0]} G={bid_lut[i,1]} B={bid_lut[i,2]} A={bid_lut[i,3]}")
if not ask_r_gt_g:
    bad = np.where(ask_lut[:, 0] < ask_lut[:, 1])[0]
    print(f"  ASK violations at indices: {bad[:10].tolist()}...")
    for i in bad[:5]:
        print(f"    idx={i}: R={ask_lut[i,0]} G={ask_lut[i,1]} B={ask_lut[i,2]} A={ask_lut[i,3]}")

# Print alpha for specific t values
print(f"\nAlpha values at specific t:")
print(f"  {'t':>7s}  {'BID_Alpha':>10s}  {'ASK_Alpha':>10s}")
for t in [0.0, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1.0]:
    idx = min(255, int(t * 255))
    print(f"  {t:7.4f}  {bid_lut[idx, 3]:10d}  {ask_lut[idx, 3]:10d}")

# Full-range RGB check: do ANY LUT entries produce R=124 G=114 B=151?
print(f"\nChecking if ANY LUT entry matches purple/gray (R≈124,G≈114,B≈151):")
for name, lut in [("BID", bid_lut), ("ASK", ask_lut)]:
    close = np.where(
        (lut[:, 0] > 110) & (lut[:, 0] < 140) &
        (lut[:, 1] > 100) & (lut[:, 1] < 130) &
        (lut[:, 2] > 130) & (lut[:, 2] < 170)
    )[0]
    if len(close) > 0:
        print(f"  {name}: {len(close)} close entries:")
        for i in close[:5]:
            print(f"    idx={i} t={i/255:.3f}: R={lut[i,0]} G={lut[i,1]} B={lut[i,2]} A={lut[i,3]}")
    else:
        print(f"  {name}: NO entries match purple/gray range")

# =========================================================================
# PART 3: _draw_column Blending Check
# =========================================================================
print("\n\n" + "=" * 70)
print("PART 3: _draw_column BLENDING CHECK")
print("=" * 70)

print("""
Code analysis of _draw_column (lines 125-222 of density_engine.py):

1. For each selected price, bid AND ask densities map to the SAME buffer row:
   buf_row = pad_top + i * spacing
   bid_arr[buf_row] = b_den   ← writes bid density
   ask_arr[buf_row] = a_den   ← writes ask density (same row!)

2. Normalize each side independently:
   bid_norm = normalize(bid_arr)  ← independent normalization
   ask_norm = normalize(ask_arr)  ← independent normalization

3. Pick DOMINANT side (NOT blended):
   use_bid = bid_norm >= ask_norm
   use_ask = ask_norm > bid_norm
   norm = np.where(use_bid, bid_norm, ask_norm)

4. Apply SINGLE-SIDE color:
   self._buffer[mask, col, :] = np.where(
       side_is_bid[:, None],
       ColorSystem.BID_LUT[indices],  ← pure BID color
       ColorSystem.ASK_LUT[indices],  ← pure ASK color
   )

VERDICT: _draw_column does NOT blend bid and ask colors.
Each pixel gets EITHER pure BID (green) OR pure ASK (red) color.
No purple/gray can be produced by this code path.

POTENTIAL ISSUES IF PURPLE/GRAY IS SEEN:
  (a) The buffer is being read/displayed through an additional blending step
  (b) The screenshot shows Alpha-blended result against some background
  (c) The buffer is modified by another code path after _draw_column
  (d) The purple color comes from a DIFFERENT render layer (e.g. volume bubbles)
""")

# =========================================================================
# PART 4: Bid/Ask Density Diagnostics
# =========================================================================
print("\n\n" + "=" * 70)
print("PART 4: BID/ASK DENSITY DIAGNOSTICS")
print("=" * 70)

bid_d = engine._bid_density
ask_d = engine._ask_density

print(f"Bid density entries: {len(bid_d)}")
print(f"Ask density entries: {len(ask_d)}")

if bid_d:
    bid_vals = list(bid_d.values())
    print(f"  Bid density: min={min(bid_vals):.1f} max={max(bid_vals):.1f} mean={np.mean(bid_vals):.1f}")
    # Show normalized values
    bid_normed = np.clip(np.array(bid_vals) / engine._bid_norm.global_ref, 0, 1)
    print(f"  Bid normalized: min={bid_normed.min():.3f} max={bid_normed.max():.3f} mean={bid_normed.mean():.3f}")

if ask_d:
    ask_vals = list(ask_d.values())
    print(f"  Ask density: min={min(ask_vals):.1f} max={max(ask_vals):.1f} mean={np.mean(ask_vals):.1f}")
    ask_normed = np.clip(np.array(ask_vals) / engine._ask_norm.global_ref, 0, 1)
    print(f"  Ask normalized: min={ask_normed.min():.3f} max={ask_normed.max():.3f} mean={ask_normed.mean():.3f}")

# Check: do any prices have BOTH bid AND ask density?
both_sides = set(bid_d.keys()) & set(ask_d.keys())
print(f"\nPrices with BOTH bid AND ask density: {len(both_sides)}")
if both_sides:
    for p in sorted(list(both_sides))[:10]:
        print(f"  price={p:.2f}: bid={bid_d[p]:.1f} ask={ask_d[p]:.1f}")
    if len(both_sides) > 10:
        print(f"  ... and {len(both_sides)-10} more")

# =========================================================================
# PART 5: Rightmost Column Pixel Dump
# =========================================================================
print("\n\n" + "=" * 70)
print("PART 5: RIGHTMOST COLUMN PIXEL DUMP (col -1)")
print("=" * 70)

# Dump all non-BG pixels in the rightmost column
col = hm_width - 1
col_pixels = buf[:, col, :]
bg = ColorSystem.BG_COLOR
non_bg_mask = ~np.all(col_pixels == bg, axis=1)
non_bg_rows = np.where(non_bg_mask)[0]

print(f"Rightmost column ({col}): {len(non_bg_rows)}/{vis_rows} rows have data")
for row in non_bg_rows[:20]:
    r, g, b, a = col_pixels[row]
    dom = "GREEN" if g > r else ("RED" if r > g else "TIE")
    lut_match = ""
    bid_match = np.where((bid_lut[:, 0] == r) & (bid_lut[:, 1] == g) & (bid_lut[:, 2] == b) & (bid_lut[:, 3] == a))[0]
    ask_match = np.where((ask_lut[:, 0] == r) & (ask_lut[:, 1] == g) & (ask_lut[:, 2] == b) & (ask_lut[:, 3] == a))[0]
    if len(bid_match) > 0:
        lut_match = f"BID_LUT[{bid_match[0]}] t={bid_match[0]/255:.3f}"
    elif len(ask_match) > 0:
        lut_match = f"ASK_LUT[{ask_match[0]}] t={ask_match[0]/255:.3f}"
    else:
        lut_match = "NO LUT MATCH!"
    print(f"  row={row:3d}: R={r:3d} G={g:3d} B={b:3d} A={a:3d}  {dom}  {lut_match}")

if len(non_bg_rows) > 20:
    print(f"  ... and {len(non_bg_rows)-20} more rows")

# Also check: are there any pixels NOT in the LUT?
print(f"\nChecking ALL buffer pixels against LUTs:")
all_pixels = buf.reshape(-1, 4)
all_non_bg = all_pixels[~np.all(all_pixels == bg, axis=1)]

bid_matches = np.zeros(len(all_non_bg), dtype=bool)
ask_matches = np.zeros(len(all_non_bg), dtype=bool)
for i in range(len(all_non_bg)):
    px = all_non_bg[i]
    bid_matches[i] = np.any(np.all(bid_lut == px, axis=1))
    ask_matches[i] = np.any(np.all(ask_lut == px, axis=1))

in_lut = bid_matches | ask_matches
not_in_lut = len(all_non_bg) - int(np.sum(in_lut))
print(f"  Total non-BG pixels: {len(all_non_bg)}")
print(f"  Match BID_LUT: {int(np.sum(bid_matches))}")
print(f"  Match ASK_LUT: {int(np.sum(ask_matches))}")
print(f"  Match NEITHER LUT: {not_in_lut}")

if not_in_lut > 0:
    bad_pixels = all_non_bg[~in_lut]
    print(f"  Orphan pixel samples (not in any LUT):")
    for i in range(min(10, len(bad_pixels))):
        r, g, b, a = bad_pixels[i]
        print(f"    R={r:3d} G={g:3d} B={b:3d} A={a:3d}")

print("\n\n" + "=" * 70)
print("DIAGNOSIS COMPLETE")
print("=" * 70)
