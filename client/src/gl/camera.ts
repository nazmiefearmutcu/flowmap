/**
 * View transform — the pan/zoom camera (§8.3, M2 T6).
 *
 * This module is the reason FlowMap does not have the v1 1-fps bug. v1
 * re-rasterized all resident history on the CPU every frame it panned; here the
 * camera is nothing but six scalars, and every pan/zoom is O(1) — it mutates
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
 *   - `followTime`: auto-track the live right edge.
 *   - `followPrice`: how the price axis auto-scales — see {@link PriceFollow}.
 *
 * **Per-axis follow.** The two axes used to share ONE `follow` boolean, so any
 * gesture froze both and price was never tracked again. They are independent
 * now: scrolling back through time keeps the price axis auto-scaling, and
 * zooming price keeps the right edge pinned to now. The pure `applyKill` below
 * is the single place that encodes which gesture releases which axis.
 *
 * **Overscroll.** `rowCenter` is clamped to a SPAN-RELATIVE band that extends a
 * full viewport past each edge of the price grid ({@link rowCenterBounds}), so
 * the user can push the grid entirely off screen in either direction — the
 * "look infinitely far up/down" gesture. That is visually safe with no shader
 * change: the fragment shader already paints the LUT floor (`background()`) for
 * any row outside `[0, rows)`. `rowSpan` still tops out at the grid height:
 * beyond that there is nothing but background to reveal, and letting it grow
 * further would push `Renderer.currentLevel()` to SUM-mip level 2, which
 * silently suppresses scroll-back backfill (see net/history.ts).
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

/**
 * How the price axis auto-scales.
 *   - `'fit'`   — auto-fit to the visible book (the boot state). The renderer
 *                 owns BOTH `rowCenter` and `rowSpan`.
 *   - `'track'` — the user owns `rowSpan` (their zoom is sacred); the renderer
 *                 only recentres `rowCenter` when price drifts out of a central
 *                 deadband. This is what a price zoom promotes `'fit'` into.
 *   - `'off'`   — frozen; the user owns both.
 *
 * A 3-state union rather than a second boolean because the boot state and the
 * post-zoom state are genuinely different: before the user has zoomed there IS
 * no user span to preserve, and auto-fitting is the only way a 2048-row grid
 * shows more than a hairline of book.
 */
export type PriceFollow = 'fit' | 'track' | 'off';

/** The six scalars that fully describe what the viewport shows. */
export interface CameraState {
  /** Absolute column at the viewport's horizontal center (fractional). */
  colCenter: number;
  /** Columns across the viewport (time zoom). Clamped ≥ minColSpan. */
  colSpan: number;
  /** Absolute row at the viewport's vertical center (fractional). */
  rowCenter: number;
  /** Rows across the viewport (price zoom). Clamped to [MIN_ROW_SPAN, rows]. */
  rowSpan: number;
  /** Auto-track the newest column at the right edge (TIME axis only). */
  followTime: boolean;
  /** How the PRICE axis auto-scales. */
  followPrice: PriceFollow;
}

/** Which axes a gesture releases from auto-follow. */
export interface FollowKill {
  killTime: boolean;
  killPrice: boolean;
}

/** A positional drag: a full manual takeover of both axes. */
export const KILL_BOTH: FollowKill = { killTime: true, killPrice: true };
/** A time-only gesture (wheel over the chart / time gutter, ←/→ keys). */
export const KILL_TIME: FollowKill = { killTime: true, killPrice: false };
/** A price-only gesture (↑/↓ keys). */
export const KILL_PRICE: FollowKill = { killTime: false, killPrice: true };
/** No release (a programmatic reframe). */
export const KILL_NONE: FollowKill = { killTime: false, killPrice: false };

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
 * The overscroll band `rowCenter` may roam in, for a given (already clamped)
 * `rowSpan`. One full viewport past each edge of the grid: at the low bound the
 * grid's bottom row sits at the TOP of the viewport (everything below is
 * background), at the high bound its top row sits at the BOTTOM. That is as far
 * as "look further up/down" can mean anything — past it the screen is uniformly
 * background and there is nothing left to scroll toward. Span-relative rather
 * than a fixed row count so the gesture feels the same at every price zoom.
 */
export function rowCenterBounds(rowSpan: number, limits: CameraLimits): { lo: number; hi: number } {
  return { lo: -rowSpan, hi: limits.rows + rowSpan };
}

/**
 * Enforce the clamps on a candidate state:
 *   - colSpan  ∈ [minColSpan, maxColSpan]          (time zoom limits)
 *   - rowSpan  ∈ [MIN_ROW_SPAN, rows]              (price zoom limits)
 *   - rowCenter ∈ rowCenterBounds(rowSpan)         (price overscroll band)
 * `rowSpan` is clamped FIRST so the two price clamps compose deterministically
 * (the centre band is derived from the FINAL span, never a pre-clamp one).
 * `colCenter` is intentionally NOT clamped: panning/zooming freely through all
 * of history (and a little past either end, where the shader draws background)
 * is the whole point, and it stays O(1).
 */
export function clampCamera(s: CameraState, limits: CameraLimits): CameraState {
  const rowSpan = clamp(s.rowSpan, MIN_ROW_SPAN, limits.rows);
  const bounds = rowCenterBounds(rowSpan, limits);
  return {
    colCenter: s.colCenter,
    colSpan: clamp(s.colSpan, limits.minColSpan, limits.maxColSpan),
    rowCenter: clamp(s.rowCenter, bounds.lo, bounds.hi),
    rowSpan,
    followTime: s.followTime,
    followPrice: s.followPrice,
  };
}

/**
 * Release the axes a gesture takes over.
 *
 * The one subtlety, and the reason this is a named pure function: killing TIME
 * while price is `'fit'` PROMOTES price to `'track'` rather than switching it
 * off. Auto-fit is only meaningful at the live edge (it frames the book in the
 * follow window), but the span it had just fitted is exactly the span the user
 * wants kept while they scroll back. So a horizontal drag drops you off the live
 * edge and price keeps tracking at the span it was already showing — which is
 * precisely "a horizontal drag should not kill price-follow".
 */
export function applyKill(s: CameraState, kill: FollowKill): CameraState {
  let followPrice = s.followPrice;
  if (kill.killPrice) followPrice = 'off';
  else if (kill.killTime && followPrice === 'fit') followPrice = 'track';
  return {
    ...s,
    followTime: kill.killTime ? false : s.followTime,
    followPrice,
  };
}

/**
 * A price zoom: the user has just chosen a span, so `'fit'` (renderer-owned
 * span) becomes `'track'` (user-owned span, renderer-owned centre). `'track'`
 * and `'off'` are unchanged — zooming never re-enables a follow the user turned
 * off, and never disables the tracking they left on.
 */
export function adoptPriceSpan(s: CameraState): CameraState {
  return s.followPrice === 'fit' ? { ...s, followPrice: 'track' } : s;
}

/**
 * Pan by a signed column/row delta. `kill` says which axes the gesture claims —
 * a positional drag claims both ({@link KILL_BOTH}, the default), while the
 * arrow keys claim only the axis they move.
 */
export function pan(
  s: CameraState,
  limits: CameraLimits,
  dCols: number,
  dRows: number,
  kill: FollowKill = KILL_BOTH,
): CameraState {
  return clampCamera(
    applyKill({ ...s, colCenter: s.colCenter + dCols, rowCenter: s.rowCenter + dRows }, kill),
    limits,
  );
}

/**
 * Cursor-anchored time zoom. `factor` scales the span (<1 zooms in, >1 zooms
 * out); `anchorCol` is the absolute column currently under the cursor and stays
 * pinned to the same pixel across the zoom. Releases TIME follow only — the
 * price axis keeps auto-scaling.
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
  return clampCamera(applyKill({ ...s, colSpan: newSpan, colCenter }, KILL_TIME), limits);
}

/**
 * Cursor-anchored price zoom. `factor` scales the row span; `anchorRow` is the
 * absolute row under the cursor and stays pinned (exactly, away from the
 * overscroll bounds where rowCenter clamps). Does NOT touch time follow, and
 * does not switch price follow off — it promotes `'fit'` to `'track'` so the
 * span the user just chose is kept and only the centre keeps tracking.
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
  return clampCamera(adoptPriceSpan({ ...s, rowSpan: newSpan, rowCenter }), limits);
}

/**
 * The price frame (bottom row + span) that shows a non-zero book extent
 * `[lo, hi]` with proportional padding, clamped to the grid. Lifted out of the
 * renderer's follow frame so the framing rule is pure and unit-testable — it is
 * the same math the auto-fit uses on every column.
 */
export function priceFrame(
  lo: number,
  hi: number,
  rows: number,
  padFraction: number,
  minPad: number,
): { rowBottom: number; rowSpan: number } {
  const pad = Math.max(minPad, Math.round((hi - lo) * padFraction));
  const bottom = Math.max(0, lo - pad);
  const top = Math.min(rows, hi + pad + 1);
  return { rowBottom: bottom, rowSpan: Math.max(1, top - bottom) };
}

/** Frame all resident columns and the whole price grid. Static (no follow). */
export function fit(limits: CameraLimits, range: ResidentRange, rows: number): CameraState {
  const count = Math.max(1, range.newest - range.oldest + 1);
  const colSpan = clamp(count, limits.minColSpan, limits.maxColSpan);
  // Center of the half-open column interval [oldest, newest+1).
  const colCenter = (range.oldest + range.newest + 1) / 2;
  const rowSpan = clamp(rows, MIN_ROW_SPAN, limits.rows);
  return {
    colCenter,
    colSpan,
    rowCenter: rows / 2,
    rowSpan,
    followTime: false,
    followPrice: 'off',
  };
}

/**
 * Reset to a live default: frame the resident columns (or the max span if none),
 * pin the right edge to the newest column, center the price grid, BOTH follows
 * on. This is the `R` / Go-Live action. When a range is given the view is
 * immediately correct; the renderer's per-column follow reframes the span to the
 * canvas next.
 */
export function reset(
  limits: CameraLimits,
  range?: ResidentRange | null,
  rows?: number,
): CameraState {
  const gridRows = rows ?? limits.rows;
  const count = range ? Math.max(1, range.newest - range.oldest + 1) : limits.maxColSpan;
  const colSpan = clamp(count, limits.minColSpan, limits.maxColSpan);
  const colCenter = range ? range.newest + 1 - colSpan / 2 : 0;
  const rowSpan = clamp(gridRows, MIN_ROW_SPAN, limits.rows);
  return {
    colCenter,
    colSpan,
    rowCenter: gridRows / 2,
    rowSpan,
    followTime: true,
    followPrice: 'fit',
  };
}

/** Snap the right edge to the newest column, keeping the current spans and the
 *  price-follow mode. Time follow ON. */
export function follow(s: CameraState, range: ResidentRange): CameraState {
  const rightEdge = range.newest + 1;
  return { ...s, colCenter: rightEdge - s.colSpan / 2, followTime: true };
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

/** Fractional absolute grid coordinate under a viewport point (crosshair). */
export interface GridPoint {
  /** Fractional absolute column (floor → the col_seq the shader painted). */
  colf: number;
  /** Fractional absolute row (floor → the row index; row 0 = bottom of grid). */
  rowf: number;
}

/**
 * Inverse of the view transform (screen → grid), the crosshair's reverse of the
 * shader's `col = colOffset + colScale·uv.x`, `row = rowOffset + rowScale·uv.y`.
 * `uvX`/`uvY` are normalized viewport coordinates in [0,1] with **uvY measured
 * from the BOTTOM** (uv.y = 0 at the bottom of the price grid, matching the
 * shader and the gesture code's `uvY = 1 - cursorY/cssH`). Pure + testable — the
 * exact algebraic inverse of {@link toView}, so mapping a cursor back through it
 * lands on the same cell the fragment shader filled at that pixel.
 */
export function viewToGrid(view: HeatmapView, uvX: number, uvY: number): GridPoint {
  return {
    colf: view.colOffset + view.colScale * uvX,
    rowf: view.rowOffset + view.rowScale * uvY,
  };
}

/**
 * Screen→grid straight from CSS pixels on the canvas. `cssX` grows right, `cssY`
 * grows DOWN (DOM convention); this flips y to the shader's bottom-up uv before
 * delegating to {@link viewToGrid}. Points outside the canvas simply extrapolate
 * (the caller decides whether the result is in the resident range).
 */
export function screenToGrid(
  view: HeatmapView,
  cssX: number,
  cssY: number,
  cssW: number,
  cssH: number,
): GridPoint {
  const w = cssW > 0 ? cssW : 1;
  const h = cssH > 0 ? cssH : 1;
  return viewToGrid(view, cssX / w, 1 - cssY / h);
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

  /** Whether the TIME axis is auto-tracking the live right edge. */
  get followTime(): boolean {
    return this.state.followTime;
  }

  /** How the PRICE axis is auto-scaling. */
  get followPrice(): PriceFollow {
    return this.state.followPrice;
  }

  setLimits(limits: CameraLimits): void {
    this.limits = limits;
    // Re-clamp so a shrunk grid can't leave the view out of bounds.
    this.state = clampCamera(this.state, limits);
  }

  pan(dCols: number, dRows: number, kill: FollowKill = KILL_BOTH): void {
    this.state = pan(this.state, this.limits, dCols, dRows, kill);
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

  /** Time half of the auto-follow frame: left column + span. Keeps follow ON. */
  setTimeFrame(colLeft: number, colSpan: number): void {
    this.state = clampCamera(
      { ...this.state, colCenter: colLeft + colSpan / 2, colSpan, followTime: true },
      this.limits,
    );
  }

  /** Price half of the auto-fit frame: bottom row + span. Leaves the follow
   *  mode alone (the caller only reaches here while it is 'fit'). */
  setPriceFrame(rowBottom: number, rowSpan: number): void {
    this.state = clampCamera(
      { ...this.state, rowCenter: rowBottom + rowSpan / 2, rowSpan },
      this.limits,
    );
  }

  /** Recentre price without touching the span (the 'track' glide). */
  setRowCenter(rowCenter: number): void {
    this.state = clampCamera({ ...this.state, rowCenter }, this.limits);
  }

  /** Re-express the price axis in a new epoch's row coordinates (p0 moved). */
  remapPrice(rowCenter: number, rowSpan: number): void {
    this.state = clampCamera({ ...this.state, rowCenter, rowSpan }, this.limits);
  }

  /** Turn TIME follow on/off. Off routes through {@link applyKill}, so a 'fit'
   *  price axis is promoted to 'track' rather than losing the fitted span. */
  setFollowTime(on: boolean): void {
    this.state = on
      ? { ...this.state, followTime: true }
      : applyKill(this.state, KILL_TIME);
  }

  /** Set the PRICE follow mode directly (chip click, `P`, gutter double-click). */
  setPriceFollow(mode: PriceFollow): void {
    this.state = { ...this.state, followPrice: mode };
  }

  /**
   * Set the whole follow frame from edge form (renderer's per-column auto-follow):
   * left column, time span, bottom row, price span. Keeps time follow ON.
   */
  setFollowFrame(colLeft: number, colSpan: number, rowBottom: number, rowSpan: number): void {
    this.setTimeFrame(colLeft, colSpan);
    this.setPriceFrame(rowBottom, rowSpan);
  }

  toView(): HeatmapView {
    return toView(this.state);
  }
}
