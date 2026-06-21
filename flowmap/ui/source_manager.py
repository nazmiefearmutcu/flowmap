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

# ── CrypcodileReplay — optional dependency ──
try:
    from ..data.crypcodile_replay import CrypcodileReplayProvider
    HAS_CRYPCODILE_REPLAY = True
except ImportError:
    CrypcodileReplayProvider = None  # type: ignore
    HAS_CRYPCODILE_REPLAY = False


# ─────────────────────────────────────────────────────────────────────
#  DataSource enum
# ─────────────────────────────────────────────────────────────────────

class DataSource(Enum):
    SIMULATOR = auto()
    CRYPCODILE_REPLAY = auto()
    CCXT_LIVE = auto()


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
        self._data_source: DataSource = DataSource.SIMULATOR
        self._provider: Optional[object] = None
        self._symbol: str = "BTC/USDT"
        self._replay_speed: float = 1.0
        self._replay_data_dir: str = ""
        self._running: bool = False
        self._sim_speed: float = 2.0
        self._frame_count: int = 0
        self._simulator: MarketSimulator = MarketSimulator(
            symbol="SYNTH.NIFTY", tick_size=0.05, depth_levels=15)

    @property
    def queue(self):
        return self._queue

    # ── Properties ──────────────────────────────────────────────────

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
    def replay_speed(self, v: float) -> None: self._replay_speed = v
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

    def on_source_combo_changed(self, index: int) -> None:
        combo = self._toolbar._source_combo
        data = combo.currentData()
        if data is None:
            combo.setCurrentIndex(0)
            self._window._status.showMessage(
                "Crypcodile Replay not available — install 'crypcodile' package")
            return
        new_source = DataSource(data)
        if new_source != self._data_source:
            self.switch_to(new_source)

    def switch_to(self, source: DataSource) -> None:
        self.stop_current()
        self._data_source = source
        self._window._order_book.reset()
        self._window._order_book.symbol = self._symbol
        self._window._pulse.reset()
        if hasattr(self._window, 'volume_profile') and self._window.volume_profile is not None:
            self._window.volume_profile.reset()
        self._window._gui_frame = 0
        self._frame_count = 0
        self._running = False

        if source == DataSource.SIMULATOR:
            self._start_simulator()
        elif source == DataSource.CRYPCODILE_REPLAY:
            self._start_replay()
        elif source == DataSource.CCXT_LIVE:
            self._start_live()

        self._toolbar.update_visibility(source, False)
        self._window._update_status_message()

    def stop_current(self) -> None:
        sim_timer = self._window._sim_timer
        if sim_timer.isActive():
            sim_timer.stop()
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
        self._toolbar.set_connected_state(False)

    # ─────────────────────────────────────────────────────────────────
    #  Source starters
    # ─────────────────────────────────────────────────────────────────

    def _start_simulator(self) -> None:
        self._symbol = "SYNTH.NIFTY"
        self._toolbar._symbol_edit.setText(self._symbol)
        self._window._order_book.symbol = self._symbol
        self._simulator = MarketSimulator(
            symbol=self._symbol, tick_size=0.05, depth_levels=15)
        self._window._status.showMessage(
            f"Source: Simulator  |  Symbol: {self._symbol}  |  Ready")

    def _start_replay(self) -> None:
        if not HAS_CRYPCODILE_REPLAY or CrypcodileReplayProvider is None:
            self._window._status.showMessage("CrypcodileReplayProvider not available")
            return
        try:
            # 1. Auto-detect data directory if not set
            data_dir = self._replay_data_dir
            if not data_dir or data_dir == ".":
                import os
                possible_dirs = [
                    "/Users/nazmi/data",
                    os.path.expanduser("~/data"),
                    ".",
                ]
                for d in possible_dirs:
                    if os.path.exists(d) and os.path.isdir(d):
                        syms = CrypcodileReplayProvider.load_symbols(d)
                        if syms:
                            data_dir = d
                            self._replay_data_dir = d
                            break
            if not data_dir:
                data_dir = "."

            # 2. Query available symbols, and map self._symbol to canonical Crypcodile format
            available = CrypcodileReplayProvider.load_symbols(data_dir)
            if available:
                clean_sym = self._symbol.replace("/", "").replace(":", "").upper()
                matched = None
                for av_sym in available:
                    av_clean = av_sym.split(":")[-1].upper()
                    if av_clean == clean_sym or av_sym.upper() == clean_sym:
                        matched = av_sym
                        break
                if matched:
                    self._symbol = matched
                else:
                    # Default to first available symbol in database if no match is found
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
            self._window._order_book.symbol = self._symbol
            self._window._status.showMessage(
                f"Source: Crypcodile Replay  |  Symbol: {self._symbol}  |  "
                f"Speed: {self._replay_speed:.1f}×  |  Press Start to begin")
        except Exception as exc:
            self._window._status.showMessage(f"Replay init error: {exc}")

    def _start_live(self) -> None:
        try:
            provider = CryptoProvider(exchange_id="binance", depth=15, force_rest=False, queue=self._queue)
            provider.subscribe(self._symbol)
            provider.on_snapshot.connect(self._on_provider_snapshot)
            provider.on_trade.connect(self._on_provider_trade)
            provider.on_bbo.connect(self._on_provider_bbo)
            provider.on_connected.connect(self._on_provider_connected)
            provider.on_disconnected.connect(self._on_provider_disconnected)
            provider.on_error.connect(self._on_provider_error)
            self._provider = provider
            self._window._order_book.symbol = self._symbol
            self._toolbar.update_visibility(self._data_source, False)
            self._window._status.showMessage(
                f"Source: CCXT Live (binance)  |  Symbol: {self._symbol}  |  "
                f"Disconnected — press Connect")
        except Exception as exc:
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
        if self._data_source == DataSource.CCXT_LIVE:
            self._toolbar.set_connected_state(True)
        elif self._data_source == DataSource.CRYPCODILE_REPLAY:
            self._toolbar.set_start_stop_state(True)
        self._toolbar.update_visibility(self._data_source,
            self._provider is not None and getattr(self._provider, 'is_connected', False))
        self._window._update_status_message()

    def _on_provider_disconnected(self) -> None:
        self._running = False
        if self._data_source == DataSource.CCXT_LIVE:
            self._toolbar.set_connected_state(False)
        elif self._data_source == DataSource.CRYPCODILE_REPLAY:
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

    def on_symbol_changed(self) -> None:
        symbol_edit = self._toolbar._symbol_edit
        new_symbol = symbol_edit.text().strip().upper()
        if not new_symbol:
            symbol_edit.setText(self._symbol)
            return
        if new_symbol != self._symbol:
            self._symbol = new_symbol
            self._window._order_book.reset()
            self._window._order_book.symbol = self._symbol
            self._window._pulse.reset()
            if hasattr(self._window, 'volume_profile') and self._window.volume_profile is not None:
                self._window.volume_profile.reset()
            if self._provider is not None:
                try:
                    self._provider.subscribe(self._symbol)
                except Exception:
                    pass
            self._window._update_status_message()

    # ─────────────────────────────────────────────────────────────────
    #  Connect / Disconnect (live mode)
    # ─────────────────────────────────────────────────────────────────

    def on_connect_clicked(self) -> None:
        if self._provider is None:
            return
        if getattr(self._provider, 'is_connected', False):
            self._provider.disconnect()
        else:
            self._provider.connect()

    # ── Simulation / Replay control ──────────────────────────────────

    def toggle_simulation(self) -> None:
        if self._data_source == DataSource.SIMULATOR:
            self._toggle_simulator()
        elif self._data_source == DataSource.CRYPCODILE_REPLAY:
            self._toggle_replay()

    def _toggle_simulator(self) -> None:
        sim_timer = self._window._sim_timer
        if self._running:
            sim_timer.stop()
            self._running = False
            self._toolbar.set_start_stop_state(False)
            self._window._status.showMessage("Simulation stopped")
        else:
            _safe = max(self._sim_speed, 0.01)
            sim_timer.start(int(1000 / (60 * _safe)))
            self._running = True
            self._toolbar.set_start_stop_state(True)
            self._window._status.showMessage("Simulation running — NIFTY @ ~24,500")

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
                self._provider.start_replay(
                    symbol=self._symbol,
                    start_ns=start_ns,
                    end_ns=end_ns,
                    speed=self._replay_speed,
                )
                self._running = True
                self._toolbar.set_start_stop_state(True)
                self._window._status.showMessage(
                    f"Replay running — {self._symbol} @ {self._replay_speed:.1f}×")
            else:
                self._window._status.showMessage("Provider does not support start_replay()")

    # ── Sim tick ────────────────────────────────────────────────────

    def sim_tick(self) -> dict:
        self._frame_count += 1
        return self._simulator.tick()
