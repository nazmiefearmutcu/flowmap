"""Lifespan startup/shutdown: prewarm start-stop + recording flush.

Up to REC_FLUSH_COLS buffered columns plus trades per active session used
to be lost on every kill — ``create_app`` had no lifespan hook at all. The
shutdown phase now flushes every active session (``SessionManager.flush_all``)
while the loop is still running, before uvicorn tears it down.

The discovery cache's ``run_background`` prewarm is ALSO started/cancelled
here (survey-1 #3 — it was dead code with a docstring claiming otherwise), so
every test through this lifespan injects a no-network fake cache; a dedicated
test pins the start/cancel wiring.

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


class _FakePrewarmCache:
    """Lifespan prewarm stand-in: records start/cancel, no network, parks
    until cancelled like the real loop's sleep."""

    def __init__(self) -> None:
        self.started = False
        self.cancelled = False
        self.markets: tuple[str, ...] | None = None
        self.interval_s: float | None = None

    async def run_background(self, markets: tuple[str, ...], interval_s: float) -> None:
        self.started = True
        self.markets = markets
        self.interval_s = interval_s
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            self.cancelled = True
            raise


async def test_shutdown_flushes_buffered_columns(tmp_path):
    cfg = Config(data_dir=str(tmp_path), dt_crypto_ns=50_000_000)
    app = create_app(cfg, market_cache=_FakePrewarmCache())
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
    app = create_app(cfg, market_cache=_FakePrewarmCache())
    async with app.router.lifespan_context(app):
        pass  # enter + exit: lifespan shutdown must not raise


async def test_lifespan_starts_and_cancels_market_cache_prewarm(tmp_path):
    """The prewarm loop (crypto+equity, 30 s cadence) must actually run for
    the app's lifetime and be cancelled on shutdown — it used to never be
    started at all (survey-1 #3)."""
    cache = _FakePrewarmCache()
    cfg = Config(data_dir=str(tmp_path))
    app = create_app(cfg, market_cache=cache)
    async with app.router.lifespan_context(app):
        for _ in range(100):  # bounded await: let the task reach its first step
            if cache.started:
                break
            await asyncio.sleep(0)
        assert cache.started
        assert cache.markets == ("crypto", "equity")
        assert cache.interval_s == 30.0
    assert cache.cancelled
