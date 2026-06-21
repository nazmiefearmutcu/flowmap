"""
Data source manager — unified interface for all market data providers.

The DataManager owns the active provider (simulator, crypto, replay, etc.)
and exposes a common API + signals so that MainWindow and other consumers
do not need to know which concrete provider is running.
"""

from __future__ import annotations

from typing import Any, Optional

from PyQt6.QtCore import QObject, pyqtSignal

from ..core import Level2Snapshot, Level2Update, Trade, BBO
from .base import DataProvider
from .simulator import MarketSimulator
from .crypto import CryptoProvider
from .config import EXCHANGE_CONFIG


class DataManager(QObject):
    """
    Central data-source manager.

    Call *set_source* to pick the active provider, then *connect* / *disconnect*
    to control the data flow.  All data signals are proxied from whichever
    provider is currently active.

    Usage::

        mgr = DataManager()
        mgr.set_source("simulator", symbol="SYNTH.NIFTY")
        mgr.connect()
        mgr.on_snapshot.connect(my_slot)
    """

    # Proxied signals
    on_snapshot = pyqtSignal(object)       # Level2Snapshot
    on_update = pyqtSignal(object)         # Level2Update
    on_trade = pyqtSignal(object)          # Trade
    on_bbo = pyqtSignal(object)            # BBO
    on_connected = pyqtSignal()
    on_disconnected = pyqtSignal()
    on_error = pyqtSignal(str)

    # Lifecycle
    on_source_changed = pyqtSignal(str)    # new source name

    # ── Known source types ──────────────────────────────────────

    SOURCES = {
        "simulator": "Simulated market (random walk + order book)",
        "binance": "Binance (WebSocket / REST)",
        "coinbase": "Coinbase (WebSocket / REST)",
        "kraken": "Kraken (WebSocket / REST)",
        "bybit": "Bybit (WebSocket / REST)",
        "okx": "OKX (WebSocket / REST)",
        "bitmex": "BitMEX (WebSocket / REST)",
    }

    def __init__(self, parent: QObject = None) -> None:
        super().__init__(parent)
        self._provider: Optional[DataProvider] = None
        self._source_type: str = ""

    # ── Properties ──────────────────────────────────────────────

    @property
    def provider(self) -> Optional[DataProvider]:
        """The currently active DataProvider instance."""
        return self._provider

    @property
    def source_type(self) -> str:
        """Type string of the active source (e.g. ``"binance"``)."""
        return self._source_type

    @property
    def is_connected(self) -> bool:
        return self._provider is not None and self._provider.is_connected

    # ── Source selection ────────────────────────────────────────

    def set_source(self, source_type: str, **kwargs: Any) -> None:
        """
        Switch to a different data source.

        Parameters
        ----------
        source_type : str
            One of ``"simulator"`` or an exchange name (``"binance"``, …).
        **kwargs
            Forwarded to the provider constructor.  Common options:
            ``symbol``, ``api_key``, ``api_secret``, ``depth``, etc.
        """
        self.disconnect()

        old = self._provider
        self._provider = None
        self._source_type = ""
        if old is not None:
            old.deleteLater()

        provider = self._build_provider(source_type, kwargs)
        if provider is None:
            self.on_error.emit(f"Unknown data source: {source_type}")
            return

        self._provider = provider
        self._source_type = source_type

        # Wire signals
        provider.on_snapshot.connect(self.on_snapshot.emit)
        provider.on_update.connect(self.on_update.emit)
        provider.on_trade.connect(self.on_trade.emit)
        provider.on_bbo.connect(self.on_bbo.emit)
        provider.on_connected.connect(self.on_connected.emit)
        provider.on_disconnected.connect(self.on_disconnected.emit)
        provider.on_error.connect(self.on_error.emit)

        self.on_source_changed.emit(source_type)

    def _build_provider(self, source_type: str,
                        kwargs: dict[str, Any]) -> Optional[DataProvider]:
        """Factory — create a DataProvider for *source_type*."""
        if source_type == "simulator":
            return MarketSimulator(
                symbol=kwargs.pop("symbol", "SYNTH.NIFTY"),
                base_price=kwargs.pop("base_price", 24500.0),
                tick_size=kwargs.pop("tick_size", 0.05),
                depth_levels=kwargs.pop("depth", 20),
                **kwargs,
            )

        # Otherwise treat *source_type* as an exchange name
        if source_type not in EXCHANGE_CONFIG:
            return None

        cfg = EXCHANGE_CONFIG[source_type]
        depth = int(kwargs.pop("depth", cfg.get("depth", 20)))
        force_rest = bool(kwargs.pop("force_rest", not cfg.get("ws", True)))

        return CryptoProvider(
            exchange_id=source_type,
            api_key=kwargs.pop("api_key", ""),
            api_secret=kwargs.pop("api_secret", ""),
            depth=depth,
            force_rest=force_rest,
            parent=self,
            **kwargs,
        )

    # ── Lifecycle ───────────────────────────────────────────────

    def connect(self) -> None:
        """Connect the active provider."""
        if self._provider is None:
            self.on_error.emit("No data source selected")
            return
        if not self._provider.is_connected:
            self._provider.connect()

    def disconnect(self) -> None:
        """Disconnect the active provider."""
        if self._provider is not None and self._provider.is_connected:
            self._provider.disconnect()

    # ── Subscription (delegated) ────────────────────────────────

    def subscribe(self, symbol: str) -> None:
        if self._provider is not None:
            self._provider.subscribe(symbol)

    def unsubscribe(self, symbol: str) -> None:
        if self._provider is not None:
            self._provider.unsubscribe(symbol)

    # ── Cleanup ─────────────────────────────────────────────────

    def shutdown(self) -> None:
        """Disconnect and release all resources."""
        self.disconnect()
        if self._provider is not None:
            self._provider.deleteLater()
            self._provider = None
        self._source_type = ""
