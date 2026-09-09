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

import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

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


def _error_response(code: str, message: str, status_code: int) -> JSONResponse:
    """One machine-readable error shape for the whole REST surface."""
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message}},
    )


def _install_error_handlers(app: FastAPI) -> None:
    """Structured JSON errors: ``{"error": {"code", "message"}}``.

    Replaces the framework defaults (Starlette's ``{"detail": ...}`` and
    FastAPI's verbose 422 ``detail`` list) so the client parses ONE shape.
    Status codes are preserved: 404 stays 404, validation stays 422
    (FastAPI's contract), only the BODY is normalized.
    """
    _HTTP_CODES = {
        400: "bad_request",
        401: "unauthorized",
        403: "forbidden",
        404: "not_found",
        405: "method_not_allowed",
        429: "rate_limited",
    }

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _HTTP_CODES.get(exc.status_code, "http_error")
        return _error_response(code, str(exc.detail), exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        parts = [
            f"{'.'.join(str(loc) for loc in err.get('loc', ()))}: {err.get('msg', 'invalid')}"
            for err in exc.errors()
        ]
        message = "; ".join(parts) if parts else "invalid request parameters"
        return _error_response("invalid_params", message, 422)

    @app.exception_handler(Exception)
    async def _internal_error(request: Request, exc: Exception) -> JSONResponse:
        # Never leak internals to the wire; the traceback stays in the log.
        return _error_response("internal_error", "internal server error", 500)


def _server_feed_factory(cfg: Config) -> Callable[[events.Subscribe], Feed]:
    """Server-path feed factory: realtime sim + live crypto/equity.

    Same routing as the test path (both go through ``feeds.router``); only the
    sim feed differs — ``realtime=True`` paces one interval per ``dt_ns`` of
    wall time, which keeps the event loop live and the demo stream watchable
    (4 columns/s at dt=250 ms).
    """
    return feed_factory(cfg, realtime_sim=True)


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Shutdown flush (spec §7): up to REC_FLUSH_COLS buffered columns plus
    trades per active session used to be lost on every sidecar kill. After
    uvicorn stops serving (loop still running), every session's buffered
    recording rows are flushed and awaited; failures inside the flush are
    logged and contained, never propagated into shutdown."""
    yield
    manager = getattr(app.state, "manager", None)
    flush_all = getattr(manager, "flush_all", None)
    if flush_all is not None:
        await flush_all()


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
    app = FastAPI(
        title="flowmap-server",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=_lifespan,
    )
    app.state.cfg = cfg
    app.state.manager = manager
    app.state.market_cache = market_cache
    # /health uptime anchor (monotonic — immune to wall-clock adjustments).
    app.state.started_monotonic_ns = time.monotonic_ns()
    _install_error_handlers(app)
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
