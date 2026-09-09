"""Crypto grid tick resolution (FLOWMAP_CRYPTO_TICK / preferred_tick).

The default crypto grid tick is the sim-shaped 0.5, scaled by tick_multiple
on re-anchor — correct for majors, but a sub-cent coin collapses into 1-2
rows. These tests pin the resolution order: an explicit config override
wins, a feed-declared ``preferred_tick`` comes next, the fallback last;
invalid values are treated as "no answer", never trusted.
"""

from __future__ import annotations

import math
from types import SimpleNamespace

from flowmap_server.config import Config
from flowmap_server.core.session import SessionManager, _crypto_tick_for

import pytest


class FakeTimer:
    """SessionManager only needs a monotonic-ish clock for these tests."""

    def now_ns(self) -> int:  # pragma: no cover - name matches the real seam
        return 0


def _crypto_feed(**attrs: object) -> SimpleNamespace:
    base = {"market": "binance-spot", "symbol": "PEPEUSDT", "capability": {}}
    base.update(attrs)
    return SimpleNamespace(**base)


def test_fallback_is_the_sim_shaped_tick_when_nothing_declares() -> None:
    assert _crypto_tick_for(_crypto_feed(), 0.0) == 0.5


def test_feed_declared_preferred_tick_wins_over_fallback() -> None:
    assert _crypto_tick_for(_crypto_feed(preferred_tick=1e-6), 0.0) == 1e-6


def test_config_override_wins_over_feed_declaration() -> None:
    assert _crypto_tick_for(_crypto_feed(preferred_tick=1e-6), 0.01) == 0.01


@pytest.mark.parametrize("bad", [0, -1.0, float("nan"), float("inf")])
def test_invalid_values_are_never_trusted(bad: float) -> None:
    assert _crypto_tick_for(_crypto_feed(preferred_tick=bad), 0.0) == 0.5
    assert _crypto_tick_for(_crypto_feed(), bad) == 0.5


def test_grid_for_builds_with_the_declared_tick() -> None:
    cfg = Config()
    mgr = SessionManager(cfg, timer=FakeTimer())
    grid = mgr._grid_for(_crypto_feed(preferred_tick=1e-6))
    assert grid._cfg.tick == 1e-6
    # The nominal p0 anchor still sits on the tick grid.
    step = grid._step
    assert math.isclose(grid._p0 / step, round(grid._p0 / step), abs_tol=1e-9)


def test_grid_for_default_matches_the_old_fallback() -> None:
    cfg = Config()
    mgr = SessionManager(cfg, timer=FakeTimer())
    grid = mgr._grid_for(_crypto_feed())
    assert grid._cfg.tick == 0.5
