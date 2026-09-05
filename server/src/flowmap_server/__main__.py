"""``python -m flowmap_server`` — run the app under uvicorn (spec §11).

Config is env-first via :meth:`Config.from_env`; the loopback-only bind is
enforced twice: ``from_env`` raises on a non-loopback ``FLOWMAP_HOST``, and
the explicit check below keeps the invariant visible at the entrypoint
(and survives ``python -O``).
"""

from __future__ import annotations

import logging
import os

import uvicorn

from flowmap_server.api.app import create_app
from flowmap_server.config import Config

__all__ = ["main", "configure_logging"]

# Set once configure_logging() has run; a second call is a no-op so re-entry
# (tests, embedders) cannot stack duplicate handlers on the root logger.
_configured = False


def configure_logging(level: str = "info", log_file: str | None = None) -> None:
    """Route ALL ``flowmap_server.*`` log records to stderr (+ optional file).

    Why this exists: uvicorn's default dictConfig wires only the ``uvicorn.*``
    loggers and leaves the ROOT logger handler-less. Module loggers such as
    ``flowmap_server.api.ws`` (refused-subscribe warnings, dead-peer aborts)
    then fall through to ``logging.lastResort`` — unformatted, stderr-only,
    and lost entirely when the desktop wrapper captures stdout or a log file
    instead of stderr. basicConfig runs BEFORE ``uvicorn.run`` applies its own
    config (``disable_existing_loggers: False``), so the two coexist: uvicorn
    keeps its access/error handlers, our records reach the root handler.

    ``level``/``log_file`` default to the ``FLOWMAP_LOG_LEVEL`` (already
    existed) and ``FLOWMAP_LOG_FILE`` (new, optional) env vars at the call
    site in :func:`main`.
    """
    global _configured
    if _configured:
        return
    _configured = True
    fmt = logging.Formatter(
        "%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S"
    )
    root = logging.getLogger()
    root.setLevel(level.upper())
    stream = logging.StreamHandler()  # stderr: uvicorn's own default channel
    stream.setFormatter(fmt)
    root.addHandler(stream)
    if log_file:
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setFormatter(fmt)
        root.addHandler(file_handler)


def main() -> None:
    cfg = Config.from_env(os.environ)
    if cfg.host not in ("127.0.0.1", "localhost"):  # survives python -O, unlike assert
        raise SystemExit(f"loopback only (spec §11): refusing to bind {cfg.host!r}")
    log_level = os.environ.get("FLOWMAP_LOG_LEVEL", "info")
    configure_logging(log_level, os.environ.get("FLOWMAP_LOG_FILE") or None)
    uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port, log_level=log_level)


if __name__ == "__main__":
    main()
