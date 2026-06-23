"""
PriceChart — Simple line chart showing mid-price history.

Designed to sit ABOVE the heatmap, sharing time axis.
"""

from __future__ import annotations

from collections import deque

from PyQt6.QtCore import Qt, QRect, pyqtSignal, QPointF, QRectF
from PyQt6.QtGui import (
    QPainter, QColor, QPen, QFont, QPainterPath,
    QPaintEvent, QBrush, QLinearGradient,
)
from PyQt6.QtWidgets import QWidget, QSizePolicy

from .theme import Colors, Fonts


class PriceChart(QWidget):
    """Line chart of mid-price over time. Compact, sits above heatmap."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(120)
        self.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Expanding,
        )
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)

        self._prices: deque = deque(maxlen=600)  # (tick, price)
        self._tick_count: int = 0
        self._min_price: float = 0.0
        self._max_price: float = 0.0
        self._bg_color: QColor = Colors.BG_CHART
        self._line_color: QColor = Colors.CHART_LINE
        self._fill_color: QColor = Colors.CHART_FILL
        self.price_axis_w: int = 62  # Matches HeatmapWidget price_axis_w

    # ── Public API ────────────────────────────────────────────────

    def push_price(self, price: float) -> None:
        """Add a price point."""
        self._tick_count += 1
        self._prices.append((self._tick_count, price))
        if len(self._prices) >= 2:
            recent = [p for _, p in self._prices]
            self._min_price = min(recent) * 0.9995
            self._max_price = max(recent) * 1.0005
            # Ensure minimum Y range (at least 0.5% of price)
            mid = (self._min_price + self._max_price) / 2.0
            min_range = mid * 0.005
            if (self._max_price - self._min_price) < min_range:
                self._min_price = mid - min_range / 2.0
                self._max_price = mid + min_range / 2.0
        self.update()

    def reset(self) -> None:
        """Clear all price history."""
        self._prices.clear()
        self._tick_count = 0
        self._min_price = 0.0
        self._max_price = 0.0
        self.update()

    # ── Paint ─────────────────────────────────────────────────────

    def paintEvent(self, event: QPaintEvent) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        w, h = self.width(), self.height()
        cw = w - self.price_axis_w

        # Background (draw BG_CHART for chart area, and BG_PANEL for price axis area)
        p.fillRect(0, 0, cw, h, self._bg_color)
        p.fillRect(cw, 0, w - cw, h, Colors.BG_PANEL)

        # Vertical separator line to align with HeatmapWidget price axis border
        p.setPen(QPen(Colors.BORDER_MEDIUM, 1.5))
        p.drawLine(QPointF(cw, 0), QPointF(cw, h))

        # Chart boundary border (left, top, bottom)
        p.setPen(QPen(Colors.BORDER_CHART, 1))
        p.drawLine(0, 0, cw - 1, 0)
        p.drawLine(0, h - 1, cw - 1, h - 1)
        p.drawLine(0, 0, 0, h - 1)

        if len(self._prices) < 2:
            p.setPen(Colors.TEXT_DIM)
            p.setFont(Fonts.sans(10))
            p.drawText(
                QRect(0, 0, cw, h),
                Qt.AlignmentFlag.AlignCenter,
                "Price Chart",
            )
            p.end()
            return

        # Build polyline
        prices_list = list(self._prices)
        min_tick = prices_list[0][0]
        max_tick = prices_list[-1][0]
        tick_range = max_tick - min_tick if max_tick > min_tick else 1
        price_range = (
            self._max_price - self._min_price
            if self._max_price > self._min_price
            else 1
        )

        # Draw horizontal grid lines at 25% / 50% / 75%
        grid_pen = QPen(Colors.CHART_GRID, 0.5)
        grid_pen.setStyle(Qt.PenStyle.DashLine)
        p.setPen(grid_pen)
        for frac in (0.25, 0.50, 0.75):
            grid_price = self._min_price + price_range * frac
            y = int(h - (grid_price - self._min_price) / price_range * (h - 20) - 10)
            p.drawLine(0, y, cw, y)

        # Fill area under curve with vertical linear gradient
        path = QPainterPath()
        first_x = 0
        first_y = int(
            h
            - (prices_list[0][1] - self._min_price) / price_range * (h - 20)
            - 10
        )
        path.moveTo(first_x, h)
        path.lineTo(first_x, first_y)

        for tick, price in prices_list:
            x = int((tick - min_tick) / tick_range * cw)
            y = int(
                h - (price - self._min_price) / price_range * (h - 20) - 10
            )
            path.lineTo(x, y)

        path.lineTo(cw, h)
        path.closeSubpath()

        # Vertical linear gradient from top of the curve to bottom of the widget
        gradient = QLinearGradient(0, 0, 0, h)
        gradient.setColorAt(0.0, QColor(Colors.ACCENT_BLUE.red(), Colors.ACCENT_BLUE.green(), Colors.ACCENT_BLUE.blue(), 70))
        gradient.setColorAt(1.0, QColor(Colors.ACCENT_BLUE.red(), Colors.ACCENT_BLUE.green(), Colors.ACCENT_BLUE.blue(), 0))
        p.fillPath(path, gradient)

        # Draw current price horizontal dashed line
        if prices_list:
            curr_y = int(h - (prices_list[-1][1] - self._min_price) / price_range * (h - 20) - 10)
            current_price_pen = QPen(QColor(self._line_color.red(), self._line_color.green(), self._line_color.blue(), 120), 1.0, Qt.PenStyle.DashLine)
            p.setPen(current_price_pen)
            p.drawLine(QPointF(0, curr_y), QPointF(cw, curr_y))

        # Draw line
        pen = QPen(self._line_color, 1.5)
        p.setPen(pen)
        last_x, last_y = None, None
        for tick, price in prices_list:
            x = int((tick - min_tick) / tick_range * cw)
            y = int(
                h - (price - self._min_price) / price_range * (h - 20) - 10
            )
            if last_x is not None:
                p.drawLine(last_x, last_y, x, y)
            last_x, last_y = x, y

        # Current price label (centered as a premium dark pill with line border inside the price axis)
        if prices_list and last_y is not None:
            current_price = prices_list[-1][1]
            txt = f"{current_price:.2f}"
            p.setFont(Fonts.mono(9, bold=True))
            fm = p.fontMetrics()
            tw = fm.horizontalAdvance(txt)

            badge_w = self.price_axis_w - 4
            badge_h = fm.height() + 4
            badge_x = cw + 2
            badge_y = last_y - badge_h / 2
            badge_y = max(2.0, min(h - badge_h - 2, badge_y))

            # Draw rounded pill background
            p.setBrush(QBrush(QColor(10, 11, 16, 240)))
            cyan_color = QColor(0, 229, 255)
            p.setPen(QPen(cyan_color, 1.5))
            p.drawRoundedRect(QRectF(badge_x, badge_y, badge_w, badge_h), 4.0, 4.0)

            # Draw colored text inside the pill
            p.setPen(cyan_color)
            tx = badge_x + (badge_w - tw) / 2
            ty = badge_y + fm.ascent() + 2
            p.drawText(QPointF(tx, ty), txt)

        p.end()
