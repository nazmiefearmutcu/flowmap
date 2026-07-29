"""The one place a ``Subscribe.market`` string becomes a :class:`Feed`.

This used to be copy-pasted twice — once in ``SessionManager`` for the test
path and once in ``api.app`` for the server path — differing only in the sim
feed's ``realtime`` flag. With the venue set now numbering in the hundreds
rather than three, two copies is two places to drift; the flag is a parameter
instead.

Market grammar (unchanged, now with a far larger domain):

``sim``                     the deterministic demo feed
``<exchange>[-<segment>]``  any crypto venue Crocodile can reach — the ten
                            hand-written connectors plus every ccxt venue id.
                            The optional segment picks a venue's market
                            (``binance-usdm``, ``bybit-linear``); venues that
                            encode it in the symbol take none (``okx``).
``equity``                  US equities, provider tier auto-selected from cfg

Unknown markets raise :class:`NotImplementedError`, which the WS layer turns
into close code 1003. The message names the shape rather than listing every
venue — a wall of ids is not a better error than a rule.
"""

from __future__ import annotations

from flowmap_server.config import Config
from flowmap_server.feeds.base import Feed
from flowmap_server.feeds.crypto import CryptoFeed, is_crypto_market, split_market
from flowmap_server.feeds.equity import EQUITY_MARKETS, EquityFeed
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto import events

__all__ = ["SIM_MARKET", "build_feed", "feed_factory"]

SIM_MARKET = "sim"



def build_feed(sub: events.Subscribe, cfg: Config, *, realtime_sim: bool) -> Feed:
    """Route one subscription to its feed.

    ``realtime_sim`` paces the demo feed to wall time (one column per ``dt_ns``,
    which keeps the event loop live and the stream watchable). Tests want the
    unpaced variant so they can drive the clock themselves.
    """
    if sub.market == SIM_MARKET:
        return SimFeed(seed=42, dt_ns=cfg.dt_crypto_ns, start_ns=0, realtime=realtime_sim)
    if sub.market in EQUITY_MARKETS:
        # Tier (keyless SYNTH / Alpaca / Finnhub) auto-selected from cfg keys.
        return EquityFeed(sub.symbol, cfg)
    if is_crypto_market(sub.market):
        exchange, segment = split_market(sub.market)
        return CryptoFeed(exchange=exchange, symbol=sub.symbol, market=segment, cfg=cfg)
    raise NotImplementedError(
        f"market {sub.market!r} has no feed — expected 'sim', "
        f"{sorted(EQUITY_MARKETS)}, or '<exchange>[-<segment>]' naming a crypto "
        f"venue this build can reach (see GET /api/venues)"
    )


def feed_factory(cfg: Config, *, realtime_sim: bool):
    """Bind *cfg* into the single-argument factory the session manager wants."""

    def factory(sub: events.Subscribe) -> Feed:
        return build_feed(sub, cfg, realtime_sim=realtime_sim)

    return factory
