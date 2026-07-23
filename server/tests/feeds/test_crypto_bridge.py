"""CryptoFeed (Crypcodile -> canonical) bridge tests (M1 plan Task 9).

NO live network. The fixture ``fixtures/binance_btcusdt_sample.jsonl`` holds
raw Binance USD-M ws frames plus two REST-style depth snapshots (wrapper
lines ``{"rest_depth_snapshot": {...}}`` consumed FIFO by the fake
``fetch_book_snapshot``). Frames are replayed through the REAL
``BinanceConnector.run`` loop over a ``FakeTransport`` — normalize, book
sync, and BookResyncBridge are the exact production path; only the socket
and the REST fetch are faked. ``CryptoFeed.events()`` wiring (queue,
connector lifecycle, end-of-stream) is exercised end to end.
"""

from __future__ import annotations

import json
import pathlib

import numpy as np

from crypcodile.exchanges.binance.book import parse_rest_depth_snapshot
from crypcodile.exchanges.binance.connector import BinanceConnector
from crypcodile.ingest.transport import FakeTransport
from crypcodile.instruments.registry import InstrumentRegistry
from crypcodile.schema.enums import Side
from crypcodile.schema.records import BookSnapshot
from crypcodile.schema.records import Trade as CTrade

from flowmap_server.config import Config
from flowmap_server.feeds.base import BookState, Feed, FeedEvent
from flowmap_server.feeds.crypto import (
    BOOK_TOP_N,
    CRYPTO_MARKETS,
    CryptoFeed,
    _BridgeSink,
)
from flowmap_server.proto.events import (
    BBO,
    SIDE_BUY,
    SIDE_SELL,
    SIDE_SRC_EXCHANGE,
    Marker,
    Trade,
)

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "binance_btcusdt_sample.jsonl"

# Channels the production factory subscribes for a usdm market (mirrors
# CryptoFeed._channels; asserted against it in test_channels below).
USDM_CHANNELS = ["trade", "book_delta", "book_snapshot", "book_ticker", "liquidation"]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _load_fixture() -> tuple[list[dict], list[bytes]]:
    rest: list[dict] = []
    frames: list[bytes] = []
    for line in FIXTURE.read_text().splitlines():
        obj = json.loads(line)
        if "rest_depth_snapshot" in obj:
            rest.append(obj["rest_depth_snapshot"])
        else:
            frames.append(json.dumps(obj, separators=(",", ":")).encode())
    return rest, frames


def _make_fixture_feed() -> tuple[CryptoFeed, list[int]]:
    """CryptoFeed over a REAL BinanceConnector fed by the fixture frames."""
    rest, frames = _load_fixture()
    rest_iter = iter(rest)
    fetch_seqs: list[int] = []

    def factory(sink):  # (Sink) -> Connector, the CryptoFeed seam
        conn = BinanceConnector(
            symbols=["BTCUSDT"],
            channels=USDM_CHANNELS,
            out=sink,
            registry=InstrumentRegistry(),
            market="usdm",
        )

        async def _fake_fetch(symbol: str) -> BookSnapshot:
            data = next(rest_iter)
            fetch_seqs.append(int(data["lastUpdateId"]))
            return parse_rest_depth_snapshot(
                data,
                symbol_raw=symbol,
                venue=conn._venue,
                local_ts=1_700_000_000_000_000_000,
                registry=conn.registry,
            )

        conn.fetch_book_snapshot = _fake_fetch  # type: ignore[method-assign]
        conn.transport = FakeTransport(frames)
        return conn

    feed = CryptoFeed(
        exchange="binance",
        symbol="BTCUSDT",
        market="usdm",
        cfg=Config(),
        connector_factory=factory,
    )
    return feed, fetch_seqs


async def _collect(feed: CryptoFeed) -> list[FeedEvent]:
    out: list[FeedEvent] = []
    async for ev in feed.events():
        out.append(ev)
    return out


# ---------------------------------------------------------------------------
# capability / protocol shape
# ---------------------------------------------------------------------------


def test_capability_shape() -> None:
    feed = CryptoFeed(exchange="binance", symbol="BTCUSDT", market="usdm", cfg=Config())
    assert feed.capability == {
        "depth": "L2",
        "tape": "tick",
        "trade_side": "exchange",
        "markers": ["liquidation", "gap"],
    }
    assert feed.market == "binance-usdm"
    assert feed.symbol == "BTCUSDT"
    assert isinstance(feed, Feed)


def test_channels_match_market() -> None:
    usdm = CryptoFeed(exchange="binance", symbol="BTCUSDT", market="usdm", cfg=Config())
    spot = CryptoFeed(exchange="binance", symbol="BTCUSDT", market="spot", cfg=Config())
    assert usdm._channels() == USDM_CHANNELS
    # forceOrder is a futures-only stream: spot must not subscribe liquidation.
    assert "liquidation" not in spot._channels()


# ---------------------------------------------------------------------------
# fixture replay through the real connector
# ---------------------------------------------------------------------------


async def test_bookstate_two_sided_and_aggregated() -> None:
    feed, _ = _make_fixture_feed()
    events = await _collect(feed)
    books = [e for e in events if isinstance(e, BookState)]
    assert len(books) >= 40

    # The stale pre-anchor delta must NOT produce output: the first BookState
    # is exactly REST snapshot 1 (top of book 49999.9 / 50000.1, size 1.0/0.8).
    first = books[0]
    assert float(np.max(first.bid_px)) == 49999.9
    assert float(np.min(first.ask_px)) == 50000.1
    assert float(first.bid_sz[np.argmax(first.bid_px)]) == 1.0
    assert float(first.ask_sz[np.argmin(first.ask_px)]) == 0.8

    for b in books:
        assert len(b.bid_px) == len(b.bid_sz)
        assert len(b.ask_px) == len(b.ask_sz)
        assert len(b.bid_px) and len(b.ask_px)
        assert float(np.max(b.bid_px)) < float(np.min(b.ask_px))
        # aggregated per price: one entry per level, all finite
        assert len(np.unique(b.bid_px)) == len(b.bid_px)
        assert len(np.unique(b.ask_px)) == len(b.ask_px)
        assert np.isfinite(b.bid_px).all() and np.isfinite(b.bid_sz).all()
        assert np.isfinite(b.ask_px).all() and np.isfinite(b.ask_sz).all()

    # Latest-absolute-size-wins per level: 49997.7 was set to 3.333, 5.555,
    # then 7.777 across the pre-gap deltas.
    gap_i = next(
        i for i, e in enumerate(events) if isinstance(e, Marker) and e.kind == "gap"
    )
    last_pre = next(
        e for e in reversed(events[:gap_i]) if isinstance(e, BookState)
    )
    (idx,) = np.where(last_pre.bid_px == 49997.7)
    assert last_pre.bid_sz[idx[0]] == 7.777
    # Removal (qty 0) really removes: ask 50001.9 must be gone pre-gap.
    assert 50001.9 not in last_pre.ask_px


async def test_trades_map_side_directly() -> None:
    feed, _ = _make_fixture_feed()
    events = await _collect(feed)
    trades = [e for e in events if isinstance(e, Trade)]
    assert len(trades) >= 20
    assert {t.side for t in trades} == {SIDE_BUY, SIDE_SELL}
    for t in trades:
        assert t.side_src == SIDE_SRC_EXCHANGE
        assert t.price > 0 and t.size > 0
        assert t.venue == "binance-usdm"
        assert t.ts_ns > 0


async def test_liquidation_marker() -> None:
    feed, _ = _make_fixture_feed()
    events = await _collect(feed)
    liqs = [e for e in events if isinstance(e, Marker) and e.kind == "liquidation"]
    assert len(liqs) == 1
    liq = liqs[0]
    assert liq.price == 50115.5  # forceOrder "ap" (avg execution price)
    assert liq.size == 2.5  # forceOrder "q"
    assert "buy" in liq.text


async def test_bbo() -> None:
    feed, _ = _make_fixture_feed()
    events = await _collect(feed)
    bbos = [e for e in events if isinstance(e, BBO)]
    assert len(bbos) >= 3
    first = bbos[0]
    assert first.bid_px == 49999.9 and first.ask_px == 50000.1
    assert first.bid_sz > 0 and first.ask_sz > 0
    for b in bbos:
        assert b.bid_px < b.ask_px


async def test_gap_marker_then_post_resync_bookstate() -> None:
    feed, fetch_seqs = _make_fixture_feed()
    events = await _collect(feed)

    gaps = [
        (i, e)
        for i, e in enumerate(events)
        if isinstance(e, Marker) and e.kind == "gap"
    ]
    assert len(gaps) == 1  # exactly one resync in the fixture
    gap_i, _ = gaps[0]

    # REST fetched twice: bootstrap anchor (1000) then resync anchor (2050).
    assert fetch_seqs == [1000, 2050]

    post_books = [e for e in events[gap_i + 1 :] if isinstance(e, BookState)]
    assert post_books, "no BookState after the gap marker"
    # Snapshot 2 REPLACED the book: pre-gap region (~50000) is gone, the new
    # book sits around 50010 with the kept buffered delta (u=2100) applied.
    snap2 = post_books[0]
    assert float(np.max(snap2.bid_px)) == 50009.9
    assert float(np.min(snap2.ask_px)) == 50010.1
    assert 49999.9 not in snap2.bid_px
    last = post_books[-1]
    (idx,) = np.where(last.bid_px == 50007.3)
    assert last.bid_sz[idx[0]] == 4.444  # post-resync tracked level


# ---------------------------------------------------------------------------
# events() restart contract: fresh connector per call, resumes live
# ---------------------------------------------------------------------------


async def test_events_recall_builds_fresh_connector() -> None:
    calls: list[object] = []

    class _OneShotConn:
        ws_url = "wss://fake.invalid/stream"

        def __init__(self, sink) -> None:
            self._sink = sink
            self.transport = FakeTransport([])  # pre-set: factory owns it

        async def run(self, max_reconnects: int = -1) -> None:
            await self._sink.put(
                CTrade(
                    exchange="binance-usdm",
                    symbol="binance-usdm:BTCUSDT",
                    symbol_raw="BTCUSDT",
                    exchange_ts=1_700_000_000_000_000_000,
                    local_ts=1_700_000_000_000_000_001,
                    id=str(len(calls)),
                    price=50000.0,
                    amount=0.5,
                    side=Side.BUY,
                )
            )

    def factory(sink):
        conn = _OneShotConn(sink)
        calls.append(conn)
        return conn

    feed = CryptoFeed(
        exchange="binance",
        symbol="BTCUSDT",
        market="usdm",
        cfg=Config(),
        connector_factory=factory,
    )
    first = await _collect(feed)
    second = await _collect(feed)  # re-call after normal end: MUST rebuild
    assert len(calls) == 2
    assert calls[0] is not calls[1]
    assert len(first) == 1 and len(second) == 1
    assert isinstance(first[0], Trade) and isinstance(second[0], Trade)


# ---------------------------------------------------------------------------
# translation unit edge: top-N cap and best-first ordering
# ---------------------------------------------------------------------------


async def test_bookstate_top_n_cap_and_order() -> None:
    out: list[FeedEvent] = []
    sink = _BridgeSink(out.append)
    n = BOOK_TOP_N + 500
    await sink.put(
        BookSnapshot(
            exchange="binance-usdm",
            symbol="binance-usdm:BTCUSDT",
            symbol_raw="BTCUSDT",
            exchange_ts=None,
            local_ts=123,
            bids=[(50000.0 - 0.1 * i, 1.0) for i in range(n)],
            asks=[(50000.1 + 0.1 * i, 1.0) for i in range(n)],
            depth=2 * n,
            sequence_id=1,
        )
    )
    (book,) = out
    assert isinstance(book, BookState)
    assert book.ts_ns == 123  # exchange_ts None -> local_ts
    assert len(book.bid_px) == BOOK_TOP_N
    assert len(book.ask_px) == BOOK_TOP_N
    # best-first: bids descending from best bid, asks ascending from best ask
    assert book.bid_px[0] == 50000.0
    assert book.ask_px[0] == 50000.1
    assert (np.diff(book.bid_px) < 0).all()
    assert (np.diff(book.ask_px) > 0).all()
    # the CLOSEST 2000 levels survive the cap, not arbitrary ones
    assert float(np.min(book.bid_px)) > 50000.0 - 0.1 * n
    assert float(np.max(book.ask_px)) < 50000.1 + 0.1 * n


# ---------------------------------------------------------------------------
# session feed-factory routing
# ---------------------------------------------------------------------------


def test_session_factory_routing() -> None:
    import pytest

    from flowmap_server.core.session import SessionManager
    from flowmap_server.feeds.sim import SimFeed
    from flowmap_server.proto import events as pe

    mgr = SessionManager(Config())
    assert CRYPTO_MARKETS == {"binance-spot", "binance-usdm", "okx"}

    sim = mgr._default_feed_factory(pe.Subscribe(market="sim", symbol="X", mode="live"))
    assert isinstance(sim, SimFeed)

    for market in sorted(CRYPTO_MARKETS):
        feed = mgr._default_feed_factory(
            pe.Subscribe(market=market, symbol="BTCUSDT", mode="live")
        )
        assert isinstance(feed, CryptoFeed)
        assert feed.market == market
        assert feed.symbol == "BTCUSDT"

    with pytest.raises(NotImplementedError):
        mgr._default_feed_factory(
            pe.Subscribe(market="nasdaq", symbol="AAPL", mode="live")
        )


def test_book_top_n_is_configurable_and_keeps_the_closest_levels():
    """The emit cap — not the grid — decides how far from the touch a resting
    order can be and still reach the client, so the wide/full price bands are
    bounded by it. Verify it is honoured and that it keeps the CLOSEST levels."""
    from flowmap_server.feeds.crypto import _BridgeSink

    out: list = []
    sink = _BridgeSink(out.append, book_top_n=3)
    sink._initialized = True
    # 10 bids below and 10 asks above a 100/101 touch.
    for i in range(10):
        sink._bids[100.0 - i] = 1.0
        sink._asks[101.0 + i] = 1.0
    sink._emit_book(123)

    book = out[-1]
    assert len(book.bid_px) == 3
    assert len(book.ask_px) == 3
    # Best-first, closest to the touch.
    assert list(book.bid_px) == [100.0, 99.0, 98.0]
    assert list(book.ask_px) == [101.0, 102.0, 103.0]


def test_book_top_n_default_is_deep_enough_for_a_wide_band():
    from flowmap_server.config import Config
    from flowmap_server.feeds.crypto import BOOK_TOP_N

    # A 2000-level cap truncates BTCUSDT a few hundred dollars from mid, which
    # would leave the wide/full bands rendering an empty far field.
    assert BOOK_TOP_N >= 20_000
    assert Config().book_top_n == BOOK_TOP_N
