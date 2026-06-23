"""
Volume Profile Panel — horizontal histogram to the right of the heatmap.

Shows trade volume distribution across price levels as horizontal
bars extending left from the right edge.  Highlights:
- Point of Control (POC): the highest-volume level
- Value Area: the narrowest price range containing ~70% of total volume
"""
from __future__ import annotations
import math
from typing import Optional

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QPainter, QPen, QBrush, QColor, QFont, QPaintEvent, QLinearGradient
from PyQt6.QtWidgets import QWidget, QSizePolicy


class VolumeProfileOverlay(QWidget):
    """
    Volume Profile histogram panel.

    Designed to sit to the right of the heatmap.  Horizontal bars
    extending left from the right edge, with POC highlighted.

    Methods
    -------
    add_trade(price, size) : record volume at a price level
    set_levels(levels) : sync with heatmap price levels for row positions
    reset() : clear all data
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumWidth(100)
        self.setSizePolicy(
            QSizePolicy.Policy.Fixed,
            QSizePolicy.Policy.Expanding,
        )

        # ── Data ──
        # price → cumulative volume
        self._volumes: dict[float, float] = {}
        self._levels: list = []  # BookLevel list (for row positioning)
        self._total_volume: float = 0.0

        # Computed on each paint (or incrementally)
        self._max_volume: float = 0.0
        self._poc_price: Optional[float] = None
        self._poc_volume: float = 0.0
        self._va_high: Optional[float] = None
        self._va_low: Optional[float] = None

        self._va_stale: bool = True
        self._last_va_compute_time: float = 0.0
        self._va_throttle_sec: float = 0.1

        # ── Appearance ──
        from ..theme import Colors
        self.bg_color = Colors.BG_PANEL
        self.grid_color = QColor(35, 35, 45)
        self.text_color = QColor(180, 180, 190)
        self.poc_color = QColor(0, 200, 255)        # Bright cyan
        self.poc_label_color = QColor(0, 200, 255)
        self.va_color = QColor(30, 80, 140, 80)     # Dark blue shade
        self.bar_gradient_top = QColor(20, 60, 120)  # Dark blue
        self.bar_gradient_bot = QColor(0, 180, 220)  # Bright cyan

        # Row sync from heatmap
        self.row_height: int = 20
        self.bar_max_width: int = 80

        # Label area
        self._label_width: int = 36  # Space on the right for POC/VAL labels

        # Pre-generate color tables for performance (indexed by intensity 0-255)
        self._va_colors = [
            QColor(int(30 + i * 50 / 255), int(80 + i * 100 / 255), int(140 + i * 100 / 255), 200)
            for i in range(256)
        ]
        self._reg_colors = [
            QColor(int(20 + i * 30 / 255), int(60 + i * 120 / 255), int(120 + i * 100 / 255), 180)
            for i in range(256)
        ]

    # ── Public API ─────────────────────────────────────────────

    def add_trade(self, price: float, size: float) -> None:
        """Record trade volume at a given price level."""
        price_key = round(price, 6)
        old_vol = self._volumes.get(price_key, 0.0)
        new_vol = old_vol + size
        self._volumes[price_key] = new_vol
        self._total_volume += size
        
        # Incrementally update max volume and POC (O(1) updates)
        if new_vol > self._poc_volume:
            self._poc_volume = new_vol
            self._poc_price = price_key
        if new_vol > self._max_volume:
            self._max_volume = new_vol

        self._va_stale = True
        self.update()

    def add_trades(self, trades: list[Trade]) -> None:
        """Record a batch of trade volumes at given price levels."""
        if not trades:
            return
        for trade in trades:
            price, size = trade.price, trade.size
            price_key = round(price, 6)
            old_vol = self._volumes.get(price_key, 0.0)
            new_vol = old_vol + size
            self._volumes[price_key] = new_vol
            self._total_volume += size
            
            # Incrementally update max volume and POC
            if new_vol > self._poc_volume:
                self._poc_volume = new_vol
                self._poc_price = price_key
            if new_vol > self._max_volume:
                self._max_volume = new_vol

        self._va_stale = True
        self.update()

    def set_levels(self, levels: list) -> None:
        """
        Sync with the heatmap's visible price levels.
        This determines which rows are drawn and their order.
        """
        self._levels = levels
        # Vis range shifts do not affect historical POC or Value Area,
        # so we do NOT call _invalidate() here to avoid unnecessary computations.
        self.update()

    def set_row_height(self, h: int) -> None:
        """Set row height for matching heatmap layout."""
        if self.row_height != h:
            self.row_height = h
            self.update()

    def reset(self) -> None:
        """Clear all volume profile data."""
        self._volumes.clear()
        self._levels.clear()
        self._total_volume = 0.0
        self._max_volume = 0.0
        self._poc_price = None
        self._poc_volume = 0.0
        self._va_high = None
        self._va_low = None
        self._va_stale = True
        self.update()

    # ── Internal ───────────────────────────────────────────────

    def _invalidate(self) -> None:
        """Mark computed values as stale."""
        self._va_stale = True

    def _compute(self) -> None:
        """Compute POC and Value Area from current volume data."""
        if not self._volumes or self._total_volume <= 0:
            return

        # Ensure POC is computed (fallback)
        if self._poc_price is None or self._poc_price not in self._volumes:
            self._poc_price = max(self._volumes, key=self._volumes.get)
            self._poc_volume = self._volumes[self._poc_price]
            self._max_volume = max(self._max_volume, self._poc_volume)

        if not self._va_stale:
            return

        import time
        now = time.time()
        if now - self._last_va_compute_time < self._va_throttle_sec and self._va_low is not None:
            return

        self._last_va_compute_time = now
        self._va_stale = False

        # Compute Value Area (narrowest range containing ~70% of volume)
        # Sort levels by volume descending and accumulate until 70%
        sorted_levels = sorted(
            self._volumes.items(),
            key=lambda x: x[1],
            reverse=True,
        )

        target_vol = self._total_volume * 0.70
        accumulated = 0.0
        va_levels: list[float] = []

        for price, vol in sorted_levels:
            if accumulated >= target_vol:
                break
            accumulated += vol
            va_levels.append(price)

        if va_levels:
            self._va_low = min(va_levels)
            self._va_high = max(va_levels)

    # ── Painting ───────────────────────────────────────────────

    def paintEvent(self, event: QPaintEvent) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)

        w, h = self.width(), self.height()

        # Background
        painter.fillRect(0, 0, w, h, self.bg_color)

        if not self._levels or not self._volumes:
            painter.setPen(self.text_color)
            painter.setFont(QFont('Helvetica Neue', 9))
            painter.drawText(
                self.rect(),
                Qt.AlignmentFlag.AlignCenter,
                "No data",
            )
            painter.end()
            return

        # Compute POC and VA if stale
        self._compute()

        # If still no volume data after computing, bail
        if self._total_volume <= 0:
            painter.end()
            return

        bar_area_right = w
        bar_area_left = 4
        bar_width = bar_area_right - bar_area_left
        if bar_width <= 0:
            painter.end()
            return

        # Normalize max volume for bar scaling
        max_v = max(self._max_volume, 1.0)

        # Draw bars for each visible price level using nearest-neighbor row boundaries
        bh = len(self._levels)
        for i, level in enumerate(self._levels):
            price = level.price
            y_start = int(i * h / bh)
            y_end = int((i + 1) * h / bh)
            y_height = y_end - y_start
            if y_start > h:
                break

            price_key = round(price, 6)
            vol = self._volumes.get(price_key, 0.0)
            if vol <= 0:
                continue

            # Bar width proportional to volume
            bar_len = int((vol / max_v) * bar_width)
            bar_len = min(bar_len, bar_width)

            if bar_len <= 0:
                continue

            # Determine if this level is in the value area
            in_va = (
                self._va_low is not None
                and self._va_high is not None
                and self._va_low <= price_key <= self._va_high
            )

            # Is this the POC?
            is_poc = (
                self._poc_price is not None
                and abs(price_key - self._poc_price) < 0.001
            )

            # Bar X position (right-aligned)
            bar_x = bar_area_right - bar_len

            # Keep a 1-pixel gap if height allows, otherwise draw at full row height
            draw_height = max(1, y_height - 1) if y_height > 1 else y_height

            # ── Bar fill ──
            if is_poc:
                # POC: bright cyan
                painter.fillRect(
                    bar_x, y_start, bar_len, draw_height,
                    self.poc_color,
                )
            else:
                intensity = vol / max_v
                idx = int(intensity * 255)
                idx = max(0, min(255, idx))
                if in_va:
                    # Value Area: slightly different shade (blue tint)
                    painter.fillRect(
                        bar_x, y_start, bar_len, draw_height,
                        self._va_colors[idx],
                    )
                else:
                    # Regular bar: gradient from dark blue to cyan based on volume
                    painter.fillRect(
                        bar_x, y_start, bar_len, draw_height,
                        self._reg_colors[idx],
                    )

            # ── POC label ──
            if is_poc:
                font = QFont('Menlo', 8, QFont.Weight.Bold)
                painter.setFont(font)
                painter.setPen(self.poc_label_color)
                label = "POC"
                fm = painter.fontMetrics()
                label_w = fm.horizontalAdvance(label)
                painter.drawText(
                    bar_area_right - label_w - 4,
                    y_start + y_height - 4,
                    label,
                )

        # ── Bottom info line ──
        painter.setFont(QFont('Helvetica Neue', 8))
        painter.setPen(self.text_color)
        info = f"Vol: {self._total_volume:.1f}"
        painter.drawText(4, h - 4, info)

        painter.end()
