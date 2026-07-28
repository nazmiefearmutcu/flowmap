"""Live venue + symbol enumeration, straight from the market engine.

The bundled lists in :mod:`flowmap_server.data.universe` exist because the
*pinned* engine had no enumerator. The merged engine does, so this module is
the live path and the bundled lists become the offline fallback rather than
the whole truth.

Two things are enumerated, and they have very different costs:

**Venues** (:func:`venue_catalog`) — free. ``list_all_exchanges()`` is a union
of the engine's hand-written connectors and ccxt's venue table, both module
constants. No network, safe to call per request.

**Symbols** (:func:`venue_symbols`) — one REST round-trip per venue, cached.

Spelling is the load-bearing detail. A venue with a hand-written connector
wants its OWN symbol id (Binance ``ETHBTC``, OKX ``BTC-USD-SWAP``, Deribit
``BTC-PERPETUAL``); ccxt speaks a unified id (``ETH/BTC``). The engine's
``exchange_instruments`` routes through ccxt whenever the venue is a ccxt id —
which includes Binance and OKX — so enumerating through it would hand the
symbol picker a spelling the native connector then rejects. So: enumerate from
the native connector first and fall back to ccxt only for venues that have no
native reader (or whose native listing fails). :func:`resolve_symbol` closes
the remaining gap at subscribe time, so a symbol typed in either spelling still
works.

Native listings go through the same certifi hardening the live feed uses — a
stock macOS framework Python cannot verify these hosts otherwise, and the
failure looks like "venue has no symbols" rather than a TLS error.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from flowmap_server.feeds.crypto import (
    CRYPTO_EXCHANGES,
    NATIVE_EXCHANGES,
    _harden_rest_ssl,
    split_market,
)
from flowmap_server.feeds.equity import EQUITY_MARKET

__all__ = [
    "SYMBOL_TTL_NS",
    "VenueInfo",
    "ccxt_knows",
    "resolve_symbol",
    "venue_catalog",
    "venue_symbols",
]

logger = logging.getLogger(__name__)

# Segments that mean "derivatives" to ccxt's `defaultType`.
_SWAP_SEGMENTS = frozenset({"usdm", "coinm", "linear", "inverse", "swap", "perp", "futures"})

# One venue's instrument list is stable on the scale of a session; re-listing
# per search keystroke would be a rate-limit incident, not a feature.
SYMBOL_TTL_NS = 15 * 60 * 10**9

# A venue listing runs inside a request handler, under a per-market lock, so an
# unbounded await blocks every other caller for that venue. The engine's own
# readers have no wall-clock bound of their own: Deribit does 20 sequential REST
# calls at 10 s + 3 retries each, Bybit pages a cursor with no page cap. Cap it
# here.
LIST_TIMEOUT_S = 25.0

# A venue that just failed is not retried on the next keystroke, but neither is
# the failure treated as a 15-minute answer: a short negative TTL debounces the
# outage without freezing an empty picker until the venue is forgotten.
EMPTY_TTL_NS = 30 * 10**9

# Segments a venue accepts after the "-" in a market string. Only venues whose
# connector takes a segment kwarg have any; the rest encode it in the symbol.
_SEGMENTS: dict[str, tuple[str, ...]] = {
    "binance": ("spot", "usdm", "coinm"),
    "bybit": ("spot", "linear", "inverse", "option"),
}

class VenueInfo:
    """One selectable venue, as the discovery API reports it."""

    __slots__ = ("asset_class", "depth", "id", "native", "segments")

    def __init__(
        self,
        id: str,
        asset_class: str,
        native: bool,
        segments: tuple[str, ...],
        depth: str | None = None,
    ) -> None:
        self.id = id
        self.asset_class = asset_class
        self.native = native
        self.segments = segments
        # Crypto: a native connector streams true book diffs, a ccxt venue is
        # re-read whole each tick, and the client badges the difference — so the
        # `native` flag IS the depth there. Off the crypto side it is not:
        # deriving it made this endpoint claim L2 for equity, which no equity
        # tier serves (keyless is SYNTH, Alpaca is L1) and which contradicted
        # what /api/universe reports for the same market. Non-crypto venues
        # therefore state their own depth, read off the feed.
        self.depth = depth or ("L2" if native else "L2-snapshot")

    def as_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "assetClass": self.asset_class,
            "depth": self.depth,
            "native": self.native,
            "segments": list(self.segments),
        }


def _feed_depth(capability: dict[str, object]) -> str:
    return str(capability.get("depth", "unknown"))


def _sim_depth() -> str:
    """Sim depth read off SimFeed itself (construction is pure)."""
    from flowmap_server.feeds.sim import SimFeed

    return _feed_depth(SimFeed(seed=0).capability)


def _equity_depth() -> str:
    """Equity depth read off EquityFeed's own tier selection, never assumed.

    Mirrors ``api.rest._equity_capability``: keys are auto-detected from env, so
    a keyed machine reports its real tier with no code change. Construction does
    no I/O. Falls back to the keyless answer if the env is unreadable.
    """
    import os

    from flowmap_server.config import Config
    from flowmap_server.feeds.equity import EquityFeed

    try:
        cfg = Config.from_env(os.environ)
    except Exception:  # noqa: BLE001 — a bad env falls back to keyless defaults
        cfg = Config()
    return _feed_depth(EquityFeed("AAPL", cfg).capability)


def venue_catalog() -> list[VenueInfo]:
    """Every venue this build can actually stream. No network."""
    out = [
        VenueInfo("sim", "sim", True, (), depth=_sim_depth()),
        VenueInfo(EQUITY_MARKET, "equity", True, (), depth=_equity_depth()),
    ]
    for ex in sorted(CRYPTO_EXCHANGES):
        # CRYPTO_EXCHANGES already excludes the non-streamable readers — the
        # catalog and the router cannot disagree about what is subscribable.
        out.append(VenueInfo(ex, "crypto", ex in NATIVE_EXCHANGES, _SEGMENTS.get(ex, ())))
    return out


_cache: dict[str, tuple[int, list[str]]] = {}
_locks: dict[str, asyncio.Lock] = {}


async def venue_symbols(market: str, *, now_ns: int | None = None) -> list[str]:
    """Symbols listed by *market*, in the spelling that venue's feed expects.

    Returns ``[]`` — never raises — when the venue is unreachable, so discovery
    degrades to the bundled shortlist instead of failing the request. Results
    are cached for :data:`SYMBOL_TTL_NS` and concurrent callers collapse onto
    one fetch.
    """
    now = time.time_ns() if now_ns is None else now_ns
    hit = _cache.get(market)
    if hit is not None and now - hit[0] < SYMBOL_TTL_NS:
        return hit[1]
    lock = _locks.setdefault(market, asyncio.Lock())
    async with lock:
        # Re-check: a caller that queued on the lock wants the fetch the holder
        # just did, not a second one.
        hit = _cache.get(market)
        if hit is not None and now - hit[0] < SYMBOL_TTL_NS:
            return hit[1]
        try:
            async with asyncio.timeout(LIST_TIMEOUT_S):
                symbols = await _list_symbols(market)
        except (TimeoutError, asyncio.TimeoutError):
            logger.warning("symbol enumeration timed out for %r", market)
            symbols = []
        except Exception:  # noqa: BLE001 — discovery must not fail on a venue outage
            logger.warning("symbol enumeration failed for %r", market, exc_info=True)
            symbols = []
        # Stamp the time the answer was OBTAINED, not the time the request
        # started: a slow fetch would otherwise be born already aged. Honour an
        # injected clock so tests stay deterministic.
        done = time.time_ns() if now_ns is None else now_ns
        if symbols:
            _cache[market] = (done, symbols)
            return symbols
        if hit is not None:
            # Keep the last good list rather than blanking the picker — and
            # refresh its stamp, or every later call re-fetches and the failure
            # becomes the rate-limit incident the cache exists to prevent.
            _cache[market] = (done, hit[1])
            return hit[1]
        # Nothing good to fall back on: remember the emptiness only briefly.
        _cache[market] = (done - SYMBOL_TTL_NS + EMPTY_TTL_NS, [])
        return []


async def _list_symbols(market: str) -> list[str]:
    exchange, segment = split_market(market)
    if exchange in NATIVE_EXCHANGES:
        native = await _native_symbols(exchange, segment)
        if native:
            return native
        logger.info("native listing empty for %r; falling back to ccxt", market)
    return await _ccxt_symbols(exchange)


async def _native_symbols(exchange: str, segment: str) -> list[str]:
    from crocodile.core.sink.memory import MemorySink
    from crocodile.crypto.exchanges.factory import make_connector
    from crocodile.crypto.instruments.registry import InstrumentRegistry

    kw: dict[str, Any] = {}
    if exchange == "binance" and segment:
        kw["market"] = segment
    elif exchange == "bybit" and segment:
        kw["category"] = segment
    conn = make_connector(
        exchange,
        symbols=[],
        channels=["trade"],
        out=MemorySink(),
        registry=InstrumentRegistry(),
        **kw,
    )
    _harden_rest_ssl(conn)
    try:
        instruments = await conn.list_instruments()
    finally:
        await _close_quietly(conn)
    return sorted({str(i.symbol_raw) for i in instruments if i.symbol_raw})


def ccxt_knows(exchange: str) -> bool:
    """True when ccxt has a driver for *exchange*.

    NOT ``factory.is_ccxt_exchange``: that answers "is this venue SERVED BY the
    ccxt connector", which is False for every venue that also has a native
    connector — measured against the pinned engine + ccxt 4.5.69, six of the ten
    natives are also ccxt ids (binance, bybit, coinbase, deribit, derive, okx).
    Those are exactly the venues where we still want ccxt for what the native
    reader does not do — symbol translation and kline backfill — so the question
    here is the other one.
    """
    try:
        import ccxt
    except ModuleNotFoundError:
        return False
    return exchange in ccxt.exchanges


async def _ccxt_symbols(exchange: str) -> list[str]:
    if not ccxt_knows(exchange):
        return []
    import ccxt.async_support as ccxt_async

    ex = getattr(ccxt_async, exchange)({"enableRateLimit": True})
    try:
        markets = await ex.load_markets()
    finally:
        await ex.close()
    return sorted(str(sym) for sym, m in markets.items() if (m or {}).get("active", True))


async def resolve_symbol(market: str, symbol: str) -> str:
    """Return *symbol* in the spelling *market*'s connector expects.

    A native venue is given its own id; a ccxt venue is given the unified id.
    Cross-spelling input is translated through ccxt's market table, which
    carries both (``markets[unified]["id"]`` IS the venue-native symbol). When
    nothing matches, the input is returned untouched — the connector's own
    error is a better message than a guess.
    """
    exchange, segment = split_market(market)
    native = exchange in NATIVE_EXCHANGES
    if native == ("/" not in symbol):
        # Native venue with a native-looking symbol, or ccxt venue with a
        # unified one: already the right shape.
        return symbol
    if not ccxt_knows(exchange):
        return symbol
    try:
        import ccxt.async_support as ccxt_async

        from crocodile.crypto.exchanges.ccxt_universal.connector import CCXTConnector

        # `defaultType` decides which market a bare, ambiguous id resolves to.
        # ccxt lists spot first, so without this a `binance-usdm` subscribe for
        # "BTCUSDT" would come back as the SPOT pair — the wrong instrument
        # under the right label, which is worse than an error.
        ex = getattr(ccxt_async, exchange)(
            {
                "enableRateLimit": True,
                "options": {"defaultType": "swap" if segment in _SWAP_SEGMENTS else "spot"},
            }
        )
        try:
            markets = await ex.load_markets()
            unified = CCXTConnector._resolve_symbol(symbol, markets, ex.markets_by_id)
            if unified is None:
                return symbol
            if not native:
                return unified
            venue_id = (markets.get(unified) or {}).get("id")
            return str(venue_id) if venue_id else symbol
        finally:
            await ex.close()
    except Exception:  # noqa: BLE001 — a failed translation must not block a subscribe
        logger.warning("symbol translation failed for %s:%s", market, symbol, exc_info=True)
        return symbol


async def _close_quietly(conn: object) -> None:
    session = getattr(conn, "_session", None)
    if session is not None and not getattr(session, "closed", True):
        try:
            await session.close()
        except Exception:  # noqa: BLE001
            pass
