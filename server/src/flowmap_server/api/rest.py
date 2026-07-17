"""REST routes (M1 T8): health + symbol directory (spec §5).

Handlers are pure in-memory lookups — network calls are FORBIDDEN here (the
T9/M4 feed adapters own live symbol discovery). The M1 directory is:

- the sim symbol, with its capability read off :class:`SimFeed` so the
  directory can never drift from what a ``sim`` subscribe actually delivers;
- a static crypto shortlist. Crypcodile's ``InstrumentRegistry``
  (``crypcodile.instruments.registry``) was checked: it is an empty
  in-memory map populated by live connectors at runtime, so enumerating real
  symbols would require network — hence the static list, noted "live in T9";
- a static equity top-tickers shortlist, noted "live in M4".
"""

from __future__ import annotations

from fastapi import APIRouter

from flowmap_server import __version__
from flowmap_server.feeds.sim import SimFeed

__all__ = ["router"]

router = APIRouter(prefix="/api")

# SimFeed's constructor does no I/O; seed is irrelevant for the capability.
_SIM_CAPABILITY = SimFeed(seed=0).capability

_CRYPTO_SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT")
_CRYPTO_CAPABILITY: dict[str, object] = {"depth": "L2", "tape": "tick"}
_EQUITY_SYMBOLS = ("AAPL", "MSFT", "NVDA", "TSLA", "SPY")
_EQUITY_CAPABILITY: dict[str, object] = {"depth": "SYNTH", "tape": "poll"}

_DIRECTORY: tuple[dict[str, object], ...] = (
    {"market": "sim", "symbol": SimFeed.symbol, "capability": _SIM_CAPABILITY},
    *(
        {
            "market": "binance-spot",
            "symbol": s,
            "capability": _CRYPTO_CAPABILITY,
            "note": "live in T9",
        }
        for s in _CRYPTO_SYMBOLS
    ),
    *(
        {
            "market": "equity",
            "symbol": s,
            "capability": _EQUITY_CAPABILITY,
            "note": "live in M4",
        }
        for s in _EQUITY_SYMBOLS
    ),
)


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@router.get("/symbols")
async def symbols(q: str = "") -> dict[str, list[dict[str, object]]]:
    """Merged symbol directory, filtered by case-insensitive substring."""
    needle = q.lower()
    return {
        "symbols": [e for e in _DIRECTORY if needle in str(e["symbol"]).lower()]
    }
