"""
Market Pulse — Cumulative Volume Delta (CVD) + Sweep Detection panel.

A bottom-docked panel showing:
- Green/red filled area chart of cumulative volume delta over time
- Sweep detection: highlights large aggressive trades that "sweep"
  multiple price levels in rapid succession
- Dark theme, compact design

Designed to be embedded as a QDockWidget in the main window.
"""

from __future__ import annotations

import math
import time
from collections import deque
from enum import Enum
from typing import Optional

from PyQt6.QtCore import Qt, QPointF, QTimer
from PyQt6.QtGui import (
    QPainter, QColor, QBrush, QPen, QFont, QFontMetrics,
    QPaintEvent, QAction,
)
from PyQt6.QtWidgets import QWidget, QSizePolicy, QMenu

from ..core import Side
from .theme import Colors, Fonts


class ColorVisionMode(Enum):
    NORMAL = "Normal (Red/Green)"
    DEUTERANOPIA = "Deuteranopia (Red-Green Blind)"
    PROTANOPIA = "Protanopia (Red-Green Blind)"
    TRITANOPIA = "Tritanopia (Blue-Yellow Blind)"


class SweepEvent:
    """A detected sweep: a burst of large aggressive trades."""

    __slots__ = ('timestamp', 'side', 'total_size', 'trade_count', 'price_range')

    def __init__(
        self,
        timestamp: float,
        side: Side,
        total_size: float,
        trade_count: int,
        price_range: float,
    ) -> None:
        self.timestamp = timestamp
        self.side = side
        self.total_size = total_size
        self.trade_count = trade_count
        self.price_range = price_range

    @property
    def age(self) -> float:
        return time.time() - self.timestamp


class MarketPulse(QWidget):
    """
    Cumulative Volume Delta panel with sweep detection.

    Features:
    - Sliding window CVD line chart (green above zero, red below)
    - Filled area under the curve
    - Sweep markers for large trade bursts
    - Compact label showing current CVD value
    """

    # ── Appearance constants (from theme) ──
    BG_COLOR = Colors.BG_DEEP
    GRID_COLOR = Colors.BORDER_SUBTLE
    TEXT_COLOR = Colors.TEXT_SECONDARY
    AXIS_COLOR = Colors.TEXT_DIM
    ZERO_LINE_COLOR = Colors.CHART_ZERO

    LINE_POSITIVE = Colors.CVD_POSITIVE_LINE
    LINE_NEGATIVE = Colors.CVD_NEGATIVE_LINE
    FILL_POSITIVE = Colors.CVD_POSITIVE_FILL
    FILL_NEGATIVE = Colors.CVD_NEGATIVE_FILL

    SWEEP_BUY_COLOR = QColor(60, 255, 120, 200)
    SWEEP_SELL_COLOR = QColor(255, 70, 70, 200)

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(100)
        self.setMaximumHeight(180)
        self.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Fixed,
        )
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)
        self.setAutoFillBackground(False)

        # ── Color Vision Deficiency (CVD) Mode ──
        self._cvd_mode: ColorVisionMode = ColorVisionMode.NORMAL

        # ── Data ──
        self._window_size: int = 300
        self._cvd_values: deque[float] = deque(maxlen=self._window_size)
        self._timestamps: deque[float] = deque(maxlen=self._window_size)
        self._current_cvd: float = 0.0

        # Sweep detection
        self._sweeps: deque[SweepEvent] = deque(maxlen=20)
        # Recent trade buffer for sweep detection
        self._recent_trades: deque[tuple[float, float, Side, float]] = deque(maxlen=30)
        self._sweep_threshold: float = 0.5   # Min size to trigger sweep check
        self._sweep_time_window: float = 0.3  # Seconds to aggregate
        self._sweep_count_min: int = 3        # Min trades in window

        # ── Margins ──
        self._margin_left: int = 48
        self._margin_right: int = 8
        self._margin_top: int = 8
        self._margin_bottom: int = 16

        # Bootstrap
        self._cvd_values.append(0.0)
        self._timestamps.append(0.0)

        # Paint throttle
        self._dirty: bool = False
        self._throttle_timer = QTimer(self)
        self._throttle_timer.setInterval(33)  # ~30fps
        self._throttle_timer.timeout.connect(self._on_throttle_tick)
        self._throttle_timer.start()

    def set_color_vision_mode(self, mode: ColorVisionMode) -> None:
        """Change the Color Vision Deficiency rendering mode."""
        self._cvd_mode = mode
        self._dirty = True
        self.update()

    def _get_colors(self) -> tuple[QColor, QColor, QColor, QColor, QColor, QColor]:
        """
        Returns (line_pos, line_neg, fill_pos, fill_neg, sweep_buy, sweep_sell)
        tailored to the active color vision deficiency mode.
        """
        if self._cvd_mode == ColorVisionMode.DEUTERANOPIA:
            # Deuteranopia (green-blind): Use bright sky blue for buy/pos, orange for sell/neg.
            line_pos = QColor(0, 136, 204)
            line_neg = QColor(230, 97, 0)
            fill_pos = QColor(0, 136, 204, 60)
            fill_neg = QColor(230, 97, 0, 60)
            sweep_buy = QColor(0, 136, 204, 200)
            sweep_sell = QColor(230, 97, 0, 200)
        elif self._cvd_mode == ColorVisionMode.PROTANOPIA:
            # Protanopia (red-blind): Sky Blue vs Vermillion/Orange-Red
            line_pos = QColor(86, 180, 233)
            line_neg = QColor(213, 94, 0)
            fill_pos = QColor(86, 180, 233, 60)
            fill_neg = QColor(213, 94, 0, 60)
            sweep_buy = QColor(86, 180, 233, 200)
            sweep_sell = QColor(213, 94, 0, 200)
        elif self._cvd_mode == ColorVisionMode.TRITANOPIA:
            # Tritanopia (blue-blind): Use cyan for positive, magenta/pink for negative.
            line_pos = QColor(0, 200, 200)
            line_neg = QColor(240, 0, 120)
            fill_pos = QColor(0, 200, 200, 60)
            fill_neg = QColor(240, 0, 120, 60)
            sweep_buy = QColor(0, 200, 200, 200)
            sweep_sell = QColor(240, 0, 120, 200)
        else:
            # NORMAL (default)
            line_pos = self.LINE_POSITIVE
            line_neg = self.LINE_NEGATIVE
            fill_pos = self.FILL_POSITIVE
            fill_neg = self.FILL_NEGATIVE
            sweep_buy = self.SWEEP_BUY_COLOR
            sweep_sell = self.SWEEP_SELL_COLOR
            
        return line_pos, line_neg, fill_pos, fill_neg, sweep_buy, sweep_sell

    def contextMenuEvent(self, event) -> None:
        """Right-click context menu to switch Color Vision Deficiency (CVD) modes."""
        menu = QMenu(self)
        menu.setTitle("Color Vision Mode")
        
        for mode in ColorVisionMode:
            action = QAction(mode.value, self)
            action.setCheckable(True)
            action.setChecked(self._cvd_mode == mode)
            action.triggered.connect(lambda checked, m=mode: self.set_color_vision_mode(m))
            menu.addAction(action)
            
        menu.exec(event.globalPos())

    # ── Public API ─────────────────────────────────────────────────

    def add_trade(self, price: float, size: float, side: Side) -> None:
        """
        Record a trade: update CVD and check for sweeps.

        Parameters
        ----------
        price : float
            Trade execution price.
        size : float
            Trade size (volume).
        side : Side
            Aggressor side (BUY or SELL).
        """
        delta = size if side == Side.BUY else -size
        self._current_cvd += delta
        self._cvd_values.append(self._current_cvd)
        self._timestamps.append(time.time())

        # Sweep detection: buffer recent trades
        now_ts = time.time()
        self._recent_trades.append((price, size, side, now_ts))
        self._check_sweep(now_ts)

        self._dirty = True

    def reset(self) -> None:
        """Clear all CVD data and sweeps."""
        self._cvd_values.clear()
        self._timestamps.clear()
        self._current_cvd = 0.0
        self._sweeps.clear()
        self._recent_trades.clear()
        self._cvd_values.append(0.0)
        self._timestamps.append(0.0)
        self._dirty = True
        self.update()

    @property
    def cvd(self) -> float:
        """Latest cumulative volume delta."""
        return self._current_cvd

    @property
    def count(self) -> int:
        """Number of CVD data points in window."""
        return len(self._cvd_values)

    # ── Sweep Detection ────────────────────────────────────────────

    def _check_sweep(self, now_ts: float) -> None:
        """
        Detect sweeps: large aggressive trades in rapid succession.

        A sweep is detected when:
        - Multiple trades (>sweep_count_min) in <sweep_time_window seconds
        - All on the same side (buys or sells)
        - Total size exceeds threshold * some factor
        """
        # Evict expired trades (older than sweep_time_window) from the front
        while self._recent_trades and now_ts - self._recent_trades[0][3] > self._sweep_time_window:
            self._recent_trades.popleft()

        if len(self._recent_trades) < self._sweep_count_min:
            return

        # Check if all trades in window are same side
        first_side = self._recent_trades[0][2]
        same_side = all(t[2] == first_side for t in self._recent_trades)

        if not same_side:
            return

        total_size = sum(t[1] for t in self._recent_trades)
        if total_size < self._sweep_threshold * self._sweep_count_min:
            return

        # Check price range
        prices = [t[0] for t in self._recent_trades]
        price_range = max(prices) - min(prices)

        # Avoid duplicate: check if we already have a recent sweep
        if self._sweeps:
            last = self._sweeps[-1]
            if now_ts - last.timestamp < 0.15 and last.side == first_side:
                # Update existing sweep instead of creating new one
                # We'll just skip — let the old one fade
                return

        sweep = SweepEvent(
            timestamp=now_ts,
            side=first_side,
            total_size=total_size,
            trade_count=len(self._recent_trades),
            price_range=price_range,
        )
        self._sweeps.append(sweep)

    # ── Throttle ───────────────────────────────────────────────────

    def _on_throttle_tick(self) -> None:
        now = time.time()
        
        # Evict expired sweeps (older than 3.0s)
        while self._sweeps and now - self._sweeps[0].timestamp > 3.0:
            self._sweeps.popleft()
            
        # Evict expired recent trades (older than sweep_time_window)
        while self._recent_trades and now - self._recent_trades[0][3] > self._sweep_time_window:
            self._recent_trades.popleft()
            
        has_active_sweeps = len(self._sweeps) > 0
        if self._dirty or has_active_sweeps:
            self._dirty = False
            self.update()

    # ── Painting ───────────────────────────────────────────────────

    def paintEvent(self, event: QPaintEvent) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)

        w, h = self.width(), self.height()

        # Background
        painter.fillRect(0, 0, w, h, self.BG_COLOR)

        # Compute plot area
        ml, mr, mt, mb = self._margin_left, self._margin_right, self._margin_top, self._margin_bottom
        plot_left = ml
        plot_right = w - mr
        plot_top = mt
        plot_bottom = h - mb
        plot_w = plot_right - plot_left
        plot_h = plot_bottom - plot_top

        if plot_w <= 0 or plot_h <= 0:
            painter.end()
            return

        # ── Left axis label ──
        painter.setFont(Fonts.sans(9))
        painter.setPen(self.TEXT_COLOR)
        painter.drawText(4, plot_top + 12, "CVD")

        # ── Resolve Colors for CVD Mode ──
        line_pos, line_neg, fill_pos, fill_neg, sweep_buy, sweep_sell = self._get_colors()

        # ── Draw the chart ──
        n = len(self._cvd_values)
        if n < 2:
            painter.drawText(
                plot_left, plot_top, plot_w, plot_h,
                Qt.AlignmentFlag.AlignCenter,
                "Waiting for data…",
            )
            painter.end()
            return

        # Y range
        min_val = min(self._cvd_values)
        max_val = max(self._cvd_values)
        val_range = max_val - min_val
        if val_range < 0.01:
            val_range = 1.0
            mid = (max_val + min_val) / 2.0
            min_val = mid - 0.5
            max_val = mid + 0.5

        # Padding
        pad = val_range * 0.1
        min_val -= pad
        max_val += pad
        val_range = max_val - min_val

        def y_of(value: float) -> float:
            return plot_top + plot_h * (1.0 - (value - min_val) / val_range)

        def x_of(idx: int) -> float:
            if n <= 1:
                return plot_left
            return plot_left + (idx / (n - 1)) * plot_w

        # ── Grid ──
        painter.setPen(QPen(self.GRID_COLOR, 1))
        for frac in [0.0, 0.25, 0.5, 0.75, 1.0]:
            gy = plot_top + plot_h * frac
            painter.drawLine(QPointF(plot_left, gy), QPointF(plot_right, gy))

        # ── Zero line ──
        zero_y = y_of(0.0)
        if plot_top <= zero_y <= plot_bottom:
            painter.setPen(QPen(self.ZERO_LINE_COLOR, 1, Qt.PenStyle.DashLine))
            painter.drawLine(QPointF(plot_left, zero_y), QPointF(plot_right, zero_y))

        # ── Build point list ──
        points: list[tuple[float, float]] = []
        for i in range(n):
            points.append((x_of(i), y_of(self._cvd_values[i])))

        # ── Filled area (split at zero, grouped into contiguous segments to avoid crossover issues) ──
        zero_y_plot = y_of(0.0)
        current_segment: list[tuple[float, float]] = []
        current_is_positive: Optional[bool] = None

        segments_above: list[list[tuple[float, float]]] = []
        segments_below: list[list[tuple[float, float]]] = []

        for i in range(n - 1):
            x1, y1 = points[i]
            x2, y2 = points[i + 1]
            v1 = self._cvd_values[i]
            v2 = self._cvd_values[i + 1]

            if v1 >= 0 and v2 >= 0:
                if current_is_positive is False:
                    if current_segment:
                        segments_below.append(current_segment)
                    current_segment = []
                current_is_positive = True
                if not current_segment:
                    current_segment.append((x1, y1))
                current_segment.append((x2, y2))
            elif v1 <= 0 and v2 <= 0:
                if current_is_positive is True:
                    if current_segment:
                        segments_above.append(current_segment)
                    current_segment = []
                current_is_positive = False
                if not current_segment:
                    current_segment.append((x1, y1))
                current_segment.append((x2, y2))
            else:
                # Crosses zero
                t = (0.0 - v1) / (v2 - v1) if v2 != v1 else 0.5
                ix = x1 + t * (x2 - x1)
                iy = y1 + t * (y2 - y1)

                if v1 >= 0:
                    # Positive to negative
                    if current_is_positive is True or current_is_positive is None:
                        if not current_segment:
                            current_segment.append((x1, y1))
                        current_segment.append((ix, iy))
                        segments_above.append(current_segment)
                    current_segment = [(ix, iy), (x2, y2)]
                    current_is_positive = False
                else:
                    # Negative to positive
                    if current_is_positive is False or current_is_positive is None:
                        if not current_segment:
                            current_segment.append((x1, y1))
                        current_segment.append((ix, iy))
                        segments_below.append(current_segment)
                    current_segment = [(ix, iy), (x2, y2)]
                    current_is_positive = True

        # Flush the last segment
        if current_segment:
            if current_is_positive:
                segments_above.append(current_segment)
            else:
                segments_below.append(current_segment)

        # Draw filled polygons
        def draw_fill(pts: list[tuple[float, float]], color: QColor, base_y: float) -> None:
            if len(pts) < 2:
                return
            path_pts = list(pts)
            path_pts.append((path_pts[-1][0], base_y))
            path_pts.append((path_pts[0][0], base_y))
            qpoints = [QPointF(p[0], p[1]) for p in path_pts]
            painter.setBrush(QBrush(color))
            painter.setPen(Qt.PenStyle.NoPen)
            painter.drawPolygon(*qpoints)

        for seg in segments_above:
            draw_fill(seg, fill_pos, zero_y_plot)
        for seg in segments_below:
            draw_fill(seg, fill_neg, zero_y_plot)

        # ── Line ──
        for i in range(n - 1):
            x1, y1 = points[i]
            x2, y2 = points[i + 1]
            cvd_j = self._cvd_values[i + 1]
            seg_color = line_pos if cvd_j >= 0 else line_neg
            painter.setPen(QPen(seg_color, 1.5))
            painter.drawLine(QPointF(x1, y1), QPointF(x2, y2))

        # ── Sweep markers with historical alignment and pulse oscillations ──
        now_ts = time.time()
        for sweep in self._sweeps:
            age = now_ts - sweep.timestamp
            if age > 3.0:
                continue

            # Find closest historical index in self._timestamps to match exact timeline position
            best_idx = -1
            min_diff = float('inf')
            for i, ts in enumerate(self._timestamps):
                diff = abs(ts - sweep.timestamp)
                if diff < min_diff:
                    min_diff = diff
                    best_idx = i

            if best_idx != -1 and min_diff < 1.0:  # must match within 1 second of data
                sx = x_of(best_idx)
                sy = y_of(self._cvd_values[best_idx])
            else:
                # If too old or not found, fall back to sliding near the right edge
                sx = plot_right - 12
                sy = y_of(self._current_cvd)

            if plot_top <= sy <= plot_bottom and plot_left <= sx <= plot_right:
                # Fade alpha smoothly over the 3 seconds life
                alpha = max(0, int(200 * (1.0 - age / 3.0)))
                
                # Resolve sweep color based on side
                c_base = sweep_buy if sweep.side == Side.BUY else sweep_sell
                c = QColor(c_base)
                c.setAlpha(alpha)
                
                # Base radius from sweep size
                r_base = 4.0 + sweep.total_size * 0.2
                r_base = max(3.0, min(8.0, r_base))
                
                # 1. Pulsating center core (using a fast sine wave over time)
                t_pulse = time.time() * 12.0  # speed of core pulse
                r_pulse = r_base + math.sin(t_pulse) * 1.5
                r_pulse = max(2.0, r_pulse)
                
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(QBrush(c))
                painter.drawEllipse(QPointF(sx, sy), r_pulse, r_pulse)

                # 2. Concentric expanding "pulse oscillation" ripple rings
                for delay in [0.0, 0.4]:
                    r_age = age - delay
                    if 0.0 <= r_age <= 1.2:
                        progress = r_age / 1.2
                        # Ring expands outwards
                        ripple_r = r_base + progress * 16.0
                        ripple_alpha = int(140 * (1.0 - progress))
                        ripple_color = QColor(c_base)
                        ripple_color.setAlpha(ripple_alpha)
                        
                        painter.setBrush(Qt.BrushStyle.NoBrush)
                        painter.setPen(QPen(ripple_color, 1.0 + (1.0 - progress) * 1.5))
                        painter.drawEllipse(QPointF(sx, sy), ripple_r, ripple_r)

        # ── Latest CVD label (right side) ──
        latest = self._cvd_values[-1]
        latest_y = y_of(latest)
        label_color = line_pos if latest >= 0 else line_neg

        painter.setFont(Fonts.mono(10, bold=True))
        painter.setPen(label_color)
        sign = '+' if latest >= 0 else ''
        label_text = f"{sign}{latest:,.0f}"
        fm = QFontMetrics(painter.font())
        label_w = fm.horizontalAdvance(label_text)
        label_x = plot_right - label_w - 6
        label_y = max(plot_top + fm.ascent() + 2, min(plot_bottom, int(latest_y)))
        painter.drawText(int(label_x), int(label_y), label_text)

        # ── Bottom axis ──
        painter.setFont(Fonts.sans(8))
        painter.setPen(self.AXIS_COLOR)
        painter.drawText(int(plot_left), h - 2, "Time →")

        painter.end()
