"""``core.backfill.crypto_klines`` — the reworked native/ccxt dispatch. NO network.

With 109 venues and a hand-written REST backfill that covers ``ohlcv`` for
Binance alone, the dispatch rule is the difference between a chart with history
and a cold start on 108 of them:

- native FIRST where the venue has a native REST ohlcv path, because only the
  venue's own klines carry the taker buy/sell split that makes the
  reconstructed CVD real rather than flat;
- ccxt otherwise, AND whenever the native path raises or comes back empty.

Both candle fetchers are monkeypatched here, so the tests assert the routing
itself. ``_native_candles`` is then exercised over a fake ``iter_backfill`` to
pin the other half of the merge: the merged ``OHLCV`` made the taker split
``float | None``, and ``float(None)`` raises — the absence has to be passed
through, not coerced, or every venue that omits the split would fail backfill
outright.
"""

from __future__ import annotations

import pytest
from crocodile.core.schema.enums import AssetClass
from crocodile.core.schema.records import OHLCV

from flowmap_server.core import backfill
from flowmap_server.core.backfill import Candle, crypto_klines

NOW = 1_700_000_000 * 10**9
MINUTE = 60 * 10**9


def _candle(t0: int = NOW, tag: float = 1.0) -> Candle:
    return Candle(t0_ns=t0, o=tag, h=tag, l=tag, c=tag, volume=tag)


@pytest.fixture(autouse=True)
def _no_symbol_translation(monkeypatch):
    """``resolve_symbol`` is a network path; identity by default."""

    async def identity(market: str, symbol: str) -> str:
        return symbol

    monkeypatch.setattr("flowmap_server.data.venues.resolve_symbol", identity)


class _Spy:
    """Records the call and returns a canned result (or raises)."""

    def __init__(self, result=None, exc: BaseException | None = None) -> None:
        self.result = [] if result is None else result
        self.exc = exc
        self.calls: list[tuple[tuple, dict]] = []

    async def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.exc is not None:
            raise self.exc
        return self.result

    @property
    def n(self) -> int:
        return len(self.calls)


def _spies(monkeypatch, *, native: _Spy, ccxt: _Spy) -> None:
    monkeypatch.setattr(backfill, "_native_candles", native)
    monkeypatch.setattr(backfill, "_ccxt_candles", ccxt)


# --- the table the dispatch reads ----------------------------------------------


def test_only_binance_has_a_native_ohlcv_path_today() -> None:
    """The dispatch is table-driven; this pins what the table currently says."""
    from crocodile.crypto.client.backfill import SUPPORTED_CHANNELS

    with_ohlcv = {ex for ex, ch in SUPPORTED_CHANNELS.items() if "ohlcv" in ch}
    assert with_ohlcv == {"binance"}
    # The other native venues DO have a REST backfill — just not for klines.
    assert {"bybit", "okx", "deribit"} <= set(SUPPORTED_CHANNELS)


# --- native-first ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("market", "seg"),
    [("binance", "spot"), ("binance-spot", "spot"), ("binance-usdm", "usdm"),
     ("binance-coinm", "coinm")],
)
async def test_binance_goes_native_first(monkeypatch, market: str, seg: str) -> None:
    native = _Spy([_candle()])
    ccxt = _Spy([_candle(tag=99.0)])
    _spies(monkeypatch, native=native, ccxt=ccxt)

    out = await crypto_klines(market, "BTCUSDT", max_bars=120, now_ns=NOW)

    assert out == [_candle()]
    assert ccxt.n == 0, "ccxt was called even though native served the request"
    (args, kwargs) = native.calls[0]
    assert args == ("binance", "BTCUSDT", seg)  # a bare venue means spot
    assert kwargs == {"interval": "1m", "max_bars": 120, "now_ns": NOW}


async def test_interval_is_threaded_through(monkeypatch) -> None:
    native = _Spy([_candle()])
    ccxt = _Spy()
    _spies(monkeypatch, native=native, ccxt=ccxt)
    await crypto_klines("binance-spot", "BTCUSDT", interval="1h", max_bars=24, now_ns=NOW)
    assert native.calls[0][1]["interval"] == "1h"


async def test_dispatch_follows_the_table_not_a_hardcoded_venue(monkeypatch) -> None:
    """If a venue gains a native ohlcv path it must be used without a code edit."""
    monkeypatch.setattr(
        "crocodile.crypto.client.backfill.SUPPORTED_CHANNELS",
        {"kraken": frozenset({"ohlcv"})},
    )
    native = _Spy([_candle()])
    ccxt = _Spy([_candle(tag=99.0)])
    _spies(monkeypatch, native=native, ccxt=ccxt)

    assert await crypto_klines("kraken", "BTC/USD", max_bars=10, now_ns=NOW) == [_candle()]
    assert native.n == 1 and ccxt.n == 0
    # ...and binance, now absent from the table, drops to ccxt.
    assert await crypto_klines("binance-spot", "BTCUSDT", max_bars=10, now_ns=NOW) == [
        _candle(tag=99.0)
    ]
    assert native.n == 1 and ccxt.n == 1


# --- ccxt fallback --------------------------------------------------------------


@pytest.mark.parametrize(
    ("market", "seg"),
    [
        ("kraken", "spot"),  # ccxt-only venue
        ("kucoin", "spot"),
        ("bybit-linear", "linear"),  # native connector, but no native klines
        ("okx", "spot"),
        ("deribit", "spot"),
    ],
)
async def test_venue_without_native_klines_uses_ccxt(
    monkeypatch, market: str, seg: str
) -> None:
    native = _Spy([_candle()])
    ccxt = _Spy([_candle(tag=99.0)])
    _spies(monkeypatch, native=native, ccxt=ccxt)

    out = await crypto_klines(market, "BTCUSDT", max_bars=60, now_ns=NOW)

    assert out == [_candle(tag=99.0)]
    assert native.n == 0, "a venue with no native ohlcv path must not be tried natively"
    exchange = market.partition("-")[0]
    assert ccxt.calls[0][0] == (exchange, "BTCUSDT", seg)
    assert ccxt.calls[0][1] == {"interval": "1m", "max_bars": 60, "now_ns": NOW}


async def test_empty_native_result_falls_back_to_ccxt(monkeypatch) -> None:
    native = _Spy([])  # venue reachable but served nothing
    ccxt = _Spy([_candle(tag=99.0)])
    _spies(monkeypatch, native=native, ccxt=ccxt)

    out = await crypto_klines("binance-usdm", "BTCUSDT", max_bars=60, now_ns=NOW)

    assert out == [_candle(tag=99.0)]
    assert native.n == 1 and ccxt.n == 1
    # The fallback gets the SAME arguments the native attempt did.
    assert ccxt.calls[0][0] == native.calls[0][0]
    assert ccxt.calls[0][1] == native.calls[0][1]


async def test_native_exception_is_swallowed_into_the_ccxt_fallback(monkeypatch) -> None:
    """A native REST outage must cost the taker split, not the whole history."""
    native = _Spy(exc=RuntimeError("binance REST 451"))
    ccxt = _Spy([_candle(tag=99.0)])
    _spies(monkeypatch, native=native, ccxt=ccxt)

    out = await crypto_klines("binance-spot", "BTCUSDT", max_bars=60, now_ns=NOW)

    assert out == [_candle(tag=99.0)]
    assert native.n == 1 and ccxt.n == 1


async def test_a_ccxt_failure_is_not_swallowed_here(monkeypatch) -> None:
    """There is no third path, so the caller's own best-effort guard owns it —
    silently returning [] here would hide a real bug from the log."""
    native = _Spy(exc=RuntimeError("down"))
    ccxt = _Spy(exc=RuntimeError("also down"))
    _spies(monkeypatch, native=native, ccxt=ccxt)
    with pytest.raises(RuntimeError, match="also down"):
        await crypto_klines("binance-spot", "BTCUSDT", max_bars=60, now_ns=NOW)


async def test_default_backfill_fn_degrades_to_a_cold_start(monkeypatch) -> None:
    """The seam above ``crypto_klines`` is where a total failure becomes []."""
    async def boom(market, symbol, **kw):
        raise RuntimeError("everything is down")

    monkeypatch.setattr(backfill, "crypto_klines", boom)
    assert await backfill.default_backfill_fn(
        "binance-spot", "BTCUSDT", max_cols=10, now_ns=NOW
    ) == []
    # sim never backfills, and a zero budget short-circuits before any dispatch.
    assert await backfill.default_backfill_fn("sim", "SIM-DEMO", max_cols=10, now_ns=NOW) == []
    assert await backfill.default_backfill_fn(
        "binance-spot", "BTCUSDT", max_cols=0, now_ns=NOW
    ) == []


# --- symbol translation happens BEFORE the dispatch ----------------------------


async def test_symbol_is_resolved_before_either_fetcher(monkeypatch) -> None:
    """A symbol in the other venue's spelling must not silently cost us the
    native path (and with it the taker split)."""

    async def translate(market: str, symbol: str) -> str:
        assert market == "binance-usdm"
        return "BTCUSDT" if symbol == "BTC/USDT" else symbol

    monkeypatch.setattr("flowmap_server.data.venues.resolve_symbol", translate)
    native = _Spy([_candle()])
    ccxt = _Spy()
    _spies(monkeypatch, native=native, ccxt=ccxt)

    await crypto_klines("binance-usdm", "BTC/USDT", max_bars=10, now_ns=NOW)
    assert native.calls[0][0][1] == "BTCUSDT"


# --- _native_candles: the Optional taker split ---------------------------------


def _ohlcv(ts: int, *, buy: float | None, sell: float | None) -> OHLCV:
    return OHLCV(
        source="binance-spot",
        symbol="binance-spot:BTCUSDT",
        symbol_raw="BTCUSDT",
        asset_class=AssetClass.CRYPTO,
        source_ts=ts,
        local_ts=ts + 1,
        interval="1m",
        open=100.0,
        high=101.0,
        low=99.0,
        close=100.5,
        volume=10.0,
        buy_volume=buy,
        sell_volume=sell,
    )


def _fake_iter(monkeypatch, records: list[OHLCV], seen: list | None = None) -> None:
    async def fake(*args, **kwargs):
        if seen is not None:
            seen.append((args, kwargs))
        for rec in records:
            yield rec

    monkeypatch.setattr("crocodile.crypto.client.backfill.iter_backfill", fake)
    # Skip the certifi-hardened aiohttp session: engine defaults, no sockets.
    monkeypatch.setattr(backfill, "_hardened_backfill", lambda exchange, seg: (None, None))


async def test_absent_taker_split_stays_none_not_zero(monkeypatch) -> None:
    """The merged ``OHLCV`` made the split Optional. ``float(None)`` raises, and
    a coerced ``0.0`` would draw a fake all-sell bar instead of a flat CVD."""
    _fake_iter(monkeypatch, [_ohlcv(NOW, buy=None, sell=None)])

    (candle,) = await backfill._native_candles(
        "binance", "BTCUSDT", "spot", interval="1m", max_bars=10, now_ns=NOW
    )

    assert candle.buy_volume is None
    assert candle.sell_volume is None
    # `== 0.0` would pass on None-coerced-to-zero too, so assert the type.
    assert not isinstance(candle.buy_volume, float)
    assert candle.volume == 10.0 and candle.c == 100.5


async def test_a_reported_split_survives_including_a_real_zero(monkeypatch) -> None:
    """``0.0`` must still mean "measured: no buying", not "unfilled"."""
    _fake_iter(
        monkeypatch,
        [_ohlcv(NOW, buy=4.0, sell=6.0), _ohlcv(NOW + MINUTE, buy=0.0, sell=10.0)],
    )

    a, b = await backfill._native_candles(
        "binance", "BTCUSDT", "spot", interval="1m", max_bars=10, now_ns=NOW
    )

    assert (a.buy_volume, a.sell_volume) == (4.0, 6.0)
    assert (b.buy_volume, b.sell_volume) == (0.0, 10.0)
    assert b.buy_volume is not None


async def test_a_half_reported_split_is_not_fabricated(monkeypatch) -> None:
    """One side present and one absent must not become (x, 0.0)."""
    _fake_iter(monkeypatch, [_ohlcv(NOW, buy=4.0, sell=None)])

    (candle,) = await backfill._native_candles(
        "binance", "BTCUSDT", "spot", interval="1m", max_bars=10, now_ns=NOW
    )

    assert candle.buy_volume == 4.0
    assert candle.sell_volume is None


async def test_native_candles_window_and_cap(monkeypatch) -> None:
    seen: list = []
    _fake_iter(monkeypatch, [_ohlcv(NOW + i * MINUTE, buy=None, sell=None) for i in range(9)], seen)

    out = await backfill._native_candles(
        "binance", "BTCUSDT", "usdm", interval="1m", max_bars=4, now_ns=NOW
    )

    assert len(out) == 4  # the iterator is cut at max_bars, not drained
    args, kwargs = seen[0]
    assert args[:3] == ("binance", "ohlcv", "BTCUSDT")
    assert args[3] == NOW - 4 * MINUTE  # start = now - max_bars * interval span
    assert args[4] == NOW
    assert kwargs["market"] == "usdm" and kwargs["interval"] == "1m"


async def test_native_candles_falls_back_to_local_ts(monkeypatch) -> None:
    rec = _ohlcv(NOW, buy=None, sell=None)
    import msgspec

    _fake_iter(monkeypatch, [msgspec.structs.replace(rec, source_ts=None)])
    (candle,) = await backfill._native_candles(
        "binance", "BTCUSDT", "spot", interval="1m", max_bars=10, now_ns=NOW
    )
    assert candle.t0_ns == NOW + 1  # local_ts


# --- the certifi-hardened Binance session --------------------------------------


def test_hardened_backfill_keeps_engine_defaults_off_binance() -> None:
    assert backfill._hardened_backfill("kraken", "spot") == (None, None)
    assert backfill._hardened_backfill("okx", "swap") == (None, None)


@pytest.mark.parametrize("seg", ["spot", "usdm", "coinm", "unknown-segment"])
async def test_hardened_backfill_names_the_right_binance_rest_base(seg: str) -> None:
    """The engine's own wiring points klines at the SPOT base for every segment,
    so a usdm/coinm backfill would silently read spot candles."""
    bf, session = backfill._hardened_backfill("binance", seg)
    try:
        assert bf is not None and session is not None
        expected = backfill._BINANCE_KLINE_BASE.get(seg, backfill._BINANCE_KLINE_BASE["spot"])
        assert bf._fetch_klines.keywords["rest_base"] == expected
        assert bf._fetch_klines.keywords["session"] is session
    finally:
        await session.close()
