#!/usr/bin/env python3
import sys
import os
import time
import cProfile
import pstats
import numpy as np

# Add project path
sys.path.insert(0, "/Users/nazmi/flowmap")

from PyQt6.QtWidgets import QApplication
from PyQt6.QtCore import Qt, QPointF, QRect
from PyQt6.QtGui import QImage, QPainter, QColor, QPen, QFont, QFontMetrics
from flowmap.engine.density_engine import DensityEngine
from flowmap.engine.color_system import ColorSystem
from flowmap.data.simulator import MarketSimulator
from flowmap.core.order_book import OrderBook
from flowmap.ui.heatmap_widget import HeatmapWidget

# Setup QApplication (headless)
app = QApplication(["--platform", "offscreen"])

# Define optimized methods to patch in
def optimized_paintEvent(self, event) -> None:
    p = QPainter(self)
    p.setRenderHint(QPainter.RenderHint.Antialiasing, False)
    ww, wh = self.width(), self.height()

    # Fill background
    p.fillRect(0, 0, ww, wh, QColor(0, 0, 0))

    if len(self._levels) > 0:
        buf = self._engine.get_buffer()
        bh, bw = buf.shape[0], buf.shape[1]
        if bh > 0 and bw > 0:
            hm_left = 0
            hm_w = ww - self.price_axis_w

            # Zero-copy wrapper using Format_ARGB32 (performs R-B swap natively on little-endian)
            qimg = QImage(
                buf.data,
                bw,
                bh,
                bw * 4,
                QImage.Format.Format_RGBA8888,
            )

            # Set SmoothPixmapTransform to False to ensure nearest-neighbor scaling
            p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
            
            # Draw the QImage scaled to the exact size of the viewport (hm_w by wh)
            p.drawImage(QRect(hm_left, 0, hm_w, wh), qimg)

            # Draw BBO history lines (optimized)
            self._draw_bbo_history_lines(p, ww, wh, hm_w)

            # Draw BBO current lines
            if self.show_bbo and self._bbo:
                self._draw_bbo_lines(p, ww, wh, hm_left)

            # Draw trades
            if self.show_trades:
                self._draw_trades(p, ww, wh, hm_w)

            # Draw liquidations
            self._draw_liquidations(p, ww, wh, hm_w)

            # Draw volume bubbles (after heatmap, before axis)
            if self.show_trades and self._levels:
                p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
                price_to_y = lambda price: self._price_to_screen_y(price, wh)
                self._bubbles.draw(p, ww, wh, hm_w, price_to_y, self._frame_count, bw)
                p.setRenderHint(QPainter.RenderHint.Antialiasing, False)

            # Draw price axis
            self._draw_price_axis(p, ww, wh)
    else:
        # No data state
        p.setPen(QColor(140, 150, 170))
        p.setFont(QFont('Helvetica Neue', 13))
        p.drawText(
            self.rect(),
            Qt.AlignmentFlag.AlignCenter,
            "No data — Start simulation",
        )

    # Crosshair
    if self._my >= 0 and self._hover_price is not None:
        p.setPen(QPen(QColor(180, 190, 210, 90), 1, Qt.PenStyle.DashLine))
        p.drawLine(0, self._my, ww, self._my)
        p.setPen(QColor(255, 255, 255))
        p.setFont(QFont('Menlo', 10, QFont.Weight.Bold))
        p.drawText(4, self._my - 4, f"{self._hover_price:.2f}")

    p.end()

def optimized_draw_bbo_lines(self, p: QPainter, ww: int, wh: int, hm_left: int) -> None:
    if not self._bbo or not self._levels:
        return

    hm_w = ww - self.price_axis_w

    for price, color, label in [
        (
            self._bbo.bid,
            QColor(100, 255, 120, 255),
            f"{self._bbo.bid:.2f}",
        ),
        (
            self._bbo.ask,
            QColor(255, 100, 90, 255),
            f"{self._bbo.ask:.2f}",
        ),
    ]:
        y = int(self._price_to_screen_y(price, wh))
        if 0 <= y < wh:
            p.setPen(QPen(color, 2, Qt.PenStyle.SolidLine))
            p.drawLine(QPointF(hm_left, y), QPointF(hm_w, y))
            p.setPen(QColor(255, 255, 80))
            font = QFont('Menlo', 9, QFont.Weight.Bold)
            p.setFont(font)
            fm = QFontMetrics(font)
            tw = fm.horizontalAdvance(label)
            p.drawText(int(ww - tw - 4), int(y - 2), label)

def optimized_draw_bbo_history_lines(self, p: QPainter, ww: int, wh: int, hm_w: int) -> None:
    bbo_history = self._engine.get_bbo_history()
    n_hist = len(bbo_history)
    if n_hist < 2:
        return

    buf = self._engine.get_buffer()
    bw = buf.shape[1]
    if bw <= 0 or self._engine.center_price_ticks is None or self._engine.tick_size <= 0:
        return

    p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    
    # Pre-calculate constants for screen Y mapping
    bh = buf.shape[0]
    tick_size = self._engine.tick_size
    center_ticks = self._engine.center_price_ticks
    y_scale = wh / bh
    y_offset = (wh / bh) / 2.0
    half_bh = bh / 2.0

    bbo_arr = np.array(bbo_history)  # (N, 2)
    bids = bbo_arr[:, 0]
    asks = bbo_arr[:, 1]
    
    def prices_to_ys(prices):
        p_ticks = np.round(prices / tick_size)
        rows = half_bh - (p_ticks - center_ticks)
        return rows * y_scale + y_offset

    cols = np.arange(bw - n_hist, bw)
    xs = cols * (hm_w / bw)

    # Draw bid line
    valid_bids = bids > 0
    if np.any(valid_bids):
        bid_ys = prices_to_ys(bids)
        if np.all(valid_bids):
            points = [QPointF(xs[i], bid_ys[i]) for i in range(n_hist)]
            p.setPen(QPen(QColor(100, 255, 120, 180), 1.5))
            p.drawPolyline(points)
        else:
            runs = np.diff(np.concatenate(([False], valid_bids, [False])))
            starts = np.where(runs == 1)[0]
            ends = np.where(runs == -1)[0]
            p.setPen(QPen(QColor(100, 255, 120, 180), 1.5))
            for start, end in zip(starts, ends):
                if end - start >= 2:
                    points = [QPointF(xs[i], bid_ys[i]) for i in range(start, end)]
                    p.drawPolyline(points)

    # Draw ask line
    valid_asks = asks > 0
    if np.any(valid_asks):
        ask_ys = prices_to_ys(asks)
        if np.all(valid_asks):
            points = [QPointF(xs[i], ask_ys[i]) for i in range(n_hist)]
            p.setPen(QPen(QColor(255, 100, 90, 180), 1.5))
            p.drawPolyline(points)
        else:
            runs = np.diff(np.concatenate(([False], valid_asks, [False])))
            starts = np.where(runs == 1)[0]
            ends = np.where(runs == -1)[0]
            p.setPen(QPen(QColor(255, 100, 90, 180), 1.5))
            for start, end in zip(starts, ends):
                if end - start >= 2:
                    points = [QPointF(xs[i], ask_ys[i]) for i in range(start, end)]
                    p.drawPolyline(points)

    p.setRenderHint(QPainter.RenderHint.Antialiasing, False)

# Monkey-patch HeatmapWidget with optimized versions
HeatmapWidget.paintEvent = optimized_paintEvent
HeatmapWidget._draw_bbo_lines = optimized_draw_bbo_lines
HeatmapWidget._draw_bbo_history_lines = optimized_draw_bbo_history_lines

def run_profile_pipeline():
    ob = OrderBook("BTC/USDT", depth=15)
    widget = HeatmapWidget()
    widget.resize(1338, 900)

    sim = MarketSimulator(symbol="TEST", base_price=24500, tick_size=0.05,
                          depth_levels=30, volume_per_tick=0.25)

    print("Running 1000 pipeline iterations with optimized functions...")
    start_time = time.perf_counter()
    
    render_target = QImage(1338, 900, QImage.Format.Format_ARGB32)

    for tick in range(1000):
        r = sim.tick()
        
        ob.apply_snapshot(r['snapshot'])
        for t in r['trades']:
            ob.record_trade(t)
            
        levels = ob.get_levels()
        bbo = ob.bbo
        widget.push_snapshot(levels, bbo)
        
        painter = QPainter(render_target)
        widget.render(painter)
        painter.end()

    end_time = time.perf_counter()
    duration = end_time - start_time
    print(f"Completed 1000 ticks in {duration:.4f} seconds ({1000/duration:.1f} FPS)")

if __name__ == "__main__":
    pr = cProfile.Profile()
    pr.enable()
    run_profile_pipeline()
    pr.disable()
    ps = pstats.Stats(pr).sort_stats('cumulative')
    ps.print_stats(30)
