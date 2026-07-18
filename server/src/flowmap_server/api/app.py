"""FastAPI application factory (M1 T8; spec §5, §11).

``create_app`` wires the REST router, the binary WS endpoint and CORS around
one :class:`SessionManager`. The default manager serves market "sim" with a
REALTIME SimFeed (the non-realtime sim generator never awaits between
events, so inside a shared event loop it would starve every other task,
uvicorn included) plus the live crypto markets via :class:`CryptoFeed`, and
carries a :class:`Recorder` rooted at ``cfg.data_dir`` so every live session
self-records and rehydrates per spec §7/§8.1. Tests that want instant data
or no disk IO inject their own manager.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from flowmap_server import __version__
from flowmap_server.api import rest, ws
from flowmap_server.config import Config
from flowmap_server.core.record import Recorder
from flowmap_server.core.session import SessionManager
from flowmap_server.feeds.base import Feed
from flowmap_server.feeds.crypto import CRYPTO_MARKETS, CryptoFeed
from flowmap_server.feeds.equity import EQUITY_MARKETS, EquityFeed
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto import events

__all__ = ["create_app"]

# Vite dev-server origins only (spec §11: CORS restricted to the client).
_ALLOWED_ORIGINS = ("http://127.0.0.1:5173", "http://localhost:5173")


def _server_feed_factory(cfg: Config) -> Callable[[events.Subscribe], Feed]:
    """Server-path feed factory: realtime sim + live crypto (M1).

    Mirrors ``SessionManager._default_feed_factory`` except the sim feed is
    ``realtime=True`` — one interval per ``dt_ns`` of wall time keeps the
    event loop live and the demo stream watchable (4 columns/s at dt=250 ms).
    """

    def factory(sub: events.Subscribe) -> Feed:
        if sub.market == "sim":
            return SimFeed(seed=42, dt_ns=cfg.dt_crypto_ns, start_ns=0, realtime=True)
        if sub.market in CRYPTO_MARKETS:
            # "<exchange>-<market>" ("binance-usdm") or bare "<exchange>".
            exchange, _, market = sub.market.partition("-")
            return CryptoFeed(exchange=exchange, symbol=sub.symbol, market=market, cfg=cfg)
        if sub.market in EQUITY_MARKETS:
            # Tier (keyless SYNTH / Alpaca / Finnhub) auto-selected from cfg keys.
            return EquityFeed(sub.symbol, cfg)
        raise NotImplementedError(
            f"market {sub.market!r} has no feed "
            f"(sim + crypto {sorted(CRYPTO_MARKETS)} + equity {sorted(EQUITY_MARKETS)})"
        )

    return factory


def create_app(cfg: Config, manager: SessionManager | None = None) -> FastAPI:
    if manager is None:
        recorder = Recorder(
            # expanduser defensively: from_env already expands, but a Config
            # constructed directly may carry the "~/..." default.
            Path(cfg.data_dir).expanduser(),
            cfg.recording_gb_cap,
            enabled=cfg.recording_enabled,
        )
        manager = SessionManager(
            cfg, feed_factory=_server_feed_factory(cfg), recorder=recorder
        )
    app = FastAPI(title="flowmap-server", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.cfg = cfg
    app.state.manager = manager
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(_ALLOWED_ORIGINS),
        allow_methods=["GET"],
        allow_headers=[],
    )
    app.include_router(rest.router)
    app.include_router(ws.router)
    return app
