"""TTL-cached market data behind an injectable network seam (GOAL 2).

The REST discovery handlers (``/api/movers``, ``/api/quote``) must never call a
provider directly — all network lives here, behind a TTL cache that debounces
per-keystroke traffic so typing in the search box cannot hammer Yahoo / the
exchange REST. Providers are injected as async seams
(``quote_fn`` / ``movers_fn``), so pytest feeds canned data and never touches the
network; the production seams (:func:`default_quote_fn` / :func:`default_movers_fn`)
are imported lazily and wired in :func:`~flowmap_server.api.app.create_app`.

Semantics:

- **TTL + debounce.** A read returns the cached value while it is younger than
  ``ttl_ns`` (an injectable monotonic clock). On a stale/absent entry the fetch
  runs under a per-key ``asyncio.Lock``, so concurrent identical reads collapse
  into ONE provider call.
- **Never raise, never lie.** A provider error returns the last good value
  flagged ``stale=True`` (``reachable=False``); with nothing cached it returns an
  explicit empty ``price=None`` / ``reachable=False`` quote. Display-only data —
  a stale or market-closed equity value is surfaced as ``stale``, never as a live
  print.
- **Background prewarm.** :meth:`run_background` periodically refreshes
  movers so the first UI read is warm; ``create_app``'s lifespan starts it
  for the production cache and cancels it on shutdown, and httpx's
  ASGITransport does not run lifespan events, so plain-ASGI tests never spin
  it up.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Sequence

import msgspec

__all__ = [
    "QuoteData",
    "MarketDataCache",
    "quote_to_json",
    "mover_to_json",
    "default_quote_fn",
    "default_movers_fn",
]

logger = logging.getLogger(__name__)

DEFAULT_TTL_NS = 15 * 10**9  # 15 s: fresh enough for a mover strip, cheap on providers
# Bound on cached entries (quotes AND movers lists) so a long-lived server
# that browses thousands of distinct symbols cannot grow the dicts forever.
# 512 quotes ~ far more than any real browsing session touches; eviction is
# oldest-INSERTED-first (see MarketDataCache._evict).
DEFAULT_MAX_ENTRIES = 512
SPARK_MAX = 64  # cap sparkline points on the wire
# Wall-clock deadline for ONE movers candidate sweep (A2-5). The sweep is
# bounded (~40-100 quotes) but gathered concurrently with no deadline of its
# own, so one hung provider used to hold the whole endpoint. Past the deadline
# whatever ranked already — partial results, honestly — is served.
MOVERS_DEADLINE_S = 15.0
# The movers cache always fetches this many rows (the same clamp /api/movers
# enforces) and slices per caller: caching the FIRST caller's limit poisoned
# a later, larger request for a whole TTL (survey-1 #4).
_MOVERS_MAX = 100

QuoteFn = Callable[[str, str], Awaitable["QuoteData"]]
MoversFn = Callable[[str, int], Awaitable[list["QuoteData"]]]
Clock = Callable[[], int]


class QuoteData(msgspec.Struct):
    """A display-only price snapshot for one symbol.

    ``price``/``change_pct`` are ``None`` when unavailable (unreachable, or no
    data). ``as_of_ns`` is wall-clock UTC ns of the freshest datum. ``stale`` is
    True for market-closed / last-good-on-error data; ``reachable`` is False when
    the provider could not be reached at all.
    """

    market: str
    symbol: str
    price: float | None = None
    change_pct: float | None = None
    spark: list[float] = msgspec.field(default_factory=list)
    as_of_ns: int = 0
    stale: bool = False
    reachable: bool = True


def quote_to_json(q: QuoteData) -> dict[str, object]:
    """``/api/quote`` shape (camelCase; includes ``reachable``)."""
    return {
        "market": q.market,
        "symbol": q.symbol,
        "price": q.price,
        "changePct": q.change_pct,
        "spark": list(q.spark[:SPARK_MAX]),
        "asOf": int(q.as_of_ns),
        "stale": bool(q.stale),
        "reachable": bool(q.reachable),
    }


def mover_to_json(q: QuoteData) -> dict[str, object]:
    """``/api/movers`` shape (camelCase; no ``reachable`` — a listed mover is by
    definition one we reached)."""
    return {
        "market": q.market,
        "symbol": q.symbol,
        "price": q.price,
        "changePct": q.change_pct,
        "spark": list(q.spark[:SPARK_MAX]),
        "asOf": int(q.as_of_ns),
        "stale": bool(q.stale),
    }


class MarketDataCache:
    """TTL cache over injectable quote/movers provider seams."""

    def __init__(
        self,
        *,
        quote_fn: QuoteFn,
        movers_fn: MoversFn,
        ttl_ns: int = DEFAULT_TTL_NS,
        max_entries: int = DEFAULT_MAX_ENTRIES,
        clock: Clock = time.monotonic_ns,
        wall_clock: Clock = time.time_ns,
    ) -> None:
        self._quote_fn = quote_fn
        self._movers_fn = movers_fn
        self._ttl_ns = ttl_ns
        self._max_entries = max(1, int(max_entries))
        self._clock = clock
        self._wall = wall_clock
        self._quotes: dict[tuple[str, str], tuple[int, QuoteData]] = {}
        self._quote_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._movers: dict[str, tuple[int, list[QuoteData]]] = {}
        self._movers_locks: dict[str, asyncio.Lock] = {}

    # -- quotes ----------------------------------------------------------------

    async def quote(self, market: str, symbol: str) -> QuoteData:
        key = (market, symbol.upper())
        cached = self._quotes.get(key)
        if cached is not None and self._fresh(cached[0]):
            return cached[1]
        lock = self._quote_locks.setdefault(key, asyncio.Lock())
        try:
            async with lock:
                cached = self._quotes.get(key)
                if cached is not None and self._fresh(cached[0]):
                    return cached[1]
                try:
                    q = await self._quote_fn(market, symbol.upper())
                except Exception:  # noqa: BLE001 — never raise into the handler
                    logger.debug("quote fetch failed for %s:%s", market, symbol, exc_info=True)
                    return self._fallback_quote(market, symbol.upper(), cached)
                self._quotes[key] = (self._clock(), q)
                self._evict(self._quotes)
                return q
        finally:
            # AFTER the async with released the lock (and any waiters that
            # grabbed it have either finished or are holding it) — pruning
            # INSIDE the block never worked: locked() was always True while
            # the caller still held it (survey-1 #5).
            self._release_lock(self._quote_locks, key, lock)

    def _evict(self, store: dict) -> None:
        """Bound a cache store: drop OLDEST-INSERTED entries while over cap.

        Fresh fetches overwrite in place without reinserting, so dict order
        stays a faithful insertion-time ordering; oldest-first biases
        retention toward the RECENTLY browsed working set. Only successful
        inserts pay this cost — error fallbacks never grow the store.
        """
        while len(store) > self._max_entries:
            store.pop(next(iter(store)))

    @staticmethod
    def _release_lock(locks: dict, key, lock: asyncio.Lock) -> None:
        """Drop a single-flight lock once it is free and no longer mapped.

        Called AFTER the ``async with`` releases the lock: if another request
        has already grabbed (or is waiting on) this exact object, ``locked()``
        keeps the entry; otherwise the key is pruned so the dicts do not grow
        with every symbol ever browsed over a long server lifetime.

        A queued waiter resumption window exists where ``locked()`` is False
        while ``_waiters`` is non-empty (R1-L3): pruning then would let a third
        caller create a NEW lock and run a duplicate fetch. Keep the mapping
        whenever waiters are queued; the eventual holder prunes after release."""
        if getattr(lock, "_waiters", None):
            return
        if not lock.locked() and locks.get(key) is lock:
            locks.pop(key, None)

    def _fallback_quote(
        self, market: str, symbol: str, cached: tuple[int, QuoteData] | None
    ) -> QuoteData:
        if cached is not None:
            prev = cached[1]
            return msgspec.structs.replace(prev, stale=True, reachable=False)
        return QuoteData(
            market=market,
            symbol=symbol,
            price=None,
            change_pct=None,
            spark=[],
            as_of_ns=self._wall(),
            stale=True,
            reachable=False,
        )

    # -- movers ----------------------------------------------------------------

    async def movers(self, market: str, limit: int) -> list[QuoteData]:
        """Ranked movers for *market*, sliced to *limit* (and hard-bounded by
        ``_MOVERS_MAX``). The cache always holds a fixed-max fetch, so a small
        first request can never shrink a later larger one."""
        take = max(0, min(int(limit), _MOVERS_MAX))
        cached = self._movers.get(market)
        if cached is not None and self._fresh(cached[0]):
            return cached[1][:take]
        lock = self._movers_locks.setdefault(market, asyncio.Lock())
        try:
            async with lock:
                cached = self._movers.get(market)
                if cached is not None and self._fresh(cached[0]):
                    return cached[1][:take]
                try:
                    ranked = await self._movers_fn(market, _MOVERS_MAX)
                except Exception:  # noqa: BLE001 — never raise into the handler
                    logger.debug("movers fetch failed for %s", market, exc_info=True)
                    return cached[1][:take] if cached is not None else []
                self._movers[market] = (self._clock(), ranked)
                self._evict(self._movers)
                return ranked[:take]
        finally:
            # Prune run AFTER the async with released the lock (survey-1 #5).
            self._release_lock(self._movers_locks, market, lock)

    # -- background prewarm (production only) ----------------------------------

    async def run_background(self, markets: tuple[str, ...], interval_s: float) -> None:
        """Periodically refresh movers so the first UI read is warm. Started
        by ``create_app``'s lifespan for the production cache (cancelled on
        shutdown); every cycle is wrapped so one bad refresh never stops the
        loop. Refreshes the full ``_MOVERS_MAX`` cache row set so every
        caller's slice is served warm."""
        while True:
            for market in markets:
                try:
                    await self.movers(market, limit=_MOVERS_MAX)
                except Exception:  # noqa: BLE001
                    logger.debug("background movers refresh failed for %s", market, exc_info=True)
            await asyncio.sleep(interval_s)

    def _fresh(self, at_ns: int) -> bool:
        return self._clock() - at_ns < self._ttl_ns


# --- default (production) network seams ----------------------------------------
# Imported lazily; NEVER exercised by pytest (tests inject their own seams).


async def default_quote_fn(market: str, symbol: str) -> QuoteData:
    """Production single-symbol quote seam (crypto klines / equity Yahoo)."""
    from flowmap_server.feeds.crypto import is_crypto_market
    from flowmap_server.feeds.equity import EQUITY_MARKETS

    if market == "crypto" or is_crypto_market(market):
        return await _crypto_quote(market if market != "crypto" else "binance-spot", symbol)
    if market in EQUITY_MARKETS or market == "equity":
        return await _equity_quote(symbol)
    return QuoteData(market=market, symbol=symbol, reachable=False, stale=True, as_of_ns=time.time_ns())


async def _bounded_quote_sweep(
    fetch: Callable[[str], Awaitable[QuoteData]],
    symbols: Sequence[str],
    deadline_s: float,
) -> list[QuoteData | None]:
    """Quote every symbol in *symbols*, bounded by a wall-clock deadline.

    Unlike a bare ``asyncio.gather`` (unbounded: one hung fetch held the whole
    sweep for its full duration), past ``deadline_s`` pending fetches are
    cancelled and ``None`` is reported for them — the movers endpoint serves
    partial, honestly-ranked results instead of hanging. ``_safe_quote``
    already swallows per-fetch errors, so finished tasks carry results.
    """
    if not symbols:
        return []
    tasks = [asyncio.ensure_future(_safe_quote(fetch, s)) for s in symbols]
    try:
        await asyncio.wait(tasks, timeout=deadline_s)
    except BaseException:
        for t in tasks:
            t.cancel()
        raise
    for t in tasks:
        if not t.done():
            t.cancel()
    return [t.result() if t.done() and not t.cancelled() else None for t in tasks]


async def default_movers_fn(market: str, limit: int) -> list[QuoteData]:
    """Production movers seam: rank a bounded candidate set by 24 h %change.

    Crypto: the curated shortlist. Equity: a bounded head of the curated ticker
    list (a full-list Yahoo sweep per refresh would be far too many calls).
    """
    from flowmap_server.data.universe import CRYPTO_SYMBOLS, EQUITY_TICKERS

    if market in ("equity",):
        candidates = EQUITY_TICKERS[:40]
        fetch = _equity_quote
        mkt = "equity"
    else:
        candidates = CRYPTO_SYMBOLS
        fetch = lambda s: _crypto_quote("binance-spot", s)  # noqa: E731
        mkt = "binance-spot"
    results = await _bounded_quote_sweep(fetch, candidates, MOVERS_DEADLINE_S)
    quotes = [q for q in results if q is not None and q.change_pct is not None]
    quotes.sort(key=lambda q: abs(q.change_pct or 0.0), reverse=True)
    for q in quotes:
        q.market = mkt
    return quotes[:limit]


async def _safe_quote(fetch: Callable[[str], Awaitable[QuoteData]], symbol: str) -> QuoteData | None:
    try:
        return await fetch(symbol)
    except Exception:  # noqa: BLE001
        return None


async def _crypto_quote(market: str, symbol: str) -> QuoteData:
    # Shared with the grid backfill so every venue quotes through the same
    # path: native REST klines where the engine has them, ccxt fetchOHLCV
    # otherwise. Previously this was Binance-only in practice.
    from flowmap_server.core.backfill import crypto_klines

    now = time.time_ns()
    candles = await crypto_klines(market, symbol, interval="1h", max_bars=25, now_ns=now)
    closes = [float(c.c) for c in candles]
    last_ts = int(candles[-1].t0_ns) if candles else now
    if not closes:
        return QuoteData(market=market, symbol=symbol, reachable=True, stale=True, as_of_ns=now)
    price = closes[-1]
    first = closes[0]
    change = ((price - first) / first * 100.0) if first else None
    return QuoteData(
        market=market,
        symbol=symbol,
        price=price,
        change_pct=change,
        spark=closes[-SPARK_MAX:],
        as_of_ns=last_ts,
        stale=False,
        reachable=True,
    )


async def _equity_quote(symbol: str) -> QuoteData:
    import datetime

    from crocodile.core.scheduler.calendar import USMarketCalendar
    from crocodile.equity.providers.yahoo.client import YahooClient

    bars = await YahooClient().fetch_intraday_bars(symbol.upper(), "1m")
    closes = [float(b.close) for b in bars if b.close is not None]
    now = time.time_ns()
    if not closes:
        return QuoteData(market="equity", symbol=symbol.upper(), reachable=True, stale=True, as_of_ns=now)
    last_bar = bars[-1]
    last_ts = int(last_bar.source_ts if last_bar.source_ts is not None else last_bar.local_ts)
    open_px = closes[0]
    price = closes[-1]
    change = ((price - open_px) / open_px * 100.0) if open_px else None
    closed = not USMarketCalendar().is_market_open(
        datetime.datetime.fromtimestamp(now / 1e9, tz=datetime.timezone.utc)
    )
    return QuoteData(
        market="equity",
        symbol=symbol.upper(),
        price=price,
        change_pct=change,
        spark=closes[-SPARK_MAX:],
        as_of_ns=last_ts,
        stale=closed,  # market closed -> last print is not a live NBBO
        reachable=True,
    )
