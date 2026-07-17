"""``python -m flowmap_server`` — run the app under uvicorn (spec §11).

Config is env-first via :meth:`Config.from_env`; the loopback-only bind is
enforced twice: ``from_env`` raises on a non-loopback ``FLOWMAP_HOST``, and
the assert below keeps the invariant visible at the entrypoint.
"""

from __future__ import annotations

import os

import uvicorn

from flowmap_server.api.app import create_app
from flowmap_server.config import Config


def main() -> None:
    cfg = Config.from_env(os.environ)
    assert cfg.host in ("127.0.0.1", "localhost"), (
        f"loopback only (spec §11): refusing to bind {cfg.host!r}"
    )
    uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port, log_level="info")


if __name__ == "__main__":
    main()
