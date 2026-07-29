"""Crypto venue surface after the 3-venue -> ~109-venue widening. NO network.

The crypto side used to be a hand-kept shortlist of three markets. It is now
the engine's whole venue table: ten hand-written connectors plus every ccxt
venue id, with the universal ccxt connector serving anything without a native
reader. That connector has no incremental book diff (it re-reads the whole book
each tick) and no liquidation topic, so the widening is only honest if the
difference is CARRIED — in ``capability``, in the subscribed channel list, and
in how a repeated ``BookSnapshot`` is interpreted.

This file pins that difference on all three axes:

- ``split_market`` / ``is_crypto_market`` / the two venue sets (the grammar);
- ``CryptoFeed.native`` + ``capability`` + ``_channels()`` +
  ``_connector_kwargs()`` (what we claim and what we actually subscribe);
- ``_BridgeSink(snapshot_driven=...)`` (a re-snapshot is a resync on a delta
  venue and a plain update on a snapshot-driven one) — both directions, both at
  the sink and end-to-end through ``CryptoFeed.events()`` over a fake connector.

Everything is construction + in-process record replay; ``events()`` only ever
runs against an injected connector whose ``ws_url`` is empty, so no transport is
ever built and ``resolve_symbol`` (the only other network path) is skipped.
"""

from __future__ import annotations

import pytest
from crocodile.core.schema.enums import AssetClass, Side
from crocodile.core.schema.records import BookDelta, BookSnapshot
from crocodile.core.schema.records import Trade as CTrade

from flowmap_server.config import Config
from flowmap_server.feeds.base import BookState, FeedEvent
from flowmap_server.feeds.crypto import (
    CRYPTO_EXCHANGES,
    _LIQUIDATION_VIA_TRADES,
    NATIVE_EXCHANGES,
    NOT_STREAMABLE,
    CryptoFeed,
    _BridgeSink,
    is_crypto_market,
    split_market,
)
from flowmap_server.proto.events import (
    SIDE_SELL,
    SIDE_SRC_EXCHANGE,
    SIDE_SRC_NA,
    SIDE_UNKNOWN,
    Marker,
)

# The engine's hand-written connectors, as of the merge. Pinned by name because
# `native` is not cosmetic: it decides depth honesty, the gap marker, the
# channel list and the connector kwargs.
# The engine ships ten hand-written connectors; five of them are not order-flow
# readers (CoinGecko's daily candle, the on-chain pool watchers) and are excluded
# from the venue set itself, so `NATIVE_EXCHANGES` is the streamable five.
ENGINE_NATIVE = {
    "base_onchain",
    "binance",
    "bybit",
    "coinbase",
    "coingecko",
    "deribit",
    "derive",
    "gmx_synthetix",
    "okx",
    "superchain",
}
EXPECTED_NATIVE = {"binance", "bybit", "coinbase", "deribit", "okx"}


def _feed(market: str) -> CryptoFeed:
    exchange, segment = split_market(market)
    return CryptoFeed(exchange=exchange, symbol="BTCUSDT", market=segment, cfg=Config())


# --- the market grammar --------------------------------------------------------


@pytest.mark.parametrize(
    ("market", "expected"),
    [
        ("binance-usdm", ("binance", "usdm")),
        ("bybit-linear", ("bybit", "linear")),
        ("okx", ("okx", "")),
        ("kraken", ("kraken", "")),
        # Venue ids use "_" precisely so the "-" partition stays unambiguous.
        ("base_onchain", ("base_onchain", "")),
        ("gmx_synthetix", ("gmx_synthetix", "")),
        ("", ("", "")),
        # Only the FIRST "-" separates; a segment may not contain one today but
        # the parse must not silently drop the tail if it ever does.
        ("binance-usd-m", ("binance", "usd-m")),
    ],
)
def test_split_market(market: str, expected: tuple[str, str]) -> None:
    assert split_market(market) == expected


def test_venue_sets_are_the_engines_not_a_shortlist() -> None:
    assert set(NATIVE_EXCHANGES) == EXPECTED_NATIVE
    assert ENGINE_NATIVE - EXPECTED_NATIVE == set(NOT_STREAMABLE)
    assert NATIVE_EXCHANGES < CRYPTO_EXCHANGES  # strict: ccxt adds many more
    assert len(CRYPTO_EXCHANGES) > 100, "ccxt venues missing — is `market` installed?"
    # The "<exchange>-<segment>" grammar depends on no venue id containing "-".
    assert not [e for e in CRYPTO_EXCHANGES if "-" in e]


@pytest.mark.parametrize(
    ("market", "expected"),
    [
        ("binance", True),
        ("binance-usdm", True),
        ("okx", True),
        ("kraken", True),  # ccxt-only
        # Reachable by the engine, but not an order-flow view — excluded from
        # the venue set so the router cannot build a feed that claims L2.
        ("base_onchain", False),
        ("coingecko", False),
        ("nasdaq", False),
        ("equity", False),
        ("sim", False),
        ("", False),
    ],
)
def test_is_crypto_market(market: str, expected: bool) -> None:
    assert is_crypto_market(market) is expected


# --- capability honesty --------------------------------------------------------


@pytest.mark.parametrize(
    ("market", "native", "depth"),
    [
        ("binance-usdm", True, "L2"),
        ("binance-spot", True, "L2"),
        ("okx", True, "L2"),
        ("deribit", True, "L2"),
        ("kraken", False, "L2-snapshot"),
        ("kucoin", False, "L2-snapshot"),
    ],
)
def test_depth_capability_tracks_native(market: str, native: bool, depth: str) -> None:
    feed = _feed(market)
    assert feed.native is native
    assert feed.capability["depth"] == depth
    # The rest of the capability block is venue-independent.
    assert feed.capability["tape"] == "tick"
    assert feed.capability["trade_side"] == "exchange"
    assert feed.capability["cvd"] == "exchange"


@pytest.mark.parametrize(
    ("market", "markers"),
    [
        # Liquidation streams exist only where the venue really publishes one.
        ("binance-usdm", ["liquidation", "gap"]),
        ("binance-coinm", ["liquidation", "gap"]),
        ("binance-spot", ["gap"]),
        # Bybit's engine-side channel name is stale (`liquidation.{sym}`; the
        # venue answers "handler not found" and wants `allLiquidation.{sym}`),
        # so no liquidation is promised or subscribed. Measured live.
        ("bybit-linear", ["gap"]),
        ("bybit-inverse", ["gap"]),
        ("bybit-spot", ["gap"]),
        ("bybit-option", ["gap"]),
        # OKX likewise: the engine sends `liq-orders`+instId, which the venue
        # rejects as non-existent (v5 wants `liquidation-orders`+instType).
        ("okx", ["gap"]),  # segment lives in the symbol
        # Deribit flags liquidations on the trades stream we already take.
        ("deribit", ["liquidation", "gap"]),
        ("coinbase", ["gap"]),
        # A snapshot-driven venue has no sequence to lose and no liquidation
        # topic, so it claims neither marker.
        ("kraken", []),
        ("kucoin", []),
    ],
)
def test_marker_capability_is_per_venue_and_per_segment(
    market: str, markers: list[str]
) -> None:
    assert _feed(market).capability["markers"] == markers


def test_gap_marker_is_claimed_exactly_when_native() -> None:
    """The gap marker is a claim about sequence detection, not a decoration."""
    for market in ("binance-usdm", "okx", "kraken", "kucoin", "gate"):
        feed = _feed(market)
        assert ("gap" in feed.capability["markers"]) is feed.native


# --- what we actually subscribe ------------------------------------------------


def test_ccxt_channels_do_not_double_spend_or_ask_for_a_dead_topic() -> None:
    channels = _feed("kraken")._channels()
    # book_delta and book_snapshot are answered from the SAME ccxt
    # fetch/watch_order_book call — asking for both doubles the rate-limit cost
    # for identical records.
    assert "book_snapshot" in channels
    assert "book_delta" not in channels
    # No liquidation topic on the universal connector.
    assert "liquidation" not in channels
    assert channels == ["trade", "book_snapshot", "book_ticker"]


@pytest.mark.parametrize(
    ("market", "expected"),
    [
        ("binance-usdm", ["trade", "book_delta", "book_snapshot", "book_ticker", "liquidation"]),
        ("binance-spot", ["trade", "book_delta", "book_snapshot", "book_ticker"]),
        ("bybit-linear", ["trade", "book_delta", "book_snapshot", "book_ticker"]),
        ("bybit-spot", ["trade", "book_delta", "book_snapshot", "book_ticker"]),
        ("okx", ["trade", "book_delta", "book_snapshot", "book_ticker"]),
        ("deribit", ["trade", "book_delta", "book_snapshot", "book_ticker"]),
    ],
)
def test_native_channels_follow_the_liquidation_matrix(
    market: str, expected: list[str]
) -> None:
    assert _feed(market)._channels() == expected


def test_channels_and_capability_never_disagree_about_liquidation() -> None:
    """The two directions are NOT symmetric, and conflating them was a bug.

    Subscribing a liquidation channel while hiding the marker would drop data on
    the floor, so `subscribed -> claimed` must always hold. The converse does
    not: Deribit flags liquidations on the ordinary `trades` stream, so it earns
    the marker with no channel of its own. What is forbidden is claiming a
    marker no path can deliver — which is why OKX and Bybit, whose engine-side
    channel names the venues reject, claim nothing.
    """
    for market in ("binance-usdm", "binance-spot", "bybit-linear", "bybit-option",
                   "okx", "deribit", "coinbase", "kraken"):
        feed = _feed(market)
        claimed = "liquidation" in feed.capability["markers"]
        subscribed = "liquidation" in feed._channels()
        if subscribed:
            assert claimed, f"{market}: subscribed a channel whose marker is hidden"
        if claimed and not subscribed:
            assert split_market(market)[0] in _LIQUIDATION_VIA_TRADES, market


@pytest.mark.parametrize(
    ("market", "expected"),
    [
        # Only two native venues take a segment kwarg, and they spell it
        # differently.
        ("binance-usdm", {"market": "usdm"}),
        ("binance-spot", {"market": "spot"}),
        ("bybit-linear", {"category": "linear"}),
        ("bybit-inverse", {"category": "inverse"}),
        # These encode the segment in the symbol (BTC-USDT-SWAP, BTC-PERPETUAL),
        # so passing one would be a TypeError at the connector.
        ("okx", {}),
        ("deribit", {}),
        ("coinbase", {}),
        # A bare native venue that COULD take one simply does not get one.
        ("binance", {}),
        ("bybit", {}),
    ],
)
def test_native_connector_kwargs(market: str, expected: dict[str, object]) -> None:
    assert _feed(market)._connector_kwargs() == expected


@pytest.mark.parametrize("market", ["kraken", "kucoin", "gate"])
def test_ccxt_connector_kwargs_ask_for_websockets(market: str) -> None:
    kwargs = _feed(market)._connector_kwargs()
    # Stream where the venue supports it; ccxt.pro degrades to REST polling on
    # its own where it does not.
    assert kwargs["use_ws"] is True
    assert kwargs["book_depth"] == 100
    # A ccxt venue must never be handed a native segment kwarg.
    assert "market" not in kwargs and "category" not in kwargs


def test_a_ccxt_venue_with_a_segment_still_gets_no_segment_kwarg() -> None:
    """A user can type ``kraken-spot``; the segment is display-only there."""
    feed = _feed("kraken-spot")
    assert feed.market == "kraken-spot"
    assert feed._connector_kwargs() == {"use_ws": True, "book_depth": 100}


# --- _BridgeSink: snapshot_driven ----------------------------------------------


def _snapshot(seq: int, *, ts: int, top_bid: float = 100.0) -> BookSnapshot:
    return BookSnapshot(
        source="test",
        symbol="test:BTCUSDT",
        symbol_raw="BTCUSDT",
        asset_class=AssetClass.CRYPTO,
        source_ts=ts,
        local_ts=ts + 1,
        bids=[(top_bid, 1.0), (top_bid - 1.0, 2.0)],
        asks=[(top_bid + 0.1, 1.0), (top_bid + 1.1, 2.0)],
        depth=4,
        sequence_id=seq,
    )


def _delta(seq: int, *, ts: int) -> BookDelta:
    return BookDelta(
        source="test",
        symbol="test:BTCUSDT",
        symbol_raw="BTCUSDT",
        asset_class=AssetClass.CRYPTO,
        source_ts=ts,
        local_ts=ts + 1,
        bids=[(99.0, 5.0)],
        asks=[],
        seq_id=seq,
        prev_seq_id=seq - 1,
    )


async def _run_sink(*, snapshot_driven: bool, records: list) -> list[FeedEvent]:
    out: list[FeedEvent] = []
    sink = _BridgeSink(out.append, 100, snapshot_driven=snapshot_driven)
    for rec in records:
        await sink.put(rec)
    return out


async def test_delta_venue_resnapshot_emits_the_gap_marker() -> None:
    """On a delta venue a snapshot on an already-initialized book IS the
    connector's resync signature, and losing that marker would silently hide a
    book discontinuity from the client."""
    out = await _run_sink(
        snapshot_driven=False,
        records=[_snapshot(1, ts=10), _snapshot(2, ts=20), _snapshot(3, ts=30)],
    )
    gaps = [e for e in out if isinstance(e, Marker) and e.kind == "gap"]
    assert len(gaps) == 2  # the FIRST snapshot only initializes; the next two resync
    assert [g.ts_ns for g in gaps] == [20, 30]
    assert "seq=2" in gaps[0].text and "resync" in gaps[0].text
    # Each gap is emitted BEFORE the replacing BookState, never after.
    kinds = [type(e).__name__ for e in out]
    assert kinds == ["BookState", "Marker", "BookState", "Marker", "BookState"]


async def test_snapshot_driven_venue_emits_no_gap_markers() -> None:
    """The ccxt path re-reads the whole book every tick. Marking each read a
    gap would invent a stream of resyncs that never happened."""
    out = await _run_sink(
        snapshot_driven=True,
        records=[_snapshot(i, ts=10 * i) for i in range(1, 6)],
    )
    assert not [e for e in out if isinstance(e, Marker)]
    assert all(isinstance(e, BookState) for e in out)
    assert len(out) == 5  # every snapshot still produces a book update
    # And the book is REPLACED (not merged) on each one.
    assert list(out[-1].bid_px) == [100.0, 99.0]


async def test_snapshot_driven_flag_does_not_change_anything_else() -> None:
    """Only the gap marker is suppressed: initialization, replacement and the
    delta path behave identically."""
    records = [_snapshot(1, ts=10), _delta(2, ts=20)]
    delta_venue = await _run_sink(snapshot_driven=False, records=records)
    snap_venue = await _run_sink(snapshot_driven=True, records=records)
    assert [type(e).__name__ for e in delta_venue] == ["BookState", "BookState"]
    assert [type(e).__name__ for e in snap_venue] == ["BookState", "BookState"]
    for a, b in zip(delta_venue, snap_venue, strict=True):
        assert list(a.bid_px) == list(b.bid_px)
        assert list(a.bid_sz) == list(b.bid_sz)


# --- the flag is actually WIRED to `native` ------------------------------------


class _ReplayConn:
    """Minimal Connector stand-in: empty ws_url so no transport is built."""

    ws_url = ""

    def __init__(self, sink, records: list) -> None:
        self._sink = sink
        self._records = records
        self.transport = None

    async def run(self, max_reconnects: int = -1) -> None:
        for rec in self._records:
            await self._sink.put(rec)


async def _collect(feed: CryptoFeed) -> list[FeedEvent]:
    return [ev async for ev in feed.events()]


@pytest.mark.parametrize(
    ("market", "expect_gaps"),
    [("binance-usdm", 2), ("kraken", 0)],
)
async def test_feed_wires_snapshot_driven_from_native(
    market: str, expect_gaps: int
) -> None:
    """End-to-end regression guard: a ccxt venue re-snapshotting must not spray
    gap markers, and a native venue must still report its resyncs."""
    exchange, segment = split_market(market)
    records = [_snapshot(i, ts=10 * i) for i in range(1, 4)]
    sinks: list[_BridgeSink] = []

    def factory(sink):
        sinks.append(sink)
        return _ReplayConn(sink, records)

    feed = CryptoFeed(
        exchange=exchange,
        symbol="BTCUSDT",
        market=segment,
        cfg=Config(),
        connector_factory=factory,
    )
    out = await _collect(feed)
    assert sinks[0]._snapshot_driven is (not feed.native)
    gaps = [e for e in out if isinstance(e, Marker) and e.kind == "gap"]
    assert len(gaps) == expect_gaps
    assert len([e for e in out if isinstance(e, BookState)]) == 3


# --- the merged header's clock, pinned ------------------------------------------
# A referee proved these were unpinned: swapping `record.source_ts` for
# `record.local_ts` in `_BridgeSink._ts` left every migrated test green. That
# rename (crypto `exchange_ts` -> `source_ts`) is the single most load-bearing
# line of the Crocodile migration, so it gets assertions where the two clocks
# genuinely differ.

_VENUE_NS = 1_700_000_000_000_000_000
_LOCAL_NS = _VENUE_NS + 777_000_000  # receive clock, 777 ms later


def _hdr_snapshot(**over: object) -> BookSnapshot:
    kw: dict[str, object] = {
        "source": "binance-spot",
        "symbol": "binance-spot:BTCUSDT",
        "symbol_raw": "BTCUSDT",
        "asset_class": AssetClass.CRYPTO,
        "source_ts": _VENUE_NS,
        "local_ts": _LOCAL_NS,
        "bids": [(100.0, 1.0)],
        "asks": [(101.0, 1.0)],
        "depth": 2,
        "sequence_id": 1,
    }
    kw.update(over)
    return BookSnapshot(**kw)  # type: ignore[arg-type]


def _hdr_trade(**over: object) -> CTrade:
    kw: dict[str, object] = {
        "source": "binance-spot",
        "symbol": "binance-spot:BTCUSDT",
        "symbol_raw": "BTCUSDT",
        "asset_class": AssetClass.CRYPTO,
        "source_ts": _VENUE_NS,
        "local_ts": _LOCAL_NS,
        "id": "1",
        "price": 100.5,
        "amount": 2.0,
        "side": Side.BUY,
    }
    kw.update(over)
    return CTrade(**kw)  # type: ignore[arg-type]


async def test_book_carries_the_venue_clock_not_the_receive_clock() -> None:
    out: list = []
    sink = _BridgeSink(out.append)
    await sink.put(_hdr_snapshot())
    (book,) = out
    assert book.ts_ns == _VENUE_NS
    assert book.ts_ns != _LOCAL_NS


async def test_trade_carries_the_venue_clock_not_the_receive_clock() -> None:
    out: list = []
    sink = _BridgeSink(out.append)
    await sink.put(_hdr_snapshot())
    out.clear()
    await sink.put(_hdr_trade())
    (trade,) = out
    assert trade.ts_ns == _VENUE_NS
    assert trade.ts_ns != _LOCAL_NS
    # …and the size field really is the merged `amount`, not a stale `size`.
    assert trade.size == 2.0


async def test_local_clock_is_only_the_fallback_when_the_venue_stamps_nothing() -> None:
    out: list = []
    sink = _BridgeSink(out.append)
    await sink.put(_hdr_snapshot(source_ts=None))
    (book,) = out
    assert book.ts_ns == _LOCAL_NS


async def test_a_venue_that_omits_the_side_is_not_called_exchange_true() -> None:
    """ccxt's unified trade `side` is optional; its normalizer maps anything
    that is not buy/sell to Side.UNKNOWN. Claiming SIDE_SRC_EXCHANGE on that
    would tell the client an unknown aggressor was venue-confirmed."""
    out: list = []
    sink = _BridgeSink(out.append, snapshot_driven=True)
    await sink.put(_hdr_snapshot())
    out.clear()
    # Distinct ids: this sink is snapshot_driven, so it dedups by trade id.
    await sink.put(_hdr_trade(id="a", side=Side.UNKNOWN))
    (trade,) = out
    assert trade.side == SIDE_UNKNOWN
    assert trade.side_src == SIDE_SRC_NA
    # A published side still reports exchange-true.
    out.clear()
    await sink.put(_hdr_trade(id="b", side=Side.SELL))
    (trade,) = out
    assert trade.side == SIDE_SELL
    assert trade.side_src == SIDE_SRC_EXCHANGE


async def test_polled_venues_do_not_re_emit_the_same_print() -> None:
    """ccxt's REST poll has no `since` cursor: it re-reads the venue's recent
    trades every interval. Without dedup the same print lands once per poll and
    both the tape and the CVD inflate, under a `tape: "tick"` badge."""
    out: list = []
    sink = _BridgeSink(out.append, snapshot_driven=True)
    await sink.put(_hdr_snapshot())
    out.clear()
    for _ in range(3):  # three polls returning the same window
        await sink.put(_hdr_trade(id="t1"))
        await sink.put(_hdr_trade(id="t2", price=101.0))
    assert [t.price for t in out] == [100.5, 101.0]


async def test_a_delta_venue_is_not_deduped() -> None:
    """Native streams push each print once and legitimately reuse ids across
    reconnects; deduping there would silently drop real trades."""
    out: list = []
    sink = _BridgeSink(out.append, snapshot_driven=False)
    await sink.put(_hdr_snapshot())
    out.clear()
    await sink.put(_hdr_trade(id="t1"))
    await sink.put(_hdr_trade(id="t1"))
    assert len(out) == 2
