"""Discovery REST tests (GOAL 2) — /universe, /movers, /quote + the TTL cache.

The universe endpoint is pure (bundled directory). Movers/quote run against a
canned :class:`MarketDataCache` injected into ``create_app`` — no network. Also
covers the cache directly: TTL debounce (per-keystroke calls collapse to one
provider hit) and the never-raise error fallback (stale / unreachable).
"""

from __future__ import annotations

import httpx
import pytest

from flowmap_server.api.app import create_app
from flowmap_server.api.market_cache import MarketDataCache, QuoteData
from flowmap_server.config import Config
from flowmap_server.data.universe import CRYPTO_SYMBOLS, EQUITY_TICKERS


class _Clock:
    def __init__(self) -> None:
        self.t = 0

    def __call__(self) -> int:
        return self.t


def _quote_fn(price=100.0, change=2.5, *, stale=False, reachable=True, counter=None):
    async def fn(market, symbol):
        if counter is not None:
            counter["n"] += 1
        return QuoteData(
            market=market, symbol=symbol, price=price, change_pct=change,
            spark=[1.0, 2.0, 3.0], as_of_ns=42, stale=stale, reachable=reachable,
        )

    return fn


def _movers_fn(rows):
    async def fn(market, limit):
        return [
            QuoteData(market=market, symbol=s, price=p, change_pct=c,
                      spark=[p], as_of_ns=7, stale=False)
            for s, p, c in rows
        ][:limit]

    return fn


def _make_client(cache: MarketDataCache | None):
    app = create_app(Config(), market_cache=cache)
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8720")


# --- /universe (pure) ----------------------------------------------------------


async def test_universe_returns_full_and_filters():
    async with _make_client(None) as c:
        r = await c.get("/api/universe")
        assert r.status_code == 200
        syms = r.json()["symbols"]
        # default limit caps the result; full universe is larger than the cap.
        assert len(syms) == 100

        r = await c.get("/api/universe", params={"market": "equity", "limit": 1000})
        names = {s["symbol"] for s in r.json()["symbols"]}
        assert names == set(EQUITY_TICKERS)
        assert all(s["market"] == "equity" for s in r.json()["symbols"])

        r = await c.get("/api/universe", params={"market": "crypto", "limit": 1000})
        names = {s["symbol"] for s in r.json()["symbols"]}
        assert names == set(CRYPTO_SYMBOLS)

        r = await c.get("/api/universe", params={"q": "btc", "market": "crypto"})
        assert {s["symbol"] for s in r.json()["symbols"]} == {"BTCUSDT"}


async def test_universe_capabilities_are_honest():
    async with _make_client(None) as c:
        r = await c.get("/api/universe", params={"q": "AAPL", "market": "equity"})
        entry = next(s for s in r.json()["symbols"] if s["symbol"] == "AAPL")
        assert entry["capability"]["depth"] == "SYNTH"
        assert entry["capability"]["cvd"] == "na"  # keyless equity: no honest CVD
        r = await c.get("/api/universe", params={"q": "ETHUSDT", "market": "crypto"})
        entry = next(s for s in r.json()["symbols"] if s["symbol"] == "ETHUSDT")
        assert entry["capability"]["cvd"] == "exchange"


# --- /movers -------------------------------------------------------------------


async def test_movers_json_shape():
    cache = MarketDataCache(
        quote_fn=_quote_fn(), movers_fn=_movers_fn([("AAA", 10.0, 8.0), ("BBB", 5.0, -3.0)])
    )
    async with _make_client(cache) as c:
        r = await c.get("/api/movers", params={"market": "crypto", "limit": 5})
        assert r.status_code == 200
        movers = r.json()["movers"]
        assert [m["symbol"] for m in movers] == ["AAA", "BBB"]
        m = movers[0]
        assert set(m) == {"market", "symbol", "price", "changePct", "spark", "asOf", "stale"}
        assert m["changePct"] == 8.0 and m["asOf"] == 7 and m["stale"] is False


async def test_movers_no_cache_is_empty():
    app = create_app(Config())
    app.state.market_cache = None  # simulate an unwired cache
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8720") as c:
        r = await c.get("/api/movers", params={"market": "crypto"})
        assert r.json() == {"movers": []}


# --- /quote --------------------------------------------------------------------


async def test_quote_json_shape_includes_reachable():
    cache = MarketDataCache(quote_fn=_quote_fn(price=250.0, change=1.2), movers_fn=_movers_fn([]))
    async with _make_client(cache) as c:
        r = await c.get("/api/quote", params={"market": "equity", "symbol": "aapl"})
        q = r.json()
        assert q["market"] == "equity" and q["symbol"] == "AAPL"
        assert q["price"] == 250.0 and q["changePct"] == 1.2
        assert q["reachable"] is True and q["stale"] is False
        assert q["spark"] == [1.0, 2.0, 3.0]


async def test_quote_market_closed_is_stale_not_a_live_print():
    cache = MarketDataCache(
        quote_fn=_quote_fn(price=200.0, change=0.0, stale=True), movers_fn=_movers_fn([])
    )
    async with _make_client(cache) as c:
        q = (await c.get("/api/quote", params={"market": "equity", "symbol": "SPY"})).json()
        assert q["stale"] is True  # closed/last-good -> never presented as live NBBO
        assert q["reachable"] is True


# --- cache internals -----------------------------------------------------------


async def test_cache_ttl_debounces_provider_calls():
    counter = {"n": 0}
    clock = _Clock()
    cache = MarketDataCache(
        quote_fn=_quote_fn(counter=counter), movers_fn=_movers_fn([]),
        ttl_ns=100, clock=clock,
    )
    await cache.quote("crypto", "BTCUSDT")
    await cache.quote("crypto", "BTCUSDT")  # within TTL -> cached, no 2nd call
    assert counter["n"] == 1
    clock.t = 200  # past TTL -> refetch
    await cache.quote("crypto", "BTCUSDT")
    assert counter["n"] == 2


async def test_cache_error_fallback_never_raises():
    async def boom(market, symbol):
        raise RuntimeError("provider down")

    cache = MarketDataCache(quote_fn=boom, movers_fn=_movers_fn([]))
    q = await cache.quote("equity", "AAPL")
    assert q.reachable is False and q.stale is True and q.price is None

    async def boom_movers(market, limit):
        raise RuntimeError("down")

    cache2 = MarketDataCache(quote_fn=_quote_fn(), movers_fn=boom_movers)
    assert await cache2.movers("crypto", 10) == []


async def test_cache_error_fallback_returns_last_good_stale():
    calls = {"n": 0}

    async def flaky(market, symbol):
        calls["n"] += 1
        if calls["n"] == 1:
            return QuoteData(market=market, symbol=symbol, price=99.0, change_pct=1.0,
                             as_of_ns=5, stale=False, reachable=True)
        raise RuntimeError("now down")

    clock = _Clock()
    cache = MarketDataCache(quote_fn=flaky, movers_fn=_movers_fn([]), ttl_ns=10, clock=clock)
    first = await cache.quote("equity", "AAPL")
    assert first.price == 99.0 and first.reachable is True
    clock.t = 100  # expire -> refetch raises -> last-good returned, flagged stale
    second = await cache.quote("equity", "AAPL")
    assert second.price == 99.0 and second.stale is True and second.reachable is False
