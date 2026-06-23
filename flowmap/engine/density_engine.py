"""
Density Engine — Bookmap-style heatmap renderer.
Maintains SEPARATE bid/ask density accumulators per price level.
Percentile-based adaptive normalization makes accumulation zones GLOW.
Pure NumPy, no Qt imports.
"""

from collections import deque
from typing import Optional

import numpy as np

from ..core import BBO, BookLevel
from .color_system import ColorSystem
from .normalizer import AdaptiveNormalizer


class DensityEngine:
    """
    Incremental heatmap renderer with per-side density tracking.

    Parameters
    ----------
    max_levels : int, default 50
        Maximum number of levels to track.
    history_width : int, default 600
        Width of the rolling buffer in columns.
    decay : float, default 0.92
        Multiplicative decay factor per tick (0.5–0.99).
    config : EngineConfig, optional
        Alternative config object; overrides other kwargs when provided.

    Key design:
    - SEPARATE _bid_density[price] and _ask_density[price] accumulators
    - Each decays independently: density *= decay, then += new_size
    - Fixed-reference normalization per side (default bid ref=8000, ask ref=8000)
    - Linear ratio for wide color spread
    - Buffer scrolls left, rightmost column is CLEARED before drawing new data
    """

    def __init__(self, max_levels=50, history_width=600, decay=0.92,
                 config: Optional["EngineConfig"] = None):
        from .config import EngineConfig
        if config is not None:
            self.config = config
        else:
            self.config = EngineConfig(
                max_levels=max_levels,
                history_width=history_width,
                decay=decay,
                bid_ref=3000.0,
                ask_ref=3000.0
            )


        self._bid_density: dict[float, float] = {}   # price → accumulated bid density
        self._ask_density: dict[float, float] = {}   # price → accumulated ask density
        self._bbo: Optional[BBO] = None
        self._levels: list[BookLevel] = []

        self._price_history: deque[float] = deque(maxlen=self.history_width)
        self._bbo_history: deque[tuple[float, float]] = deque(maxlen=self.history_width)
        self._cvd_history: deque[float] = deque(maxlen=self.history_width)
        self._timestamp_history: deque[float] = deque(maxlen=self.history_width)

        # Exposed price→row mapping
        self.selected_prices: list[float] = []
        self.spacing: int = 1
        self.pad_top: int = 0

        # Linear scale variables
        self.tick_size: float = 0.05
        self.center_price_ticks: Optional[int] = None
        self._center_price_ticks_float: Optional[float] = None
        self._in_recenter_drift: bool = False

        # Buffer — starts 1×1, filled with background color
        self._buffer = np.zeros((1, 1, 4), dtype=np.uint8)
        self._buffer[:] = ColorSystem.BG_COLOR
        self._needs_rebuild = True

        # Pre-allocated arrays to avoid GC overhead during heavy tick bursts
        self._arr = np.zeros(1, dtype=np.float64)
        self._normalized = np.zeros(1, dtype=np.float64)

        # Adaptive normalizers
        self._bid_normalizer = AdaptiveNormalizer(fixed_ref=self.config.bid_ref)
        self._ask_normalizer = AdaptiveNormalizer(fixed_ref=self.config.ask_ref)
        self._norm = self._bid_normalizer

        # Tradermap Pro min order size filter
        self.min_order_size: float = 0.0

    def reset(self) -> None:
        """Reset the density engine state for a new symbol/session."""
        self._bid_density.clear()
        self._ask_density.clear()
        self._bbo = None
        self._levels.clear()
        self._price_history.clear()
        self._bbo_history.clear()
        self._cvd_history.clear()
        self._timestamp_history.clear()
        self.selected_prices = []
        self.center_price_ticks = None
        self._center_price_ticks_float = None
        self._in_recenter_drift = False
        self._tick_size_detected = False
        self._bid_normalizer.global_ref = self.config.bid_ref
        self._ask_normalizer.global_ref = self.config.ask_ref
        self._buffer[:] = ColorSystem.BG_COLOR
        self._needs_rebuild = True

    def push_snapshot(self, levels: list[BookLevel], bbo: BBO, auto_follow: bool = True, vis_rows: Optional[int] = None, update_normalizer: bool = True, detect_tick_size: bool = True, col_idx: Optional[int] = None, bid_prices=None, bid_values=None, ask_prices=None, ask_values=None, cvd: float = 0.0, timestamp: float = 0.0):
        """Process one tick."""
        self._levels = levels
        self._bbo = bbo

        # 0. Detect tick size from snapshot levels (keep running minimum to avoid vertical scaling jumps)
        if not getattr(self, '_tick_size_detected', False):
            prices = sorted([lv.price for lv in levels])
            if len(prices) >= 2:
                diffs = np.diff(prices)
                valid_diffs = diffs[diffs > 0.000001]
                if len(valid_diffs) > 0:
                    obs_min = round(float(np.min(valid_diffs)), 6)
                    if not getattr(self, '_tick_size_detected', False):
                        self.tick_size = obs_min
                        self._tick_size_detected = True
                    else:
                        self.tick_size = min(self.tick_size, obs_min)

        # 1. Store the current snapshot sizes directly (no accumulation or decay)
        if col_idx is None:
            self._bid_density = {lv.price: lv.bid_size for lv in levels if lv.bid_size > 0}
            self._ask_density = {lv.price: lv.ask_size for lv in levels if lv.ask_size > 0}

        # Save pre-parsed arrays for current drawing
        if bid_prices is None or bid_values is None:
            bids = [(lv.price, lv.bid_size) for lv in levels if lv.bid_size > 0.0]
            if bids:
                self._curr_bid_prices = np.array([x[0] for x in bids], dtype=np.float64)
                self._curr_bid_values = np.array([x[1] for x in bids], dtype=np.float64)
            else:
                self._curr_bid_prices = np.empty(0, dtype=np.float64)
                self._curr_bid_values = np.empty(0, dtype=np.float64)
        else:
            self._curr_bid_prices = bid_prices
            self._curr_bid_values = bid_values

        if ask_prices is None or ask_values is None:
            asks = [(lv.price, lv.ask_size) for lv in levels if lv.ask_size > 0.0]
            if asks:
                self._curr_ask_prices = np.array([x[0] for x in asks], dtype=np.float64)
                self._curr_ask_values = np.array([x[1] for x in asks], dtype=np.float64)
            else:
                self._curr_ask_prices = np.empty(0, dtype=np.float64)
                self._curr_ask_values = np.empty(0, dtype=np.float64)
        else:
            self._curr_ask_prices = ask_prices
            self._curr_ask_values = ask_values

        # 3. Track mid price and BBO history
        bid = bbo.bid if bbo else 0.0
        ask = bbo.ask if bbo else 0.0
        self._bbo_history.append((bid, ask))
        mid = (bid + ask) / 2.0 if bid > 0 and ask > 0 else 0.0
        self._price_history.append(mid)
        self._cvd_history.append(cvd)
        self._timestamp_history.append(timestamp)

        if col_idx is not None:
            buf_h, hw = self._buffer.shape[0], self._buffer.shape[1]
            v_rows = vis_rows if vis_rows is not None else buf_h // 5
            self._draw_column(v_rows, hw, col_idx=col_idx, update_normalizer=update_normalizer)
            return

        # 4. Scroll buffer left + clear rightmost + draw new column
        buf_h, hw = self._buffer.shape[0], self._buffer.shape[1]
        v_rows = vis_rows if vis_rows is not None else buf_h // 5
        if buf_h > 1 and hw > 1:
            if mid > 0:
                mid_ticks_float = mid / self.render_tick_size
                if self.center_price_ticks is None:
                    self.center_price_ticks = int(round(mid_ticks_float))
                    self._center_price_ticks_float = float(self.center_price_ticks)
                    self._in_recenter_drift = False

                # Centering calculation
                new_center_ticks = self.center_price_ticks

                if auto_follow:
                    if self.centering_mode == "immediate":
                        new_center_ticks = int(round(mid_ticks_float))
                        self._center_price_ticks_float = float(new_center_ticks)
                    elif self.centering_mode == "deadband":
                        deadband = max(1, int(self.centering_deadband_pct * v_rows))
                        current_mid_ticks_int = int(round(mid_ticks_float))
                        delta_ticks = current_mid_ticks_int - self.center_price_ticks
                        if abs(delta_ticks) > deadband:
                            new_center_ticks = current_mid_ticks_int
                            self._center_price_ticks_float = float(new_center_ticks)
                    elif self.centering_mode == "ema":
                        current_mid_ticks_int = int(round(mid_ticks_float))
                        delta_ticks = current_mid_ticks_int - self.center_price_ticks
                        if abs(delta_ticks) > v_rows // 2:
                            new_center_ticks = current_mid_ticks_int
                            self._center_price_ticks_float = float(new_center_ticks)
                        else:
                            self._center_price_ticks_float = (
                                (1.0 - self.centering_ema_alpha) * self._center_price_ticks_float +
                                self.centering_ema_alpha * mid_ticks_float
                            )
                            new_center_ticks = int(round(self._center_price_ticks_float))
                    elif self.centering_mode == "smooth_deadband":
                        deadband = max(1, int(self.centering_deadband_pct * v_rows))
                        current_mid_ticks_int = int(round(mid_ticks_float))
                        delta_ticks = current_mid_ticks_int - self.center_price_ticks
                        if abs(delta_ticks) > v_rows // 2:
                            new_center_ticks = current_mid_ticks_int
                            self._center_price_ticks_float = float(new_center_ticks)
                            self._in_recenter_drift = False
                        elif abs(delta_ticks) > deadband or self._in_recenter_drift:
                            self._in_recenter_drift = True
                            self._center_price_ticks_float = (
                                (1.0 - self.centering_ema_alpha) * self._center_price_ticks_float +
                                self.centering_ema_alpha * mid_ticks_float
                            )
                            new_center_ticks = int(round(self._center_price_ticks_float))
                            if abs(self._center_price_ticks_float - mid_ticks_float) < 1.0:
                                self._in_recenter_drift = False
                        else:
                            self._center_price_ticks_float = float(self.center_price_ticks)

                delta_ticks = new_center_ticks - self.center_price_ticks
                if delta_ticks != 0:
                    self._buffer = np.roll(self._buffer, delta_ticks, axis=0)
                    if delta_ticks > 0:
                        if delta_ticks >= buf_h:
                            self._buffer[:] = ColorSystem.BG_COLOR
                        else:
                            self._buffer[:delta_ticks, :, :] = ColorSystem.BG_COLOR
                    else:
                        if abs(delta_ticks) >= buf_h:
                            self._buffer[:] = ColorSystem.BG_COLOR
                        else:
                            self._buffer[delta_ticks:, :, :] = ColorSystem.BG_COLOR
                    self.center_price_ticks = new_center_ticks

            if col_idx is None:
                # Shift buffer left
                self._buffer[:, :-1, :] = self._buffer[:, 1:, :]
                # CRITICAL: clear rightmost column to BG_COLOR
                self._buffer[:, -1, :] = ColorSystem.BG_COLOR
                self._draw_column(v_rows, hw, update_normalizer=update_normalizer)
            else:
                self._draw_column(v_rows, hw, col_idx=col_idx, update_normalizer=update_normalizer)

    def _draw_column(self, vis_rows, hm_width, col_idx: Optional[int] = None, update_normalizer: bool = True):
        """Draw rightmost or specific column using linear price tick scale."""
        if not self._levels or self.center_price_ticks is None:
            return

        self.selected_prices = sorted([lv.price for lv in self._levels])
        self.spacing = 1
        self.pad_top = 0

        col = col_idx if col_idx is not None else (hm_width - 1)
        buf_h = self._buffer.shape[0]
        
        if self._arr.shape[0] != buf_h:
            self._arr = np.zeros(buf_h, dtype=np.float64)
            self._normalized = np.zeros(buf_h, dtype=np.float64)
            self._bid_arr = np.zeros(buf_h, dtype=np.float64)
            self._ask_arr = np.zeros(buf_h, dtype=np.float64)
            self._is_bid = np.zeros(buf_h, dtype=bool)
            self._active_bids = np.zeros(buf_h, dtype=bool)
            self._active_asks = np.zeros(buf_h, dtype=bool)
            self._norm_bids = np.zeros(buf_h, dtype=np.float64)
            self._norm_asks = np.zeros(buf_h, dtype=np.float64)
        elif not hasattr(self, '_active_bids') or self._active_bids.shape[0] != buf_h:
            self._bid_arr = np.zeros(buf_h, dtype=np.float64)
            self._ask_arr = np.zeros(buf_h, dtype=np.float64)
            self._is_bid = np.zeros(buf_h, dtype=bool)
            self._active_bids = np.zeros(buf_h, dtype=bool)
            self._active_asks = np.zeros(buf_h, dtype=bool)
            self._norm_bids = np.zeros(buf_h, dtype=np.float64)
            self._norm_asks = np.zeros(buf_h, dtype=np.float64)
            
        bid_arr = self._bid_arr
        ask_arr = self._ask_arr
        bid_arr.fill(0.0)
        ask_arr.fill(0.0)

        bid_prices = self._curr_bid_prices
        bid_values = self._curr_bid_values
        ask_prices = self._curr_ask_prices
        ask_values = self._curr_ask_values

        # Vectorized mapping of prices to row indices
        if bid_prices is not None and len(bid_prices) > 0:
            if self.min_order_size > 0.0:
                bid_values = bid_values.copy()
                bid_values[bid_values < self.min_order_size] = 0.0
            bid_rows = (buf_h // 2) - np.round(bid_prices / self.render_tick_size).astype(np.int32) + self.center_price_ticks
            mask = (bid_rows >= 0) & (bid_rows < buf_h)
            np.maximum.at(bid_arr, bid_rows[mask], bid_values[mask])

        if ask_prices is not None and len(ask_prices) > 0:
            if self.min_order_size > 0.0:
                ask_values = ask_values.copy()
                ask_values[ask_values < self.min_order_size] = 0.0
            ask_rows = (buf_h // 2) - np.round(ask_prices / self.render_tick_size).astype(np.int32) + self.center_price_ticks
            mask = (ask_rows >= 0) & (ask_rows < buf_h)
            np.maximum.at(ask_arr, ask_rows[mask], ask_values[mask])

        # Apply vertical smoothing if enabled
        if self.vertical_smoothing > 0.01:
            bid_ref = self._bid_norm.global_ref
            ask_ref = self._ask_norm.global_ref
            
            smoothed_bid = self._smooth_column(bid_arr, self.vertical_smoothing)
            bid_blend = np.clip(bid_arr / (bid_ref + 1e-9), 0.0, 1.0)
            bid_blend = bid_blend ** 2.0  # Sharp transition to avoid bleeding of large orders
            bid_arr = bid_arr * bid_blend + smoothed_bid * (1.0 - bid_blend)
            
            smoothed_ask = self._smooth_column(ask_arr, self.vertical_smoothing)
            ask_blend = np.clip(ask_arr / (ask_ref + 1e-9), 0.0, 1.0)
            ask_blend = ask_blend ** 2.0  # Sharp transition to avoid bleeding of large orders
            ask_arr = ask_arr * ask_blend + smoothed_ask * (1.0 - ask_blend)

        # Calculate active_bids and active_asks
        active_bids = self._active_bids
        np.greater(bid_arr, 0.01, out=active_bids)
        active_asks = self._active_asks
        np.greater(ask_arr, 0.01, out=active_asks)

        # Update adaptive normalizers
        if update_normalizer:
            if np.any(active_bids):
                self._bid_norm.update(bid_arr[active_bids])
                
            if np.any(active_asks):
                self._ask_norm.update(ask_arr[active_asks])

        # Normalize separately
        norm_bids = self._norm_bids
        norm_bids.fill(0.0)
        if np.any(active_bids):
            norm_bids[active_bids] = self._bid_norm.normalize(bid_arr[active_bids])
            
        norm_asks = self._norm_asks
        norm_asks.fill(0.0)
        if np.any(active_asks):
            norm_asks[active_asks] = self._ask_norm.normalize(ask_arr[active_asks])

        # Combine for active indices check using max selection logic
        normalized = self._normalized
        np.maximum(norm_bids, norm_asks, out=normalized)
        active_indices = normalized > 0.0005
        
        is_bid = self._is_bid
        is_bid.fill(False)
        mid_price = (self._bbo.bid + self._bbo.ask) / 2.0 if self._bbo else 0.0
        if mid_price > 0:
            p_ticks = self.center_price_ticks + (buf_h // 2 - np.arange(buf_h, dtype=np.int32))
            prices = p_ticks * self.render_tick_size
            np.less_equal(prices, mid_price, out=is_bid)
        else:
            np.greater(bid_arr, ask_arr, out=is_bid)
        
        # Separate color mapping for bids and asks to avoid single color heatmap bug
        active_bids = is_bid & (norm_bids > 0.0005)
        active_asks = (~is_bid) & (norm_asks > 0.0005)

        if np.any(active_bids):
            bid_idx = np.clip((norm_bids[active_bids] * 255).astype(np.int32), 0, 255)
            self._buffer[active_bids, col, :] = ColorSystem.BOOKMAP_BID_LUT[bid_idx]

        if np.any(active_asks):
            ask_idx = np.clip((norm_asks[active_asks] * 255).astype(np.int32), 0, 255)
            self._buffer[active_asks, col, :] = ColorSystem.BOOKMAP_ASK_LUT[ask_idx]

        # Draw current BBO tick directly into the buffer column (no-copy scroll history lines!)
        if self._bbo:
            bid_ticks = round(self._bbo.bid / self.render_tick_size)
            bid_row = (buf_h // 2) - (bid_ticks - self.center_price_ticks)
            if 0 <= bid_row < buf_h:
                self._buffer[bid_row, col, :] = [100, 255, 120, 180]
                
            ask_ticks = round(self._bbo.ask / self.render_tick_size)
            ask_row = (buf_h // 2) - (ask_ticks - self.center_price_ticks)
            if 0 <= ask_row < buf_h:
                self._buffer[ask_row, col, :] = [255, 100, 90, 180]

    def resize(self, vis_rows, hm_width, old_center_ticks: Optional[int] = None):
        if vis_rows < 1:
            vis_rows = 1
        if hm_width < 1:
            hm_width = 1
        buf_h = vis_rows * 5
        ch, cw = self._buffer.shape[0], self._buffer.shape[1]
        if ch == buf_h and cw == hm_width:
            return
        new_buf = np.zeros((buf_h, hm_width, 4), dtype=np.uint8)
        new_buf[:] = ColorSystem.BG_COLOR
        copy_w = min(cw, hm_width)
        if copy_w > 0 and ch > 0:
            if self.center_price_ticks is not None:
                ref_old = old_center_ticks if old_center_ticks is not None else self.center_price_ticks
                shift = (buf_h // 2) - (ch // 2) + (self.center_price_ticks - ref_old)
                dst_y_start = max(0, shift)
                dst_y_end = min(buf_h, ch + shift)
                src_y_start = max(0, -shift)
                src_y_end = min(ch, buf_h - shift)
                if dst_y_end > dst_y_start and src_y_end > src_y_start:
                    new_buf[dst_y_start:dst_y_end, -copy_w:] = self._buffer[src_y_start:src_y_end, -copy_w:]
            else:
                copy_h = min(ch, buf_h)
                new_buf[:copy_h, -copy_w:] = self._buffer[:copy_h, -copy_w:]
        self._buffer = new_buf
        self._needs_rebuild = True
        
        # Resize recycled arrays
        self._arr = np.zeros(buf_h, dtype=np.float64)
        self._normalized = np.zeros(buf_h, dtype=np.float64)

    def get_buffer(self) -> np.ndarray:
        return self._buffer

    @property
    def _bid_norm(self) -> AdaptiveNormalizer:
        return self._bid_normalizer

    @property
    def _ask_norm(self) -> AdaptiveNormalizer:
        return self._ask_normalizer

    @property
    def decay(self) -> float:
        return self.config.decay

    @decay.setter
    def decay(self, value: float) -> None:
        self.config.decay = max(0.5, min(0.99, value))

    @property
    def history_width(self) -> int:
        return self.config.history_width

    @history_width.setter
    def history_width(self, value: int) -> None:
        self.config.history_width = value
        # Update deque maxlens if changed
        if hasattr(self, '_price_history') and self._price_history.maxlen != value:
            self._price_history = deque(self._price_history, maxlen=value)
        if hasattr(self, '_bbo_history') and self._bbo_history.maxlen != value:
            self._bbo_history = deque(self._bbo_history, maxlen=value)
        if hasattr(self, '_cvd_history') and self._cvd_history.maxlen != value:
            self._cvd_history = deque(self._cvd_history, maxlen=value)
        if hasattr(self, '_timestamp_history') and self._timestamp_history.maxlen != value:
            self._timestamp_history = deque(self._timestamp_history, maxlen=value)

    @property
    def _depth_levels(self) -> int:
        return self.config.depth_levels

    @_depth_levels.setter
    def _depth_levels(self, value: int) -> None:
        self.config.depth_levels = value

    @property
    def _density_threshold(self) -> float:
        return self.config.density_threshold

    @_density_threshold.setter
    def _density_threshold(self, value: float) -> None:
        self.config.density_threshold = value

    @property
    def _spacing_min(self) -> int:
        return self.config.spacing_min

    @_spacing_min.setter
    def _spacing_min(self, value: int) -> None:
        self.config.spacing_min = value

    @property
    def vertical_smoothing(self) -> float:
        return getattr(self.config, 'vertical_smoothing', 1.0)

    @vertical_smoothing.setter
    def vertical_smoothing(self, value: float) -> None:
        if hasattr(self.config, 'vertical_smoothing'):
            self.config.vertical_smoothing = value

    @property
    def centering_mode(self) -> str:
        return getattr(self.config, 'centering_mode', 'ema')

    @centering_mode.setter
    def centering_mode(self, value: str) -> None:
        if hasattr(self.config, 'centering_mode'):
            self.config.centering_mode = value

    @property
    def centering_ema_alpha(self) -> float:
        return getattr(self.config, 'centering_ema_alpha', 0.05)

    @centering_ema_alpha.setter
    def centering_ema_alpha(self, value: float) -> None:
        if hasattr(self.config, 'centering_ema_alpha'):
            self.config.centering_ema_alpha = value

    @property
    def centering_deadband_pct(self) -> float:
        return getattr(self.config, 'centering_deadband_pct', 0.35)

    @centering_deadband_pct.setter
    def centering_deadband_pct(self, value: float) -> None:
        if hasattr(self.config, 'centering_deadband_pct'):
            self.config.centering_deadband_pct = value

    @property
    def ticks_per_row(self) -> int:
        return getattr(self.config, 'ticks_per_row', 1)

    @ticks_per_row.setter
    def ticks_per_row(self, value: int) -> None:
        if hasattr(self.config, 'ticks_per_row'):
            self.config.ticks_per_row = max(1, value)

    @property
    def render_tick_size(self) -> float:
        return self.tick_size * self.ticks_per_row

    def get_price_history(self) -> list:
        return list(self._price_history)

    def get_bbo_history(self) -> list[tuple[float, float]]:
        return list(self._bbo_history)

    def get_cvd_history(self) -> list[float]:
        return list(self._cvd_history)

    def get_timestamp_history(self) -> list[float]:
        return list(self._timestamp_history)

    def set_decay(self, d):
        self.decay = max(0.5, min(0.99, d))

    def set_vertical_smoothing(self, val: float):
        self.vertical_smoothing = max(0.0, min(5.0, val))

    def _smooth_column(self, arr: np.ndarray, sigma: float) -> np.ndarray:
        """Apply vertical 1D Gaussian smoothing to a column array using NumPy."""
        if sigma <= 0.01:
            return arr
            
        # Cache kernel
        if not hasattr(self, '_cached_sigma') or self._cached_sigma != sigma:
            import math
            self._cached_sigma = sigma
            radius = int(math.ceil(3 * sigma))
            self._cached_radius = radius
            x = np.arange(-radius, radius + 1)
            kernel = np.exp(-0.5 * (x / sigma) ** 2)
            kernel /= np.sum(kernel)
            self._cached_kernel = kernel
        else:
            kernel = self._cached_kernel
            radius = self._cached_radius

        vis_rows = arr.shape[0]
        pad_size = vis_rows + 2 * radius
        
        # Reuse padded array
        if not hasattr(self, '_padded_arr') or self._padded_arr.shape[0] != pad_size:
            self._padded_arr = np.zeros(pad_size, dtype=np.float64)
            
        padded = self._padded_arr
        padded[radius : radius + vis_rows] = arr
        padded[0 : radius] = arr[0]
        padded[radius + vis_rows : ] = arr[-1]
        
        return np.convolve(padded, kernel, mode='valid')
