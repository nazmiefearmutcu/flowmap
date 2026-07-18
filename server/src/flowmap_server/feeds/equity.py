"""US-equity feed: stockodile providers -> canonical FeedEvents (M3 T1).

Equities have **no free L2 depth**. This feed therefore auto-selects a tier
from the credentials in :class:`~flowmap_server.config.Config` and expresses
each tier's real capability honestly (spec §7):

============  ================================================================
Tier          What ``events()`` emits
============  ================================================================
keyless       SYNTH_PROFILE depth (volume-at-price from Yahoo 1 m bars,
              bid-only density), a display-only last-price tape
              (``side_src=na``, ``venue='synthetic'``) polled every
              ``dt_equity_keyless_ns``, gaps + session_break markers. **No
              tick tape, no CVD** — the machine has no equity keys, so this is
              the only genuinely-available tier and it must be honest.
alpaca (keyed) L1_BAND depth + tick tape with side **inferred** (quote rule
              vs the streamed L1 BBO), quotes as ``BBO``.
finnhub (keyed) tick tape with side **inferred** (tick rule); no depth / no
              quotes.
============  ================================================================

**SYNTH volume-at-price** (keyless): each 1 m bar's whole volume is placed at
its typical price ``(H+L+C)/3`` snapped to a cent bucket, accumulated into a
*cumulative* profile. One :class:`BookState` is emitted per bar (bid_px = the
occupied price buckets, bid_sz = cumulative volume there, ask arrays EMPTY) so
the grid — which time-weights the previous book over each interval — renders a
horizontal volume-profile-over-time. The grid carries ``mode=SYNTH_PROFILE``
and drops the (empty) ask channel on the wire; total ``bid_sz`` equals the
summed bar volume (volume-conserving). Warmup uses **the most recent session's
bars only**, so bar timestamps stay ~1 m apart and the grid never bridges an
overnight gap into thousands of empty columns (spec §7.1 "no empty-column
accumulation").

**Market-closed** — the :class:`~flowmap_server.feeds.base.Feed` protocol's
``FeedEvent`` union has no ``Status`` (that is a session/protocol message), so
this feed exposes the closed state two ways the session layer (T2) reads:

- ``feed.feed_state`` (``"live"`` | ``"closed"``) and ``feed.next_open_ts``
  (UTC ns of the next RTH open) — attributes T2 maps onto
  ``Status{feed_state='closed', next_open_ts=...}``; and
- an in-band ``Marker{kind='session_break', text='market closed — ...'}``.

When closed, the warmup SYNTH profile from the last session still renders; the
feed emits **no** live trades (a stale last price is not a print) and does NOT
spam empty live columns — ``events()`` returns after the session_break so T2
can schedule a restart at ``next_open_ts`` (``events()`` is re-callable per the
Feed restart contract and re-fetches on the next call).

The session model authority is
:class:`stockodile.scheduler.calendar.USMarketCalendar` (America/New_York,
holiday-aware); live polling is gated on its RTH window. All time is UTC ns;
``now_ns_fn`` is injected so tests can pin "closed" (a Saturday) vs "open" (a
weekday RTH minute) with no wall-clock dependency, and ``bars_fn`` / ``price_fn``
/ ``sleep_fn`` are injectable seams so pytest never touches the network.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime
import logging
import math
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence

import numpy as np

from stockodile.scheduler.calendar import MARKET_TZ, USMarketCalendar
from stockodile.schema.records import Bar as StkBar
from stockodile.schema.records import Quote as StkQuote
from stockodile.schema.records import Trade as StkTrade

from flowmap_server.config import Config
from flowmap_server.feeds.base import BookState, FeedEvent
from flowmap_server.proto.events import (
    BBO,
    SIDE_BUY,
    SIDE_SELL,
    SIDE_SRC_INFERRED,
    SIDE_SRC_NA,
    SIDE_UNKNOWN,
    Marker,
    Trade,
)

__all__ = ["EQUITY_MARKET", "EQUITY_MARKETS", "EquityFeed"]

logger = logging.getLogger(__name__)

# Subscribe.market string routed to EquityFeed by the session feed factory (T2).
EQUITY_MARKET = "equity"
EQUITY_MARKETS = frozenset({EQUITY_MARKET})

# SYNTH profile price granularity: US equities quote in cents. Bar volume is
# bucketed to this tick before the grid re-buckets to its own rows.
DEFAULT_PROFILE_TICK = 0.01
# Keyless last-price display venue tag (spec §7: not an exchange print/NBBO).
SYNTH_VENUE = "synthetic"
# Live keyless bar refresh cadence (spec §7: Yahoo >=60 s/symbol).
BAR_REFRESH_NS = 60 * 10**9

# Provider hard caps (single-symbol here, kept for parity with the reference).
_ALPACA_CAP = 30
_FINNHUB_CAP = 50


BarsFn = Callable[[], Awaitable[Sequence[StkBar]]]
PriceFn = Callable[[], Awaitable[float | None]]
SleepFn = Callable[[float], Awaitable[None]]
NowFn = Callable[[], int]


def _bar_ts(bar: StkBar) -> int:
    """A bar's canonical UTC-ns timestamp (source over local)."""
    return int(bar.source_ts if bar.source_ts is not None else bar.local_ts)


def _bar_finite(bar: StkBar) -> bool:
    """True iff the bar's OHLCV are all finite and volume is non-negative.

    Yahoo bars can carry gaps (already dropped in the client), but NaN/inf can
    still slip through resampling — a poisoned typical price would scatter a
    non-finite density texel, so bad bars are skipped, never emitted."""
    vals = (bar.open, bar.high, bar.low, bar.close, bar.volume)
    return all(v is not None and math.isfinite(v) for v in vals) and bar.volume >= 0.0


def _typical_price(bar: StkBar) -> float:
    """Bar typical price ``(H+L+C)/3`` — the volume-at-price anchor and the
    same convention spec §7 uses for the approx VWAP."""
    return (bar.high + bar.low + bar.close) / 3.0


class _ProfileBuilder:
    """Accumulates 1 m bars into a cumulative volume-at-price density.

    Volume is conserved: each bar contributes its whole volume to exactly one
    cent bucket (its typical price), so the emitted ``bid_sz`` always sums to
    the summed volume of the added bars. Bucketing by integer index avoids
    float-key drift."""

    def __init__(self, tick: float = DEFAULT_PROFILE_TICK) -> None:
        if not (tick > 0.0):
            raise ValueError("profile tick must be positive")
        self._tick = tick
        self._buckets: dict[int, float] = {}

    def add_bar(self, bar: StkBar) -> bool:
        """Add one bar's volume at its typical price. Returns False (skipped)
        for non-finite/negative-volume bars or a non-positive typical price."""
        if not _bar_finite(bar):
            return False
        tp = _typical_price(bar)
        if not (tp > 0.0):
            return False
        idx = int(round(tp / self._tick))
        self._buckets[idx] = self._buckets.get(idx, 0.0) + float(bar.volume)
        return True

    def total_volume(self) -> float:
        return float(sum(self._buckets.values()))

    def book_state(self, ts_ns: int) -> BookState:
        """The cumulative profile as a bid-only :class:`BookState`.

        bid_px/bid_sz are the occupied buckets (ascending price); the ask
        arrays are EMPTY — the grid runs in SYNTH_PROFILE mode and only the bid
        channel is a real density."""
        if self._buckets:
            idxs = np.fromiter(sorted(self._buckets), dtype=np.int64)
            bid_px = idxs.astype(np.float64) * self._tick
            bid_sz = np.array([self._buckets[int(i)] for i in idxs], dtype=np.float64)
        else:
            bid_px = np.empty(0, dtype=np.float64)
            bid_sz = np.empty(0, dtype=np.float64)
        empty = np.empty(0, dtype=np.float64)
        return BookState(
            ts_ns=int(ts_ns), bid_px=bid_px, bid_sz=bid_sz, ask_px=empty, ask_sz=empty
        )


class _FeedEnd:
    """Queue sentinel for the keyed path: the provider task finished."""

    __slots__ = ("exc",)

    def __init__(self, exc: BaseException | None) -> None:
        self.exc = exc


class _EquitySink:
    """Translate stockodile records -> canonical events (keyed tiers).

    US tapes carry no aggressor side, so it is inferred and stamped
    ``side_src=inferred`` (spec §7):

    - **quote rule** (alpaca, ``use_quote_rule=True``): trade above the last
      streamed BBO midpoint is a buy, below a sell, at the mid falls back to
      the tick rule;
    - **tick rule** (finnhub): up-tick buy, down-tick sell, flat carries the
      previous side; the first print defaults to buy (any fixed default is
      equally arbitrary — documented in the reference feed).

    Implements just enough of :class:`stockodile.sink.base.Sink` (``put`` /
    ``flush``) to run inside ``collect``'s TaskGroup; not a real Parquet sink.
    """

    def __init__(
        self, emit: Callable[[FeedEvent], None], *, use_quote_rule: bool
    ) -> None:
        self._emit = emit
        self._use_quote_rule = use_quote_rule
        self._last_px: float | None = None
        self._last_side = SIDE_BUY
        self._bbo: tuple[float, float] | None = None  # (bid_px, ask_px)

    async def put(self, record: object) -> None:
        if isinstance(record, StkTrade):
            self._emit(
                Trade(
                    ts_ns=_rec_ts(record),
                    price=float(record.price),
                    size=float(record.size),
                    side=self._infer_side(float(record.price)),
                    side_src=SIDE_SRC_INFERRED,
                    venue=record.provider,
                )
            )
        elif isinstance(record, StkQuote) and self._use_quote_rule:
            self._bbo = (float(record.bid_px), float(record.ask_px))
            self._emit(
                BBO(
                    ts_ns=_rec_ts(record),
                    bid_px=float(record.bid_px),
                    bid_sz=float(record.bid_sz),
                    ask_px=float(record.ask_px),
                    ask_sz=float(record.ask_sz),
                )
            )
        # Bars/fundamentals/status/etc.: not part of the canonical tape dialect.

    async def flush(self) -> None:
        return None

    async def close(self) -> None:
        return None

    def _infer_side(self, price: float) -> int:
        if self._use_quote_rule and self._bbo is not None:
            bid, ask = self._bbo
            if math.isfinite(bid) and math.isfinite(ask):
                mid = 0.5 * (bid + ask)
                if price > mid:
                    side = SIDE_BUY
                elif price < mid:
                    side = SIDE_SELL
                else:
                    side = self._flat_side(price)
            else:
                side = self._flat_side(price)
        else:
            side = self._flat_side(price)
        self._last_px = price
        self._last_side = side
        return side

    def _flat_side(self, price: float) -> int:
        prev = self._last_px
        if prev is None or price > prev:
            return SIDE_BUY
        if price < prev:
            return SIDE_SELL
        return self._last_side


def _rec_ts(record: StkTrade | StkQuote) -> int:
    return int(record.source_ts if record.source_ts is not None else record.local_ts)


class _GooglePricePoller:
    """Default keyless last-price source: a one-shot google_finance scrape.

    Owns a lazily-created aiohttp session + provider so each poll is a single
    fragile CSS scrape (spec §7); failures are the caller's to swallow. Never
    imported at module load (heavy deps) and never touched by pytest (tests
    inject ``price_fn``)."""

    def __init__(self, symbol: str) -> None:
        self._symbol = symbol
        self._provider: object | None = None
        self._session: object | None = None

    async def poll(self) -> float | None:
        import aiohttp

        from stockodile.providers.google_finance.connector import GoogleFinanceProvider
        from stockodile.reference.registry import InstrumentRegistry
        from stockodile.sink.base import MemorySink

        if self._provider is None:
            self._provider = GoogleFinanceProvider(
                [self._symbol], ["trade"], MemorySink(), InstrumentRegistry()
            )
        session = self._session
        if session is None or getattr(session, "closed", True):
            session = aiohttp.ClientSession()
            self._session = session
        self._provider.session = session  # type: ignore[attr-defined]
        recs = await self._provider._scrape_symbol(self._symbol)  # type: ignore[attr-defined]
        for rec in recs:
            if isinstance(rec, StkTrade) and math.isfinite(rec.price):
                return float(rec.price)
        return None

    async def close(self) -> None:
        session = self._session
        self._session = None
        if session is not None and not getattr(session, "closed", True):
            with contextlib.suppress(Exception):
                await session.close()  # type: ignore[attr-defined]


class EquityFeed:
    """Live US-equity feed (implements the Feed protocol; spec §7 / §7.1).

    ``events()`` is re-callable (Feed restart contract): each call builds fresh
    state, re-fetches bars, and re-evaluates the session window. The tier is
    fixed at construction from ``cfg`` credentials.
    """

    market = EQUITY_MARKET

    def __init__(
        self,
        symbol: str,
        cfg: Config,
        *,
        now_ns_fn: NowFn | None = None,
        bars_fn: BarsFn | None = None,
        price_fn: PriceFn | None = None,
        sleep_fn: SleepFn | None = None,
        provider_factory: Callable[[_EquitySink], object] | None = None,
        calendar: USMarketCalendar | None = None,
        profile_tick: float = DEFAULT_PROFILE_TICK,
        bar_refresh_ns: int = BAR_REFRESH_NS,
    ) -> None:
        self.symbol = symbol.upper()
        self._cfg = cfg
        self._now_ns: NowFn = now_ns_fn or (lambda: int(__import__("time").time_ns()))
        self._bars_fn = bars_fn
        self._price_fn = price_fn
        self._sleep: SleepFn = sleep_fn or asyncio.sleep
        self._provider_factory = provider_factory
        self._calendar = calendar or USMarketCalendar()
        self._profile_tick = profile_tick
        self._bar_refresh_ns = bar_refresh_ns

        self._tier = self._select_tier()
        self.capability: dict[str, object] = _CAPABILITY[self._tier]

        # Session state the session layer (T2) reads to emit Status. Reset at
        # the start of every events() call so a re-called feed starts honest.
        self.feed_state: str = "live"
        self.next_open_ts: int | None = None

        # Lazily-created default keyless price poller (network; never in tests).
        self._poller: _GooglePricePoller | None = None

    def _select_tier(self) -> str:
        cfg = self._cfg
        if cfg.alpaca_key and cfg.alpaca_secret:
            return "alpaca"
        if cfg.finnhub_key:
            return "finnhub"
        return "keyless"

    @property
    def tier(self) -> str:
        """Selected tier: ``"alpaca"`` | ``"finnhub"`` | ``"keyless"``."""
        return self._tier

    # -- SYNTH profile (unit-testable in isolation) ----------------------------

    @staticmethod
    def synth_profile(
        bars: Sequence[StkBar], *, tick: float = DEFAULT_PROFILE_TICK
    ) -> BookState:
        """Aggregate ``bars`` into one cumulative volume-at-price BookState.

        Bid-only density (ask arrays empty); ``bid_sz`` sums to the summed
        volume of the finite bars; the peak bucket is where the most volume
        concentrated. ``ts_ns`` is the newest bar's timestamp (0 if none)."""
        builder = _ProfileBuilder(tick)
        last_ts = 0
        for bar in bars:
            if builder.add_bar(bar):
                last_ts = max(last_ts, _bar_ts(bar))
        return builder.book_state(last_ts)

    def _select_warmup_bars(self, bars: Sequence[StkBar]) -> list[StkBar]:
        """The most recent session's finite bars (grouped by ET date), sorted
        by time. Restricting to one session keeps warmup timestamps ~1 m apart
        so the grid never bridges an overnight/weekend gap into empty columns
        (spec §7.1)."""
        finite = sorted((b for b in bars if _bar_finite(b)), key=_bar_ts)
        if not finite:
            return []
        last_date = self._et_date(_bar_ts(finite[-1]))
        return [b for b in finite if self._et_date(_bar_ts(b)) == last_date]

    @staticmethod
    def _et_date(ts_ns: int) -> datetime.date:
        return (
            datetime.datetime.fromtimestamp(ts_ns / 1e9, tz=datetime.timezone.utc)
            .astimezone(MARKET_TZ)
            .date()
        )

    # -- session model ---------------------------------------------------------

    def _session_state(self, now_ns: int) -> tuple[str, int | None]:
        """(``"open"``|``"closed"``, next_open_ts). Open == RTH per the
        calendar; next_open is the next RTH open strictly after now."""
        dt = datetime.datetime.fromtimestamp(now_ns / 1e9, tz=datetime.timezone.utc)
        if self._calendar.is_market_open(dt):
            return "open", None
        return "closed", self._next_open_ns(dt)

    def _next_open_ns(self, now_dt: datetime.datetime) -> int | None:
        et = now_dt.astimezone(MARKET_TZ)
        for add in range(0, 10):
            day = (et + datetime.timedelta(days=add)).date()
            hours = self._calendar.get_market_hours(day)
            if hours is None:
                continue
            open_dt, _close_dt = hours
            if et < open_dt:
                return int(open_dt.timestamp() * 1e9)
        return None  # pragma: no cover — always a trading day within 10 days

    # -- feed protocol ---------------------------------------------------------

    async def events(self) -> AsyncIterator[FeedEvent]:
        """Fresh canonical event stream (re-callable; resumes live)."""
        self.feed_state = "live"
        self.next_open_ts = None
        if self._tier == "keyless":
            async for ev in self._keyless_events():
                yield ev
        else:
            async for ev in self._keyed_events():
                yield ev

    # -- keyless (fully implemented) -------------------------------------------

    async def _keyless_events(self) -> AsyncIterator[FeedEvent]:
        bars = await self._fetch_bars()
        warmup = self._select_warmup_bars(bars)
        builder = _ProfileBuilder(self._profile_tick)
        last_bar_ts = 0
        for bar in warmup:
            builder.add_bar(bar)
            ts = _bar_ts(bar)
            last_bar_ts = max(last_bar_ts, ts)
            # Cumulative bid-only density at the bar time: the heatmap grows a
            # horizontal volume-profile-over-time as levels are revisited.
            yield builder.book_state(ts)

        now = self._now_ns()
        state, next_open = self._session_state(now)
        if state == "closed":
            self.feed_state = "closed"
            self.next_open_ts = next_open
            # session_break at the end of the visible profile (last bar), or
            # now when there were no warmup bars. Closed markets render the
            # last session's SYNTH profile and emit NO stale live trades.
            yield Marker(
                ts_ns=last_bar_ts or now,
                kind="session_break",
                text="market closed — SYNTH profile from last session",
            )
            return

        try:
            async for ev in self._keyless_live(builder, last_bar_ts):
                yield ev
        finally:
            await self._close_poller()

    async def _keyless_live(
        self, builder: _ProfileBuilder, last_bar_ts: int
    ) -> AsyncIterator[FeedEvent]:
        """Live keyless loop: per ``dt_equity_keyless_ns`` poll the last price
        (display-only Trade) and re-assert the resting SYNTH profile (advances
        the grid one column); refresh bars every ``bar_refresh_ns``. Stops with
        a session_break when the RTH window closes."""
        poll_s = self._cfg.dt_equity_keyless_ns / 1e9
        next_refresh = self._now_ns() + self._bar_refresh_ns
        while True:
            now = self._now_ns()
            state, next_open = self._session_state(now)
            if state == "closed":
                self.feed_state = "closed"
                self.next_open_ts = next_open
                yield Marker(
                    ts_ns=now,
                    kind="session_break",
                    text="market closed — SYNTH profile from last session",
                )
                return

            if now >= next_refresh:
                try:
                    for bar in self._select_warmup_bars(await self._fetch_bars()):
                        ts = _bar_ts(bar)
                        if ts > last_bar_ts and builder.add_bar(bar):
                            last_bar_ts = ts
                except Exception:  # noqa: BLE001 — stale profile survives a bad refresh
                    logger.debug(
                        "keyless bar refresh failed for %s", self.symbol, exc_info=True
                    )
                next_refresh = now + self._bar_refresh_ns

            price = await self._poll_price_safe()
            if price is not None and math.isfinite(price) and price > 0.0:
                # Display-only tape: google last-price is not a print/NBBO.
                yield Trade(
                    ts_ns=now,
                    price=float(price),
                    size=1.0,
                    side=SIDE_UNKNOWN,
                    side_src=SIDE_SRC_NA,
                    venue=SYNTH_VENUE,
                )
            # Re-assert the resting profile so the grid advances a column and
            # the current column rolls with the (bar-refreshed) profile.
            yield builder.book_state(now)
            await self._sleep(poll_s)

    async def _fetch_bars(self) -> Sequence[StkBar]:
        if self._bars_fn is not None:
            return await self._bars_fn()
        return await self._default_fetch_bars()

    async def _default_fetch_bars(self) -> Sequence[StkBar]:
        from stockodile.providers.yahoo.client import YahooClient

        client = YahooClient()
        return await client.fetch_intraday_bars(self.symbol, "1m")

    async def _poll_price_safe(self) -> float | None:
        try:
            if self._price_fn is not None:
                return await self._price_fn()
            if self._poller is None:
                self._poller = _GooglePricePoller(self.symbol)
            return await self._poller.poll()
        except Exception:  # noqa: BLE001 — a stale tape is honest; never kill the loop
            logger.debug("keyless price poll failed for %s", self.symbol, exc_info=True)
            return None

    async def _close_poller(self) -> None:
        if self._poller is not None:
            await self._poller.close()
            self._poller = None

    # -- keyed (structured; lightly tested — no live keys on this machine) ------

    async def _keyed_events(self) -> AsyncIterator[FeedEvent]:
        queue: asyncio.Queue[FeedEvent | _FeedEnd] = asyncio.Queue()
        sink = _EquitySink(queue.put_nowait, use_quote_rule=(self._tier == "alpaca"))
        provider = self._make_provider(sink)
        runner = asyncio.create_task(
            self._drive_keyed(provider, sink, queue),
            name=f"equity-feed-{self._tier}:{self.symbol}",
        )
        try:
            while True:
                ev = await queue.get()
                if isinstance(ev, _FeedEnd):
                    if ev.exc is not None:
                        raise ev.exc
                    return
                yield ev
        finally:
            runner.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await runner

    def _make_provider(self, sink: _EquitySink) -> object:
        if self._provider_factory is not None:
            return self._provider_factory(sink)
        from stockodile.providers.factory import make_provider
        from stockodile.reference.registry import InstrumentRegistry

        if self._tier == "alpaca":
            return make_provider(
                "alpaca",
                [self.symbol],
                ["trade", "quote"],
                out=sink,  # type: ignore[arg-type]
                registry=InstrumentRegistry(),
                key=self._cfg.alpaca_key,
                secret=self._cfg.alpaca_secret,
            )
        return make_provider(
            "finnhub",
            [self.symbol],
            ["trade"],
            out=sink,  # type: ignore[arg-type]
            registry=InstrumentRegistry(),
            token=self._cfg.finnhub_key,
        )

    @staticmethod
    async def _drive_keyed(
        provider: object, sink: _EquitySink, queue: asyncio.Queue[FeedEvent | _FeedEnd]
    ) -> None:
        from stockodile.client.collect import collect

        try:
            await collect([provider], sink, max_reconnects=-1)  # type: ignore[list-item]
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — forwarded to the consumer
            queue.put_nowait(_FeedEnd(exc))
        else:
            queue.put_nowait(_FeedEnd(None))


# Per-tier capability descriptors (spec §7 dual-market parity table).
_CAPABILITY: dict[str, dict[str, object]] = {
    "keyless": {
        "depth": "SYNTH_PROFILE",
        "tape": "poll",
        "trade_side": "na",
        "vwap": "approx",
        "markers": ["gap", "session_break"],
    },
    "alpaca": {
        "depth": "L1_BAND",
        "tape": "tick",
        "trade_side": "inferred",
        "vwap": "from_tape",
        "markers": ["halt", "gap", "session_break"],
    },
    "finnhub": {
        "depth": "N/A",
        "tape": "tick",
        "trade_side": "inferred",
        "vwap": "from_tape",
        "markers": ["gap", "session_break"],
    },
}
