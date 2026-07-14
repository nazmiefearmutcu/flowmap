"""
CVD (Cumulative Volume Delta) Panel — line chart below the heatmap.

CVD = cumulative Σ(buy_volume - sell_volume) over time.
Shows a sliding window of ~200 data points as a line chart with a
filled area under the curve.
"""
from __future__ import annotations
import math
from typing import Optional
from collections import deque

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QPainter, QPen, QBrush, QColor, QFont, QPaintEvent
from PyQt6.QtWidgets import QWidget, QSizePolicy

from ...core import Side, is_buy_side


class CVDOverlay(QWidget):
    """
    Cumulative Volume Delta line chart panel.

    Designed to sit below the heatmap.  Draws CVD as a simple
    line chart using QPainter — no external charting library.

    Methods
    -------
    add_trade(price, size, side) : record a trade and update CVD
    reset() : clear all data
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(120)
        self.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Fixed,
        )

        # ── Data ──
        self._window_size: int = 200
        self._cvd_values: deque[float] = deque(maxlen=self._window_size)
        self._timestamps: deque[float] = deque(maxlen=self._window_size)
        self._current_cvd: float = 0.0

        # ── Appearance ──
        self.bg_color = QColor(18, 18, 22)
        self.grid_color = QColor(35, 35, 45)
        self.text_color = QColor(180, 180, 190)
        self.line_positive = QColor(40, 200, 80)     # Green
        self.line_negative = QColor(220, 60, 60)      # Red
        self.fill_positive = QColor(40, 200, 80, 76)  # 30% alpha
        self.fill_negative = QColor(220, 60, 60, 76)  # 30% alpha
        self.zero_color = QColor(100, 100, 110, 160)

        # Margins
        self._margin_left: int = 10
        self._margin_right: int = 10
        self._margin_top: int = 20
        self._margin_bottom: int = 4

        # Bootstrap initial data so the panel always has something
        self._cvd_values.append(0.0)
        self._timestamps.append(0.0)

    # ── Public API ─────────────────────────────────────────────

    def add_trade(self, price: float, size: float, side: Side) -> None:
        """
        Record a trade and update the cumulative CVD.

        Parameters
        ----------
        price : float  (used for potential future price-weighted delta)
        size : float
        side : Side — BUY adds volume, SELL subtracts volume
        """
        import time
        delta = size if is_buy_side(side) else -size
        self._current_cvd += delta
        self._cvd_values.append(self._current_cvd)
        self._timestamps.append(time.time())
        self.update()

    def reset(self) -> None:
        """Clear all CVD data and reset to zero."""
        self._cvd_values.clear()
        self._timestamps.clear()
        self._current_cvd = 0.0
        self._cvd_values.append(0.0)
        self._timestamps.append(0.0)
        self.update()

    @property
    def cvd(self) -> float:
        """Latest cumulative volume delta."""
        return self._current_cvd

    @property
    def count(self) -> int:
        """Number of data points."""
        return len(self._cvd_values)

    # ── Painting ───────────────────────────────────────────────

    def paintEvent(self, event: QPaintEvent) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)

        w, h = self.width(), self.height()

        # Background
        painter.fillRect(0, 0, w, h, self.bg_color)

        n = len(self._cvd_values)
        if n < 2:
            painter.setPen(self.text_color)
            painter.setFont(QFont('Helvetica Neue', 10))
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "CVD — waiting for data")
            painter.end()
            return

        # Plot area
        plot_left = self._margin_left
        plot_right = w - self._margin_right
        plot_top = self._margin_top
        plot_bottom = h - self._margin_bottom
        plot_w = plot_right - plot_left
        plot_h = plot_bottom - plot_top

        if plot_w <= 0 or plot_h <= 0:
            painter.end()
            return

        # Compute Y range
        min_val = min(self._cvd_values)
        max_val = max(self._cvd_values)
        val_range = max_val - min_val
        if val_range < 0.01:
            val_range = 1.0  # avoid division by zero
            mid = (max_val + min_val) / 2.0
            min_val = mid - 0.5
            max_val = mid + 0.5

        # Add padding
        padding = val_range * 0.1
        min_val -= padding
        max_val += padding
        val_range = max_val - min_val

        def y_of(value: float) -> float:
            return plot_top + plot_h * (1.0 - (value - min_val) / val_range)

        def x_of(idx: int) -> float:
            if n <= 1:
                return plot_left
            return plot_left + (idx / (n - 1)) * plot_w

        # ── Grid lines (horizontal) ──
        painter.setPen(QPen(self.grid_color, 1))
        for frac in [0.0, 0.25, 0.50, 0.75, 1.0]:
            gy = plot_top + plot_h * frac
            painter.drawLine(int(plot_left), int(gy), int(plot_right), int(gy))

        # ── Zero line ──
        zero_y = y_of(0.0)
        if plot_top <= zero_y <= plot_bottom:
            painter.setPen(QPen(self.zero_color, 1, Qt.PenStyle.DashLine))
            painter.drawLine(int(plot_left), int(zero_y), int(plot_right), int(zero_y))

        # ── Build point lists ──
        points: list[tuple[float, float]] = []
        for i in range(n):
            x = x_of(i)
            y = y_of(self._cvd_values[i])
            points.append((x, y))

        # ── Filled area ──
        # Draw filled area below zero (red tint) and above zero (green tint)
        # We do this by drawing two polygons: one for the portion above 0, one below.
        zero_y_plot = y_of(0.0)

        # Build the filled polygon above zero — walk points, drop segments below zero
        poly_above: list[tuple[float, float]] = []
        poly_below: list[tuple[float, float]] = []

        for i in range(n - 1):
            x1, y1 = points[i]
            x2, y2 = points[i + 1]
            v1 = self._cvd_values[i]
            v2 = self._cvd_values[i + 1]

            # Segment above zero
            if v1 >= 0 and v2 >= 0:
                poly_above.append((x1, y1))
                poly_above.append((x2, y2))
            elif v1 <= 0 and v2 <= 0:
                poly_below.append((x1, y1))
                poly_below.append((x2, y2))
            else:
                # Crosses zero — find intersection
                t = (0.0 - v1) / (v2 - v1)
                ix = x1 + t * (x2 - x1)
                iy = y1 + t * (y2 - y1)

                if v1 >= 0:
                    poly_above.append((x1, y1))
                    poly_above.append((ix, iy))
                    poly_below.append((ix, iy))
                    poly_below.append((x2, y2))
                else:
                    poly_below.append((x1, y1))
                    poly_below.append((ix, iy))
                    poly_above.append((ix, iy))
                    poly_above.append((x2, y2))

        def draw_fill(poly: list, color: QColor, base_y: float) -> None:
            if len(poly) < 2:
                return
            # Close the polygon down to the base line
            path_pts = poly.copy()
            path_pts.append((poly[-1][0], base_y))
            path_pts.append((poly[0][0], base_y))
            path_pts.append((poly[0][0], poly[0][1]))

            # Build flat list of QPointF for QPainterPath-like fill via polygon
            from PyQt6.QtCore import QPointF
            qpoints = [QPointF(p[0], p[1]) for p in path_pts]

            painter.setBrush(QBrush(color))
            painter.setPen(Qt.PenStyle.NoPen)
            painter.drawPolygon(*qpoints)

        draw_fill(poly_above, self.fill_positive, zero_y_plot)
        draw_fill(poly_below, self.fill_negative, zero_y_plot)

        # ── Line ──
        painter.setPen(QPen(self.line_positive, 2))
        for i in range(n - 1):
            x1, y1 = points[i]
            x2, y2 = points[i + 1]

            # Choose segment color based on endpoint
            cvd_i = self._cvd_values[i]
            cvd_j = self._cvd_values[i + 1]
            seg_color = self.line_positive if cvd_j >= 0 else self.line_negative

            painter.setPen(QPen(seg_color, 2))
            painter.drawLine(int(x1), int(y1), int(x2), int(y2))

        # ── Value label (right side) ──
        latest_cvd = self._cvd_values[-1]
        latest_y = y_of(latest_cvd)
        label_color = self.line_positive if latest_cvd >= 0 else self.line_negative

        painter.setFont(QFont('Menlo', 10, QFont.Weight.Bold))
        painter.setPen(label_color)
        label_text = f"{latest_cvd:+.2f}" if abs(latest_cvd) >= 0.01 else f"{latest_cvd:.2f}"

        fm = painter.fontMetrics()
        label_w = fm.horizontalAdvance(label_text) + 6

        # Clip label inside widget
        label_x = min(plot_right - label_w - 2, plot_right - label_w)
        label_x = max(plot_left, label_x)
        label_y = max(plot_top + fm.ascent(), min(plot_bottom, int(latest_y)))

        painter.drawText(label_x, label_y, label_text)

        # ── Label at top-left ──
        painter.setFont(QFont('Helvetica Neue', 9))
        painter.setPen(self.text_color)
        painter.drawText(plot_left + 4, plot_top + 12, "CVD")

        painter.end()
