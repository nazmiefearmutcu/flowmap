"""Time-weighted density grid with epochs and a float16 column ring.

Design spec §8.1–8.2. Semantics that are load-bearing for the whole product:

- **Density is time-weighted resting size.** Each book update integrates the
  *previous* book state over ``(ts_ns - prev_ts)`` into the current column's
  accumulator; finalize divides the accumulator by ``dt_ns``. Two different
  update cadences over the same book therefore produce byte-identical columns
  (this kills the v1 bug where venue update-rate masqueraded as liquidity).
- **Precision:** accumulation happens in float64; the division by ``dt_ns``
  happens in float64 and only the finished density is cast to float16 for
  ring storage.
- **Epochs:** all columns in an epoch share ``(p0, tick, tick_multiple, dt)``.
  When mid exits the central 70 % of the span, :meth:`Grid.maybe_reanchor`
  bumps the epoch and recenters ``p0`` (snapped to the ``tick * tick_multiple``
  grid). History in the ring is NEVER rewritten — old columns keep their epoch.
  The in-progress accumulator is row-shifted into the new epoch's coordinates
  (the p0 delta is always an integer number of rows because both p0 values sit
  on the tick*multiple grid), so a column finalized after a mid-interval
  re-anchor is exact and carries the new epoch.
- **Interval boundaries:** interval ``k`` covers ``[k*dt, (k+1)*dt)``. An
  ``on_book`` at exactly a boundary finalizes the ending interval using the
  previous book integrated to the boundary; the new state applies from the
  boundary forward. A zero-span duplicate call whose timestamp equals the end
  of the most recently finalized column re-returns that column (idempotent —
  the ring and ``col_seq`` are untouched; callers dedup by ``col_seq``).
- **Bars:** ``vol_buy`` / ``vol_sell`` and OHLC are per-interval;
  ``cvd_cum`` / ``vwap_num_cum`` / ``vwap_den_cum`` are session-cumulative.
  Unknown-side trades feed neither volume bucket and leave cvd unchanged,
  but DO count toward the vwap sums. Intervals without trades carry the
  previous close as ``o == h == l == c`` (NaN before the first trade ever).

Time advancement is driven by :meth:`Grid.on_book` only; :meth:`Grid.on_trade`
accumulates into the current interval's bar and never finalizes columns.
"""

from __future__ import annotations

import msgspec
import numpy as np

from flowmap_server.proto.events import (
    MODE_SYNTH_PROFILE,
    SIDE_BUY,
    SIDE_SELL,
    BarColumn,
    DepthColumn,
    EpochParams,
)

_NAN = float("nan")


class GridCfg(msgspec.Struct, frozen=True):
    """Immutable grid configuration for one session."""

    tick: float
    tick_multiple: int
    dt_ns: int
    p0: float
    rows: int
    ring_columns: int
    mode: int  # MODE_L2 | MODE_L1_BAND | MODE_SYNTH_PROFILE


class FinalizedColumn(msgspec.Struct):
    """A finalized density column plus its bar, as stored in the ring."""

    epoch: int
    col_seq: int
    t0_ns: int
    bid: np.ndarray  # float16, length rows
    ask: np.ndarray  # float16, length rows
    bar: BarColumn


class Grid:
    """Per-session density grid: time-weighted accumulation, epochs, ring."""

    def __init__(self, cfg: GridCfg) -> None:
        if cfg.rows <= 0 or cfg.ring_columns <= 0 or cfg.dt_ns <= 0:
            raise ValueError("rows, ring_columns and dt_ns must be positive")
        self._cfg = cfg
        self._step = cfg.tick * cfg.tick_multiple
        self._p0 = cfg.p0
        self._epoch = 0
        # Per-epoch params table (spec §6.3): snapshot/history must be able to
        # announce EVERY epoch still present in the ring, not just the current
        # one. Populated here (epoch 0) and on every re-anchor; kept for the
        # session lifetime (re-anchors are rare, entries are tiny).
        self._epoch_params: dict[int, EpochParams] = {
            0: EpochParams(
                epoch=0,
                tick=cfg.tick,
                tick_multiple=cfg.tick_multiple,
                dt_ns=cfg.dt_ns,
                p0=cfg.p0,
                rows=cfg.rows,
            )
        }

        rows = cfg.rows
        # Current-interval accumulator and dense book state, [2, rows] f64
        # (channel 0 = bid, channel 1 = ask).
        self._acc = np.zeros((2, rows), dtype=np.float64)
        self._state = np.zeros((2, rows), dtype=np.float64)
        # Raw last book (price/size copies) so the dense state can be rebuilt
        # against a new p0 at re-anchor (out-of-range levels return then).
        self._last_book: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None = None

        self._prev_ts: int | None = None
        self._cur_idx: int | None = None  # current interval index; t0 = idx * dt_ns
        self._count = 0  # next col_seq (may exceed finalized count after a capped gap skip) (never resets)

        # Ring storage: float16 [ring_columns, 2, rows] + parallel metadata.
        rc = cfg.ring_columns
        self._ring = np.zeros((rc, 2, rows), dtype=np.float16)
        self._ring_epoch = np.zeros(rc, dtype=np.uint32)
        self._ring_t0 = np.zeros(rc, dtype=np.int64)
        self._ring_seq = np.zeros(rc, dtype=np.uint32)
        self._ring_bars: list[BarColumn | None] = [None] * rc

        # Bar state for the current interval.
        self._o = self._h = self._l = self._c = _NAN
        self._prev_close = _NAN
        self._bar_has_trade = False
        self._vol_buy = 0.0
        self._vol_sell = 0.0
        # Session-cumulative accumulators.
        self._cvd_cum = 0.0
        self._vwap_num_cum = 0.0
        self._vwap_den_cum = 0.0

    # -- book / density --------------------------------------------------------

    def on_book(
        self,
        ts_ns: int,
        bid_px: np.ndarray,
        bid_sz: np.ndarray,
        ask_px: np.ndarray,
        ask_sz: np.ndarray,
    ) -> list[FinalizedColumn]:
        """Apply a book state observed at ``ts_ns``.

        Time-weighted: the PREVIOUS book state is integrated over
        ``(ts_ns - prev_ts)``. May finalize 0..k columns (k > 1 if ts jumps
        intervals; skipped intervals emit columns (capped at ring_columns; older intervals are skipped) with the persisted book
        integrated across them). Returns the finalized columns.
        """
        dt = self._cfg.dt_ns
        out: list[FinalizedColumn] = []

        if self._cur_idx is None:
            self._cur_idx = ts_ns // dt
            self._prev_ts = ts_ns
            self._set_book(bid_px, bid_sz, ask_px, ask_sz)
            return out

        assert self._prev_ts is not None
        duplicate = ts_ns == self._prev_ts
        # Non-monotonic timestamps: clamp to zero span (state still replaced).
        cursor = self._prev_ts
        ts_eff = max(ts_ns, cursor)

        # Gap cap: a huge ts jump (e.g. weekend reconnect) would otherwise
        # finalize gap/dt columns — ~900k columns / ~14 GiB of return list for
        # a weekend at dt=250ms — only for all but the last ring_columns of
        # them to be immediately evicted. If the jump crosses more than
        # ring_columns + 1 whole intervals: finalize the current (partial)
        # interval normally, then skip straight to the last ring_columns
        # intervals before ts. col_seq advances by the number of SKIPPED
        # intervals so (col_seq delta == t0 delta / dt_ns) stays true across
        # the gap and t0<->col_seq bookkeeping can rely on monotonicity;
        # skipped seqs are never written to the ring and history() treats
        # them as evicted (a capped call always overwrites the whole ring).
        rc = self._cfg.ring_columns
        if ts_eff // dt - self._cur_idx > rc + 1:
            end = (self._cur_idx + 1) * dt
            span = end - cursor
            if span > 0:
                self._acc += self._state * span
            out.append(self._finalize_current())
            self._cur_idx += 1
            new_idx = ts_eff // dt - rc
            self._count += new_idx - self._cur_idx  # skipped interval count
            self._cur_idx = new_idx
            cursor = new_idx * dt

        while True:
            end = (self._cur_idx + 1) * dt
            if ts_eff < end:
                break
            span = end - cursor
            if span > 0:
                self._acc += self._state * span
            out.append(self._finalize_current())
            cursor = end
            self._cur_idx += 1
        span = ts_eff - cursor
        if span > 0:
            self._acc += self._state * span

        self._prev_ts = ts_eff
        self._set_book(bid_px, bid_sz, ask_px, ask_sz)

        if duplicate and not out and self._count > 0:
            # Zero-span call at exactly the end of the most recently finalized
            # column: re-return it (idempotent; callers dedup by col_seq).
            i = (self._count - 1) % self._cfg.ring_columns
            if int(self._ring_t0[i]) + dt == ts_ns:
                out.append(self._column_from_ring(i))
        return out

    def _set_book(
        self,
        bid_px: np.ndarray,
        bid_sz: np.ndarray,
        ask_px: np.ndarray,
        ask_sz: np.ndarray,
    ) -> None:
        self._last_book = (
            np.array(bid_px, dtype=np.float64, copy=True),
            np.array(bid_sz, dtype=np.float64, copy=True),
            np.array(ask_px, dtype=np.float64, copy=True),
            np.array(ask_sz, dtype=np.float64, copy=True),
        )
        self._state[0] = self._map_levels(bid_px, bid_sz)
        self._state[1] = self._map_levels(ask_px, ask_sz)

    def _map_levels(self, px: np.ndarray, sz: np.ndarray) -> np.ndarray:
        """Scatter price levels into a dense [rows] float64 profile.

        ``row = round((px - p0) / (tick * tick_multiple))``; out-of-range
        levels are dropped (they return after a re-anchor). Non-finite prices
        or sizes (NaN/inf) are dropped BEFORE the rint/int cast — they would
        otherwise poison the density texels and raise RuntimeWarnings.
        """
        rows = self._cfg.rows
        px64 = np.asarray(px, dtype=np.float64)
        sz64 = np.asarray(sz, dtype=np.float64)
        finite = np.isfinite(px64) & np.isfinite(sz64)
        px64 = px64[finite]
        sz64 = sz64[finite]
        r = np.rint((px64 - self._p0) / self._step).astype(np.int64)
        mask = (r >= 0) & (r < rows)
        return np.bincount(r[mask], weights=sz64[mask], minlength=rows)

    def _finalize_current(self) -> FinalizedColumn:
        assert self._cur_idx is not None
        dt = self._cfg.dt_ns
        t0 = self._cur_idx * dt
        # Division in float64, then a single cast to float16 (spec §8.1).
        density16 = (self._acc / float(dt)).astype(np.float16)
        bar = self._snap_bar(t0)

        i = self._count % self._cfg.ring_columns
        self._ring[i] = density16
        self._ring_epoch[i] = self._epoch
        self._ring_t0[i] = t0
        self._ring_seq[i] = self._count
        self._ring_bars[i] = bar

        col = FinalizedColumn(
            epoch=self._epoch,
            col_seq=self._count,
            t0_ns=t0,
            bid=density16[0],
            ask=density16[1],
            bar=bar,
        )
        self._count += 1
        self._acc[:] = 0.0
        self._reset_interval_bar()
        return col

    def _column_from_ring(self, i: int) -> FinalizedColumn:
        bar = self._ring_bars[i]
        assert bar is not None
        return FinalizedColumn(
            epoch=int(self._ring_epoch[i]),
            col_seq=int(self._ring_seq[i]),
            t0_ns=int(self._ring_t0[i]),
            bid=self._ring[i, 0].copy(),
            ask=self._ring[i, 1].copy(),
            bar=bar,
        )

    # -- trades / bars ---------------------------------------------------------

    def on_trade(self, ts_ns: int, price: float, size: float, side: int) -> None:
        """Feed a trade into the current interval's bar accumulators.

        Never advances intervals or finalizes columns — time advancement is
        driven by :meth:`on_book`. A trade arriving before any book update
        anchors the current interval at ``ts_ns // dt_ns``.
        """
        if self._cur_idx is None:
            self._cur_idx = ts_ns // self._cfg.dt_ns
            self._prev_ts = ts_ns

        if self._bar_has_trade:
            self._h = max(self._h, price)
            self._l = min(self._l, price)
        else:
            self._o = self._h = self._l = price
            self._bar_has_trade = True
        self._c = price

        if side == SIDE_BUY:
            self._vol_buy += size
            self._cvd_cum += size
        elif side == SIDE_SELL:
            self._vol_sell += size
            self._cvd_cum -= size
        # SIDE_UNKNOWN: neither volume bucket, cvd unchanged.
        self._vwap_num_cum += price * size
        self._vwap_den_cum += size

    def _snap_bar(self, t0_ns: int) -> BarColumn:
        return BarColumn(
            epoch=self._epoch,
            col_seq=self._count,
            t0_ns=t0_ns,
            o=self._o,
            h=self._h,
            l=self._l,
            c=self._c,
            vol_buy=self._vol_buy,
            vol_sell=self._vol_sell,
            cvd_cum=self._cvd_cum,
            vwap_num_cum=self._vwap_num_cum,
            vwap_den_cum=self._vwap_den_cum,
        )

    def _reset_interval_bar(self) -> None:
        self._prev_close = self._c  # may be NaN before the first trade ever
        self._o = self._h = self._l = self._c = self._prev_close
        self._bar_has_trade = False
        self._vol_buy = 0.0
        self._vol_sell = 0.0
        # *_cum accumulators persist across intervals (session-cumulative).

    # -- partial (right-edge) emission -----------------------------------------

    def _make_depth(
        self,
        epoch: int,
        col_seq: int,
        t0_ns: int,
        bid: np.ndarray,
        ask: np.ndarray,
        final: bool,
    ) -> DepthColumn:
        """Single owner of the density->wire conversion: cast to float32 and
        drop the ask channel in SYNTH_PROFILE mode."""
        synth = self._cfg.mode == MODE_SYNTH_PROFILE
        return DepthColumn(
            epoch=epoch,
            col_seq=col_seq,
            t0_ns=t0_ns,
            mode=self._cfg.mode,
            final=final,
            bid=bid.astype(np.float32),
            ask=None if synth else ask.astype(np.float32),
        )

    def to_depth(self, col: FinalizedColumn) -> DepthColumn:
        """Convert a finalized (f16 ring) column to a wire DepthColumn
        (float32, ``final=True``, ask dropped in SYNTH_PROFILE mode)."""
        return self._make_depth(col.epoch, col.col_seq, col.t0_ns, col.bid, col.ask, final=True)

    def current_partial(self) -> DepthColumn | None:
        """Progressive right-edge emit: the in-progress column so far.

        The partial integral (accumulated through the latest ``on_book``
        timestamp) is divided by the full ``dt_ns``, so the value converges to
        the finalized column as the interval fills. Returns ``None`` before the
        grid has been anchored by any event; after a trade-only anchor the
        density is all zeros but the column (t0/col_seq) is already meaningful.
        """
        if self._cur_idx is None:
            return None
        density = self._acc / float(self._cfg.dt_ns)
        return self._make_depth(
            self._epoch,
            self._count,
            self._cur_idx * self._cfg.dt_ns,
            density[0],
            density[1],
            final=False,
        )

    def bar_partial(self) -> BarColumn:
        """The current interval's bar state (not yet finalized)."""
        t0 = 0 if self._cur_idx is None else self._cur_idx * self._cfg.dt_ns
        return self._snap_bar(t0)

    # -- epochs / re-anchor ----------------------------------------------------

    def maybe_reanchor(self, mid: float) -> EpochParams | None:
        """Re-anchor if ``mid`` sits outside the central 70 % of the span.

        Bumps the epoch, recenters ``p0`` (snapped to the tick*multiple grid)
        and returns the new :class:`EpochParams`. History in the ring is NEVER
        rewritten; the in-progress accumulator is shifted into the new row
        coordinates so the current column stays exact under the new epoch.
        """
        cfg = self._cfg
        span = cfg.rows * self._step
        lo = self._p0 + 0.15 * span
        hi = self._p0 + 0.85 * span
        if lo <= mid <= hi:
            return None

        new_p0 = round((mid - span / 2.0) / self._step) * self._step
        offset = round((new_p0 - self._p0) / self._step)  # exact: both on grid
        self._shift_rows(self._acc, offset)
        self._p0 = new_p0
        self._epoch += 1
        if self._last_book is not None:
            bid_px, bid_sz, ask_px, ask_sz = self._last_book
            self._state[0] = self._map_levels(bid_px, bid_sz)
            self._state[1] = self._map_levels(ask_px, ask_sz)
        params = EpochParams(
            epoch=self._epoch,
            tick=cfg.tick,
            tick_multiple=cfg.tick_multiple,
            dt_ns=cfg.dt_ns,
            p0=new_p0,
            rows=cfg.rows,
        )
        self._epoch_params[self._epoch] = params
        return params

    def epoch_params_for(self, epoch: int) -> EpochParams:
        """Params of any epoch this grid has lived through.

        Raises ``KeyError`` for epochs the grid never entered.
        """
        return self._epoch_params[epoch]

    def current_epoch_params(self) -> EpochParams:
        """Params of the live (current) epoch."""
        return self._epoch_params[self._epoch]

    def _shift_rows(self, a: np.ndarray, offset: int) -> None:
        """In-place row shift along the last axis: ``new[r] = old[r + offset]``.

        Rows shifted out of range are dropped; vacated rows become zero.
        """
        if offset == 0:
            return
        rows = self._cfg.rows
        if abs(offset) >= rows:
            a[...] = 0.0
            return
        if offset > 0:
            a[..., : rows - offset] = a[..., offset:]
            a[..., rows - offset :] = 0.0
        else:
            k = -offset
            a[..., k:] = a[..., : rows - k]
            a[..., :k] = 0.0

    # -- history ---------------------------------------------------------------

    def oldest_retained_t0_ns(self) -> int | None:
        """``t0_ns`` of the oldest column still retained in the ring, or
        ``None`` when no column has been finalized yet. This is what
        ``HistoryResponse.oldest_available_t_ns`` reports for the RAM ring."""
        rc = self._cfg.ring_columns
        retained = min(self._count, rc)
        if retained == 0:
            return None
        return int(self._ring_t0[(self._count - retained) % rc])

    def history(self, before_t_ns: int, n: int) -> list[FinalizedColumn]:
        """The most recent ``n`` retained columns with ``t0_ns < before_t_ns``.

        ``before_t_ns`` is EXCLUSIVE. Returns chronological (oldest first).
        Only columns still retained in the ring are served; arrays are copies.
        """
        rc = self._cfg.ring_columns
        retained = min(self._count, rc)
        if retained == 0 or n <= 0:
            return []
        seqs = np.arange(self._count - retained, self._count, dtype=np.int64)
        idxs = seqs % rc
        keep = self._ring_t0[idxs] < before_t_ns
        chosen = idxs[keep][-n:]
        return [self._column_from_ring(int(i)) for i in chosen]
