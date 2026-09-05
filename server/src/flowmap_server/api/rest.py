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
import time

from fastapi import APIRouter, Request

from flowmap_server import __version__
from flowmap_server.config import Config
from flowmap_server.data.universe import build_directory, filter_directory
from flowmap_server.feeds.equity import EquityFeed
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto import wire

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
async def health(request: Request) -> dict[str, object]:
    """Liveness + operational snapshot. No auth, NO sensitive fields.

    Goes beyond the legacy ``{status, version}`` liveness ping so an operator
    (or the desktop wrapper) can answer "is the sidecar alive AND is it
    actually feeding?" in one call: process uptime, wire protocol version,
    whether recording is enabled, and one row per ACTIVE session with its
    feed kind and live/degraded state. Reads session state defensively via
    ``getattr`` — the health probe must never 500 (a missing manager or an
    unexpected session shape degrades to zeros/empty, still ``status: ok``).
    """
    cfg: Config | None = getattr(request.app.state, "cfg", None)
    manager = getattr(request.app.state, "manager", None)
    feeds: list[dict[str, str]] = []
    # Keyed (market, symbol, mode, source, band); the band is geometry, not
    # identity, so it is not surfaced here.
    for key, s in sorted(getattr(manager, "_sessions", {}).items()):
        feed = getattr(s, "_feed", None)
        feeds.append(
            {
                "market": str(getattr(feed, "market", key[0]) if feed else key[0]),
                "symbol": str(getattr(feed, "symbol", key[1]) if feed else key[1]),
                "mode": str(key[2]),
                "state": str(getattr(s, "_feed_state", "unknown")),
            }
        )
    started = getattr(request.app.state, "started_monotonic_ns", None)
    uptime_s = max(0.0, (time.monotonic_ns() - started) / 1e9) if started else 0.0
    return {
        "status": "ok",
        "version": __version__,
        "protocol_version": wire.PROTO_VER,
        "uptime_s": round(uptime_s, 3),
        "recording_enabled": bool(getattr(cfg, "recording_enabled", False)),
        "active_sessions": len(feeds),
        "feeds": feeds,
    }


@router.get("/symbols")
async def symbols(q: str = "") -> dict[str, list[dict[str, object]]]:
    """Merged symbol directory, filtered by case-insensitive substring.

    Returns the FULL bundled universe (kept backward-compatible: the legacy
    sim/crypto/equity shortlist symbols are all still present)."""
    return {"symbols": filter_directory(current_directory(), q=q)}
