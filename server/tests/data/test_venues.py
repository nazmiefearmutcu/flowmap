"""``data.venues`` — the live venue/symbol enumerator. NO network.

Three surfaces, three very different cost profiles:

- :func:`venue_catalog` is PURE (both venue lists are module constants), so it
  is asserted directly: what is in it, what is deliberately NOT, and that the
  depth badge it publishes matches the feed that will actually serve the venue.
- :func:`ccxt_knows` exists ONLY because it differs from the engine's
  ``factory.is_ccxt_exchange``; that difference is asserted explicitly, because
  if the two ever agreed the function would be dead code and the five
  native+ccxt venues would silently lose symbol translation and kline backfill.
- :func:`venue_symbols` is the one network path, so every test here monkeypatches
  ``_list_symbols``: the TTL cache, the single-flight lock, the never-raise
  contract, and the "keep the last good list" rule are all pinned against a
  fake fetch and an injected clock (``now_ns``).
"""

from __future__ import annotations

import asyncio

import pytest
from crocodile.crypto.exchanges.factory import is_ccxt_exchange

from flowmap_server.data import venues
from flowmap_server.data.venues import (
    SYMBOL_TTL_NS,
    VenueInfo,
    ccxt_knows,
    resolve_symbol,
    venue_catalog,
    venue_symbols,
)
from flowmap_server.feeds.crypto import (
    CRYPTO_EXCHANGES,
    NATIVE_EXCHANGES,
    NOT_STREAMABLE,
    is_crypto_market,
)

# Reachable, but they cannot serve a live order-flow view: CoinGecko publishes
# one 24 h candle per coin and the on-chain readers surface pool events rather
# than a book. Listing them would promise a chart they cannot draw.

# The five venues that have BOTH a hand-written connector and a ccxt driver —
# the whole reason `ccxt_knows` is not `is_ccxt_exchange`.
DUAL_VENUES = ("binance", "bybit", "coinbase", "deribit", "okx")


@pytest.fixture(autouse=True)
def _isolate_symbol_cache():
    """``_cache``/``_locks`` are module globals; a leak across tests would make
    the TTL assertions order-dependent."""
    venues._cache.clear()
    venues._locks.clear()
    yield
    venues._cache.clear()
    venues._locks.clear()


def _by_id(catalog: list[VenueInfo]) -> dict[str, VenueInfo]:
    return {v.id: v for v in catalog}


# --- venue_catalog (pure) ------------------------------------------------------


def test_catalog_leads_with_sim_and_equity() -> None:
    catalog = venue_catalog()
    assert [v.id for v in catalog[:2]] == ["sim", "equity"]
    assert catalog[0].asset_class == "sim"
    assert catalog[1].asset_class == "equity"
    assert all(v.asset_class == "crypto" for v in catalog[2:])
    # Crypto ids are sorted, so the picker's order is stable across runs.
    crypto_ids = [v.id for v in catalog[2:]]
    assert crypto_ids == sorted(crypto_ids)


def test_catalog_is_the_whole_reachable_crypto_set_minus_the_unstreamable() -> None:
    catalog = venue_catalog()
    listed = {v.id for v in catalog if v.asset_class == "crypto"}
    assert listed == set(CRYPTO_EXCHANGES)
    assert len(listed) > 100, "ccxt venues missing — is the `market` extra installed?"
    # The exclusion lives in the venue set itself, not in this projection: the
    # catalog and the router must never disagree about what is subscribable.
    for excluded in NOT_STREAMABLE:
        assert excluded not in CRYPTO_EXCHANGES
        assert excluded not in listed
        assert not is_crypto_market(excluded)


def test_catalog_native_flags_match_the_engines_connector_list() -> None:
    catalog = _by_id(venue_catalog())
    for venue_id, info in catalog.items():
        if info.asset_class != "crypto":
            continue
        assert info.native is (venue_id in NATIVE_EXCHANGES), venue_id
    assert catalog["binance"].native is True
    assert catalog["okx"].native is True
    assert catalog["kraken"].native is False


def test_catalog_segments_only_where_a_connector_takes_one() -> None:
    catalog = _by_id(venue_catalog())
    with_segments = {v.id: v.segments for v in venue_catalog() if v.segments}
    assert with_segments == {
        "binance": ("spot", "usdm", "coinm"),
        "bybit": ("spot", "linear", "inverse", "option"),
    }
    # OKX/Deribit encode the segment in the symbol, so offering one would be a
    # lie about the market string the feed accepts.
    assert catalog["okx"].segments == ()
    assert catalog["deribit"].segments == ()
    assert catalog["kraken"].segments == ()


def test_catalog_json_shape() -> None:
    entry = _by_id(venue_catalog())["binance"].as_dict()
    assert entry == {
        "id": "binance",
        "assetClass": "crypto",
        "depth": "L2",
        "native": True,
        "segments": ["spot", "usdm", "coinm"],
    }
    assert isinstance(entry["segments"], list)  # JSON-serializable, not a tuple


def test_catalog_depth_badge_matches_the_feed_that_will_serve_it() -> None:
    """The depth badge is a promise about the subscribe that follows it.

    For crypto the `native` flag IS the depth (true diffs vs a whole-book
    re-read). Off the crypto side it is not: equity has no L2 tier at all, so
    deriving the badge from `native` made /api/venues contradict /api/universe
    for the same market.
    """
    from flowmap_server.api.rest import _equity_capability
    from flowmap_server.feeds.sim import SimFeed

    catalog = _by_id(venue_catalog())
    assert catalog["sim"].depth == SimFeed(seed=0).capability["depth"]
    assert catalog["equity"].depth == _equity_capability()["depth"]
    assert catalog["equity"].depth != "L2"  # no equity tier has ever served L2
    for venue_id, info in catalog.items():
        if info.asset_class == "crypto":
            assert info.depth == ("L2" if info.native else "L2-snapshot"), venue_id


def test_catalog_is_pure_and_repeatable() -> None:
    assert [v.as_dict() for v in venue_catalog()] == [v.as_dict() for v in venue_catalog()]


# --- ccxt_knows vs is_ccxt_exchange --------------------------------------------


@pytest.mark.parametrize("venue", DUAL_VENUES)
def test_ccxt_knows_differs_from_is_ccxt_exchange_on_dual_venues(venue: str) -> None:
    """This inequality is the entire reason ``ccxt_knows`` exists.

    ``is_ccxt_exchange`` answers "is this venue SERVED BY the ccxt connector",
    which is False wherever a native connector wins the route. But those are
    exactly the venues where ccxt is still wanted for what the native reader
    does not do — symbol translation and kline backfill — so the question here
    is the other one: "does ccxt have a driver at all".
    """
    assert is_ccxt_exchange(venue) is False
    assert ccxt_knows(venue) is True


def test_ccxt_knows_agrees_where_there_is_no_native_connector() -> None:
    for venue in ("kraken", "kucoin", "gate", "bitfinex"):
        assert is_ccxt_exchange(venue) is True
        assert ccxt_knows(venue) is True


@pytest.mark.parametrize("venue", ["coingecko", "base_onchain", "gmx_synthetix", "superchain"])
def test_ccxt_knows_is_false_for_non_ccxt_readers(venue: str) -> None:
    assert ccxt_knows(venue) is False


def test_ccxt_knows_is_false_for_a_non_venue() -> None:
    assert ccxt_knows("nasdaq") is False
    assert ccxt_knows("") is False


# --- venue_symbols: cache / single-flight / failure ----------------------------


def _fake_lister(monkeypatch, fn) -> None:
    monkeypatch.setattr(venues, "_list_symbols", fn)


async def test_ttl_cache_collapses_repeated_calls(monkeypatch) -> None:
    calls: list[str] = []

    async def fake(market: str) -> list[str]:
        calls.append(market)
        return ["AAA", "BBB"]

    _fake_lister(monkeypatch, fake)
    assert await venue_symbols("kraken", now_ns=0) == ["AAA", "BBB"]
    assert await venue_symbols("kraken", now_ns=1) == ["AAA", "BBB"]
    assert await venue_symbols("kraken", now_ns=SYMBOL_TTL_NS - 1) == ["AAA", "BBB"]
    assert calls == ["kraken"], "re-listing per keystroke is a rate-limit incident"

    # Past the TTL the venue is asked again.
    assert await venue_symbols("kraken", now_ns=SYMBOL_TTL_NS) == ["AAA", "BBB"]
    assert calls == ["kraken", "kraken"]


async def test_cache_is_per_market(monkeypatch) -> None:
    async def fake(market: str) -> list[str]:
        return [f"{market.upper()}-1"]

    _fake_lister(monkeypatch, fake)
    assert await venue_symbols("kraken", now_ns=0) == ["KRAKEN-1"]
    assert await venue_symbols("binance-usdm", now_ns=0) == ["BINANCE-USDM-1"]
    # A segment is part of the cache key: spot and usdm list different books.
    assert await venue_symbols("binance-spot", now_ns=0) == ["BINANCE-SPOT-1"]


async def test_concurrent_callers_collapse_onto_one_fetch(monkeypatch) -> None:
    """Six keystrokes in flight must be one REST round-trip, not six."""
    calls: list[str] = []
    gate = asyncio.Event()

    async def fake(market: str) -> list[str]:
        calls.append(market)
        await gate.wait()
        return ["AAA"]

    _fake_lister(monkeypatch, fake)
    tasks = [asyncio.create_task(venue_symbols("kraken", now_ns=0)) for _ in range(6)]
    for _ in range(10):  # let every task reach the lock
        await asyncio.sleep(0)
    assert calls == ["kraken"], "the lock did not single-flight the fetch"
    gate.set()
    results = await asyncio.gather(*tasks)
    assert calls == ["kraken"]
    assert results == [["AAA"]] * 6


async def test_different_markets_do_not_block_each_other(monkeypatch) -> None:
    """The lock is per market — one slow venue must not stall the others."""
    started: list[str] = []
    gate = asyncio.Event()

    async def fake(market: str) -> list[str]:
        started.append(market)
        if market == "slowvenue":
            await gate.wait()
        return [market]

    _fake_lister(monkeypatch, fake)
    slow = asyncio.create_task(venue_symbols("slowvenue", now_ns=0))
    for _ in range(3):
        await asyncio.sleep(0)
    assert await venue_symbols("kraken", now_ns=0) == ["kraken"]
    gate.set()
    assert await slow == ["slowvenue"]
    assert set(started) == {"slowvenue", "kraken"}


async def test_failure_yields_empty_without_raising(monkeypatch) -> None:
    """Discovery degrades to the bundled shortlist; it must never 500."""

    async def boom(market: str) -> list[str]:
        raise RuntimeError("venue unreachable")

    _fake_lister(monkeypatch, boom)
    assert await venue_symbols("kraken", now_ns=0) == []


async def test_failure_with_no_prior_result_is_cached_not_hammered(monkeypatch) -> None:
    calls: list[str] = []

    async def boom(market: str) -> list[str]:
        calls.append(market)
        raise RuntimeError("venue unreachable")

    _fake_lister(monkeypatch, boom)
    assert await venue_symbols("kraken", now_ns=0) == []
    assert await venue_symbols("kraken", now_ns=1) == []
    assert calls == ["kraken"], "a down venue must not be retried per keystroke"


async def test_later_failure_keeps_the_last_good_list(monkeypatch) -> None:
    """Blanking the picker because a refresh failed is worse than a stale list."""
    state = {"fail": False, "calls": 0}

    async def flaky(market: str) -> list[str]:
        state["calls"] += 1
        if state["fail"]:
            raise RuntimeError("now down")
        return ["AAA", "BBB"]

    _fake_lister(monkeypatch, flaky)
    assert await venue_symbols("kraken", now_ns=0) == ["AAA", "BBB"]

    state["fail"] = True
    assert await venue_symbols("kraken", now_ns=SYMBOL_TTL_NS) == ["AAA", "BBB"]
    assert state["calls"] == 2  # it really did try again
    # The last-good list is re-stamped. Leaving the original timestamp would
    # mean every later call re-fetches from a venue that is currently DOWN —
    # turning an outage into the rate-limit incident this cache exists to
    # prevent.
    assert venues._cache["kraken"] == (SYMBOL_TTL_NS, ["AAA", "BBB"])
    assert await venue_symbols("kraken", now_ns=SYMBOL_TTL_NS + 1) == ["AAA", "BBB"]
    assert state["calls"] == 2  # served from cache, venue left alone

    state["fail"] = False
    assert await venue_symbols("kraken", now_ns=3 * SYMBOL_TTL_NS) == ["AAA", "BBB"]
    assert state["calls"] == 3


async def test_later_empty_listing_also_keeps_the_last_good_list(monkeypatch) -> None:
    """An empty answer is the same failure mode as an exception, dressed up."""
    state = {"empty": False}

    async def flaky(market: str) -> list[str]:
        return [] if state["empty"] else ["AAA"]

    _fake_lister(monkeypatch, flaky)
    assert await venue_symbols("kraken", now_ns=0) == ["AAA"]
    state["empty"] = True
    assert await venue_symbols("kraken", now_ns=SYMBOL_TTL_NS) == ["AAA"]
    assert venues._cache["kraken"] == (SYMBOL_TTL_NS, ["AAA"])


# --- resolve_symbol: the no-op paths are pure (no ccxt, no network) ------------


@pytest.mark.parametrize(
    ("market", "symbol"),
    [
        ("binance-spot", "ETHBTC"),  # native venue, native spelling
        ("okx", "BTC-USDT-SWAP"),
        ("kraken", "ETH/BTC"),  # ccxt venue, unified spelling
        ("base_onchain", "WETHUSDC"),  # no ccxt driver -> nothing to translate
    ],
)
async def test_resolve_symbol_is_a_no_op_when_the_spelling_already_fits(
    market: str, symbol: str
) -> None:
    assert await resolve_symbol(market, symbol) == symbol
