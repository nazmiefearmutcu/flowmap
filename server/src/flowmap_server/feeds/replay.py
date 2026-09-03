"""Recording-backed replay feed (spec docs/superpowers/specs/2026-09-03-replay-engine-design.md).

Serves a symbol's RECORDED session as a paced ``Feed``: every recorded
column becomes one synthesized :class:`BookState` snapshot at the column's
``t0_ns`` (each nonzero density row mapped back to its row price via the
epoch's scale), with the recorded trades and markers of the same interval.
The grid then integrates those snapshots exactly like live books, so the
whole downstream path — ring, mips, snapshots, Hello/EpochStart, recording
disabled — is the stock live machinery.

Pacing is wall-clock based and controllable mid-stream via :meth:`control`
(``Seek`` / ``SetSpeed`` / ``Pause`` / ``Resume`` from the WS transport). At
end-of-recording the feed PARKS instead of ending: a normally-ending feed
would tear the session down, and a replayed past has no "live" to resume —
a ``Seek`` backwards rewinds the cursor and iteration continues.

Fidelity note (deliberate): replay resynthesizes BOOK snapshots from
finalized density columns, so the grid re-integrates them at its own
cadence. Column-level shape and prices match the recording; within-interval
microstructure does not. Replay is for study, not tick forensics.
"""

from __future__ import annotations

import asyncio
import bisect
import time
from collections.abc import AsyncIterator

import numpy as np

from flowmap_server.core.price_scale import scale_of
from flowmap_server.core.price_scale_np import rows_for_prices
from flowmap_server.core.record import TailData
from flowmap_server.feeds.base import BookState, FeedEvent
from flowmap_server.proto import events

__all__ = ["ReplayFeed"]

_PARK_POLL_S = 0.2  # end-of-recording / paused tick
_TICK_S = 0.02  # clock wait granularity while pacing


class _Clock:
    """Recorded-time position driven by wall time and a speed multiplier."""

    def __init__(self, t0: int) -> None:
        self.t = int(t0)
        self.speed = 1.0
        self.paused = False
        self._wall0 = time.monotonic()

    def now(self) -> int:
        if self.paused:
            return self.t
        return int(self.t + (time.monotonic() - self._wall0) * self.speed * 1e9)

    def pause(self) -> None:
        self.t = self.now()
        self.paused = True

    def resume(self) -> None:
        self.paused = False
        self._wall0 = time.monotonic()

    def set_speed(self, x: float) -> None:
        self.t = self.now()
        self.speed = max(0.0, float(x))
        self._wall0 = time.monotonic()

    def seek(self, t: int) -> None:
        self.t = int(t)
        self._wall0 = time.monotonic()


class ReplayFeed:
    """One recorded session, replayed. Construct via
    ``SessionManager._replay_feed`` (the recorder supplies the ``TailData``)."""

    market: str
    symbol: str
    capability: dict[str, object]

    def __init__(self, *, market: str, symbol: str, tail: TailData, speed: float = 1.0) -> None:
        self.market = market
        self.symbol = symbol
        # Honesty: the descriptor states exactly what a replay subscribe
        # delivers — real recorded depth/tape, synthesized side.
        self.capability = {"depth": "L2", "tape": "tick", "trade_side": "exchange", "replay": True}

        self._cols = sorted(tail.columns, key=lambda c: c.col_seq)
        self._t0s = [c.t0_ns for c in self._cols]
        self._scales = {e.epoch: scale_of(e) for e in tail.epochs}
        self._dts = {e.epoch: e.dt_ns for e in tail.epochs}

        # Bucket trades/markers under the column whose interval contains them
        # (greatest t0 <= ts), matching how they were recorded.
        self._by_t0: dict[int, list[FeedEvent]] = {}
        for t in sorted(tail.trades, key=lambda t: t.ts_ns):
            self._bucket(t.ts_ns, t)
        for m in sorted(tail.markers, key=lambda m: m.ts_ns):
            self._bucket(m.ts_ns, m)

        self._clock = _Clock(self._t0s[0])
        self._clock.set_speed(speed)
        self._cursor = 0

    def _bucket(self, ts: int, ev: FeedEvent) -> None:
        i = bisect.bisect_right(self._t0s, ts) - 1
        if i < 0:
            return  # before the first column: nothing to attach it to
        self._by_t0.setdefault(self._t0s[i], []).append(ev)

    # -- transport controls ------------------------------------------------------

    def control(self, ev: events.Seek | events.SetSpeed | events.Pause | events.Resume) -> None:
        """Apply one replay transport control (called by the session layer)."""
        if isinstance(ev, events.Seek):
            self._clock.seek(ev.t)
            # Move the cursor to the column whose interval contains t.
            self._cursor = max(0, bisect.bisect_right(self._t0s, ev.t) - 1)
        elif isinstance(ev, events.SetSpeed):
            self._clock.set_speed(ev.x)
        elif isinstance(ev, events.Pause):
            self._clock.pause()
        elif isinstance(ev, events.Resume):
            self._clock.resume()

    # -- stream --------------------------------------------------------------------

    async def events(self) -> AsyncIterator[FeedEvent]:
        """Yield the recorded session, paced. Restart contract: resumes from
        the current cursor; at end-of-recording the feed parks (a Seek
        rewinds) instead of ending — a normal end would tear the session down."""
        i = self._cursor
        while True:
            if i >= len(self._cols):
                await asyncio.sleep(_PARK_POLL_S)
                i = self._cursor  # a Seek may have rewound us
                continue
            col = self._cols[i]
            if self._clock.now() < col.t0_ns:
                # Not due yet (or paused before it): poll — a Pause/Seek may
                # change the target between ticks.
                await asyncio.sleep(_TICK_S)
                continue

            scale = self._scales.get(col.epoch)
            if scale is not None:
                yield self._snapshot(col, scale)

            dt = self._dts.get(col.epoch, 0)
            for ev in self._by_t0.get(col.t0_ns, ()):
                yield ev

            i += 1
            self._cursor = i

    def _snapshot(self, col, scale) -> BookState:
        """Synthesize the column's book snapshot: each nonzero density row is
        one level at that row's price. f16 -> f64 widens losslessly."""
        bid = np.asarray(col.bid, dtype=np.float64)
        rows = np.arange(bid.shape[0], dtype=np.float64)
        px = rows_for_prices(scale, rows)
        live = np.isfinite(px) & (bid > 0)
        bid_px = px[live]
        bid_sz = bid[live]
        ask = col.ask
        if ask is not None:
            askd = np.asarray(ask, dtype=np.float64)
            al = np.isfinite(px) & (askd > 0)
            ask_px = px[al]
            ask_sz = askd[al]
        else:
            ask_px = np.empty(0, dtype=np.float64)
            ask_sz = np.empty(0, dtype=np.float64)
        return BookState(
            ts_ns=int(col.t0_ns),
            bid_px=bid_px,
            bid_sz=bid_sz,
            ask_px=ask_px,
            ask_sz=ask_sz,
        )
