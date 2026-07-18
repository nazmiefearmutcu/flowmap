"""EquityFeed tests (M3 plan Task 1) — fixture-driven, NO live network.

All bars/prices/clocks are hand-built and injected (``bars_fn`` / ``price_fn``
/ ``now_ns_fn`` / ``sleep_fn``), so pytest never touches Yahoo or
google_finance. The frozen contract:

1. SYNTH volume-at-price builder: bars -> **two-sided** BookState split at a
   reference price (bid ``price <= ref`` / ask ``price > ref``, stockodile
   ``split_ladder`` semantics), the profile SHAPE rescaled to a combined peak,
   the point-of-control preserved.
2. That profile lands as two-sided density in a real L1_BAND Grid.
3. Keyless live poll emits display-only Trades (side_src=na, venue synthetic).
4. Market-closed (pinned Saturday): warmup profile still renders, one
   session_break marker, NO live trades, closed state exposed.
5. Market-open (pinned weekday RTH): live polling emits trades.
6. Tier auto-select + capability shapes (keyless SYNTH / alpaca L1); keyed sink
   side inference + real L1 depth column; re-callable events(); NaN/finite
   safety; Feed protocol conformance.
"""

from __future__ import annotations

import datetime

import numpy as np

from stockodile.scheduler.calendar import MARKET_TZ
from stockodile.schema.records import Bar as StkBar
from stockodile.schema.records import Quote as StkQuote
from stockodile.schema.records import Trade as StkTrade

from flowmap_server.config import Config
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.feeds.base import BookState, Feed, FeedEvent
from flowmap_server.feeds.equity import (
    DEFAULT_PROFILE_TICK,
    EQUITY_MARKET,
    PROFILE_PEAK_TARGET,
    EquityFeed,
    _EquitySink,
)
from flowmap_server.proto.events import (
    BBO,
    MODE_L1_BAND,
    MODE_SYNTH_PROFILE,
    SIDE_BUY,
    SIDE_SELL,
    SIDE_SRC_INFERRED,
    SIDE_SRC_NA,
    SIDE_UNKNOWN,
    Marker,
    Trade,
)

# --- fixtures / helpers --------------------------------------------------------

DT_KEYLESS_NS = 10 * 10**9  # matches Config.dt_equity_keyless_ns


def _et_ns(y: int, mo: int, d: int, h: int, mi: int = 0, s: int = 0) -> int:
    dt = datetime.datetime(y, mo, d, h, mi, s, tzinfo=MARKET_TZ)
    return int(dt.timestamp() * 1e9)


def _bar(ts_ns: int, o: float, h: float, low: float, c: float, v: float) -> StkBar:
    return StkBar(
        provider="yahoo",
        symbol="AAPL",
        symbol_raw="AAPL",
        local_ts=ts_ns,
        source_ts=ts_ns,
        interval="1m",
        open=o,
        high=h,
        low=low,
        close=c,
        volume=v,
    )


def _flat_bar(ts_ns: int, price: float, v: float) -> StkBar:
    """A bar whose whole OHLC sits at one price (typical price == price)."""
    return _bar(ts_ns, price, price, price, price, v)


# A single-session (Friday 2026-07-17) fixture where volume concentrates at
# 100.00: three 1 m bars of 1000 there, plus small bars at 95.00 / 105.00.
def _concentrated_session() -> list[StkBar]:
    base = _et_ns(2026, 7, 17, 10, 0)
    m = 60 * 10**9
    return [
        _flat_bar(base + 0 * m, 100.00, 1000.0),
        _flat_bar(base + 1 * m, 95.00, 50.0),
        _flat_bar(base + 2 * m, 100.00, 1000.0),
        _flat_bar(base + 3 * m, 105.00, 50.0),
        _flat_bar(base + 4 * m, 100.00, 1000.0),
    ]


class _StepClock:
    """UTC-ns clock advancing a fixed step per call (one call per feed cycle)."""

    def __init__(self, start_ns: int, step_ns: int) -> None:
        self._t = start_ns
        self._step = step_ns

    def __call__(self) -> int:
        v = self._t
        self._t += self._step
        return v


async def _nosleep(_s: float) -> None:
    return None


async def _collect(feed: EquityFeed, n: int, cap: int = 10_000) -> list[FeedEvent]:
    out: list[FeedEvent] = []
    async for ev in feed.events():
        out.append(ev)
        if len(out) >= n or len(out) >= cap:
            break
    return out


# --- 1. SYNTH profile builder --------------------------------------------------


def test_synth_profile_two_sided_split_peaks_and_bounded():
    bars = _concentrated_session()  # last close 100.00 -> ref = 100.00
    bs = EquityFeed.synth_profile(bars)

    assert isinstance(bs, BookState)
    # Two-sided now: ref 100.00 puts {95.00, 100.00} on bid, {105.00} on ask.
    assert set(np.round(bs.bid_px, 2)) == {95.00, 100.00}
    assert set(np.round(bs.ask_px, 2)) == {105.00}
    # every emitted value finite.
    for arr in (bs.bid_px, bs.bid_sz, bs.ask_px, bs.ask_sz):
        assert np.isfinite(arr).all()
    # combined-peak normalization: the global peak (both sides) == the target,
    # bounded far below the grid's f16 ceiling.
    combined_peak = max(float(bs.bid_sz.max()), float(bs.ask_sz.max()))
    assert combined_peak == PROFILE_PEAK_TARGET
    assert combined_peak < float(np.finfo(np.float16).max)
    # the point-of-control (100.00, stacked 3000) is the peak, on the bid side.
    poc_price = float(bs.bid_px[int(np.argmax(bs.bid_sz))])
    assert abs(poc_price - 100.00) < DEFAULT_PROFILE_TICK
    assert float(bs.bid_sz.max()) == PROFILE_PEAK_TARGET
    # SHAPE preserved exactly through a single combined scale: raw 3000 vs 50
    # (ratio 60) survives, and holds ACROSS the bid/ask split (100.00 bid vs
    # 105.00 ask) — the cross-side comparison is honest.
    bid_sz = bs.bid_sz[np.argsort(bs.bid_px)]  # ascending: 95.00, 100.00
    assert abs(bid_sz[1] / bid_sz[0] - 60.0) < 1e-9  # 3000 / 50 (both bid)
    assert abs(float(bs.bid_sz.max()) / float(bs.ask_sz.max()) - 60.0) < 1e-9  # 3000 / 50 cross-side


def test_synth_profile_bounded_under_liquid_cumulative_volume():
    # A liquid name over a full RTH session: raw cumulative shares reach the
    # hundreds of millions and would overflow the grid's float16 ring (max
    # 65 504) to inf. The normalized profile must stay finite, bounded, and
    # peaked at the high-volume price no matter how large the cumulative grows.
    base = _et_ns(2026, 7, 17, 10, 0)
    m = 60 * 10**9
    bars = []
    for i in range(390):  # 390 one-minute RTH bars
        if i % 3:
            bars.append(_flat_bar(base + i * m, 200.00, 3_000_000.0))
        else:
            bars.append(_flat_bar(base + i * m, 199.99, 20_000.0))
    bs = EquityFeed.synth_profile(bars)
    f16_max = float(np.finfo(np.float16).max)
    # raw cumulative peak ~= 260 * 3e6 = 7.8e8 >> f16 max; normalized fits with
    # room to spare and survives the grid's f16 cast.
    assert np.isfinite(bs.bid_sz).all()
    assert bs.bid_sz.max() == PROFILE_PEAK_TARGET
    assert float(bs.bid_sz.astype(np.float16).max()) < f16_max
    peak_price = float(bs.bid_px[int(np.argmax(bs.bid_sz))])
    assert abs(peak_price - 200.00) < DEFAULT_PROFILE_TICK


def test_synth_profile_empty_bars_is_empty_book():
    bs = EquityFeed.synth_profile([])
    assert bs.bid_px.size == 0 and bs.bid_sz.size == 0
    assert bs.ask_px.size == 0 and bs.ask_sz.size == 0


def test_synth_profile_skips_nonfinite_and_negative_volume():
    base = _et_ns(2026, 7, 17, 10, 0)
    m = 60 * 10**9
    bars = [
        _flat_bar(base + 0 * m, 100.0, 500.0),
        _bar(base + 1 * m, 101.0, float("nan"), 100.0, 100.5, 999.0),  # NaN high
        _flat_bar(base + 2 * m, 100.0, -7.0),  # negative volume
        _flat_bar(base + 3 * m, 100.0, 500.0),
    ]
    bs = EquityFeed.synth_profile(bars)
    # only the two finite, non-negative bars survive -> 1000 total at 100.00.
    assert bs.bid_sz.sum() == 1000.0
    assert np.isfinite(bs.bid_px).all() and np.isfinite(bs.bid_sz).all()


# --- 2. profile lands as two-sided density in an L1_BAND Grid ------------------


async def test_warmup_profile_drives_two_sided_l1band_density():
    # bars within the grid span so nothing is clipped by the grid.
    base = _et_ns(2026, 7, 17, 10, 0)
    m = 60 * 10**9
    bars = [
        _flat_bar(base + 0 * m, 100.00, 1000.0),
        _flat_bar(base + 1 * m, 100.50, 40.0),
        _flat_bar(base + 2 * m, 100.00, 1000.0),
        _flat_bar(base + 3 * m, 99.50, 40.0),  # last close 99.50 -> ref splits here
    ]
    cfg = Config()
    feed = EquityFeed(
        "AAPL",
        cfg,
        now_ns_fn=lambda: _et_ns(2026, 7, 18, 12, 0),  # Saturday -> closed after warmup
        bars_fn=_make_bars_fn(bars),
    )
    events = await _collect(feed, 100)
    books = [e for e in events if isinstance(e, BookState)]
    assert books, "no warmup BookState emitted"
    # two-sided: by the last book the ref (99.50) leaves the 100.00/100.50 mass
    # on the ask side, so the ask channel is genuinely populated.
    assert any(b.ask_px.size > 0 for b in books), "no ask channel — depth is still one-sided"

    rows = 512
    tick = 0.01
    p0 = round((100.00 - rows * tick / 2.0) / tick) * tick
    grid = Grid(
        GridCfg(
            tick=tick,
            tick_multiple=1,
            dt_ns=DT_KEYLESS_NS,
            p0=p0,
            rows=rows,
            ring_columns=4096,
            mode=MODE_L1_BAND,
        )
    )
    cols = []
    for b in books:
        cols.extend(grid.on_book(b.ts_ns, b.bid_px, b.bid_sz, b.ask_px, b.ask_sz))
    # flush the final interval.
    cols.extend(
        grid.on_book(
            books[-1].ts_ns + DT_KEYLESS_NS,
            books[-1].bid_px,
            books[-1].bid_sz,
            books[-1].ask_px,
            books[-1].ask_sz,
        )
    )
    assert cols
    last = cols[-1]
    bid = last.bid.astype(np.float64)
    ask = last.ask.astype(np.float64)
    # combined point-of-control (100.00, stacked 2000) is the peak across BOTH
    # channels; with ref 99.50 it lands on the ask side.
    peak_row = int(np.argmax(np.maximum(bid, ask)))
    assert peak_row == round((100.00 - p0) / tick), "combined density peak not at 100.00 row"
    # L1_BAND keeps both channels on the wire; the ask density is real.
    assert grid.to_depth(last).ask is not None
    assert float(ask.max()) > 0.0
    # finite + bounded (no f16 overflow on either channel).
    f16_max = float(np.finfo(np.float16).max)
    assert np.isfinite(bid).all() and np.isfinite(ask).all()
    assert float(bid.max()) < f16_max and float(ask.max()) < f16_max


async def test_liquid_name_synth_grid_density_stays_finite_f16():
    # M3 regression: a liquid name's raw cumulative shares (hundreds of millions)
    # cast to the grid's float16 ring overflow to inf — the heatmap blows out to
    # a saturated white band and the ladder shows ∞. With the normalized profile,
    # every finalized f16 density must stay finite and bounded, peaked at price.
    base = _et_ns(2026, 7, 17, 10, 0)
    m = 60 * 10**9
    bars = []
    for i in range(60):  # revisit 200.00 (heavy) so its cumulative >> f16 max
        if i % 3:
            bars.append(_flat_bar(base + i * m, 200.00, 3_000_000.0))
        else:
            bars.append(_flat_bar(base + i * m, 200.01, 20_000.0))
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=lambda: _et_ns(2026, 7, 18, 12, 0),  # Saturday -> closed after warmup
        bars_fn=_make_bars_fn(bars),
    )
    events = await _collect(feed, 10_000)
    books = [e for e in events if isinstance(e, BookState)]
    assert books, "no warmup BookState emitted"

    rows = 512
    tick = 0.01
    p0 = round((200.00 - rows * tick / 2.0) / tick) * tick
    grid = Grid(
        GridCfg(
            tick=tick,
            tick_multiple=1,
            dt_ns=DT_KEYLESS_NS,
            p0=p0,
            rows=rows,
            ring_columns=4096,
            mode=MODE_SYNTH_PROFILE,
        )
    )
    cols = []
    for b in books:
        cols.extend(grid.on_book(b.ts_ns, b.bid_px, b.bid_sz, b.ask_px, b.ask_sz))
    cols.extend(
        grid.on_book(
            books[-1].ts_ns + DT_KEYLESS_NS,
            books[-1].bid_px,
            books[-1].bid_sz,
            books[-1].ask_px,
            books[-1].ask_sz,
        )
    )
    assert cols
    f16_max = float(np.finfo(np.float16).max)
    for c in cols:
        bid = c.bid.astype(np.float64)
        assert np.isfinite(bid).all(), "SYNTH f16 density overflowed to inf"
        assert float(bid.max()) < f16_max
    # peak density lands on the high-volume price (200.00) after normalization.
    last = cols[-1]
    assert int(np.argmax(last.bid.astype(np.float64))) == round((200.00 - p0) / tick)


# --- 3. keyless live poll emits display-only trades ----------------------------


async def test_keyless_live_emits_display_only_trades():
    prices = [100.0, 101.0, 100.5, 102.0]
    idx = {"i": 0}

    async def price_fn() -> float:
        i = idx["i"]
        idx["i"] += 1
        return prices[i] if i < len(prices) else prices[-1]

    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(_et_ns(2026, 7, 15, 11, 0), DT_KEYLESS_NS),  # Wed RTH
        bars_fn=_make_bars_fn([]),  # no warmup -> straight to live
        price_fn=price_fn,
        sleep_fn=_nosleep,
        bar_refresh_ns=10**18,  # never refresh during the test
    )
    events = await _collect(feed, 12)
    trades = [e for e in events if isinstance(e, Trade)]
    assert len(trades) >= len(prices)
    for tr, px in zip(trades, prices, strict=False):
        assert tr.side_src == SIDE_SRC_NA
        assert tr.side == SIDE_UNKNOWN
        assert tr.venue == "synthetic"
        assert tr.size == 1.0
        assert tr.price == px
    # every live cycle also re-asserts the resting profile (BookState).
    assert any(isinstance(e, BookState) for e in events)


# --- 4. market closed ----------------------------------------------------------


async def test_market_closed_renders_warmup_no_trades_and_exposes_state():
    sat = _et_ns(2026, 7, 18, 12, 0)  # Saturday
    trade_calls = {"n": 0}

    async def price_fn() -> float:
        trade_calls["n"] += 1  # must never be called when closed
        return 123.0

    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=lambda: sat,
        bars_fn=_make_bars_fn(_concentrated_session()),
        price_fn=price_fn,
        sleep_fn=_nosleep,
    )
    events = await _collect(feed, 10_000)  # generator ends on its own when closed

    books = [e for e in events if isinstance(e, BookState)]
    markers = [e for e in events if isinstance(e, Marker)]
    trades = [e for e in events if isinstance(e, Trade)]

    assert books, "warmup SYNTH profile must still render when closed"
    # two-sided depth: some warmup books carry an ask channel (mass above the
    # then-current price); all books are finite.
    assert all(np.isfinite(b.bid_sz).all() and np.isfinite(b.ask_sz).all() for b in books)
    assert not trades, "closed market must emit no stale live trades"
    assert trade_calls["n"] == 0, "must not poll last price when closed"
    assert len(markers) == 1 and markers[0].kind == "session_break"
    assert "closed" in markers[0].text

    assert feed.feed_state == "closed"
    # next open is Monday 2026-07-20 09:30 ET.
    assert feed.next_open_ts == _et_ns(2026, 7, 20, 9, 30)


async def test_closed_with_no_bars_still_marks_session_break():
    sat = _et_ns(2026, 7, 18, 12, 0)
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=lambda: sat,
        bars_fn=_make_bars_fn([]),
    )
    events = await _collect(feed, 100)
    markers = [e for e in events if isinstance(e, Marker)]
    assert len(markers) == 1 and markers[0].kind == "session_break"
    assert markers[0].ts_ns == sat
    assert feed.feed_state == "closed"


# --- 5. market open ------------------------------------------------------------


async def test_market_open_polls_and_emits_trades():
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=_StepClock(_et_ns(2026, 7, 15, 11, 0), DT_KEYLESS_NS),
        bars_fn=_make_bars_fn(_concentrated_session()),
        price_fn=_const_price(150.25),
        sleep_fn=_nosleep,
        bar_refresh_ns=10**18,
    )
    events = await _collect(feed, 20)
    trades = [e for e in events if isinstance(e, Trade)]
    assert trades, "open market must emit live display trades"
    assert all(t.price == 150.25 and t.side_src == SIDE_SRC_NA for t in trades)
    assert feed.feed_state == "live"


# --- 6a. tier auto-select + capability -----------------------------------------


def test_tier_keyless_when_no_keys():
    feed = EquityFeed("AAPL", Config())
    assert feed.tier == "keyless"
    assert feed.capability == {
        "depth": "SYNTH",
        "tape": "poll",
        "trade_side": "na",
        "vwap": "approx",
        "markers": ["gap", "session_break"],
    }
    assert feed.market == EQUITY_MARKET
    assert feed.symbol == "AAPL"


def test_tier_alpaca_when_both_keys():
    feed = EquityFeed("AAPL", Config(alpaca_key="k", alpaca_secret="s"))
    assert feed.tier == "alpaca"
    assert feed.capability["depth"] == "L1"
    assert feed.capability["trade_side"] == "inferred"
    assert feed.capability["tape"] == "tick"


def test_tier_finnhub_when_finnhub_key_only():
    feed = EquityFeed("AAPL", Config(finnhub_key="tok"))
    assert feed.tier == "finnhub"
    assert feed.capability["depth"] == "N/A"
    assert feed.capability["trade_side"] == "inferred"


def test_symbol_uppercased():
    assert EquityFeed("aapl", Config()).symbol == "AAPL"


# --- 6b. keyed sink side inference (translation seam) --------------------------


def _stk_trade(ts: int, price: float) -> StkTrade:
    return StkTrade(
        provider="finnhub",
        symbol="AAPL",
        symbol_raw="AAPL",
        local_ts=ts,
        source_ts=ts,
        id="",
        price=price,
        size=10.0,
    )


async def test_keyed_sink_tick_rule_finnhub():
    out: list[FeedEvent] = []
    sink = _EquitySink(out.append, use_quote_rule=False)
    await sink.put(_stk_trade(1, 100.0))  # first -> BUY default
    await sink.put(_stk_trade(2, 101.0))  # up -> BUY
    await sink.put(_stk_trade(3, 100.5))  # down -> SELL
    await sink.put(_stk_trade(4, 100.5))  # flat -> carries SELL
    sides = [t.side for t in out]
    assert sides == [SIDE_BUY, SIDE_BUY, SIDE_SELL, SIDE_SELL]
    assert all(isinstance(t, Trade) and t.side_src == SIDE_SRC_INFERRED for t in out)
    assert all(t.venue == "finnhub" for t in out)


async def test_keyed_sink_quote_rule_alpaca_emits_bbo_and_infers_side():
    out: list[FeedEvent] = []
    sink = _EquitySink(out.append, use_quote_rule=True)
    # streamed L1 quote sets the midpoint (100.5) and surfaces as a BBO.
    await sink.put(
        StkQuote(
            provider="alpaca",
            symbol="AAPL",
            symbol_raw="AAPL",
            local_ts=1,
            source_ts=1,
            bid_px=100.0,
            bid_sz=5.0,
            ask_px=101.0,
            ask_sz=7.0,
        )
    )
    await sink.put(_stk_trade(2, 100.9))  # above mid -> BUY
    await sink.put(_stk_trade(3, 100.1))  # below mid -> SELL
    bbos = [e for e in out if isinstance(e, BBO)]
    trades = [e for e in out if isinstance(e, Trade)]
    assert len(bbos) == 1 and bbos[0].bid_px == 100.0 and bbos[0].ask_px == 101.0
    assert [t.side for t in trades] == [SIDE_BUY, SIDE_SELL]
    assert all(t.side_src == SIDE_SRC_INFERRED for t in trades)
    # the streamed L1 quote also lands as a real two-sided depth column (fills
    # the keyed depth channel; sizes emitted raw so the imbalance survives).
    books = [e for e in out if isinstance(e, BookState)]
    assert len(books) == 1
    b = books[0]
    assert b.bid_px.tolist() == [100.0] and b.bid_sz.tolist() == [5.0]
    assert b.ask_px.tolist() == [101.0] and b.ask_sz.tolist() == [7.0]


async def test_keyed_sink_alpaca_skips_zero_price_quote_for_depth():
    """Alpaca sends a 0 price to mean "no quote on this side" (at the open, on
    illiquid names, during a halt). Such a quote must NOT become a depth level:
    a 0-priced bid/ask would snap the grid's reanchor midpoint to ~half the real
    price. The BBO still surfaces (that path already existed), but no BookState."""
    out: list[FeedEvent] = []
    sink = _EquitySink(out.append, use_quote_rule=True)
    await sink.put(
        StkQuote(
            provider="alpaca",
            symbol="AAPL",
            symbol_raw="AAPL",
            local_ts=1,
            source_ts=1,
            bid_px=0.0,  # "no bid" sentinel
            bid_sz=0.0,
            ask_px=101.0,
            ask_sz=7.0,
        )
    )
    assert not [e for e in out if isinstance(e, BookState)], "0-priced quote must not become depth"
    # a healthy two-sided quote afterwards DOES produce a depth column.
    await sink.put(
        StkQuote(
            provider="alpaca", symbol="AAPL", symbol_raw="AAPL", local_ts=2, source_ts=2,
            bid_px=100.0, bid_sz=5.0, ask_px=101.0, ask_sz=7.0,
        )
    )
    assert len([e for e in out if isinstance(e, BookState)]) == 1


# --- 6c. re-callable events() + protocol ---------------------------------------


async def test_events_recallable_fresh_state():
    sat = _et_ns(2026, 7, 18, 12, 0)
    feed = EquityFeed(
        "AAPL",
        Config(),
        now_ns_fn=lambda: sat,
        bars_fn=_make_bars_fn(_concentrated_session()),
    )
    first = await _collect(feed, 10_000)
    second = await _collect(feed, 10_000)
    n_books_1 = sum(isinstance(e, BookState) for e in first)
    n_books_2 = sum(isinstance(e, BookState) for e in second)
    assert n_books_1 == n_books_2 > 0
    assert feed.feed_state == "closed"  # honest after each run


def test_equityfeed_satisfies_feed_protocol():
    feed = EquityFeed("AAPL", Config())
    assert isinstance(feed, Feed)
    assert isinstance(feed.capability, dict)


# --- shared injectable seams ---------------------------------------------------


def _make_bars_fn(bars: list[StkBar]):
    async def bars_fn() -> list[StkBar]:
        return list(bars)

    return bars_fn


def _const_price(px: float):
    async def price_fn() -> float:
        return px

    return price_fn
