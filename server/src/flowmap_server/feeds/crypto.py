"""Crocodile live bridge: crypto venue streams -> canonical FeedEvents (M1 T9).

:class:`CryptoFeed` implements the :class:`~flowmap_server.feeds.base.Feed`
protocol on top of a Crocodile connector. The moving parts:

- A :class:`~crocodile.core.connector.Connector` (built via ``make_connector``)
  + :class:`~crocodile.core.ingest.transport.AiohttpWsTransport` runs the
  supervised ws loop (``Connector.run`` reconnects internally with backoff;
  Binance depth streams are sequence-gated through ``OrderBookSync`` +
  ``BookResyncBridge``, so only in-order deltas and resync snapshots ever
  reach the sink).

  Five of the streamable venues have hand-written connectors (binance, bybit,
  coinbase, deribit, okx); every other ccxt venue id falls through to the
  universal ccxt connector, which re-reads the whole book each tick instead of
  streaming diffs. That difference is carried honestly in
  ``capability["depth"]`` (``L2`` vs ``L2-snapshot``) rather than hidden — see
  :attr:`CryptoFeed.native`. The engine has ten hand-written connectors; the
  other five are not order-flow readers at all (see ``NOT_STREAMABLE``).
- :class:`_BridgeSink` — the testable translation seam — receives Crocodile
  records, maintains the live L2 book, and emits canonical events:

  ============================  =======================================
  Crocodile record              canonical event
  ============================  =======================================
  ``BookSnapshot``              book replace -> full ``BookState``
                                (on a delta venue, plus ``Marker{kind=gap}``
                                first when the book was already initialized:
                                a snapshot on a live book IS the resync
                                signature. On a snapshot-driven venue it is
                                simply the next update — no marker.)
  ``BookDelta``                 level apply -> full ``BookState``
  ``Trade``                     ``Trade`` (venue-published side ->
                                ``side_src=SIDE_SRC_EXCHANGE``; a record whose
                                side the venue omitted stays ``SIDE_UNKNOWN``
                                and is marked ``SIDE_SRC_NA``, never laundered
                                into an exchange-true claim)
  ``BookTicker``                ``BBO``
  ``Liquidation``               ``Marker{kind=liquidation}``
  anything else                 ignored (not in the canonical dialect)
  ============================  =======================================

Book maintenance note (deviation from the plan's "engine ``OrderBook``"):
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

from crocodile.core.connector import Connector
from crocodile.core.ingest.transport import AiohttpWsTransport, Transport
from crocodile.core.schema.enums import Side
from crocodile.core.schema.records import (
    BookDelta,
    BookSnapshot,
    BookTicker,
    Level,
    Liquidation,
    Record,
)
from crocodile.core.schema.records import Trade as CTrade
from crocodile.core.sink.base import Sink
from crocodile.crypto.exchanges.factory import (
    list_all_exchanges,
    list_exchanges,
    make_connector,
)
from crocodile.crypto.instruments.registry import InstrumentRegistry

from flowmap_server.config import Config
from flowmap_server.feeds.base import BookState, FeedEvent
from flowmap_server.proto.events import (
    BBO,
    SIDE_BUY,
    SIDE_SELL,
    SIDE_SRC_EXCHANGE,
    SIDE_SRC_NA,
    SIDE_UNKNOWN,
    Marker,
    Trade,
)

__all__ = [
    "BOOK_TOP_N",
    "CRYPTO_EXCHANGES",
    "NATIVE_EXCHANGES",
    "NOT_STREAMABLE",
    "CryptoFeed",
    "is_crypto_market",
    "split_market",
]

logger = logging.getLogger(__name__)

# Subscribe.market strings routed to CryptoFeed by the session feed factory:
# "<exchange>-<segment>" (segment forwarded to the connector, e.g. Binance spot
# vs USD-M futures ws endpoints) or bare "<exchange>".
#
# The venue set is no longer a hand-kept shortlist. `list_all_exchanges()` is
# the union of the engine's hand-written connectors and every ccxt venue the
# installed ccxt can reach; `make_connector` falls through to the universal
# ccxt connector for anything without a native reader. Both lists are read once
# at import — ccxt's venue table is a module constant, not a network call.

# Reachable, but NOT an order-flow view. CoinGecko publishes one 24 h candle
# per coin and the on-chain readers surface pool events — neither has a book or
# a tick tape. Subscribing to them would hand the client a `depth: "L2"` promise
# nothing can keep, so they are excluded from the venue set itself rather than
# merely hidden in the picker: one exclusion, enforced at the routing boundary,
# and every consumer (router, backfill dispatch, quote routing, discovery)
# inherits it.
NOT_STREAMABLE = frozenset(
    {"coingecko", "base_onchain", "gmx_synthetix", "superchain", "derive"}
)

NATIVE_EXCHANGES = frozenset(list_exchanges()) - NOT_STREAMABLE
CRYPTO_EXCHANGES = frozenset(list_all_exchanges()) - NOT_STREAMABLE

# No ccxt or native exchange id contains "-", so "<exchange>-<segment>" parses
# unambiguously with a single partition. (Underscores are used instead:
# base_onchain, gmx_synthetix.) Asserted by tests/feeds/test_crypto_bridge.py.

# The constructor kwarg each native venue uses to pick its market segment, and
# the segments it accepts. Only these two venues take one: everywhere else the
# segment lives in the symbol (OKX "BTC-USDT-SWAP", Deribit "BTC-PERPETUAL",
# ccxt "BTC/USDC:USDC").
#
# The allowed-set is load-bearing, not decorative. `<exchange>-<anything>` used
# to pass validation on the exchange alone, so a caller could mint unbounded
# distinct market strings — each one a fresh session key, a fresh cache entry, a
# fresh directory under the recording root, and an outbound request to the
# venue. Segments are now a closed set, and a venue that cannot use one rejects
# it instead of silently dropping it (which would have shown the client a
# `bitget-swap` label over spot data).
_SEGMENT_KWARG: dict[str, str] = {"binance": "market", "bybit": "category"}
SEGMENTS: dict[str, frozenset[str]] = {
    "binance": frozenset({"spot", "usdm", "coinm"}),
    "bybit": frozenset({"spot", "linear", "inverse", "option"}),
}

# Venue/segment pairs whose forced-liquidation topic this build can ACTUALLY
# subscribe. Not "which venues have liquidations" — which channel names the
# pinned engine spells the way the venue spells them today. Measured against the
# live public sockets rather than read off the venue docs:
#
#   binance usdm  `btcusdt@forceOrder`          -> accepted
#   okx           `liq-orders` + instId         -> ERROR "channel ... doesn't exist"
#                 (OKX v5 wants `liquidation-orders` keyed by instType)
#   bybit linear  `liquidation.BTCUSDT`         -> ERROR "handler not found"
#                 (Bybit v5 renamed it `allLiquidation.{sym}`)
#
# So OKX and Bybit are deliberately absent: subscribing there would spend a
# topic slot on a channel the venue rejects AND advertise a `liquidation` marker
# that could never fire. Both are engine-side spellings — re-measure and add
# them back when the pinned engine is bumped past the fix.
_LIQUIDATION: dict[str, frozenset[str]] = {
    "binance": frozenset({"usdm", "coinm"}),
}

# Venues that deliver liquidations WITHOUT a dedicated channel: Deribit flags
# them on the ordinary `trades` stream, which we already subscribe, and the
# engine yields a `Liquidation` record for each. Declaring the marker here keeps
# the capability honest in the other direction — under-promising is a lie too,
# and this one had the client told a marker kind could not appear seconds before
# it did.
_LIQUIDATION_VIA_TRADES: frozenset[str] = frozenset({"deribit"})


def split_market(market: str) -> tuple[str, str]:
    """``"binance-usdm"`` -> ``("binance", "usdm")``; ``"okx"`` -> ``("okx", "")``."""
    exchange, _, segment = market.partition("-")
    return exchange, segment


def is_crypto_market(market: str) -> bool:
    """True when *market* names a venue+segment this build can actually serve.

    Validates BOTH halves. A segment the venue has no use for is rejected rather
    than ignored — see :data:`SEGMENTS`.
    """
    exchange, segment = split_market(market)
    if exchange not in CRYPTO_EXCHANGES:
        return False
    return not segment or segment in SEGMENTS.get(exchange, frozenset())

# Default cap per side on emitted BookState arrays; the closest-to-touch levels
# win. Overridable via Config.book_top_n / FLOWMAP_BOOK_TOP_N.
#
# This cap — not the grid — is what actually decides how far from the touch a
# resting order can be and still reach the client. At 2000 levels BTCUSDT is
# truncated a few hundred dollars from mid (well under 1%), so the wide/full
# price bands would render an empty far field no matter how tall the grid was.
# The sort below is over the FULL book either way, so raising the cap costs only
# a larger array build, not a bigger sort.
#
# Be honest about the remaining limit: venues also enforce order price-band
# filters (Binance PERCENT_PRICE / PERCENT_PRICE_BY_SIDE), so on the majors
# resting orders at +1000% of mid mostly cannot legally exist. A wide band shows
# what IS there; it cannot conjure liquidity the venue does not accept.
BOOK_TOP_N = 20_000

_SIDE_MAP = {Side.BUY: SIDE_BUY, Side.SELL: SIDE_SELL}

# Trade ids remembered per polled session for dedup. Comfortably larger than any
# venue's recent-trades window (ccxt returns at most a few hundred per fetch).
_SEEN_TRADE_IDS = 4096


class _FeedEnd:
    """Queue sentinel: the connector task finished (exc=None -> clean end)."""

    __slots__ = ("exc",)

    def __init__(self, exc: BaseException | None) -> None:
        self.exc = exc


class _BridgeSink(Sink):
    """Translate Crocodile records into canonical FeedEvents.

    Maintains the live L2 book as price->size dicts (absolute exchange sizes,
    inherently aggregated per price level). Sequencing is NOT re-checked here
    — see the module docstring. A ``BookSnapshot`` arriving while the book is
    already initialized is the connector's resync signature: emit
    ``Marker{kind=gap}`` first, then snapshot-replace.
    """

    def __init__(
        self,
        emit: Callable[[FeedEvent], None],
        book_top_n: int = BOOK_TOP_N,
        *,
        snapshot_driven: bool = False,
    ) -> None:
        self._emit = emit
        self._book_top_n = max(1, book_top_n)
        self._bids: dict[float, float] = {}
        self._asks: dict[float, float] = {}
        self._initialized = False
        # On a delta venue a re-snapshot means the connector lost sequence, so
        # it earns a gap marker. On a snapshot-driven venue (the ccxt path has
        # no incremental diff — it re-reads the whole book every tick) a
        # snapshot IS the normal update, and marking each one a gap would
        # invent a stream of resyncs that never happened.
        self._snapshot_driven = snapshot_driven
        # The ccxt REST poll has no `since` cursor and no dedup of its own: it
        # re-reads the venue's recent-trades window every interval, so the same
        # print arrives once per poll. Left alone that multiplies tape volume
        # and CVD under a `tape: "tick"` badge. Only polled feeds need this, and
        # a bounded ring keeps it O(1) — a venue that reuses trade ids across a
        # long session would at worst drop one print, which is the safer error.
        self._seen_ids: dict[str, None] = {}

    async def put(self, record: Record) -> None:
        if isinstance(record, BookDelta):
            if not self._initialized:
                return  # pre-snapshot deltas carry no anchored state
            self._apply_levels(record.bids, self._bids)
            self._apply_levels(record.asks, self._asks)
            self._emit_book(self._ts(record))
        elif isinstance(record, BookSnapshot):
            if self._initialized and not self._snapshot_driven:
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
            # The side is exchange-true only when the venue actually published
            # one. ccxt's unified trade `side` is optional, and its normalizer
            # maps anything that is not "buy"/"sell" to Side.UNKNOWN — stamping
            # SIDE_SRC_EXCHANGE on that would tell the client an unknown
            # aggressor was venue-confirmed, and the grid drops those prints
            # from CVD anyway. Say NA and let the tape show it.
            if self._snapshot_driven and self._is_duplicate(record.id):
                return
            side = _SIDE_MAP.get(record.side)
            self._emit(
                Trade(
                    ts_ns=self._ts(record),
                    price=record.price,
                    size=record.amount,
                    side=side if side is not None else SIDE_UNKNOWN,
                    side_src=SIDE_SRC_EXCHANGE if side is not None else SIDE_SRC_NA,
                    venue=record.source,
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

    def _is_duplicate(self, trade_id: str) -> bool:
        """True when this polled feed already emitted *trade_id*."""
        if not trade_id:
            return False  # a venue that publishes no id cannot be deduped
        if trade_id in self._seen_ids:
            return True
        self._seen_ids[trade_id] = None
        if len(self._seen_ids) > _SEEN_TRADE_IDS:
            # dicts preserve insertion order, so this evicts the oldest.
            del self._seen_ids[next(iter(self._seen_ids))]
        return False

    async def flush(self) -> None:
        return None

    @staticmethod
    def _ts(record: Record) -> int:
        # Merged-engine header: the venue/provider clock is `source_ts` for both
        # asset classes (it was `exchange_ts` on the crypto fork). Still optional
        # — a venue that stamps nothing falls back to our receive clock.
        ts = record.source_ts
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
        cap = self._book_top_n
        bids = sorted(self._bids.items(), key=lambda kv: -kv[0])[:cap]
        asks = sorted(self._asks.items())[:cap]
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
    iterator is running, the engine's own supervision handles ws reconnects
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
        # What the connector is actually subscribed with; resolved from
        # `symbol` on the first events() call (see there). Until then the two
        # are the same, which is the common case.
        self._connector_symbol = symbol
        self.market = f"{exchange}-{market}" if market else exchange
        self._market_kw = market
        self._cfg = cfg
        self._connector_factory = connector_factory or self._default_connector
        # Recorded as a flag, NOT by comparing `self._connector_factory is
        # self._default_connector` later: every attribute access on a bound
        # method builds a NEW object, so that identity test is always False and
        # the symbol translation below would silently never run.
        self._owns_connector = connector_factory is None
        self._transport_factory = transport_factory
        # A venue with no hand-written reader is served by the universal ccxt
        # connector, which has no incremental book diff and no liquidation
        # topic. That is a real capability difference, so it is declared rather
        # than papered over.
        self.native = exchange in NATIVE_EXCHANGES
        # Two different things: whether to SUBSCRIBE a liquidation channel, and
        # whether liquidations can reach the client at all. Deribit flags them
        # on the trades stream we already take, so it earns the marker without
        # a channel.
        self._liquidation = market in _LIQUIDATION.get(exchange, frozenset())
        emits_liquidation = self._liquidation or exchange in _LIQUIDATION_VIA_TRADES
        # markers reflect what the client can actually receive (spec §7 honesty
        # rule), and a snapshot-driven venue cannot detect a sequence gap.
        markers: list[str] = ["gap"] if self.native else []
        if emits_liquidation:
            markers.insert(0, "liquidation")
        self.capability: dict[str, object] = {
            "depth": "L2" if self.native else "L2-snapshot",
            "tape": "tick",
            "trade_side": "exchange",
            # Exchange-true aggressor side -> honest per-bar CVD (spec §7 parity).
            "cvd": "exchange",
            "markers": markers,
        }

    def _channels(self) -> list[str]:
        if not self.native:
            # The ccxt path answers book_delta and book_snapshot from the same
            # `fetch/watch_order_book` call, so asking for both would double the
            # venue's rate-limit spend for identical records.
            return ["trade", "book_snapshot", "book_ticker"]
        channels = ["trade", "book_delta", "book_snapshot", "book_ticker"]
        if self._liquidation:
            channels.append("liquidation")
        return channels

    def _connector_kwargs(self) -> dict[str, object]:
        if not self.native:
            # Stream where the venue supports it; ccxt.pro falls back to REST
            # polling per channel on its own when it does not.
            return {"use_ws": True, "book_depth": 100}
        kwarg = _SEGMENT_KWARG.get(self.exchange)
        if kwarg is not None and self._market_kw:
            return {kwarg: self._market_kw}
        return {}

    def _default_connector(self, sink: Sink) -> Connector:
        conn = make_connector(
            self.exchange,
            symbols=[self._connector_symbol],
            channels=self._channels(),
            out=sink,
            registry=InstrumentRegistry(),
            **self._connector_kwargs(),
        )
        _harden_rest_ssl(conn)
        return conn

    async def events(self) -> AsyncIterator[FeedEvent]:
        queue: asyncio.Queue[FeedEvent | _FeedEnd] = asyncio.Queue()
        sink = _BridgeSink(
            queue.put_nowait, self._cfg.book_top_n, snapshot_driven=not self.native
        )
        if self._owns_connector:
            # A symbol can arrive in either spelling — the venue's own
            # ("ETHBTC") or ccxt's unified ("ETH/BTC") — depending on which
            # enumerator the picker used. Translate once, here, so the same
            # user-visible symbol works whichever connector serves it. Skipped
            # when a factory is injected: that caller owns the symbol.
            # Lazy import: data.venues reads this module's venue sets.
            from flowmap_server.data.venues import resolve_symbol

            # Deliberately NOT `self.symbol`: that is the session's identity
            # (recording path, client-visible label) and must not shift under
            # a mid-session feed restart.
            self._connector_symbol = await resolve_symbol(self.market, self.symbol)
        conn = self._connector_factory(sink)
        if conn.transport is None and conn.ws_url:
            # Poll-only connectors (the ccxt path, CoinGecko, the on-chain
            # readers) declare an empty ws_url and drive themselves; handing
            # them a websocket transport for "" would be a connection to
            # nowhere.
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
