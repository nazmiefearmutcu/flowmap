"""WS origin gate + per-process connection cap (campaign SB item 2).

Unit half: the policy function against an env dict (production reads
``os.environ`` at CALL time, so monkeypatched env reaches a LIVE server too).
E2E half: a real uvicorn boot where browser-like clients (Origin header set)
are accepted or closed with an honest close code — 1008 for a disallowed
origin, 1013 when the FLOWMAP_WS_MAX_CONNECTIONS cap is full.
"""

from __future__ import annotations

import asyncio
import socket

import httpx
import pytest
import uvicorn
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from flowmap_server.api import _env
from flowmap_server.api.app import create_app
from flowmap_server.config import Config
from flowmap_server.proto import events, wire

SUB = events.Subscribe(market="sim", symbol="SIM-DEMO", mode="live")


def decode_frame(buf: bytes) -> list:
    out = []
    offset = 0
    while offset < len(buf):
        ev, offset = wire.decode(buf, offset)
        if ev is not None:
            out.append(ev)
    return out


# --- unit: the policy function -------------------------------------------------


@pytest.mark.parametrize(
    "origin,expected",
    [
        (None, True),  # non-browser client
        ("", True),
        ("   ", True),
        ("http://127.0.0.1:5173", True),
        ("http://127.0.0.1:0", True),  # any port
        ("http://localhost:3000", True),
        ("http://[::1]:5173", True),  # IPv6 loopback: same trust as 127.0.0.1
        ("HTTP://LocalHost:5173", True),  # normalized to lowercase
        ("tauri://localhost", True),
        ("https://tauri.localhost", True),
        ("https://127.0.0.1:5173", False),  # policy is http-only for loopback
        ("https://[::1]:5173", False),
        ("http://[fe80::1]:5173", False),  # IPv6 loopback only, not any v6 host
        ("http://evil.example", False),
        ("http://localhost.evil.example", False),
        ("ftp://localhost", False),
        ("tauri://evil.example", False),
    ],
)
def test_origin_policy_builtin(origin, expected):
    assert _env.origin_allowed(origin, environ={}) is expected


def test_origin_policy_env_replaces_the_browser_allow_list():
    env = {"FLOWMAP_WS_ALLOWED_ORIGINS": "https://good.example, http://else.example"}
    assert _env.origin_allowed("https://good.example", env)
    assert _env.origin_allowed("http://else.example", env)
    # the built-in browser origins are overridden away...
    assert not _env.origin_allowed("http://127.0.0.1:5173", env)
    assert not _env.origin_allowed("tauri://localhost", env)
    # ...but absent Origin (non-browser) is still accepted
    assert _env.origin_allowed(None, env)


def test_origin_policy_env_star_disables_the_check():
    env = {"FLOWMAP_WS_ALLOWED_ORIGINS": "*"}
    assert _env.origin_allowed("http://evil.example", env)
    assert _env.origin_allowed("anything://anywhere", env)


def test_ws_max_connections_env():
    assert _env.ws_max_connections(environ={}) == 16
    assert _env.ws_max_connections(
        environ={"FLOWMAP_WS_MAX_CONNECTIONS": "3"}
    ) == 3
    assert _env.ws_max_connections(
        environ={"FLOWMAP_WS_MAX_CONNECTIONS": "0"}
    ) == 1  # clamps to >= 1
    assert _env.ws_max_connections(
        environ={"FLOWMAP_WS_MAX_CONNECTIONS": "-4"}
    ) == 1
    for junk in ("", "   ", "many", "3.5"):
        assert _env.ws_max_connections(
            environ={"FLOWMAP_WS_MAX_CONNECTIONS": junk}
        ) == 16


# --- e2e: real server, browser-like clients -------------------------------------


@pytest.fixture
def port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def _boot_server(cfg: Config):
    app = create_app(cfg)
    srv = uvicorn.Server(
        uvicorn.Config(app, host=cfg.host, port=cfg.port, log_level="warning")
    )
    task = asyncio.create_task(srv.serve(), name="uvicorn-ws-gate")
    async with httpx.AsyncClient() as probe:
        for _ in range(200):
            try:
                r = await probe.get(f"http://127.0.0.1:{cfg.port}/api/health")
                if r.status_code == 200:
                    break
            except httpx.TransportError:
                pass
            await asyncio.sleep(0.025)
        else:
            task.cancel()
            raise RuntimeError("uvicorn did not become ready")
    return app, srv, task


async def _stop_server(app, srv, task) -> None:
    srv.should_exit = True
    await task
    for session in list(app.state.manager._sessions.values()):
        if session.run_task is not None:
            session.run_task.cancel()
    await asyncio.sleep(0)


@pytest.fixture
async def server(port, tmp_path):
    cfg = Config(port=port, data_dir=str(tmp_path / "rec"))
    app, srv, task = await _boot_server(cfg)
    yield port
    await _stop_server(app, srv, task)


async def _expect_hello(port: int, **kwargs) -> None:
    async with connect(f"ws://127.0.0.1:{port}/ws", **kwargs) as ws:
        await ws.send(wire.encode(SUB))
        async with asyncio.timeout(10):
            while True:
                if any(
                    isinstance(e, events.Hello) for e in decode_frame(await ws.recv())
                ):
                    return


@pytest.mark.parametrize(
    "origin",
    [
        None,  # no Origin header at all (the python client's default)
        "http://127.0.0.1:5173",
        "http://localhost:8123",
        "tauri://localhost",
        "https://tauri.localhost",
    ],
)
async def test_allowed_origins_stream_normally(server, origin):
    kwargs = {} if origin is None else {"origin": origin}
    await _expect_hello(server, **kwargs)


async def test_disallowed_origin_gets_1008_with_honest_reason(server):
    ws = await connect(f"ws://127.0.0.1:{server}/ws", origin="http://evil.example")
    with pytest.raises(ConnectionClosed) as ei:
        async with asyncio.timeout(5):
            async for _ in ws:
                pass
    assert ei.value.rcvd is not None
    assert ei.value.rcvd.code == 1008
    assert "origin" in (ei.value.rcvd.reason or "").lower()


async def test_env_override_allows_listed_and_rejects_builtin(server, monkeypatch):
    monkeypatch.setenv("FLOWMAP_WS_ALLOWED_ORIGINS", "https://good.example")
    await _expect_hello(server, origin="https://good.example")
    ws = await connect(f"ws://127.0.0.1:{server}/ws", origin="http://127.0.0.1:5173")
    with pytest.raises(ConnectionClosed) as ei:
        async with asyncio.timeout(5):
            async for _ in ws:
                pass
    assert ei.value.rcvd is not None and ei.value.rcvd.code == 1008


async def test_env_star_disables_the_gate(server, monkeypatch):
    monkeypatch.setenv("FLOWMAP_WS_ALLOWED_ORIGINS", "*")
    await _expect_hello(server, origin="http://evil.example")


async def test_connection_cap_rejects_with_1013_then_frees(server, monkeypatch):
    monkeypatch.setenv("FLOWMAP_WS_MAX_CONNECTIONS", "1")
    async with connect(f"ws://127.0.0.1:{server}/ws") as first:
        await first.send(wire.encode(SUB))
        async with asyncio.timeout(10):
            while not any(
                isinstance(e, events.Hello) for e in decode_frame(await first.recv())
            ):
                pass

        # Cap is full: the next connection is accepted then closed 1013.
        second = await connect(f"ws://127.0.0.1:{server}/ws")
        with pytest.raises(ConnectionClosed) as ei:
            async with asyncio.timeout(5):
                async for _ in second:
                    pass
        assert ei.value.rcvd is not None
        assert ei.value.rcvd.code == 1013
        assert "try again later" in (ei.value.rcvd.reason or "")

        # Closing the first client frees its slot for the next one.
        await first.close()
        await asyncio.sleep(0.2)
        await _expect_hello(server)


async def test_origin_refusal_does_not_consume_a_cap_slot(server, monkeypatch):
    monkeypatch.setenv("FLOWMAP_WS_MAX_CONNECTIONS", "1")
    # Burn one rejection (does NOT occupy the single slot)...
    ws = await connect(f"ws://127.0.0.1:{server}/ws", origin="http://evil.example")
    with pytest.raises(ConnectionClosed):
        async with asyncio.timeout(5):
            async for _ in ws:
                pass
    # ...the legit client still fits under the cap.
    await _expect_hello(server)


def test_connection_counter_is_per_app_state():
    """Two apps in one process must not share the counter (production runs
    one app per uvicorn process; tests boot several in-process)."""
    app_a = create_app(Config())
    app_b = create_app(Config())
    assert app_a.state.ws_live_connections == 0
    assert app_b.state.ws_live_connections == 0
    app_a.state.ws_live_connections += 5
    assert app_b.state.ws_live_connections == 0
