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
(:func:`default_backfill_fn`) dispatches crypto -> crypcodile ``iter_backfill``
klines and equity -> stockodile Yahoo 1 m bars, and is imported lazily so the
heavy provider deps never load in tests.

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
        from flowmap_server.feeds.crypto import CRYPTO_MARKETS
        from flowmap_server.feeds.equity import EQUITY_MARKETS

        if market in CRYPTO_MARKETS:
            return await _crypto_candles(market, symbol, max_cols=max_cols, now_ns=now_ns)
        if market in EQUITY_MARKETS:
            return await _equity_candles(symbol, max_cols=max_cols)
    except Exception:  # noqa: BLE001 — backfill is best-effort; cold start on any error
        logger.warning("backfill failed for %s:%s; cold start", market, symbol, exc_info=True)
    return []


async def _crypto_candles(
    market: str, symbol: str, *, max_cols: int, now_ns: int
) -> list[Candle]:
    from crypcodile.client.backfill import iter_backfill

    exchange, _, seg = market.partition("-")
    seg = seg or "spot"
    minute = 60 * 10**9
    start = now_ns - max_cols * minute
    out: list[Candle] = []
    async for rec in iter_backfill(
        exchange, "ohlcv", symbol, start, now_ns, market=seg, interval="1m"
    ):
        ts = rec.exchange_ts if rec.exchange_ts is not None else rec.local_ts
        out.append(
            Candle(
                t0_ns=int(ts),
                o=float(rec.open),
                h=float(rec.high),
                l=float(rec.low),
                c=float(rec.close),
                volume=float(rec.volume),
                buy_volume=float(rec.buy_volume),
                sell_volume=float(rec.sell_volume),
            )
        )
        if len(out) >= max_cols:
            break
    return out


async def _equity_candles(symbol: str, *, max_cols: int) -> list[Candle]:
    from stockodile.providers.yahoo.client import YahooClient

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
