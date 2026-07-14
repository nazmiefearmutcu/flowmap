"""
CCXT-based crypto data provider with WebSocket + REST polling modes.

Uses ccxt.pro for real-time WebSocket feeds when available, with a
graceful fallback to REST polling via QTimer.

Supported exchanges: binance, coinbase, kraken, bybit, okx, bitmex, etc.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Optional

from PyQt6.QtCore import QObject, QThread, QTimer, pyqtSignal, pyqtSlot

from ..core import Level2Snapshot, Level2Update, Trade, BBO, Side
from .base import DataProvider

# ---------------------------------------------------------------------------
# Helpers – convert CCXT data to FlowMap core types
# ---------------------------------------------------------------------------

_SIDE_MAP = {"buy": Side.BUY, "sell": Side.SELL, "bid": Side.BID, "ask": Side.ASK}


def _side_from_ccxt(raw) -> Side:
    """Map CCXT trade/liq side string to Side. Unknown/empty → UNKNOWN (FIND-NUM-05)."""
    if raw is None:
        return Side.UNKNOWN
    if isinstance(raw, str):
        key = raw.lower().strip()
        if not key:
            return Side.UNKNOWN
        return _SIDE_MAP.get(key, Side.UNKNOWN)
    val = getattr(raw, "value", raw)
    if isinstance(val, str):
        key = val.lower().strip()
        return _SIDE_MAP.get(key, Side.UNKNOWN) if key else Side.UNKNOWN
    return Side.UNKNOWN


def _ccxt_ts(ccxt_item: dict) -> float:
    """Extract a Unix-epoch-seconds timestamp from a CCXT object."""
    ts = ccxt_item.get("timestamp")
    if ts is None:
        return time.time()
    # CCXT gives ms – convert to seconds
    return ts / 1000.0


def _snapshot_from_ccxt(ob: dict, depth: int = 20, receive_timestamp: float = 0.0) -> Level2Snapshot:
    """Convert a CCXT order-book dict to a Level2Snapshot."""
    bids: list[tuple[float, float]] = []
    asks: list[tuple[float, float]] = []
    for p, s in ob.get("bids", []):
        if p and s is not None:
            bids.append((float(p), float(s)))
    for p, s in ob.get("asks", []):
        if p and s is not None:
            asks.append((float(p), float(s)))
    return Level2Snapshot(
        timestamp=_ccxt_ts(ob),
        symbol=str(ob.get("symbol", "")),
        bids=tuple(bids[:depth]),
        asks=tuple(asks[:depth]),
        bid_depth=len(bids[:depth]),
        ask_depth=len(asks[:depth]),
        receive_timestamp=receive_timestamp,
    )


def _bbo_from_ccxt(ob: dict, symbol: str, receive_timestamp: float = 0.0) -> BBO:
    """Derive a BBO from a CCXT order-book dict."""
    bids = ob.get("bids", [])
    asks = ob.get("asks", [])
    ts = _ccxt_ts(ob)
    if bids and asks:
        bid_price = float(bids[0][0])
        bid_size = float(bids[0][1])
        ask_price = float(asks[0][0])
        ask_size = float(asks[0][1])
        return BBO(
            timestamp=ts, symbol=symbol,
            bid=bid_price, ask=ask_price,
            bid_size=bid_size, ask_size=ask_size,
            receive_timestamp=receive_timestamp,
        )
    return BBO(timestamp=ts, symbol=symbol, bid=0.0, ask=0.0,
               bid_size=0.0, ask_size=0.0, receive_timestamp=receive_timestamp)


def _trades_from_ccxt(raw_trades: list[dict], symbol: str, receive_timestamp: float = 0.0) -> list[Trade]:
    """Convert a list of CCXT trade dicts to FlowMap Trade objects."""
    out: list[Trade] = []
    for t in raw_trades:
        # Missing/garbage side → UNKNOWN (not silent BUY bias)
        side = _side_from_ccxt(t.get("side"))
        out.append(Trade(
            timestamp=_ccxt_ts(t),
            symbol=str(t.get("symbol", symbol)),
            price=float(t["price"]),
            size=float(t.get("amount", 0)),
            side=side,
            trade_id=str(t.get("id", "")),
            receive_timestamp=receive_timestamp,
        ))
    return out


def _bbo_from_ticker(ticker: dict, symbol: str, receive_timestamp: float = 0.0) -> Optional[BBO]:
    """Build a BBO from a CCXT ticker dict (used by polling mode)."""
    bid = ticker.get("bid")
    ask = ticker.get("ask")
    if bid is None or ask is None:
        return None
    return BBO(
        timestamp=_ccxt_ts(ticker),
        symbol=str(ticker.get("symbol", symbol)),
        bid=float(bid),
        ask=float(ask),
        bid_size=float(ticker.get("bidVolume", 0)),
        ask_size=float(ticker.get("askVolume", 0)),
        receive_timestamp=receive_timestamp,
    )


# ---------------------------------------------------------------------------
# Async worker – runs ccxt.pro in a background QThread
# ---------------------------------------------------------------------------


class _WsWorker(QObject):
    """Runs ccxt.pro WebSocket watchers inside a dedicated thread + asyncio loop.

    Signals are thread-safe; consumers on the main thread receive them via
    Qt's automatic queued connections.
    """

    sig_snapshot = pyqtSignal(object)   # Level2Snapshot
    sig_trade = pyqtSignal(object)      # Trade
    sig_bbo = pyqtSignal(object)        # BBO
    sig_connected = pyqtSignal()
    sig_disconnected = pyqtSignal()
    sig_error = pyqtSignal(str)

    def __init__(self, exchange_id: str, ccxt_config: dict,
                 symbols: list[str], depth: int, queue=None, parent: QObject = None) -> None:
        super().__init__(parent)
        self._exchange_id = exchange_id
        self._ccxt_config = ccxt_config
        self._symbols = symbols
        self._depth = depth
        self._queue = queue
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._exchange: Any = None
        self._running = False
        
        # Ingestion buffers to prevent event queue overflow
        self._trade_buffer: list[Trade] = []
        self._orderbook_buffer: Optional[dict] = None
        self._ticker_buffer: Optional[dict] = None
        # Nonces: ccxt mutates dicts in-place; identity checks cannot detect updates.
        self._orderbook_nonce: int = 0
        self._ticker_nonce: int = 0
        self._last_ob_nonce: int = -1
        self._last_ticker_nonce: int = -1

    # ── Public API (called via signal/slot from the owning thread) ──

    @pyqtSlot()
    def start(self) -> None:
        """Enter the asyncio event loop; runs until *stop* is requested."""
        import ccxt.pro

        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._running = True
        try:
            self._loop.run_until_complete(self._run(ccxt.pro))
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            self.sig_error.emit(f"WebSocket worker crashed: {exc}")
        finally:
            self._loop.close()
            self._loop = None

    @pyqtSlot()
    def stop(self) -> None:
        """Request graceful shutdown."""
        self._running = False
        if self._exchange and self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self._exchange.close(), self._loop
            )

    # ── Async internals ──────────────────────────────────────────

    async def _run(self, cpro: Any) -> None:
        ex_cls = getattr(cpro, self._exchange_id, None)
        if ex_cls is None:
            self.sig_error.emit(
                f"ccxt.pro has no exchange '{self._exchange_id}'"
            )
            return

        self._exchange = ex_cls(self._ccxt_config)
        symbol = self._symbols[0] if self._symbols else "BTC/USDT"
        self.sig_connected.emit()

        tasks = [
            asyncio.create_task(self._watch_orderbook(symbol)),
            asyncio.create_task(self._watch_trades(symbol)),
            asyncio.create_task(self._watch_ticker(symbol)),
            asyncio.create_task(self._watch_liquidations(symbol)),
            asyncio.create_task(self._sender_loop()),
        ]
        try:
            await asyncio.gather(*tasks)
        except asyncio.CancelledError:
            for t in tasks:
                t.cancel()

    async def _sender_loop(self) -> None:
        """Periodically flushes buffered trades, and conflated orderbook/BBO updates."""
        last_ob = None
        last_ticker = None
        conflation_interval = 0.03  # ~33Hz, optimal for smooth UI frames and minimal overhead

        while self._running:
            try:
                await asyncio.sleep(conflation_interval)

                # 1. Dispatch trade batch
                if self._trade_buffer:
                    trades_to_emit = list(self._trade_buffer)
                    self._trade_buffer.clear()
                    if self._queue is not None:
                        for t in trades_to_emit:
                            self._queue.put(("trade", t))
                    else:
                        self.sig_trade.emit(trades_to_emit)

                # 2. Conflate orderbook and its derived BBO
                # CCXT often mutates one dict in-place; identity (`is not`) never
                # changes after the first assignment → book would stall forever.
                # Use a nonce bumped by the watch loop instead.
                ob = self._orderbook_buffer
                ob_nonce = getattr(self, "_orderbook_nonce", 0)
                last_ob_nonce = getattr(self, "_last_ob_nonce", -1)
                if ob is not None and ob_nonce != last_ob_nonce:
                    snap = _snapshot_from_ccxt(ob, self._depth)
                    bbo = _bbo_from_ccxt(ob, ob.get("symbol", ""))
                    if self._queue is not None:
                        self._queue.put(("snapshot", snap))
                        self._queue.put(("bbo", bbo))
                    else:
                        self.sig_snapshot.emit(snap)
                        self.sig_bbo.emit(bbo)
                    self._last_ob_nonce = ob_nonce
                    last_ob = ob

                # 3. Conflate ticker BBO
                ticker = self._ticker_buffer
                ticker_nonce = getattr(self, "_ticker_nonce", 0)
                last_ticker_nonce = getattr(self, "_last_ticker_nonce", -1)
                if ticker is not None and ticker_nonce != last_ticker_nonce:
                    bbo = _bbo_from_ticker(ticker, ticker.get("symbol", ""))
                    if bbo is not None:
                        if self._queue is not None:
                            self._queue.put(("bbo", bbo))
                        else:
                            self.sig_bbo.emit(bbo)
                    self._last_ticker_nonce = ticker_nonce
                    last_ticker = ticker

            except asyncio.CancelledError:
                break
            except Exception as exc:
                self.sig_error.emit(f"WS Sender loop error: {exc}")

    async def _watch_liquidations(self, symbol: str) -> None:
        if not hasattr(self._exchange, 'has') or not self._exchange.has.get('watchLiquidations'):
            return
        while self._running:
            try:
                raw = await self._exchange.watch_liquidations(symbol)
                for liq in raw:
                    side = _side_from_ccxt(liq.get("side"))
                    trade = Trade(
                        timestamp=_ccxt_ts(liq),
                        symbol=str(liq.get("symbol", symbol)),
                        price=float(liq["price"]),
                        size=float(liq.get("amount", 0)),
                        side=side,
                        trade_id=str(liq.get("id", "")),
                        is_liquidation=True
                    )
                    self._trade_buffer.append(trade)
            except asyncio.CancelledError:
                break
            except Exception:
                await asyncio.sleep(10)

    async def _watch_orderbook(self, symbol: str) -> None:
        while self._running:
            try:
                ob = await self._exchange.watch_order_book(symbol)
                self._orderbook_buffer = ob
                self._orderbook_nonce += 1
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self.sig_error.emit(f"OrderBook stream: {exc}")
                await asyncio.sleep(5)

    async def _watch_trades(self, symbol: str) -> None:
        while self._running:
            try:
                raw = await self._exchange.watch_trades(symbol)
                self._trade_buffer.extend(_trades_from_ccxt(raw, symbol))
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self.sig_error.emit(f"Trade stream: {exc}")
                await asyncio.sleep(5)

    async def _watch_ticker(self, symbol: str) -> None:
        while self._running:
            try:
                ticker = await self._exchange.watch_ticker(symbol)
                self._ticker_buffer = ticker
                self._ticker_nonce += 1
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self.sig_error.emit(f"Ticker stream: {exc}")
                await asyncio.sleep(5)


# ---------------------------------------------------------------------------
# CryptoProvider – public-facing data provider
# ---------------------------------------------------------------------------


class CryptoProvider(DataProvider):
    """
    Real-time crypto market data provider backed by CCXT.

    Two operating modes:
      * **WebSocket** (preferred) – uses ccxt.pro for low-latency streaming.
      * **Polling**  – falls back to REST API via QTimer every *poll_interval*
        seconds when ccxt.pro is unavailable or ``force_rest=True``.

    Parameters
    ----------
    exchange_id : str
        Exchange identifier (e.g. ``"binance"``, ``"coinbase"``, ``"kraken"``).
    api_key : str, optional
        CCXT API key (not required for public data on most exchanges).
    api_secret : str, optional
        CCXT API secret.
    depth : int
        Number of price levels per side (default 20).
    poll_interval : float
        Seconds between REST polls (default 2.0).
    force_rest : bool
        If True, use REST polling even when ccxt.pro is available.
    """

    def __init__(
        self,
        exchange_id: str = "binance",
        api_key: str = "",
        api_secret: str = "",
        depth: int = 20,
        poll_interval: float = 2.0,
        force_rest: bool = False,
        queue=None,
        parent: QObject = None,
    ) -> None:
        super().__init__(parent)
        self._exchange_id = exchange_id.lower()
        self._depth = depth
        self._poll_interval = poll_interval
        self._force_rest = force_rest
        self._queue = queue

        # CCXT config
        self._ccxt_config: dict[str, Any] = {
            "enableRateLimit": True,
            "options": {"defaultType": "spot"},
        }
        if api_key:
            self._ccxt_config["apiKey"] = api_key
        if api_secret:
            self._ccxt_config["secret"] = api_secret

        # WebSocket thread / worker
        self._ws_thread: Optional[QThread] = None
        self._ws_worker: Optional[_WsWorker] = None

        # REST polling timer
        self._rest_exchange: Any = None
        self._poll_timer: Optional[QTimer] = None

        self._connected = False

    # ── Properties ──────────────────────────────────────────────

    @property
    def name(self) -> str:
        suffix = "ws" if not self._force_rest else "rest"
        return f"{self._exchange_id}-{suffix}"

    # ── Lifecycle ───────────────────────────────────────────────

    def connect(self) -> None:
        if self._connected:
            return

        if self._force_rest:
            self._start_polling()
        else:
            try:
                self._start_websocket()
            except ImportError:
                self.on_error.emit(
                    "ccxt.pro not available; falling back to REST polling"
                )
                self._start_polling()

    def disconnect(self) -> None:
        self._stop_websocket()
        self._stop_polling()
        if self._connected:
            self._connected = False
            self.on_disconnected.emit()

    # ── Subscription ────────────────────────────────────────────

    def subscribe(self, symbol: str) -> None:
        symbol = symbol.upper().replace("-", "/")
        if symbol not in self._symbols:
            self._symbols.append(symbol)

    def unsubscribe(self, symbol: str) -> None:
        symbol = symbol.upper().replace("-", "/")
        if symbol in self._symbols:
            self._symbols.remove(symbol)

    # ── WebSocket mode ──────────────────────────────────────────

    def _start_websocket(self) -> None:
        import ccxt.pro  # noqa: F401 – ensures the module is importable

        if not self._symbols:
            self._symbols.append("BTC/USDT")

        self._ws_worker = _WsWorker(
            exchange_id=self._exchange_id,
            ccxt_config=self._ccxt_config,
            symbols=self._symbols,
            depth=self._depth,
            queue=self._queue,
        )

        # Wire worker signals → our signals (cross-thread safe)
        self._ws_worker.sig_snapshot.connect(self.on_snapshot.emit)
        self._ws_worker.sig_trade.connect(self.on_trade.emit)
        self._ws_worker.sig_bbo.connect(self.on_bbo.emit)
        self._ws_worker.sig_connected.connect(self._on_ws_connected)
        self._ws_worker.sig_disconnected.connect(self._on_ws_disconnected)
        self._ws_worker.sig_error.connect(self.on_error.emit)

        # Move worker to a dedicated thread
        self._ws_thread = QThread(self)
        self._ws_worker.moveToThread(self._ws_thread)
        self._ws_thread.started.connect(self._ws_worker.start)
        self._ws_thread.finished.connect(self._ws_thread.deleteLater)
        self._ws_thread.start()

    def _stop_websocket(self) -> None:
        if self._ws_worker:
            self._ws_worker.stop()
        if self._ws_thread and self._ws_thread.isRunning():
            self._ws_thread.quit()
            self._ws_thread.wait(5000)
        self._ws_thread = None
        self._ws_worker = None

    def _on_ws_connected(self) -> None:
        self._connected = True
        self.on_connected.emit()

    def _on_ws_disconnected(self) -> None:
        self._connected = False
        self.on_disconnected.emit()

    # ── REST polling mode ───────────────────────────────────────

    def _start_polling(self) -> None:
        import ccxt

        ex_cls = getattr(ccxt, self._exchange_id, None)
        if ex_cls is None:
            self.on_error.emit(
                f"Unknown exchange '{self._exchange_id}'"
            )
            return

        self._rest_exchange = ex_cls(self._ccxt_config)
        self._connected = True
        self.on_connected.emit()

        self._poll_timer = QTimer(self)
        self._poll_timer.setInterval(int(self._poll_interval * 1000))
        self._poll_timer.timeout.connect(self._poll_tick)
        self._poll_timer.start()

    def _stop_polling(self) -> None:
        if self._poll_timer:
            self._poll_timer.stop()
            self._poll_timer = None
        self._rest_exchange = None

    def _poll_tick(self) -> None:
        import ccxt

        if not self._symbols:
            return

        symbol = self._symbols[0]
        try:
            # Order book
            ob = self._rest_exchange.fetch_order_book(symbol, self._depth)
            rec_time = time.time()
            snap = _snapshot_from_ccxt(ob, self._depth, rec_time)
            bbo = _bbo_from_ccxt(ob, symbol, rec_time)

            # Trades (REST fallback)
            trades = []
            rec_time_trades = rec_time
            try:
                trades = self._rest_exchange.fetch_trades(symbol, limit=20)
                rec_time_trades = time.time()
            except Exception:
                pass

            if self._queue is not None:
                self._queue.put(("snapshot", snap))
                self._queue.put(("bbo", bbo))
                for trade in _trades_from_ccxt(trades, symbol, rec_time_trades):
                    self._queue.put(("trade", trade))
            else:
                self.on_snapshot.emit(snap)
                self.on_bbo.emit(bbo)
                for trade in _trades_from_ccxt(trades, symbol, rec_time_trades):
                    self.on_trade.emit(trade)

        except (ccxt.NetworkError, ccxt.ExchangeError,
                ccxt.RateLimitExceeded) as exc:
            self.on_error.emit(f"Polling error ({symbol}): {exc}")
        except Exception as exc:
            self.on_error.emit(f"Unexpected polling error: {exc}")
