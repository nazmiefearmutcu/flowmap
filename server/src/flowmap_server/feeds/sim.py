"""Deterministic simulated feed (M1 T6).

The sim feed is the test/demo data source for the whole stack: e2e tests, the
M2 renderer perf harness (``generate_history``) and visual verification of
sum-mips (persistent liquidity walls) all build on it, so everything here is
driven by one seeded ``np.random.default_rng`` and NOTHING reads the wall
clock. Two constructions with the same seed yield identical event sequences;
timestamps advance arithmetically from ``start_ns``.

Market model (one step per ``dt_ns`` interval):

- **Mid** starts at 100.0 and follows a gaussian random walk with a rare
  larger jump, clamped away from zero. All draws are gaussian/lognormal/
  uniform, so every price and size is finite by construction.
- **Book**: a 40-level ladder per side at tick 0.5 around the best quotes,
  with lognormal sizes, PLUS 4 persistent "wall" levels per side whose
  *absolute* price stays fixed for hundreds of intervals at ~10x the median
  ladder size. Walls survive mid drift (they are appended as explicit price
  levels, not ladder offsets), so the heatmap shows horizontal bright lines —
  the structure sum-mips verification needs. A wall respawns at a new price
  only when its lifetime expires or the mid crosses it.
- **Trades**: Poisson (~3/interval) at the touch with correct aggressor
  semantics — a buy hits the ask (trades at best ask), a sell hits the bid.
- **Markers**: rare (~1/500 intervals) "liquidation" markers.

``events()`` yields 4–8 book updates per interval at deterministically
jittered offsets (ladder sizes re-drawn per update; walls held), interleaved
with the interval's trades/markers in non-decreasing ``ts_ns`` order. It never
sleeps unless ``realtime=True``, in which case it paces one interval per
``dt_ns`` of wall time via ``asyncio.sleep`` (the only clock interaction, and
it does not influence the generated data).

``generate_history`` reuses the exact same per-interval core but drives a
private :class:`Grid` with a single book state per interval boundary — the
relaxation the plan allows for speed — and comfortably builds 10k columns
(rows=2048) inside the 2 s budget.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import msgspec
import numpy as np

from flowmap_server.core.grid import FinalizedColumn, Grid, GridCfg
from flowmap_server.feeds.base import BookState, FeedEvent
from flowmap_server.proto.events import (
    MODE_L2,
    SIDE_BUY,
    SIDE_SELL,
    SIDE_SRC_EXCHANGE,
    Marker,
    Trade,
)

__all__ = ["SimFeed"]

# --- model constants (tuned; tests pin the emergent properties, not these) ----
_MID0 = 100.0
_TICK = 0.5
_MIN_PRICE = 5.0
_LEVELS = 40  # ladder depth per side
_LN_MU, _LN_SIGMA = 1.0, 0.5  # ladder size ~ lognormal; median = e^mu ~= 2.72
_MEDIAN_SIZE = float(np.exp(_LN_MU))

_MID_SIGMA = 0.04  # per-interval random-walk step
_JUMP_P = 1.0 / 200.0
_JUMP_SIGMA = 1.0

_WALLS_PER_SIDE = 4
_WALL_SCALE = 10.0  # x median ladder size
_WALL_MIN_TICKS, _WALL_MAX_TICKS = 3, 25  # spawn offset from the touch
_WALL_TTL_MIN, _WALL_TTL_MAX = 300, 900  # lifetime in intervals

_TRADE_RATE = 3.0  # Poisson mean per interval
_TRADE_LN_MU, _TRADE_LN_SIGMA = -0.5, 0.8
_LIQ_P = 1.0 / 500.0
_VENUE = "sim"

_SUB_MIN, _SUB_MAX = 4, 8  # book updates per interval in events()


class _Interval(msgspec.Struct):
    """One interval's deterministic outputs (book sizes drawn separately)."""

    t0_ns: int
    best_bid: float
    best_ask: float
    trades: list[Trade]
    marker: Marker | None


class _SimCore:
    """Seeded market-state machine shared by ``events()`` and history gen."""

    def __init__(self, seed: int, dt_ns: int, start_ns: int) -> None:
        self.rng = np.random.default_rng(seed)
        self.dt_ns = dt_ns
        self.t_next = start_ns
        self.mid = _MID0
        # walls: [side(0=bid,1=ask), i] -> price / size / remaining lifetime
        self.wall_px = np.zeros((2, _WALLS_PER_SIDE), dtype=np.float64)
        self.wall_sz = np.zeros((2, _WALLS_PER_SIDE), dtype=np.float64)
        self.wall_ttl = np.zeros((2, _WALLS_PER_SIDE), dtype=np.int64)
        for side in (0, 1):
            for i in range(_WALLS_PER_SIDE):
                self._respawn_wall(side, i)

    def _quotes(self) -> tuple[float, float]:
        best_bid = float(np.floor(self.mid / _TICK) * _TICK)
        return best_bid, best_bid + _TICK

    def _respawn_wall(self, side: int, i: int) -> None:
        best_bid, best_ask = self._quotes()
        off = int(self.rng.integers(_WALL_MIN_TICKS, _WALL_MAX_TICKS + 1)) * _TICK
        self.wall_px[side, i] = (best_bid - off) if side == 0 else (best_ask + off)
        self.wall_sz[side, i] = _WALL_SCALE * _MEDIAN_SIZE * float(self.rng.uniform(0.8, 1.4))
        self.wall_ttl[side, i] = int(self.rng.integers(_WALL_TTL_MIN, _WALL_TTL_MAX + 1))

    def step(self) -> _Interval:
        """Advance one dt interval: mid walk, wall upkeep, trades, marker."""
        rng = self.rng
        t0 = self.t_next
        self.t_next += self.dt_ns

        d = rng.normal(0.0, _MID_SIGMA)
        if rng.random() < _JUMP_P:
            d += rng.normal(0.0, _JUMP_SIGMA)
        self.mid = max(self.mid + d, _MIN_PRICE)
        best_bid, best_ask = self._quotes()

        # Walls persist at a FIXED absolute price until their lifetime runs out
        # or the mid crosses them (a crossed wall was "consumed").
        self.wall_ttl -= 1
        for i in range(_WALLS_PER_SIDE):
            if self.wall_ttl[0, i] <= 0 or self.wall_px[0, i] > best_bid + 1e-9:
                self._respawn_wall(0, i)
            if self.wall_ttl[1, i] <= 0 or self.wall_px[1, i] < best_ask - 1e-9:
                self._respawn_wall(1, i)

        n = int(rng.poisson(_TRADE_RATE))
        offs = np.sort(rng.integers(0, self.dt_ns, n))
        buys = rng.integers(0, 2, n)  # 1 -> aggressive buy, 0 -> aggressive sell
        sizes = rng.lognormal(_TRADE_LN_MU, _TRADE_LN_SIGMA, n)
        trades = [
            Trade(
                ts_ns=int(t0 + offs[j]),
                # A buy hits the ask; a sell hits the bid.
                price=best_ask if buys[j] else best_bid,
                size=float(sizes[j]),
                side=SIDE_BUY if buys[j] else SIDE_SELL,
                side_src=SIDE_SRC_EXCHANGE,
                venue=_VENUE,
            )
            for j in range(n)
        ]

        marker: Marker | None = None
        if rng.random() < _LIQ_P:
            m_off = int(rng.integers(0, self.dt_ns))
            m_buy = int(rng.integers(0, 2))
            marker = Marker(
                ts_ns=int(t0 + m_off),
                kind="liquidation",
                text="sim liquidation",
                price=best_ask if m_buy else best_bid,
                size=float(rng.lognormal(2.5, 0.6)),
            )
        return _Interval(t0_ns=t0, best_bid=best_bid, best_ask=best_ask, trades=trades, marker=marker)

    def book(self, iv: _Interval) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Draw one book realization: fresh ladder sizes + fixed walls."""
        rng = self.rng
        lad = np.arange(_LEVELS, dtype=np.float64) * _TICK
        bid_px = np.concatenate([iv.best_bid - lad, self.wall_px[0]])
        ask_px = np.concatenate([iv.best_ask + lad, self.wall_px[1]])
        bid_sz = np.concatenate([rng.lognormal(_LN_MU, _LN_SIGMA, _LEVELS), self.wall_sz[0]])
        ask_sz = np.concatenate([rng.lognormal(_LN_MU, _LN_SIGMA, _LEVELS), self.wall_sz[1]])
        return bid_px, bid_sz, ask_px, ask_sz


class SimFeed:
    """Deterministic simulated market feed (implements the Feed protocol)."""

    market = "sim"
    symbol = "SIM-DEMO"

    def __init__(
        self,
        seed: int,
        dt_ns: int = 250_000_000,
        start_ns: int = 0,
        *,
        realtime: bool = False,
    ) -> None:
        if dt_ns <= 0:
            raise ValueError("dt_ns must be positive")
        self._seed = seed
        self._dt_ns = dt_ns
        self._start_ns = start_ns
        self._realtime = realtime
        self.capability: dict[str, object] = {
            "depth": "L2",
            "tape": "tick",
            "trade_side": "exchange",
            "markers": ["liquidation", "gap"],
        }

    async def events(self) -> AsyncIterator[FeedEvent]:
        """Endless deterministic event stream (fresh state per call).

        Per interval: 4-8 :class:`BookState` updates at jittered offsets
        (the first at exactly ``t0``, so the previous interval finalizes on
        the boundary), plus the interval's trades and occasional liquidation
        marker, merged in non-decreasing ``ts_ns`` order. Never sleeps unless
        ``realtime=True``.
        """
        core = _SimCore(self._seed, self._dt_ns, self._start_ns)
        dt = self._dt_ns
        while True:
            iv = core.step()
            n_sub = int(core.rng.integers(_SUB_MIN, _SUB_MAX + 1))
            offs = np.empty(n_sub, dtype=np.int64)
            offs[0] = 0
            offs[1:] = np.sort(core.rng.integers(1, dt, n_sub - 1))
            timed: list[tuple[int, FeedEvent]] = [
                (
                    int(iv.t0_ns + off),
                    BookState(int(iv.t0_ns + off), *core.book(iv)),
                )
                for off in offs
            ]
            timed.extend((t.ts_ns, t) for t in iv.trades)
            if iv.marker is not None:
                timed.append((iv.marker.ts_ns, iv.marker))
            # Stable sort on ts only: at equal ts, books precede trades/markers.
            timed.sort(key=lambda p: p[0])
            for _, ev in timed:
                yield ev
            if self._realtime:
                await asyncio.sleep(dt / 1e9)

    @classmethod
    def generate_history(
        cls,
        seed: int,
        n_cols: int,
        *,
        dt_ns: int = 250_000_000,
        start_ns: int = 0,
        rows: int = 2048,
        tick: float = _TICK,
        tick_multiple: int = 1,
        ring_columns: int = 1024,
    ) -> list[FinalizedColumn]:
        """Build ``n_cols`` finalized columns fast (M2 perf harness).

        Same deterministic core as ``events()``, but one book state per
        interval boundary drives a private :class:`Grid` in a tight loop
        (walls/structure statistically identical — NOT the same trajectory
        as ``events()`` for the same seed, since ``events()`` consumes extra
        rng draws for sub-interval cadence; each path is individually
        deterministic). ``start_ns`` should be a multiple of ``dt_ns`` so ``t0``
        lands on the boundaries. 10k columns at rows=2048 build in well
        under 2 s.
        """
        if n_cols <= 0:
            return []
        core = _SimCore(seed, dt_ns, start_ns)
        p0 = round((_MID0 - rows * tick * tick_multiple / 2.0) / tick) * tick
        grid = Grid(
            GridCfg(
                tick=tick,
                tick_multiple=tick_multiple,
                dt_ns=dt_ns,
                p0=p0,
                rows=rows,
                ring_columns=ring_columns,
                mode=MODE_L2,
            )
        )
        out: list[FinalizedColumn] = []
        for _ in range(n_cols + 1):
            iv = core.step()
            out.extend(grid.on_book(iv.t0_ns, *core.book(iv)))
            if len(out) >= n_cols:
                break
            for t in iv.trades:
                grid.on_trade(t.ts_ns, t.price, t.size, t.side)
        return out[:n_cols]
