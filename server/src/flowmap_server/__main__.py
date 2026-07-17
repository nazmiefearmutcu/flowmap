"""``python -m flowmap_server`` — run the app under uvicorn (spec §11).

Config is env-first via :meth:`Config.from_env`; the loopback-only bind is
enforced twice: ``from_env`` raises on a non-loopback ``FLOWMAP_HOST``, and
the explicit check below keeps the invariant visible at the entrypoint
(and survives ``python -O``).
"""

from __future__ import annotations

import os

import uvicorn

from flowmap_server.api.app import create_app
from flowmap_server.config import Config


def main() -> None:
    cfg = Config.from_env(os.environ)
    if cfg.host not in ("127.0.0.1", "localhost"):  # survives python -O, unlike assert
        raise SystemExit(f"loopback only (spec §11): refusing to bind {cfg.host!r}")
    log_level = os.environ.get("FLOWMAP_LOG_LEVEL", "info")
    uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port, log_level=log_level)


if __name__ == "__main__":
    main()
