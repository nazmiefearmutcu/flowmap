"""REST routes (M1 T8; equity capability M3 T2; universe GOAL 2): health +
symbol directory (spec §5).

Handlers are pure in-memory lookups — network calls are FORBIDDEN here. The
directory is now the FULL bundled universe (``data/universe.py``): the sim
symbol, a curated crypto shortlist, and a curated large-cap US equity list —
each with a capability read off its real feed so the directory can never drift
from what a subscribe actually delivers:

- the sim symbol, capability from :class:`SimFeed`;
- the curated crypto shortlist (live market-wide enumeration is unavailable
  offline in the pinned deps, so the LIST is bundled; live price/mover data for
  these symbols is served separately by ``/api/movers`` + ``/api/quote`` through
  the network cache);
- the curated equity list, capability read off :class:`EquityFeed` (the keyless
  SYNTH tier on this machine; keyed tiers activate with no code change).

``current_directory()`` is shared with the ``/api/universe`` handler
(``api/discovery.py``) so both surfaces stay identical and honest.
"""

from __future__ import annotations

import os

from fastapi import APIRouter

from flowmap_server import __version__
from flowmap_server.config import Config
from flowmap_server.data.universe import build_directory, filter_directory
from flowmap_server.feeds.equity import EquityFeed
from flowmap_server.feeds.sim import SimFeed

__all__ = ["router", "current_directory", "CRYPTO_CAPABILITY"]

router = APIRouter(prefix="/api")

# SimFeed's constructor does no I/O; seed is irrelevant for the capability.
_SIM_CAPABILITY = SimFeed(seed=0).capability

# Crypto directory capability (spec §7 honesty; GOAL 3 cvd). Mirrors the core
# keys a crypto subscribe delivers — L2 depth, tick tape, exchange-true side and
# CVD. (Per-market marker lists live on the feed itself.)
CRYPTO_CAPABILITY: dict[str, object] = {
    "depth": "L2",
    "tape": "tick",
    "trade_side": "exchange",
    "cvd": "exchange",
}


def _equity_capability() -> dict[str, object]:
    """Equity capability mirrored from :class:`EquityFeed`'s own tier selection
    so the directory never lies about an equity subscribe. Keys are auto-detected
    from env (spec §7): keyless -> SYNTH on this machine; Alpaca/Finnhub keyed
    tiers activate with no code change. Construction is pure (no I/O)."""
    try:
        cfg = Config.from_env(os.environ)
    except Exception:  # noqa: BLE001 — a bad env falls back to keyless defaults
        cfg = Config()
    return EquityFeed("AAPL", cfg).capability


def current_directory() -> tuple[dict[str, object], ...]:
    """The full merged directory with live-derived capabilities (no I/O)."""
    return build_directory(
        sim_symbol=SimFeed.symbol,
        sim_capability=_SIM_CAPABILITY,
        crypto_capability=CRYPTO_CAPABILITY,
        equity_capability=_equity_capability(),
    )


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@router.get("/symbols")
async def symbols(q: str = "") -> dict[str, list[dict[str, object]]]:
    """Merged symbol directory, filtered by case-insensitive substring.

    Returns the FULL bundled universe (kept backward-compatible: the legacy
    sim/crypto/equity shortlist symbols are all still present)."""
    return {"symbols": filter_directory(current_directory(), q=q)}
