/**
 * View transform — the pan/zoom camera (§8.3, M2 T6).
 *
 * This module is the reason FlowMap v2 does not have the v1 1-fps bug. v1
 * re-rasterized all resident history on the CPU every frame it panned; here the
 * camera is nothing but five scalars, and every pan/zoom is O(1) — it mutates
 * those scalars and produces the four `HeatmapView` uniforms. A column, once
 * uploaded to the tile texture (see TileRing), is NEVER touched again by a
 * pan/zoom: the fragment shader re-reads the same texels through a different
 * linear map. Interaction cost is independent of history depth.
 *
 * State (canonical center+span form, so cursor-anchored zoom is symmetric):
 *   - time:  `colCenter` (absolute column at the viewport's horizontal center,
 *            fractional) + `colSpan` (columns across the viewport = time zoom).
 *   - price: `rowCenter` (absolute row at the viewport's vertical center,
 *            fractional) + `rowSpan` (rows across the viewport = price zoom).
 *   - `follow`: auto-track the live right edge (any user pan/zoom clears it).
 *
 * All operations are PURE — they take a state (+ limits) and return a new state,
 * so the math is unit-testable with no GL context (see camera.test.ts). The
 * `Camera` class at the bottom is a thin imperative wrapper the renderer holds.
 *
 * Uniform mapping (matches the heatmap shader `col = colOffset + colScale*uv.x`,
 * `row = rowOffset + rowScale*uv.y`, with uv.y = 0 at the BOTTOM of the grid):
 *   colOffset = colCenter - colSpan/2   (left edge)
 *   colScale  = colSpan
 *   rowOffset = rowCenter - rowSpan/2   (bottom edge)
 *   rowScale  = rowSpan
 */

import type { HeatmapView } from './heatmap';
import type { ResidentRange } from './tileRing';

/** The five scalars that fully describe what the viewport shows. */
export interface CameraState {
  /** Absolute column at the viewport's horizontal center (fractional). */
  colCenter: number;
  /** Columns across the viewport (time zoom). Clamped ≥ minColSpan. */
  colSpan: number;
  /** Absolute row at the viewport's vertical center (fractional). */
  rowCenter: number;
  /** Rows across the viewport (price zoom). Clamped to [MIN_ROW_SPAN, rows]. */
  rowSpan: number;
  /** Auto-track the newest column at the right edge. */
  follow: boolean;
}

/** Bounds the clamps enforce (from the tile ring geometry). */
export interface CameraLimits {
  /** Price grid height — caps rowSpan (zoom-out) and bounds rowCenter. */
  rows: number;
  /** Smallest time span — "can't zoom past 1 col". */
  minColSpan: number;
  /** Largest time span — "can't zoom out beyond a max span". */
  maxColSpan: number;
}

/** Smallest time span in columns (one column fills the whole viewport). */
export const MIN_COL_SPAN = 1;
/** Smallest price span in rows (one price level fills the whole viewport). */
export const MIN_ROW_SPAN = 1;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Build limits from the ring geometry: rows tall, up to `capacityCols` wide. */
export function limitsFor(rows: number, capacityCols: number): CameraLimits {
  return {
    rows,
    minColSpan: MIN_COL_SPAN,
    // Allow zooming out to (a little past) the whole ring; never below 1.
    maxColSpan: Math.max(MIN_COL_SPAN, capacityCols),
  };
}

/**
 * Enforce the clamps on a candidate state:
 *   - colSpan ∈ [minColSpan, maxColSpan]           (time zoom limits)
 *   - rowSpan ∈ [MIN_ROW_SPAN, rows]               (price zoom limits)
 *   - rowCenter ∈ [0, rows]                         (can't pan off the price grid)
 * `colCenter` is intentionally NOT clamped: panning/zooming freely through all
 * of history (and a little past either end, where the shader draws background)
 * is the whole point, and it stays O(1).
 */
export function clampCamera(s: CameraState, limits: CameraLimits): CameraState {
  return {
    colCenter: s.colCenter,
    colSpan: clamp(s.colSpan, limits.minColSpan, limits.maxColSpan),
    rowCenter: clamp(s.rowCenter, 0, limits.rows),
    rowSpan: clamp(s.rowSpan, MIN_ROW_SPAN, limits.rows),
    follow: s.follow,
  };
}

/** Pan by a signed column/row delta. Disables auto-follow (a user gesture). */
export function pan(
  s: CameraState,
  limits: CameraLimits,
  dCols: number,
  dRows: number,
): CameraState {
  return clampCamera(
    { ...s, colCenter: s.colCenter + dCols, rowCenter: s.rowCenter + dRows, follow: false },
    limits,
  );
}

/**
 * Cursor-anchored time zoom. `factor` scales the span (<1 zooms in, >1 zooms
 * out); `anchorCol` is the absolute column currently under the cursor and stays
 * pinned to the same pixel across the zoom. Disables auto-follow.
 *
 * Derivation: keep the anchor's pixel offset from center constant. With the
 * post-clamp span ratio `eff = newSpan/oldSpan`, the new center is
 * `anchorCol + eff·(oldCenter − anchorCol)` — so the anchor is exact even when
 * the span clamps (colCenter is unclamped on the time axis).
 */
export function zoomTime(
  s: CameraState,
  limits: CameraLimits,
  factor: number,
  anchorCol: number,
): CameraState {
  const newSpan = clamp(s.colSpan * factor, limits.minColSpan, limits.maxColSpan);
  const eff = newSpan / s.colSpan;
  const colCenter = anchorCol + eff * (s.colCenter - anchorCol);
  return clampCamera({ ...s, colSpan: newSpan, colCenter, follow: false }, limits);
}

/**
 * Cursor-anchored price zoom. `factor` scales the row span; `anchorRow` is the
 * absolute row under the cursor and stays pinned (exactly, away from the price
 * grid edges where rowCenter clamps). Disables auto-follow.
 */
export function zoomPrice(
  s: CameraState,
  limits: CameraLimits,
  factor: number,
  anchorRow: number,
): CameraState {
  const newSpan = clamp(s.rowSpan * factor, MIN_ROW_SPAN, limits.rows);
  const eff = newSpan / s.rowSpan;
  const rowCenter = anchorRow + eff * (s.rowCenter - anchorRow);
  return clampCamera({ ...s, rowSpan: newSpan, rowCenter, follow: false }, limits);
}

/** Frame all resident columns and the whole price grid. Static (follow off). */
export function fit(limits: CameraLimits, range: ResidentRange, rows: number): CameraState {
  const count = Math.max(1, range.newest - range.oldest + 1);
  const colSpan = clamp(count, limits.minColSpan, limits.maxColSpan);
  // Center of the half-open column interval [oldest, newest+1).
  const colCenter = (range.oldest + range.newest + 1) / 2;
  const rowSpan = clamp(rows, MIN_ROW_SPAN, limits.rows);
  return { colCenter, colSpan, rowCenter: rows / 2, rowSpan, follow: false };
}

/**
 * Reset to a live default: frame the resident columns (or the max span if none),
 * pin the right edge to the newest column, center the price grid, follow ON.
 * This is the `R` / Go-Live action. When a range is given the view is immediately
 * correct; the renderer's per-column follow reframes the span to the canvas next.
 */
export function reset(limits: CameraLimits, range?: ResidentRange | null, rows?: number): CameraState {
  const gridRows = rows ?? limits.rows;
  const count = range ? Math.max(1, range.newest - range.oldest + 1) : limits.maxColSpan;
  const colSpan = clamp(count, limits.minColSpan, limits.maxColSpan);
  const colCenter = range ? range.newest + 1 - colSpan / 2 : 0;
  const rowSpan = clamp(gridRows, MIN_ROW_SPAN, limits.rows);
  return { colCenter, colSpan, rowCenter: gridRows / 2, rowSpan, follow: true };
}

/** Snap the right edge to the newest column, keeping the current spans. Follow ON. */
export function follow(s: CameraState, range: ResidentRange): CameraState {
  const rightEdge = range.newest + 1;
  return { ...s, colCenter: rightEdge - s.colSpan / 2, follow: true };
}

/** Convert camera state to the heatmap's scalar view uniforms. */
export function toView(s: CameraState): HeatmapView {
  return {
    colOffset: s.colCenter - s.colSpan / 2,
    colScale: s.colSpan,
    rowOffset: s.rowCenter - s.rowSpan / 2,
    rowScale: s.rowSpan,
  };
}

/**
 * Imperative wrapper the renderer holds: current state + limits, delegating to
 * the pure ops above. Gestures call these; each mutation lets the renderer mark
 * itself dirty and redraw with the new uniforms — nothing re-rasterizes.
 */
export class Camera {
  state: CameraState;
  limits: CameraLimits;

  constructor(limits: CameraLimits, state?: CameraState) {
    this.limits = limits;
    this.state = state ?? reset(limits);
  }

  get follow(): boolean {
    return this.state.follow;
  }

  setLimits(limits: CameraLimits): void {
    this.limits = limits;
    // Re-clamp so a shrunk grid can't leave the view out of bounds.
    this.state = clampCamera(this.state, limits);
  }

  pan(dCols: number, dRows: number): void {
    this.state = pan(this.state, this.limits, dCols, dRows);
  }

  zoomTime(factor: number, anchorCol: number): void {
    this.state = zoomTime(this.state, this.limits, factor, anchorCol);
  }

  zoomPrice(factor: number, anchorRow: number): void {
    this.state = zoomPrice(this.state, this.limits, factor, anchorRow);
  }

  fit(range: ResidentRange, rows: number): void {
    this.state = fit(this.limits, range, rows);
  }

  reset(range?: ResidentRange | null, rows?: number): void {
    this.state = reset(this.limits, range, rows);
  }

  followEdge(range: ResidentRange): void {
    this.state = follow(this.state, range);
  }

  /**
   * Set the whole follow frame from edge form (renderer's per-column auto-follow):
   * left column, time span, bottom row, price span. Keeps follow ON.
   */
  setFollowFrame(colLeft: number, colSpan: number, rowBottom: number, rowSpan: number): void {
    this.state = {
      colCenter: colLeft + colSpan / 2,
      colSpan,
      rowCenter: rowBottom + rowSpan / 2,
      rowSpan,
      follow: true,
    };
  }

  toView(): HeatmapView {
    return toView(this.state);
  }
}
