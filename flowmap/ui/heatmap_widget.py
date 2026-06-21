"""
HeatmapWidget — zero-flicker QWidget wrapping DensityEngine.

Design rules:
1. setAttribute(WA_OpaquePaintEvent, True) + WA_NoSystemBackground + setAutoFillBackground(False)
2. paintEvent: np.repeat upscale → QImage → drawImage at native size — zero QRect scaling
3. No bilinear blending — pure discrete level lines (Bookmap-style stratigraphy)
4. Row 0 = highest price (asks at top), bottom = lowest (bids at bottom)
5. Mouse tracking: setMouseTracking(True)
"""

from __future__ import annotations

import math
import time
from collections import deque
from typing import Optional

import numpy as np

from PyQt6.QtCore import Qt, pyqtSignal, QPointF, QRect, QRectF
from PyQt6.QtGui import (
    QPainter, QColor, QPen, QFont, QFontMetrics,
    QPaintEvent, QMouseEvent, QWheelEvent, QKeyEvent, QImage,
    QBrush,
)
import os
import sys
from PyQt6.QtWidgets import QSizePolicy, QWidget

# Determine rendering backend
# Default to CPU for tests/verification to ensure reliable grabbing, and OpenGL for app
is_test = any(x in sys.argv[0].lower() for x in ['test', 'verify', 'benchmark', 'profile'])
env_renderer = os.environ.get("FLOWMAP_RENDERER", "").lower()

if env_renderer == "opengl":
    use_opengl = True
elif env_renderer == "cpu":
    use_opengl = False
else:
    use_opengl = not is_test

BaseHeatmapWidget = QWidget
if use_opengl:
    try:
        from PyQt6.QtOpenGLWidgets import QOpenGLWidget
        BaseHeatmapWidget = QOpenGLWidget
        print("[Heatmap] Using GPU-accelerated QOpenGLWidget backend.")
    except ImportError:
        print("[Heatmap] QOpenGLWidget not available. Falling back to CPU QWidget backend.")
else:
    print("[Heatmap] Using CPU-based QWidget backend.")

from ..core import BookLevel, BBO, Side, Trade
from ..engine import DensityEngine, ColorSystem
from .bubbles import VolumeBubbles
from .theme import Colors, Fonts


class HeatmapWidget(BaseHeatmapWidget):
    """Zero-flicker order-book heatmap rendering via DensityEngine."""

    price_hovered = pyqtSignal(float)
    price_clicked = pyqtSignal(float)
    row_height_changed = pyqtSignal(int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(400, 300)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground, True)
        self.setAutoFillBackground(False)

        self._engine = DensityEngine(max_levels=50, history_width=600, decay=0.92)
        self._bbo: Optional[BBO] = None
        self._levels: list[BookLevel] = []
        self._history: deque = deque(maxlen=600)  # Compatibility history
        self._all_prices: set[float] = set()  # Compatibility set

        # Trades for dot overlay
        self._trades: deque = deque(maxlen=300)
        self._liquidations: deque = deque(maxlen=200)

        # Volume Bubbles overlay
        self._bubbles = VolumeBubbles()

        # Rendering
        self.row_height: int = 4
        self.price_axis_w: int = 62
        self.auto_follow: bool = True
        self.show_bbo: bool = True
        self.show_trades: bool = True
        self._min_rh: int = 2
        self._max_rh: int = 24

        # Mouse
        self._mx: int = -1
        self._my: int = -1
        self._hover_price: Optional[float] = None

        # Dragging state
        self._drag_active: bool = False
        self._drag_start_pos = None
        self._drag_start_center_float: Optional[float] = None
        self._drag_occurred: bool = False

        # Track buffer state
        self._last_vis_rows: int = -1
        self._last_hm_w: int = -1
        self._frame_count: int = 0

        # Recycled buffer for swapping R/B channels in-place
        self._buf_swapped: Optional[np.ndarray] = None
        self._buf_swapped_mv: Optional[memoryview] = None

        # Latency tracking
        self._last_receive_timestamp: float = 0.0
        self._latency_history: list[float] = []
        self.last_latency_ms: Optional[float] = None

    @property
    def _buffer(self) -> np.ndarray:
        """Compatibility property for _buffer."""
        return self._engine.get_buffer()

    def _visible_rows(self) -> int:
        """Compatibility method for visible rows."""
        return self._engine.get_buffer().shape[0]

    @property
    def _price_min(self) -> float:
        """Compatibility property for minimum price in view."""
        engine = self._engine
        if engine.center_price_ticks is None or engine.tick_size <= 0:
            return 0.0
        bh = engine.get_buffer().shape[0]
        return (engine.center_price_ticks - bh // 2) * engine.tick_size

    @property
    def _price_max(self) -> float:
        """Compatibility property for maximum price in view."""
        engine = self._engine
        if engine.center_price_ticks is None or engine.tick_size <= 0:
            return 0.0
        bh = engine.get_buffer().shape[0]
        return (engine.center_price_ticks + bh // 2) * engine.tick_size

    def _price_to_screen_y(self, price: float, wh: int) -> float:
        """Unified linear mapping from price → screen Y coordinate."""
        engine = self._engine
        if engine.center_price_ticks is None or engine.tick_size <= 0:
            return wh / 2.0
        bh = engine.get_buffer().shape[0]
        p_ticks = round(price / engine.tick_size)
        row = (bh // 2) - (p_ticks - engine.center_price_ticks)
        return row * wh / bh + (wh / bh) / 2.0

    def get_visible_prices(self) -> list[float]:
        """Get the list of prices corresponding to each row from top to bottom."""
        engine = self._engine
        if engine.center_price_ticks is None or engine.tick_size <= 0:
            return []
        bh = engine.get_buffer().shape[0]
        return [
            (engine.center_price_ticks + (bh // 2 - r)) * engine.tick_size
            for r in range(bh)
        ]

    # ── Public API ────────────────────────────────────────────────

    def push_snapshot(self, levels: list[BookLevel], bbo: Optional[BBO], receive_timestamp: float = 0.0) -> None:
        """Feed one tick of data. Called from main window timer."""
        if not levels:
            return
        self._levels = levels
        self._bbo = bbo
        self._history.append((levels, bbo))  # Keep track of history for compatibility
        self._all_prices.update(level.price for level in levels)
        self._last_receive_timestamp = receive_timestamp or (bbo.receive_timestamp if bbo else 0.0)

        vr = max(1, self.height() // self.row_height)
        hm_w = max(1, self.width() - self.price_axis_w)

        # Resize/Rebuild engine if needed
        if vr != self._last_vis_rows or hm_w != self._last_hm_w:
            self.rebuild_heatmap()
        else:
            self._engine.push_snapshot(levels, bbo, auto_follow=self.auto_follow)
            self._last_vis_rows = vr
            self._last_hm_w = hm_w
            self._frame_count += 1
            self.update()

    def set_levels(self, levels: list[BookLevel]) -> None:
        """Compatibility method for set_levels."""
        self.push_snapshot(levels, self._bbo)

    def set_bbo(self, bbo: Optional[BBO]) -> None:
        """Compatibility method for set_bbo."""
        self._bbo = bbo
        if self._history:
            last_levels, _ = self._history[-1]
            self._history[-1] = (last_levels, bbo)
        self.update()

    def add_trade(self, price: float, size: float, side: Side, is_liquidation: bool = False) -> None:
        """Record a trade for the dot overlay and volume bubbles."""
        self._trades.append((price, size, side, time.time(), self._frame_count))
        self._bubbles.add_trade(price, size, side, self._frame_count)
        if is_liquidation:
            self._liquidations.append({
                'price': price,
                'size': size,
                'side': side,
                'tick_index': self._frame_count
            })

    def rebuild_heatmap(self) -> None:
        """Fully rebuild/re-render the entire heatmap buffer from history."""
        vr = max(1, self.height() // self.row_height)
        hm_w = max(1, self.width() - self.price_axis_w)
        
        # 1. Clear engine buffer and state
        self._engine._bid_density.clear()
        self._engine._ask_density.clear()
        self._engine.center_price_ticks = None
        self._engine._center_price_ticks_float = None
        self._engine._in_recenter_drift = False
        self._engine._price_history.clear()
        self._engine._bbo_history.clear()
        self._engine._tick_size_detected = False
        self._engine.tick_size = 0.05
        
        # Resize engine buffer to the new size and fill with BG_COLOR
        self._engine.resize(vr, hm_w)
        self._engine.get_buffer()[:] = ColorSystem.BG_COLOR
        
        # 2. Re-push all historical snapshots through the engine
        history_list = list(self._history)
        if len(history_list) > hm_w:
            history_list = history_list[-hm_w:]
            
        for hist_levels, hist_bbo in history_list:
            self._engine.push_snapshot(hist_levels, hist_bbo, auto_follow=self.auto_follow)
            
        self._last_vis_rows = vr
        self._last_hm_w = hm_w
        self._frame_count = len(history_list)
        self.update()

    def set_row_height(self, h: int) -> None:
        self.zoom_to_height(h)

    def zoom_to_height(self, h: int) -> None:
        old_h = self.row_height
        new_h = max(self._min_rh, min(self._max_rh, h))
        if old_h == new_h:
            return

        self.row_height = new_h
        self.rebuild_heatmap()
        
        # Update hover price under cursor
        engine = self._engine
        vr = max(1, self.height() // new_h)
        if self._my >= 0 and engine.center_price_ticks is not None and engine.tick_size > 0:
            row = self._my * vr / max(1, self.height()) - 0.5
            p_ticks = engine.center_price_ticks + (vr // 2 - row)
            self._hover_price = round(p_ticks) * engine.tick_size
            self.price_hovered.emit(self._hover_price)

        self.row_height_changed.emit(self.row_height)

    def set_decay(self, d: float) -> None:
        self._engine.set_decay(d)

    def set_vertical_smoothing(self, s: float) -> None:
        self._engine.set_vertical_smoothing(s)
        self.update()

    def set_auto_follow(self, e: bool) -> None:
        self.auto_follow = e

    def zoom_in(self) -> None:
        self.zoom_to_height(self.row_height + 1)

    def zoom_out(self) -> None:
        self.zoom_to_height(self.row_height - 1)

    def reset_view(self) -> None:
        self.row_height = 4
        self.auto_follow = True
        self.rebuild_heatmap()

    def render(self, target, targetOffset=None, sourceRegion=None, flags=None):
        try:
            args = [target]
            if targetOffset is not None:
                args.append(targetOffset)
            if sourceRegion is not None:
                args.append(sourceRegion)
            if flags is not None:
                args.append(flags)
            super().render(*args)
        except Exception as e:
            if hasattr(self, 'grabFramebuffer'):
                try:
                    img = self.grabFramebuffer()
                    from PyQt6.QtGui import QPainter, QPixmap
                    if isinstance(target, QPixmap):
                        painter = QPainter(target)
                        painter.drawImage(0, 0, img)
                        painter.end()
                    return
                except (AttributeError, RuntimeError):
                    pass
            raise e

    # ── paintEvent ────────────────────────────────────────────────

    def paintEvent(self, event: QPaintEvent) -> None:
        if self._last_receive_timestamp > 0.0:
            now_time = time.time()
            latency = now_time - self._last_receive_timestamp
            if 0.0 <= latency < 10.0:
                self._latency_history.append(latency * 1000.0)
                if len(self._latency_history) > 30:
                    self._latency_history.pop(0)
                self.last_latency_ms = sum(self._latency_history) / len(self._latency_history)
        else:
            self.last_latency_ms = None

        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        ww, wh = self.width(), self.height()

        # Fill background
        p.fillRect(0, 0, ww, wh, Colors.BG_DEEP)

        if len(self._levels) > 0:
            buf = self._engine.get_buffer()
            bh, bw = buf.shape[0], buf.shape[1]
            if bh > 0 and bw > 0:
                hm_left = 0
                hm_w = ww - self.price_axis_w

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

                # Draw BBO history lines
                self._draw_bbo_history_lines(p, ww, wh, hm_w)

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

                # Draw BBO current lines (on top of price axis to ensure readability)
                if self.show_bbo and self._bbo:
                    self._draw_bbo_lines(p, ww, wh, hm_left)
        else:
            # No data state
            p.setPen(Colors.TEXT_SECONDARY)
            p.setFont(Fonts.sans(13))
            p.drawText(
                self.rect(),
                Qt.AlignmentFlag.AlignCenter,
                "No data — Start simulation",
            )

        # Draw latency overlay in top-right of heatmap
        if self.last_latency_ms is not None:
            p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
            p.setFont(Fonts.mono(9, bold=True))
            lat_str = f"WS-to-UI: {self.last_latency_ms:.1f}ms"
            fm = p.fontMetrics()
            tw = fm.horizontalAdvance(lat_str)
            th = fm.height()
            
            hm_w = ww - self.price_axis_w
            px = hm_w - tw - 12
            py = 10
            
            p.setBrush(QBrush(QColor(0, 0, 0, 160)))
            p.setPen(Qt.PenStyle.NoPen)
            p.drawRoundedRect(QRectF(px - 6, py - 4, tw + 12, th + 8), 4.0, 4.0)
            
            if self.last_latency_ms <= 20.0:
                p.setPen(QColor("#00E676"))  # bright green
            elif self.last_latency_ms <= 50.0:
                p.setPen(QColor("#FFD600"))  # bright yellow
            else:
                p.setPen(QColor("#FF1744"))  # bright red
                
            p.drawText(QPointF(px, py + th - 2), lat_str)
            p.setRenderHint(QPainter.RenderHint.Antialiasing, False)

        # Crosshair
        if self._my >= 0 and self._hover_price is not None:
            p.setPen(QPen(QColor(Colors.TEXT_SECONDARY.red(), Colors.TEXT_SECONDARY.green(), Colors.TEXT_SECONDARY.blue(), 90), 1, Qt.PenStyle.DashLine))
            p.drawLine(0, self._my, ww, self._my)
            p.setPen(Colors.TEXT_BRIGHT)
            p.setFont(Fonts.mono(10, bold=True))
            p.drawText(QPointF(4.0, float(self._my - 4)), f"{self._hover_price:.2f}")

        p.end()

    def _draw_bbo_history_lines(
        self, p: QPainter, ww: int, wh: int, hm_w: int
    ) -> None:
        """Historical BBO lines are now drawn directly in the numpy buffer column."""
        pass

    def _draw_bbo_lines(
        self, p: QPainter, ww: int, wh: int, hm_left: int
    ) -> None:
        """Draw bright bid (green) and ask (red) lines at BBO prices."""
        if not self._bbo or not self._levels:
            return

        hm_w = ww - self.price_axis_w

        for price, color, label in [
            (
                self._bbo.bid,
                QColor(Colors.ACCENT_GREEN.red(), Colors.ACCENT_GREEN.green(), Colors.ACCENT_GREEN.blue(), 255),
                f"{self._bbo.bid:.2f}",
            ),
            (
                self._bbo.ask,
                QColor(Colors.ACCENT_RED.red(), Colors.ACCENT_RED.green(), Colors.ACCENT_RED.blue(), 255),
                f"{self._bbo.ask:.2f}",
            ),
        ]:
            y = self._price_to_screen_y(price, wh)
            if 0 <= y < wh:
                p.setPen(QPen(color, 2, Qt.PenStyle.SolidLine))
                p.drawLine(QPointF(hm_left, y), QPointF(hm_w, y))
                p.setPen(Colors.ACCENT_YELLOW)
                font = Fonts.mono(9, bold=True)
                p.setFont(font)
                fm = QFontMetrics(font)
                tw = fm.horizontalAdvance(label)
                p.drawText(QPointF(ww - tw - 4, y - 2), label)

    def _draw_trades(
        self, p: QPainter, ww: int, wh: int, hm_w: int
    ) -> None:
        """Draw trade dots at price positions."""
        if not self._levels:
            return
        now_ts = time.time()
        buf = self._engine.get_buffer()
        bw = buf.shape[1]
        if bw <= 0:
            return

        engine = self._engine
        if engine.center_price_ticks is None or engine.tick_size <= 0:
            return
        bh = buf.shape[0]
        tick_size = engine.tick_size
        center_price_ticks = engine.center_price_ticks
        y_scale = wh / bh
        y_offset = y_scale / 2.0
        half_bh = bh // 2

        green_r, green_g, green_b = Colors.ACCENT_GREEN.red(), Colors.ACCENT_GREEN.green(), Colors.ACCENT_GREEN.blue()
        red_r, red_g, red_b = Colors.ACCENT_RED.red(), Colors.ACCENT_RED.green(), Colors.ACCENT_RED.blue()

        p.setPen(Qt.PenStyle.NoPen)
        brush = QBrush(Qt.BrushStyle.SolidPattern)

        for t in self._trades:
            if len(t) == 5:
                price, sz, side, ts, tick_index = t
            else:
                price, sz, side, ts = t
                tick_index = self._frame_count

            age = now_ts - ts
            if age > 2.0:
                continue

            col = bw - self._frame_count + tick_index
            if not (0 <= col < bw):
                continue
            x = col * hm_w / bw

            a = int(max(30, 230 * (1 - age / 2)))
            if side == Side.BUY:
                brush.setColor(QColor(green_r, green_g, green_b, a))
            else:
                brush.setColor(QColor(red_r, red_g, red_b, a))
            p.setBrush(brush)

            row = half_bh - (price / tick_size - center_price_ticks)
            y = row * y_scale + y_offset
            if 0 <= y < wh:
                r = max(1, min(4, int(1 + sz * 0.01)))
                p.drawEllipse(QPointF(x, y), r, r)

    def _draw_liquidations(
        self, p: QPainter, ww: int, wh: int, hm_w: int
    ) -> None:
        """Draw liquidation bubbles and horizontal tracking lines."""
        if not self._liquidations:
            return

        buf = self._engine.get_buffer()
        bw = buf.shape[1]
        if bw <= 0:
            return

        engine = self._engine
        if engine.center_price_ticks is None or engine.tick_size <= 0:
            return
        bh = buf.shape[0]
        tick_size = engine.tick_size
        center_price_ticks = engine.center_price_ticks
        y_scale = wh / bh
        y_offset = y_scale / 2.0
        half_bh = bh // 2

        white_r, white_g, white_b = Colors.TEXT_BRIGHT.red(), Colors.TEXT_BRIGHT.green(), Colors.TEXT_BRIGHT.blue()

        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        
        pen_track = QPen(Qt.PenStyle.DashLine)
        pen_track.setWidthF(1.5)
        
        pen_border = QPen()
        pen_border.setWidthF(1.5)
        
        brush_bubble = QBrush(Qt.BrushStyle.SolidPattern)

        for liq in list(self._liquidations):
            col = bw - self._frame_count + liq['tick_index']
            if col < 0 or col >= bw:
                continue
            x = col * hm_w / bw
            
            row = half_bh - (liq['price'] / tick_size - center_price_ticks)
            y = row * y_scale + y_offset
            if not (0 <= y < wh):
                continue

            radius = max(5.0, min(18.0, 3.0 + math.log2(1.0 + liq['size']) * 1.5))
            age_ticks = bw - 1 - col
            alpha = max(30, int(220 * (1.0 - age_ticks / bw)))

            # Magenta for sell liquidations (longs), cyan for buy liquidations (shorts)
            if liq['side'] == Side.SELL:
                color = QColor(255, 0, 128, alpha)
            else:
                color = QColor(0, 191, 255, alpha)

            # Draw liquidation track line
            pen_track.setColor(color)
            p.setPen(pen_track)
            p.drawLine(QPointF(x, y), QPointF(hm_w, y))

            # Draw liquidation bubble
            pen_border.setColor(QColor(white_r, white_g, white_b, alpha))
            p.setPen(pen_border)
            
            brush_bubble.setColor(color)
            p.setBrush(brush_bubble)
            p.drawEllipse(QPointF(x, y), radius, radius)
            
        p.setRenderHint(QPainter.RenderHint.Antialiasing, False)

    def _draw_price_axis(self, p: QPainter, ww: int, wh: int) -> None:
        """Draw price labels on the right edge at clean linear intervals."""
        engine = self._engine
        if engine.center_price_ticks is None or engine.tick_size <= 0:
            return
        bh = engine.get_buffer().shape[0]

        p.setPen(Colors.TEXT_SECONDARY)
        p.setFont(Fonts.mono(8))
        fm = QFontMetrics(p.font())

        seen_prices = set()
        # Clean vertical step for price labels
        for y in range(20, wh - 10, 40):
            row = y * bh / wh - 0.5
            p_ticks = engine.center_price_ticks + (bh // 2 - row)
            rounded_ticks = round(p_ticks)
            price = rounded_ticks * engine.tick_size
            if price in seen_prices:
                continue
            seen_prices.add(price)
            
            # Recalculate exact Y coordinate for the rounded tick to ensure perfect vertical alignment
            row_tick = (bh // 2) - (rounded_ticks - engine.center_price_ticks)
            y_tick = row_tick * wh / bh + (wh / bh) / 2.0
            
            txt = f"{price:.2f}"
            tw = fm.horizontalAdvance(txt)
            p.drawText(QPointF(ww - tw - 4, y_tick + 4), txt)

    # ── Mouse events ──────────────────────────────────────────────

    def mouseMoveEvent(self, e: QMouseEvent) -> None:
        self._my = int(e.position().y())
        self._mx = int(e.position().x())
        engine = self._engine
        
        if self._drag_active and self._drag_start_center_float is not None and engine.center_price_ticks is not None:
            delta_pos = e.position() - self._drag_start_pos
            dy = delta_pos.y()
            if abs(dy) > 3 or self._drag_occurred:
                self._drag_occurred = True
                self.auto_follow = False  # disable follow during manual drag
                bh = engine.get_buffer().shape[0]
                dy_ticks = dy * bh / max(1, self.height())
                target_center_float = self._drag_start_center_float + dy_ticks
                target_center_ticks = int(round(target_center_float))
                
                delta_ticks = target_center_ticks - engine.center_price_ticks
                if delta_ticks != 0:
                    engine._buffer = np.roll(engine._buffer, delta_ticks, axis=0)
                    if delta_ticks > 0:
                        engine._buffer[:delta_ticks, :, :] = ColorSystem.BG_COLOR
                    else:
                        engine._buffer[delta_ticks:, :, :] = ColorSystem.BG_COLOR
                    engine.center_price_ticks = target_center_ticks
                engine._center_price_ticks_float = target_center_float

        if engine.center_price_ticks is not None and engine.tick_size > 0:
            bh = engine.get_buffer().shape[0]
            row = self._my * bh / max(1, self.height()) - 0.5
            p_ticks = engine.center_price_ticks + (bh // 2 - row)
            price = round(p_ticks) * engine.tick_size
            self._hover_price = price
            self.price_hovered.emit(price)
            
        self.update()

    def leaveEvent(self, e) -> None:
        self._my = -1
        self._hover_price = None
        self.update()

    def mousePressEvent(self, e: QMouseEvent) -> None:
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_active = True
            self._drag_start_pos = e.position()
            self._drag_start_center_float = self._engine._center_price_ticks_float
            self._drag_occurred = False

    def mouseReleaseEvent(self, e: QMouseEvent) -> None:
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_active = False
            if not self._drag_occurred and self._hover_price:
                self.price_clicked.emit(self._hover_price)

    def wheelEvent(self, e: QWheelEvent) -> None:
        d = e.angleDelta().y()
        if abs(d) < 1:
            return

        if e.modifiers() & Qt.KeyboardModifier.ControlModifier:
            if d > 0:
                self.zoom_in()
            else:
                self.zoom_out()
        else:
            # Mouse-wheel panning (scroll up/down)
            engine = self._engine
            if engine.center_price_ticks is not None and engine.tick_size > 0:
                self.auto_follow = False  # Disable follow on manual scroll
                
                detents = d / 120.0
                scroll_ticks = int(round(detents * 3))
                if scroll_ticks == 0:
                    scroll_ticks = 1 if d > 0 else -1
                
                target_center_ticks = engine.center_price_ticks + scroll_ticks
                delta_ticks = target_center_ticks - engine.center_price_ticks
                if delta_ticks != 0:
                    engine._buffer = np.roll(engine._buffer, delta_ticks, axis=0)
                    if delta_ticks > 0:
                        engine._buffer[:delta_ticks, :, :] = ColorSystem.BG_COLOR
                    else:
                        engine._buffer[delta_ticks:, :, :] = ColorSystem.BG_COLOR
                    engine.center_price_ticks = target_center_ticks
                    engine._center_price_ticks_float = float(target_center_ticks)
                    engine._in_recenter_drift = False
                    
                if self._my >= 0:
                    bh = engine.get_buffer().shape[0]
                    row = self._my * bh / max(1, self.height()) - 0.5
                    p_ticks = engine.center_price_ticks + (bh // 2 - row)
                    self._hover_price = round(p_ticks) * engine.tick_size
                    self.price_hovered.emit(self._hover_price)
                    
                self.update()

    def keyPressEvent(self, e: QKeyEvent) -> None:
        k = e.key()
        if k in (Qt.Key.Key_Plus, Qt.Key.Key_Equal):
            self.zoom_in()
        elif k == Qt.Key.Key_Minus:
            self.zoom_out()
        elif k == Qt.Key.Key_R:
            self.reset_view()
        else:
            super().keyPressEvent(e)

    def resizeEvent(self, e) -> None:
        super().resizeEvent(e)
        vr = max(1, self.height() // self.row_height)
        hm_w = max(1, self.width() - self.price_axis_w)
        if vr != self._last_vis_rows or hm_w != self._last_hm_w:
            self._engine.resize(vr, hm_w)
            self._last_vis_rows = vr
            self._last_hm_w = hm_w
            if self._levels:
                self._engine.push_snapshot(self._levels, self._bbo, auto_follow=self.auto_follow)
            self.update()
