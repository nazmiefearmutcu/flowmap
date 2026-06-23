"""
CrypcodileLiveProvider — bridges Crypcodile's live exchange connectors
to FlowMap's real-time visualization.

Connects to live WebSocket feeds via Crypcodile's make_connector and
AiohttpWsTransport inside a background QThread.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from PyQt6.QtCore import QObject, QThread, pyqtSignal, pyqtSlot

from ..core import Level2Snapshot, Level2Update, Trade, BBO, Side
from .base import DataProvider
from .crypcodile_replay import _dispatch_record

log = logging.getLogger(__name__)

# ── Optional crypcodile imports ──────────────────────────────────────────────

try:
    from crypcodile.exchanges.factory import make_connector
    from crypcodile.ingest.transport import AiohttpWsTransport
    from crypcodile.instruments.registry import InstrumentRegistry
    from crypcodile.sink.base import Sink
    from crypcodile.schema.records import Record
    _CRYPCODILE_AVAILABLE = True
except ImportError as _import_error:
    _CRYPCODILE_AVAILABLE = False
    _CRYPCODILE_IMPORT_ERROR = str(_import_error)
    make_connector = None  # type: ignore
    AiohttpWsTransport = None  # type: ignore
    InstrumentRegistry = None  # type: ignore
    Sink = object  # type: ignore
    Record = None  # type: ignore


if _CRYPCODILE_AVAILABLE:
    class FlowMapLiveSink(Sink):
        """Custom Crypcodile Sink that feeds incoming Record objects to a callback."""

        def __init__(self, callback) -> None:
            self._callback = callback

        async def put(self, record: Record) -> None:
            self._callback(record)

        async def flush(self) -> None:
            pass

        async def close(self) -> None:
            pass
else:
    class FlowMapLiveSink:
        pass


class _LiveWorker(QObject):
    """Runs the asyncio loop for the Crypcodile Connector inside a QThread."""

    sig_snapshot = pyqtSignal(object)   # Level2Snapshot
    sig_update = pyqtSignal(object)     # Level2Update
    sig_trade = pyqtSignal(object)      # Trade
    sig_bbo = pyqtSignal(object)        # BBO
    sig_connected = pyqtSignal()
    sig_disconnected = pyqtSignal()
    sig_error = pyqtSignal(str)

    def __init__(
        self,
        exchange: str,
        symbol_raw: str,
        market: str,
        queue=None,
        parent: QObject = None,
    ) -> None:
        super().__init__(parent)
        self._exchange = exchange
        self._symbol_raw = symbol_raw
        self._market = market
        self._queue = queue
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._connector: Optional[Any] = None
        self._running = False

    @pyqtSlot()
    def start(self) -> None:
        """Enter the asyncio event loop; runs until stop() is requested."""
        if not _CRYPCODILE_AVAILABLE:
            self.sig_error.emit(
                f"Crypcodile is not available: {_CRYPCODILE_IMPORT_ERROR}"
            )
            return

        try:
            import aiohttp
            if not getattr(aiohttp.ClientSession, '_patched_for_flowmap', False):
                original_ws_connect = aiohttp.ClientSession.ws_connect
                async def patched_ws_connect(self_session, url, *args, **kwargs):
                    kwargs['ssl'] = False
                    return await original_ws_connect(self_session, url, *args, **kwargs)
                aiohttp.ClientSession.ws_connect = patched_ws_connect
                aiohttp.ClientSession._patched_for_flowmap = True
                log.info("Monkeypatched aiohttp.ClientSession.ws_connect to disable SSL verification.")
        except Exception as e:
            log.warning(f"Failed to monkeypatch aiohttp: {e}")

        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._running = True
        try:
            self._loop.run_until_complete(self._run())
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            self.sig_error.emit(f"Live worker crashed: {exc}")
        finally:
            self._loop.close()
            self._loop = None

    @pyqtSlot()
    def stop(self) -> None:
        """Request graceful shutdown of the transport and event loop."""
        self._running = False
        if self._loop and self._loop.is_running():
            if self._connector and self._connector.transport:
                asyncio.run_coroutine_threadsafe(
                    self._connector.transport.close(), self._loop
                )

    async def _run(self) -> None:
        registry = InstrumentRegistry()
        sink = FlowMapLiveSink(self._on_record)

        kwargs = {}
        if self._exchange == "binance":
            kwargs["market"] = self._market
        elif self._exchange == "bybit":
            kwargs["category"] = "spot" if self._market == "spot" else "linear"
        elif self._exchange == "okx":
            kwargs["region"] = "global"

        try:
            connector = make_connector(
                exchange=self._exchange,
                symbols=[self._symbol_raw],
                channels=["trade", "book_snapshot", "book_delta"],
                out=sink,
                registry=registry,
                **kwargs,
            )
        except Exception as e:
            self.sig_error.emit(f"Failed to create connector: {e}")
            return

        if connector.transport is None:
            connector.transport = AiohttpWsTransport(connector.ws_url)

        self._connector = connector
        self.sig_connected.emit()

        try:
            await connector.run()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.sig_error.emit(f"Connector run error: {e}")
        finally:
            self.sig_disconnected.emit()

    def _on_record(self, record: Record) -> None:
        # Convert and dispatch to FlowMap core types
        flow_objects = _dispatch_record(record)
        for obj in flow_objects:
            if self._queue is not None:
                if isinstance(obj, Level2Snapshot):
                    self._queue.put(("snapshot", obj))
                elif isinstance(obj, Level2Update):
                    self._queue.put(("update", obj))
                elif isinstance(obj, Trade):
                    self._queue.put(("trade", obj))
                elif isinstance(obj, BBO):
                    self._queue.put(("bbo", obj))
            else:
                if isinstance(obj, Level2Snapshot):
                    self.sig_snapshot.emit(obj)
                elif isinstance(obj, Level2Update):
                    self.sig_update.emit(obj)
                elif isinstance(obj, Trade):
                    self.sig_trade.emit(obj)
                elif isinstance(obj, BBO):
                    self.sig_bbo.emit(obj)


class CrypcodileLiveProvider(DataProvider):
    """Real-time market data provider backed by Crypcodile's exchange connectors."""

    def __init__(
        self,
        exchange: str,
        symbol_raw: str,
        market: str = "spot",
        queue=None,
        parent: QObject = None,
    ) -> None:
        super().__init__(parent)
        self._exchange = exchange
        self._symbol_raw = symbol_raw
        self._market = market
        self._queue = queue
        self._worker: Optional[_LiveWorker] = None
        self._thread: Optional[QThread] = None

    @property
    def name(self) -> str:
        return f"crypcodile-live-{self._exchange}"

    def connect(self) -> None:
        if self._connected:
            return

        if not _CRYPCODILE_AVAILABLE:
            self.on_error.emit(
                f"Crypcodile is not installed: {_CRYPCODILE_IMPORT_ERROR}"
            )
            return

        self._worker = _LiveWorker(
            exchange=self._exchange,
            symbol_raw=self._symbol_raw,
            market=self._market,
            queue=self._queue,
        )

        self._worker.sig_snapshot.connect(self.on_snapshot.emit)
        self._worker.sig_update.connect(self.on_update.emit)
        self._worker.sig_trade.connect(self.on_trade.emit)
        self._worker.sig_bbo.connect(self.on_bbo.emit)
        self._worker.sig_connected.connect(self._on_worker_connected)
        self._worker.sig_disconnected.connect(self._on_worker_disconnected)
        self._worker.sig_error.connect(self.on_error.emit)

        self._thread = QThread(self)
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(self._worker.start)
        self._thread.finished.connect(self._thread.deleteLater)
        self._thread.start()

    def disconnect(self) -> None:
        if self._worker:
            self._worker.stop()
        if self._thread and self._thread.isRunning():
            self._thread.quit()
            self._thread.wait(2000)
        self._worker = None
        self._thread = None
        if self._connected:
            self._connected = False
            self.on_disconnected.emit()

    def _on_worker_connected(self) -> None:
        self._connected = True
        self.on_connected.emit()

    def _on_worker_disconnected(self) -> None:
        self._connected = False
        self.on_disconnected.emit()

    def subscribe(self, symbol: str) -> None:
        pass

    def unsubscribe(self, symbol: str) -> None:
        pass
