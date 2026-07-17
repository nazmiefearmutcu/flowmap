"""FastAPI application factory (M1 T8; spec §5, §11).

``create_app`` wires the REST router, the binary WS endpoint and CORS around
one :class:`SessionManager`. The default manager serves market "sim" with a
REALTIME SimFeed: the non-realtime sim generator never awaits between
events, so inside a shared event loop it would starve every other task
(uvicorn included). Tests that want instant data inject their own manager.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from flowmap_server import __version__
from flowmap_server.api import rest, ws
from flowmap_server.config import Config
from flowmap_server.core.session import SessionManager
from flowmap_server.feeds.base import Feed
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto import events

__all__ = ["create_app"]

# Vite dev-server origins only (spec §11: CORS restricted to the client).
_ALLOWED_ORIGINS = ("http://127.0.0.1:5173", "http://localhost:5173")


def _realtime_sim_factory(cfg: Config) -> Callable[[events.Subscribe], Feed]:
    """Server-path feed factory: sim only at M1, paced against wall time.

    Mirrors ``SessionManager._default_feed_factory`` except ``realtime=True``
    — one interval per ``dt_ns`` of wall time keeps the event loop live and
    the demo stream watchable (4 columns/s at dt=250 ms).
    """

    def factory(sub: events.Subscribe) -> Feed:
        if sub.market == "sim":
            return SimFeed(seed=42, dt_ns=cfg.dt_crypto_ns, start_ns=0, realtime=True)
        raise NotImplementedError(
            f"market {sub.market!r} feeds land in T9+ (M1 has sim only)"
        )

    return factory


def create_app(cfg: Config, manager: SessionManager | None = None) -> FastAPI:
    if manager is None:
        manager = SessionManager(cfg, feed_factory=_realtime_sim_factory(cfg))
    app = FastAPI(title="flowmap-server", version=__version__, docs_url=None, redoc_url=None)
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
