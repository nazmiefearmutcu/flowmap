"""
CrypcodileReplayProvider — bridges Crypcodile's historical data lake
to FlowMap's real-time heatmap via asynchronous replay.

Iterates historical Records from CrypcodileClient.replay() inside a
background QThread worker, converts them to FlowMap core types, and
emits them through the standard DataProvider signal interface with
configurable playback speed.

Usage::

    provider = CrypcodileReplayProvider(data_dir="/data/crypcodile")
    symbols = provider.load_symbols("/data/crypcodile")
    provider.start_replay("deribit:BTC-PERPETUAL", start_ns, end_ns, speed=1.0)
"""

from __future__ import annotations

import threading
import time
from typing import Optional

from PyQt6.QtCore import QObject, QThread, QTimer, pyqtSignal, pyqtSlot

from ..core import Level2Snapshot, Level2Update, Trade, BBO, Side
from .base import DataProvider

# ── Optional crypcodile imports ──────────────────────────────────────────────

try:
    from crypcodile.client.client import CrypcodileClient
    from crypcodile.schema.records import (
        Trade as _CrypTrade,
        BookSnapshot as _CrypBookSnapshot,
        BookDelta as _CrypBookDelta,
        BookTicker as _CrypBookTicker,
        Liquidation as _CrypLiquidation,
        Record,
    )
    from crypcodile.schema.enums import Side as _CrypSide
    _CRYPCODILE_AVAILABLE = True
except ImportError as _import_error:
    _CRYPCODILE_AVAILABLE = False
    _CRYPCODILE_IMPORT_ERROR = str(_import_error)
    CrypcodileClient = None  # type: ignore[assignment]
    _CrypTrade = None
    _CrypBookSnapshot = None
    _CrypBookDelta = None
    _CrypBookTicker = None
    _CrypLiquidation = None
    _CrypSide = None


# ── Conversion helpers ───────────────────────────────────────────────────────

# Map crypcodile Side enum values to flowmap Side enum
_SIDE_MAP = {
    "buy": Side.BUY,
    "sell": Side.SELL,
    "bid": Side.BID,
    "ask": Side.ASK,
}

# Reverse map for BookDelta → Level2Update
_CRYP_SIDE_TO_FLOWMAP_SIDE = {
    "buy": Side.BID,
    "sell": Side.ASK,
}


def _ns_to_seconds(ns: int) -> float:
    """Convert nanosecond UTC timestamp to float seconds for FlowMap types."""
    return ns / 1_000_000_000.0


def _get_flowmap_side(cryp_side) -> Side:
    """Safely map a crypcodile side (enum or string) to flowmap Side enum."""
    if cryp_side is None:
        return Side.BUY
    val = getattr(cryp_side, "value", cryp_side)
    if isinstance(val, str):
        val = val.lower()
    return _SIDE_MAP.get(val, Side.BUY)


def _cryp_trade_to_flowmap(rec: _CrypTrade) -> Trade:
    """Convert a crypcodile Trade record to a flowmap Trade."""
    is_liq = False
    if hasattr(rec, "liquidation") and rec.liquidation is not None:
        is_liq = True
    return Trade(
        timestamp=_ns_to_seconds(rec.local_ts),
        symbol=rec.symbol,
        price=rec.price,
        size=rec.amount,
        side=_get_flowmap_side(rec.side),
        trade_id=rec.id or None,
        is_liquidation=is_liq,
    )


def _cryp_liquidation_to_flowmap(rec: _CrypLiquidation) -> Trade:
    """Convert a crypcodile Liquidation record to a flowmap Trade marked as liquidation."""
    return Trade(
        timestamp=_ns_to_seconds(rec.local_ts),
        symbol=rec.symbol,
        price=rec.price,
        size=rec.amount,
        side=_get_flowmap_side(rec.side),
        trade_id=rec.id or None,
        is_liquidation=True,
    )


def _cryp_book_snapshot_to_flowmap(rec: _CrypBookSnapshot) -> Level2Snapshot:
    """Convert a crypcodile BookSnapshot to a flowmap Level2Snapshot."""
    bids = tuple((float(p), float(s)) for (p, s) in rec.bids if s > 0)
    asks = tuple((float(p), float(s)) for (p, s) in rec.asks if s > 0)
    return Level2Snapshot(
        timestamp=_ns_to_seconds(rec.local_ts),
        symbol=rec.symbol,
        bids=bids,
        asks=asks,
        bid_depth=len(bids),
        ask_depth=len(asks),
    )


def _cryp_book_delta_to_flowmap_updates(
    rec: _CrypBookDelta,
) -> list[Level2Update]:
    """Convert a crypcodile BookDelta to one or more flowmap Level2Update objects.

    A BookDelta may contain multiple bid and ask price-level changes.
    Each level is emitted as an individual Level2Update.
    An amount of 0.0 signals removal of that price level.
    """
    ts = _ns_to_seconds(rec.local_ts)
    updates: list[Level2Update] = []

    for price, size in rec.bids:
        updates.append(Level2Update(
            timestamp=ts,
            symbol=rec.symbol,
            side=Side.BID,
            price=float(price),
            size=float(size),
        ))

    for price, size in rec.asks:
        updates.append(Level2Update(
            timestamp=ts,
            symbol=rec.symbol,
            side=Side.ASK,
            price=float(price),
            size=float(size),
        ))

    return updates


def _cryp_book_ticker_to_flowmap(rec: _CrypBookTicker) -> BBO:
    """Convert a crypcodile BookTicker to a flowmap BBO."""
    return BBO(
        timestamp=_ns_to_seconds(rec.local_ts),
        symbol=rec.symbol,
        bid=rec.bid_px,
        ask=rec.ask_px,
        bid_size=rec.bid_sz,
        ask_size=rec.ask_sz,
    )


def _dispatch_record(rec: Record):
    """Return the appropriate flowmap object(s) for a crypcodile Record.

    Returns a list of flowmap objects (Level2Snapshot, Level2Update, Trade, BBO)
    that should be emitted for this record.  Unknown record types are silently
    skipped (empty list).
    """
    channel = getattr(rec, "__struct_config__", None)
    tag = channel.tag if channel else getattr(type(rec), "channel", None)

    if tag == "trade":
        return [_cryp_trade_to_flowmap(rec)]
    elif tag == "book_snapshot":
        return [_cryp_book_snapshot_to_flowmap(rec)]
    elif tag == "book_delta":
        if getattr(rec, "is_snapshot", False):
            # Treat snapshot book deltas as actual full snapshots to avoid state drift
            bids = tuple((float(p), float(s)) for (p, s) in rec.bids if s > 0)
            asks = tuple((float(p), float(s)) for (p, s) in rec.asks if s > 0)
            return [Level2Snapshot(
                timestamp=_ns_to_seconds(rec.local_ts),
                symbol=rec.symbol,
                bids=bids,
                asks=asks,
                bid_depth=len(bids),
                ask_depth=len(asks),
            )]
        return _cryp_book_delta_to_flowmap_updates(rec)
    elif tag == "book_ticker":
        return [_cryp_book_ticker_to_flowmap(rec)]
    elif tag == "liquidation":
        return [_cryp_liquidation_to_flowmap(rec)]
    else:
        # Silently skip channels we don't map (funding, etc.)
        return []


# ── Replay worker (runs in a background QThread) ─────────────────────────────

class _ReplayWorker(QObject):
    """Runs the blocking CrypcodileClient.replay() iterator in a dedicated thread.

    Emits flowmap-typed signals that the main-thread provider re-emits through
    the DataProvider interface.  Uses threading primitives for pause/resume
    control.
    """

    # ── Signals (emitted from worker thread; Qt queues them to main thread) ──
    sig_snapshot = pyqtSignal(object)   # Level2Snapshot
    sig_update = pyqtSignal(object)     # Level2Update
    sig_trade = pyqtSignal(object)      # Trade
    sig_bbo = pyqtSignal(object)        # BBO
    sig_progress = pyqtSignal(float)    # 0.0 → 1.0
    sig_finished = pyqtSignal()
    sig_error = pyqtSignal(str)

    def __init__(self, data_dir: str, queue=None, parent: QObject = None) -> None:
        super().__init__(parent)
        self._data_dir = data_dir
        self._queue = queue
        self._client: Optional[CrypcodileClient] = None
        self._running = False
        self._paused = False
        self._pause_event = threading.Event()
        self._pause_event.set()  # Unpaused initially
        self._speed: float = 1.0
        self._symbol: str = ""
        self._start_ns: int = 0
        self._end_ns: int = 0
        self._channels: list[str] = [
            "trade", "book_snapshot", "book_delta", "book_ticker", "liquidation",
        ]

    @pyqtSlot()
    def start_replay(
        self,
        symbol: str,
        start_ns: int,
        end_ns: int,
        speed: float = 1.0,
    ) -> None:
        """Begin the replay loop (called from owning thread via signal/slot)."""
        if not _CRYPCODILE_AVAILABLE:
            self.sig_error.emit(
                f"Crypcodile is not installed: {_CRYPCODILE_IMPORT_ERROR}"
            )
            return

        self._symbol = symbol
        self._start_ns = start_ns
        self._end_ns = end_ns
        self._speed = speed
        self._running = True
        self._paused = False
        self._pause_event.set()

        try:
            self._client = CrypcodileClient(data_dir=self._data_dir)
        except Exception as exc:
            self.sig_error.emit(f"Failed to open CrypcodileClient: {exc}")
            return

        total_span = end_ns - start_ns
        if total_span <= 0:
            self.sig_error.emit(
                f"Invalid time range: end_ns ({end_ns}) must be > start_ns ({start_ns})"
            )
            self._running = False
            self.sig_finished.emit()
            return

        # Use a large but bounded record iterator — the caller can stop() early.
        try:
            record_iter = self._client.replay(
                channels=self._channels,
                symbols=[symbol],
                frm=start_ns,
                to=end_ns,
                limit=None,
            )
        except Exception as exc:
            self.sig_error.emit(f"Failed to start replay: {exc}")
            self._running = False
            self.sig_finished.emit()
            return

        prev_ts_ns: Optional[int] = None

        try:
            for rec in record_iter:
                # ── Honour stop ──
                if not self._running:
                    break

                # ── Honour pause ──
                self._pause_event.wait()

                if not self._running:
                    break

                current_ns: int = rec.local_ts

                # ── Speed-controlled sleep ──
                if prev_ts_ns is not None and self._speed > 0:
                    delta_ns = current_ns - prev_ts_ns
                    if delta_ns > 0:
                        sleep_sec = (delta_ns / 1_000_000_000.0) / self._speed
                        # Cap sleep to avoid huge gaps freezing the UI
                        sleep_sec = min(sleep_sec, 5.0)
                        # Use small sleep chunks so we respond to pause/stop faster
                        while sleep_sec > 0 and self._running and self._pause_event.is_set():
                            chunk = min(sleep_sec, 0.1)
                            time.sleep(chunk)
                            sleep_sec -= chunk

                if not self._running:
                    break

                # ── Dispatch to flowmap types and emit ──
                flow_objects = _dispatch_record(rec)
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

                # ── Progress ──
                if total_span > 0:
                    progress = (current_ns - start_ns) / total_span
                    self.sig_progress.emit(max(0.0, min(1.0, progress)))

                prev_ts_ns = current_ns

        except Exception as exc:
            self.sig_error.emit(f"Replay error: {exc}")
        finally:
            self._running = False
            self.sig_finished.emit()

    @pyqtSlot()
    def stop(self) -> None:
        """Request the replay loop to stop."""
        self._running = False
        self._pause_event.set()  # Unblock any paused wait

    @pyqtSlot()
    def pause(self) -> None:
        """Pause the replay."""
        self._paused = True
        self._pause_event.clear()

    @pyqtSlot()
    def resume(self) -> None:
        """Resume a paused replay."""
        self._paused = False
        self._pause_event.set()


# ── Public DataProvider ──────────────────────────────────────────────────────

class CrypcodileReplayProvider(DataProvider):
    """Replays historical Crypcodile data through FlowMap's real-time interface.

    Parameters
    ----------
    data_dir : str
        Root directory of the Crypcodile data lake (same path passed to
        ``ParquetSink`` / ``CrypcodileClient``).
    parent : QObject, optional
        Parent QObject for ownership/lifetime management.

    Signals
    -------
    replay_progress : pyqtSignal(float)
        Emitted during replay with a value from 0.0 (start) to 1.0 (end).
    """

    replay_progress = pyqtSignal(float)

    def __init__(self, data_dir: str, queue=None, parent: QObject = None) -> None:
        super().__init__(parent)
        self._data_dir = data_dir
        self._queue = queue

        # Worker & thread
        self._worker: Optional[_ReplayWorker] = None
        self._thread: Optional[QThread] = None

        # Replay state
        self._replaying = False
        self._paused = False

    # ── Properties ──────────────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return "crypcodile-replay"

    @property
    def is_replaying(self) -> bool:
        return self._replaying

    @property
    def is_paused(self) -> bool:
        return self._paused

    # ── Lifecycle ────────────────────────────────────────────────────────────

    def connect(self) -> None:
        """Connect to the Crypcodile data lake (lightweight — opens the catalog)."""
        if self._connected:
            return

        if not _CRYPCODILE_AVAILABLE:
            self.on_error.emit(
                f"Crypcodile is not installed: {_CRYPCODILE_IMPORT_ERROR}. "
                f"Install it with: pip install crypcodile"
            )
            return

        self._connected = True
        self.on_connected.emit()

    def disconnect(self) -> None:
        """Disconnect and stop any active replay."""
        self.stop_replay()
        if self._connected:
            self._connected = False
            self.on_disconnected.emit()

    # ── Subscription ─────────────────────────────────────────────────────────

    def subscribe(self, symbol: str) -> None:
        """Register *symbol* for replay (only one symbol replayed at a time)."""
        if symbol not in self._symbols:
            self._symbols.append(symbol)

    def unsubscribe(self, symbol: str) -> None:
        """Remove *symbol* from the subscribed list."""
        if symbol in self._symbols:
            self._symbols.remove(symbol)

    # ── Replay control ───────────────────────────────────────────────────────

    def start_replay(
        self,
        symbol: str,
        start_ns: int,
        end_ns: int,
        speed: float = 1.0,
    ) -> None:
        """Begin asynchronous replay of historical data for *symbol*.

        Parameters
        ----------
        symbol : str
            Canonical Crypcodile symbol (e.g. ``"deribit:BTC-PERPETUAL"``).
        start_ns : int
            Inclusive start time in nanoseconds UTC.
        end_ns : int
            Inclusive end time in nanoseconds UTC.
        speed : float
            Playback speed multiplier:
            - 1.0 = real-time (respects inter-record timestamps)
            - 2.0 = 2× speed
            - 0   = as-fast-as-possible (no sleeps between records)
        """
        if self._replaying:
            self.stop_replay()

        if not _CRYPCODILE_AVAILABLE:
            self.on_error.emit(
                f"Crypcodile is not installed: {_CRYPCODILE_IMPORT_ERROR}"
            )
            return

        self._symbols = [symbol]
        self._replaying = True
        self._paused = False

        # Create worker and thread
        self._worker = _ReplayWorker(data_dir=self._data_dir, queue=self._queue)

        # Wire worker signals → our signals (cross-thread safe, auto-queued)
        self._worker.sig_snapshot.connect(self.on_snapshot.emit)
        self._worker.sig_update.connect(self.on_update.emit)
        self._worker.sig_trade.connect(self.on_trade.emit)
        self._worker.sig_bbo.connect(self.on_bbo.emit)
        self._worker.sig_progress.connect(self.replay_progress.emit)
        self._worker.sig_finished.connect(self._on_replay_finished)
        self._worker.sig_error.connect(self.on_error.emit)

        # Move worker to a dedicated thread
        self._thread = QThread(self)
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(
            lambda: self._worker.start_replay(symbol, start_ns, end_ns, speed)
        )
        self._thread.finished.connect(self._thread.deleteLater)
        self._thread.start()

    def stop_replay(self) -> None:
        """Stop the active replay and clean up resources."""
        if self._worker:
            self._worker.stop()

        if self._thread and self._thread.isRunning():
            self._thread.quit()
            self._thread.wait(5000)

        self._worker = None
        self._thread = None
        self._replaying = False
        self._paused = False

    def pause(self) -> None:
        """Pause the currently running replay."""
        if self._worker and self._replaying and not self._paused:
            self._worker.pause()
            self._paused = True

    def resume(self) -> None:
        """Resume a paused replay."""
        if self._worker and self._paused:
            self._worker.resume()
            self._paused = False

    # ── Static helpers ───────────────────────────────────────────────────────

    @staticmethod
    def get_time_range(data_dir: str, symbol: str) -> tuple[Optional[int], Optional[int]]:
        """Scan available channels to find the available time range (min and max local_ts) for a symbol.

        Parameters
        ----------
        data_dir : str
            Root directory of the Crypcodile data lake.
        symbol : str
            Canonical symbol.

        Returns
        -------
        tuple of (min_ns, max_ns) or (None, None)
        """
        if not _CRYPCODILE_AVAILABLE:
            return None, None

        import glob
        import os

        try:
            client = CrypcodileClient(data_dir=data_dir)
        except Exception:
            return None, None

        try:
            df_tables = client.query("SHOW TABLES")
            registered = set(df_tables["name"].to_list())
        except Exception:
            registered = set()

        min_ns: Optional[int] = None
        max_ns: Optional[int] = None

        for table in ["trade", "book_snapshot", "book_delta"]:
            if table not in registered:
                continue
            try:
                pattern = os.path.join(data_dir, "exchange=*", f"channel={table}", "date=*")
                date_paths = glob.glob(pattern)
                if not date_paths:
                    continue

                dates = []
                for p in date_paths:
                    parts = os.path.basename(p).split("=")
                    if len(parts) == 2 and parts[0] == "date":
                        dates.append(parts[1])

                if not dates:
                    continue

                sorted_dates = sorted(list(set(dates)))

                if len(sorted_dates) == 1:
                    df = client.query(
                        f"SELECT MIN(local_ts), MAX(local_ts) FROM {table} WHERE date = '{sorted_dates[0]}' AND symbol = '{symbol}'"
                    )
                    if df is not None and len(df) > 0:
                        row = df.row(0)
                        if row and row[0] is not None and row[1] is not None:
                            t_min, t_max = int(row[0]), int(row[1])
                            if min_ns is None or t_min < min_ns:
                                min_ns = t_min
                            if max_ns is None or t_max > max_ns:
                                max_ns = t_max
                else:
                    # Find MIN local_ts
                    for date in sorted_dates:
                        df = client.query(
                            f"SELECT MIN(local_ts) FROM {table} WHERE date = '{date}' AND symbol = '{symbol}'"
                        )
                        if df is not None and len(df) > 0:
                            val = df.row(0)[0]
                            if val is not None:
                                t_min = int(val)
                                if min_ns is None or t_min < min_ns:
                                    min_ns = t_min
                                break

                    # Find MAX local_ts
                    for date in reversed(sorted_dates):
                        df = client.query(
                            f"SELECT MAX(local_ts) FROM {table} WHERE date = '{date}' AND symbol = '{symbol}'"
                        )
                        if df is not None and len(df) > 0:
                            val = df.row(0)[0]
                            if val is not None:
                                t_max = int(val)
                                if max_ns is None or t_max > max_ns:
                                    max_ns = t_max
                                break
            except Exception:
                pass
        return min_ns, max_ns

    @staticmethod
    def load_symbols(data_dir: str) -> list[str]:
        """Scan the Crypcodile data lake and return available symbols.

        Queries the DuckDB catalog for distinct symbols across all channels.
        Returns an empty list if no data is present or crypcodile is unavailable.

        Parameters
        ----------
        data_dir : str
            Root directory of the Crypcodile data lake.

        Returns
        -------
        list[str]
            Sorted list of canonical symbol strings.
        """
        if not _CRYPCODILE_AVAILABLE:
            return []

        import glob
        import os

        try:
            client = CrypcodileClient(data_dir=data_dir)
        except Exception:
            return []

        try:
            df_tables = client.query("SHOW TABLES")
            registered = set(df_tables["name"].to_list())
        except Exception:
            registered = set()

        # Query distinct symbols across the main data channels that actually exist
        channels = [c for c in ["trade", "book_snapshot", "book_ticker"] if c in registered]
        symbols: set[str] = set()

        for channel in channels:
            try:
                pattern = os.path.join(data_dir, "exchange=*", f"channel={channel}", "date=*")
                date_paths = glob.glob(pattern)
                if not date_paths:
                    continue

                dates = []
                for p in date_paths:
                    parts = os.path.basename(p).split("=")
                    if len(parts) == 2 and parts[0] == "date":
                        dates.append(parts[1])

                if not dates:
                    continue

                # Query the latest date partition (extremely fast due to partition pruning)
                latest_date = max(dates)
                df = client.query(
                    f"SELECT DISTINCT symbol FROM {channel} WHERE date = '{latest_date}' LIMIT 1000"
                )
                if df is not None and len(df) > 0:
                    for sym in df["symbol"].to_list():
                        symbols.add(str(sym))

                # Fallback if no symbols found on the latest date
                if not symbols:
                    df = client.query(
                        f"SELECT DISTINCT symbol FROM {channel} LIMIT 1000"
                    )
                    if df is not None and len(df) > 0:
                        for sym in df["symbol"].to_list():
                            symbols.add(str(sym))
            except Exception:
                pass

        return sorted(symbols)

    # ── Internal slots ───────────────────────────────────────────────────────

    def _on_replay_finished(self) -> None:
        """Called when the replay worker finishes (natural end or stop)."""
        self._replaying = False
        self._paused = False
