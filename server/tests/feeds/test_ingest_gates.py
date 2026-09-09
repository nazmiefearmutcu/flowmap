"""Live-ingestion hardening tests (campaign A2-2/3/4/5).

Pins four feed-boundary behaviors, all at the LIVE ingestion seams only
(replay/sim deliberately have no gate — recorded history is never re-gated):

- **Timestamp sanity (A2-2):** crypto `_BridgeSink` / equity `_EquitySink` /
  equity warmup-bar selection drop records whose venue stamp is non-positive,
  1970-era (the ms/ns mixup signature) or beyond the 24 h horizon, counting
  and (once) logging each drop.
- **Bounded fan-in (A2-3):** the connector->consumer queue inside
  ``events()`` has drop-oldest semantics, a dropped counter, and never
  raises; the end sentinel always survives.
- **Connector-task join (A2-4):** a consumer that closes (or abandons) the
  events generator leaves NO live connector task behind.
- **Symbol-translation memo (A2-5):** ``resolve_symbol_cached`` downloads a
  venue's ccxt markets once per (market, symbol) for the server lifetime.
"""

from __future__ import annotations

import asyncio
import logging
import time

import pytest
from crocodile.core.schema.enums import AssetClass, Side
from crocodile.core.schema.records import BookSnapshot
from crocodile.core.schema.records import OHLCV as StkBar
from crocodile.core.schema.records import Quote as StkQuote
from crocodile.core.schema.records import Trade as CTrade
from crocodile.core.schema.records import Trade as StkTrade
from crocodile.core.scheduler.calendar import MARKET_TZ

import flowmap_server.data.venues as venues_mod
import flowmap_server.feeds.crypto as crypto_mod
from flowmap_server.config import Config
from flowmap_server.feeds.base import (
    FEED_QUEUE_MAXSIZE,
    TS_FLOOR_NS,
    TS_HORIZON_NS,
    BoundedFeedQueue,
    ts_ns_sane,
)
from flowmap_server.feeds.crypto import CryptoFeed, _BridgeSink
from flowmap_server.feeds.crypto import resolve_symbol_cached
from flowmap_server.feeds.equity import EquityFeed, _EquitySink, _bar_ts
from flowmap_server.proto.events import (
    SIDE_BUY,
    SIDE_SRC_EXCHANGE,
    Trade,
)

# Plausible "now" for every injected clock (Nov 2023 UTC ns).
NOW = 1_700_000_000_000_000_000
HOUR_NS = 3600 * 10**9


def _reset_caches():
    crypto_mod._RESOLVED_SYMBOLS.clear()
    crypto_mod._PENDING_RESOLVES.clear()


@pytest.fixture(autouse=True)
def _clean_resolver_cache():
    _reset_caches()
    yield
    _reset_caches()


# ---------------------------------------------------------------------------
# A2-2: the shared gate helper


def test_ts_gate_boundaries():
    assert ts_ns_sane(NOW, now_ns=NOW)  # now-ish
    assert ts_ns_sane(NOW + HOUR_NS, now_ns=NOW)  # +1h skew tolerated
    assert not ts_ns_sane(0, now_ns=NOW)  # zero
    assert not ts_ns_sane(-5, now_ns=NOW)  # negative
    assert not ts_ns_sane(1_700_000_000_000, now_ns=NOW)  # ms-as-ns: 1970-era
    assert not ts_ns_sane(TS_FLOOR_NS - 1, now_ns=NOW)  # below the 2010 floor
    assert ts_ns_sane(TS_FLOOR_NS, now_ns=NOW)
    assert not ts_ns_sane(NOW + TS_HORIZON_NS + 1, now_ns=NOW)  # +25h
    assert ts_ns_sane(NOW + TS_HORIZON_NS, now_ns=NOW)  # exactly on the horizon


# ---------------------------------------------------------------------------
# A2-2: crypto bridge sink


def _ctrade(ts: int, tid: str = "t1", price: float = 100.0) -> CTrade:
    return CTrade(
        source="binance",
        symbol="binance-usdm:BTCUSDT",
        symbol_raw="BTCUSDT",
        asset_class=AssetClass.CRYPTO,
        source_ts=ts,
        local_ts=ts,
        id=tid,
        price=price,
        amount=1.0,
        side=Side.BUY,
    )


async def test_bridge_sink_drops_implausible_stamps_and_counts(caplog):
    out = []
    sink = _BridgeSink(out.append, now_ns=lambda: NOW)
    with caplog.at_level(logging.WARNING, logger="flowmap_server.feeds.crypto"):
        await sink.put(_ctrade(0))  # zero
        await sink.put(_ctrade(-5, tid="t2"))  # negative
        await sink.put(_ctrade(1_700_000_000_000, tid="t3"))  # 1970-era
        await sink.put(_ctrade(NOW + 25 * HOUR_NS, tid="t4"))  # +25h future
    assert out == []
    assert sink.dropped_ts == 4
    # Exactly ONE warning for the first drop; the rest only count (a log line
    # per bad stamp would storm under a wedged venue clock).
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warnings) == 1
    assert "implausible" in caplog.text


async def test_bridge_sink_keeps_sane_stamps():
    out = []
    sink = _BridgeSink(out.append, now_ns=lambda: NOW)
    await sink.put(_ctrade(NOW))  # now-ish
    await sink.put(_ctrade(NOW + HOUR_NS, tid="t2"))  # +1h skew
    assert [t.ts_ns for t in out] == [NOW, NOW + HOUR_NS]
    assert sink.dropped_ts == 0


async def test_bridge_sink_drops_future_snapshot_before_it_becomes_a_book():
    out = []
    sink = _BridgeSink(out.append, now_ns=lambda: NOW)
    await sink.put(
        BookSnapshot(
            source="binance",
            symbol="binance-usdm:BTCUSDT",
            symbol_raw="BTCUSDT",
            asset_class=AssetClass.CRYPTO,
            source_ts=NOW + 25 * HOUR_NS,
            local_ts=NOW + 25 * HOUR_NS,
            bids=[(100.0, 1.0)],
            asks=[(100.1, 1.0)],
            depth=2,
            sequence_id=1,
        )
    )
    assert out == []  # no BookState, no gap marker — the sample never existed
    assert sink.dropped_ts == 1


# ---------------------------------------------------------------------------
# A2-2: equity keyed sink + keyless warmup bars


def _stktrade(ts: int) -> StkTrade:
    return StkTrade(
        source="finnhub",
        symbol="AAPL",
        symbol_raw="AAPL",
        asset_class=AssetClass.EQUITY,
        local_ts=ts,
        source_ts=ts,
        id="",
        price=100.0,
        amount=10.0,
        side=Side.UNKNOWN,
    )


def _stkquote(ts: int, bid_px: float = 100.0) -> StkQuote:
    return StkQuote(
        source="alpaca",
        symbol="AAPL",
        symbol_raw="AAPL",
        asset_class=AssetClass.EQUITY,
        local_ts=ts,
        source_ts=ts,
        bid_px=bid_px,
        bid_sz=5.0,
        ask_px=101.0,
        ask_sz=7.0,
    )


async def test_equity_sink_drops_implausible_stamps_and_counts(caplog):
    out = []
    sink = _EquitySink(out.append, use_quote_rule=True, now_ns=lambda: NOW)
    with caplog.at_level(logging.WARNING, logger="flowmap_server.feeds.equity"):
        await sink.put(_stktrade(0))
        await sink.put(_stkquote(NOW + 25 * HOUR_NS))
        await sink.put(_stktrade(1_000_000_000))  # 1970-era
    trades = [e for e in out if isinstance(e, Trade)]
    assert trades == []  # no tape print, no BBO, no L1 depth column
    assert sink.dropped_ts == 3
    assert len([r for r in caplog.records if r.levelno >= logging.WARNING]) == 1


async def test_equity_sink_keeps_sane_stamps():
    out = []
    sink = _EquitySink(out.append, use_quote_rule=True, now_ns=lambda: NOW)
    await sink.put(_stkquote(NOW))  # BBO + L1 depth column
    await sink.put(_stktrade(NOW + HOUR_NS))  # +1h skew kept
    assert len(out) == 3  # BBO + BookState from the quote, then the Trade
    assert sink.dropped_ts == 0


def _stkbar(ts: int) -> StkBar:
    return StkBar(
        source="yahoo",
        symbol="AAPL",
        symbol_raw="AAPL",
        asset_class=AssetClass.EQUITY,
        local_ts=ts,
        source_ts=ts,
        interval="1m",
        open=100.0,
        high=100.0,
        low=100.0,
        close=100.0,
        volume=10.0,
    )


def test_warmup_bars_gate_implausible_stamps():
    import datetime

    def _et(y, mo, d, h, mi=0):
        return int(
            datetime.datetime(y, mo, d, h, mi, tzinfo=MARKET_TZ).timestamp() * 1e9
        )

    now = _et(2026, 7, 18, 12, 0)  # Saturday after the session below
    good = _et(2026, 7, 17, 10, 0)
    feed = EquityFeed("AAPL", Config(), now_ns_fn=lambda: now)
    kept = feed._select_warmup_bars(
        [
            _stkbar(0),  # zero
            _stkbar(-7),  # negative
            _stkbar(1_000_000_000),  # 1970-era (s/ms-as-ns mixup)
            _stkbar(now + 25 * HOUR_NS),  # absurdly future
            _stkbar(good),  # the one real bar
        ]
    )
    assert [_bar_ts(b) for b in kept] == [good]


# ---------------------------------------------------------------------------
# A2-3: bounded drop-oldest fan-in queue


async def test_bounded_queue_drops_oldest_counts_and_never_raises():
    q = BoundedFeedQueue(3)
    for i in range(5):
        q.put_nowait(i)  # no exception on overflow
    assert q.dropped == 2  # items 0 and 1 were dropped oldest-first
    assert await q.get() == 2  # FIFO order preserved for survivors
    assert await q.get() == 3
    assert await q.get() == 4


def _ev(i: int) -> Trade:
    return Trade(
        ts_ns=NOW + i,
        price=float(i),
        size=1.0,
        side=SIDE_BUY,
        side_src=SIDE_SRC_EXCHANGE,
        venue="t",
    )


async def test_crypto_feed_full_queue_drops_oldest_but_ends_cleanly():
    """A stalled consumer with a flooding connector: events drop OLDEST, the
    dropped counter counts, nothing raises, and the end sentinel still lands
    (the stream terminates instead of hanging)."""
    queues = []

    def factory(sink):
        # The sink's emit IS the queue's put_nowait — recover the queue to
        # assert its counter (white-box by design: this is the unit under test).
        queue = sink._emit.__self__
        queues.append(queue)

        class _FloodConn:
            transport = None
            ws_url = None

            async def run(self):
                # Events only — on a clean return _drive enqueues the end
                # sentinel itself (that final put also participates in the
                # overflow accounting).
                for i in range(FEED_QUEUE_MAXSIZE + 3):
                    queue.put_nowait(_ev(i))

        return _FloodConn()

    feed = CryptoFeed(
        "binance", "BTCUSDT", "usdm", Config(), connector_factory=factory
    )
    got: list = []
    async for ev in feed.events():  # must end cleanly, not hang
        got.append(ev)

    queue = queues[0]
    # maxsize events fill the queue; the +3 flood drops 3 events; the
    # sentinel put drops exactly one more. The sentinel itself is never the
    # dropped item.
    assert queue.dropped == 4
    assert len(got) == FEED_QUEUE_MAXSIZE - 1
    assert got[0].price == 4.0  # events 0-3 were dropped oldest-first
    assert got[-1].price == float(FEED_QUEUE_MAXSIZE + 2)


# ---------------------------------------------------------------------------
# A2-4: an abandoned/closed events() generator must not leak the connector task


async def _assert_task_gone(name: str, grace_s: float = 2.0) -> bool:
    deadline = time.monotonic() + grace_s
    while time.monotonic() < deadline:
        if not any(t.get_name() == name for t in asyncio.all_tasks()):
            return True
        await asyncio.sleep(0.01)
    return False


async def test_generator_aclose_cancels_connector_task():
    started = asyncio.Event()

    def factory(sink):
        class _HangingConn:
            transport = None
            ws_url = None

            async def run(self):
                await sink.put(_ctrade(NOW, tid="first"))  # one event, then hang
                started.set()
                await asyncio.Event().wait()  # hangs until cancelled

        return _HangingConn()

    feed = CryptoFeed(
        "binance", "BTCUSDT", "usdm", Config(), connector_factory=factory
    )
    name = "crypto-feed-binance-usdm:BTCUSDT"
    agen = feed.events()
    ev = await agen.__anext__()
    assert isinstance(ev, Trade) and ev.ts_ns == NOW
    assert started.is_set()
    await agen.aclose()  # the consumer closes the generator early
    assert await _assert_task_gone(name), "connector task leaked after aclose"


async def test_consumer_exception_abandonment_still_cancels_connector():
    """The GC/aclose-finalizer path: the consumer RAISES mid-stream and drops
    all references; the asyncgen finalizer must still run the generator's
    finally, which cancels and joins the connector task."""
    def factory(sink):
        class _HangingConn:
            transport = None
            ws_url = None

            async def run(self):
                await sink.put(_ctrade(NOW, tid="first"))
                await asyncio.Event().wait()

        return _HangingConn()

    feed = CryptoFeed(
        "binance", "BTCUSDT", "usdm", Config(), connector_factory=factory
    )
    name = "crypto-feed-binance-usdm:BTCUSDT"
    with pytest.raises(RuntimeError, match="consumer boom"):

        async for _ev in feed.events():
            raise RuntimeError("consumer boom")
    del feed  # drop the last references; CPython finalizes the asyncgen now
    assert await _assert_task_gone(name), "connector task leaked after abandonment"


# ---------------------------------------------------------------------------
# A2-5: symbol translation memoized for the server lifetime


async def test_resolve_symbol_cached_memoizes(monkeypatch):
    calls: list[tuple[str, str]] = []

    async def fake_resolve(market: str, symbol: str) -> str:
        calls.append((market, symbol))
        await asyncio.sleep(0)
        return f"{symbol.lower()}-unified"

    monkeypatch.setattr(venues_mod, "resolve_symbol", fake_resolve)
    first = await resolve_symbol_cached("kraken", "XXBT")
    second = await resolve_symbol_cached("kraken", "XXBT")
    assert first == second == "xxbt-unified"
    assert calls == [("kraken", "XXBT")]  # second resolve did NOT refetch


async def test_resolve_symbol_cached_single_flights_concurrent_misses(monkeypatch):
    calls: list[tuple[str, str]] = []

    async def fake_resolve(market: str, symbol: str) -> str:
        calls.append((market, symbol))
        await asyncio.sleep(0.05)  # a slow markets download
        return f"{symbol.lower()}-unified"

    monkeypatch.setattr(venues_mod, "resolve_symbol", fake_resolve)
    got = await asyncio.gather(
        resolve_symbol_cached("kraken", "XXBT"),
        resolve_symbol_cached("kraken", "XXBT"),
    )
    assert got == ["xxbt-unified", "xxbt-unified"]
    assert len(calls) == 1  # one download shared by both waiters


async def test_resolve_symbol_failure_is_not_pinned(monkeypatch):
    calls: list[int] = []

    async def flaky(market: str, symbol: str) -> str:
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("venue down")
        return f"{symbol.lower()}-unified"

    monkeypatch.setattr(venues_mod, "resolve_symbol", flaky)
    with pytest.raises(RuntimeError, match="venue down"):
        await resolve_symbol_cached("kraken", "XXBT")
    got = await resolve_symbol_cached("kraken", "XXBT")  # retried, not cached
    assert got == "xxbt-unified"
    assert len(calls) == 2


async def test_identity_resolution_is_not_cached(monkeypatch):
    """An untranslated result may mean the lookup failed transiently — it must
    retry on the next call rather than be pinned for the server lifetime."""
    calls: list[tuple[str, str]] = []

    async def fake_resolve(market: str, symbol: str) -> str:
        calls.append((market, symbol))
        await asyncio.sleep(0)
        return symbol  # translation found nothing: identity passthrough

    monkeypatch.setattr(venues_mod, "resolve_symbol", fake_resolve)
    await resolve_symbol_cached("kraken", "XXBT")
    await resolve_symbol_cached("kraken", "XXBT")
    assert len(calls) == 2
