"""
DOM Ladder (Depth of Market) Widget — Bookmap-style liquidity ladder.

Shows bid / ask depth as numerical bars in a compact vertical layout.
Designed to be embedded alongside HeatmapRenderer in a QSplitter.

Layout per row (horizontal):
  | Bid Qty | Bid Bar | Price | Ask Bar | Ask Qty | Imbalance |

Bid side (top of the ladder):  descending prices, green bars.
Ask side (bottom of the ladder): ascending prices, red bars.
Spread row (middle):             special background, shows BBO spread.
"""

from __future__ import annotations
import time
from functools import lru_cache
from typing import Optional

from PyQt6.QtCore import Qt, QRect, QPointF, pyqtSignal, QTimer
from PyQt6.QtGui import (
    QPainter, QColor, QPen, QFont, QBrush, QFontMetrics,
    QPaintEvent, QMouseEvent,
)
from PyQt6.QtWidgets import QWidget, QSizePolicy

from ...core import BookLevel, BBO


from ..theme import Colors, Fonts


class DomLadder(QWidget):
    """Bookmap-style Depth of Market ladder widget."""

    # Signals
    price_hovered = pyqtSignal(float)
    price_clicked = pyqtSignal(float)

    # ── Fixed column widths (pixels) ──
    BID_QTY_WIDTH = 72
    PRICE_WIDTH = 80
    ASK_QTY_WIDTH = 72
    IMBALANCE_WIDTH = 14
    BAR_MIN_WIDTH = 40  # minimum width per bar column

    # ── Colors (dark theme centralized) ──
    BG_COLOR = Colors.BG_PANEL
    TEXT_COLOR = Colors.TEXT_PRIMARY
    DIM_TEXT = Colors.TEXT_DIM
    GRID_COLOR = Colors.BORDER_SUBTLE
    BID_COLOR = Colors.ACCENT_GREEN
    ASK_COLOR = Colors.ACCENT_RED
    SPREAD_BG = Colors.BG_DEEP
    SPREAD_TEXT = Colors.TEXT_SECONDARY
    HOVER_BG = QColor(255, 255, 255, 14)
    BBO_LINE_BID = QColor(Colors.ACCENT_GREEN.red(), Colors.ACCENT_GREEN.green(), Colors.ACCENT_GREEN.blue(), 130)
    BBO_LINE_ASK = QColor(Colors.ACCENT_RED.red(), Colors.ACCENT_RED.green(), Colors.ACCENT_RED.blue(), 130)
    NEUTRAL_COLOR = Colors.TEXT_DIM

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setMinimumSize(300, 200)
        self.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Expanding,
        )
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

        # ── Rendering config ──
        self.row_height: int = 20
        self._depth: int = 10

        # ── Data ──
        self._levels: list[BookLevel] = []
        self._bbo: Optional[BBO] = None
        # Display window into _levels (ascending price indices); paint reverses for top=high
        self._window_start: int = 0
        self._window_count: int = 0

        # ── Interaction ──
        self._hovered_price: Optional[float] = None
        self._hovered_row: Optional[int] = None

        # ── Cached Fonts and Metrics ──
        self._font = QFont("Menlo", 9)
        self._metrics = QFontMetrics(self._font)
        self._small_font = QFont("Menlo", 7)
        self._empty_font = QFont("Helvetica Neue", 12)

        # ── Throttling ──
        self._update_interval_ms: int = 50  # 20 FPS max update rate
        self._last_paint_time: float = 0.0
        self._update_timer = QTimer(self)
        self._update_timer.setSingleShot(True)
        self._update_timer.timeout.connect(self._actual_update)

    # ──────────────────────────────────────────────
    #  Public API
    # ──────────────────────────────────────────────

    def set_levels(self, levels: list[BookLevel]) -> None:
        """Update the order book levels to display."""
        self._levels = levels
        self._trigger_throttled_update()

    def set_bbo(self, bbo: Optional[BBO]) -> None:
        """Update the best bid / offer."""
        self._bbo = bbo
        self._trigger_throttled_update()

    def reset(self) -> None:
        """Clear ladder for symbol/session change."""
        self._levels = []
        self._bbo = None
        self.update()

    def _trigger_throttled_update(self) -> None:
        if not self.isVisible():
            return

        now_time = time.perf_counter()
        elapsed = (now_time - self._last_paint_time) * 1000.0

        if elapsed >= self._update_interval_ms:
            self._actual_update()
        else:
            if not self._update_timer.isActive():
                remaining = int(self._update_interval_ms - elapsed)
                self._update_timer.start(max(1, remaining))

    def _actual_update(self) -> None:
        self._last_paint_time = time.perf_counter()
        self.update()

    def showEvent(self, event) -> None:
        super().showEvent(event)
        self._actual_update()

    def set_depth(self, depth: int) -> None:
        """Set how many price levels per side of BBO (default 10)."""
        self._depth = max(1, depth)
        self.update()

    def set_row_height(self, height: int) -> None:
        """Set the per-row height, clamped to [8, 40]."""
        self.row_height = max(8, min(40, height))
        self.update()

    # ──────────────────────────────────────────────
    #  Layout helpers
    # ──────────────────────────────────────────────

    def _bbo_mid_price(self) -> Optional[float]:
        """Best mid price for ladder centering, or None if unavailable."""
        if self._bbo is None:
            return None
        bid = self._bbo.bid
        ask = self._bbo.ask
        if bid > 0 and ask > 0:
            return (bid + ask) / 2.0
        if bid > 0:
            return bid
        if ask > 0:
            return ask
        return None

    def _center_index(self, mid: float) -> int:
        """Index of level closest to mid (levels sorted ascending by price)."""
        levels = self._levels
        n = len(levels)
        if n == 0:
            return 0
        # Linear scan is fine for typical book sizes; keeps dependency-free code.
        best_i = 0
        best_d = abs(levels[0].price - mid)
        for i in range(1, n):
            d = abs(levels[i].price - mid)
            if d < best_d:
                best_d = d
                best_i = i
        return best_i

    def _select_display_levels(self, widget_height: int) -> list[BookLevel]:
        """
        Window levels around BBO mid (not highest-N only).

        visible_count = min(fit-to-height, 2*_depth, n).
        Returns levels in display order: highest price first (top of ladder).
        """
        n = len(self._levels)
        if n == 0:
            self._window_start = 0
            self._window_count = 0
            return []

        fit_count = max(1, widget_height // self.row_height)
        # _depth = levels each side of BBO; total window ≈ 2 * depth
        depth_window = max(1, 2 * self._depth)
        visible_count = min(n, fit_count, depth_window)

        mid = self._bbo_mid_price()
        if mid is None:
            # Fall back: prefer a level with both sides, else book middle
            center_idx = n // 2
            for i, lv in enumerate(self._levels):
                if lv.bid_size > 0 and lv.ask_size > 0:
                    center_idx = i
                    break
        else:
            center_idx = self._center_index(mid)

        half = visible_count // 2
        start = center_idx - half
        if start < 0:
            start = 0
        if start + visible_count > n:
            start = max(0, n - visible_count)

        self._window_start = start
        self._window_count = visible_count
        window = self._levels[start : start + visible_count]
        # Highest price at top (standard DOM)
        return list(reversed(window))

    def _compute_columns(self, widget_width: int) -> tuple[QRect, ...]:
        """Return (bid_qty, bid_bar, price, ask_bar, ask_qty, imbalance) rects.

        The two bar columns share the remaining horizontal space equally.
        """
        fixed = self.BID_QTY_WIDTH + self.PRICE_WIDTH + self.ASK_QTY_WIDTH + self.IMBALANCE_WIDTH
        bar_total = max(0, widget_width - fixed)
        bid_bar_w = max(self.BAR_MIN_WIDTH, bar_total // 2)
        ask_bar_w = max(self.BAR_MIN_WIDTH, bar_total - bid_bar_w)

        x = 0
        bid_qty = QRect(x, 0, self.BID_QTY_WIDTH, 0)
        x += self.BID_QTY_WIDTH
        bid_bar = QRect(x, 0, bid_bar_w, 0)
        x += bid_bar_w
        price = QRect(x, 0, self.PRICE_WIDTH, 0)
        x += self.PRICE_WIDTH
        ask_bar = QRect(x, 0, ask_bar_w, 0)
        x += ask_bar_w
        ask_qty = QRect(x, 0, self.ASK_QTY_WIDTH, 0)
        x += self.ASK_QTY_WIDTH
        imbalance = QRect(x, 0, self.IMBALANCE_WIDTH, 0)

        return (bid_qty, bid_bar, price, ask_bar, ask_qty, imbalance)

    # ──────────────────────────────────────────────
    #  Painting
    # ──────────────────────────────────────────────

    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: PLR0915
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)

        w, h = self.width(), self.height()
        cols = self._compute_columns(w)

        # --- background ---
        painter.fillRect(0, 0, w, h, self.BG_COLOR)

        if not self._levels:
            painter.setPen(self.TEXT_COLOR)
            painter.setFont(self._empty_font)
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "No market data")
            return

        # ── Determine visible levels (BBO-centered window) ──
        display_levels = self._select_display_levels(h)

        # Max sizes for normalising bar widths (visible window only)
        max_bid = 1.0
        max_ask = 1.0
        for l in display_levels:
            if l.bid_size > max_bid:
                max_bid = l.bid_size
            if l.ask_size > max_ask:
                max_ask = l.ask_size

        # Fonts
        painter.setFont(self._font)
        ascent = self._metrics.ascent()
        # vertical text baseline offset inside the row
        text_y_ofs = (self.row_height - ascent) // 2 + ascent - 2

        # Pre-compute BBO prices
        bbo_bid = self._bbo.bid if self._bbo else None
        bbo_ask = self._bbo.ask if self._bbo else None

        for i, level in enumerate(display_levels):
            y = i * self.row_height
            row_h = self.row_height
            if y > h:
                break

            price = level.price
            has_bid = level.bid_size > 0
            has_ask = level.ask_size > 0
            is_bbo_bid = bbo_bid is not None and abs(price - bbo_bid) < 0.001
            is_bbo_ask = bbo_ask is not None and abs(price - bbo_ask) < 0.001

            # Determine if this row is inside the spread
            is_spread = (
                bbo_bid is not None
                and bbo_ask is not None
                and bbo_bid < price < bbo_ask
            )

            # ── Row background ──
            if is_spread:
                painter.fillRect(0, y, w, row_h, self.SPREAD_BG)
            elif self._hovered_row == i:
                painter.fillRect(0, y, w, row_h, self.HOVER_BG)

            # ── Grid line every 5 rows ──
            if i > 0 and i % 5 == 0:
                painter.setPen(QPen(self.GRID_COLOR, 1))
                painter.drawLine(0, y, w, y)

            # ── Column: Bid Quantity ──
            bq = cols[0]
            if has_bid:
                txt = self._format_size(level.bid_size)
                painter.setPen(self.BID_COLOR if is_bbo_bid else self.TEXT_COLOR)
                painter.drawText(
                    bq.left() + 4, y + text_y_ofs, txt,
                )
            elif not has_ask and not is_spread:
                # Empty side — dim placeholder
                painter.setPen(self.DIM_TEXT)
                painter.drawText(bq.left() + 4, y + text_y_ofs, "--")

            # ── Column: Bid Bar (green, grows left→right) ──
            bb = cols[1]
            if has_bid:
                bar_w = int(bb.width() * min(1.0, level.bid_size / max_bid))
                if bar_w > 0:
                    alpha = max(35, min(200, int(200 * (level.bid_size / max_bid))))
                    c = QColor(self.BID_COLOR)
                    c.setAlpha(alpha)
                    painter.fillRect(bb.left(), y, bar_w, row_h, c)

            # ── Column: Price ──
            pc = cols[2]
            price_txt = f"{price:.2f}"
            if is_bbo_bid:
                painter.setPen(self.BID_COLOR)
            elif is_bbo_ask:
                painter.setPen(self.ASK_COLOR)
            elif is_spread:
                painter.setPen(self.SPREAD_TEXT)
            else:
                painter.setPen(self.TEXT_COLOR)
            painter.drawText(
                pc, Qt.AlignmentFlag.AlignCenter,
                price_txt,
            )

            # ── Spread label (inside price column, below the price text) ──
            if is_spread:
                painter.setPen(self.SPREAD_TEXT)
                painter.setFont(self._small_font)
                spread_val = bbo_ask - bbo_bid if (bbo_bid and bbo_ask) else 0.0
                painter.drawText(
                    pc.left(), y + row_h - 2,
                    pc.width(), 12,
                    Qt.AlignmentFlag.AlignCenter,
                    f"×{spread_val:.2f}",
                )
                painter.setFont(self._font)  # restore

            # ── Column: Ask Bar (red, grows right←left) ──
            ab = cols[3]
            if has_ask:
                bar_w = int(ab.width() * min(1.0, level.ask_size / max_ask))
                if bar_w > 0:
                    alpha = max(35, min(200, int(200 * (level.ask_size / max_ask))))
                    c = QColor(self.ASK_COLOR)
                    c.setAlpha(alpha)
                    bar_x = ab.right() - bar_w
                    painter.fillRect(bar_x, y, bar_w, row_h, c)

            # ── Column: Ask Quantity ──
            aq = cols[4]
            if has_ask:
                txt = self._format_size(level.ask_size)
                painter.setPen(self.ASK_COLOR if is_bbo_ask else self.TEXT_COLOR)
                painter.drawText(
                    aq.right() - 4 - self._metrics.horizontalAdvance(txt),
                    y + text_y_ofs,
                    txt,
                )
            elif not has_bid and not is_spread:
                painter.setPen(self.DIM_TEXT)
                painter.drawText(aq.right() - 4 - self._metrics.horizontalAdvance("--"),
                                 y + text_y_ofs, "--")

            # ── Column: Imbalance Indicator ──
            imb = level.imbalance
            ic = cols[5]
            ix = ic.center().x()
            iy = y + row_h // 2
            if abs(imb) > 0.05:
                radius = max(2.0, min(5.0, abs(imb) * 6.0))
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(QBrush(self.BID_COLOR if imb > 0 else self.ASK_COLOR))
                painter.drawEllipse(QPointF(ix, iy), radius, radius)
            else:
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(QBrush(self.NEUTRAL_COLOR))
                painter.drawEllipse(QPointF(ix, iy), 2.0, 2.0)

            # ── BBO boundary lines ──
            if is_bbo_bid:
                painter.setPen(QPen(self.BBO_LINE_BID, 2))
                painter.drawLine(0, y + row_h - 1, w, y + row_h - 1)
            if is_bbo_ask:
                painter.setPen(QPen(self.BBO_LINE_ASK, 2))
                painter.drawLine(0, y + row_h - 1, w, y + row_h - 1)

        # ── Vertical dividers between sections ──
        painter.setPen(QPen(self.GRID_COLOR, 1))
        # Thin lines at the boundaries of all columns
        for col_idx in (0, 1, 2, 3, 4):
            x = cols[col_idx].x() + cols[col_idx].width()
            painter.drawLine(x, 0, x, h)

        painter.end()

    @staticmethod
    def _format_size(size: float) -> str:
        """Human-readable size short-form for DOM ladder display."""
        if size >= 1000000:
            s = size / 1000000.0
            if s == int(s):
                return f"{int(s)}M"
            return f"{s:.1f}M"
        if size >= 1000:
            s = size / 1000.0
            if s == int(s):
                return f"{int(s)}K"
            return f"{s:.1f}K"
        if size >= 10:
            if size == int(size):
                return f"{int(size)}"
            return f"{size:.2f}"
        if size >= 1:
            return f"{size:.2f}"
        return f"{size:.3f}"


    # ──────────────────────────────────────────────
    #  Mouse / Keyboard interaction
    # ──────────────────────────────────────────────

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if not self._levels or self._window_count <= 0:
            return

        # Map mouse Y back to the reversed display index within BBO window
        rel_y = event.position().y()
        display_row = int(rel_y // self.row_height)

        # display_row 0 = highest price = last index in ascending window slice
        if 0 <= display_row < self._window_count:
            actual_idx = self._window_start + (self._window_count - 1 - display_row)
            if 0 <= actual_idx < len(self._levels):
                prev = self._hovered_price
                self._hovered_price = self._levels[actual_idx].price
                self._hovered_row = display_row
                if self._hovered_price != prev:
                    self.price_hovered.emit(self._hovered_price)
            else:
                self._hovered_price = None
                self._hovered_row = None
        else:
            self._hovered_price = None
            self._hovered_row = None

        self.update()
        super().mouseMoveEvent(event)

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton and self._hovered_price is not None:
            self.price_clicked.emit(self._hovered_price)
        super().mousePressEvent(event)

    def leaveEvent(self, event) -> None:
        self._hovered_price = None
        self._hovered_row = None
        self.update()
        super().leaveEvent(event)

    def wheelEvent(self, event) -> None:
        """Mouse wheel scrolls through levels."""
        delta = event.angleDelta().y()
        # For now, no scroll — we always show the full visible set.
        # Future: add scroll_offset if levels exceed visible rows.
        event.accept()
        super().wheelEvent(event)

    # ──────────────────────────────────────────────
    #  Size hints
    # ──────────────────────────────────────────────

    def minimumSizeHint(self) -> 'QSize':
        from PyQt6.QtCore import QSize
        return QSize(300, 200)

    def sizeHint(self) -> 'QSize':
        from PyQt6.QtCore import QSize
        return QSize(320, 400)
