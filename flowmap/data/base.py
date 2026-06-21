"""
Abstract base class for all market data providers.
Defines the signal interface that consumers (MainWindow, overlays) rely on.

NOTE: We cannot use abc.ABC here because PyQt6's QObject metaclass (Shiboken)
conflicts with ABCMeta.  Instead we raise NotImplementedError in the base
methods — the pattern is enforced by convention.
"""

from __future__ import annotations
from typing import Optional

from PyQt6.QtCore import QObject, pyqtSignal

from ..core import Level2Snapshot, Level2Update, Trade, BBO


class DataProvider(QObject):
    """
    Abstract base for market data sources.

    Concrete providers (simulator, crypto, replay) inherit from this class
    and emit signals when new data arrives.  Consumers connect to the signals
    without caring about the underlying source.
    """

    # ── Signals ─────────────────────────────────────────────────

    on_snapshot = pyqtSignal(object)       # Level2Snapshot
    on_update = pyqtSignal(object)         # Level2Update (incremental L2)
    on_trade = pyqtSignal(object)          # Trade
    on_bbo = pyqtSignal(object)            # BBO
    on_connected = pyqtSignal()
    on_disconnected = pyqtSignal()
    on_error = pyqtSignal(str)

    def __init__(self, parent: Optional[QObject] = None) -> None:
        super().__init__(parent)
        self._symbols: list[str] = []
        self._connected: bool = False

    # ── Properties ──────────────────────────────────────────────

    @property
    def name(self) -> str:
        """Human-readable provider name (e.g. 'binance-ws', 'simulator')."""
        raise NotImplementedError

    @property
    def symbols(self) -> list[str]:
        """Symbols currently subscribed to."""
        return self._symbols.copy()

    @property
    def is_connected(self) -> bool:
        return self._connected

    # ── Lifecycle ───────────────────────────────────────────────

    def connect(self) -> None:
        """Open the data connection.  May be async; provider should emit
        on_connected when the link is established and on_error on failure."""
        raise NotImplementedError

    def disconnect(self) -> None:
        """Tear down the connection cleanly.  Emit on_disconnected."""
        raise NotImplementedError

    # ── Subscription ────────────────────────────────────────────

    def subscribe(self, symbol: str) -> None:
        """Subscribe to real-time data for *symbol*."""
        raise NotImplementedError

    def unsubscribe(self, symbol: str) -> None:
        """Unsubscribe from *symbol*."""
        raise NotImplementedError
