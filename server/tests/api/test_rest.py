"""REST surface tests (M1 plan Task 8; equity capability M3 T2): /api/health,
/api/symbols, CORS.

Runs against ``create_app`` through httpx's ASGITransport — no real server,
no network. The symbol directory is: the sim symbol (capability taken from
SimFeed) + a static crypto shortlist (noted "live in T9") + a static equity
shortlist whose capability is read off EquityFeed (live keyless SYNTH tier,
no note); handlers must never do network I/O.
"""

from __future__ import annotations

import httpx
import pytest

from flowmap_server import __version__
from flowmap_server.api.app import create_app
from flowmap_server.config import Config


@pytest.fixture
def app():
    return create_app(Config())


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8720") as c:
        yield c


async def test_health(client):
    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "version": __version__}


async def test_symbols_sim_capability_from_simfeed(client):
    r = await client.get("/api/symbols", params={"q": "sim"})
    assert r.status_code == 200
    entry = next(s for s in r.json()["symbols"] if s["symbol"] == "SIM-DEMO")
    assert entry["market"] == "sim"
    assert entry["capability"]["depth"] == "L2"
    assert "note" not in entry  # sim is fully live at M1


async def test_symbols_crypto_shortlist(client):
    r = await client.get("/api/symbols", params={"q": "btc"})
    entry = next(s for s in r.json()["symbols"] if s["symbol"] == "BTCUSDT")
    assert entry["market"] == "binance-spot"
    assert entry["capability"] == {"depth": "L2", "tape": "tick"}
    assert entry["note"] == "live in T9"


async def test_symbols_equity_shortlist(client):
    r = await client.get("/api/symbols", params={"q": "aapl"})
    entry = next(s for s in r.json()["symbols"] if s["symbol"] == "AAPL")
    assert entry["market"] == "equity"
    # Honest capability mirrored from EquityFeed's keyless tier (M3 T2).
    assert entry["capability"]["depth"] == "SYNTH"
    assert entry["capability"]["tape"] == "poll"
    assert entry["capability"]["trade_side"] == "na"
    assert "note" not in entry  # equity is live (keyless SYNTH), like sim


async def test_symbols_empty_q_returns_all(client):
    r = await client.get("/api/symbols")
    syms = r.json()["symbols"]
    names = {s["symbol"] for s in syms}
    assert {
        "SIM-DEMO",
        "BTCUSDT", "ETHUSDT", "SOLUSDT",
        "AAPL", "MSFT", "NVDA", "TSLA", "SPY",
    } <= names
    assert len(syms) == 9  # 1 sim + 3 crypto + 5 equity at M1


async def test_symbols_filter_case_insensitive_substring(client):
    r = await client.get("/api/symbols", params={"q": "Usdt"})
    names = {s["symbol"] for s in r.json()["symbols"]}
    assert names == {"BTCUSDT", "ETHUSDT", "SOLUSDT"}
    r = await client.get("/api/symbols", params={"q": "zzz-no-match"})
    assert r.json()["symbols"] == []


async def test_cors_allowed_origins(client):
    # Vite dev origins + the packaged desktop webview origin (Tauri serves the
    # SPA from tauri://localhost and fetches /api/symbols cross-origin).
    for origin in (
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "tauri://localhost",
    ):
        r = await client.get("/api/health", headers={"origin": origin})
        assert r.headers.get("access-control-allow-origin") == origin


async def test_cors_evil_origin_gets_no_header(client):
    r = await client.get("/api/health", headers={"origin": "http://evil.example"})
    assert "access-control-allow-origin" not in r.headers


async def test_cors_preflight_blocks_evil_origin_and_non_get(client):
    ok = await client.options(
        "/api/symbols",
        headers={
            "origin": "http://127.0.0.1:5173",
            "access-control-request-method": "GET",
        },
    )
    assert ok.status_code == 200
    bad_origin = await client.options(
        "/api/symbols",
        headers={
            "origin": "http://evil.example",
            "access-control-request-method": "GET",
        },
    )
    assert bad_origin.status_code == 400
    bad_method = await client.options(
        "/api/symbols",
        headers={
            "origin": "http://127.0.0.1:5173",
            "access-control-request-method": "POST",
        },
    )
    assert bad_method.status_code == 400
