"""
Volume Profile Panel — horizontal histogram to the right of the heatmap.

Displays depth and volume profile columns side by side:
- COB (Current Order Book): resting limit order depth (bids in green, asks in red)
- CVP (Chart Range Volume Profile): traded volume within the visible chart range
- SVP (Session Range Volume Profile): accumulated traded volume since start of session
"""
from __future__ import annotations
from typing import Optional

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QPainter, QPen, QBrush, QColor, QFont, QPaintEvent
from PyQt6.QtWidgets import QWidget, QSizePolicy


class VolumeProfileOverlay(QWidget):
    """
    Volume Profile overlay panel displaying COB, CVP, and SVP.

    Designed to sit to the right of the heatmap. Refreshes dynamically
    with grid alignment to the visible heatmap rows.
    """

    def __init__(self, parent=None, heatmap=None):
        super().__init__(parent)
        self._heatmap = heatmap
        self._order_book = None
        
        self.setMinimumWidth(220)
        self.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Expanding,
        )

        # ── Toggle states for the columns ──
        self.show_cob: bool = True
        self.show_cvp: bool = True
        self.show_svp: bool = True

        # ── SVP Data (Session Volume Profile) ──
        self._svp_volumes: dict[float, float] = {}
        self._svp_total_volume: float = 0.0
        self._svp_max_volume: float = 0.0
        self._svp_poc_price: Optional[float] = None
        self._svp_poc_volume: float = 0.0
        self._svp_va_low: Optional[float] = None
        self._svp_va_high: Optional[float] = None
        self._svp_va_stale: bool = True

        # ── CVP Data (Chart Volume Profile) ──
        self._cvp_volumes: dict[float, float] = {}
        self._cvp_total_volume: float = 0.0
        self._cvp_max_volume: float = 0.0
        self._cvp_poc_price: Optional[float] = None
        self._cvp_poc_volume: float = 0.0
        self._cvp_va_low: Optional[float] = None
        self._cvp_va_high: Optional[float] = None

        self._levels: list = []  # BookLevel list (synced from heatmap)
        self.row_height: int = 20

        # ── Appearance ──
        from ..theme import Colors
        self.bg_color = Colors.BG_PANEL
        self.grid_color = QColor(31, 34, 47)
        self.text_color = Colors.TEXT_SECONDARY
        
        # Color mapping tables for Value Area intensity (0-255)
        self._svp_va_colors = [
            QColor(int(94 + i * 20 / 255), int(114 + i * 40 / 255), int(228 + i * 20 / 255), 200)
            for i in range(256)
        ]
        self._svp_reg_colors = [
            QColor(int(51 + i * 20 / 255), int(65 + i * 20 / 255), int(85 + i * 20 / 255), 150)
            for i in range(256)
        ]
        self._cvp_va_colors = [
            QColor(int(59 + i * 40 / 255), int(130 + i * 40 / 255), int(246 + i * 9 / 255), 200)
            for i in range(256)
        ]
        self._cvp_reg_colors = [
            QColor(int(99 + i * 20 / 255), int(102 + i * 20 / 255), int(241 + i * 14 / 255), 150)
            for i in range(256)
        ]

    # ── Public API ─────────────────────────────────────────────

    def set_order_book(self, order_book) -> None:
        """Link the data source order book directly for COB queries."""
        self._order_book = order_book

    def add_trade(self, price: float, size: float) -> None:
        """Record trade volume at a given price level for SVP."""
        price_key = self._bin_price(price)
        old_vol = self._svp_volumes.get(price_key, 0.0)
        new_vol = old_vol + size
        self._svp_volumes[price_key] = new_vol
        self._svp_total_volume += size
        
        # Incrementally update max volume and POC
        if new_vol > self._svp_poc_volume:
            self._svp_poc_volume = new_vol
            self._svp_poc_price = price_key
        if new_vol > self._svp_max_volume:
            self._svp_max_volume = new_vol

        self._svp_va_stale = True
        self.update()

    def add_trades(self, trades: list) -> None:
        """Record a batch of trade volumes at given price levels for SVP."""
        if not trades:
            return
        for trade in trades:
            price, size = trade.price, trade.size
            price_key = self._bin_price(price)
            old_vol = self._svp_volumes.get(price_key, 0.0)
            new_vol = old_vol + size
            self._svp_volumes[price_key] = new_vol
            self._svp_total_volume += size
            
            # Incrementally update max volume and POC
            if new_vol > self._svp_poc_volume:
                self._svp_poc_volume = new_vol
                self._svp_poc_price = price_key
            if new_vol > self._svp_max_volume:
                self._svp_max_volume = new_vol

        self._svp_va_stale = True
        self.update()

    def set_levels(self, levels: list) -> None:
        """Sync with the heatmap's visible price levels to match rows."""
        self._levels = levels
        self.update()

    def set_row_height(self, h: int) -> None:
        """Set row height matching the heatmap layout."""
        if self.row_height != h:
            self.row_height = h
            self.update()

    def reset(self) -> None:
        """Clear all COB, CVP, and SVP data."""
        self._svp_volumes.clear()
        self._svp_total_volume = 0.0
        self._svp_max_volume = 0.0
        self._svp_poc_price = None
        self._svp_poc_volume = 0.0
        self._svp_va_low = None
        self._svp_va_high = None
        self._svp_va_stale = True

        self._cvp_volumes.clear()
        self._cvp_total_volume = 0.0
        self._cvp_max_volume = 0.0
        self._cvp_poc_price = None
        self._cvp_poc_volume = 0.0
        self._cvp_va_low = None
        self._cvp_va_high = None

        self._levels.clear()
        self.update()

    # ── Calculations ───────────────────────────────────────────

    def _render_tick(self) -> float:
        """Price step of one heatmap row (for binning trades/depth)."""
        if self._heatmap is not None:
            eng = getattr(self._heatmap, "_engine", None)
            if eng is not None:
                rts = float(getattr(eng, "render_tick_size", 0.0) or 0.0)
                if rts > 0:
                    return rts
        if len(self._levels) >= 2:
            # Infer from sorted unique spacing of visible levels
            prices = sorted({float(lv.price) for lv in self._levels})
            diffs = [prices[i + 1] - prices[i] for i in range(len(prices) - 1)]
            positive = [d for d in diffs if d > 1e-12]
            if positive:
                return min(positive)
        return 0.01

    def _bin_price(self, price: float) -> float:
        """Snap a trade/book price onto the heatmap row grid."""
        tick = self._render_tick()
        if tick <= 0:
            return round(float(price), 6)
        return round(round(float(price) / tick) * tick, 6)

    def _rebinned(self, volumes: dict[float, float]) -> dict[float, float]:
        """Collapse raw price keys onto the current render-tick grid once."""
        if not volumes:
            return {}
        out: dict[float, float] = {}
        for p, v in volumes.items():
            if v <= 0:
                continue
            key = self._bin_price(p)
            out[key] = out.get(key, 0.0) + float(v)
        return out

    def _volume_on_level(self, volumes: dict[float, float], level_price: float) -> float:
        """Sum volume keys that map onto this level after binning.

        Trades arrive at exchange ticks (e.g. 75.81) while rows are
        render-tick aligned (e.g. 75.80 / 75.82). Always rebin — a fast
        exact-key path would miss sibling keys that snap to the same row.
        """
        if not volumes:
            return 0.0
        target = self._bin_price(level_price)
        total = 0.0
        for p, v in volumes.items():
            if v > 0 and self._bin_price(p) == target:
                total += float(v)
        return total

    @staticmethod
    def _bar_len(vol: float, max_vol: float, col_w: int, *, min_px: int = 2) -> int:
        """Map volume → bar width with soft sqrt scale so mid-levels stay visible.

        Linear scale makes a single POC wall crush the rest of the profile to
        1px ghosts (frontend audit: VP bright ~5% while heatmap ~45%).
        """
        if vol <= 0 or col_w <= 0:
            return 0
        ref = max(float(max_vol), 1e-9)
        # sqrt: vol=0.25*max → 0.5 of column (was 0.25 linear)
        t = (float(vol) / ref) ** 0.5
        length = int(round(t * col_w))
        return max(min_px, min(col_w, length))

    def _compute_svp_va(self) -> None:
        """Compute POC and Value Area for Session Volume Profile."""
        if not self._svp_volumes or self._svp_total_volume <= 0:
            return

        # Ensure POC is computed (fallback)
        if self._svp_poc_price is None or self._svp_poc_price not in self._svp_volumes:
            self._svp_poc_price = max(self._svp_volumes, key=self._svp_volumes.get)
            self._svp_poc_volume = self._svp_volumes[self._svp_poc_price]
            self._svp_max_volume = max(self._svp_max_volume, self._svp_poc_volume)

        if not self._svp_va_stale:
            return

        self._svp_va_stale = False

        # Value Area (narrowest range containing 70% of total volume)
        sorted_levels = sorted(
            self._svp_volumes.items(),
            key=lambda x: x[1],
            reverse=True,
        )

        target_vol = self._svp_total_volume * 0.70
        accumulated = 0.0
        va_levels: list[float] = []

        for price, vol in sorted_levels:
            if accumulated >= target_vol:
                break
            accumulated += vol
            va_levels.append(price)

        if va_levels:
            self._svp_va_low = min(va_levels)
            self._svp_va_high = max(va_levels)

    def _compute_cvp(self) -> None:
        """Dynamically compute CVP (Chart Volume Profile) from visible trades."""
        self._cvp_volumes.clear()
        self._cvp_total_volume = 0.0
        self._cvp_max_volume = 0.0
        self._cvp_poc_price = None
        self._cvp_poc_volume = 0.0
        self._cvp_va_low = None
        self._cvp_va_high = None

        if not self._heatmap:
            return

        # Fetch on-screen visible trades from the heatmap cache
        visible_trades = self._heatmap.get_visible_trades()
        for t in visible_trades:
            # Format: (price, size, side, ts, tick_index)
            if len(t) >= 4:
                price, size = t[0], t[1]
                price_key = self._bin_price(price)
                self._cvp_volumes[price_key] = self._cvp_volumes.get(price_key, 0.0) + size
                self._cvp_total_volume += size

        if not self._cvp_volumes or self._cvp_total_volume <= 0:
            return

        # Compute POC for CVP
        self._cvp_poc_price = max(self._cvp_volumes, key=self._cvp_volumes.get)
        self._cvp_poc_volume = self._cvp_volumes[self._cvp_poc_price]
        self._cvp_max_volume = self._cvp_poc_volume

        # Compute Value Area for CVP
        sorted_levels = sorted(
            self._cvp_volumes.items(),
            key=lambda x: x[1],
            reverse=True,
        )

        target_vol = self._cvp_total_volume * 0.70
        accumulated = 0.0
        va_levels: list[float] = []

        for price, vol in sorted_levels:
            if accumulated >= target_vol:
                break
            accumulated += vol
            va_levels.append(price)

        if va_levels:
            self._cvp_va_low = min(va_levels)
            self._cvp_va_high = max(va_levels)

    # ── Painting ───────────────────────────────────────────────

    def paintEvent(self, event: QPaintEvent) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)

        w, h = self.width(), self.height()

        # Fill background
        painter.fillRect(0, 0, w, h, self.bg_color)

        # Determine which columns to render
        active_cols = []
        if self.show_cob:
            active_cols.append("COB")
        if self.show_cvp:
            active_cols.append("CVP")
        if self.show_svp:
            active_cols.append("SVP")

        num_cols = len(active_cols)
        if num_cols == 0 or not self._levels:
            painter.setPen(self.text_color)
            painter.setFont(QFont('Helvetica Neue', 9))
            painter.drawText(
                self.rect(),
                Qt.AlignmentFlag.AlignCenter,
                "No active profiles" if num_cols == 0 else "No data",
            )
            painter.end()
            return

        # Compute profile metrics
        if self.show_svp:
            self._compute_svp_va()
        if self.show_cvp:
            self._compute_cvp()

        # Build current order book map for COB column
        cob_bids = {}
        cob_asks = {}
        levels_source = []
        if self._heatmap and hasattr(self._heatmap, '_levels') and self._heatmap._levels:
            levels_source = self._heatmap._levels
        elif self._order_book:
            levels_source = self._order_book.get_levels()

        for lv in levels_source:
            price_key = self._bin_price(lv.price)
            if lv.bid_size > 0:
                cob_bids[price_key] = cob_bids.get(price_key, 0.0) + lv.bid_size
            if lv.ask_size > 0:
                cob_asks[price_key] = cob_asks.get(price_key, 0.0) + lv.ask_size

        # Grid geometry parameters
        margin = 4
        spacing = 8
        net_w = w - 2 * margin - (num_cols - 1) * spacing
        col_w = max(10, net_w // num_cols)

        # Rebin once per paint (O(n) not O(n×levels) per row)
        cvp_binned = self._rebinned(self._cvp_volumes)
        svp_binned = self._rebinned(self._svp_volumes)

        # Normalization constants (bin-aware lookup)
        max_cob = 0.0
        for level in self._levels:
            pk = self._bin_price(level.price)
            max_cob = max(max_cob, cob_bids.get(pk, 0.0), cob_asks.get(pk, 0.0))
        max_cob = max(max_cob, 1.0)

        max_cvp = max(cvp_binned.values(), default=0.0) or max(self._cvp_max_volume, 1.0)
        max_svp = max(svp_binned.values(), default=0.0) or max(self._svp_max_volume, 1.0)
        max_cvp = max(float(max_cvp), 1.0)
        max_svp = max(float(max_svp), 1.0)

        # Draw the price rows — fixed pitch matching heatmap (not stretch i*h/bh).
        # Prefer live heatmap.row_height when linked; else self.row_height.
        if self._heatmap is not None and getattr(self._heatmap, "row_height", None):
            rh = max(1, int(self._heatmap.row_height))
        else:
            rh = max(1, int(self.row_height))

        for i, level in enumerate(self._levels):
            price = level.price
            y_start = i * rh
            if y_start >= h:
                break
            y_height = rh
            # Leave 1px gap between rows when row is tall enough (matches visual grid)
            draw_height = max(1, y_height - 1) if y_height > 1 else y_height

            price_key = self._bin_price(price)

            for idx, col_name in enumerate(active_cols):
                x_col_start = margin + idx * (col_w + spacing)

                if col_name == "COB":
                    bid_sz = cob_bids.get(price_key, 0.0)
                    ask_sz = cob_asks.get(price_key, 0.0)
                    # Draw both sides when present (half-height each) so
                    # locked/near-mid levels are not dropped by elif.
                    if bid_sz > 0 and ask_sz > 0:
                        half = max(1, draw_height // 2)
                        bl = self._bar_len(bid_sz, max_cob, col_w)
                        al = self._bar_len(ask_sz, max_cob, col_w)
                        painter.fillRect(x_col_start, y_start, bl, half, QColor(16, 185, 129, 180))
                        painter.fillRect(x_col_start, y_start + half, al, draw_height - half, QColor(239, 68, 68, 180))
                    elif bid_sz > 0:
                        bl = self._bar_len(bid_sz, max_cob, col_w)
                        painter.fillRect(x_col_start, y_start, bl, draw_height, QColor(16, 185, 129, 180))
                    elif ask_sz > 0:
                        al = self._bar_len(ask_sz, max_cob, col_w)
                        painter.fillRect(x_col_start, y_start, al, draw_height, QColor(239, 68, 68, 180))

                elif col_name == "CVP":
                    vol = cvp_binned.get(price_key, 0.0)
                    if vol > 0:
                        bar_len = self._bar_len(vol, max_cvp, col_w)

                        in_va = (
                            self._cvp_va_low is not None
                            and self._cvp_va_high is not None
                            and self._cvp_va_low <= price_key <= self._cvp_va_high
                        )
                        is_poc = (
                            self._cvp_poc_price is not None
                            and abs(self._bin_price(self._cvp_poc_price) - price_key) < 1e-9
                        )

                        if is_poc:
                            # CVP POC: Bright amber yellow
                            color = QColor(245, 158, 11)
                        elif in_va:
                            # Value Area: Deep blue intensity
                            intensity = (vol / max_cvp) ** 0.5
                            c_idx = max(0, min(255, int(intensity * 255)))
                            color = self._cvp_va_colors[c_idx]
                        else:
                            # Regular: Indigo intensity
                            intensity = (vol / max_cvp) ** 0.5
                            c_idx = max(0, min(255, int(intensity * 255)))
                            color = self._cvp_reg_colors[c_idx]

                        painter.fillRect(x_col_start, y_start, bar_len, draw_height, color)

                        # Draw subtle horizontal line for CVP POC
                        if is_poc:
                            painter.setPen(QPen(QColor(245, 158, 11), 1, Qt.PenStyle.SolidLine))
                            painter.drawLine(x_col_start, y_start + draw_height // 2, x_col_start + col_w, y_start + draw_height // 2)
                            painter.setPen(Qt.PenStyle.NoPen)

                elif col_name == "SVP":
                    vol = svp_binned.get(price_key, 0.0)
                    if vol > 0:
                        bar_len = self._bar_len(vol, max_svp, col_w)

                        in_va = (
                            self._svp_va_low is not None
                            and self._svp_va_high is not None
                            and self._svp_va_low <= price_key <= self._svp_va_high
                        )
                        is_poc = (
                            self._svp_poc_price is not None
                            and abs(self._bin_price(self._svp_poc_price) - price_key) < 1e-9
                        )

                        if is_poc:
                            # SVP POC: Bright Cyan
                            color = QColor(0, 200, 255)
                        elif in_va:
                            # Value area: Royal purple intensity
                            intensity = (vol / max_svp) ** 0.5
                            c_idx = max(0, min(255, int(intensity * 255)))
                            color = self._svp_va_colors[c_idx]
                        else:
                            # Regular: Slate intensity
                            intensity = (vol / max_svp) ** 0.5
                            c_idx = max(0, min(255, int(intensity * 255)))
                            color = self._svp_reg_colors[c_idx]

                        painter.fillRect(x_col_start, y_start, bar_len, draw_height, color)

                        # Draw subtle horizontal line for SVP POC
                        if is_poc:
                            painter.setPen(QPen(QColor(0, 200, 255), 1, Qt.PenStyle.SolidLine))
                            painter.drawLine(x_col_start, y_start + draw_height // 2, x_col_start + col_w, y_start + draw_height // 2)
                            painter.setPen(Qt.PenStyle.NoPen)

        # ── Draw HUD Column Headers ──
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        
        # Header banner (semi-transparent slate)
        painter.fillRect(0, 0, w, 20, QColor(10, 11, 16, 230))
        painter.setPen(QPen(QColor(31, 34, 47), 1, Qt.PenStyle.SolidLine))
        painter.drawLine(0, 20, w, 20)

        from ..theme import Fonts
        header_font = Fonts.sans(8, bold=True)
        painter.setFont(header_font)

        for idx, col_name in enumerate(active_cols):
            x_col_start = margin + idx * (col_w + spacing)

            # Draw vertical column separator line
            if idx < num_cols - 1:
                x_sep = x_col_start + col_w + spacing // 2
                painter.setPen(QPen(QColor(31, 34, 47), 1, Qt.PenStyle.SolidLine))
                painter.drawLine(x_sep, 0, x_sep, h)

            # Draw Column Label
            painter.setPen(QColor(226, 228, 233))
            fm = painter.fontMetrics()
            label_w = fm.horizontalAdvance(col_name)
            tx = x_col_start + (col_w - label_w) // 2
            painter.drawText(tx, 13, col_name)

        # ── Draw HUD Footers ──
        painter.fillRect(0, h - 16, w, 16, QColor(10, 11, 16, 230))
        painter.setPen(QPen(QColor(31, 34, 47), 1, Qt.PenStyle.SolidLine))
        painter.drawLine(0, h - 16, w, h - 16)

        footer_font = QFont('Helvetica Neue', 7, QFont.Weight.Bold)
        painter.setFont(footer_font)

        for idx, col_name in enumerate(active_cols):
            x_col_start = margin + idx * (col_w + spacing)

            painter.setPen(self.text_color)
            txt = ""

            def _fmt_vol(v: float) -> str:
                if v >= 1_000_000:
                    return f"{v/1_000_000.0:.1f}M"
                if v >= 1000.0:
                    return f"{v/1000.0:.1f}k"
                return f"{v:.0f}"

            if col_name == "COB":
                # Show peak visible book size so footer is not a dead "BOOK" label
                # while CVP/SVP show live volume totals.
                peak = 0.0
                for lv in self._levels:
                    pk = self._bin_price(lv.price)
                    peak = max(
                        peak,
                        cob_bids.get(pk, 0.0),
                        cob_asks.get(pk, 0.0),
                    )
                txt = _fmt_vol(peak) if peak > 0 else "BOOK"
            elif col_name == "CVP":
                txt = _fmt_vol(self._cvp_total_volume)
            elif col_name == "SVP":
                txt = _fmt_vol(self._svp_total_volume)

            fm = painter.fontMetrics()
            label_w = fm.horizontalAdvance(txt)
            tx = x_col_start + (col_w - label_w) // 2
            painter.drawText(tx, h - 5, txt)

        painter.end()
