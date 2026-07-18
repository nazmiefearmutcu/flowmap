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
 * Column⇄time affine for the current epoch: `t0(col) = anchorT0Ns + (col −
 * anchorSeq)·dtNs`, invertible to `col(ts) = anchorSeq + (ts − anchorT0Ns)/dtNs`.
 * Any resident `(col_seq, t0_ns)` is a valid anchor (the relation is exact within
 * an epoch), so the renderer supplies the newest written column.
 */
export interface TimeMap {
  anchorSeq: number;
  anchorT0Ns: bigint;
  dtNs: number;
}

/** Row⇄price affine for the current epoch: `price = p0 + row·step`. */
export interface PriceMap {
  p0: number;
  /** `tick · tick_multiple` — grid price increment per row. */
  step: number;
}

/**
 * Immutable per-frame snapshot of the camera transform + epoch geometry. Overlays
 * hold one for the duration of a draw and read coordinates off it; nothing here
 * mutates, so it is trivially pure/testable.
 */
export class GridMap {
  readonly view: HeatmapView;
  readonly dims: SurfaceDims;
  readonly time: TimeMap | null;
  readonly price: PriceMap | null;

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

  /** Whether `(ts_ns, price)` events can be placed (both affines known). */
  get hasEvents(): boolean {
    return this.time !== null && this.price !== null;
  }

  // --- event space → grid space -------------------------------------------------

  /** Fractional absolute column of a timestamp, or NaN when time is unknown. */
  tsToCol(tsNs: bigint): number {
    const t = this.time;
    if (t === null) return Number.NaN;
    return t.anchorSeq + Number(tsNs - t.anchorT0Ns) / t.dtNs;
  }

  /** Nanosecond start time of a (fractional) column, or null when time unknown. */
  colToTsNs(col: number): bigint | null {
    const t = this.time;
    if (t === null) return null;
    return t.anchorT0Ns + BigInt(Math.round((col - t.anchorSeq) * t.dtNs));
  }

  /** Fractional row of a price, or NaN when the price affine is unknown. */
  priceToRow(price: number): number {
    const p = this.price;
    if (p === null || p.step === 0) return Number.NaN;
    return (price - p.p0) / p.step;
  }

  /** Price at a (fractional) row, or NaN when the price affine is unknown. */
  rowToPrice(row: number): number {
    const p = this.price;
    if (p === null) return Number.NaN;
    return p.p0 + row * p.step;
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
