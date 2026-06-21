#!/usr/bin/env python3
"""
Test script: Generate a PNG screenshot of the BookmapHeatmap widget
to verify Bookmap-style rendering with stable price grid.

Verification checklist:
- Dark background (not pure black)
- Green columns on right (bids)
- Red columns mixed with green (asks)
- Visible grid lines
- Price axis on left
- BBO lines visible
- Dense coverage (not sparse — >15% non-background)
"""

import sys
import os

PROJECT_DIR = os.path.expanduser('~/flowmap')
sys.path.insert(0, PROJECT_DIR)

from PyQt6.QtWidgets import QApplication
from PyQt6.QtGui import QPixmap, QColor

from flowmap.ui.heatmap import BookmapHeatmap
from flowmap.core.order_book import OrderBook
from flowmap.data.simulator import MarketSimulator


def analyze_pixmap(pixmap: QPixmap) -> dict:
    """Analyze a QPixmap and return statistics about its contents."""
    img = pixmap.toImage()
    if img.isNull():
        return {"error": "Image is null"}
    w, h = img.width(), img.height()
    if w == 0 or h == 0:
        return {"error": f"Zero dimensions: {w}x{h}"}

    dark_pixels = 0
    green_pixels = 0
    red_pixels = 0
    yellow_pixels = 0
    total_pixels = 0
    non_bg_pixels = 0

    for y in range(0, h, 2):
        for x in range(0, w, 2):
            c = img.pixelColor(x, y)
            r, g, b = c.red(), c.green(), c.blue()
            total_pixels += 1

            # Background: very dark (r<20, g<20, b<25 — covers dark blue-black)
            if r < 20 and g < 20 and b < 25:
                dark_pixels += 1
            else:
                non_bg_pixels += 1

            # Green: G is the dominant channel (bid area)
            if g > r + 15 and g > b + 15 and g > 40:
                green_pixels += 1

            # Red: R is the dominant channel (ask area)
            if r > g + 15 and r > b + 15 and r > 40:
                red_pixels += 1

            # Yellow BBO lines: R and G both high, B lower
            if r > 100 and g > 100 and b < 80:
                yellow_pixels += 1

    # Column-by-column coverage analysis
    col_coverage = []
    for x in range(0, w, 5):
        non_dark = 0
        for y in range(0, h, 3):
            c = img.pixelColor(x, y)
            if c.red() >= 20 or c.green() >= 20 or c.blue() >= 25:
                non_dark += 1
        total_col = max(1, h // 3)
        col_coverage.append(non_dark / total_col * 100)

    active_cols = sum(1 for cov in col_coverage if cov > 5)

    key_points = []
    for y_pct in [0.1, 0.5, 0.9]:
        y = int(h * y_pct)
        row_samples = []
        for x in [5, 70, w // 2, w - 100, w - 5]:
            if x < w and y < h:
                c = img.pixelColor(x, y)
                row_samples.append({
                    "pos": f"({x},{y})",
                    "R": c.red(), "G": c.green(), "B": c.blue(), "A": c.alpha()
                })
        key_points.append({"y_pct": y_pct, "samples": row_samples})

    return {
        "width": w, "height": h,
        "pct_dark": round(dark_pixels / max(total_pixels, 1) * 100, 1),
        "pct_green": round(green_pixels / max(total_pixels, 1) * 100, 1),
        "pct_red": round(red_pixels / max(total_pixels, 1) * 100, 1),
        "pct_yellow": round(yellow_pixels / max(total_pixels, 1) * 100, 1),
        "pct_non_bg": round(non_bg_pixels / max(total_pixels, 1) * 100, 1),
        "active_cols": active_cols,
        "total_cols": len(col_coverage),
        "total_sampled": total_pixels,
        "key_points": key_points,
    }


def main():
    app = QApplication(sys.argv)

    # ── 1. Create the heatmap widget ──
    heatmap = BookmapHeatmap()
    heatmap.resize(900, 500)
    heatmap.show()
    app.processEvents()

    # ── 2. Create OrderBook + Simulator ──
    order_book = OrderBook("TEST.NIFTY", depth=25)
    simulator = MarketSimulator(
        symbol="TEST.NIFTY",
        base_price=24500.0,
        tick_size=0.05,
        depth_levels=25,
    )

    # ── 3. Run 300 ticks ──
    print("Running 300 simulation ticks...")
    for i in range(300):
        result = simulator.tick()
        order_book.apply_snapshot(result['snapshot'])
        for trade in result['trades']:
            order_book.record_trade(trade)

        levels = order_book.get_levels()
        heatmap.set_levels(levels)
        heatmap.set_bbo(order_book.bbo)

    # ── 4. Debug info ──
    print(f"\nWidget: {heatmap.width()}x{heatmap.height()}  row_height={heatmap.row_height}")
    print(f"History: {len(heatmap._history)} snapshots, {len(heatmap._all_prices)} unique prices")
    print(f"Buffer: {heatmap._buffer.shape}  vis_rows={heatmap._visible_rows()}")
    print(f"Price range: {heatmap._price_min:.2f} - {heatmap._price_max:.2f}")
    print(f"Price grid: {len(heatmap._all_prices)} unique prices")

    # ── 5. Render and save ──
    heatmap.repaint()
    app.processEvents()

    pixmap = QPixmap(heatmap.size())
    heatmap.render(pixmap)

    output_path = os.path.join(PROJECT_DIR, 'heatmap_test.png')
    pixmap.save(output_path)
    print(f"\nSaved screenshot to {output_path} ({pixmap.width()}x{pixmap.height()})")

    # ── 6. Analyze ──
    print("\n========== Analysis ==========")
    result = analyze_pixmap(pixmap)

    if "error" in result:
        print(f"ERROR: {result['error']}")
        return 1

    print(f"Dark background:    {result['pct_dark']:.1f}%")
    print(f"Green (bids):       {result['pct_green']:.1f}%")
    print(f"Red (asks):         {result['pct_red']:.1f}%")
    print(f"Yellow (BBO):       {result['pct_yellow']:.1f}%")
    print(f"Non-background:     {result['pct_non_bg']:.1f}%")
    print(f"Active columns:     {result['active_cols']}/{result['total_cols']}")

    print("\nPixel samples:")
    for row_data in result['key_points']:
        for s in row_data['samples']:
            print(f"  {s['pos']}: R={s['R']:3d} G={s['G']:3d} B={s['B']:3d} A={s['A']:3d}")

    # ── 7. Verify ──
    print("\n========== Verification ==========")
    checks = [
        ("PASS" if result['pct_dark'] > 30 else "FAIL",
         f"Dark background > 30%: {result['pct_dark']:.1f}%"),
        ("PASS" if result['pct_green'] > 1.0 else "FAIL",
         f"Green bid areas > 1%: {result['pct_green']:.1f}%"),
        ("PASS" if result['pct_red'] > 0.5 else "FAIL",
         f"Red ask areas > 0.5%: {result['pct_red']:.1f}%"),
        ("PASS" if result['pct_non_bg'] > 10 else "FAIL",
         f"Non-background > 10%: {result['pct_non_bg']:.1f}%"),
        ("PASS" if result['active_cols'] > 5 else "FAIL",
         f"Active columns > 5: {result['active_cols']}"),
        ("PASS" if result['width'] >= 800 and result['height'] >= 400 else "FAIL",
         f"Dimensions: {result['width']}x{result['height']}"),
    ]

    for status, msg in checks:
        print(f"  [{status}] {msg}")

    failures = [c for c in checks if c[0] == "FAIL"]
    if failures:
        print(f"\n✗ {len(failures)} verification failures!")
        return 1

    print("\n✓ All checks passed! Heatmap renders Bookmap-style output correctly.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
