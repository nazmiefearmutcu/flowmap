"""
SourceManager — Data source switching, provider lifecycle, and signal wiring.

Manages three data sources: Simulator | Crypcodile Replay | CCXT Live.
"""
from __future__ import annotations
from enum import Enum, auto
import time
from typing import Optional, TYPE_CHECKING

from PyQt6.QtCore import QObject

from ..core import Trade, BBO
from ..data.simulator import MarketSimulator
from ..data.crypto import CryptoProvider

if TYPE_CHECKING:
    from .main_window import MainWindow
    from .toolbar_manager import ToolbarManager

# ── CrypcodileReplay & CrypcodileLive — optional dependencies ──
try:
    from ..data.crypcodile_replay import CrypcodileReplayProvider
    from ..data.crypcodile_live import CrypcodileLiveProvider
    HAS_CRYPCODILE_REPLAY = True
except ImportError:
    CrypcodileReplayProvider = None  # type: ignore
    CrypcodileLiveProvider = None  # type: ignore
    HAS_CRYPCODILE_REPLAY = False


# ─────────────────────────────────────────────────────────────────────
#  DataSource enum
# ─────────────────────────────────────────────────────────────────────

class DataSource(Enum):
    CRYPCODILE_REPLAY = auto()
    CRYPCODILE_LIVE = auto()


# ─────────────────────────────────────────────────────────────────────
#  Helpers
# ─────────────────────────────────────────────────────────────────────

def _disconnect_provider_signals(mgr: 'SourceManager', provider) -> None:
    """Safely disconnect all known provider signal handlers from the manager."""
    signal_names = [
        'on_snapshot', 'on_update', 'on_trade', 'on_bbo',
        'on_connected', 'on_disconnected', 'on_error',
    ]
    for name in signal_names:
        sig = getattr(provider, name, None)
        if sig is not None:
            try:
                sig.disconnect()
            except (TypeError, RuntimeError):
                pass
    if hasattr(provider, 'replay_progress'):
        try:
            provider.replay_progress.disconnect()
        except (TypeError, RuntimeError):
            pass


# ─────────────────────────────────────────────────────────────────────
#  SourceManager
# ─────────────────────────────────────────────────────────────────────

class SourceManager(QObject):
    """Manages data source switching, provider lifecycle, and signal wiring.

    Owns the DataSource enum and all source-switching logic.
    Uses ToolbarManager for button state updates.
    """

    def __init__(self, window: 'MainWindow', toolbar_mgr: 'ToolbarManager'):
        super().__init__(parent=window)
        self._window = window
        self._toolbar = toolbar_mgr

        import queue
        self._queue = queue.Queue()
        self._data_source: DataSource = DataSource.CRYPCODILE_LIVE
        self._provider: Optional[object] = None
        self._symbol: str = "binance-spot:SOLUSDT"
        self._replay_speed: float = 20.0
        self._replay_data_dir: str = "/Users/nazmi/data"
        self._running_val: bool = False
        self._sim_speed: float = 2.0
        self._frame_count: int = 0

    @property
    def queue(self):
        return self._queue

    # ── Properties ──────────────────────────────────────────────────

    @property
    def _running(self) -> bool:
        return getattr(self, '_running_val', False)

    @_running.setter
    def _running(self, val: bool) -> None:
        import traceback
        import sys
        print(f"[DEBUG_RUNNING] _running set to {val}", file=sys.stderr, flush=True)
        traceback.print_stack(limit=5, file=sys.stderr)
        sys.stderr.flush()
        self._running_val = val

    @property
    def data_source(self) -> DataSource: return self._data_source
    @property
    def provider(self) -> Optional[object]: return self._provider
    @property
    def symbol(self) -> str: return self._symbol
    @symbol.setter
    def symbol(self, v: str) -> None: self._symbol = v
    @property
    def running(self) -> bool: return self._running
    @running.setter
    def running(self, v: bool) -> None: self._running = v
    @property
    def sim_speed(self) -> float: return self._sim_speed
    @sim_speed.setter
    def sim_speed(self, v: float) -> None: self._sim_speed = max(v, 0.01)
    @property
    def replay_speed(self) -> float: return self._replay_speed
    @replay_speed.setter
    def replay_speed(self, v: float) -> None:
        self._replay_speed = v
        if self._provider is not None and hasattr(self._provider, 'set_speed'):
            self._provider.set_speed(v)
    @property
    def replay_data_dir(self) -> str: return self._replay_data_dir
    @replay_data_dir.setter
    def replay_data_dir(self, v: str) -> None: self._replay_data_dir = v
    @property
    def simulator(self) -> MarketSimulator: return self._simulator
    @property
    def frame_count(self) -> int: return self._frame_count

    # ─────────────────────────────────────────────────────────────────
    #  Data source switching
    # ─────────────────────────────────────────────────────────────────

    # ─────────────────────────────────────────────────────────────────
    #  Data source switching
    # ─────────────────────────────────────────────────────────────────

    def on_source_combo_changed(self, index: int) -> None:
        pass

    def switch_to(self, source: DataSource) -> None:
        print(f"[DEBUG] switch_to: switching from {self._data_source} to {source}")
        self.stop_current()
        self._data_source = source
        self._window._order_book.reset()
        self._window._order_book.symbol = self._symbol
        self._window._pulse.reset()
        if hasattr(self._window, 'volume_profile') and self._window.volume_profile is not None:
            self._window.volume_profile.reset()
        if hasattr(self._window, 'heatmap') and self._window.heatmap is not None:
            self._window.heatmap.reset()
        if hasattr(self._window, 'price_chart') and self._window.price_chart is not None:
            self._window.price_chart.reset()
        self._window._gui_frame = 0
        self._frame_count = 0
        self._running = False

        if source == DataSource.CRYPCODILE_REPLAY:
            self._start_replay()
            if self._toolbar and self._toolbar._replay_speed_spinner:
                self._toolbar._replay_speed_spinner.setEnabled(True)
        elif source == DataSource.CRYPCODILE_LIVE:
            self._start_live()
            if self._toolbar and self._toolbar._replay_speed_spinner:
                self._toolbar._replay_speed_spinner.setEnabled(False)

        self._toolbar.update_visibility(source, False)
        self._window._update_status_message()

    def stop_current(self) -> None:
        if self._provider is not None:
            try:
                _disconnect_provider_signals(self, self._provider)
                if hasattr(self._provider, 'stop_replay'):
                    self._provider.stop_replay()
                self._provider.disconnect()
            except Exception:
                pass
            self._provider = None
        
        # Drain the queue to prevent stale updates from leaking
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
                self._queue.task_done()
            except Exception:
                break

        self._running = False
        self._toolbar.set_start_stop_state(False)

    # ─────────────────────────────────────────────────────────────────
    #  Source starters
    # ─────────────────────────────────────────────────────────────────

    def _start_replay(self) -> None:
        if not HAS_CRYPCODILE_REPLAY or CrypcodileReplayProvider is None:
            self._window._status.showMessage("CrypcodileReplayProvider not available")
            return
        try:
            data_dir = self._replay_data_dir
            print(f"[DEBUG] _start_replay: data_dir is '{data_dir}' at entry")
            if not data_dir or data_dir == ".":
                import os
                possible_dirs = [
                    "/Users/nazmi/data",
                    os.path.expanduser("~/data"),
                    ".",
                ]
                for d in possible_dirs:
                    exists = os.path.exists(d) and os.path.isdir(d)
                    syms = CrypcodileReplayProvider.load_symbols(d) if exists else []
                    print(f"[DEBUG] Checking '{d}': exists={exists}, symbols={syms}")
                    if syms:
                        data_dir = d
                        self._replay_data_dir = d
                        break
            if not data_dir:
                data_dir = "."

            # 2. Query available symbols, and map self._symbol to canonical Crypcodile format
            available = CrypcodileReplayProvider.load_symbols(data_dir)
            if available:
                if self._symbol in available:
                    pass  # Exact match, keep self._symbol
                else:
                    clean_sym = self._symbol.replace("/", "").replace(":", "").replace("-", "").upper()
                    matched = None
                    for av_sym in available:
                        av_clean = av_sym.split(":")[-1].replace("-", "").upper()
                        av_full_clean = av_sym.replace("/", "").replace(":", "").replace("-", "").upper()
                        if av_clean == clean_sym or av_full_clean == clean_sym:
                            matched = av_sym
                            break
                    if matched:
                        self._symbol = matched
                    else:
                        self._symbol = available[0]
                
                # Sync symbol field in the toolbar UI
                self._toolbar._symbol_edit.setText(self._symbol)

            provider = CrypcodileReplayProvider(data_dir=data_dir, queue=self._queue, parent=self._window)
            provider.subscribe(self._symbol)
            provider.on_snapshot.connect(self._on_provider_snapshot)
            provider.on_update.connect(self._on_provider_update)
            provider.on_trade.connect(self._on_provider_trade)
            provider.on_bbo.connect(self._on_provider_bbo)
            provider.on_connected.connect(self._on_provider_connected)
            provider.on_disconnected.connect(self._on_provider_disconnected)
            provider.on_error.connect(self._on_provider_error)
            if hasattr(provider, 'replay_progress'):
                provider.replay_progress.connect(self._on_replay_progress)
            self._provider = provider
            self.update_thresholds_for_symbol()
            self._window._order_book.symbol = self._symbol
            self._window._status.showMessage(
                f"Source: Crypcodile Replay  |  Symbol: {self._symbol}  |  "
                f"Speed: {self._replay_speed:.1f}×  |  Press Start to begin")
        except Exception as exc:
            import traceback
            traceback.print_exc()
            self._window._status.showMessage(f"Replay init error: {exc}")

    def _start_live(self) -> None:
        if not HAS_CRYPCODILE_REPLAY or CrypcodileLiveProvider is None:
            self._window._status.showMessage("CrypcodileLiveProvider not available")
            return
        try:
            # Parse the symbol e.g., "binance-spot:SOLUSDT"
            parts = self._symbol.split(":")
            if len(parts) == 2:
                prefix, symbol_raw = parts[0], parts[1]
                if "-" in prefix:
                    exchange, market = prefix.split("-", 1)
                else:
                    exchange, market = prefix, "spot"
            else:
                exchange, market, symbol_raw = "binance", "spot", self._symbol

            # Sync symbol in editing field
            self._toolbar._symbol_edit.setText(self._symbol)

            provider = CrypcodileLiveProvider(
                exchange=exchange,
                symbol_raw=symbol_raw,
                market=market,
                queue=self._queue,
                parent=self._window
            )
            provider.on_snapshot.connect(self._on_provider_snapshot)
            provider.on_update.connect(self._on_provider_update)
            provider.on_trade.connect(self._on_provider_trade)
            provider.on_bbo.connect(self._on_provider_bbo)
            provider.on_connected.connect(self._on_provider_connected)
            provider.on_disconnected.connect(self._on_provider_disconnected)
            provider.on_error.connect(self._on_provider_error)

            self._provider = provider
            self.update_thresholds_for_symbol()
            self._window._order_book.symbol = self._symbol
            self._window._status.showMessage(
                f"Source: Crypcodile Live  |  Exchange: {exchange}  |  "
                f"Symbol: {symbol_raw}  |  Press Start to begin"
            )
        except Exception as exc:
            import traceback
            traceback.print_exc()
            self._window._status.showMessage(f"Live init error: {exc}")

    # ─────────────────────────────────────────────────────────────────
    #  Provider signal handlers
    # ─────────────────────────────────────────────────────────────────

    def _on_provider_snapshot(self, snap) -> None:
        self._window._order_book.apply_snapshot(snap)

    def _on_provider_update(self, update) -> None:
        self._window._order_book.apply_update(update)

    def _on_provider_trade(self, trade: Trade | list[Trade]) -> None:
        if isinstance(trade, list):
            for t in trade:
                self._window._order_book.record_trade(t)
        else:
            self._window._order_book.record_trade(trade)

    def _on_provider_bbo(self, bbo: BBO) -> None:
        pass

    def _on_provider_connected(self) -> None:
        self._running = True
        self._toolbar.set_start_stop_state(True)
        self._toolbar.update_visibility(self._data_source,
            self._provider is not None and getattr(self._provider, 'is_connected', False))
        self._window._update_status_message()

    def _on_provider_disconnected(self) -> None:
        self._running = False
        self._toolbar.set_start_stop_state(False)
        self._toolbar.update_visibility(self._data_source, False)
        self._window._update_status_message()

    def _on_provider_error(self, msg: str) -> None:
        self._window._status.showMessage(f"Error: {msg}")

    def _on_replay_progress(self, progress: float) -> None:
        if self._window._gui_frame % 30 == 0:
            self._window._status.showMessage(
                f"Replay progress: {progress * 100:.0f}%  |  {self._symbol}")

    # ─────────────────────────────────────────────────────────────────
    #  Symbol change
    # ─────────────────────────────────────────────────────────────────

    def update_thresholds_for_symbol(self) -> None:
        """Dynamically adjust spinbox default values and engine zoom/refs based on symbol."""
        # 1. Update spinners if they exist
        if hasattr(self._window, 'llt_thresh_spinner') and hasattr(self._window, 'stops_thresh_spinner'):
            if "SOLUSDT" in self._symbol:
                self._window.llt_thresh_spinner.setValue(5000.0)
                self._window.stops_thresh_spinner.setValue(100.0)
            elif "ETHUSDT" in self._symbol:
                self._window.llt_thresh_spinner.setValue(250.0)
                self._window.stops_thresh_spinner.setValue(20.0)
            else:
                self._window.llt_thresh_spinner.setValue(15.0)
                self._window.stops_thresh_spinner.setValue(10.0)

        # 2. Update engine configuration (ticks_per_row and normalization references)
        if hasattr(self._window, 'heatmap') and self._window.heatmap is not None:
            engine = self._window.heatmap._engine
            if "SOLUSDT" in self._symbol:
                engine.ticks_per_row = 2
                engine.config.bid_ref = 3000.0
                engine.config.ask_ref = 3000.0
            elif "ETHUSDT" in self._symbol:
                engine.ticks_per_row = 10
                engine.config.bid_ref = 100.0
                engine.config.ask_ref = 100.0
            else: # BTCUSDT
                engine.ticks_per_row = 100
                engine.config.bid_ref = 5.0
                engine.config.ask_ref = 5.0
            
            # Synchronize normalizers
            engine._bid_normalizer.global_ref = engine.config.bid_ref
            engine._ask_normalizer.global_ref = engine.config.ask_ref
            engine._bid_normalizer._initialized = False
            engine._ask_normalizer._initialized = False


    def on_symbol_changed(self) -> None:
        symbol_edit = self._toolbar._symbol_edit
        new_symbol = symbol_edit.text().strip()
        if not new_symbol:
            symbol_edit.setText(self._symbol)
            return
        if new_symbol != self._symbol:
            was_running = self._running
            if was_running:
                self.stop_current()
            elif self._provider is not None:
                self.stop_current()

            self._symbol = new_symbol
            self.update_thresholds_for_symbol()
            
            self._window._order_book.reset()
            self._window._order_book.symbol = self._symbol
            self._window._pulse.reset()
            if hasattr(self._window, 'volume_profile') and self._window.volume_profile is not None:
                self._window.volume_profile.reset()
            if hasattr(self._window, 'heatmap') and self._window.heatmap is not None:
                self._window.heatmap.reset()
            if hasattr(self._window, 'price_chart') and self._window.price_chart is not None:
                self._window.price_chart.reset()

            if self._data_source == DataSource.CRYPCODILE_REPLAY:
                self._start_replay()
                if was_running:
                    self._toggle_replay()
            elif self._data_source == DataSource.CRYPCODILE_LIVE:
                self._start_live()
                if was_running:
                    self._toggle_live()

            self._window._update_status_message()

    # ── Simulation / Replay control ──────────────────────────────────

    def toggle_simulation(self) -> None:
        if self._data_source == DataSource.CRYPCODILE_REPLAY:
            self._toggle_replay()
        elif self._data_source == DataSource.CRYPCODILE_LIVE:
            self._toggle_live()

    def _toggle_replay(self) -> None:
        if self._provider is None:
            self._window._status.showMessage("No replay provider initialized")
            return
        if self._running:
            if hasattr(self._provider, 'stop_replay'):
                self._provider.stop_replay()
            self._provider.disconnect()
            self._running = False
            self._toolbar.set_start_stop_state(False)
            self._window._status.showMessage("Replay stopped")
        else:
            if not getattr(self._provider, 'is_connected', False):
                self._provider.connect()

            # Dynamic start/end timestamp resolution from DuckDB database
            start_ns, end_ns = None, None
            data_dir = self._replay_data_dir or "."
            if hasattr(self._provider, 'get_time_range'):
                start_ns, end_ns = self._provider.get_time_range(data_dir, self._symbol)

            if start_ns is None or end_ns is None:
                # Fallback to last 1 hour of real-world time if DB query fails or has no records
                now_ns = int(time.time() * 1_000_000_000)
                one_hour_ns = 3600 * 1_000_000_000
                start_ns = now_ns - one_hour_ns
                end_ns = now_ns

            if hasattr(self._provider, 'start_replay'):
                print(f"[DEBUG] Calling provider.start_replay: symbol={self._symbol} start_ns={start_ns} end_ns={end_ns} speed={self._replay_speed}")
                self._provider.start_replay(
                    symbol=self._symbol,
                    start_ns=start_ns,
                    end_ns=end_ns,
                    speed=self._replay_speed,
                )
                self._running = True
                self._toolbar.set_start_stop_state(True)
                self._window._update_status_message()
            else:
                self._window._status.showMessage("Provider does not support start_replay()")

    def _toggle_live(self) -> None:
        if self._provider is None:
            self._window._status.showMessage("No live provider initialized")
            return
        if self._running:
            self._provider.disconnect()
            self._running = False
            self._toolbar.set_start_stop_state(False)
            self._window._status.showMessage("Live stopped")
        else:
            self._provider.connect()
            # self._running will be set to True on provider connect (signals connected to _on_provider_connected)
            self._window._status.showMessage("Connecting to live stream...")


