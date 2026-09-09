"""Feed abstraction shared by all data sources (M1 T6 sim, T9 crypto, ...).

A feed is an async stream of canonical events:

- :class:`BookState` — full L2 snapshot (price/size arrays per side). This is
  a feed-layer type only; the grid consumes it via ``Grid.on_book`` and the
  wire never carries it.
- :class:`~flowmap_server.proto.events.Trade` and
  :class:`~flowmap_server.proto.events.Marker` are reused from proto.events
  (NOT duplicated) so downstream code speaks one dialect.

The :class:`Feed` protocol is deliberately minimal: an ``events()`` async
iterator plus ``market`` / ``symbol`` / ``capability`` attributes. ``events()``
is declared as a plain ``def`` returning ``AsyncIterator`` — that is the shape
an ``async def`` generator method presents to callers.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Protocol, runtime_checkable

import msgspec
import numpy as np

from flowmap_server.proto.events import BBO, Marker, Trade

__all__ = [
    "BookState",
    "BoundedFeedQueue",
    "FEED_QUEUE_MAXSIZE",
    "Feed",
    "FeedEvent",
    "TS_FLOOR_NS",
    "TS_HORIZON_NS",
    "ts_ns_sane",
]


class BookState(msgspec.Struct):
    """Full order-book snapshot observed at ``ts_ns``.

    ``bid_px``/``bid_sz`` and ``ask_px``/``ask_sz`` are parallel float64
    arrays; levels need not be contiguous or sorted (the grid scatters by
    price). Producers must emit finite values only.
    """

    ts_ns: int
    bid_px: np.ndarray
    bid_sz: np.ndarray
    ask_px: np.ndarray
    ask_sz: np.ndarray


FeedEvent = BookState | Trade | Marker | BBO


# -- live-ingest timestamp sanity (venue clocks are hostile) --------------------

# Conservative LOWER bound on a plausible market-data stamp: 2010-01-01 UTC.
# Real venue data is never older; anything below is a broken clock or a unit
# mixup (seconds/ms stamped into the ns field lands here), not history.
TS_FLOOR_NS = 1_262_304_000_000_000_000
# Conservative UPPER slack over our own clock: a venue clock skewed up to a
# day ahead is tolerated; beyond that the stamp is nonsense, not "future data".
TS_HORIZON_NS = 24 * 60 * 60 * 10**9


def ts_ns_sane(ts_ns: int, *, now_ns: int) -> bool:
    """True when *ts_ns* is plausible as a LIVE market-data timestamp.

    Rejects non-positive stamps, 1970-era stamps (the ms/ns mixup signature)
    via :data:`TS_FLOOR_NS`, and anything further than :data:`TS_HORIZON_NS`
    ahead of *now_ns*. Applied ONLY at the live ingestion boundaries
    (crypto/equity bridges) — recorded or replayed history is never re-gated.
    """
    return TS_FLOOR_NS <= ts_ns <= now_ns + TS_HORIZON_NS


# -- bounded feed fan-in ---------------------------------------------------------

# Cap on the connector->consumer queue inside a feed's ``events()``. Generous:
# it only fills when the consumer stalls, and then drop-oldest keeps the feed's
# RSS bounded instead of growing without limit on a stuck session.
FEED_QUEUE_MAXSIZE = 8192


class BoundedFeedQueue:
    """A bounded ``asyncio.Queue`` with drop-OLDEST semantics for feed fan-in.

    The connector task produces via :meth:`put_nowait` (never blocks, never
    raises on overflow): when the queue is full the OLDEST unconsumed event is
    discarded and :attr:`dropped` counts it. A stalled consumer therefore
    degrades to a short tape rather than unbounded memory. The connector's
    terminal sentinel (enqueued as the producer's final act) can never be the
    item dropped — no put follows it — so end-of-stream delivery is intact.
    """

    def __init__(self, maxsize: int = FEED_QUEUE_MAXSIZE) -> None:
        self._q: asyncio.Queue[object] = asyncio.Queue(maxsize=max(1, maxsize))
        self.dropped = 0

    def put_nowait(self, item: object) -> None:
        q = self._q
        if q.full():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:  # pragma: no cover — full() just said otherwise
                return
            self.dropped += 1
        q.put_nowait(item)

    async def get(self) -> object:
        return await self._q.get()

    def qsize(self) -> int:
        return self._q.qsize()


@runtime_checkable
class Feed(Protocol):
    """Minimal contract every feed (sim, crypto, equity) implements.

    Restart contract: ``events()`` MUST be re-callable after a crash — the
    session layer restarts a crashed (or normally-ended) feed by calling
    ``events()`` again on the same instance. On re-call the feed SHOULD
    resume from current/live data, not replay history. SimFeed replays
    deterministically from ``start_ns``, which is acceptable for the sim;
    real feeds (T9 crypto) must reconnect and resume live.

    Optional declaration (not part of the structural check): a feed MAY carry
    ``preferred_tick: float`` — the venue's price tick for its own symbols.
    The crypto grid honors it when present and finite (see
    ``core.session._crypto_tick_for``); absent means "no opinion".
    """

    market: str
    symbol: str
    capability: dict[str, object]

    def events(self) -> AsyncIterator[FeedEvent]: ...
