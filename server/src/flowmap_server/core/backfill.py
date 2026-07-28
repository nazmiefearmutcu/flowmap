"""First-launch history backfill: candles -> reconstructed grid columns.

GOAL 1 (data plane). On a COLD subscribe (no Parquet tail to rehydrate) the
grid ring is empty, so the client's eager ``requestHistory`` after the first
snapshot returns nothing. This module fetches a bounded span of candles for the
symbol and converts them into :class:`~flowmap_server.core.grid.FinalizedColumn`
objects that :meth:`Grid.preload` accepts, so the ring actually holds recent
history before the first attach.

**Honesty (load-bearing).** Candles carry OHLCV (crypto klines also carry a
taker buy/sell split), NOT the resting order book. The synthesized density is a
volume-at-price *reconstruction* — where price traded, not resting L2 size — so
the session badges the whole backfilled region ``history: 'reconstructed'`` and
the caller emits a ``Marker{kind=gap}`` between the reconstructed tail and live.
Reconstructed columns are seeded into the ring but are deliberately NOT recorded
to Parquet (only genuine live columns persist for a future rehydration).

The network fetch is fully behind the injectable ``BackfillFn`` seam
(``async (market, symbol, *, max_cols, now_ns) -> Sequence[Candle]``): pytest
feeds canned candles and never hits the network; the default production seam
(:func:`default_backfill_fn`) dispatches crypto -> Crocodile ``iter_backfill``
klines where a venue has a native REST backfill and ccxt ``fetchOHLCV`` for the
rest, equity -> Crocodile's Yahoo 1 m bars; all imported lazily so the heavy
provider deps never load in tests.

Conversion rules (mirrors :meth:`Grid.preload`'s contract):

- one column per candle, ``col_seq`` assigned ``0..N-1`` (strictly contiguous,
  which preload requires), ``t0_ns`` snapped onto the grid's ``dt`` grid and
  forced strictly increasing;
- a single synthetic epoch 0 whose ``p0`` is centered on the last candle's
  close (so live data continues in the SAME epoch with no spurious re-anchor),
  with ``tick``/``tick_multiple``/``dt_ns``/``rows`` equal to the grid cfg;
- each candle's volume spread across its ``[low, high]`` row band and split at
  the candle close into the bid channel (``price <= close``) and the ask
  channel (``price > close``) — a two-sided volume-at-price profile;
- one global scale factor normalizes the densest bucket across ALL columns to
  ``PEAK_TARGET`` (bounded far below float16's ceiling, so a liquid name's
  volume cannot overflow the ring — spec §8.1 — while cross-column and
  cross-side ratios survive exactly);
- bars carry the candle OHLC and (crypto only) a reconstructed
  ``vol_buy``/``vol_sell``/``cvd_cum`` from the taker split; equity bars have no
  side split so those stay 0 (cvd flat). ``vwap_*`` accumulate from the candle
  typical price for both markets.

Banded (wide/full/deep) grids are skipped — their ``tick_multiple`` is frozen
from the first real mid, which does not compose with a pre-seeded epoch; the
default ``native`` band (the first-launch default) is always eligible.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Sequence

import msgspec
import numpy as np

from flowmap_server.core.grid import FinalizedColumn, GridCfg
from flowmap_server.proto.events import BarColumn, EpochParams

__all__ = ["Candle", "BackfillFn", "columns_from_candles", "default_backfill_fn"]

logger = logging.getLogger(__name__)

# Normalized peak of the reconstructed density (mirrors the equity SYNTH profile
# target): a bounded RELATIVE intensity, never a share count. A liquid name's raw
# candle volume cast to the grid's float16 ring (max 65 504) would overflow to
# inf; one global scale keeps every texel ~1e3 (~65x headroom) while preserving
# between-bucket and cross-side ratios.
PEAK_TARGET = 1000.0
_NAN = float("nan")


class Candle(msgspec.Struct):
    """One OHLCV candle for backfill (canonical, provider-agnostic).

    ``t0_ns`` is the candle-open UTC ns. ``buy_volume``/``sell_volume`` are the
    taker aggressor split (crypto klines); ``None`` for markets without a split
    (equity), which suppresses the reconstructed CVD.
    """

    t0_ns: int
    o: float
    h: float
    l: float
    c: float
    volume: float
    buy_volume: float | None = None
    sell_volume: float | None = None


# async (market, symbol, *, max_cols, now_ns) -> candles (oldest-first ideally;
# the converter sorts defensively). Returns [] to decline (e.g. sim).
BackfillFn = Callable[..., Awaitable[Sequence[Candle]]]


def _finite(*vals: float) -> bool:
    return all(v is not None and np.isfinite(v) for v in vals)


def columns_from_candles(
    candles: Sequence[Candle],
    cfg: GridCfg,
) -> tuple[list[FinalizedColumn], EpochParams] | None:
    """Convert candles to ``(columns, epoch)`` for :meth:`Grid.preload`.

    Returns ``None`` when nothing usable can be produced (no finite candles, a
    banded grid, a degenerate price frame) — the caller then degrades to a cold
    start. Never raises on ordinary bad input; only programming errors surface.
    """
    if cfg.band_up is not None or cfg.band_down is not None:
        # Banded grids freeze tick_multiple from the first real mid — a
        # pre-seeded epoch cannot honor that. Cold start on those.
        return None

    rows = cfg.rows
    step = cfg.tick * cfg.tick_multiple
    dt = cfg.dt_ns
    if rows <= 0 or step <= 0.0 or dt <= 0:
        return None

    # Keep finite candles, sorted by (snapped) t0, deduped so t0 strictly
    # increases (preload requires it). Newest kept when two snap together.
    clean: list[Candle] = []
    for cd in candles:
        if not _finite(cd.o, cd.h, cd.l, cd.c, cd.volume):
            continue
        if cd.volume < 0.0 or not (cd.c > 0.0):
            continue
        clean.append(cd)
    if not clean:
        return None
    clean.sort(key=lambda cd: cd.t0_ns)

    ref = float(clean[-1].c)
    if not (ref > 0.0):
        return None
    # Frame centered on the last close, snapped onto the step grid, so live data
    # continues in this epoch without an immediate re-anchor.
    span = rows * step
    p0 = round((ref - span / 2.0) / step) * step

    def row_of(px: float) -> int:
        return int(round((px - p0) / step))

    # First pass: raw two-sided densities + running bar accumulators.
    raw: list[np.ndarray] = []  # each [2, rows] float64
    t0s: list[int] = []
    cvd_cum = 0.0
    vwap_num = 0.0
    vwap_den = 0.0
    bars: list[BarColumn] = []
    prev_t0 = None
    global_peak = 0.0
    for cd in clean:
        t0 = (cd.t0_ns // dt) * dt
        if prev_t0 is not None and t0 <= prev_t0:
            t0 = prev_t0 + dt  # force strictly increasing on the dt grid
        prev_t0 = t0

        dens = np.zeros((2, rows), dtype=np.float64)
        lo_r = row_of(min(cd.l, cd.h))
        hi_r = row_of(max(cd.l, cd.h))
        lo_r, hi_r = min(lo_r, hi_r), max(lo_r, hi_r)
        band = [r for r in range(lo_r, hi_r + 1) if 0 <= r < rows]
        if band:
            per = float(cd.volume) / len(band)
            close_r = row_of(cd.c)
            for r in band:
                # price(row) <= close -> bid channel, else ask channel.
                dens[0 if r <= close_r else 1, r] += per
        raw.append(dens)
        t0s.append(t0)
        global_peak = max(global_peak, float(dens.max()) if dens.size else 0.0)

        # Reconstructed bar. Crypto: real taker split -> vol_buy/vol_sell + cvd.
        has_split = cd.buy_volume is not None and cd.sell_volume is not None
        vb = float(cd.buy_volume) if has_split else 0.0
        vs = float(cd.sell_volume) if has_split else 0.0
        if has_split and _finite(vb, vs):
            cvd_cum += vb - vs
        else:
            vb = vs = 0.0
        tp = (cd.h + cd.l + cd.c) / 3.0
        vwap_num += tp * float(cd.volume)
        vwap_den += float(cd.volume)
        bars.append(
            BarColumn(
                epoch=0,
                col_seq=len(bars),  # provisional; rewritten below with real seq
                t0_ns=t0,
                o=float(cd.o),
                h=float(cd.h),
                l=float(cd.l),
                c=float(cd.c),
                vol_buy=vb,
                vol_sell=vs,
                cvd_cum=cvd_cum,
                vwap_num_cum=vwap_num,
                vwap_den_cum=vwap_den,
            )
        )

    scale = (PEAK_TARGET / global_peak) if global_peak > 0.0 else 1.0
    columns: list[FinalizedColumn] = []
    for seq, (dens, t0, bar) in enumerate(zip(raw, t0s, bars, strict=True)):
        d16 = (dens * scale).astype(np.float16)
        bar = msgspec.structs.replace(bar, col_seq=seq)
        columns.append(
            FinalizedColumn(
                epoch=0,
                col_seq=seq,
                t0_ns=t0,
                bid=d16[0],
                ask=d16[1],
                bar=bar,
            )
        )

    epoch = EpochParams(
        epoch=0,
        tick=cfg.tick,
        tick_multiple=cfg.tick_multiple,
        dt_ns=dt,
        p0=p0,
        rows=rows,
    )
    return columns, epoch


# --- default (production) network seam -----------------------------------------
# Imported lazily; NEVER exercised by pytest (tests inject their own BackfillFn).


async def default_backfill_fn(
    market: str, symbol: str, *, max_cols: int, now_ns: int
) -> list[Candle]:
    """Production backfill seam: crypto klines / equity Yahoo bars -> candles.

    Best-effort and self-contained: any provider failure returns ``[]`` so the
    session degrades to a clean cold start. ``sim`` never backfills (it
    generates live data immediately)."""
    if max_cols <= 0:
        return []
    try:
        if market == "sim":
            return []
        from flowmap_server.feeds.crypto import is_crypto_market
        from flowmap_server.feeds.equity import EQUITY_MARKETS

        if is_crypto_market(market):
            return await crypto_klines(market, symbol, max_bars=max_cols, now_ns=now_ns)
        if market in EQUITY_MARKETS:
            return await _equity_candles(symbol, max_cols=max_cols)
    except Exception:  # noqa: BLE001 — backfill is best-effort; cold start on any error
        logger.warning("backfill failed for %s:%s; cold start", market, symbol, exc_info=True)
    return []


# Market segments that mean "derivatives" to ccxt's defaultType option. Used
# only to disambiguate a bare symbol (BTCUSDT) when a venue lists both a spot
# and a perp pair under near-identical names.
_SWAP_SEGMENTS = frozenset({"usdm", "coinm", "linear", "inverse", "swap", "perp", "futures"})


# Interval label -> its span in ns. The two the app asks for: 1 m grid columns
# and 1 h quote sparks.
_INTERVAL_NS: dict[str, int] = {"1m": 60 * 10**9, "1h": 3600 * 10**9}


async def crypto_klines(
    market: str, symbol: str, *, interval: str = "1m", max_bars: int, now_ns: int
) -> list[Candle]:
    """Crypto klines, from whichever path the venue actually has.

    The engine's hand-written REST backfill covers ``ohlcv`` for Binance only
    (``SUPPORTED_CHANNELS``). Every other venue is reachable through ccxt's
    ``fetchOHLCV``, so falling back there is the difference between a chart with
    history and a cold start on all but one of the venues.
    """
    from crocodile.crypto.client.backfill import SUPPORTED_CHANNELS

    from flowmap_server.data.venues import resolve_symbol

    exchange, _, seg = market.partition("-")
    seg = seg or "spot"
    # Same translation the live feed does: a symbol in the other venue's
    # spelling must not silently cost us the native path (and with it the taker
    # split) by failing the venue's REST call.
    symbol = await resolve_symbol(market, symbol)
    kw = {"interval": interval, "max_bars": max_bars, "now_ns": now_ns}
    if "ohlcv" in SUPPORTED_CHANNELS.get(exchange, frozenset()):
        # Native first: only the venue's own klines carry the taker buy/sell
        # split, which is what makes the reconstructed CVD real rather than
        # flat. ccxt's unified OHLCV has no such column.
        try:
            native = await _native_candles(exchange, symbol, seg, **kw)
        except Exception:  # noqa: BLE001 — fall through to ccxt below
            logger.warning("native klines failed for %s; trying ccxt", market, exc_info=True)
        else:
            if native:
                return native
    return await _ccxt_candles(exchange, symbol, seg, **kw)


async def _native_candles(
    exchange: str, symbol: str, seg: str, *, interval: str, max_bars: int, now_ns: int
) -> list[Candle]:
    from crocodile.crypto.client.backfill import iter_backfill

    span = _INTERVAL_NS.get(interval, 60 * 10**9)
    start = now_ns - max_bars * span
    out: list[Candle] = []
    backfill_obj, session = _hardened_backfill(exchange, seg)
    try:
        async for rec in iter_backfill(
            exchange,
            "ohlcv",
            symbol,
            start,
            now_ns,
            market=seg,
            interval=interval,
            backfill_obj=backfill_obj,
        ):
            ts = rec.source_ts if rec.source_ts is not None else rec.local_ts
            # The merged OHLCV makes the taker split optional: a venue that does
            # not report it now says None instead of a fabricated 0.0. Pass the
            # absence through — Candle already treats None as "no split", which
            # keeps CVD flat instead of drawing a fake all-sell bar.
            buy, sell = rec.buy_volume, rec.sell_volume
            out.append(
                Candle(
                    t0_ns=int(ts),
                    o=float(rec.open),
                    h=float(rec.high),
                    l=float(rec.low),
                    c=float(rec.close),
                    volume=float(rec.volume),
                    buy_volume=None if buy is None else float(buy),
                    sell_volume=None if sell is None else float(sell),
                )
            )
            if len(out) >= max_bars:
                break
    finally:
        if session is not None:
            await session.close()
    return out


# Binance REST bases per market segment. The engine's `make_live_backfill`
# wires klines to the SPOT base for every segment, so a usdm/coinm backfill
# would silently read spot candles; naming the base here fixes that as a
# side-effect of hardening the session.
_BINANCE_KLINE_BASE = {
    "spot": "https://api.binance.com/api/v3",
    "usdm": "https://fapi.binance.com/fapi/v1",
    "coinm": "https://dapi.binance.com/dapi/v1",
}


def _hardened_backfill(exchange: str, seg: str) -> tuple[object | None, object | None]:
    """A backfill object whose REST session trusts the certifi CA bundle.

    Same problem `_harden_rest_ssl` solves for the live feed: on a stock macOS
    framework Python the default OpenSSL trust store cannot verify these hosts,
    and the engine's own backfill builds its session internally where that
    wrapper cannot reach. Returns ``(None, None)`` — plain engine defaults —
    for venues we have no hardening recipe for, or if certifi is unavailable.
    """
    if exchange != "binance":
        return None, None
    try:
        import functools
        import ssl

        import aiohttp
        import certifi

        from crocodile.crypto.exchanges.binance.backfill import (
            BinanceBackfill,
            _live_fetch_klines,
        )
    except Exception:  # noqa: BLE001 — keep engine defaults if anything is absent
        return None, None
    ctx = ssl.create_default_context(cafile=certifi.where())
    session = aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=ctx))
    try:
        base = _BINANCE_KLINE_BASE.get(seg, _BINANCE_KLINE_BASE["spot"])
        bf = BinanceBackfill(
            fetch_aggtrades=None,
            fetch_klines=functools.partial(_live_fetch_klines, rest_base=base, session=session),
            fetch_open_interest=None,
            fetch_open_interest_hist=None,
        )
    except Exception:  # noqa: BLE001 — never leak the session we just opened
        session._connector.close()  # sync close; we are not in an await context
        raise
    return bf, session


async def _ccxt_candles(
    exchange: str, symbol: str, seg: str, *, interval: str, max_bars: int, now_ns: int
) -> list[Candle]:
    """1-minute klines for any ccxt venue, via ``fetchOHLCV``.

    Returns ``[]`` rather than raising when the venue is not a ccxt id (the
    on-chain and CoinGecko readers), does not serve OHLCV, or does not list the
    symbol — the caller treats an empty result as a clean cold start.

    No taker split: ccxt's unified OHLCV has no buy/sell breakdown, so the
    candles carry ``None`` and the reconstructed CVD stays flat instead of
    inventing a direction.
    """
    from crocodile.crypto.exchanges.ccxt_universal.connector import CCXTConnector
    from flowmap_server.data.venues import ccxt_knows

    # `ccxt_knows`, not `factory.is_ccxt_exchange` — the latter is False for the
    # five venues that also have a native connector, and those are precisely the
    # ones whose klines we need from ccxt (the engine's own REST backfill serves
    # ohlcv for Binance alone).
    if not ccxt_knows(exchange):
        return []
    import ccxt.async_support as ccxt_async

    default_type = "swap" if seg in _SWAP_SEGMENTS else "spot"
    ex = getattr(ccxt_async, exchange)(
        {"enableRateLimit": True, "options": {"defaultType": default_type}}
    )
    try:
        if not ex.has.get("fetchOHLCV"):
            return []
        markets = await ex.load_markets()
        unified = CCXTConnector._resolve_symbol(symbol, markets, ex.markets_by_id)
        if unified is None:
            logger.warning("ccxt backfill: %s does not list %r", exchange, symbol)
            return []
        span = _INTERVAL_NS.get(interval, 60 * 10**9)
        since_ms = (now_ns - max_bars * span) // 10**6
        rows = await ex.fetch_ohlcv(unified, interval, since=int(since_ms), limit=max_bars)
    finally:
        await ex.close()
    out: list[Candle] = []
    for ts_ms, o, h, l, c, vol in rows[-max_bars:]:
        if None in (ts_ms, o, h, l, c):
            continue
        out.append(
            Candle(
                t0_ns=int(ts_ms) * 10**6,
                o=float(o),
                h=float(h),
                l=float(l),
                c=float(c),
                volume=float(vol or 0.0),
            )
        )
    return out


async def _equity_candles(symbol: str, *, max_cols: int) -> list[Candle]:
    from crocodile.equity.providers.yahoo.client import YahooClient

    bars = await YahooClient().fetch_intraday_bars(symbol.upper(), "1m")
    out: list[Candle] = []
    for bar in bars[-max_cols:]:
        ts = bar.source_ts if bar.source_ts is not None else bar.local_ts
        if None in (bar.open, bar.high, bar.low, bar.close, bar.volume):
            continue
        out.append(
            Candle(
                t0_ns=int(ts),
                o=float(bar.open),
                h=float(bar.high),
                l=float(bar.low),
                c=float(bar.close),
                volume=float(bar.volume),
            )
        )
    return out
