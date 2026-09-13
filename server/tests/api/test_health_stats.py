"""Health v3 `stats` key (campaign SB item 1, contract C1).

The core lane (SA) ships a `SessionStats` producer; contract C1 freezes the
snapshot field names and SB must render `snapshot()` VERBATIM under
`/api/health`'s `stats` key without reshaping. Until/unless the producer is
mounted on the manager, health degrades to `stats: null` +
`stats_available: false` and MUST NOT 500.

These tests run against a FAKE hub exposing a `stats` object with a
`snapshot()` returning the C1 dict shape, so they pass independently of when
SA's producer lands. If SA later changes the shape, only the verbatim-
equality assertion follows it (that is the contract working as intended).
"""

from __future__ import annotations

import httpx
import pytest

from flowmap_server import __version__
from flowmap_server.api.app import create_app
from flowmap_server.config import Config
from flowmap_server.proto import wire

# Contract C1 field names, verbatim (minimum shape).
C1_SNAPSHOT: dict = {
    "drops": {"feed": 1, "tx_lag": 2, "snapshot": 3},
    "restarts": 0,
    "sessions": {"active": 1, "rejected": 0},
    "latency_ms": 12.5,
    "staleness_ms": {"crypto": 40.0},
    "clock_skew_ms": -3.25,
    "recording": {
        "enabled": True,
        "flush_failures": 0,
        "last_flush_ts": None,
        "flush_stalls": 0,
        "last_flush_age_s": None,
        "stalled": False,
    },
}


class _FakeStats:
    """Stand-in for SA's SessionStats producer."""

    def __init__(self, payload: dict | None = C1_SNAPSHOT, raises: bool = False):
        self._payload = payload
        self._raises = raises

    def snapshot(self) -> dict:
        if self._raises:
            raise RuntimeError("producer exploded")
        if self._payload is None:
            raise AssertionError("snapshot() should not be called")
        return self._payload


class _NotAProducer:
    """Has a `snapshot` attribute that is not callable — must be ignored."""


@pytest.fixture
def app():
    return create_app(Config())


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://127.0.0.1:8720"
    ) as c:
        yield c


def _set_stats(app, value) -> None:
    app.state.manager.stats = value


def _clear_stats(app) -> None:
    if "stats" in app.state.manager.__dict__:
        del app.state.manager.__dict__["stats"]


async def test_health_without_stats_producer_degrades_to_null(app, client):
    _clear_stats(app)
    r = await client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["stats"] is None
    assert body["stats_available"] is False


async def test_health_renders_c1_snapshot_verbatim(app, client):
    """The stats dict must reach the wire UNRESHAPED: same keys, same values,
    same nesting (C1 freezes the names; this surface is a pass-through)."""
    _set_stats(app, _FakeStats())
    try:
        r = await client.get("/api/health")
        assert r.status_code == 200
        body = r.json()
        assert body["stats_available"] is True
        assert body["stats"] == C1_SNAPSHOT
        # Verbatim means keys survive exactly — spot-check the nested ones.
        assert body["stats"]["drops"] == {"feed": 1, "tx_lag": 2, "snapshot": 3}
        assert body["stats"]["recording"]["flush_failures"] == 0
        assert body["stats"]["latency_ms"] == 12.5
    finally:
        _clear_stats(app)


async def test_health_extra_snapshot_keys_pass_through(app, client):
    """C1 is a minimum shape: producer additions surface untouched."""
    payload = dict(C1_SNAPSHOT)
    payload["events_in"] = 4242
    _set_stats(app, _FakeStats(payload))
    try:
        body = (await client.get("/api/health")).json()
        assert body["stats"]["events_in"] == 4242
    finally:
        _clear_stats(app)


async def test_health_broken_producer_never_500s(app, client):
    _set_stats(app, _FakeStats(raises=True))
    try:
        r = await client.get("/api/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["stats"] is None
        assert body["stats_available"] is False
    finally:
        _clear_stats(app)


async def test_health_non_callable_snapshot_ignored(app, client):
    _set_stats(app, _NotAProducer())
    try:
        body = (await client.get("/api/health")).json()
        assert body["stats"] is None
        assert body["stats_available"] is False
    finally:
        _clear_stats(app)


async def test_health_v3_keeps_every_legacy_field(client):
    r = await client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["version"] == __version__
    assert body["protocol_version"] == wire.PROTO_VER
    assert isinstance(body["uptime_s"], (int, float)) and body["uptime_s"] >= 0.0
    assert isinstance(body["recording_enabled"], bool)
    assert body["active_sessions"] == 0
    assert body["feeds"] == []
