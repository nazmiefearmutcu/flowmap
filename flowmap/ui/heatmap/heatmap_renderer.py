"""
Bookmap-style 2D History Heatmap — level-based, zero-flicker, incremental.

Each order book price LEVEL = one thin horizontal line.
Gaps between levels = dark background (natural stratigraphy).
Brightness = order size (accumulation zones GLOW).

X-axis = time (columns scroll right-to-left)
Y-axis = price levels from order book (high price = top)
"""

from __future__ import annotations
import math, time as _time, bisect
from collections import deque
from typing import Optional
import numpy as np
from PyQt6.QtCore import Qt, QRect, pyqtSignal
from PyQt6.QtGui import QPainter, QColor, QPen, QFont, QImage, QFontMetrics, QPaintEvent, QMouseEvent, QWheelEvent, QKeyEvent
from PyQt6.QtWidgets import QWidget, QSizePolicy
from ...core import BookLevel, BBO, Side
from .color_schemes import BACKGROUND_COLOR, GRID_COLOR, PRICE_TEXT_COLOR, BBO_BID_COLOR, BBO_ASK_COLOR

BG_RGBA     = (*BACKGROUND_COLOR, 255)
BID_G_COLOR = (100, 255, 120, 200)
ASK_R_COLOR = (255, 100, 90, 200)
TRADE_BUY   = (80, 255, 100)
TRADE_SELL  = (255, 80, 80)
CROSSHAIR   = (180, 190, 210, 90)

# ── Color functions: wider gamut for density perception ──

def _bid_color(t: float) -> tuple:
    t = max(0.0, min(1.0, t)); g = t ** 0.35
    a = int(10 + 245*g); r = int(0 + 25*g); gr = int(5 + 250*g*g); b = int(0 + 15*g)
    return (min(255,r), min(255,gr), min(255,b), min(255,a))

def _ask_color(t: float) -> tuple:
    t = max(0.0, min(1.0, t)); g = t ** 0.35
    a = int(10 + 245*g); r = int(10 + 245*g*g); gr = int(0 + 10*g); b = int(0 + 12*g)
    return (min(255,r), min(255,gr), min(255,b), min(255,a))

def _draw_col(buf, col, bid_sz, ask_sz, ref):
    """Vectorized column draw using level-based bid/ask arrays."""
    rows = buf.shape[0]; buf[:, col] = BG_RGBA
    ref = max(ref, 1.0)
    bm = (bid_sz > 0.01) & (bid_sz >= ask_sz)
    am = (ask_sz > 0.01) & (ask_sz > bid_sz)
    if np.any(bm):
        t = np.clip(bid_sz[bm]/ref, 0.0, 1.0); g = t**0.35
        r = np.clip(25*g, 0, 25).astype(np.uint8)
        gr = np.clip(5+250*g*g, 0, 255).astype(np.uint8)
        b = np.clip(15*g, 0, 255).astype(np.uint8)
        a = np.clip(10+245*g, 0, 255).astype(np.uint8)
        buf[bm, col, 0] = r; buf[bm, col, 1] = gr; buf[bm, col, 2] = b; buf[bm, col, 3] = a
    if np.any(am):
        t = np.clip(ask_sz[am]/ref, 0.0, 1.0); g = t**0.35
        r = np.clip(10+245*g*g, 0, 255).astype(np.uint8)
        gr = np.clip(10*g, 0, 255).astype(np.uint8)
        b = np.clip(12*g, 0, 255).astype(np.uint8)
        a = np.clip(10+245*g, 0, 255).astype(np.uint8)
        buf[am, col, 0] = r; buf[am, col, 1] = gr; buf[am, col, 2] = b; buf[am, col, 3] = a


class BookmapHeatmap(QWidget):
    price_hovered = pyqtSignal(float)
    price_clicked = pyqtSignal(float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(400, 300)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground, True)
        self.setAutoFillBackground(False)

        self._history: deque = deque(maxlen=600)
        self._trades: deque = deque(maxlen=300)
        self._bbo: Optional[BBO] = None
        self._levels: list[BookLevel] = []
        self._tick_count: int = 0

        # Running reference max (80th percentile with cap)
        self._size_samples: deque = deque(maxlen=5000)
        self._ref_max: float = 500.0

        self._buffer = np.zeros((1, 1, 4), dtype=np.uint8)
        self._buffer[:] = BG_RGBA
        self._qimg: Optional[QImage] = None
        self._needs_rebuild: bool = True
        self._last_vis_rows: int = -1
        self._last_hm_w: int = -1

        # Pre-allocated arrays and memoryview for zero allocation/copying
        self._ba = np.zeros(1, dtype=np.float64)
        self._aa = np.zeros(1, dtype=np.float64)
        self._buffer_mv = None

        self.row_height: int = 4      # thin lines, big gaps
        self.price_axis_w: int = 62
        self.auto_follow: bool = True
        self.show_bbo: bool = True
        self.show_trades: bool = True
        self._min_rh: int = 2
        self._max_rh: int = 24

        self._mx: int = -1; self._my: int = -1
        self._hover_price: Optional[float] = None

    # ── Buffer ──

    def _ensure_buf(self, vr, hw):
        if vr < 1: vr = 1
        if hw < 1: hw = 1
        ch, cw = self._buffer.shape[0], self._buffer.shape[1]
        if ch == vr and cw == hw: return
        nb = np.zeros((vr, hw, 4), dtype=np.uint8); nb[:] = BG_RGBA
        copy_h, copy_w = min(ch, vr), min(cw, hw)
        if copy_h > 0 and copy_w > 0: nb[:copy_h, :copy_w] = self._buffer[:copy_h, :copy_w]
        self._buffer = nb; self._needs_rebuild = True
        
        # Resize pre-allocated arrays
        self._ba = np.zeros(vr, dtype=np.float64)
        self._aa = np.zeros(vr, dtype=np.float64)

    def _refresh_qimg(self):
        h, w = self._buffer.shape[0], self._buffer.shape[1]
        if w > 0 and h > 0: self._qimg = QImage(self._buffer.tobytes(), w, h, w*4, QImage.Format.Format_RGBA8888)
        else: self._qimg = None

    def _vis_rows(self): return max(1, self.height() // self.row_height)
    def _hm_w(self): return max(1, self.width() - self.price_axis_w)

    # ── Ref max ──

    def _update_ref_max(self):
        if len(self._size_samples) < 20:
            self._ref_max = max(500.0, max(self._size_samples) if self._size_samples else 500.0)
            return
        s = sorted(self._size_samples)
        self._ref_max = max(500.0, min(s[int(len(s)*0.80)], 8000.0))

    # ── Level price grid ──

    def _level_prices(self): return sorted([lv.price for lv in self._levels])

    def _visible_prices(self, vis_rows):
        lp = self._level_prices(); n = len(lp)
        if n == 0: return [], 0
        if n <= vis_rows:
            # Center the levels vertically with padding
            pad_top = (vis_rows - n) // 2
            padded = [None]*pad_top + list(reversed(lp)) + [None]*(vis_rows-n-pad_top)
            return padded, pad_top
        mid = (self._bbo.bid+self._bbo.ask)/2 if self._bbo and self._bbo.bid>0 else lp[n//2]
        ci = bisect.bisect_left(lp, mid); ci = max(0, min(n-1, ci))
        so = max(0, min(n-vis_rows, ci-vis_rows//2))
        return list(reversed(lp[so:so+vis_rows])), 0

    def _real_prices(self, vp):
        """Return only the non-None prices from a padded visible list."""
        return [p for p in vp if p is not None]

    # ── Rebuild ──

    def _rebuild(self, vis_rows, hm_w):
        self._buffer[:] = BG_RGBA
        if not self._history or not self._levels: self._needs_rebuild = False; return
        hl = list(self._history); nc = min(hm_w, len(hl)); cs = max(0, len(hl)-hm_w)
        vp, _ = self._visible_prices(vis_rows)
        rp = self._real_prices(vp)
        n_real = len(rp)
        spacing = max(1, vis_rows // max(n_real, 1)) if n_real <= vis_rows else 1
        ref = self._ref_max
        for co in range(nc):
            snap = hl[cs+co]; bc = hm_w-nc+co
            real_idx = 0
            for target in vp:
                if target is None: continue
                buffer_row = real_idx * spacing
                real_idx += 1
                if buffer_row >= vis_rows: continue
                best_p, best_d = None, float('inf')
                for p in snap:
                    d = abs(p-target)
                    if d < best_d: best_d = d; best_p = p
                if best_p is None or best_d > 5.0: continue
                bs, as_ = snap[best_p]
                if bs > 0.01 and bs >= as_:
                    t = min(1.0, bs/ref); r,g,b,a = _bid_color(t)
                    self._buffer[buffer_row, bc] = (r,g,b,a)
                elif as_ > 0.01 and as_ > bs:
                    t = min(1.0, as_/ref); r,g,b,a = _ask_color(t)
                    self._buffer[buffer_row, bc] = (r,g,b,a)
        self._needs_rebuild = False

    # ── Public API ──

    def set_levels(self, levels):
        if not levels: return
        self._levels = levels
        snap = {}
        for lv in levels:
            snap[lv.price] = (lv.bid_size, lv.ask_size)
            if lv.bid_size > 0: self._size_samples.append(lv.bid_size)
            if lv.ask_size > 0: self._size_samples.append(lv.ask_size)
        self._history.append(snap); self._tick_count += 1
        if self._tick_count % 50 == 0: self._update_ref_max()

        vis_rows = self._vis_rows(); hm_w = self._hm_w()
        sc = (vis_rows != self._last_vis_rows or hm_w != self._last_hm_w)

        if sc or self._needs_rebuild:
            self._ensure_buf(vis_rows, hm_w); self._rebuild(vis_rows, hm_w)
        else:
            self._ensure_buf(vis_rows, hm_w)
            if hm_w > 1: self._buffer[:, :-1, :] = self._buffer[:, 1:, :]
            vp, _ = self._visible_prices(vis_rows)
            rp = self._real_prices(vp)
            n_real = len(rp)
            spacing = max(1, vis_rows // max(n_real, 1)) if n_real <= vis_rows else 1
            if self._ba.shape[0] != vis_rows:
                self._ba = np.zeros(vis_rows, dtype=np.float64)
                self._aa = np.zeros(vis_rows, dtype=np.float64)
            ba = self._ba
            aa = self._aa
            ba.fill(0.0)
            aa.fill(0.0)
            real_idx = 0
            for price in vp:
                if price is not None:
                    buf_row = real_idx * spacing
                    real_idx += 1
                    if buf_row < vis_rows:
                        s = snap.get(price, (0,0)); ba[buf_row] = s[0]; aa[buf_row] = s[1]
            _draw_col(self._buffer, hm_w-1, ba, aa, self._ref_max)

        self._last_vis_rows = vis_rows; self._last_hm_w = hm_w
        self._refresh_qimg(); self.update()

    def set_bbo(self, bbo):
        if self._bbo and self._bbo.bid == bbo.bid and self._bbo.ask == bbo.ask:
            return  # no change, skip repaint to avoid flicker
        self._bbo = bbo
        # update() removed — BBO rendered in paintEvent triggered by set_levels

    def add_trade(self, price, size, side):
        self._trades.append((price, size, side, _time.time()))
        # update() removed — trades rendered in paintEvent triggered by set_levels

    def set_row_height(self, h):
        self.row_height = max(self._min_rh, min(self._max_rh, h))
        self._needs_rebuild = True; self.update()

    def set_auto_follow(self, e): self.auto_follow = e
    def zoom_in(self): self.set_row_height(self.row_height + 1)
    def zoom_out(self): self.set_row_height(self.row_height - 1)

    # ── Paint ──

    def resizeEvent(self, e): super().resizeEvent(e); self._needs_rebuild = True

    def paintEvent(self, event):
        p = QPainter(self); p.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        ww, wh = self.width(), self.height()
        vis_rows = self._vis_rows()

        if not self._history or not self._levels:
            p.fillRect(0, 0, ww, wh, QColor(*BG_RGBA))
            p.setPen(QColor(*PRICE_TEXT_COLOR)); p.setFont(QFont('Helvetica Neue', 13))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "No data \u2014 press Start")
            p.end(); return
        ax_w = self.price_axis_w; hm_left = 0; hm_w = ww - ax_w
        p.fillRect(0, 0, ww, wh, QColor(*BG_RGBA[:3]))

        if self._qimg and not self._qimg.isNull():
            p.drawImage(QRect(hm_left, 0, hm_w, wh), self._qimg)

        # BBO lines
        vp, _ = self._visible_prices(vis_rows)
        rp = self._real_prices(vp)
        if self.show_bbo and self._bbo and rp:
            lo, hi = rp[-1] if rp else 0, rp[0] if rp else 1
            pr = hi-lo if hi>lo else 1.0
            def p2y(px): return int((hi-px)/pr*wh)
            font = QFont('Menlo', 9, QFont.Weight.Bold); p.setFont(font)
            fm = QFontMetrics(font)
            for price, pen_c, label in [(self._bbo.bid, BID_G_COLOR, f"{self._bbo.bid:.2f}"),
                                          (self._bbo.ask, ASK_R_COLOR, f"{self._bbo.ask:.2f}")]:
                y = p2y(price)
                if 0 <= y < wh:
                    p.setPen(QPen(QColor(*pen_c), 2)); p.drawLine(hm_left, y, ww, y)
                    p.setPen(QColor(255,255,80)); tw = fm.horizontalAdvance(label)
                    p.drawText(ww-tw-4, y-2, label)
            if self._bbo.bid>0 and self._bbo.ask>0:
                mid = (self._bbo.bid+self._bbo.ask)/2; my = p2y(mid)
                if 0<=my<wh:
                    p.setPen(QPen(QColor(255,255,100,180),1,Qt.PenStyle.DashLine))
                    p.drawLine(hm_left, my, ww, my)

        # Trades
        if self.show_trades:
            now_ts = _time.time()
            for price, sz, side, ts in self._trades:
                age = now_ts-ts
                if age>2.0: continue
                a = int(max(30, 230*(1-age/2)))
                c = QColor(*(TRADE_BUY if side==Side.BUY else TRADE_SELL), a)
                p.setPen(Qt.PenStyle.NoPen); p.setBrush(c)
                y = p2y(price)
                if 0<=y<wh:
                    r = max(1, min(4, int(1+sz*0.01)))
                    p.drawEllipse(hm_w-4-r, y-r, r*2, r*2)

        # Price axis (every 3rd level with spacing)
        if rp:
            p.setPen(QColor(*PRICE_TEXT_COLOR)); p.setFont(QFont('Menlo', 8))
            fm = QFontMetrics(p.font())
            n_real = len(rp)
            spacing = max(1, vis_rows // max(n_real, 1)) if n_real <= vis_rows else 1
            real_idx = 0
            for price in vp:
                if price is not None:
                    if real_idx % 3 == 0:
                        y = real_idx * spacing * self.row_height
                        txt = f"{price:.2f}"; tw = fm.horizontalAdvance(txt)
                        p.drawText(ww-tw-4, y+self.row_height-1, txt)
                    real_idx += 1
                    txt = f"{price:.2f}"; tw = fm.horizontalAdvance(txt)
                    p.drawText(ww-tw-4, y+self.row_height-1, txt)

        # Grid lines every 5 rows
        p.setPen(QPen(QColor(*GRID_COLOR), 1))
        for i in range(0, vis_rows+1, 5):
            y = i*self.row_height; p.drawLine(hm_left, y, ww, y)

        # Crosshair
        if self._my>=0 and self._hover_price is not None:
            p.setPen(QPen(QColor(*CROSSHAIR), 1, Qt.PenStyle.DashLine))
            p.drawLine(hm_left, self._my, ww, self._my)
            p.setPen(QColor(255,255,255)); p.setFont(QFont('Menlo',10,QFont.Weight.Bold))
            p.drawText(hm_left+4, self._my-4, f"{self._hover_price:.2f}")

        p.end()

    # ── Mouse ──

    def mouseMoveEvent(self, e):
        self._my = int(e.position().y()); self._mx = int(e.position().x())
        vp, _ = self._visible_prices(self._vis_rows())
        if vp:
            row = min(self._my//self.row_height, len(vp)-1)
            if 0<=row<len(vp) and vp[row] is not None:
                self._hover_price = vp[row]; self.price_hovered.emit(vp[row])
        self.update()

    def leaveEvent(self, e): self._my=-1; self._hover_price=None; self.update()

    def mousePressEvent(self, e):
        if e.button()==Qt.MouseButton.LeftButton and self._hover_price:
            self.price_clicked.emit(self._hover_price)

    def wheelEvent(self, e):
        if e.modifiers() & Qt.KeyboardModifier.ControlModifier:
            d = e.angleDelta().y()
            if d>0: self.zoom_in()
            else: self.zoom_out()

    def keyPressEvent(self, e):
        k = e.key()
        if k in (Qt.Key.Key_Plus, Qt.Key.Key_Equal): self.zoom_in()
        elif k == Qt.Key.Key_Minus: self.zoom_out()
        elif k == Qt.Key.Key_R: self._needs_rebuild=True; self.update()
