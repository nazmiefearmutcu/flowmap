"""Crypcodile live bridge: crypto exchange ws streams -> canonical FeedEvents (M1 T9).

:class:`CryptoFeed` implements the :class:`~flowmap_server.feeds.base.Feed`
protocol on top of a crypcodile connector. The moving parts:

- A crypcodile :class:`~crypcodile.exchanges.base.Connector` (built via
  ``make_connector``) + :class:`~crypcodile.ingest.transport.AiohttpWsTransport`
  runs the supervised ws loop (``Connector.run`` reconnects internally with
  backoff; Binance depth streams are sequence-gated through ``OrderBookSync``
  + ``BookResyncBridge``, so only in-order deltas and resync snapshots ever
  reach the sink).
- :class:`_BridgeSink` — the testable translation seam — receives crypcodile
  records, maintains the live L2 book, and emits canonical events:

  ============================  =======================================
  crypcodile record             canonical event
  ============================  =======================================
  ``BookSnapshot``              book replace -> full ``BookState``
                                (plus ``Marker{kind=gap}`` first when the
                                book was already initialized: a snapshot
                                on a live book IS the resync signature)
  ``BookDelta``                 level apply -> full ``BookState``
  ``Trade``                     ``Trade`` (side mapped directly,
                                ``side_src=SIDE_SRC_EXCHANGE``)
  ``BookTicker``                ``BBO``
  ``Liquidation``               ``Marker{kind=liquidation}``
  anything else                 ignored (not in the canonical dialect)
  ============================  =======================================

Book maintenance note (deviation from the plan's "crypcodile ``OrderBook``"):
``OrderBook._check_gap`` re-runs sequence-continuity rules that *spuriously*
fire on the first delta after every Binance snapshot — the exchange contract
is snapshot OVERLAP (first event has ``U <= sid <= u``; ``pu``/``seq``
need not chain from the snapshot id), and post-resync kept deltas bypass the
sync machine entirely. Upstream ``OrderBookSync`` + ``BookResyncBridge`` is
the single sequencing authority, so the sink applies levels with the same
canonical semantics (amount==0 removes, snapshot replaces — mirroring
``OrderBook._apply_levels``) WITHOUT re-checking continuity.

No throttling here: every book change emits a full BookState (top
``BOOK_TOP_N`` levels per side, best-first numpy arrays). Session/Grid own
cadence via time-weighted column integration.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable

import numpy as np

from crypcodile.exchanges.base import Connector
from crypcodile.exchanges.factory import make_connector
from crypcodile.ingest.transport import AiohttpWsTransport, Transport
from crypcodile.instruments.registry import InstrumentRegistry
from crypcodile.schema.enums import Side
from crypcodile.schema.records import (
    BookDelta,
    BookSnapshot,
    BookTicker,
    Level,
    Liquidation,
    Record,
)
from crypcodile.schema.records import Trade as CTrade
from crypcodile.sink.base import Sink

from flowmap_server.config import Config
from flowmap_server.feeds.base import BookState, FeedEvent
from flowmap_server.proto.events import (
    BBO,
    SIDE_BUY,
    SIDE_SELL,
    SIDE_SRC_EXCHANGE,
    SIDE_UNKNOWN,
    Marker,
    Trade,
)

__all__ = ["BOOK_TOP_N", "CRYPTO_MARKETS", "CryptoFeed"]

logger = logging.getLogger(__name__)

# Subscribe.market strings routed to CryptoFeed by the session feed factory.
# "<exchange>-<market>" (market forwarded to the connector, e.g. Binance
# spot vs USD-M futures ws endpoints) or bare "<exchange>".
CRYPTO_MARKETS = frozenset({"binance-spot", "binance-usdm", "okx"})

# Cap per side on emitted BookState arrays; the closest-to-touch levels win.
BOOK_TOP_N = 2000

_SIDE_MAP = {Side.BUY: SIDE_BUY, Side.SELL: SIDE_SELL}


class _FeedEnd:
    """Queue sentinel: the connector task finished (exc=None -> clean end)."""

    __slots__ = ("exc",)

    def __init__(self, exc: BaseException | None) -> None:
        self.exc = exc


class _BridgeSink(Sink):
    """Translate crypcodile records into canonical FeedEvents.

    Maintains the live L2 book as price->size dicts (absolute exchange sizes,
    inherently aggregated per price level). Sequencing is NOT re-checked here
    — see the module docstring. A ``BookSnapshot`` arriving while the book is
    already initialized is the connector's resync signature: emit
    ``Marker{kind=gap}`` first, then snapshot-replace.
    """

    def __init__(self, emit: Callable[[FeedEvent], None]) -> None:
        self._emit = emit
        self._bids: dict[float, float] = {}
        self._asks: dict[float, float] = {}
        self._initialized = False

    async def put(self, record: Record) -> None:
        if isinstance(record, BookDelta):
            if not self._initialized:
                return  # pre-snapshot deltas carry no anchored state
            self._apply_levels(record.bids, self._bids)
            self._apply_levels(record.asks, self._asks)
            self._emit_book(self._ts(record))
        elif isinstance(record, BookSnapshot):
            if self._initialized:
                self._emit(
                    Marker(
                        ts_ns=self._ts(record),
                        kind="gap",
                        text=f"book resync: snapshot seq={record.sequence_id}",
                    )
                )
            self._bids.clear()
            self._asks.clear()
            self._apply_levels(record.bids, self._bids)
            self._apply_levels(record.asks, self._asks)
            self._initialized = True
            self._emit_book(self._ts(record))
        elif isinstance(record, CTrade):
            self._emit(
                Trade(
                    ts_ns=self._ts(record),
                    price=record.price,
                    size=record.amount,
                    side=_SIDE_MAP.get(record.side, SIDE_UNKNOWN),
                    side_src=SIDE_SRC_EXCHANGE,
                    venue=record.exchange,
                )
            )
        elif isinstance(record, BookTicker):
            self._emit(
                BBO(
                    ts_ns=self._ts(record),
                    bid_px=record.bid_px,
                    bid_sz=record.bid_sz,
                    ask_px=record.ask_px,
                    ask_sz=record.ask_sz,
                )
            )
        elif isinstance(record, Liquidation):
            self._emit(
                Marker(
                    ts_ns=self._ts(record),
                    kind="liquidation",
                    text=f"liquidation {record.side} {record.amount:g} @ {record.price:g}",
                    price=record.price,
                    size=record.amount,
                )
            )
        # Funding / DerivativeTicker / OpenInterest / ...: not part of the
        # canonical M1 dialect — dropped silently by design.

    async def flush(self) -> None:
        return None

    @staticmethod
    def _ts(record: Record) -> int:
        ts = record.exchange_ts
        return ts if ts is not None else record.local_ts

    @staticmethod
    def _apply_levels(levels: list[Level], side: dict[float, float]) -> None:
        """Canonical level semantics (mirrors OrderBook._apply_levels):
        amount==0 removes the price level, amount>0 sets the absolute size.
        Malformed levels are skipped, never raised — one bad level must not
        DLQ a whole depth message and silently desync the book."""
        for price, amount in levels:
            if not (price > 0.0) or amount < 0.0 or amount != amount:
                logger.debug("skipping malformed level (%r, %r)", price, amount)
                continue
            if amount == 0.0:
                side.pop(price, None)
            else:
                side[price] = amount

    def _emit_book(self, ts_ns: int) -> None:
        # Best-first, closest-to-touch BOOK_TOP_N levels per side. Sorting
        # ~1000-level dicts at ~10 Hz is negligible; no throttling by design.
        bids = sorted(self._bids.items(), key=lambda kv: -kv[0])[:BOOK_TOP_N]
        asks = sorted(self._asks.items())[:BOOK_TOP_N]
        bid = np.array(bids, dtype=np.float64).reshape(-1, 2)
        ask = np.array(asks, dtype=np.float64).reshape(-1, 2)
        self._emit(
            BookState(
                ts_ns=ts_ns,
                bid_px=bid[:, 0],
                bid_sz=bid[:, 1],
                ask_px=ask[:, 0],
                ask_sz=ask[:, 1],
            )
        )


def _harden_rest_ssl(conn: Connector) -> None:
    """Point the connector's REST path at the certifi CA bundle.

    ``AiohttpWsTransport`` already resolves certifi for the ws leg, but the
    connector's REST helper (`http_get` → lazily-created ClientSession) uses
    the interpreter's default OpenSSL trust store, which on a stock macOS
    framework Python lacks the public roots — the bootstrap/resync depth
    snapshot then fails CERTIFICATE_VERIFY_FAILED while trades stream fine.
    The wrapper pre-seeds ``conn._session`` with a certifi-backed session
    before every ``http_get`` (the run loop closes the session on each
    reconnect cycle, so a one-shot seed would not survive). No-op when
    certifi is unavailable.
    """
    try:
        import ssl

        import certifi

        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:  # pragma: no cover — keep stock behavior without certifi
        return

    orig_http_get = conn.http_get

    async def http_get(
        url: str,
        params: dict[str, object] | None = None,
        max_retries: int = 3,
        timeout_sec: float = 10.0,
    ) -> object:
        import aiohttp

        if conn._session is None or conn._session.closed:
            conn._session = aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(ssl=ctx)
            )
        return await orig_http_get(
            url, params=params, max_retries=max_retries, timeout_sec=timeout_sec
        )

    conn.http_get = http_get  # type: ignore[method-assign]


class CryptoFeed:
    """Live crypto market feed (implements the Feed protocol).

    ``events()`` builds a FRESH connector + transport on every call (Feed
    restart contract: a session-layer restart after a crash or a normal end
    must reconnect and resume LIVE, never replay). While one ``events()``
    iterator is running, crypcodile's own supervision handles ws reconnects
    internally — the stream only ends when the connector task itself
    finishes, and a connector crash re-raises here so the session's backoff
    restart loop owns recovery.
    """

    def __init__(
        self,
        exchange: str,
        symbol: str,
        market: str,
        cfg: Config,
        *,
        connector_factory: Callable[[Sink], Connector] | None = None,
        transport_factory: Callable[[str], Transport] = AiohttpWsTransport,
    ) -> None:
        self.exchange = exchange
        self.symbol = symbol
        self.market = f"{exchange}-{market}" if market else exchange
        self._market_kw = market
        self._cfg = cfg
        self._connector_factory = connector_factory or self._default_connector
        self._transport_factory = transport_factory
        self.capability: dict[str, object] = {
            "depth": "L2",
            "tape": "tick",
            "trade_side": "exchange",
            "markers": ["liquidation", "gap"],
        }

    def _channels(self) -> list[str]:
        channels = ["trade", "book_delta", "book_snapshot", "book_ticker"]
        if self._market_kw in ("usdm", "coinm"):
            # forceOrder liquidations exist on futures only; a spot subscribe
            # would be a dead topic.
            channels.append("liquidation")
        return channels

    def _default_connector(self, sink: Sink) -> Connector:
        kw: dict[str, object] = {}
        if self.exchange == "binance" and self._market_kw:
            kw["market"] = self._market_kw
        conn = make_connector(
            self.exchange,
            symbols=[self.symbol],
            channels=self._channels(),
            out=sink,
            registry=InstrumentRegistry(),
            **kw,
        )
        _harden_rest_ssl(conn)
        return conn

    async def events(self) -> AsyncIterator[FeedEvent]:
        queue: asyncio.Queue[FeedEvent | _FeedEnd] = asyncio.Queue()
        sink = _BridgeSink(queue.put_nowait)
        conn = self._connector_factory(sink)
        if conn.transport is None:
            conn.transport = self._transport_factory(conn.ws_url)
        runner = asyncio.create_task(
            self._drive(conn, queue), name=f"crypto-feed-{self.market}:{self.symbol}"
        )
        try:
            while True:
                ev = await queue.get()
                if isinstance(ev, _FeedEnd):
                    # Sentinel is enqueued strictly after the connector's last
                    # record, so no translated event can be lost behind it.
                    if ev.exc is not None:
                        raise ev.exc
                    return
                yield ev
        finally:
            runner.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await runner

    @staticmethod
    async def _drive(conn: Connector, queue: asyncio.Queue[FeedEvent | _FeedEnd]) -> None:
        try:
            await conn.run()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — forwarded to the consumer
            queue.put_nowait(_FeedEnd(exc))
        else:
            queue.put_nowait(_FeedEnd(None))
