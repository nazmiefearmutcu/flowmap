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
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .heatmap_widget import HeatmapWidget

import itertools
from PyQt6.QtCore import Qt, QPointF, QTimer, QRectF
from PyQt6.QtGui import (
    QPainter, QColor, QBrush, QPen, QFont, QFontMetrics,
    QPaintEvent, QAction, QPolygonF,
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

    def __init__(self, parent: Optional[QWidget] = None, heatmap: Optional[HeatmapWidget] = None) -> None:
        super().__init__(parent)
        self._heatmap = heatmap
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

    def set_heatmap(self, heatmap: HeatmapWidget) -> None:
        self._heatmap = heatmap
        self._dirty = True
        self.update()

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
        from flowmap.core import is_buy_side
        delta = size if is_buy_side(side) else -size
        self._current_cvd += delta
        self._cvd_values.append(self._current_cvd)
        self._timestamps.append(time.time())

        # Sweep detection: buffer recent trades
        now_ts = time.time()
        self._recent_trades.append((price, size, side, now_ts))
        self._check_sweep(now_ts)

        self._dirty = True

    def add_trades(self, trades: list[Trade]) -> None:
        """Record multiple trades: update CVD and check for sweeps in batch."""
        if not trades:
            return
        now_ts = time.time()
        from flowmap.core import is_buy_side
        for trade in trades:
            price, size, side = trade.price, trade.size, trade.side
            delta = size if is_buy_side(side) else -size
            self._current_cvd += delta
            self._cvd_values.append(self._current_cvd)
            self._timestamps.append(now_ts)
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

    def _slice_cvd_history(
        self,
        scroll_offset: Optional[int] = None,
        buffer_width: Optional[int] = None,
    ) -> tuple[list[float], list[float], int]:
        """
        Slice engine CVD/timestamp history like the heatmap time window.

        Parameters
        ----------
        scroll_offset :
            Columns back from the live tip. When None, uses
            ``heatmap._scroll_offset`` (0 if no heatmap).
        buffer_width :
            Window length in columns. When None, uses engine buffer width
            (or local deque length without heatmap).

        Returns
        -------
        (cvd_values, timestamps, bw)
        """
        if self._heatmap is not None:
            engine = self._heatmap._engine
            buf = engine.get_buffer()
            bw = int(buffer_width) if buffer_width is not None else int(buf.shape[1])
            history_len = len(engine._cvd_history)
            if scroll_offset is None:
                scroll_offset = int(getattr(self._heatmap, "_scroll_offset", 0) or 0)
            scroll_offset = max(0, int(scroll_offset))
            slice_end = max(0, history_len - scroll_offset)
            slice_start = max(0, slice_end - bw)
            cvd_values = list(itertools.islice(engine._cvd_history, slice_start, slice_end))
            timestamps = list(itertools.islice(engine._timestamp_history, slice_start, slice_end))
            return cvd_values, timestamps, bw

        cvd_values = list(self._cvd_values)
        timestamps = list(self._timestamps)
        bw = int(buffer_width) if buffer_width is not None else len(cvd_values)
        return cvd_values, timestamps, bw

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

        # Compute plot area - aligned horizontally with Heatmap
        ml, mr, mt, mb = self._margin_left, self._margin_right, self._margin_top, self._margin_bottom
        plot_left = 0
        price_axis_w = self._heatmap.price_axis_w if self._heatmap is not None else 62
        plot_right = w - price_axis_w
        plot_top = mt
        plot_bottom = h - mb
        plot_w = plot_right - plot_left
        plot_h = plot_bottom - plot_top

        if plot_w <= 0 or plot_h <= 0:
            painter.end()
            return

        # Background (draw BG_CHART for plot area, and BG_DEEP for axis area)
        painter.fillRect(0, 0, plot_right, h, Colors.BG_CHART)
        painter.fillRect(plot_right, 0, w - plot_right, h, Colors.BG_DEEP)

        # Plot boundary border
        painter.setPen(QPen(Colors.BORDER_CHART, 1))
        painter.drawRect(0, 0, plot_right - 1, h - 1)

        # ── Left axis label ──
        painter.setFont(Fonts.sans(9))
        painter.setPen(self.TEXT_COLOR)
        painter.drawText(8, plot_top + 12, "CVD")

        # ── Resolve Colors for CVD Mode ──
        line_pos, line_neg, fill_pos, fill_neg, sweep_buy, sweep_sell = self._get_colors()

        # ── Get CVD history and engine buffer width ──
        # Align with heatmap time window via optional scroll_offset
        cvd_values, timestamps, bw = self._slice_cvd_history()

        import math
        valid_cvd = [v for v in cvd_values if not math.isnan(v)]
        n = len(cvd_values)
        if n < 2 or len(valid_cvd) < 2 or bw <= 0:
            painter.drawText(
                plot_left, plot_top, plot_w, plot_h,
                Qt.AlignmentFlag.AlignCenter,
                "Waiting for trades…",
            )
            painter.end()
            return

        # Downsample to screen resolution to prevent heavy CPU load on high tick rates/history widths
        step = 1
        if n > plot_w and plot_w > 0:
            step = max(1, n // plot_w)
            cvd_drawn = cvd_values[::step]
            # Ensure the last element is always included to make the live line look responsive
            if (n - 1) % step != 0:
                cvd_drawn.append(next((v for v in reversed(cvd_values) if not math.isnan(v)), 0.0))
        else:
            cvd_drawn = cvd_values

        n_drawn = len(cvd_drawn)

        # Y range (compute based on the visible/drawn slice to stay tight and correct)
        valid_drawn = [v for v in cvd_drawn if not math.isnan(v)]
        min_val = min(valid_drawn) if valid_drawn else 0.0
        max_val = max(valid_drawn) if valid_drawn else 0.0
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

        # Precompute scales and offsets for inline drawing to avoid function call overhead
        y_scale = plot_h / val_range
        x_scale = plot_w / bw

        # Group non-nan points into contiguous segments
        segments = []
        current_segment = []
        
        x_scale_fallback = plot_w / (n - 1) if n > 1 else 1.0
        col_offset = bw - n if self._heatmap is not None else 0
        from PyQt6.QtCore import QPointF
        
        for j, val in enumerate(cvd_drawn):
            if not math.isnan(val):
                if self._heatmap is not None:
                    x = (col_offset + (j * step if j < n_drawn - 1 else n - 1)) * x_scale
                else:
                    x = plot_left + (j * step if j < n_drawn - 1 else n - 1) * x_scale_fallback
                y = plot_top + plot_h - (val - min_val) * y_scale
                current_segment.append(QPointF(x, y))
            else:
                if current_segment:
                    segments.append(current_segment)
                    current_segment = []
        if current_segment:
            segments.append(current_segment)

        # ── Grid ──
        painter.setPen(QPen(self.GRID_COLOR, 1))
        for frac in [0.0, 0.25, 0.5, 0.75, 1.0]:
            gy = plot_top + plot_h * frac
            painter.drawLine(QPointF(plot_left, gy), QPointF(plot_right, gy))

        # ── Zero line ──
        zero_y_plot = plot_top + plot_h - (0.0 - min_val) * y_scale
        if plot_top <= zero_y_plot <= plot_bottom:
            painter.setPen(QPen(self.ZERO_LINE_COLOR, 1, Qt.PenStyle.DashLine))
            painter.drawLine(QPointF(plot_left, zero_y_plot), QPointF(plot_right, zero_y_plot))

        # ── Draw filled areas and lines for each contiguous segment ──
        for segment in segments:
            if len(segment) >= 2:
                # Create a closed polygon at the zero line
                polygon_points = [QPointF(segment[0].x(), zero_y_plot)] + segment + [QPointF(segment[-1].x(), zero_y_plot)]
                poly = QPolygonF(polygon_points)
                line_poly = QPolygonF(segment)

                # 1. Positive area (above zero line, y < zero_y_plot)
                painter.save()
                rect_top = QRectF(plot_left, plot_top, plot_w, max(0.0, zero_y_plot - plot_top))
                painter.setClipRect(rect_top)
                # Fill
                painter.setBrush(QBrush(fill_pos))
                painter.setPen(Qt.PenStyle.NoPen)
                painter.drawPolygon(poly)
                # Line
                painter.setPen(QPen(line_pos, 1.5))
                painter.setBrush(Qt.BrushStyle.NoBrush)
                painter.drawPolyline(line_poly)
                painter.restore()

                # 2. Negative area (below zero line, y > zero_y_plot)
                painter.save()
                rect_bottom = QRectF(plot_left, zero_y_plot, plot_w, max(0.0, plot_bottom - zero_y_plot))
                painter.setClipRect(rect_bottom)
                # Fill
                painter.setBrush(QBrush(fill_neg))
                painter.setPen(Qt.PenStyle.NoPen)
                painter.drawPolygon(poly)
                # Line
                painter.setPen(QPen(line_neg, 1.5))
                painter.setBrush(Qt.BrushStyle.NoBrush)
                painter.drawPolyline(line_poly)
                painter.restore()
            elif len(segment) == 1:
                # Draw a single point for single-trade segments
                painter.save()
                pt = segment[0]
                painter.setPen(QPen(line_pos if pt.y() < zero_y_plot else line_neg, 3))
                painter.drawPoint(pt)
                painter.restore()

        # ── Latest CVD badge (in the axis column: w - 60 to w - 2) ──
        latest = next((v for v in reversed(cvd_values) if not math.isnan(v)), 0.0)
        latest_y = plot_top + plot_h - (latest - min_val) * y_scale

        # ── Sweep markers with fast bisect search and pulse oscillations ──
        import bisect
        now_ts = time.time()
        for sweep in self._sweeps:
            age = now_ts - sweep.timestamp
            if age > 3.0:
                continue

            # Bisect search (O(log N)) to find closest timeline column
            idx = bisect.bisect_left(timestamps, sweep.timestamp)
            best_idx = -1
            min_diff = float('inf')
            for check_idx in (idx - 1, idx, idx + 1):
                if 0 <= check_idx < len(timestamps):
                    diff = abs(timestamps[check_idx] - sweep.timestamp)
                    if diff < min_diff:
                        min_diff = diff
                        best_idx = check_idx

            if best_idx != -1 and min_diff < 1.5:  # must match within 1.5 seconds of data
                drawn_idx = min(n_drawn - 1, best_idx // step)
                val = cvd_drawn[drawn_idx]
                if not math.isnan(val):
                    if self._heatmap is not None:
                        sx = (col_offset + (drawn_idx * step if drawn_idx < n_drawn - 1 else n - 1)) * x_scale
                    else:
                        sx = plot_left + (drawn_idx * step if drawn_idx < n_drawn - 1 else n - 1) * x_scale_fallback
                    sy = plot_top + plot_h - (val - min_val) * y_scale
                else:
                    sx = plot_right - 12
                    sy = latest_y
            else:
                # If too old or not found, only show near the right edge if we are in live mode (not scrolled)
                is_live = True
                if self._heatmap is not None:
                    is_live = self._heatmap.auto_follow and (self._heatmap._scroll_offset == 0)

                if is_live and age < 1.5: # only show extremely recent sweeps near right edge
                    sx = plot_right - 12
                    sy = latest_y
                else:
                    continue

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

        painter.setFont(Fonts.mono(8, bold=True))
        fm = QFontMetrics(painter.font())
        sign = '+' if latest >= 0 else ''
        label_text = f"{sign}{latest:,.0f}"
        tw = fm.horizontalAdvance(label_text)

        badge_w = 58
        badge_h = fm.height() + 4
        badge_x = w - 60
        badge_y = latest_y - badge_h / 2
        badge_y = max(2.0, min(h - badge_h - 2, badge_y))

        # Badge color (green if positive, red if negative)
        badge_color = line_pos if latest >= 0 else line_neg
        painter.setBrush(QBrush(badge_color))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawRoundedRect(QRectF(badge_x, badge_y, badge_w, badge_h), 3, 3)

        # Text inside badge (black)
        painter.setPen(QColor("#000000"))
        tx = badge_x + (badge_w - tw) / 2
        ty = badge_y + fm.ascent() + 2
        painter.drawText(int(tx), int(ty), label_text)

        # ── Bottom axis ──
        painter.setFont(Fonts.sans(8))
        painter.setPen(self.AXIS_COLOR)
        painter.drawText(int(plot_left) + 8, h - 2, "Time →")

        painter.end()
