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
from flowmap_server.api import discovery, rest, ws
from flowmap_server.api.market_cache import (
    MarketDataCache,
    default_movers_fn,
    default_quote_fn,
)
from flowmap_server.config import Config
from flowmap_server.core.backfill import default_backfill_fn
from flowmap_server.core.record import Recorder
from flowmap_server.core.session import SessionManager
from flowmap_server.feeds.base import Feed
from flowmap_server.feeds.router import feed_factory
from flowmap_server.proto import events

__all__ = ["create_app"]

# CORS restricted to the FlowMap client (spec §11): the vite dev-server origins,
# plus the packaged desktop webview. In the Tauri app the SPA is served from
# `tauri://localhost` and the REST directory (`/api/symbols`) is fetched
# cross-origin from the loopback sidecar, so that origin must be allowed too.
# (The `/ws` stream is not CORS-gated — the WS endpoint accepts unconditionally.)
_ALLOWED_ORIGINS = (
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "tauri://localhost",
    "http://tauri.localhost",
)


def _server_feed_factory(cfg: Config) -> Callable[[events.Subscribe], Feed]:
    """Server-path feed factory: realtime sim + live crypto/equity.

    Same routing as the test path (both go through ``feeds.router``); only the
    sim feed differs — ``realtime=True`` paces one interval per ``dt_ns`` of
    wall time, which keeps the event loop live and the demo stream watchable
    (4 columns/s at dt=250 ms).
    """
    return feed_factory(cfg, realtime_sim=True)


def create_app(
    cfg: Config,
    manager: SessionManager | None = None,
    market_cache: MarketDataCache | None = None,
) -> FastAPI:
    if manager is None:
        recorder = Recorder(
            # expanduser defensively: from_env already expands, but a Config
            # constructed directly may carry the "~/..." default.
            Path(cfg.data_dir).expanduser(),
            cfg.recording_gb_cap,
            enabled=cfg.recording_enabled,
        )
        manager = SessionManager(
            cfg,
            feed_factory=_server_feed_factory(cfg),
            recorder=recorder,
            # First-launch history backfill (GOAL 1). The network seam dispatches
            # crypto -> klines, equity -> Yahoo, sim -> no-op; tests inject their
            # own manager (no backfill).
            backfill_fn=default_backfill_fn,
        )
    # Discovery cache (GOAL 2): all movers/quote network lives behind this
    # TTL-debounced cache. Tests inject a canned cache; the default wires the live
    # provider seams (only called when /api/movers or /api/quote is hit).
    if market_cache is None:
        market_cache = MarketDataCache(
            quote_fn=default_quote_fn, movers_fn=default_movers_fn
        )
    app = FastAPI(title="flowmap-server", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.cfg = cfg
    app.state.manager = manager
    app.state.market_cache = market_cache
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(_ALLOWED_ORIGINS),
        allow_methods=["GET"],
        allow_headers=[],
    )
    app.include_router(rest.router)
    app.include_router(discovery.router)
    app.include_router(ws.router)
    return app
