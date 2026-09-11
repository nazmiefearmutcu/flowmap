/**
 * Overlay coordinate mapping (§8.3 overlays, M2 T10).
 *
 * Every overlay (bubbles, BBO, VWAP, profile, markers) and both axes must be
 * pinned to the SAME camera transform as the heatmap, so they pan/zoom locked to
 * it. This module is the single place that math lives: it turns a canonical
 * event's `(ts_ns, price)` into the grid space the heatmap shader uses
 * (`col_seq`, `row`), then that grid space into WebGL clip space (for the GL
 * sprites/lines) or CSS pixels (for the 2D text layer). It is the exact same
 * `col = colOffset + colScale·uv.x`, `row = rowOffset + rowScale·uv.y` mapping the
 * heatmap draws with (see gl/heatmap.ts, gl/camera.ts `viewToGrid`) — so an
 * overlay glyph lands on the same pixel the fragment shader filled for that cell.
 *
 * All of it is PURE (a {@link GridMap} is an immutable snapshot of the view +
 * geometry for one frame), so trade→screen, price→row and tick math are all
 * unit-testable with no GL context (see coords.test.ts).
 *
 * Conventions (matched to the heatmap / camera):
 *   - `col_seq` is the absolute column; column `c` spans grid-x `[c, c+1)`. A
 *     trade at time `t0(c)` maps to grid-x `c` (its column's left edge); the
 *     column CENTER is `c + 0.5`.
 *   - `row` 0 is the BOTTOM of the price grid; row `r` carries price
 *     `p0 + r·step` (matching Renderer.probeAt) and spans grid-y `[r, r+1)`.
 *   - clip space is y-UP in [-1, 1] (WebGL NDC); CSS space is y-DOWN in px.
 */

import type { HeatmapView } from '../heatmap';
import {
  priceToRow as scalePriceToRow,
  rowToPrice as scaleRowToPrice,
  stepAtRow as scaleStepAtRow,
  type PriceScale,
} from '../priceScale';

/** Device + CSS pixel dimensions of the drawing surface for one frame. */
export interface SurfaceDims {
  /** Drawing-buffer width in device px (gl.drawingBufferWidth). */
  drawW: number;
  /** Drawing-buffer height in device px (gl.drawingBufferHeight). */
  drawH: number;
  /** CSS width in px (canvas.clientWidth). */
  cssW: number;
  /** CSS height in px (canvas.clientHeight). */
  cssH: number;
}

/**
 * Per-column start-time table for a resident window: `t0[i]` is the ns start
 * time of column `startSeq + i` (ascending). Present when the session's column
 * cadence is NOT uniform in time: a reconstructed (1 m-candle) history block is
 * 60 s-spaced while the live epoch is `dtNs` apart, so the single affine
 * `anchorT0Ns + (col − anchorSeq)·dtNs` lies about every reconstructed column
 * (survey S2 D1) and scatters trades/markers onto wrong lanes. When the table is
 * present and in range, ts⇄col go through it (binary search + linear
 * interpolation); everywhere else the affine is used and the result is
 * bit-identical to the pre-slot implementation.
 *
 * `t0` is float64 (the renderer's storage contract): ns values near 1.7e18
 * quantize to ~512 ns, far below the 250 ms column cadence — placement is exact
 * to sub-µs, and axis labels (ms-resolution) are unaffected.
 */
export interface TimeSlots {
  t0: Float64Array;
  /** Absolute `col_seq` of `t0[0]`. */
  startSeq: number;
}

/**
 * Column⇄time map for the current epoch. The AFFINE path is `t0(col) =
 * anchorT0Ns + (col − anchorSeq)·dtNs`, invertible to `col(ts) = anchorSeq +
 * (ts − anchorT0Ns)/dtNs`; any resident `(col_seq, t0_ns)` is a valid anchor
 * (the relation is exact within a uniform-cadence epoch), so the renderer
 * supplies the newest written column.
 *
 * `slots`, when present, is authoritative INSIDE its range: reconstructed
 * history makes the cadence non-uniform, and only the per-column table can
 * express that. Outside the table (or with no table at all) the affine is the
 * fallback — bit-identical to the historical behaviour.
 */
export interface TimeMap {
  anchorSeq: number;
  anchorT0Ns: bigint;
  dtNs: number;
  /** Optional per-column start-time table; see {@link TimeSlots}. */
  slots?: TimeSlots;
}

/**
 * Piecewise column→ts from a {@link TimeSlots} table: `t0` entries are exact
 * knots, fractional columns (and the boundary margin) interpolate linearly
 * between neighbours. Returns null when `col` is outside the table's range or
 * the table is unusable (fewer than 2 entries, reversed ends) — the caller then
 * falls back to the affine, which is what keeps the absent/out-of-range path
 * bit-identical to today. The producer writes columns in ascending order, so
 * the interior is trusted (no O(n) re-scan per query).
 */
export function slotColToTsNs(s: TimeSlots, col: number): bigint | null {
  const n = s.t0.length;
  if (n < 2) return null;
  const last = s.startSeq + n - 1;
  if (!(col >= s.startSeq) || !(col <= last)) return null;
  const t0 = s.t0;
  if (!(t0[n - 1] >= t0[0])) return null; // reversed ends → not usable
  const pos = col - s.startSeq;
  const i = Math.floor(pos);
  if (i >= n - 1) return BigInt(Math.round(t0[n - 1]));
  const v = t0[i] + (pos - i) * (t0[i + 1] - t0[i]);
  return BigInt(Math.round(v));
}

/**
 * Piecewise ts→column from a {@link TimeSlots} table (the inverse of
 * {@link slotColToTsNs}): binary-search the segment whose t0 span contains
 * `tsNs`, then interpolate linearly. Returns null when `tsNs` is outside the
 * table's range (the forming live edge belongs to the affine anchor) or the
 * table is unusable — the caller falls back to the affine.
 */
export function slotTsToCol(s: TimeSlots, tsNs: bigint): number | null {
  const n = s.t0.length;
  if (n < 2) return null;
  const t0 = s.t0;
  if (!(t0[n - 1] >= t0[0])) return null;
  const ts = Number(tsNs);
  if (!Number.isFinite(ts)) return null;
  if (ts < t0[0] || ts > t0[n - 1]) return null;
  // Largest `lo` with t0[lo] <= ts (ascending table → plain binary search).
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t0[mid] <= ts) lo = mid;
    else hi = mid - 1;
  }
  if (lo >= n - 1) return s.startSeq + n - 1;
  const span = t0[lo + 1] - t0[lo];
  const frac = span > 0 ? (ts - t0[lo]) / span : 0;
  return s.startSeq + lo + frac;
}

/**
 * Row⇄price map for the current epoch.
 *
 * `p0`/`step` describe the LINEAR affine (`price = p0 + row·step`) and remain
 * the whole story for every grid that has not opted into a wide price band —
 * so the default path is byte-identical to before.
 *
 * `scale`, when present, is authoritative and may be non-uniform (a linear core
 * with logarithmic wings; see gl/priceScale.ts). `p0`/`step` are still populated
 * alongside it as the CORE's values, purely so that code which only needs a
 * representative tick size keeps working — but anything that maps an actual row
 * or price MUST go through the accessors below, never the two scalars, because
 * under a hybrid scale a row's price height depends on where it sits.
 */
export interface PriceMap {
  p0: number;
  /** `tick · tick_multiple` — grid price increment per row (the CORE's, if hybrid). */
  step: number;
  /** Non-uniform scale, when the epoch declares one. Authoritative if set. */
  scale?: PriceScale;
}

/** The scale a PriceMap denotes — its explicit one, or the linear affine. */
export function mapScale(p: PriceMap): PriceScale {
  return p.scale ?? { kind: 'linear', p0: p.p0, step: p.step, rows: 0 };
}

/**
 * Per-frame snapshot of the camera transform + epoch geometry. Overlays hold one
 * for the duration of a draw and read coordinates off it; nothing here mutates
 * during a draw, so it is trivially pure/testable.
 *
 * The instance itself is REFILLED per frame by the overlay manager (`refill`) —
 * a dirty frame must not allocate (micro GC) — so a GridMap must not be retained
 * across frames. Constructing fresh instances remains fully supported (the
 * constructor and the refill write the same fields).
 */
export class GridMap {
  view: HeatmapView;
  dims: SurfaceDims;
  time: TimeMap | null;
  price: PriceMap | null;

  constructor(
    view: HeatmapView,
    dims: SurfaceDims,
    time: TimeMap | null,
    price: PriceMap | null,
  ) {
    this.view = view;
    this.dims = dims;
    this.time = time;
    this.price = price;
  }

  /** Point this GridMap at a new frame's view + geometry (no allocation). */
  refill(view: HeatmapView, dims: SurfaceDims, time: TimeMap | null, price: PriceMap | null): this {
    this.view = view;
    this.dims = dims;
    this.time = time;
    this.price = price;
    return this;
  }

  /** Whether `(ts_ns, price)` events can be placed (both affines known). */
  get hasEvents(): boolean {
    return this.time !== null && this.price !== null;
  }

  // --- event space → grid space -------------------------------------------------

  /** Fractional absolute column of a timestamp, or NaN when time is unknown.
   *  Piecewise through {@link TimeMap.slots} when that table covers the ts;
   *  otherwise the linear affine (bit-identical to the pre-slot behaviour). */
  tsToCol(tsNs: bigint): number {
    const t = this.time;
    if (t === null) return Number.NaN;
    if (t.slots !== undefined) {
      const piecewise = slotTsToCol(t.slots, tsNs);
      if (piecewise !== null) return piecewise;
    }
    return t.anchorSeq + Number(tsNs - t.anchorT0Ns) / t.dtNs;
  }

  /** Nanosecond start time of a (fractional) column, or null when time unknown.
   *  Piecewise through {@link TimeMap.slots} when that table covers the column;
   *  otherwise the linear affine (bit-identical to the pre-slot behaviour). */
  colToTsNs(col: number): bigint | null {
    const t = this.time;
    if (t === null) return null;
    if (t.slots !== undefined) {
      const piecewise = slotColToTsNs(t.slots, col);
      if (piecewise !== null) return piecewise;
    }
    return t.anchorT0Ns + BigInt(Math.round((col - t.anchorSeq) * t.dtNs));
  }

  /** Fractional row of a price, or NaN when the price map is unknown. */
  priceToRow(price: number): number {
    const p = this.price;
    if (p === null) return Number.NaN;
    return scalePriceToRow(mapScale(p), price);
  }

  /** Price at a (fractional) row, or NaN when the price map is unknown. */
  rowToPrice(row: number): number {
    const p = this.price;
    if (p === null) return Number.NaN;
    return scaleRowToPrice(mapScale(p), row);
  }

  /**
   * LOCAL price height of one row at `row` — what a "tick" is worth THERE.
   *
   * Constant on a linear grid; position-dependent on a hybrid one. Every
   * consumer that used to read `price.step` to size a rung, a profile bin or a
   * tick label must use this, or it will label the wings with the core's step.
   */
  stepAtRow(row: number): number {
    const p = this.price;
    if (p === null) return Number.NaN;
    return scaleStepAtRow(mapScale(p), row);
  }

  // --- grid space → clip space (WebGL, y-up) ------------------------------------

  clipX(colf: number): number {
    return ((colf - this.view.colOffset) / this.view.colScale) * 2 - 1;
  }

  clipY(rowf: number): number {
    return ((rowf - this.view.rowOffset) / this.view.rowScale) * 2 - 1;
  }

  // --- grid space → CSS pixels (2D canvas, y-down) ------------------------------

  cssX(colf: number): number {
    return ((colf - this.view.colOffset) / this.view.colScale) * this.dims.cssW;
  }

  cssY(rowf: number): number {
    return (1 - (rowf - this.view.rowOffset) / this.view.rowScale) * this.dims.cssH;
  }

  // --- pixel sizes → clip deltas (thickness / radius stay pixel-constant) --------

  /** Clip-space width of `pxCss` CSS pixels (independent of DPR: 2/cssW). */
  pxToClipW(pxCss: number): number {
    return (pxCss * 2) / Math.max(1, this.dims.cssW);
  }

  /** Clip-space height of `pxCss` CSS pixels (2/cssH). */
  pxToClipH(pxCss: number): number {
    return (pxCss * 2) / Math.max(1, this.dims.cssH);
  }

  /** A CSS pixel length in DEVICE px (for gl_PointSize, which is device-space). */
  pxToDevice(pxCss: number): number {
    return pxCss * (this.dims.drawW / Math.max(1, this.dims.cssW));
  }
}

/**
 * Coerce a canonical nanosecond field to bigint. The cold-JSON decoder only
 * promotes integer literals ABOVE 2^53 to bigint (lossless path); smaller ones —
 * e.g. a session-relative `Marker.ts_ns` (~1e12) — stay a plain `number` despite
 * the `bigint` type. Storing into a BigInt64Array (bubbles/markers rings) needs a
 * real bigint, so normalize here. Safe for both: bigint passes through; an integer
 * number converts exactly.
 */
export function toBigNs(x: bigint | number): bigint {
  return typeof x === 'bigint' ? x : BigInt(Math.round(x));
}

/** The visible absolute-column span of a view, clamped to a resident window. */
export function visibleColRange(
  view: HeatmapView,
  resident: { oldest: number; newest: number } | null,
): { lo: number; hi: number } | null {
  const left = Math.floor(view.colOffset);
  const right = Math.ceil(view.colOffset + view.colScale);
  let lo = Math.min(left, right);
  let hi = Math.max(left, right);
  if (resident !== null) {
    lo = Math.max(lo, resident.oldest);
    hi = Math.min(hi, resident.newest);
  }
  if (hi < lo) return null;
  return { lo, hi };
}

/**
 * Re-express a fractional ROW in another epoch's coordinates. The server bumps
 * the epoch and moves `p0` whenever mid leaves the grid's central band; the tile
 * ring is epoch-agnostic and the shader applies ONE row affine to every column,
 * so a locked (user-owned) price window must be remapped through the two affines
 * or it silently ends up pointing at different prices.
 *
 * Composition of `rowToPrice(from)` then `priceToRow(to)`. Returns NaN when
 * either affine is unusable (`to.step === 0`), which the caller must treat as
 * "remap failed, keep the old epoch" rather than writing NaN into the camera.
 */
export function remapRow(row: number, from: PriceMap, to: PriceMap): number {
  return scalePriceToRow(mapScale(to), scaleRowToPrice(mapScale(from), row));
}

/**
 * Re-express a row SPAN in another epoch's coordinates.
 *
 * On two linear grids a span is a pure ratio and `p0` cancels. On a non-uniform
 * grid it is not: the same number of rows covers a different price distance
 * depending on where it sits, so the caller passes `aroundRow` (the centre the
 * span is measured about) and the endpoints are remapped individually.
 */
export function remapRowSpan(
  rowSpan: number,
  from: PriceMap,
  to: PriceMap,
  aroundRow = 0,
): number {
  const f = mapScale(from);
  const t = mapScale(to);
  if (f.kind === 'linear' && t.kind === 'linear') {
    // Fast, exact path — and provably the old arithmetic.
    return t.step === 0 ? Number.NaN : (rowSpan * f.step) / t.step;
  }
  // A span is only meaningful as a difference, and under a non-uniform scale a
  // difference depends on WHERE it is measured — so remap the two endpoints of
  // the span centred on `aroundRow` and take the new distance between them.
  const lo = scaleRowToPrice(f, aroundRow - rowSpan / 2);
  const hi = scaleRowToPrice(f, aroundRow + rowSpan / 2);
  return scalePriceToRow(t, hi) - scalePriceToRow(t, lo);
}
