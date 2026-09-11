"""MarketDataCache hardening tests (upgrade wave A2): bounded size + honest
error fallback.

The cache previously grew without bound (every symbol ever browsed stayed in
``_quotes`` forever); error fallbacks were already honest (stale + reachable
flags, stored entry untouched) — both behaviors are pinned here.
"""

from __future__ import annotations

import asyncio

from flowmap_server.api.market_cache import MarketDataCache, QuoteData


def _quote(market: str, symbol: str, price: float) -> QuoteData:
    return QuoteData(market=market, symbol=symbol, price=price)


def _make_cache(quotes: dict[str, QuoteData], *, max_entries: int):
    calls: list[str] = []

    async def quote_fn(market: str, symbol: str) -> QuoteData:
        calls.append(symbol)
        return quotes[symbol]

    async def movers_fn(market: str, limit: int) -> list[QuoteData]:
        return []

    cache = MarketDataCache(
        quote_fn=quote_fn,
        movers_fn=movers_fn,
        ttl_ns=10**12,  # effectively immortal entries: TTL never evicts
        max_entries=max_entries,
    )
    return cache, calls


async def test_quote_cache_bounded_oldest_evicted():
    quotes = {s: _quote("equity", s, 1.0) for s in ("A", "B", "C")}
    cache, calls = _make_cache(quotes, max_entries=2)

    await cache.quote("equity", "A")
    await cache.quote("equity", "B")
    assert len(cache._quotes) == 2
    await cache.quote("equity", "C")  # A is the oldest insert -> evicted
    assert len(cache._quotes) == 2
    assert ("equity", "A") not in cache._quotes

    # Re-reading A must hit the PROVIDER again (no ghost entry served).
    n_before = len(calls)
    await cache.quote("equity", "A")
    assert len(calls) == n_before + 1
    assert len(cache._quotes) == 2


async def test_quote_refresh_does_not_grow_store():
    quotes = {"A": _quote("equity", "A", 1.0)}
    cache, _ = _make_cache(quotes, max_entries=1)
    await cache.quote("equity", "A")
    await cache.quote("equity", "A")  # TTL-expired refresh, same key
    assert len(cache._quotes) == 1


async def test_provider_failure_serves_stale_copy_not_poisoned():
    """Error fallback: the last good value comes back flagged stale+unreachable
    and the STORED entry stays pristine, so a recovered provider replaces it."""
    good = _quote("equity", "A", 42.0)
    fail = {"on": False}
    now = {"t": 1_000}

    async def quote_fn(market: str, symbol: str) -> QuoteData:
        if fail["on"]:
            raise RuntimeError("provider down")
        return good

    async def movers_fn(market: str, limit: int) -> list[QuoteData]:
        return []

    cache = MarketDataCache(
        quote_fn=quote_fn,
        movers_fn=movers_fn,
        ttl_ns=5_000,
        clock=lambda: now["t"],  # injectable monotonic clock: age the entry
    )
    first = await cache.quote("equity", "A")
    assert first.price == 42.0 and first.reachable and not first.stale

    # Age the entry past the TTL so the next read attempts a real fetch.
    now["t"] = 10_000
    fail["on"] = True
    fallback = await cache.quote("equity", "A")
    assert fallback.price == 42.0
    assert fallback.stale and not fallback.reachable  # honestly flagged
    # Stored entry untouched by the fallback (it is a copy): no poisoning.
    stored = cache._quotes[("equity", "A")][1]
    assert stored.price == 42.0 and stored.reachable and not stored.stale


async def test_movers_store_bounded():
    async def quote_fn(market: str, symbol: str) -> QuoteData:
        return _quote(market, symbol, 1.0)

    async def movers_fn(market: str, limit: int) -> list[QuoteData]:
        return [_quote(market, f"{market}-{i}", float(i)) for i in range(limit)]

    cache = MarketDataCache(quote_fn=quote_fn, movers_fn=movers_fn, max_entries=2)
    for m in ("m1", "m2", "m3"):  # m1 evicted, exactly like quotes
        await cache.movers(m, limit=5)
    assert len(cache._movers) == 2
    assert "m1" not in cache._movers


async def test_movers_cache_not_poisoned_by_small_first_limit():
    """The cache always fetches a fixed max and slices per caller: a limit=5
    request must not cap a later limit=100 read for a whole TTL."""
    calls: list[int] = []

    async def quote_fn(market: str, symbol: str) -> QuoteData:
        return _quote(market, symbol, 1.0)

    async def movers_fn(market: str, limit: int) -> list[QuoteData]:
        calls.append(limit)
        return [_quote(market, f"M{i}", float(i)) for i in range(limit)]

    cache = MarketDataCache(quote_fn=quote_fn, movers_fn=movers_fn, ttl_ns=10**12)
    small = await cache.movers("crypto", limit=5)
    assert len(small) == 5
    big = await cache.movers("crypto", limit=100)
    assert len(big) == 100  # same cached fetch, larger slice
    assert calls == [100]  # provider asked for the fixed max once


async def test_movers_limit_hard_bounded_by_the_fetch_max():
    calls: list[int] = []

    async def quote_fn(market: str, symbol: str) -> QuoteData:
        return _quote(market, symbol, 1.0)

    async def movers_fn(market: str, limit: int) -> list[QuoteData]:
        calls.append(limit)
        return [_quote(market, f"M{i}", float(i)) for i in range(limit)]

    cache = MarketDataCache(quote_fn=quote_fn, movers_fn=movers_fn, ttl_ns=10**12)
    out = await cache.movers("crypto", limit=9999)
    assert len(out) == 100  # clamped to _MOVERS_MAX, never more than fetched
    assert calls == [100]


def test_movers_max_matches_the_discovery_clamp():
    """Two constants name the same clamp (the cache fetch width and the
    endpoint's query clamp); pin them equal so they cannot drift silently."""
    from flowmap_server.api import discovery, market_cache

    assert market_cache._MOVERS_MAX == discovery._MOVERS_MAX


# ---------------------------------------------------------------------------
# single-flight lock pruning (survey-1 #5: _release_lock ran while held)


async def test_quote_locks_pruned_after_fetch():
    quotes = {s: _quote("equity", s, 1.0) for s in ("A", "B")}
    cache, _ = _make_cache(quotes, max_entries=8)
    await cache.quote("equity", "A")
    await cache.quote("equity", "B")
    assert cache._quote_locks == {}  # one lock per symbol ever browsed = leak


async def test_movers_locks_pruned_after_fetch():
    async def quote_fn(market: str, symbol: str) -> QuoteData:
        return _quote(market, symbol, 1.0)

    async def movers_fn(market: str, limit: int) -> list[QuoteData]:
        return [_quote(market, f"M{i}", float(i)) for i in range(limit)]

    cache = MarketDataCache(quote_fn=quote_fn, movers_fn=movers_fn, ttl_ns=10**12)
    await cache.movers("crypto", limit=5)
    await cache.movers("equity", limit=5)
    assert cache._movers_locks == {}


async def test_single_flight_still_collapses_concurrent_reads_when_pruning():
    """Pruning must not break the single-flight guarantee: two concurrent
    reads of the same key still collapse into ONE provider call, and the
    lock is gone once both finish."""
    calls: list[str] = []

    async def quote_fn(market: str, symbol: str) -> QuoteData:
        calls.append(symbol)
        await asyncio.sleep(0.01)  # second caller must actually wait
        return _quote(market, symbol, 1.0)

    async def movers_fn(market: str, limit: int) -> list[QuoteData]:
        return []

    cache = MarketDataCache(quote_fn=quote_fn, movers_fn=movers_fn)
    a, b = await asyncio.gather(
        cache.quote("equity", "A"), cache.quote("equity", "A")
    )
    assert a.price == b.price == 1.0
    assert calls == ["A"]
    assert cache._quote_locks == {}


async def test_quote_lock_kept_while_a_waiter_still_holds_it():
    """The prune is guarded by ``locked()``: a cancel/error path must not pop
    a lock another coroutine is currently holding."""
    release = asyncio.Event()
    started = asyncio.Event()

    async def quote_fn(market: str, symbol: str) -> QuoteData:
        started.set()
        await release.wait()
        return _quote(market, symbol, 1.0)

    async def movers_fn(market: str, limit: int) -> list[QuoteData]:
        return []

    cache = MarketDataCache(quote_fn=quote_fn, movers_fn=movers_fn)
    first = asyncio.create_task(cache.quote("equity", "A"))
    await started.wait()
    second = asyncio.create_task(cache.quote("equity", "A"))
    await asyncio.sleep(0)  # second is now waiting on the same lock
    assert ("equity", "A") in cache._quote_locks
    release.set()
    await asyncio.gather(first, second)
    assert cache._quote_locks == {}
