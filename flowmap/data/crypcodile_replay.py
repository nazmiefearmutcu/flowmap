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

import os
import threading
import time
from typing import Iterable, Optional

from PyQt6.QtCore import QObject, QThread, QTimer, pyqtSignal, pyqtSlot

from ..core import Level2Snapshot, Level2Update, Trade, BBO, Side
from .base import DataProvider

# Hard cap for materializing crypcodile replay iterators into RAM (FIND-P239-03).
# Override with env FLOWMAP_REPLAY_MAX_RECORDS; set to 0 for unlimited.
_DEFAULT_REPLAY_MAX_RECORDS = 2_000_000


def _replay_max_records() -> Optional[int]:
    """Resolve materialize cap from ``FLOWMAP_REPLAY_MAX_RECORDS``.

    * Unset / empty → default ``2_000_000``.
    * ``0`` (or negative) → unlimited (``None``).
    * Positive int → that hard cap.
    """
    raw = os.environ.get("FLOWMAP_REPLAY_MAX_RECORDS")
    if raw is None or str(raw).strip() == "":
        return _DEFAULT_REPLAY_MAX_RECORDS
    try:
        n = int(str(raw).strip())
    except ValueError:
        return _DEFAULT_REPLAY_MAX_RECORDS
    if n <= 0:
        return None  # unlimited
    return n


def _consume_iter_capped(
    iterable: Iterable,
    max_records: Optional[int] = None,
) -> tuple[list, bool]:
    """Materialize *iterable* into a list, stopping at *max_records*.

    Parameters
    ----------
    iterable:
        Source records (e.g. crypcodile ``client.replay()`` iterator).
    max_records:
        Hard cap. ``None`` or ``<= 0`` means unlimited (full ``list(iterable)``).

    Returns
    -------
    (items, truncated)
        *items* is the materialized list. *truncated* is True only when the
        cap stopped consumption while more items remained.
    """
    if max_records is None or max_records <= 0:
        return list(iterable), False

    out: list = []
    for i, item in enumerate(iterable):
        if i >= max_records:
            return out, True
        out.append(item)
    return out, False


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
    """Map crypcodile side (enum or string) to flowmap Side.

    Empty/None/unknown → Side.UNKNOWN so CVD does not bias buy or sell
    (FIND-NUM-05 / FIND-P203-03). Known strings: buy/sell/bid/ask.
    """
    if cryp_side is None:
        return Side.UNKNOWN
    val = getattr(cryp_side, "value", cryp_side)
    if isinstance(val, str):
        val = val.lower().strip()
        if not val:
            return Side.UNKNOWN
    elif val is None:
        return Side.UNKNOWN
    return _SIDE_MAP.get(val, Side.UNKNOWN)


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


def _sql_str(value: str) -> str:
    """Quote a SQL string literal; reject embedded quotes/semicolons (FIND-P241)."""
    if value is None:
        raise ValueError("SQL string is None")
    s = str(value)
    if any(c in s for c in (";", "--", "/*", "*/", "\x00")):
        raise ValueError(f"Unsafe SQL identifier/literal: {s!r}")
    # Escape single quotes for SQL
    return "'" + s.replace("'", "''") + "'"


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
    def run_replay(self) -> None:
        """Begin the replay loop using the configured attributes."""
        self.start_replay(self._symbol, self._start_ns, self._end_ns, self._speed)

    @pyqtSlot()
    def start_replay(
        self,
        symbol: str,
        start_ns: int,
        end_ns: int,
        speed: float = 1.0,
    ) -> None:
        """Begin the replay loop (called from owning thread via signal/slot).

        FIND-ERR-01: every early-exit path must clear ``_running`` and emit
        ``sig_finished`` so the provider can reset ``_replaying`` and the UI
        can start again without a stuck worker.
        """
        if not _CRYPCODILE_AVAILABLE:
            self.sig_error.emit(
                f"Crypcodile is not installed: {_CRYPCODILE_IMPORT_ERROR}"
            )
            self._running = False
            self.sig_finished.emit()
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
            self._running = False
            self.sig_finished.emit()
            return

        total_span = end_ns - start_ns
        if total_span <= 0:
            self.sig_error.emit(
                f"Invalid time range: end_ns ({end_ns}) must be > start_ns ({start_ns})"
            )
            self._running = False
            self.sig_finished.emit()
            return

        # Get trade min/max to shift them
        trade_min = None
        trade_max = None
        try:
            df_t = self._client.query(
                "SELECT MIN(local_ts), MAX(local_ts) FROM trade WHERE symbol = " + _sql_str(symbol)
            )
            if df_t is not None and len(df_t) > 0:
                trade_min = df_t.row(0)[0]
                trade_max = df_t.row(0)[1]
        except Exception as e:
            print(f"[REPLAY_WORKER] Error checking trade range: {e}")

        class MappedRecord:
            def __init__(self, record, mapped_ts, price_shift=0.0, original_trend=0.0):
                self._record = record
                self.local_ts = mapped_ts
                self.price_shift = price_shift
                self.original_trend = original_trend
            
            @property
            def price(self):
                return getattr(self._record, "price", 0.0) + self.price_shift
            
            def __getattr__(self, name):
                return getattr(self._record, name)

        # Get average prices to align trade prices to book prices
        price_shift = 0.0
        try:
            df_tp = self._client.query(
                "SELECT AVG(price) FROM trade WHERE symbol = " + _sql_str(symbol)
            )
            df_bp = self._client.query(
                "SELECT AVG(b.price) FROM (SELECT unnest(bids) as b FROM book_delta WHERE symbol = "
                + _sql_str(symbol)
                + ")"
            )
            if df_tp is not None and len(df_tp) > 0 and df_bp is not None and len(df_bp) > 0:
                tp_val = df_tp.row(0)[0]
                bp_val = df_bp.row(0)[0]
                if tp_val is not None and bp_val is not None:
                    price_shift = float(bp_val) - float(tp_val)
                    print(f"[REPLAY_WORKER] Aligning trade prices by shift: {price_shift:.4f}")
        except Exception as e:
            print(f"[REPLAY_WORKER] Price alignment calculation error: {e}")

        try:
            max_records = _replay_max_records()
            while self._running:
                # 1. Fetch book records (capped materialize — FIND-P239-03)
                try:
                    book_iter = self._client.replay(
                        channels=["book_snapshot", "book_delta", "book_ticker"],
                        symbols=[symbol],
                        frm=start_ns,
                        to=end_ns,
                        limit=None,
                    )
                    records, book_truncated = _consume_iter_capped(
                        book_iter, max_records
                    )
                    if book_truncated:
                        msg = f"Replay truncated at {max_records} records"
                        print(f"[REPLAY_WORKER] {msg} (book)")
                        self.sig_error.emit(msg)
                except Exception as exc:
                    self.sig_error.emit(f"Failed to start book replay: {exc}")
                    break

                # 2. Fetch trade records (trade, liquidation)
                if trade_min is not None and trade_max is not None:
                    try:
                        trade_iter = self._client.replay(
                            channels=["trade", "liquidation"],
                            symbols=[symbol],
                            frm=trade_min,
                            to=trade_max,
                            limit=None,
                        )
                        raw_trades, trade_truncated = _consume_iter_capped(
                            trade_iter, max_records
                        )
                        if trade_truncated:
                            msg = f"Replay truncated at {max_records} records"
                            print(f"[REPLAY_WORKER] {msg} (trade)")
                            self.sig_error.emit(msg)
                        
                        if raw_trades:
                            raw_trades.sort(key=lambda r: r.local_ts)
                            # Compute original trade EMA trend
                            ema = None
                            alpha = 0.05
                            trade_trends = {}
                            for rec in raw_trades:
                                p = getattr(rec, "price", 0.0)
                                if ema is None:
                                    ema = p
                                else:
                                    ema = alpha * p + (1.0 - alpha) * ema
                                trade_trends[rec.id] = ema

                            raw_trade_ts = [r.local_ts for r in raw_trades]
                            t_min_actual = min(raw_trade_ts)
                            t_max_actual = max(raw_trade_ts)
                            t_span = t_max_actual - t_min_actual
                            book_span = end_ns - start_ns
                            
                            # Time-warp (stretch trade timeline onto book window) is OFF
                            # by default — it invents timestamps (FIND-P239-01).
                            # Enable with FLOWMAP_REPLAY_TIME_WARP=1.
                            import os as _os_tw
                            do_warp = _os_tw.environ.get("FLOWMAP_REPLAY_TIME_WARP", "").strip() in (
                                "1", "true", "TRUE", "yes",
                            )
                            scale_factor = book_span / t_span if t_span > 0 else 1.0
                            for rec in raw_trades:
                                if do_warp:
                                    mapped_ts = int(
                                        start_ns + (rec.local_ts - t_min_actual) * scale_factor
                                    )
                                else:
                                    # Keep native trade timestamps (may fall outside book window)
                                    mapped_ts = int(rec.local_ts)
                                trend = trade_trends.get(rec.id, getattr(rec, "price", 0.0))
                                records.append(MappedRecord(rec, mapped_ts, price_shift, trend))
                    except Exception as exc:
                        print(f"[REPLAY_WORKER] Error loading trades: {exc}")

                # 3. Sort merged records by local_ts
                records.sort(key=lambda r: r.local_ts)

                # 3.5 Dynamic Price Alignment Pass
                class LocalBookTracker:
                    def __init__(self):
                        self.bids = {}
                        self.asks = {}
                    
                    def apply_snapshot(self, bids, asks):
                        self.bids = {float(p): float(s) for p, s in bids if s > 0}
                        self.asks = {float(p): float(s) for p, s in asks if s > 0}
                        
                    def apply_delta(self, bids_delta, asks_delta):
                        for p, s in bids_delta:
                            p_f = float(p)
                            s_f = float(s)
                            if s_f <= 0.000001:
                                self.bids.pop(p_f, None)
                            else:
                                self.bids[p_f] = s_f
                        for p, s in asks_delta:
                            p_f = float(p)
                            s_f = float(s)
                            if s_f <= 0.000001:
                                self.asks.pop(p_f, None)
                            else:
                                self.asks[p_f] = s_f
                                
                    def get_mid(self) -> Optional[float]:
                        best_bid = max(self.bids.keys()) if self.bids else None
                        best_ask = min(self.asks.keys()) if self.asks else None
                        if best_bid is not None and best_ask is not None:
                            return (best_bid + best_ask) / 2.0
                        return None

                local_book = LocalBookTracker()
                last_known_mid = None
                
                # Check the first snapshot to bootstrap the book
                for rec in records:
                    channel = getattr(rec, "__struct_config__", None)
                    tag = channel.tag if channel else getattr(type(rec), "channel", None)
                    if tag == "book_snapshot" or (tag == "book_delta" and getattr(rec, "is_snapshot", False)):
                        local_book.apply_snapshot(rec.bids, rec.asks)
                        mid = local_book.get_mid()
                        if mid is not None:
                            last_known_mid = mid

                # Pass to align trade prices
                aligned_count = 0
                for rec in records:
                    channel = getattr(rec, "__struct_config__", None)
                    tag = channel.tag if channel else getattr(type(rec), "channel", None)
                    
                    if tag == "book_snapshot" or (tag == "book_delta" and getattr(rec, "is_snapshot", False)):
                        local_book.apply_snapshot(rec.bids, rec.asks)
                        mid = local_book.get_mid()
                        if mid is not None:
                            last_known_mid = mid
                    elif tag == "book_delta":
                        local_book.apply_delta(rec.bids, rec.asks)
                        mid = local_book.get_mid()
                        if mid is not None:
                            last_known_mid = mid
                    elif isinstance(rec, MappedRecord):
                        # It is a trade record!
                        target_price = None
                        side_str = getattr(rec._record, "side", "").lower() if hasattr(rec, "_record") else ""
                        if "buy" in side_str:
                            if local_book.asks:
                                target_price = min(local_book.asks.keys())
                        elif "sell" in side_str:
                            if local_book.bids:
                                target_price = max(local_book.bids.keys())
                        
                        if target_price is None:
                            target_price = last_known_mid

                        if target_price is not None:
                            # Align trade price to current BBO/mid
                            rec.price_shift = target_price - getattr(rec._record, "price", 0.0)
                            aligned_count += 1
                        else:
                            # Fallback to static price shift
                            rec.price_shift = price_shift

                # Dynamic BBO rewrite of trade prices is OFF by default — it
                # invents fills at BBO and destroys fidelity (FIND-P240).
                # Enable only with FLOWMAP_REPLAY_REWRITE_PRICES=1.
                import os as _os
                if _os.environ.get("FLOWMAP_REPLAY_REWRITE_PRICES", "").strip() in (
                    "1", "true", "TRUE", "yes",
                ):
                    print(
                        f"[REPLAY_WORKER] Dynamic price alignment ON "
                        f"(dev). Aligned {aligned_count} trades to BBO."
                    )
                else:
                    # Clear any shifts applied above so raw trade prices play
                    for rec in records:
                        if isinstance(rec, MappedRecord):
                            rec.price_shift = getattr(rec, "price_shift", 0.0) * 0.0
                            # Keep static AVG shift only if it was pre-set on MappedRecord
                            # and env FLOWMAP_REPLAY_STATIC_SHIFT=1
                            if _os.environ.get("FLOWMAP_REPLAY_STATIC_SHIFT", "").strip() not in (
                                "1", "true", "TRUE", "yes",
                            ):
                                rec.price_shift = 0.0
                    print(
                        "[REPLAY_WORKER] Trade price rewrite disabled "
                        "(set FLOWMAP_REPLAY_REWRITE_PRICES=1 to enable)."
                    )

                prev_ts_ns = None
                for idx, rec in enumerate(records):
                    # Yield GIL to prevent GUI thread starvation
                    if idx % 100 == 0:
                        time.sleep(0.001)

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

                if self._running:
                    if not records:
                        # Empty window: back off so we don't spin the CPU (FIND-P219-03)
                        print("[REPLAY_WORKER] No records in window; sleeping 2s before retry...")
                        time.sleep(2.0)
                    else:
                        print("[REPLAY_WORKER] Replay finished, auto-looping/restarting from beginning...")
                    prev_ts_ns = None

        except Exception as exc:
            self.sig_error.emit(f"Replay error: {exc}")
        finally:
            self._running = False
            self.sig_finished.emit()

    @pyqtSlot(float)
    def set_speed(self, speed: float) -> None:
        """Dynamically update the replay speed."""
        self._speed = speed

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
    sig_set_speed = pyqtSignal(float)

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
        self.sig_set_speed.connect(self._worker.set_speed)

        # Move worker to a dedicated thread
        self._thread = QThread(self)
        self._worker.moveToThread(self._thread)
        
        # Configure params on worker before start
        self._worker._symbol = symbol
        self._worker._start_ns = start_ns
        self._worker._end_ns = end_ns
        self._worker._speed = speed

        self._thread.started.connect(self._worker.run_replay)
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

    def set_speed(self, speed: float) -> None:
        """Update playback speed dynamically."""
        self.sig_set_speed.emit(speed)

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

        # First, find min_ns from book tables to ensure we have book data immediately
        book_tables = [t for t in ["book_snapshot", "book_delta"] if t in registered]
        min_search_tables = book_tables if book_tables else [t for t in ["trade"] if t in registered]

        for table in min_search_tables:
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
                for date in sorted_dates:
                    df = client.query(
                        f"SELECT MIN(local_ts) FROM {table} WHERE date = "
                        + _sql_str(date)
                        + " AND symbol = "
                        + _sql_str(symbol)
                    )
                    if df is not None and len(df) > 0:
                        val = df.row(0)[0]
                        if val is not None:
                            t_min = int(val)
                            if min_ns is None or t_min < min_ns:
                                min_ns = t_min
                            break
            except Exception:
                pass

        # If min_ns is still None, fallback to trade table
        if min_ns is None and "trade" in registered:
            try:
                pattern = os.path.join(data_dir, "exchange=*", "channel=trade", "date=*")
                date_paths = glob.glob(pattern)
                if date_paths:
                    dates = []
                    for p in date_paths:
                        parts = os.path.basename(p).split("=")
                        if len(parts) == 2 and parts[0] == "date":
                            dates.append(parts[1])
                    if dates:
                        sorted_dates = sorted(list(set(dates)))
                        for date in sorted_dates:
                            df = client.query(
                                "SELECT MIN(local_ts) FROM trade WHERE date = "
                                + _sql_str(date)
                                + " AND symbol = "
                                + _sql_str(symbol)
                            )
                            if df is not None and len(df) > 0:
                                val = df.row(0)[0]
                                if val is not None:
                                    min_ns = int(val)
                                    break
            except Exception:
                pass

        # Find max_ns from all tables
        max_search_tables = [t for t in ["trade", "book_snapshot", "book_delta"] if t in registered]
        for table in max_search_tables:
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
                for date in reversed(sorted_dates):
                    df = client.query(
                        f"SELECT MAX(local_ts) FROM {table} WHERE date = "
                        + _sql_str(date)
                        + " AND symbol = "
                        + _sql_str(symbol)
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
        channels = [c for c in ["trade", "book_snapshot", "book_ticker", "book_delta"] if c in registered]
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
        self.disconnect()

