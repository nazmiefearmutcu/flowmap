"""Lifespan shutdown flush: buffered recording rows must hit disk when the
sidecar stops.

Up to REC_FLUSH_COLS buffered columns plus trades per active session used
to be lost on every kill — ``create_app`` had no lifespan hook at all. The
shutdown phase now flushes every active session (``SessionManager.flush_all``)
while the loop is still running, before uvicorn tears it down.

Runs against ``create_app``'s real wiring (Recorder rooted at ``data_dir``,
realtime sim feed) through the router's lifespan context — no network.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import polars as pl

from flowmap_server.api.app import create_app
from flowmap_server.config import Config
from flowmap_server.core.session import ClientTx
from flowmap_server.proto.events import Subscribe


async def test_shutdown_flushes_buffered_columns(tmp_path):
    cfg = Config(data_dir=str(tmp_path), dt_crypto_ns=50_000_000)
    app = create_app(cfg)
    manager = app.state.manager
    async with app.router.lifespan_context(app):
        client = ClientTx()
        sess = await manager.subscribe(
            Subscribe(
                market="sim", symbol="SIM-DEMO", mode="live", source=None, start_t=None
            ),
            client,
        )
        # A few finalized columns — far below the 64-column cadence, so
        # everything stays buffered while the server runs.
        async with asyncio.timeout(10):
            while sess._cols_since_flush < 3:
                client.drain(1 << 20)
                await asyncio.sleep(0.02)
        assert not list(Path(str(tmp_path)).rglob("*-columns-*.parquet"))

    # Lifespan shutdown ran flush_all: the buffered columns hit disk.
    parts = list(Path(str(tmp_path)).rglob("*-columns-*.parquet"))
    assert parts
    rows = pl.concat([pl.read_parquet(p) for p in parts])
    assert rows.height >= 3

    # Test cleanup: the session's run task outlives the lifespan here.
    sess.run_task.cancel()
    await asyncio.gather(sess.run_task, return_exceptions=True)


async def test_shutdown_flush_tolerates_manager_without_sessions(tmp_path):
    """Shutdown with no active sessions (the common restart case) is a
    no-op, not an error."""
    cfg = Config(data_dir=str(tmp_path))
    app = create_app(cfg)
    async with app.router.lifespan_context(app):
        pass  # enter + exit: lifespan shutdown must not raise
