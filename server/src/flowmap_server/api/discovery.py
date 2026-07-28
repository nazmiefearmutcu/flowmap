"""Search / discovery REST routes (GOAL 2): venues, universe, movers, quote.

- ``/api/venues`` is PURE: the engine's venue set (native connectors + every
  ccxt id + equity + sim), read from module constants.
- ``/api/universe`` is PURE for the aggregate markets (the bundled directory +
  live-derived capabilities) and enumerates live, with a cache, when asked for
  a specific venue — the fuller counterpart to ``/api/symbols``.
- ``/api/movers`` and ``/api/quote`` are display-only price surfaces. ALL network
  is behind the TTL-debounced :class:`~flowmap_server.api.market_cache.MarketDataCache`
  on ``app.state.market_cache`` (injectable; canned in tests). A closed/stale
  equity value is surfaced as ``stale`` — never presented as a live NBBO print.

The cache absence is tolerated: if no cache is wired (should not happen in the
real app), movers/quote degrade to empty/unreachable rather than 500.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from flowmap_server.api.market_cache import (
    MarketDataCache,
    QuoteData,
    mover_to_json,
    quote_to_json,
)
from flowmap_server.api.rest import current_directory
from flowmap_server.config import Config
from flowmap_server.data.universe import filter_directory
from flowmap_server.data.venues import venue_catalog, venue_symbols
from flowmap_server.feeds.crypto import CryptoFeed, is_crypto_market, split_market

__all__ = ["router"]

router = APIRouter(prefix="/api")

_MOVERS_DEFAULT = 20
_MOVERS_MAX = 100
_UNIVERSE_DEFAULT = 100
_UNIVERSE_MAX = 1000


def _cache(request: Request) -> MarketDataCache | None:
    return getattr(request.app.state, "market_cache", None)


@router.get("/venues")
async def venues() -> dict[str, list[dict[str, object]]]:
    """Every venue this build can stream. Pure — no network.

    This is what makes the picker's venue list the engine's list rather than a
    copy of it: the five native crypto connectors, every ccxt venue id, the
    equity market and the sim feed.
    """
    return {"venues": [v.as_dict() for v in venue_catalog()]}


@router.get("/universe")
async def universe(
    market: str = "all", q: str = "", limit: int = _UNIVERSE_DEFAULT
) -> dict[str, list[dict[str, object]]]:
    """Symbol universe: ``market`` = all|crypto|equity|sim, or a venue string.

    ``all``/``crypto``/``equity``/``sim`` stay PURE — they serve the bundled
    directory, so the first paint never waits on a venue. Naming a specific
    crypto venue (``kraken``, ``binance-usdm``) enumerates that venue live and
    caches it; an unreachable venue degrades to the bundled shortlist rather
    than to an error.
    """
    n = max(1, min(limit, _UNIVERSE_MAX))
    if market not in ("", "all", "crypto", "equity", "sim") and is_crypto_market(market):
        entries = await _venue_entries(market, q=q, limit=n)
        if entries is not None:
            return {"symbols": entries}
    entries = filter_directory(current_directory(), q=q, market=market, limit=n)
    return {"symbols": entries}


async def _venue_entries(
    market: str, *, q: str, limit: int
) -> list[dict[str, object]] | None:
    """Live-enumerated rows for one venue, or ``None`` when it served nothing."""
    symbols = await venue_symbols(market)
    if not symbols:
        return None
    # Ask the feed rather than restating it. A hand-written copy here drifted
    # once already (it omitted the liquidation marker that a binance-usdm
    # subscribe really delivers), and the directory promising less — or more —
    # than a subscribe returns is exactly the dishonesty the capability block
    # exists to prevent. Same trick as rest._equity_capability.
    exchange, segment = split_market(market)
    capability = CryptoFeed(
        exchange=exchange, symbol="", market=segment, cfg=Config()
    ).capability
    needle = q.lower()
    out: list[dict[str, object]] = []
    for s in symbols:
        if needle and needle not in s.lower():
            continue
        out.append({"market": market, "symbol": s, "capability": capability})
        if len(out) >= limit:
            break
    return out


@router.get("/movers")
async def movers(
    request: Request, market: str = "crypto", limit: int = _MOVERS_DEFAULT
) -> dict[str, list[dict[str, object]]]:
    """Top movers for a market, ranked by |24 h %change| (display-only)."""
    n = max(1, min(limit, _MOVERS_MAX))
    cache = _cache(request)
    if cache is None:
        return {"movers": []}
    quotes = await cache.movers(market, n)
    return {"movers": [mover_to_json(q) for q in quotes]}


@router.get("/quote")
async def quote(request: Request, market: str, symbol: str) -> dict[str, object]:
    """Single-symbol display-only quote (price + 24 h change + spark)."""
    cache = _cache(request)
    if cache is None:
        q = QuoteData(market=market, symbol=symbol.upper(), reachable=False, stale=True)
        return quote_to_json(q)
    return quote_to_json(await cache.quote(market, symbol))
