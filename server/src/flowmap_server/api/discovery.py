"""Search / discovery REST routes (GOAL 2): universe, movers, quote (JSON, GET).

- ``/api/universe`` is PURE (the bundled directory + live-derived capabilities;
  no network) — the fuller counterpart to ``/api/symbols``.
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
from flowmap_server.data.universe import filter_directory

__all__ = ["router"]

router = APIRouter(prefix="/api")

_MOVERS_DEFAULT = 20
_MOVERS_MAX = 100
_UNIVERSE_DEFAULT = 100
_UNIVERSE_MAX = 1000


def _cache(request: Request) -> MarketDataCache | None:
    return getattr(request.app.state, "market_cache", None)


@router.get("/universe")
async def universe(
    market: str = "all", q: str = "", limit: int = _UNIVERSE_DEFAULT
) -> dict[str, list[dict[str, object]]]:
    """Fuller symbol universe (pure): ``market`` = all|crypto|equity|sim (or an
    exact market string), ``q`` substring, ``limit`` cap."""
    n = max(1, min(limit, _UNIVERSE_MAX))
    entries = filter_directory(current_directory(), q=q, market=market, limit=n)
    return {"symbols": entries}


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
