"""REST routes (M1 T8; equity capability M3 T2): health + symbol directory
(spec §5).

Handlers are pure in-memory lookups — network calls are FORBIDDEN here (the
T9 crypto discovery still owns live crypto symbol enumeration). The directory
is:

- the sim symbol, with its capability read off :class:`SimFeed` so the
  directory can never drift from what a ``sim`` subscribe actually delivers;
- a static crypto shortlist. Crypcodile's ``InstrumentRegistry``
  (``crypcodile.instruments.registry``) was checked: it is an empty
  in-memory map populated by live connectors at runtime, so enumerating real
  symbols would require network — hence the static list, noted "live in T9";
- a static equity top-tickers shortlist whose capability is read off
  :class:`EquityFeed` (M3 T2). Equity is live: the keyless tier serves a
  genuine two-sided SYNTH depth (Yahoo 1 m warmup + slow last-price poll), and
  the descriptor mirrors the feed's env-selected tier so it can never lie about
  what an equity subscribe delivers.
"""

from __future__ import annotations

import os

from fastapi import APIRouter

from flowmap_server import __version__
from flowmap_server.config import Config
from flowmap_server.feeds.equity import EquityFeed
from flowmap_server.feeds.sim import SimFeed

__all__ = ["router"]

router = APIRouter(prefix="/api")

# SimFeed's constructor does no I/O; seed is irrelevant for the capability.
_SIM_CAPABILITY = SimFeed(seed=0).capability


def _equity_capability() -> dict[str, object]:
    """Equity capability mirrored from :class:`EquityFeed`'s own tier
    selection so the directory never lies about an equity subscribe. Keys are
    auto-detected from env (spec §7): keyless -> SYNTH (two-sided) on this
    machine; the Alpaca/Finnhub keyed tiers activate with no code change.
    Construction is pure (no I/O)."""
    try:
        cfg = Config.from_env(os.environ)
    except Exception:  # noqa: BLE001 — a bad env falls back to keyless defaults
        cfg = Config()
    return EquityFeed("AAPL", cfg).capability


_CRYPTO_SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT")
_CRYPTO_CAPABILITY: dict[str, object] = {"depth": "L2", "tape": "tick"}
_EQUITY_SYMBOLS = ("AAPL", "MSFT", "NVDA", "TSLA", "SPY")
_EQUITY_CAPABILITY = _equity_capability()

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
        # Live (keyless SYNTH tier): no "live in ..." note — like sim.
        {"market": "equity", "symbol": s, "capability": _EQUITY_CAPABILITY}
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
