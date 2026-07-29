"""``/api/venues`` (new) and the two-branch ``/api/universe``. NO network.

``/api/venues`` is the endpoint that makes the picker's venue list the engine's
list rather than a copy of it, and it is PURE — both venue tables are module
constants, so it is asserted straight through the ASGI transport.

``/api/universe`` grew a branch with the venue widening:

- ``all`` / ``crypto`` / ``equity`` / ``sim`` stay PURE and serve the bundled
  directory, so the first paint never waits on a venue. These tests prove that
  by making ``venue_symbols`` explode if it is ever reached.
- a specific crypto venue enumerates LIVE through ``venue_symbols`` (patched
  here) and, when the venue serves nothing, degrades to the bundled directory
  rather than to an error or an empty picker.

Style follows ``tests/api/test_discovery.py``: an httpx ASGI transport over
``create_app``, no lifespan, no sockets.
"""

from __future__ import annotations

import httpx
import pytest

from flowmap_server.api import discovery
from flowmap_server.api.app import create_app
from flowmap_server.config import Config
from flowmap_server.data.universe import CRYPTO_MARKET, CRYPTO_SYMBOLS
from flowmap_server.data.venues import venue_catalog
from flowmap_server.feeds.crypto import CryptoFeed


def _make_client():
    app = create_app(Config())
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8720")


def _patch_symbols(monkeypatch, fn) -> None:
    """Replace the ONE network seam the universe route can reach."""
    monkeypatch.setattr(discovery, "venue_symbols", fn)


def _never_called(monkeypatch, calls: list) -> None:
    async def boom(market, **kw):
        calls.append(market)
        raise AssertionError(f"aggregate market enumerated {market!r} live")

    _patch_symbols(monkeypatch, boom)


# --- GET /api/venues -----------------------------------------------------------


async def test_venues_route_shape() -> None:
    async with _make_client() as c:
        r = await c.get("/api/venues")
        assert r.status_code == 200
        body = r.json()
        assert set(body) == {"venues"}
        venues = body["venues"]
        assert venues == [v.as_dict() for v in venue_catalog()]
        for v in venues:
            assert set(v) == {"id", "assetClass", "depth", "native", "segments"}


async def test_venues_route_carries_the_whole_engine_venue_set() -> None:
    async with _make_client() as c:
        venues = (await c.get("/api/venues")).json()["venues"]
    by_id = {v["id"]: v for v in venues}

    assert [v["id"] for v in venues[:2]] == ["sim", "equity"]
    assert len(venues) > 100, "the picker got a shortlist, not the engine's table"
    # Native connector vs ccxt-served: the badge the client renders.
    assert by_id["binance"]["native"] is True
    assert by_id["binance"]["depth"] == "L2"
    assert by_id["kraken"]["native"] is False
    assert by_id["kraken"]["depth"] == "L2-snapshot"
    # Segments only where the connector takes one.
    assert by_id["binance"]["segments"] == ["spot", "usdm", "coinm"]
    assert by_id["bybit"]["segments"] == ["spot", "linear", "inverse", "option"]
    assert by_id["okx"]["segments"] == []
    # Non-streamable readers are not offered.
    for excluded in ("coingecko", "base_onchain", "gmx_synthetix", "superchain", "derive"):
        assert excluded not in by_id


async def test_venues_route_is_pure() -> None:
    """No network seam exists on this path at all — two calls, byte-identical."""
    async with _make_client() as c:
        first = (await c.get("/api/venues")).json()
        second = (await c.get("/api/venues")).json()
    assert first == second


async def test_venues_route_never_advertises_a_depth_the_feed_cannot_serve() -> None:
    from flowmap_server.api.rest import _equity_capability

    async with _make_client() as c:
        by_id = {v["id"]: v for v in (await c.get("/api/venues")).json()["venues"]}
    # Equity has no L2 tier (keyless is SYNTH, Alpaca is L1); claiming one here
    # would contradict what /api/universe reports for the same market.
    assert by_id["equity"]["depth"] == _equity_capability()["depth"]
    assert by_id["equity"]["depth"] != "L2"


async def test_venues_and_universe_agree_about_equity_depth() -> None:
    async with _make_client() as c:
        by_id = {v["id"]: v for v in (await c.get("/api/venues")).json()["venues"]}
        rows = (await c.get("/api/universe", params={"q": "AAPL", "market": "equity"})).json()
    entry = next(s for s in rows["symbols"] if s["symbol"] == "AAPL")
    assert by_id["equity"]["depth"] == entry["capability"]["depth"]


# --- /api/universe: the aggregate markets stay pure ----------------------------


@pytest.mark.parametrize("market", ["all", "crypto", "equity", "sim", ""])
async def test_aggregate_markets_never_enumerate_live(monkeypatch, market: str) -> None:
    """First paint must not wait on a venue REST call."""
    calls: list[str] = []
    _never_called(monkeypatch, calls)
    async with _make_client() as c:
        r = await c.get("/api/universe", params={"market": market, "limit": 1000})
        assert r.status_code == 200
        assert r.json()["symbols"]
    assert calls == []


async def test_unknown_market_stays_on_the_bundled_path(monkeypatch) -> None:
    """A non-venue string must not reach the enumerator either."""
    calls: list[str] = []
    _never_called(monkeypatch, calls)
    async with _make_client() as c:
        r = await c.get("/api/universe", params={"market": "nasdaq"})
    assert r.status_code == 200
    assert r.json()["symbols"] == []
    assert calls == []


# --- /api/universe: a specific venue enumerates live ---------------------------


async def test_named_venue_enumerates_live(monkeypatch) -> None:
    seen: list[str] = []

    async def fake(market: str) -> list[str]:
        seen.append(market)
        return ["AAAUSD", "BBBUSD", "CCCUSD"]

    _patch_symbols(monkeypatch, fake)
    async with _make_client() as c:
        rows = (await c.get("/api/universe", params={"market": "kraken"})).json()["symbols"]

    assert seen == ["kraken"]
    assert [s["symbol"] for s in rows] == ["AAAUSD", "BBBUSD", "CCCUSD"]
    assert all(s["market"] == "kraken" for s in rows)
    # A ccxt-served venue is badged honestly: whole-book re-read, no gap marker.
    cap = rows[0]["capability"]
    assert cap["depth"] == "L2-snapshot"
    assert cap["markers"] == []
    assert cap["tape"] == "tick" and cap["cvd"] == "exchange"


async def test_named_native_venue_with_a_segment_is_badged_l2(monkeypatch) -> None:
    async def fake(market: str) -> list[str]:
        assert market == "binance-usdm"  # the segment reaches the enumerator
        return ["BTCUSDT", "ETHUSDT"]

    _patch_symbols(monkeypatch, fake)
    async with _make_client() as c:
        rows = (await c.get("/api/universe", params={"market": "binance-usdm"})).json()["symbols"]

    assert [s["symbol"] for s in rows] == ["BTCUSDT", "ETHUSDT"]
    assert rows[0]["capability"]["depth"] == "L2"
    assert rows[0]["market"] == "binance-usdm"
    # The directory reports exactly what a subscribe delivers — including the
    # liquidation marker that only the futures segments carry. It is built from
    # the feed, so it cannot drift into under- or over-promising.
    feed_capability = CryptoFeed(
        exchange="binance", symbol="BTCUSDT", market="usdm", cfg=Config()
    ).capability
    assert rows[0]["capability"] == feed_capability
    assert "liquidation" in rows[0]["capability"]["markers"]


async def test_live_enumeration_honours_q_and_limit(monkeypatch) -> None:
    async def fake(market: str) -> list[str]:
        return [f"{p}USDT" for p in ("BTC", "ETH", "SOL", "BTCDOWN", "XBT")]

    _patch_symbols(monkeypatch, fake)
    async with _make_client() as c:
        rows = (
            await c.get("/api/universe", params={"market": "kraken", "q": "btc"})
        ).json()["symbols"]
        assert [s["symbol"] for s in rows] == ["BTCUSDT", "BTCDOWNUSDT"]  # case-insensitive

        rows = (
            await c.get("/api/universe", params={"market": "kraken", "limit": 2})
        ).json()["symbols"]
        assert [s["symbol"] for s in rows] == ["BTCUSDT", "ETHUSDT"]


# --- /api/universe: the fallback -----------------------------------------------


async def test_empty_venue_falls_back_to_the_bundled_directory(monkeypatch) -> None:
    """An unreachable venue degrades to the bundled shortlist, not to an error.

    ``binance-spot`` is the bundled directory's own crypto market, so the
    fallback is observable rather than vacuous.
    """
    async def empty(market: str) -> list[str]:
        return []

    _patch_symbols(monkeypatch, empty)
    async with _make_client() as c:
        r = await c.get("/api/universe", params={"market": CRYPTO_MARKET, "limit": 1000})
    assert r.status_code == 200
    rows = r.json()["symbols"]
    assert {s["symbol"] for s in rows} == set(CRYPTO_SYMBOLS)
    assert all(s["market"] == CRYPTO_MARKET for s in rows)
    # The bundled rows say so, so the client can tell a shortlist from a listing.
    assert all("note" in s for s in rows)


async def test_fallback_still_applies_q(monkeypatch) -> None:
    async def empty(market: str) -> list[str]:
        return []

    _patch_symbols(monkeypatch, empty)
    async with _make_client() as c:
        rows = (
            await c.get("/api/universe", params={"market": CRYPTO_MARKET, "q": "eth"})
        ).json()["symbols"]
    assert [s["symbol"] for s in rows] == ["ETHUSDT"]


async def test_live_listing_wins_over_the_bundled_shortlist(monkeypatch) -> None:
    """The whole point of the branch: a live venue is not shadowed by the
    bundled 40-symbol list for the same market string."""
    async def fake(market: str) -> list[str]:
        return ["ZZZUSDT"]

    _patch_symbols(monkeypatch, fake)
    async with _make_client() as c:
        rows = (
            await c.get("/api/universe", params={"market": CRYPTO_MARKET, "limit": 1000})
        ).json()["symbols"]
    assert [s["symbol"] for s in rows] == ["ZZZUSDT"]
    assert "note" not in rows[0]
