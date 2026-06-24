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

from PyQt6.QtCore import Qt, pyqtSignal, QPointF, QRect, QRectF, QTimer
from PyQt6.QtGui import (
    QPainter, QColor, QPen, QFont, QFontMetrics,
    QPaintEvent, QMouseEvent, QWheelEvent, QKeyEvent, QImage,
    QBrush, QPainterPath, QPixmap,
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
    column_width_changed = pyqtSignal(float)
    view_changed = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(400, 300)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground, True)
        self.setAutoFillBackground(False)

        self._engine = DensityEngine(max_levels=100, history_width=10000, decay=0.92)
        self._bbo: Optional[BBO] = None
        self._levels: list[BookLevel] = []
        self._history: deque = deque(maxlen=10000)  # Compatibility history
        self._all_prices: set[float] = set()  # Compatibility set

        # Trades for dot overlay (higher capacity to allow scrolling history)
        self._trades: deque = deque(maxlen=10000)
        self._trade_med_size: float = 1.0
        self._trade_p95_size: float = 2.0
        self._liquidations: deque = deque(maxlen=200)

        # Volume Bubbles overlay
        self._bubbles = VolumeBubbles()

        # VWAP overlay
        from .overlays.vwap import VWAPOverlay
        self._vwap_overlay = VWAPOverlay(self)

        # Rendering
        self.row_height: int = 4
        self.column_width: float = 1.0
        self.COLUMN_WIDTH_LEVELS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0, 24.0]
        self.price_axis_w: int = 62
        self.right_margin_w: int = 60
        self._scroll_offset: int = 0
        self._drag_start_scroll_offset: int = 0
        self.auto_follow: bool = True
        self._show_bbo: bool = True
        self._show_trades: bool = True
        self._show_heatmap: bool = True
        self._min_rh: int = 2
        self._max_rh: int = 24

        # Mouse
        self._mx: int = -1
        self._my: int = -1
        self._hover_price: Optional[float] = None

        # Dragging state
        self._drag_active: bool = False
        self._drag_start_on_price_axis: bool = False
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

        # Large Lot Tracker
        self._llt_enabled: bool = True
        self._llt_threshold: float = 15.0
        
        # Iceberg Detector
        self._iceberg_enabled: bool = True
        self._iceberg_markers: list[dict] = []
        self._iceberg_accum_data: dict[float, tuple[float, float]] = {}  # price -> (volume, last_ts)
        self._last_visible_size: dict[float, float] = {}  # price -> visible size
        
        # Stops Tracker
        self._stops_enabled: bool = True
        self._stop_threshold: float = 10.0
        self._stop_markers: list[dict] = []

        # Market Pulse Overlay
        self._pulse_enabled: bool = True

        # Throttling state
        self._last_rebuild_time: float = 0.0
        self._rebuild_pending: bool = False

        # Static background caching
        self._static_cache: Optional[QPixmap] = None
        self._cache_dirty: bool = True

    @property
    def _buffer(self) -> np.ndarray:
        """Compatibility property for _buffer. Returns the visible slice of the buffer."""
        buf = self._engine.get_buffer()
        bh = buf.shape[0]
        vis_rows = max(1, self.height() // self.row_height)
        start_row = bh // 2 - vis_rows // 2
        return buf[start_row : start_row + vis_rows, :, :]

    @property
    def show_bbo(self) -> bool:
        return self._show_bbo

    @show_bbo.setter
    def show_bbo(self, val: bool) -> None:
        if self._show_bbo != val:
            self._show_bbo = val
            self._cache_dirty = True

    @property
    def show_trades(self) -> bool:
        return self._show_trades

    @show_trades.setter
    def show_trades(self, val: bool) -> None:
        if self._show_trades != val:
            self._show_trades = val
            self._cache_dirty = True

    @property
    def show_heatmap(self) -> bool:
        return self._show_heatmap

    @show_heatmap.setter
    def show_heatmap(self, val: bool) -> None:
        if self._show_heatmap != val:
            self._show_heatmap = val
            self._cache_dirty = True

    @property
    def llt_enabled(self) -> bool:
        return self._llt_enabled

    @llt_enabled.setter
    def llt_enabled(self, val: bool) -> None:
        if self._llt_enabled != val:
            self._llt_enabled = val
            self._cache_dirty = True

    @property
    def llt_threshold(self) -> float:
        return self._llt_threshold

    @llt_threshold.setter
    def llt_threshold(self, val: float) -> None:
        if self._llt_threshold != val:
            self._llt_threshold = val
            self._cache_dirty = True

    @property
    def iceberg_enabled(self) -> bool:
        return self._iceberg_enabled

    @iceberg_enabled.setter
    def iceberg_enabled(self, val: bool) -> None:
        if self._iceberg_enabled != val:
            self._iceberg_enabled = val
            self._cache_dirty = True

    @property
    def stops_enabled(self) -> bool:
        return self._stops_enabled

    @stops_enabled.setter
    def stops_enabled(self, val: bool) -> None:
        if self._stops_enabled != val:
            self._stops_enabled = val
            self._cache_dirty = True

    @property
    def stop_threshold(self) -> float:
        return self._stop_threshold

    @stop_threshold.setter
    def stop_threshold(self, val: float) -> None:
        if self._stop_threshold != val:
            self._stop_threshold = val
            self._cache_dirty = True

    @property
    def pulse_enabled(self) -> bool:
        return self._pulse_enabled

    @pulse_enabled.setter
    def pulse_enabled(self, val: bool) -> None:
        if self._pulse_enabled != val:
            self._pulse_enabled = val
            self._cache_dirty = True

    @property
    def bubbles_size_multiplier(self) -> float:
        return self._bubbles.size_multiplier

    @bubbles_size_multiplier.setter
    def bubbles_size_multiplier(self, val: float) -> None:
        if self._bubbles.size_multiplier != val:
            self._bubbles.size_multiplier = val
            self._cache_dirty = True

    def _visible_rows(self) -> int:
        """Compatibility method for visible rows."""
        return max(1, self.height() // self.row_height)

    @property
    def _price_min(self) -> float:
        """Compatibility property for minimum price in view."""
        engine = self._engine
        if engine.center_price_ticks is None or engine.render_tick_size <= 0:
            return 0.0
        vis_rows = max(1, self.height() // self.row_height)
        return (engine.center_price_ticks - vis_rows // 2) * engine.render_tick_size

    @property
    def _price_max(self) -> float:
        """Compatibility property for maximum price in view."""
        engine = self._engine
        if engine.center_price_ticks is None or engine.render_tick_size <= 0:
            return 0.0
        vis_rows = max(1, self.height() // self.row_height)
        return (engine.center_price_ticks + vis_rows // 2) * engine.render_tick_size

    def _price_to_screen_y(self, price: float, wh: int) -> float:
        """Unified linear mapping from price → screen Y coordinate."""
        engine = self._engine
        if engine.center_price_ticks is None or engine.render_tick_size <= 0:
            return wh / 2.0
        vis_rows = max(1, wh // self.row_height)
        p_ticks = round(price / engine.render_tick_size)
        screen_row = (vis_rows // 2) - (p_ticks - engine.center_price_ticks)
        return screen_row * self.row_height + self.row_height / 2.0

    def get_visible_prices(self) -> list[float]:
        """Get the list of prices corresponding to each row from top to bottom."""
        engine = self._engine
        if engine.center_price_ticks is None or engine.render_tick_size <= 0:
            return []
        vis_rows = max(1, self.height() // self.row_height)
        return [
            (engine.center_price_ticks + (vis_rows // 2 - r)) * engine.render_tick_size
            for r in range(vis_rows)
        ]

    def get_visible_trades(self) -> list:
        """Get the list of trades currently visible on the heatmap timeframe."""
        if not self._trades:
            return []
        
        # We need the horizontal dimension in columns (bw)
        buf = self._engine.get_buffer()
        if buf is None:
            return []
        bw = buf.shape[1]
        if bw <= 0:
            return []
            
        visible_end_frame = self._frame_count - self._scroll_offset
        start_tick = visible_end_frame - bw + 1
        end_tick = visible_end_frame
        
        import bisect
        trades_list = list(self._trades)
        
        # Binary search for trades within the visible tick range
        start_idx = bisect.bisect_left(trades_list, start_tick, key=lambda t: t[4] if len(t) == 5 else t[3])
        end_idx = bisect.bisect_right(trades_list, end_tick, key=lambda t: t[4] if len(t) == 5 else t[3])
        return trades_list[start_idx:end_idx]

    # ── Public API ────────────────────────────────────────────────

    def push_snapshot(self, levels: list[BookLevel], bbo: Optional[BBO], receive_timestamp: float = 0.0, cvd: float = 0.0) -> None:
        """Feed one tick of data. Called from main window timer."""
        if not levels:
            return
        self._levels = levels
        self._bbo = bbo
        self._last_visible_size = {level.price: (level.bid_size if level.bid_size > 0 else level.ask_size) for level in levels}
        
        # Pre-parse levels into numpy arrays to avoid doing it repeatedly in rebuild_heatmap
        import numpy as np
        bids = [(lv.price, lv.bid_size) for lv in levels if lv.bid_size > 0.0]
        asks = [(lv.price, lv.ask_size) for lv in levels if lv.ask_size > 0.0]
        
        if bids:
            bid_prices = np.array([x[0] for x in bids], dtype=np.float64)
            bid_values = np.array([x[1] for x in bids], dtype=np.float64)
        else:
            bid_prices = np.empty(0, dtype=np.float64)
            bid_values = np.empty(0, dtype=np.float64)
            
        if asks:
            ask_prices = np.array([x[0] for x in asks], dtype=np.float64)
            ask_values = np.array([x[1] for x in asks], dtype=np.float64)
        else:
            ask_prices = np.empty(0, dtype=np.float64)
            ask_values = np.empty(0, dtype=np.float64)

        ts = receive_timestamp or (bbo.receive_timestamp if bbo else time.time())
        self._history.append((levels, bbo, bid_prices, bid_values, ask_prices, ask_values, cvd, ts))  # Keep track of history with pre-parsed arrays
        self._all_prices.update(level.price for level in levels)
        self._last_receive_timestamp = ts

        self._frame_count += 1
        if self.auto_follow:
            self._scroll_offset = 0
        else:
            self._scroll_offset += 1

        vr = max(1, self.height() // self.row_height)
        hm_w = max(1, self.width() - self.price_axis_w)
        timeline_w = max(1, hm_w - self.right_margin_w)
        target_bw = max(1, int(timeline_w / self.column_width))

        # Resize/Rebuild engine if needed
        if vr != self._last_vis_rows or target_bw != self._last_hm_w:
            self.rebuild_heatmap()
        elif self.auto_follow:
            self._engine.push_snapshot(
                levels, bbo, auto_follow=self.auto_follow, vis_rows=vr,
                bid_prices=bid_prices, bid_values=bid_values, ask_prices=ask_prices, ask_values=ask_values,
                cvd=cvd, timestamp=ts
            )
            self._last_vis_rows = vr
            self._last_hm_w = target_bw
            self._sync_vwap()
            self._cache_dirty = True
            self.update()
            self.view_changed.emit()
        else:
            self._cache_dirty = True
            self.update()

    def set_levels(self, levels: list[BookLevel]) -> None:
        """Compatibility method for set_levels."""
        self.push_snapshot(levels, self._bbo)

    def set_bbo(self, bbo: Optional[BBO]) -> None:
        """Compatibility method for set_bbo."""
        self._bbo = bbo
        if self._history:
            entry = self._history[-1]
            if len(entry) == 6:
                self._history[-1] = (entry[0], bbo, entry[2], entry[3], entry[4], entry[5])
            else:
                self._history[-1] = (entry[0], bbo)
        self._cache_dirty = True
        self.update()

    def add_trade(self, price: float, size: float, side: Side, is_liquidation: bool = False) -> None:
        """Record a trade for the dot overlay and volume bubbles."""
        now_ts = time.time()
        self._trades.append((price, size, side, now_ts, self._frame_count))
        self._bubbles.add_trade(price, size, side, self._frame_count)
        
        if is_liquidation:
            self._liquidations.append({
                'price': price,
                'size': size,
                'side': side,
                'tick_index': self._frame_count
            })

        # 1. Iceberg detection
        visible = self._last_visible_size.get(price, 0.0)
        if visible > 0.0:
            vol, last_ts = self._iceberg_accum_data.get(price, (0.0, now_ts))
            if now_ts - last_ts > 3.0:
                vol = 0.0
            new_vol = vol + size
            self._iceberg_accum_data[price] = (new_vol, now_ts)
            
            hidden_vol = new_vol - visible
            if new_vol > visible * 1.5 and hidden_vol >= 1.0:
                # Iceberg detected!
                merged = False
                for marker in self._iceberg_markers:
                    if abs(marker['price'] - price) < 0.000001 and self._frame_count - marker['tick_index'] <= 15:
                        marker['size'] = new_vol
                        marker['timestamp'] = now_ts
                        marker['tick_index'] = self._frame_count
                        merged = True
                        break
                if not merged:
                    self._iceberg_markers.append({
                        'price': price,
                        'size': new_vol,
                        'side': side,
                        'timestamp': now_ts,
                        'tick_index': self._frame_count
                    })
                    
        # 2. Stops tracking (large sudden aggressive trade)
        if size >= self.stop_threshold:
            merged = False
            for marker in self._stop_markers:
                if abs(marker['price'] - price) < 0.000001 and self._frame_count - marker['tick_index'] <= 15:
                    marker['size'] += size
                    marker['timestamp'] = now_ts
                    marker['tick_index'] = self._frame_count
                    merged = True
                    break
            if not merged:
                self._stop_markers.append({
                    'price': price,
                    'size': size,
                    'side': side,
                    'timestamp': now_ts,
                    'tick_index': self._frame_count
                })

        if hasattr(self, '_vwap_overlay') and self._vwap_overlay is not None:
            self._vwap_overlay.add_trade(price, size)
        
        self._update_trade_size_percentiles()

    def add_trades(self, trades: list[Trade]) -> None:
        """Record multiple trades for the dot overlay and volume bubbles in batch."""
        now_ts = time.time()
        for trade in trades:
            price, size, side = trade.price, trade.size, trade.side
            self._trades.append((price, size, side, now_ts, self._frame_count))
            self._bubbles.add_trade(price, size, side, self._frame_count)
            
            if trade.is_liquidation:
                self._liquidations.append({
                    'price': price,
                    'size': size,
                    'side': side,
                    'tick_index': self._frame_count
                })

            # 1. Iceberg detection
            visible = self._last_visible_size.get(price, 0.0)
            if visible > 0.0:
                vol, last_ts = self._iceberg_accum_data.get(price, (0.0, now_ts))
                if now_ts - last_ts > 3.0:
                    vol = 0.0
                new_vol = vol + size
                self._iceberg_accum_data[price] = (new_vol, now_ts)
                
                hidden_vol = new_vol - visible
                if new_vol > visible * 1.5 and hidden_vol >= 1.0:
                    # Iceberg detected!
                    merged = False
                    for marker in self._iceberg_markers:
                        if abs(marker['price'] - price) < 0.000001 and self._frame_count - marker['tick_index'] <= 15:
                            marker['size'] = new_vol
                            marker['timestamp'] = now_ts
                            marker['tick_index'] = self._frame_count
                            merged = True
                            break
                    if not merged:
                        self._iceberg_markers.append({
                            'price': price,
                            'size': new_vol,
                            'side': side,
                            'timestamp': now_ts,
                            'tick_index': self._frame_count
                        })
                        
            # 2. Stops tracking (large sudden aggressive trade)
            if size >= self.stop_threshold:
                merged = False
                for marker in self._stop_markers:
                    if abs(marker['price'] - price) < 0.000001 and self._frame_count - marker['tick_index'] <= 15:
                        marker['size'] += size
                        marker['timestamp'] = now_ts
                        marker['tick_index'] = self._frame_count
                        merged = True
                        break
                if not merged:
                    self._stop_markers.append({
                        'price': price,
                        'size': size,
                        'side': side,
                        'timestamp': now_ts,
                        'tick_index': self._frame_count
                    })

            if hasattr(self, '_vwap_overlay') and self._vwap_overlay is not None:
                self._vwap_overlay.add_trade(price, size)

        self._update_trade_size_percentiles()
        self._cache_dirty = True

    def _update_trade_size_percentiles(self) -> None:
        """Cache trade size median and 95th percentiles to avoid doing it in the paint event loop."""
        import numpy as np
        if not self._trades:
            self._trade_med_size = 1.0
            self._trade_p95_size = 2.0
            return
        sizes = [t[1] for t in self._trades]
        self._trade_med_size = float(np.median(sizes))
        self._trade_p95_size = float(np.percentile(sizes, 95))
        if self._trade_p95_size <= self._trade_med_size:
            self._trade_p95_size = self._trade_med_size + 1.0

    def rebuild_heatmap(self) -> None:
        """Fully rebuild/re-render the entire heatmap buffer from history."""
        vr = max(1, self.height() // self.row_height)
        hm_w = max(1, self.width() - self.price_axis_w)
        timeline_w = max(1, hm_w - self.right_margin_w)
        target_bw = max(1, int(timeline_w / self.column_width))
        
        # 1. Clear engine buffer and state
        if hasattr(self._engine, '_bid_density') and self._engine._bid_density:
            self._engine._bid_density.clear()
        if hasattr(self._engine, '_ask_density') and self._engine._ask_density:
            self._engine._ask_density.clear()
        self._engine._price_history.clear()
        self._engine._bbo_history.clear()
        
        # Reset normalizers to starting references
        self._engine._bid_normalizer.global_ref = self._engine.config.bid_ref
        self._engine._ask_normalizer.global_ref = self._engine.config.ask_ref
        
        # 2. Re-push all historical snapshots through the engine
        history_list = list(self._history)
        end_idx = len(history_list) - self._scroll_offset
        start_idx = max(0, end_idx - target_bw)
        end_idx = max(0, end_idx)
        history_slice = history_list[start_idx:end_idx]
            
        start_col = target_bw - len(history_slice)

        # Detect tick size from snapshots first
        detected_tick_size = 0.05
        for entry in history_slice:
            levels = entry[0]
            if levels:
                prices = sorted([lv.price for lv in levels])
                if len(prices) >= 2:
                    diffs = np.diff(prices)
                    valid_diffs = diffs[diffs > 0.000001]
                    if len(valid_diffs) > 0:
                        detected_tick_size = round(float(np.min(valid_diffs)), 6)
                        break
        self._engine.tick_size = detected_tick_size
        self._engine._tick_size_detected = True

        # Precompute centering ticks to avoid vertical rolling during rebuild loop
        final_center = self._engine.center_price_ticks
        final_center_float = self._engine._center_price_ticks_float
        final_drift = self._engine._in_recenter_drift

        if self.auto_follow:
            if history_slice:
                first_mid = 0.0
                for entry in history_slice:
                    b = entry[1]
                    if b and b.bid > 0 and b.ask > 0:
                        first_mid = (b.bid + b.ask) / 2.0
                        break
                if first_mid > 0.0:
                    render_tick_size = detected_tick_size * self._engine.ticks_per_row
                    if render_tick_size <= 0.0:
                        render_tick_size = 0.05
                    
                    center_ticks = int(round(first_mid / render_tick_size))
                    center_ticks_float = float(center_ticks)
                    in_recenter_drift = False

                    centering_mode = self._engine.centering_mode
                    centering_ema_alpha = self._engine.centering_ema_alpha
                    centering_deadband_pct = self._engine.centering_deadband_pct

                    for entry in history_slice:
                        b = entry[1]
                        if not b or b.bid <= 0 or b.ask <= 0:
                            continue
                        mid = (b.bid + b.ask) / 2.0
                        mid_ticks_float = mid / render_tick_size

                        if centering_mode == "immediate":
                            center_ticks = int(round(mid_ticks_float))
                            center_ticks_float = float(center_ticks)
                        elif centering_mode == "deadband":
                            deadband = max(1, int(centering_deadband_pct * vr))
                            current_mid_ticks_int = int(round(mid_ticks_float))
                            delta = current_mid_ticks_int - center_ticks
                            if abs(delta) > deadband:
                                center_ticks = current_mid_ticks_int
                                center_ticks_float = float(center_ticks)
                        elif centering_mode == "ema":
                            current_mid_ticks_int = int(round(mid_ticks_float))
                            delta = current_mid_ticks_int - center_ticks
                            if abs(delta) > vr // 2:
                                center_ticks = current_mid_ticks_int
                                center_ticks_float = float(center_ticks)
                            else:
                                center_ticks_float = (
                                    (1.0 - centering_ema_alpha) * center_ticks_float +
                                    centering_ema_alpha * mid_ticks_float
                                )
                                center_ticks = int(round(center_ticks_float))
                        elif centering_mode == "smooth_deadband":
                            deadband = max(1, int(centering_deadband_pct * vr))
                            current_mid_ticks_int = int(round(mid_ticks_float))
                            delta = current_mid_ticks_int - center_ticks
                            if abs(delta) > vr // 2:
                                center_ticks = current_mid_ticks_int
                                center_ticks_float = float(center_ticks)
                                in_recenter_drift = False
                            elif abs(delta) > deadband or in_recenter_drift:
                                in_recenter_drift = True
                                center_ticks_float = (
                                    (1.0 - centering_ema_alpha) * center_ticks_float +
                                    centering_ema_alpha * mid_ticks_float
                                )
                                center_ticks = int(round(center_ticks_float))
                                if abs(center_ticks_float - mid_ticks_float) < 1.0:
                                    in_recenter_drift = False
                            else:
                                center_ticks_float = float(center_ticks)

                    final_center = center_ticks
                    final_center_float = center_ticks_float
                    final_drift = in_recenter_drift
        else:
            if final_center is None and history_slice:
                first_mid = 0.0
                for entry in reversed(history_slice):
                    b = entry[1]
                    if b and b.bid > 0 and b.ask > 0:
                        first_mid = (b.bid + b.ask) / 2.0
                        break
                if first_mid > 0.0:
                    render_tick_size = detected_tick_size * self._engine.ticks_per_row
                    if render_tick_size <= 0.0:
                        render_tick_size = 0.05
                    final_center = int(round(first_mid / render_tick_size))
                    final_center_float = float(final_center)
                    final_drift = False

        self._engine.center_price_ticks = final_center
        self._engine._center_price_ticks_float = final_center_float
        self._engine._in_recenter_drift = final_drift

        # Resize engine buffer to the new size and fill with BG_COLOR
        self._engine.resize(vr, target_bw)
        self._engine.get_buffer()[:] = ColorSystem.BG_COLOR
        
        print(f"[DEBUG_REBUILD] target_bw={target_bw} history_len={len(history_list)} scroll_offset={self._scroll_offset} slice_len={len(history_slice)} start_col={start_col} auto_follow={self.auto_follow}", flush=True)
        for idx, entry in enumerate(history_slice):
            is_last = (idx == len(history_slice) - 1)
            hist_levels = entry[0]
            hist_bbo = entry[1]
            bid_p = entry[2] if len(entry) > 2 else None
            bid_v = entry[3] if len(entry) > 3 else None
            ask_p = entry[4] if len(entry) > 4 else None
            ask_v = entry[5] if len(entry) > 5 else None
            hist_cvd = entry[6] if len(entry) > 6 else 0.0
            hist_ts = entry[7] if len(entry) > 7 else (hist_bbo.receive_timestamp if hist_bbo else 0.0)
            
            self._engine.push_snapshot(
                hist_levels,
                hist_bbo,
                auto_follow=self.auto_follow,
                vis_rows=vr,
                update_normalizer=True,
                detect_tick_size=is_last,
                col_idx=start_col + idx,
                bid_prices=bid_p,
                bid_values=bid_v,
                ask_prices=ask_p,
                ask_values=ask_v,
                cvd=hist_cvd,
                timestamp=hist_ts
            )
            
        self._last_vis_rows = vr
        self._last_hm_w = target_bw
        self._sync_vwap()
        self._cache_dirty = True
        self.update()
        self.view_changed.emit()

    def request_rebuild_throttled(self) -> None:
        """Request a heatmap rebuild, throttled to max 20 FPS (every 50ms) to prevent UI lag during dragging/scrolling."""
        now = time.time()
        if now - self._last_rebuild_time > 0.05:
            self._last_rebuild_time = now
            self._rebuild_pending = False
            self.rebuild_heatmap()
        else:
            if not self._rebuild_pending:
                self._rebuild_pending = True
                QTimer.singleShot(50, self._deferred_rebuild)

    def _deferred_rebuild(self) -> None:
        if self._rebuild_pending:
            self._rebuild_pending = False
            self._last_rebuild_time = time.time()
            self.rebuild_heatmap()

    def _sync_vwap(self) -> None:
        if hasattr(self, '_vwap_overlay') and self._vwap_overlay is not None:
            from types import SimpleNamespace
            prices = self.get_visible_prices()
            self._vwap_overlay.sync_visible_levels([SimpleNamespace(price=p) for p in prices], 0)
            self._vwap_overlay.row_height = self.row_height
            self._vwap_overlay.price_column_width = self.price_axis_w

    def reset(self) -> None:
        """Clear all historical state for a new session/symbol."""
        self._history.clear()
        self._trades.clear()
        self._liquidations.clear()
        self._bubbles.clear()
        self._all_prices.clear()
        self._frame_count = 0
        self._last_receive_timestamp = 0.0
        self._latency_history.clear()
        self.last_latency_ms = None
        self._iceberg_markers.clear()
        self._iceberg_accum_data.clear()
        self._stop_markers.clear()
        if hasattr(self, '_vwap_overlay') and self._vwap_overlay is not None:
            self._vwap_overlay.reset()
        self._engine.reset()
        self.rebuild_heatmap()

    def set_row_height(self, h: int) -> None:
        self.zoom_to_height(h)

    def zoom_to_height(self, h: int) -> None:
        old_h = self.row_height
        new_h = max(self._min_rh, min(self._max_rh, h))
        if old_h == new_h:
            return

        self.row_height = new_h
        self.request_rebuild_throttled()
        
        # Update hover price under cursor
        engine = self._engine
        vr = max(1, self.height() // new_h)
        if self._my >= 0 and engine.center_price_ticks is not None and engine.render_tick_size > 0:
            row = self._my * vr / max(1, self.height()) - 0.5
            p_ticks = engine.center_price_ticks + (vr // 2 - row)
            self._hover_price = round(p_ticks) * engine.render_tick_size
            self.price_hovered.emit(self._hover_price)

        self.row_height_changed.emit(self.row_height)

    def set_column_width(self, w: float) -> None:
        old_w = self.column_width
        closest_w = min(self.COLUMN_WIDTH_LEVELS, key=lambda x: abs(x - w))
        if old_w == closest_w:
            return
        self.column_width = closest_w
        self.request_rebuild_throttled()
        self.column_width_changed.emit(self.column_width)

    def timeframe_zoom_in(self) -> None:
        """Zoom in timeframe (stretch horizontally = increase column width)."""
        current = self.column_width
        levels = self.COLUMN_WIDTH_LEVELS
        next_val = current
        for val in levels:
            if val > current:
                next_val = val
                break
        if next_val != current:
            self.set_column_width(next_val)

    def timeframe_zoom_out(self) -> None:
        """Zoom out timeframe (squeeze horizontally = decrease column width)."""
        current = self.column_width
        levels = self.COLUMN_WIDTH_LEVELS
        next_val = current
        for val in reversed(levels):
            if val < current:
                next_val = val
                break
        if next_val != current:
            self.set_column_width(next_val)

    def scroll_time(self, delta_cols: int) -> None:
        """Scroll timeframe horizontally by delta_cols."""
        hm_w = max(1, self.width() - self.price_axis_w)
        timeline_w = max(1, hm_w - self.right_margin_w)
        target_bw = max(1, int(timeline_w / self.column_width))
        max_scroll = max(0, len(self._history) - target_bw)
        new_scroll = max(0, min(max_scroll, self._scroll_offset + delta_cols))
        
        if new_scroll == 0:
            self.auto_follow = True
        else:
            self.auto_follow = False  # Disable follow on manual scroll

        if new_scroll != self._scroll_offset:
            self._scroll_offset = new_scroll
            self.request_rebuild_throttled()

    def set_decay(self, d: float) -> None:
        self._engine.set_decay(d)

    def set_min_order_size(self, size: float) -> None:
        """Filter out limit orders smaller than 'size' from the heatmap."""
        self._engine.min_order_size = size
        self.rebuild_heatmap()

    def set_vertical_smoothing(self, s: float) -> None:
        self._engine.set_vertical_smoothing(s)
        self._cache_dirty = True
        self.update()

    def set_auto_follow(self, e: bool) -> None:
        self.auto_follow = e

    def zoom_in(self) -> None:
        self.zoom_to_height(self.row_height + 1)

    def zoom_out(self) -> None:
        self.zoom_to_height(self.row_height - 1)

    def price_zoom_in(self) -> None:
        """Increase detail by decreasing ticks grouped per row."""
        current = self._engine.ticks_per_row
        levels = [1, 2, 5, 10, 20, 50, 100, 200, 500]
        next_val = current
        for val in reversed(levels):
            if val < current:
                next_val = val
                break
        if next_val != current:
            self._engine.ticks_per_row = next_val
            self.rebuild_heatmap()

    def price_zoom_out(self) -> None:
        """Decrease detail (fit wider range) by increasing ticks grouped per row."""
        current = self._engine.ticks_per_row
        levels = [1, 2, 5, 10, 20, 50, 100, 200, 500]
        next_val = current
        for val in levels:
            if val > current:
                next_val = val
                break
        if next_val != current:
            self._engine.ticks_per_row = next_val
            self.rebuild_heatmap()

    def reset_view(self) -> None:
        self.row_height = 4
        self.column_width = 1.0
        self.auto_follow = True
        self.rebuild_heatmap()

    def scroll_price(self, delta_ticks: int) -> None:
        """Scroll price vertically by delta_ticks."""
        engine = self._engine
        if engine.center_price_ticks is not None and delta_ticks != 0:
            self.auto_follow = False  # Disable follow on manual scroll
            target_center_ticks = engine.center_price_ticks + delta_ticks
            
            # Roll buffer vertically
            buf_h = engine.get_buffer().shape[0]
            engine._buffer = np.roll(engine._buffer, delta_ticks, axis=0)
            if delta_ticks > 0:
                if delta_ticks >= buf_h:
                    engine._buffer[:] = ColorSystem.BG_COLOR
                else:
                    engine._buffer[:delta_ticks, :, :] = ColorSystem.BG_COLOR
            else:
                if abs(delta_ticks) >= buf_h:
                    engine._buffer[:] = ColorSystem.BG_COLOR
                else:
                    engine._buffer[delta_ticks:, :, :] = ColorSystem.BG_COLOR
            engine.center_price_ticks = target_center_ticks
            engine._center_price_ticks_float = float(target_center_ticks)
            engine._in_recenter_drift = False
            
            self._cache_dirty = True
            self.update()
            self.view_changed.emit()

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

        ww, wh = self.width(), self.height()

        if (self._static_cache is None or 
            self._static_cache.width() != ww or 
            self._static_cache.height() != wh or 
            self._cache_dirty):
            
            cache_w = max(1, ww)
            cache_h = max(1, wh)
            self._static_cache = QPixmap(cache_w, cache_h)
            cache_painter = QPainter(self._static_cache)
            cache_painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)
            
            # Fill background
            cache_painter.fillRect(0, 0, cache_w, cache_h, Colors.BG_DEEP)

            if len(self._levels) > 0:
                buf = self._engine.get_buffer()
                bh, bw = buf.shape[0], buf.shape[1]
                if bh > 0 and bw > 0:
                    hm_left = 0
                    hm_w = cache_w - self.price_axis_w
                    timeline_w = max(1, hm_w - self.right_margin_w)

                    if self.show_heatmap:
                        qimg = QImage(
                            buf.data,
                            bw,
                            bh,
                            bw * 4,
                            QImage.Format.Format_RGBA8888,
                        )

                        # Set SmoothPixmapTransform to False to ensure nearest-neighbor scaling
                        cache_painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
                        
                        # Draw only the visible slice of the QImage to the viewport
                        vis_rows = max(1, cache_h // self.row_height)
                        start_row = bh // 2 - vis_rows // 2
                        cache_painter.drawImage(
                            QRect(hm_left, 0, timeline_w, cache_h),
                            qimg,
                            QRect(0, start_row, bw, vis_rows)
                        )

                    # Draw BBO history lines
                    self._draw_bbo_history_lines(cache_painter, cache_w, cache_h, timeline_w)

                    # Draw trades
                    if self.show_trades:
                        self._draw_trades(cache_painter, cache_w, cache_h, timeline_w)

                    # Draw liquidations
                    self._draw_liquidations(cache_painter, cache_w, cache_h, timeline_w)

                    # Draw large lot tracker lines (LLT)
                    self._draw_llt_lines(cache_painter, cache_w, cache_h, timeline_w)

                    # Draw stops execution badges
                    self._draw_stops(cache_painter, cache_w, cache_h, timeline_w)

                    # Draw icebergs badges
                    self._draw_icebergs(cache_painter, cache_w, cache_h, timeline_w)

                    # Draw volume bubbles (after heatmap, before axis)
                    if self.show_trades and self._levels:
                        cache_painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
                        price_to_y = lambda price: self._price_to_screen_y(price, cache_h)
                        visible_end_frame = self._frame_count - self._scroll_offset
                        self._bubbles.draw(cache_painter, cache_w, cache_h, timeline_w, price_to_y, visible_end_frame, bw, self.row_height, self._engine.ticks_per_row)
                        cache_painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)

                    # Draw pulse overlay boxes (top left)
                    self._draw_pulse_boxes(cache_painter, cache_w, cache_h)

                    # Draw vertical timeline boundary separator line
                    cache_painter.setPen(QPen(Colors.BORDER_SUBTLE, 1.0, Qt.PenStyle.SolidLine))
                    cache_painter.drawLine(QPointF(timeline_w, 0), QPointF(timeline_w, cache_h))

                    # Draw price axis
                    self._draw_price_axis(cache_painter, cache_w, cache_h)

                    # Draw BBO current lines (on top of price axis to ensure readability)
                    if self.show_bbo and self._bbo:
                        self._draw_bbo_lines(cache_painter, cache_w, cache_h, hm_left)
            else:
                # No data state
                cache_painter.setPen(Colors.TEXT_SECONDARY)
                cache_painter.setFont(Fonts.sans(13))
                cache_painter.drawText(
                    QRect(0, 0, cache_w, cache_h),
                    Qt.AlignmentFlag.AlignCenter,
                    "No data — Start simulation",
                )

            # Draw latency overlay in top-right of heatmap
            if self.last_latency_ms is not None:
                cache_painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
                cache_painter.setFont(Fonts.mono(9, bold=True))
                lat_str = f"WS-to-UI: {self.last_latency_ms:.1f}ms"
                fm = cache_painter.fontMetrics()
                tw = fm.horizontalAdvance(lat_str)
                th = fm.height()
                
                hm_w = cache_w - self.price_axis_w
                px = cache_w - self.price_axis_w - tw - 12
                py = 10
                
                cache_painter.setBrush(QBrush(QColor(0, 0, 0, 160)))
                cache_painter.setPen(Qt.PenStyle.NoPen)
                cache_painter.drawRoundedRect(QRectF(px - 6, py - 4, tw + 12, th + 8), 4.0, 4.0)
                
                if self.last_latency_ms <= 20.0:
                    cache_painter.setPen(QColor("#00E676"))  # bright green
                elif self.last_latency_ms <= 50.0:
                    cache_painter.setPen(QColor("#FFD600"))  # bright yellow
                else:
                    cache_painter.setPen(QColor("#FF1744"))  # bright red
                    
                cache_painter.drawText(QPointF(px, py + th - 2), lat_str)
                cache_painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)

            cache_painter.end()
            self._cache_dirty = False

        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        
        # Draw the cached static background image
        p.drawPixmap(0, 0, self._static_cache)

        # Draw dynamic overlay (Crosshair)
        if self._my >= 0 and self._hover_price is not None:
            p.setPen(QPen(QColor(Colors.TEXT_SECONDARY.red(), Colors.TEXT_SECONDARY.green(), Colors.TEXT_SECONDARY.blue(), 90), 1, Qt.PenStyle.DashLine))
            p.drawLine(0, self._my, ww, self._my)
            
            p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
            p.setFont(Fonts.mono(10, bold=True))
            txt = f"{self._hover_price:.2f}"
            fm = p.fontMetrics()
            tw = fm.horizontalAdvance(txt)
            th = fm.height()
            
            # Left edge pill background
            px = 4.0
            py = float(self._my)
            rect_w = tw + 8
            rect_h = th + 4
            rect_x = px
            rect_y = py - rect_h / 2
            
            p.setBrush(QBrush(QColor(10, 11, 16, 240)))
            p.setPen(QPen(Colors.TEXT_SECONDARY, 1.0))
            p.drawRoundedRect(QRectF(rect_x, rect_y, rect_w, rect_h), 4.0, 4.0)
            
            p.setPen(Colors.TEXT_BRIGHT)
            p.drawText(QPointF(px + 4, rect_y + fm.ascent() + 2), txt)
            p.setRenderHint(QPainter.RenderHint.Antialiasing, False)

        # Draw "Go Live" button if not in auto-follow
        if not self.auto_follow:
            p.save()
            p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
            hm_w = ww - self.price_axis_w
            timeline_w = max(1, hm_w - self.right_margin_w)
            btn_rect = QRectF(timeline_w - 110, wh - 45, 100, 30)
            
            # Check hover
            is_hovered = btn_rect.contains(QPointF(self._mx, self._my))
            
            # Style
            bg_color = QColor(30, 41, 59, 230) if is_hovered else QColor(15, 23, 42, 200)
            border_color = QColor(59, 130, 246, 255) if is_hovered else QColor(59, 130, 246, 150)
            text_color = QColor(255, 255, 255) if is_hovered else QColor(148, 163, 184)
            
            p.setBrush(QBrush(bg_color))
            p.setPen(QPen(border_color, 1.2))
            p.drawRoundedRect(btn_rect, 6.0, 6.0)
            
            # Draw text
            p.setFont(Fonts.sans(11, bold=True))
            fm = p.fontMetrics()
            txt = "↩ Go Live"
            tw = fm.horizontalAdvance(txt)
            th = fm.height()
            
            text_x = btn_rect.x() + (btn_rect.width() - tw) / 2.0
            text_y = btn_rect.y() + (btn_rect.height() - th) / 2.0 + fm.ascent()
            
            p.setPen(text_color)
            p.drawText(QPointF(text_x, text_y), txt)
            p.restore()

        p.end()

    def _draw_bbo_history_lines(
        self, p: QPainter, ww: int, wh: int, hm_w: int
    ) -> None:
        """Draw the historical mid-price line and bid/ask spread lines directly on the heatmap."""
        import numpy as np
        buf = self._engine.get_buffer()
        bw = buf.shape[1]
        if bw <= 0 or self._engine.center_price_ticks is None or self._engine.tick_size <= 0:
            return

        prices = self._engine.get_price_history()
        prices = prices[-bw:]
        n_hist = len(prices)
        if n_hist < 2:
            return

        p.save()
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        
        # 1. Draw mid-price trajectory line (neon magenta with glow)
        prices_arr = np.array(prices)
        valid = prices_arr > 0
        if np.any(valid):
            # Mid price glow
            self._draw_historical_price_line(
                p, prices_arr, QColor(255, 0, 255, 50), 6.0, bw, hm_w, n_hist
            )
            # Mid price main line
            self._draw_historical_price_line(
                p, prices_arr, QColor(255, 0, 255, 240), 2.0, bw, hm_w, n_hist
            )

        # 2. Draw Best Bid (green) and Best Offer (red) lines to show the spread
        if self.show_bbo:
            history_list = list(self._history)[-bw:]
            n_hist_bbo = len(history_list)
            if n_hist_bbo >= 2:
                bids = []
                asks = []
                for entry in history_list:
                    bbo = entry[1]
                    if bbo is not None:
                        bids.append(bbo.bid)
                        asks.append(bbo.ask)
                    else:
                        bids.append(0.0)
                        asks.append(0.0)

                bids_arr = np.array(bids)
                asks_arr = np.array(asks)

                # Best Bid line (green)
                green_color = QColor(Colors.ACCENT_GREEN.red(), Colors.ACCENT_GREEN.green(), Colors.ACCENT_GREEN.blue(), 180)
                self._draw_historical_price_line(
                    p, bids_arr, green_color, 1.2, bw, hm_w, n_hist_bbo
                )

                # Best Ask line (red)
                red_color = QColor(Colors.ACCENT_RED.red(), Colors.ACCENT_RED.green(), Colors.ACCENT_RED.blue(), 180)
                self._draw_historical_price_line(
                    p, asks_arr, red_color, 1.2, bw, hm_w, n_hist_bbo
                )

        p.restore()

    def _draw_historical_price_line(
        self, p: QPainter, prices_arr: np.ndarray, color: QColor, width: float, bw: int, hm_w: int, n_hist: int
    ) -> None:
        """Helper to draw a single vectorized historical price line on the heatmap."""
        import numpy as np
        buf = self._engine.get_buffer()
        bh = buf.shape[0]
        tick_size = self._engine.tick_size
        center_ticks = self._engine.center_price_ticks
        y_scale = self.height() / bh
        y_offset = y_scale / 2.0
        half_bh = bh / 2.0

        valid = prices_arr > 0
        if not np.any(valid):
            return

        p_ticks = np.round(prices_arr / tick_size)
        rows = half_bh - (p_ticks - center_ticks)
        ys = rows * y_scale + y_offset
        cols = np.arange(bw - n_hist, bw)
        xs = cols * (hm_w / bw)

        if np.all(valid):
            points = [QPointF(xs[i], ys[i]) for i in range(n_hist)]
            pen = QPen(color, width, Qt.PenStyle.SolidLine)
            p.setPen(pen)
            p.drawPolyline(points)
        else:
            runs = np.diff(np.concatenate(([False], valid, [False])))
            starts = np.where(runs == 1)[0]
            ends = np.where(runs == -1)[0]
            for start, end in zip(starts, ends):
                if end - start >= 2:
                    points = [QPointF(xs[i], ys[i]) for i in range(start, end)]
                    pen = QPen(color, width, Qt.PenStyle.SolidLine)
                    p.setPen(pen)
                    p.drawPolyline(points)

    def _draw_bbo_lines(
        self, p: QPainter, ww: int, wh: int, hm_left: int
    ) -> None:
        """Draw bid (green), ask (red), and a highly distinct mid-price line."""
        if not self._bbo or not self._levels:
            return

        p.save()
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        hm_w = ww - self.price_axis_w
        font = Fonts.mono(9, bold=True)
        p.setFont(font)
        fm = QFontMetrics(font)
        label_h = fm.height() + 4

        y_bid = self._price_to_screen_y(self._bbo.bid, wh)
        y_ask = self._price_to_screen_y(self._bbo.ask, wh)

        # Enforce minimum line separation of 3.0 pixels for visual distinctness of the spread.
        y_mid = (y_ask + y_bid) / 2.0
        if abs(y_bid - y_ask) < 3.0:
            y_ask_line = y_mid - 1.5
            y_bid_line = y_mid + 1.5
        else:
            y_ask_line = y_ask
            y_bid_line = y_bid

        # Determine badge Y positions to prevent overlapping.
        # Screen Y decreases as price increases, so y_ask < y_bid.
        if abs(y_bid - y_ask) < label_h:
            diff = label_h - abs(y_bid - y_ask)
            y_ask_badge = y_ask - diff / 2.0
            y_bid_badge = y_bid + diff / 2.0
            show_mid_badge = False
        elif abs(y_bid - y_ask) < 2 * label_h:
            y_ask_badge = y_ask
            y_bid_badge = y_bid
            show_mid_badge = False
        else:
            y_ask_badge = y_ask
            y_bid_badge = y_bid
            show_mid_badge = True

        # Draw Ask line & badge
        if 0 <= y_ask < wh:
            # Solid ACCENT_RED line with high visibility (alpha=220), width=1.5
            if 0 <= y_ask_line < wh:
                ask_color = QColor(Colors.ACCENT_RED.red(), Colors.ACCENT_RED.green(), Colors.ACCENT_RED.blue(), 220)
                p.setPen(QPen(ask_color, 1.5, Qt.PenStyle.SolidLine))
                p.drawLine(QPointF(hm_left, y_ask_line), QPointF(hm_w, y_ask_line))

            if 0 <= y_ask_badge < wh:
                badge_w = self.price_axis_w - 4
                badge_x = ww - self.price_axis_w + 2
                badge_y = y_ask_badge - label_h / 2.0

                p.setBrush(QBrush(QColor(10, 11, 16, 255)))
                p.setPen(QPen(ask_color, 1.2))
                p.drawRoundedRect(QRectF(badge_x, badge_y, badge_w, label_h), 4.0, 4.0)

                p.setPen(ask_color)
                label = f"{self._bbo.ask:.2f}"
                tw = fm.horizontalAdvance(label)
                tx = badge_x + (badge_w - tw) / 2.0
                ty = badge_y + fm.ascent() + 2.0
                p.drawText(QPointF(tx, ty), label)

        # Draw Bid line & badge
        if 0 <= y_bid < wh:
            # Solid ACCENT_GREEN line with high visibility (alpha=220), width=1.5
            if 0 <= y_bid_line < wh:
                bid_color = QColor(Colors.ACCENT_GREEN.red(), Colors.ACCENT_GREEN.green(), Colors.ACCENT_GREEN.blue(), 220)
                p.setPen(QPen(bid_color, 1.5, Qt.PenStyle.SolidLine))
                p.drawLine(QPointF(hm_left, y_bid_line), QPointF(hm_w, y_bid_line))

            if 0 <= y_bid_badge < wh:
                badge_w = self.price_axis_w - 4
                badge_x = ww - self.price_axis_w + 2
                badge_y = y_bid_badge - label_h / 2.0

                p.setBrush(QBrush(QColor(10, 11, 16, 255)))
                p.setPen(QPen(bid_color, 1.2))
                p.drawRoundedRect(QRectF(badge_x, badge_y, badge_w, label_h), 4.0, 4.0)

                p.setPen(bid_color)
                label = f"{self._bbo.bid:.2f}"
                tw = fm.horizontalAdvance(label)
                tx = badge_x + (badge_w - tw) / 2.0
                ty = badge_y + fm.ascent() + 2.0
                p.drawText(QPointF(tx, ty), label)

        # Draw Mid line & badge
        mid_price = (self._bbo.bid + self._bbo.ask) / 2.0
        y_mid = self._price_to_screen_y(mid_price, wh)
        if 0 <= y_mid < wh:
            # Dashed neon magenta line with alpha=150, width=1.0
            magenta_color = QColor(255, 0, 255, 150)
            p.setPen(QPen(magenta_color, 1.0, Qt.PenStyle.DashLine))
            p.drawLine(QPointF(hm_left, y_mid), QPointF(hm_w, y_mid))

            if show_mid_badge:
                badge_w = self.price_axis_w - 4
                badge_x = ww - self.price_axis_w + 2
                badge_y = y_mid - label_h / 2.0

                p.setBrush(QBrush(QColor(10, 11, 16, 255)))
                solid_magenta_color = QColor(255, 0, 255, 255)
                p.setPen(QPen(solid_magenta_color, 1.5))
                p.drawRoundedRect(QRectF(badge_x, badge_y, badge_w, label_h), 4.0, 4.0)

                p.setPen(solid_magenta_color)
                txt = f"{mid_price:.2f}"
                tw = fm.horizontalAdvance(txt)
                tx = badge_x + (badge_w - tw) / 2.0
                ty = badge_y + fm.ascent() + 2.0
                p.drawText(QPointF(tx, ty), txt)

        p.restore()

    def _draw_trades(
        self, p: QPainter, ww: int, wh: int, hm_w: int
    ) -> None:
        """Draw trade dots at price positions."""
        if not self._levels:
            return
        buf = self._engine.get_buffer()
        bw = buf.shape[1]
        if bw <= 0:
            return

        engine = self._engine
        if engine.center_price_ticks is None or engine.render_tick_size <= 0:
            return
        bh = buf.shape[0]
        
        green_r, green_g, green_b = Colors.ACCENT_GREEN.red(), Colors.ACCENT_GREEN.green(), Colors.ACCENT_GREEN.blue()
        red_r, red_g, red_b = Colors.ACCENT_RED.red(), Colors.ACCENT_RED.green(), Colors.ACCENT_RED.blue()

        p.setPen(Qt.PenStyle.NoPen)
        brush = QBrush(Qt.BrushStyle.SolidPattern)

        # Retrieve cached size distribution metrics
        med_sz = self._trade_med_size
        p95_sz = self._trade_p95_size

        visible_end_frame = self._frame_count - self._scroll_offset
        
        # Calculate tick index limits for on-screen visible trades
        start_tick = visible_end_frame - bw + 1
        end_tick = visible_end_frame

        # Slice trades using binary search (O(log N)) for maximum performance
        import bisect
        trades_list = list(self._trades)
        if not trades_list:
            return

        start_idx = bisect.bisect_left(trades_list, start_tick, key=lambda t: t[4] if len(t) == 5 else t[3])
        end_idx = bisect.bisect_right(trades_list, end_tick, key=lambda t: t[4] if len(t) == 5 else t[3])
        visible_trades = trades_list[start_idx:end_idx]

        for t in visible_trades:
            if len(t) == 5:
                price, sz, side, ts, tick_index = t
            else:
                price, sz, side, ts = t
                tick_index = self._frame_count

            col = bw - 1 - visible_end_frame + tick_index
            if col < 0 or col >= bw:
                continue
            x = col * hm_w / bw

            # Calculate relative volume for size and opacity
            if p95_sz > med_sz:
                rel_vol = (sz - med_sz) / (p95_sz - med_sz)
                rel_vol = max(0.0, min(1.0, rel_vol))
            else:
                rel_vol = 0.0

            # Scale dot size and opacity: typical volume trades are small (r=2.0) and faint (alpha=30)
            # Large volume trades scale up dynamically to r=14.0 and alpha=220
            r = 2.0 + rel_vol * 12.0
            a = int(30.0 + rel_vol * 190.0)

            if side == Side.BUY:
                brush.setColor(QColor(green_r, green_g, green_b, a))
            else:
                brush.setColor(QColor(red_r, red_g, red_b, a))
            p.setBrush(brush)

            y = self._price_to_screen_y(price, wh)
            if 0 <= y < wh:
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
        if engine.center_price_ticks is None or engine.render_tick_size <= 0:
            return
        bh = buf.shape[0]
        tick_size = engine.render_tick_size
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

        visible_end_frame = self._frame_count - self._scroll_offset
        for liq in list(self._liquidations):
            col = bw - 1 - visible_end_frame + liq['tick_index']
            if col >= bw:
                col = bw - 1
            if col < 0:
                continue
            x = col * hm_w / bw
            
            y = self._price_to_screen_y(liq['price'], wh)
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

    def _draw_llt_lines(self, p: QPainter, ww: int, wh: int, hm_w: int) -> None:
        """Draw horizontal dashed lines on price levels with massive resting liquidity."""
        if not self.llt_enabled:
            return
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        for level in self._levels:
            size = max(level.bid_size, level.ask_size)
            if size >= self.llt_threshold:
                y = self._price_to_screen_y(level.price, wh)
                if 0 <= y < wh:
                    line_color = QColor(Colors.ACCENT_GREEN.red(), Colors.ACCENT_GREEN.green(), Colors.ACCENT_GREEN.blue(), 120) if level.bid_size > level.ask_size else QColor(Colors.ACCENT_RED.red(), Colors.ACCENT_RED.green(), Colors.ACCENT_RED.blue(), 120)
                    pen = QPen(line_color, 1.0, Qt.PenStyle.DashLine)
                    p.setPen(pen)
                    p.drawLine(QPointF(0, y), QPointF(hm_w, y))
                    
                    # Size label on top of LLT line with high-contrast background pill
                    p.setFont(Fonts.mono(9, bold=True))
                    text = f"{size:.0f}"
                    fm = p.fontMetrics()
                    tw = fm.horizontalAdvance(text)
                    th = fm.height()
                    tx = hm_w - tw - 12
                    rect_w = tw + 8
                    rect_h = th + 4
                    rect_x = tx - 4
                    rect_y = y - rect_h / 2
                    
                    # Draw pill background
                    p.setBrush(QBrush(QColor(10, 11, 16, 230)))
                    p.setPen(QPen(line_color, 1.0))
                    p.drawRoundedRect(QRectF(rect_x, rect_y, rect_w, rect_h), 4.0, 4.0)
                    
                    # Draw text inside pill
                    p.setPen(Colors.TEXT_BRIGHT)
                    p.drawText(QPointF(tx, rect_y + fm.ascent() + 2), text)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, False)

    def _draw_icebergs(self, p: QPainter, ww: int, wh: int, hm_w: int) -> None:
        """Draw circular badges representing hidden iceberg order executions."""
        if not self.iceberg_enabled or not self._iceberg_markers:
            return
        
        # Prune expired markers to prevent list accumulation and rendering lag
        now_ts = time.time()
        self._iceberg_markers = [m for m in self._iceberg_markers if now_ts - m['timestamp'] <= 10.0]
        if not self._iceberg_markers:
            return

        buf = self._engine.get_buffer()
        bw = buf.shape[1]
        if bw <= 0:
            return

        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.setFont(Fonts.mono(9, bold=True))
        fm = p.fontMetrics()

        visible_end_frame = self._frame_count - self._scroll_offset
        for marker in self._iceberg_markers:
            col = bw - 1 - visible_end_frame + marker['tick_index']
            if col >= bw:
                col = bw - 1
            if col < 0:
                continue
            x = col * hm_w / bw
            y = self._price_to_screen_y(marker['price'], wh)
            if not (0 <= y < wh):
                continue

            age = now_ts - marker['timestamp']
            if age > 10.0:
                continue
            alpha = int(max(30, 235 * (1.0 - age / 10.0)))

            # Circular badge
            r = 15.0
            p.setPen(QPen(QColor(Colors.TEXT_BRIGHT.red(), Colors.TEXT_BRIGHT.green(), Colors.TEXT_BRIGHT.blue(), alpha), 1.5))
            
            if marker['side'] == Side.BUY:
                bg_color = QColor(Colors.ACCENT_GREEN.red(), Colors.ACCENT_GREEN.green(), Colors.ACCENT_GREEN.blue(), alpha)
            else:
                bg_color = QColor(Colors.ACCENT_RED.red(), Colors.ACCENT_RED.green(), Colors.ACCENT_RED.blue(), alpha)
            p.setBrush(QBrush(bg_color))
            p.drawEllipse(QPointF(x, y), r, r)

            # Center text "I:<size>"
            p.setPen(QColor(255, 255, 255, alpha))
            text = f"I:{marker['size']:.0f}"
            tw = fm.horizontalAdvance(text)
            p.drawText(QPointF(x - tw / 2, y + fm.ascent() / 2 - 1), text)

        p.setRenderHint(QPainter.RenderHint.Antialiasing, False)

    def _draw_stops(self, p: QPainter, ww: int, wh: int, hm_w: int) -> None:
        """Draw diamond badges representing large stop order triggers."""
        if not self.stops_enabled or not self._stop_markers:
            return
        
        # Prune expired markers to prevent list accumulation and rendering lag
        now_ts = time.time()
        self._stop_markers = [m for m in self._stop_markers if now_ts - m['timestamp'] <= 10.0]
        if not self._stop_markers:
            return

        buf = self._engine.get_buffer()
        bw = buf.shape[1]
        if bw <= 0:
            return

        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.setFont(Fonts.mono(9, bold=True))
        fm = p.fontMetrics()

        visible_end_frame = self._frame_count - self._scroll_offset
        for marker in self._stop_markers:
            col = bw - 1 - visible_end_frame + marker['tick_index']
            if col >= bw:
                col = bw - 1
            if col < 0:
                continue
            x = col * hm_w / bw
            y = self._price_to_screen_y(marker['price'], wh)
            if not (0 <= y < wh):
                continue

            age = now_ts - marker['timestamp']
            if age > 10.0:
                continue
            alpha = int(max(30, 235 * (1.0 - age / 10.0)))

            # Orange diamond badge
            r = 15.0
            p.setPen(QPen(QColor(Colors.TEXT_BRIGHT.red(), Colors.TEXT_BRIGHT.green(), Colors.TEXT_BRIGHT.blue(), alpha), 1.5))
            bg_color = QColor(255, 152, 0, alpha)
            p.setBrush(QBrush(bg_color))
            
            from PyQt6.QtGui import QPolygonF
            points = [
                QPointF(x, y - r),
                QPointF(x + r, y),
                QPointF(x, y + r),
                QPointF(x - r, y)
            ]
            p.drawPolygon(QPolygonF(points))

            # Black high-contrast text "S:<size>"
            p.setPen(QColor(0, 0, 0, alpha))
            text = f"S:{marker['size']:.0f}"
            tw = fm.horizontalAdvance(text)
            p.drawText(QPointF(x - tw / 2, y + fm.ascent() / 2 - 1), text)

        p.setRenderHint(QPainter.RenderHint.Antialiasing, False)

    def _draw_pulse_boxes(self, p: QPainter, ww: int, wh: int) -> None:
        """Draw floating training period aggregations in top-left."""
        if not self.pulse_enabled:
            return
        
        buy_vol = 0.0
        sell_vol = 0.0
        now_ts = time.time()
        for t in reversed(self._trades):
            if len(t) == 5:
                _, sz, side, ts, _ = t
            else:
                _, sz, side, ts = t
            if now_ts - ts > 10.0:
                break
            if side == Side.BUY:
                buy_vol += sz
            else:
                sell_vol += sz
        
        tot_vol = buy_vol + sell_vol
        cvd = buy_vol - sell_vol
        
        buy_pct = (buy_vol / tot_vol * 100) if tot_vol > 0.0 else 50.0
        sell_pct = (sell_vol / tot_vol * 100) if tot_vol > 0.0 else 50.0
        
        active_icebergs = len([m for m in self._iceberg_markers if time.time() - m['timestamp'] <= 10.0])
        active_stops = len([m for m in self._stop_markers if time.time() - m['timestamp'] <= 10.0])

        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        
        box_w, box_h = 260, 85
        bx, by = 12, 12
        
        # Glassmorphism panel 1
        p.setBrush(QBrush(QColor(10, 11, 16, 120)))
        p.setPen(QPen(QColor(44, 48, 67, 100), 1.0))
        p.drawRoundedRect(QRectF(bx, by, box_w, box_h), 6.0, 6.0)
        
        p.setPen(Colors.TEXT_BRIGHT)
        p.setFont(Fonts.sans(10, bold=True))
        p.drawText(bx + 12, by + 20, "MARKET PULSE (CVD)")
        
        cvd_color = Colors.ACCENT_GREEN if cvd >= 0 else Colors.ACCENT_RED
        p.setPen(cvd_color)
        p.setFont(Fonts.mono(14, bold=True))
        cvd_str = f"{cvd:+.1f}"
        p.drawText(bx + 12, by + 42, cvd_str)
        
        p.setPen(Colors.TEXT_SECONDARY)
        p.setFont(Fonts.sans(9))
        vol_str = f"Volume: {tot_vol:.1f}  |  B/S: {buy_pct:.0f}%/{sell_pct:.0f}%"
        p.drawText(bx + 12, by + 58, vol_str)
        
        bar_x = bx + 12
        bar_y = by + 66
        bar_w = box_w - 24
        bar_h = 5
        
        p.fillRect(QRectF(bar_x, bar_y, bar_w, bar_h), QColor(255, 23, 68, 80))
        buy_w = bar_w * (buy_pct / 100.0)
        p.fillRect(QRectF(bar_x, bar_y, buy_w, bar_h), QColor(0, 230, 118, 255))
        
        # Glassmorphism panel 2
        box_w2, box_h2 = 140, 85
        bx2 = bx + box_w + 8
        
        p.setBrush(QBrush(QColor(10, 11, 16, 120)))
        p.setPen(QPen(QColor(44, 48, 67, 100), 1.0))
        p.drawRoundedRect(QRectF(bx2, by, box_w2, box_h2), 6.0, 6.0)
        
        p.setPen(Colors.TEXT_BRIGHT)
        p.setFont(Fonts.sans(10, bold=True))
        p.drawText(bx2 + 12, by + 20, "TRACKERS")
        
        p.setPen(QColor(0, 230, 118))
        p.setFont(Fonts.sans(9, bold=True))
        p.drawText(bx2 + 12, by + 42, f"Icebergs: {active_icebergs}")
        
        p.setPen(QColor(255, 152, 0))
        p.setFont(Fonts.sans(9, bold=True))
        p.drawText(bx2 + 12, by + 60, f"Stops: {active_stops}")
        
        p.setRenderHint(QPainter.RenderHint.Antialiasing, False)

    def _draw_price_axis(self, p: QPainter, ww: int, wh: int) -> None:
        """Draw price labels on the right edge at clean linear intervals."""
        engine = self._engine
        if engine.center_price_ticks is None or engine.render_tick_size <= 0:
            return
        bh = engine.get_buffer().shape[0]

        # Fill price axis background with a premium panel background
        p.fillRect(QRect(ww - self.price_axis_w, 0, self.price_axis_w, wh), Colors.BG_PANEL)

        # Draw a vertical separator line at the boundary ww - self.price_axis_w
        p.setPen(QPen(Colors.BORDER_MEDIUM, 1.5))
        p.drawLine(QPointF(ww - self.price_axis_w, 0), QPointF(ww - self.price_axis_w, wh))

        p.setFont(Fonts.mono(10, bold=True))
        fm = QFontMetrics(p.font())

        seen_prices = set()
        # Clean vertical step for price labels
        vis_rows = max(1, wh // self.row_height)
        for y in range(20, wh - 10, 40):
            row = y * vis_rows / wh - 0.5
            p_ticks = engine.center_price_ticks + (vis_rows // 2 - row)
            rounded_ticks = round(p_ticks)
            price = rounded_ticks * engine.render_tick_size
            if price in seen_prices:
                continue
            seen_prices.add(price)
            
            # Recalculate exact Y coordinate for the rounded tick to ensure perfect vertical alignment
            row_tick = (vis_rows // 2) - (rounded_ticks - engine.center_price_ticks)
            y_tick = row_tick * wh / vis_rows + (wh / vis_rows) / 2.0
            
            # Draw tick mark extending from the boundary into the price axis area
            p.setPen(QPen(Colors.TEXT_SECONDARY, 1.5))
            p.drawLine(QPointF(ww - self.price_axis_w, y_tick), QPointF(ww - self.price_axis_w + 4, y_tick))

            txt = f"{price:.2f}"
            tw = fm.horizontalAdvance(txt)
            p.setPen(Colors.TEXT_PRIMARY)  # Bright off-white color
            p.drawText(QPointF(ww - tw - 4, y_tick + fm.ascent() / 2 - 1), txt)

    # ── Mouse events ──────────────────────────────────────────────

    def mouseMoveEvent(self, e: QMouseEvent) -> None:
        self._my = int(e.position().y())
        self._mx = int(e.position().x())
        engine = self._engine
        
        if self._drag_active and self._drag_start_center_float is not None and engine.center_price_ticks is not None:
            delta_pos = e.position() - self._drag_start_pos
            dy = delta_pos.y()
            dx = delta_pos.x()
            if abs(dy) > 8 or abs(dx) > 8 or self._drag_occurred:
                self._drag_occurred = True
                self.auto_follow = False  # disable follow during manual drag
                
                if self._drag_start_on_price_axis:
                    # 1. Vertical Price Drag ONLY
                    vis_rows = max(1, self.height() // self.row_height)
                    dy_ticks = dy * vis_rows / max(1, self.height())
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
                        self._cache_dirty = True
                        self.view_changed.emit()
                        self.request_rebuild_throttled()
                    else:
                        engine._center_price_ticks_float = target_center_float
                else:
                    # 2. Horizontal Time/History Drag ONLY
                    dx_cols = int(round(dx / self.column_width))
                    target_scroll = self._drag_start_scroll_offset + dx_cols
                    hm_w = max(1, self.width() - self.price_axis_w)
                    timeline_w = max(1, hm_w - self.right_margin_w)
                    target_bw = max(1, int(timeline_w / self.column_width))
                    max_scroll = max(0, len(self._history) - target_bw)
                    new_scroll = max(0, min(max_scroll, target_scroll))
                    
                    if new_scroll == 0:
                        self.auto_follow = True
                    else:
                        self.auto_follow = False

                    if new_scroll != self._scroll_offset:
                        delta_scroll = new_scroll - self._scroll_offset
                        self._scroll_offset = new_scroll
                        
                        engine._buffer = np.roll(engine._buffer, delta_scroll, axis=1)
                        if delta_scroll > 0:
                            engine._buffer[:, :delta_scroll, :] = ColorSystem.BG_COLOR
                        else:
                            engine._buffer[:, delta_scroll:, :] = ColorSystem.BG_COLOR
                            
                        self._cache_dirty = True
                        self.view_changed.emit()
                        self.request_rebuild_throttled()

        if engine.center_price_ticks is not None and engine.render_tick_size > 0:
            vis_rows = max(1, self.height() // self.row_height)
            row = self._my * vis_rows / max(1, self.height()) - 0.5
            p_ticks = engine.center_price_ticks + (vis_rows // 2 - row)
            price = round(p_ticks) * engine.render_tick_size
            self._hover_price = price
            self.price_hovered.emit(price)
            
        super().update()

    def leaveEvent(self, e) -> None:
        self._my = -1
        self._hover_price = None
        super().update()

    def mousePressEvent(self, e: QMouseEvent) -> None:
        if e.button() == Qt.MouseButton.LeftButton:
            # Check if clicked "Go Live" button
            if not self.auto_follow:
                hm_w = self.width() - self.price_axis_w
                timeline_w = max(1, hm_w - self.right_margin_w)
                btn_rect = QRectF(timeline_w - 110, self.height() - 45, 100, 30)
                if btn_rect.contains(e.position()):
                    self.auto_follow = True
                    self._scroll_offset = 0
                    self.rebuild_heatmap()
                    self.update()
                    e.accept()
                    return

            self._drag_active = True
            self._drag_start_pos = e.position()
            self._drag_start_center_float = self._engine._center_price_ticks_float
            self._drag_start_center_ticks = self._engine.center_price_ticks
            self._drag_start_scroll_offset = self._scroll_offset
            self._drag_occurred = False
            # Check if drag starts on price axis
            if e.position().x() >= self.width() - self.price_axis_w:
                self._drag_start_on_price_axis = True
            else:
                self._drag_start_on_price_axis = False

    def mouseReleaseEvent(self, e: QMouseEvent) -> None:
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_active = False
            if self._drag_occurred:
                if self._scroll_offset == 0:
                    self.auto_follow = True
                view_changed = (
                    self._scroll_offset != self._drag_start_scroll_offset or
                    self._engine.center_price_ticks != getattr(self, '_drag_start_center_ticks', None)
                )
                if view_changed:
                    if self._rebuild_pending:
                        self._deferred_rebuild()
                    else:
                        self.rebuild_heatmap()
            elif self._hover_price:
                self.price_clicked.emit(self._hover_price)

    def mouseDoubleClickEvent(self, e: QMouseEvent) -> None:
        if e.button() == Qt.MouseButton.LeftButton:
            is_price_axis = e.position().x() >= self.width() - self.price_axis_w
            if is_price_axis:
                # Recenter price axis to BBO mid-price
                b = self._bbo
                if b and b.bid > 0 and b.ask > 0:
                    mid = (b.bid + b.ask) / 2.0
                    render_tick_size = self._engine.tick_size * self._engine.ticks_per_row
                    if render_tick_size > 0:
                        center_ticks = int(round(mid / render_tick_size))
                        self._engine.center_price_ticks = center_ticks
                        self._engine._center_price_ticks_float = float(center_ticks)
                        self._engine._in_recenter_drift = False
                        self._cache_dirty = True
                        self.update()
                        self.rebuild_heatmap()
            else:
                # Go live and recenter
                self.auto_follow = True
                self._scroll_offset = 0
                b = self._bbo
                if b and b.bid > 0 and b.ask > 0:
                    mid = (b.bid + b.ask) / 2.0
                    render_tick_size = self._engine.tick_size * self._engine.ticks_per_row
                    if render_tick_size > 0:
                        center_ticks = int(round(mid / render_tick_size))
                        self._engine.center_price_ticks = center_ticks
                        self._engine._center_price_ticks_float = float(center_ticks)
                        self._engine._in_recenter_drift = False
                self.rebuild_heatmap()
                self.update()

    def zoom_to_height_centered(self, h: int, my: float) -> None:
        engine = self._engine
        old_h = self.row_height
        new_h = max(self._min_rh, min(self._max_rh, h))
        if old_h == new_h:
            return

        wh = max(1, self.height())
        vis_rows_before = max(1, wh // old_h)
        vis_rows_after = max(1, wh // new_h)

        if engine.center_price_ticks is not None:
            center_before = engine._center_price_ticks_float if engine._center_price_ticks_float is not None else float(engine.center_price_ticks)
            ratio = my / wh
            center_after = center_before + (vis_rows_before - vis_rows_after) * (0.5 - ratio)
            
            engine._center_price_ticks_float = center_after
            engine.center_price_ticks = int(round(center_after))
            engine._in_recenter_drift = False

        self.row_height = new_h
        self.request_rebuild_throttled()

        # Update hover price under cursor
        if my >= 0 and engine.center_price_ticks is not None and engine.render_tick_size > 0:
            vr = vis_rows_after
            row = my * vr / wh - 0.5
            p_ticks = engine.center_price_ticks + (vr // 2 - row)
            self._hover_price = round(p_ticks) * engine.render_tick_size
            self.price_hovered.emit(self._hover_price)

        self.row_height_changed.emit(self.row_height)
        self.view_changed.emit()

    def timeframe_zoom_in_centered(self, mx: float) -> None:
        """Zoom in timeframe (stretch horizontally) keeping mouse X stationary."""
        current = self.column_width
        levels = self.COLUMN_WIDTH_LEVELS
        next_val = current
        for val in levels:
            if val > current:
                next_val = val
                break
        if next_val != current:
            self.set_column_width_centered(next_val, mx)

    def timeframe_zoom_out_centered(self, mx: float) -> None:
        """Zoom out timeframe (squeeze horizontally) keeping mouse X stationary."""
        current = self.column_width
        levels = self.COLUMN_WIDTH_LEVELS
        next_val = current
        for val in reversed(levels):
            if val < current:
                next_val = val
                break
        if next_val != current:
            self.set_column_width_centered(next_val, mx)

    def set_column_width_centered(self, w: float, mx: float) -> None:
        old_w = self.column_width
        closest_w = min(self.COLUMN_WIDTH_LEVELS, key=lambda x: abs(x - w))
        if old_w == closest_w:
            return

        hm_w = max(1, self.width() - self.price_axis_w)
        timeline_w = max(1, hm_w - self.right_margin_w)
        dist_px = timeline_w - mx
        
        delta_offset = (dist_px / old_w) - (dist_px / closest_w)
        new_scroll = self._scroll_offset + delta_offset
        
        self.column_width = closest_w
        
        target_bw = max(1, int(timeline_w / self.column_width))
        max_scroll = max(0, len(self._history) - target_bw)
        self._scroll_offset = max(0, min(max_scroll, int(round(new_scroll))))
        
        if self._scroll_offset > 0:
            self.auto_follow = False
        else:
            self.auto_follow = True

        self.request_rebuild_throttled()
        self.column_width_changed.emit(self.column_width)

    def wheelEvent(self, e: QWheelEvent) -> None:
        dx = e.angleDelta().x()
        dy = e.angleDelta().y()

        # 1. Horizontal scroll (touchpad swiping or tilt wheel)
        if abs(dx) >= 1:
            cols = int(round(dx / 12.0))
            if cols != 0:
                self.scroll_time(-cols)
            return

        if abs(dy) < 1:
            return

        is_price_axis = e.position().x() >= self.width() - self.price_axis_w
        
        # We want default wheel to zoom!
        # If Control modifier is pressed, we do scrolling instead.
        use_scroll = bool(e.modifiers() & Qt.KeyboardModifier.ControlModifier)
        
        if is_price_axis:
            if use_scroll:
                # Scroll/slide price vertically
                detents = dy / 120.0
                scroll_ticks = int(round(detents * 5))
                if scroll_ticks == 0:
                    scroll_ticks = 1 if dy > 0 else -1
                self.scroll_price(scroll_ticks)
            else:
                # Zoom price vertically centered on cursor
                steps = int(round(dy / 120.0))
                if steps == 0:
                    steps = 1 if dy > 0 else -1
                
                new_h = self.row_height + steps
                self.zoom_to_height_centered(new_h, e.position().y())
            return
        else:
            # On main area:
            if use_scroll:
                # scroll/pan time horizontally
                cols = int(round(dy / 12.0))
                if cols != 0:
                    self.scroll_time(-cols)
            else:
                # zoom time (horizontal scale) centered on cursor
                if dy > 0:
                    self.timeframe_zoom_in_centered(e.position().x())
                else:
                    self.timeframe_zoom_out_centered(e.position().x())
            return

    def keyPressEvent(self, e: QKeyEvent) -> None:
        k = e.key()
        if k in (Qt.Key.Key_Plus, Qt.Key.Key_Equal):
            if e.modifiers() & Qt.KeyboardModifier.ControlModifier:
                self.zoom_in()
            elif e.modifiers() & Qt.KeyboardModifier.ShiftModifier:
                self.timeframe_zoom_in()
            else:
                self.price_zoom_in()
        elif k == Qt.Key.Key_Minus:
            if e.modifiers() & Qt.KeyboardModifier.ControlModifier:
                self.zoom_out()
            elif e.modifiers() & Qt.KeyboardModifier.ShiftModifier:
                self.timeframe_zoom_out()
            else:
                self.price_zoom_out()
        elif k == Qt.Key.Key_Left:
            self.scroll_time(50)
        elif k == Qt.Key.Key_Right:
            self.scroll_time(-50)
        elif k == Qt.Key.Key_R:
            self.reset_view()
        elif k in (Qt.Key.Key_L, Qt.Key.Key_Escape):
            self.auto_follow = True
            self._scroll_offset = 0
            self.rebuild_heatmap()
            self.update()
        else:
            super().keyPressEvent(e)

    def resizeEvent(self, e) -> None:
        super().resizeEvent(e)
        if hasattr(self, '_vwap_overlay') and self._vwap_overlay is not None:
            self._vwap_overlay.setGeometry(self.rect())
        vr = max(1, self.height() // self.row_height)
        hm_w = max(1, self.width() - self.price_axis_w)
        timeline_w = max(1, hm_w - self.right_margin_w)
        target_bw = max(1, int(timeline_w / self.column_width))
        if vr != self._last_vis_rows or target_bw != self._last_hm_w:
            self._engine.resize(vr, target_bw)
            self._last_vis_rows = vr
            self._last_hm_w = target_bw
            if self._levels:
                self._engine.push_snapshot(self._levels, self._bbo, auto_follow=self.auto_follow, vis_rows=vr)
                self._sync_vwap()
            self._cache_dirty = True
            self.update()
