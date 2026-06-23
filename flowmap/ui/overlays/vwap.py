"""
VWAP Overlay — draws a horizontal VWAP line on the heatmap.

Volume-Weighted Average Price is computed incrementally:
    VWAP = sum(price * volume) / sum(volume)
"""
from __future__ import annotations
import math
from typing import Optional

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QPainter, QPen, QFont, QColor, QPaintEvent
from PyQt6.QtWidgets import QWidget


class VWAPOverlay(QWidget):
    """
    Horizontal VWAP line drawn over the heatmap widget.

    Receives price/volume trades, computes VWAP incrementally,
    and draws a dashed yellow line at the current VWAP level
    with a "VWAP" label.

    Signals
    -------
    vwap_updated(float) : emitted whenever a new VWAP is computed
    """

    vwap_updated = pyqtSignal(float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)

        # ── VWAP state ──
        self._price_volume_sum: float = 0.0   # Σ(price * volume)
        self._volume_sum: float = 0.0          # Σ(volume)
        self._current_vwap: Optional[float] = None

        # ── Dark theme ──
        self.line_color = QColor(255, 215, 0)        # Gold #FFD700
        self.label_bg = QColor(255, 215, 0, 40)
        self.label_text_color = QColor(255, 215, 0)

        # Row sync (set externally by the layout manager from HeatmapRenderer)
        self.row_height: int = 20
        self.price_column_width: int = 80
        self._visible_levels: list = []
        self._start_idx: int = 0

    # ── Public API ─────────────────────────────────────────────

    def add_trade(self, price: float, size: float) -> None:
        """Add a trade (price, size) and recompute VWAP."""
        self._price_volume_sum += price * size
        self._volume_sum += size
        if self._volume_sum > 0:
            old_vwap = self._current_vwap
            self._current_vwap = self._price_volume_sum / self._volume_sum
            if (
                old_vwap is None
                or abs(self._current_vwap - old_vwap) > 1e-9
            ):
                self.vwap_updated.emit(self._current_vwap)
        self.update()

    def reset(self) -> None:
        """Clear all VWAP state."""
        self._price_volume_sum = 0.0
        self._volume_sum = 0.0
        self._current_vwap = None
        self.update()

    @property
    def vwap(self) -> Optional[float]:
        """Current VWAP value."""
        return self._current_vwap

    # ── Sync helpers (called by layout manager) ────────────────

    def sync_visible_levels(self, levels: list, start_idx: int) -> None:
        """Receive visible price levels so the line finds its Y position."""
        self._visible_levels = levels
        self._start_idx = start_idx

    # ── Painting ───────────────────────────────────────────────

    def paintEvent(self, event: QPaintEvent) -> None:
        if self._current_vwap is None:
            return

        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)

        w, h = self.width(), self.height()
        left = 0
        heatmap_width = w - self.price_column_width

        # Position using HeatmapWidget's unified price-to-screen mapping
        vwap_y: Optional[int] = None
        parent = self.parent()
        if parent is not None and hasattr(parent, '_price_to_screen_y'):
            vwap_y = int(parent._price_to_screen_y(self._current_vwap, h))
        else:
            # Fallback to the old logic if parent method is not accessible
            if self._visible_levels:
                for i, level in enumerate(self._visible_levels):
                    if abs(level.price - self._current_vwap) < 0.001:
                        vwap_y = i * self.row_height + self.row_height // 2
                        break
                if vwap_y is None and len(self._visible_levels) >= 2:
                    first = self._visible_levels[0].price
                    last = self._visible_levels[-1].price
                    p_min, p_max = min(first, last), max(first, last)
                    if p_max > p_min and p_min <= self._current_vwap <= p_max:
                        price_range = p_max - p_min
                        rel = (first - self._current_vwap) / price_range
                        vwap_y = int(rel * (len(self._visible_levels) - 1) * self.row_height + self.row_height // 2)

        if vwap_y is not None and 0 <= vwap_y < h:
            # ── Dashed line ──
            pen = QPen(self.line_color, 2, Qt.PenStyle.DashLine)
            painter.setPen(pen)
            painter.drawLine(left, vwap_y, left + heatmap_width, vwap_y)

            # ── Label ──
            font = QFont('Menlo', 9, QFont.Weight.Bold)
            painter.setFont(font)
            label_text = f"VWAP {self._current_vwap:.2f}"

            fm = painter.fontMetrics()
            label_w = fm.horizontalAdvance(label_text) + 10
            label_h = fm.height() + 4

            # Label background - solid dark color to block out the heatmap and line behind the text
            badge_bg = QColor(18, 18, 22, 240)
            painter.fillRect(
                left + heatmap_width - label_w - 4,
                vwap_y - label_h // 2,
                label_w,
                label_h,
                badge_bg,
            )

            # Draw a gold border around the label badge to make it look premium
            border_pen = QPen(self.line_color, 1)
            painter.setPen(border_pen)
            painter.drawRoundedRect(
                left + heatmap_width - label_w - 4,
                vwap_y - label_h // 2,
                label_w,
                label_h,
                3.0,
                3.0,
            )

            # Label text
            painter.setPen(self.label_text_color)
            painter.drawText(
                left + heatmap_width - label_w,
                vwap_y + fm.ascent() // 2,
                label_text,
            )

        painter.end()
