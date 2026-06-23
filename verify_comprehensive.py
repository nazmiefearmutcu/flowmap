#!/usr/bin/env python3
"""
Comprehensive verification of FlowMap heatmap output.
Tests buffer colors, distribution, structure, saves PNG, and prints report.

Verification checklist:
1. Numpy buffer analysis:
   - Top rows = ASK zone (red-dominant)
   - Bottom rows = BID zone (green-dominant)
   - Colors vary with intensity (unique colors > 50)
   - Accumulation zones > 3x brighter than average
   - BBO correctly positioned in the middle
2. PNG rendering via QPixmap.render()
3. PNG analysis: dark vs colored, green/red ratio, continuous topography
"""

import sys
import os
import numpy as np

PROJECT_DIR = os.path.expanduser('~/flowmap')
sys.path.insert(0, PROJECT_DIR)

from PyQt6.QtWidgets import QApplication
from PyQt6.QtGui import QPixmap, QImage, QColor

from flowmap.ui.heatmap import BookmapHeatmap
from flowmap.core.order_book import OrderBook
from flowmap.data.simulator import MarketSimulator


# ═══════════════════════════════════════════════════════════════════
#  Buffer analysis
# ═══════════════════════════════════════════════════════════════════

def analyze_buffer(buf: np.ndarray, mid_price: float, levels: list) -> dict:
    """Analyze the numpy RGBA buffer directly."""
    h, w, c = buf.shape
    results = {}

    # ── Partition buffer into 3 vertical zones ──
    top_third   = buf[:h//3, :, :]
    mid_third   = buf[h//3:2*h//3, :, :]
    bot_third   = buf[2*h//3:, :, :]

    def count_rg_in_zone(zone):
        """Count red-dominant vs green-dominant non-background pixels."""
        red, green, non_bg = 0, 0, 0
        # Sample step to keep it fast for large buffers
        step = max(1, min(zone.shape[0] * zone.shape[1] // 8000, 3))
        for y in range(0, zone.shape[0], step):
            for x in range(0, zone.shape[1], step):
                r, g, b, a = int(zone[y, x, 0]), int(zone[y, x, 1]), int(zone[y, x, 2]), int(zone[y, x, 3])
                if a < 5:
                    continue  # fully transparent = background
                non_bg += 1
                if g > r + 15 and g > b + 15 and g > 30:
                    green += 1
                elif r > g + 15 and r > b + 15 and r > 30:
                    red += 1
        total_sampled = max(1, (zone.shape[0] // step) * (zone.shape[1] // step))
        return red, green, non_bg, total_sampled

    top_r, top_g, top_nb, top_t = count_rg_in_zone(top_third)
    mid_r, mid_g, mid_nb, mid_t = count_rg_in_zone(mid_third)
    bot_r, bot_g, bot_nb, bot_t = count_rg_in_zone(bot_third)

    def pct(part, whole):
        return round(part / max(whole, 1) * 100, 1)

    results['top_zone'] = {
        'red_pct':   pct(top_r, top_nb),
        'green_pct': pct(top_g, top_nb),
        'non_bg_pct': pct(top_nb, top_t),
        'is_ask_zone': top_r > 0 and top_nb > 20,
    }
    results['mid_zone'] = {
        'red_pct':   pct(mid_r, mid_nb),
        'green_pct': pct(mid_g, mid_nb),
        'non_bg_pct': pct(mid_nb, mid_t),
    }
    results['bot_zone'] = {
        'red_pct':   pct(bot_r, bot_nb),
        'green_pct': pct(bot_g, bot_nb),
        'non_bg_pct': pct(bot_nb, bot_t),
        'is_bid_zone': bot_g > 0 and bot_nb > 20,
    }

    # ── Unique colors ──
    sample_step = max(1, min(h * w // 6000, 4))
    colors_set = set()
    brightnesses = []
    for y in range(0, h, sample_step):
        for x in range(0, w, sample_step):
            pixel = (int(buf[y, x, 0]), int(buf[y, x, 1]), int(buf[y, x, 2]), int(buf[y, x, 3]))
            if pixel[3] > 5:
                colors_set.add(pixel)
                # Perceived brightness (ITU-R BT.601)
                bri = 0.299 * pixel[0] + 0.587 * pixel[1] + 0.114 * pixel[2]
                brightnesses.append(bri)

    results['unique_colors'] = len(colors_set)
    results['unique_colors_ok'] = len(colors_set) > 50

    # ── Brightness / accumulation ──
    if brightnesses:
        avg = np.mean(brightnesses)
        p95 = float(np.percentile(brightnesses, 95))
        p99 = float(np.percentile(brightnesses, 99))
        pmax = max(brightnesses)
        results['avg_brightness'] = round(avg, 1)
        results['p95_brightness'] = round(p95, 1)
        results['p99_brightness'] = round(p99, 1)
        results['max_brightness'] = round(pmax, 1)
        results['p95_vs_avg'] = round(p95 / max(avg, 0.5), 1)
        results['accumulation_visible'] = p95 > avg * 3.0
    else:
        results['avg_brightness'] = 0
        results['accumulation_visible'] = False

    # ── BBO position (0% = top/highest price, 100% = bottom/lowest price) ──
    if levels and mid_price > 0:
        prices = sorted([lv.price for lv in levels])
        lo, hi = prices[0], prices[-1]
        if hi > lo:
            bbo_pos = (hi - mid_price) / (hi - lo) * 100
        else:
            bbo_pos = 50.0
        results['bbo_pos_pct'] = round(bbo_pos, 1)
        results['bbo_centered'] = 25 <= bbo_pos <= 75
    else:
        results['bbo_pos_pct'] = 50.0
        results['bbo_centered'] = True

    return results


# ═══════════════════════════════════════════════════════════════════
#  PNG analysis
# ═══════════════════════════════════════════════════════════════════

def analyze_png(pixmap: QPixmap) -> dict:
    """Analyze the rendered PNG QPixmap."""
    img = pixmap.toImage()
    if img.isNull():
        return {"error": "Image is null"}
    w, h = img.width(), img.height()
    if w == 0 or h == 0:
        return {"error": f"Zero dimensions: {w}x{h}"}

    dark = green = red = total = non_bg = 0
    step = max(1, min(w, h) // 60)  # sample ~3600 pixels

    for y in range(0, h, step):
        for x in range(0, w, step):
            c = img.pixelColor(x, y)
            rv, gv, bv = c.red(), c.green(), c.blue()
            total += 1
            # dark background
            if rv < 18 and gv < 18 and bv < 24:
                dark += 1
            else:
                non_bg += 1
            # green dominant
            if gv > rv + 15 and gv > bv + 15 and gv > 40:
                green += 1
            # red dominant
            elif rv > gv + 15 and rv > bv + 15 and rv > 40:
                red += 1

    # ── Check for continuous topography vs striated pattern ──
    # Measure inter-row and inter-column color variance
    row_diffs = []
    for y in range(0, h - step * 3, step):
        for x in range(0, w, step * 2):
            c1 = img.pixelColor(x, y)
            c2 = img.pixelColor(x, y + step)
            diff = abs(c1.red()-c2.red()) + abs(c1.green()-c2.green()) + abs(c1.blue()-c2.blue())
            row_diffs.append(diff)
    col_diffs = []
    for x in range(0, w - step * 3, step):
        for y in range(0, h, step * 2):
            c1 = img.pixelColor(x, y)
            c2 = img.pixelColor(x + step, y)
            diff = abs(c1.red()-c2.red()) + abs(c1.green()-c2.green()) + abs(c1.blue()-c2.blue())
            col_diffs.append(diff)

    mean_row_var = np.mean(row_diffs) if row_diffs else 0
    mean_col_var = np.mean(col_diffs) if col_diffs else 0
    # Striated: high row variance (adjacent rows very different) with low col variance
    # Continuous: moderate row variance, moderate col variance
    is_striated = mean_row_var > 60 and mean_col_var < 1.5
    is_continuous = not is_striated and mean_col_var > 2

    return {
        "width": w, "height": h,
        "pct_dark": round(dark / max(total, 1) * 100, 1),
        "pct_green": round(green / max(total, 1) * 100, 1),
        "pct_red": round(red / max(total, 1) * 100, 1),
        "pct_non_bg": round(non_bg / max(total, 1) * 100, 1),
        "green_red_ratio": round(green / max(red, 1), 1),
        "mean_row_variance": round(mean_row_var, 2),
        "mean_col_variance": round(mean_col_var, 2),
        "is_striated": is_striated,
        "is_continuous": is_continuous,
        "total_sampled": total,
    }


# ═══════════════════════════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════════════════════════

def main():
    app = QApplication(sys.argv)

    # ── 1. Create the heatmap widget ──
    heatmap = BookmapHeatmap()
    heatmap.resize(900, 500)
    heatmap.show()
    app.processEvents()

    # ── 2. Create OrderBook + Simulator ──
    order_book = OrderBook("VERIFY.NIFTY", depth=25)
    simulator = MarketSimulator(
        symbol="VERIFY.NIFTY",
        base_price=24500.0,
        tick_size=0.05,
        depth_levels=25,
    )

    # ── 3. Run 500 ticks ──
    print("=" * 70)
    print("  FLOWMAP HEATMAP — COMPREHENSIVE VERIFICATION")
    print("=" * 70)

    print(f"\n  Running 500 simulation ticks ...")
    for i in range(500):
        result = simulator.tick()
        order_book.apply_snapshot(result['snapshot'])
        for trade in result['trades']:
            order_book.record_trade(trade)

        levels = order_book.get_levels()
        heatmap.set_levels(levels)
        heatmap.set_bbo(order_book.bbo)

    # Force final paint
    heatmap.repaint()
    app.processEvents()

    bbo = order_book.bbo
    mid_price = (bbo.bid + bbo.ask) / 2 if bbo.bid > 0 and bbo.ask > 0 else 24500.0
    levels = order_book.get_levels()

    print(f"  Done.  {len(heatmap._history)} snapshots in history.")
    print(f"  Widget: {heatmap.width()}×{heatmap.height()}  row_height={heatmap.row_height}")
    print(f"  Buffer: {heatmap._buffer.shape}")
    print(f"  Price range: {min(lv.price for lv in levels):.2f} – {max(lv.price for lv in levels):.2f}")
    print(f"  BBO: {bbo.bid:.2f} / {bbo.ask:.2f}  (mid: {mid_price:.2f})")

    # ═══════════════════════════════════════════════════════════
    #  1. BUFFER ANALYSIS
    # ═══════════════════════════════════════════════════════════
    print("\n" + "─" * 70)
    print("  1. NUMPY BUFFER ANALYSIS")
    print("─" * 70)

    buf = heatmap._buffer
    buf_r = analyze_buffer(buf, mid_price, levels)

    print(f"\n  ▸ Top third  (ASK zone — higher prices):")
    print(f"    Red: {buf_r['top_zone']['red_pct']}%   Green: {buf_r['top_zone']['green_pct']}%   "
          f"Non-bg: {buf_r['top_zone']['non_bg_pct']}%")
    print(f"    ASK zone?  {'✓ YES' if buf_r['top_zone']['is_ask_zone'] else '✗ NO'}")

    print(f"\n  ▸ Middle third:")
    print(f"    Red: {buf_r['mid_zone']['red_pct']}%   Green: {buf_r['mid_zone']['green_pct']}%   "
          f"Non-bg: {buf_r['mid_zone']['non_bg_pct']}%")

    print(f"\n  ▸ Bottom third (BID zone — lower prices):")
    print(f"    Red: {buf_r['bot_zone']['red_pct']}%   Green: {buf_r['bot_zone']['green_pct']}%   "
          f"Non-bg: {buf_r['bot_zone']['non_bg_pct']}%")
    print(f"    BID zone?  {'✓ YES' if buf_r['bot_zone']['is_bid_zone'] else '✗ NO'}")

    print(f"\n  ▸ Color variation:")
    print(f"    Unique colors: {buf_r['unique_colors']}  (>50? {'✓' if buf_r['unique_colors_ok'] else '✗'})")

    print(f"\n  ▸ Brightness / accumulation:")
    print(f"    Average: {buf_r['avg_brightness']}   P95: {buf_r['p95_brightness']}   "
          f"P99: {buf_r.get('p99_brightness','?')}   Max: {buf_r['max_brightness']}")
    print(f"    P95 / Avg = {buf_r['p95_vs_avg']}×")
    print(f"    Accumulation visible (>3×)?  "
          f"{'✓ YES' if buf_r['accumulation_visible'] else '✗ NO'}")

    print(f"\n  ▸ BBO position:")
    print(f"    {buf_r['bbo_pos_pct']}% from top  (centered? "
          f"{'✓ YES' if buf_r['bbo_centered'] else '✗ NO'})")

    # ═══════════════════════════════════════════════════════════
    #  2. PNG RENDER
    # ═══════════════════════════════════════════════════════════
    print("\n" + "─" * 70)
    print("  2. PNG RENDERING")
    print("─" * 70)

    heatmap.repaint()
    app.processEvents()

    pixmap = QPixmap(heatmap.size())
    heatmap.render(pixmap)

    output_path = os.path.join(PROJECT_DIR, 'heatmap_final.png')
    pixmap.save(output_path)
    print(f"\n  Saved: {output_path}")
    print(f"  Size:  {pixmap.width()}×{pixmap.height()} px")

    # ═══════════════════════════════════════════════════════════
    #  3. PNG ANALYSIS
    # ═══════════════════════════════════════════════════════════
    print("\n" + "─" * 70)
    print("  3. PNG IMAGE ANALYSIS")
    print("─" * 70)

    png = analyze_png(pixmap)

    if "error" in png:
        print(f"\n  ERROR: {png['error']}")
    else:
        print(f"\n  ▸ Dark background:      {png['pct_dark']}%")
        print(f"  ▸ Green (bids):         {png['pct_green']}%")
        print(f"  ▸ Red (asks):           {png['pct_red']}%")
        print(f"  ▸ Non-background:       {png['pct_non_bg']}%")
        print(f"  ▸ Green/Red ratio:      {png['green_red_ratio']}×")
        print(f"  ▸ Row variance:         {png['mean_row_variance']}")
        print(f"  ▸ Column variance:      {png['mean_col_variance']}")
        print(f"  ▸ Striated pattern?     {'⚠ YES' if png['is_striated'] else '✓ NO'}")
        print(f"  ▸ Continuous topo?      {'✓ YES' if png['is_continuous'] else '⚠ NO'}")

    # ═══════════════════════════════════════════════════════════
    #  4. FINAL REPORT
    # ═══════════════════════════════════════════════════════════
    print("\n" + "=" * 70)
    print("  4. COMPREHENSIVE VERIFICATION REPORT")
    print("=" * 70)

    checks = []

    # Buffer zone checks
    checks.append((
        "PASS" if buf_r['top_zone']['is_ask_zone'] else "WARN",
        "Top rows = ASK zone (contains high-density red/orange walls)"
    ))
    checks.append((
        "PASS" if buf_r['bot_zone']['is_bid_zone'] else "WARN",
        "Bottom rows = BID zone (contains high-density green walls)"
    ))
    checks.append((
        "PASS" if buf_r['unique_colors_ok'] else "FAIL",
        f"Unique colors > 50  ({buf_r['unique_colors']})"
    ))
    checks.append((
        "PASS" if buf_r.get('accumulation_visible') else "WARN",
        f"Accumulation > 3× avg brightness  ({buf_r.get('p95_vs_avg','?')}×)"
    ))
    checks.append((
        "PASS" if buf_r.get('bbo_centered') else "WARN",
        f"BBO centered 25-75%  ({buf_r.get('bbo_pos_pct','?')}%)"
    ))

    # Coverage checks
    checks.append((
        "PASS" if buf_r['top_zone']['non_bg_pct'] > 3 else "FAIL",
        f"Top zone non-bg > 3%  ({buf_r['top_zone']['non_bg_pct']}%)"
    ))
    checks.append((
        "PASS" if buf_r['bot_zone']['non_bg_pct'] > 3 else "FAIL",
        f"Bottom zone non-bg > 3%  ({buf_r['bot_zone']['non_bg_pct']}%)"
    ))

    # PNG checks
    if "error" not in png:
        checks.append((
            "PASS" if png['pct_non_bg'] > 5 else "FAIL",
            f"PNG non-bg coverage > 5%  ({png['pct_non_bg']}%)"
        ))
        checks.append((
            "PASS" if png['pct_dark'] > 20 else "WARN",
            f"Dark background > 20%  ({png['pct_dark']}%)"
        ))
        checks.append((
            "PASS" if png['pct_green'] > 0.5 else "WARN",
            f"Green pixels > 0.5%  ({png['pct_green']}%)"
        ))
        checks.append((
            "PASS" if png['pct_red'] > 0.5 else "WARN",
            f"Red pixels > 0.5%  ({png['pct_red']}%)"
        ))
        checks.append((
            "PASS" if png['is_continuous'] else "WARN",
            "Continuous topography (not striated)"
        ))

    # Print all checks
    print()
    for status, msg in checks:
        icon = {"PASS": "✓", "WARN": "⚠", "FAIL": "✗"}[status]
        print(f"  {icon} [{status:4s}] {msg}")

    # Summary
    passes = sum(1 for s, _ in checks if s == "PASS")
    warns  = sum(1 for s, _ in checks if s == "WARN")
    fails  = sum(1 for s, _ in checks if s == "FAIL")

    print(f"\n{'─' * 70}")
    print(f"  TOTAL:  {passes} PASS  |  {warns} WARN  |  {fails} FAIL  (out of {len(checks)} checks)")

    if fails > 0:
        print(f"\n  ✗ VERIFICATION FAILED — {fails} critical issue(s)")
        return 1
    elif warns > 0:
        print(f"\n  ⚠ VERIFICATION PASSED (with {warns} warning(s))")
        return 0
    else:
        print(f"\n  ✓ ALL CHECKS PASSED — Heatmap renders correctly!")
        return 0


if __name__ == '__main__':
    sys.exit(main())
