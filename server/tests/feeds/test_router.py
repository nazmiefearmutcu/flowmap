"""``feeds.router`` — the ONE place a ``Subscribe.market`` becomes a Feed.

Routing used to be copy-pasted twice (``SessionManager._default_feed_factory``
for the test path, ``api.app._server_feed_factory`` for the server path),
differing only in the sim feed's ``realtime`` flag. With ~109 crypto venues
instead of three, two copies is two places to drift, so the duplication was
collapsed into this module and the flag became a parameter.

These tests pin BOTH halves of that claim:

1. the routing table itself (sim / equity / native-with-segment /
   native-without-segment / ccxt-only / unknown), and
2. that the two call sites really do agree now — same feed type, same market
   and symbol for every market string, with the sim ``realtime`` flag as the
   ONLY permitted difference.

Fully hermetic: every feed here is only CONSTRUCTED. ``CryptoFeed.__init__``,
``EquityFeed.__init__`` and ``SimFeed.__init__`` do no I/O — the network lives
in ``events()``, which is never called.
"""

from __future__ import annotations

import pytest

from flowmap_server.api.app import _server_feed_factory
from flowmap_server.config import Config
from flowmap_server.core.session import SessionManager
from flowmap_server.feeds.crypto import CryptoFeed
from flowmap_server.feeds.equity import EQUITY_MARKET, EquityFeed
from flowmap_server.feeds.router import (
    SIM_MARKET,
    build_feed,
    feed_factory,
)
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto import events as pe

# One native venue that takes a segment kwarg, one that encodes the segment in
# the symbol, one native+segment-less-by-choice, and one ccxt-only venue.
CRYPTO_MARKETS = ("binance-usdm", "binance-spot", "okx", "bybit-linear", "kraken")


def _sub(market: str, symbol: str = "BTCUSDT") -> pe.Subscribe:
    return pe.Subscribe(market=market, symbol=symbol, mode="live")


# --- the routing table ---------------------------------------------------------


def test_sim_routes_both_ways() -> None:
    """``realtime_sim`` is the parameter that replaced the duplicated copy."""
    cfg = Config()
    paced = build_feed(_sub(SIM_MARKET, "X"), cfg, realtime_sim=True)
    unpaced = build_feed(_sub(SIM_MARKET, "X"), cfg, realtime_sim=False)
    assert isinstance(paced, SimFeed) and isinstance(unpaced, SimFeed)
    assert paced._realtime is True
    assert unpaced._realtime is False
    # Everything else about the two is identical — the flag is the only knob.
    assert paced._dt_ns == unpaced._dt_ns == cfg.dt_crypto_ns
    assert paced._seed == unpaced._seed
    assert paced._start_ns == unpaced._start_ns == 0
    # SimFeed owns its own identity; the subscribe's symbol does not rename it.
    assert paced.market == SIM_MARKET and paced.symbol == SimFeed.symbol


def test_equity_routes_to_equity_feed() -> None:
    feed = build_feed(_sub(EQUITY_MARKET, "aapl"), Config(), realtime_sim=False)
    assert isinstance(feed, EquityFeed)
    assert feed.market == EQUITY_MARKET
    assert feed.symbol == "AAPL"  # EquityFeed upper-cases its symbol


@pytest.mark.parametrize(
    ("market", "exchange", "segment"),
    [
        ("binance-usdm", "binance", "usdm"),  # native venue WITH a segment
        ("okx", "okx", ""),  # native venue WITHOUT one
        ("kraken", "kraken", ""),  # ccxt-only venue
    ],
)
def test_crypto_routes_and_keeps_its_market_string(
    market: str, exchange: str, segment: str
) -> None:
    feed = build_feed(_sub(market), Config(), realtime_sim=False)
    assert isinstance(feed, CryptoFeed)
    assert feed.exchange == exchange
    assert feed._market_kw == segment
    # The market string round-trips: split then rejoin must be identity, which
    # is what lets the session key, the recorder path and the client label agree.
    assert feed.market == market
    assert feed.symbol == "BTCUSDT"


def test_crypto_routing_is_capability_honest() -> None:
    """Routing does not flatten the native/ccxt distinction on the way through."""
    native = build_feed(_sub("binance-usdm"), Config(), realtime_sim=False)
    ccxt_only = build_feed(_sub("kraken"), Config(), realtime_sim=False)
    assert native.native and native.capability["depth"] == "L2"
    assert not ccxt_only.native and ccxt_only.capability["depth"] == "L2-snapshot"


def test_unknown_market_raises_not_implemented() -> None:
    with pytest.raises(NotImplementedError) as excinfo:
        build_feed(_sub("nasdaq", "AAPL"), Config(), realtime_sim=False)
    msg = str(excinfo.value)
    assert "nasdaq" in msg
    # The message names the SHAPE and points at the venue endpoint rather than
    # inlining every venue id.
    assert "<exchange>[-<segment>]" in msg
    assert "/api/venues" in msg


@pytest.mark.parametrize(
    ("market", "expected"),
    [
        ("sim", True),
        ("equity", True),
        ("binance-usdm", True),
        ("okx", True),
        ("kraken", True),
        ("nasdaq", False),
        ("", False),
        ("binance spot", False),  # space, not a hyphen
        # A segment the venue has no use for is REJECTED, not silently dropped:
        # accepting it would label spot data with a perp market string, and let
        # a caller mint unbounded distinct session keys.
        ("binance-nonsense", False),
        ("bitget-swap", False),
        ("kraken-perp", False),
    ],
)
def test_routing_table_is_exactly_what_build_feed_serves(market: str, expected: bool) -> None:
    """The routable set, pinned end to end."""
    try:
        build_feed(_sub(market, "X"), Config(), realtime_sim=False)
    except NotImplementedError:
        routed = False
    else:
        routed = True
    assert routed is expected


def test_feed_factory_binds_cfg_and_flag() -> None:
    cfg = Config()
    factory = feed_factory(cfg, realtime_sim=True)
    assert factory(_sub(SIM_MARKET, "X"))._realtime is True
    assert isinstance(factory(_sub("kraken")), CryptoFeed)
    with pytest.raises(NotImplementedError):
        factory(_sub("nasdaq", "AAPL"))


# --- the two call sites now agree ----------------------------------------------


@pytest.mark.parametrize("market", [SIM_MARKET, EQUITY_MARKET, *CRYPTO_MARKETS])
def test_session_and_server_factories_agree(market: str) -> None:
    """The regression guard for the de-duplication.

    ``SessionManager._default_feed_factory`` and ``api.app._server_feed_factory``
    were two hand-kept copies of this routing table. Both now delegate to
    ``feeds.router``, so for every market string they must produce the same feed
    class with the same identity — the sim pacing flag being the sole exception.
    """
    cfg = Config()
    sub = _sub(market, "AAPL" if market == EQUITY_MARKET else "BTCUSDT")
    session_feed = SessionManager(cfg)._default_feed_factory(sub)
    server_feed = _server_feed_factory(cfg)(sub)

    assert type(session_feed) is type(server_feed)
    assert session_feed.market == server_feed.market
    assert session_feed.symbol == server_feed.symbol
    assert session_feed.capability == server_feed.capability
    if isinstance(session_feed, SimFeed):
        # The ONE sanctioned difference: the server paces the demo feed to wall
        # time; the test path leaves the clock to the test.
        assert session_feed._realtime is False
        assert server_feed._realtime is True
    else:
        assert not hasattr(session_feed, "_realtime")


def test_both_call_sites_reject_the_same_unknown_market() -> None:
    cfg = Config()
    sub = _sub("nasdaq", "AAPL")
    with pytest.raises(NotImplementedError):
        SessionManager(cfg)._default_feed_factory(sub)
    with pytest.raises(NotImplementedError):
        _server_feed_factory(cfg)(sub)
