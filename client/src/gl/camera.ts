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
 * any row outside `[0, rows)`. `rowSpan` tops out at the USER zoom-out cap
 * `maxRowSpanZoom`, which is now the GRID HEIGHT: "the whole market in one
 * view" is exactly the full band, and zooming further only added black margins
 * plus a sub-sampled mip image (owner-reported "dashed rows" past ~16
 * rows/pixel where level 2 ran out of footprint coverage). Panning past the
 * band stays allowed; zooming past it does not. See {@link limitsFor}.
 *
 * **Time bounds.** The TIME axis is bounded by the KNOWN DATA window the
 * renderer keeps in {@link CameraLimits.timeWindow}: `colOffset` is clamped so
 * the view cannot leave the history ends by more than one small overscroll band
 * ({@link COL_OVERSCROLL}, also capped at one viewport), and the manual
 * zoom-out cap is halved-to-`resident.count` scale ({@link maxColSpanFor}) so
 * the resident field can never be squeezed sub-pixel blank. Both are OPT-IN:
 * a limits object without a `timeWindow` behaves exactly like the legacy free
 * camera (all the pure-math tests), and the renderer refreshes the window via
 * {@link Camera.setTimeWindow} without re-clamping a state the e2e harness
 * installed directly.
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
  /**
   * Rows across the viewport (price zoom). Clamped to
   * [MIN_ROW_SPAN, maxRowSpanZoom] for USER zoom; programmatic frames
   * (fit/reset/setPriceFrame) are deliberately locked to the grid height.
   */
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

/**
 * The client's KNOWN time data window. One object so the pan bound and the
 * zoom-out floor always agree on what "the data" is. The renderer refreshes it
 * on every view update ({@link Camera.setTimeWindow}); pure unit limits simply
 * omit it (legacy free-camera behavior — pinned by camera.test.ts).
 */
export interface TimeWindow {
  /** Oldest absolute col_seq data can exist at (start of history). Defaults to
   *  {@link COL_SEQ_FLOOR}; the backfill loader treats col_seq 0 as the start of
   *  the stream (net/history.ts). */
  floor?: number;
  /** Newest absolute col_seq the client has SEEN (the live edge), inclusive.
   *  −1 before the first column. */
  newest: number;
  /** Full-res resident window — the zoom-out visibility floor. Null before the
   *  first column. */
  resident: ResidentRange | null;
}

/** Bounds the clamps enforce (from the tile ring geometry). */
export interface CameraLimits {
  /** Price grid height — caps the FRAMING span (fit/reset) and bounds
   *  rowCenter. Deliberately NOT the user zoom-out cap: see
   *  {@link maxRowSpanZoom}. */
  rows: number;
  /** Smallest time span — "can't zoom past 1 col". */
  minColSpan: number;
  /**
   * FRAMING cap — the widest span auto-fit / go-live / reset will FRAME to. Kept
   * at the ring's full-res capacity so a programmatic reframe never asks for more
   * columns than are GPU-resident.
   */
  maxColSpan: number;
  /**
   * USER ZOOM-OUT cap — how far a manual time-zoom gesture may widen the span.
   * Deliberately MUCH larger than {@link maxColSpan} (and the ring), so scrolling
   * the wheel out never hits an artificial wall: past the resident window the
   * shader simply paints background / SUM-mips, and the history backfill fills it
   * in. Decoupling this from the ring capacity costs no GPU memory (it is only a
   * clamp bound, not an allocation). NOTE: when {@link timeWindow} is known this
   * is reduced by {@link maxColSpanFor} so the resident field never squeezes
   * sub-pixel (the M3 max-zoom-out blank).
   */
  maxColSpanZoom: number;
  /**
   * USER ZOOM-OUT cap — how far a manual PRICE zoom gesture may widen the span.
   * The price-axis twin of {@link maxColSpanZoom}, so README's "price and time
   * both zoom out far past the grid" is true: past the grid the shader paints
   * background, so the only thing a larger span reveals is more background.
   * Also only a clamp bound, never an allocation. Framing stays locked to
   * {@link rows} — see {@link fit} / {@link reset}.
   */
  maxRowSpanZoom: number;
  /**
   * Known TIME data window (see {@link TimeWindow}). When present:
   *  - the pan clamp bounds `colOffset` to `[floor − slack, newest + 1 + slack −
   *    colSpan]` with `slack = min(colSpan, COL_OVERSCROLL)`, so the view can
   *    overscroll past the ends of history by at most one small band — a bounded
   *    edge with the oldest data still on screen, never the unbounded col_seq
   *    void the QA3 probe measured (`colOffset −92 129` / `−192 129` at
   *    `oldest 0`, 0.31 % painted);
   *  - the zoom-out cap becomes the full-res resident window over
   *    {@link MIN_RESIDENT_COVERAGE} of the viewport, so a wheel-out can never
   *    squeeze the resident field under half the screen (M3 H-1: 60 notches →
   *    colScale 1 048 576 with 2 717 resident columns → 0/420 probes painted).
   * Omitted (undefined) on bare unit limits and before the first column.
   */
  timeWindow?: TimeWindow | null;
}

/** Absolute col_seq the stream starts at — the pan clamp's hard floor (the
 *  backfill loader's start-of-history contract, net/history.ts). */
export const COL_SEQ_FLOOR = 0;

/**
 * How much of the viewport the full-res resident window must still cover at the
 * widest manual time zoom-out. 0.5 = "you can always zoom out until the
 * resident data fills half the screen"; below that the columns squeeze to
 * sub-pixel and the field reads blank (M3 H-1).
 */
export const MIN_RESIDENT_COVERAGE = 0.5;

/**
 * How far past either end of the known history a pan may overscroll, in
 * columns (also capped at one viewport — `min(colSpan, COL_OVERSCROLL)`). A
 * bounded band instead of an infinite void: at the far limit the oldest/newest
 * columns sit at the viewport edge, so the user sees where history ends.
 */
export const COL_OVERSCROLL = 64;

/** Smallest time span in columns (one column fills the whole viewport). */
export const MIN_COL_SPAN = 1;
/** Smallest price span in rows (one price level fills the whole viewport). */
export const MIN_ROW_SPAN = 1;
/**
 * Absolute ceiling on the USER time zoom-out (columns across the viewport).
 * ~1.05M columns is effectively "infinite" for an order-flow chart (days-to-
 * months of history in one view depending on the epoch cadence) while staying
 * well inside f32's exact-integer range (2^24), so column indices and the
 * colScale uniform never lose precision.
 */
export const MAX_COL_SPAN = 1_048_576;
/**
 * The USER price zoom-out cap (rows across the viewport) is the GRID HEIGHT —
 * see {@link limitsFor}. There is deliberately no larger constant: zooming out
 * past the full band only produced black margins and a sub-sampled mip image
 * (dashed price rows), so the cap and the framing height coincide. Panning
 * (overscroll) still lets the user push the band off screen.
 */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Build limits from the ring geometry: rows tall, up to `capacityCols` wide. */
export function limitsFor(rows: number, capacityCols: number): CameraLimits {
  const framing = Math.max(MIN_COL_SPAN, capacityCols);
  return {
    rows,
    minColSpan: MIN_COL_SPAN,
    // Framing (auto-fit / reset) never exceeds the full-res ring.
    maxColSpan: framing,
    // Manual zoom-out may go far past the ring — no wall.
    maxColSpanZoom: Math.max(framing, MAX_COL_SPAN),
    // Manual price zoom-out stops at the full band: past it the view is black
    // margins + a sub-sampled mip (the owner-reported dashed-rows artifact).
    maxRowSpanZoom: rows,
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
 * The EFFECTIVE user time zoom-out cap for these limits. Without a known
 * {@link TimeWindow} this is {@link CameraLimits.maxColSpanZoom} (the legacy
 * "no wall" behavior pinned by the pre-resident unit tests). With one, it is
 * the full-res resident window divided by {@link MIN_RESIDENT_COVERAGE}: at the
 * widest allowed zoom the resident columns still cover at least half the
 * viewport, so they can never be squeezed into the sub-pixel blank the M3
 * repro captured (2 717 resident columns under a 1 048 576-column span).
 *
 * The span cap is `count / coverage` — e.g. 2× the resident count at 0.5 — so
 * it grows with residency: deep scroll-back that loads more history widens
 * what you may zoom out to, automatically.
 */
export function maxColSpanFor(limits: CameraLimits): number {
  const resident = limits.timeWindow?.resident ?? null;
  if (resident === null) return limits.maxColSpanZoom;
  const count = Math.max(1, resident.count);
  return clamp(count / MIN_RESIDENT_COVERAGE, limits.minColSpan, limits.maxColSpanZoom);
}

/**
 * The band `colCenter` may roam in so the TIME view always keeps known history
 * on screen: the view's LEFT edge is bounded to
 * `[floor − slack, newest + 1 + slack − colSpan]` with
 * `slack = min(colSpan, COL_OVERSCROLL)` — at either limit the oldest/newest
 * data touches the viewport edge (the "start of history" cue QA3 asked for),
 * with at most one small overscroll band past it. Returns null when there is no
 * {@link TimeWindow} (unbounded, the legacy behavior) or before the first
 * column (`newest < floor`).
 *
 * When the view is wider than the whole extent plus both overscroll bands the
 * band collapses; the centre is then returned as a single point — the extent
 * centred in the viewport — the continuous limit of the shrinking band.
 */
export function colCenterBounds(
  colSpan: number,
  limits: CameraLimits,
): { lo: number; hi: number } | null {
  const tw = limits.timeWindow;
  if (tw === null || tw === undefined) return null;
  const floor = tw.floor ?? COL_SEQ_FLOOR;
  if (!(tw.newest >= floor) || !Number.isFinite(colSpan)) return null;
  const slack = Math.min(colSpan, COL_OVERSCROLL);
  const loLeft = floor - slack;
  const hiLeft = tw.newest + 1 + slack - colSpan;
  if (loLeft <= hiLeft) {
    return { lo: loLeft + colSpan / 2, hi: hiLeft + colSpan / 2 };
  }
  const centered = (floor + tw.newest + 1) / 2;
  return { lo: centered, hi: centered };
}

/**
 * Enforce the clamps on a candidate state:
 *   - colSpan  ∈ [minColSpan, maxColSpanFor]        (time zoom limits)
 *   - rowSpan  ∈ [MIN_ROW_SPAN, maxRowSpanZoom]     (price zoom limits)
 *   - rowCenter ∈ rowCenterBounds(rowSpan)         (price overscroll band)
 *   - colCenter ∈ colCenterBounds(colSpan)         (time overscroll band, when
 *                                                   the known data window is
 *                                                   present — see TimeWindow)
 * `rowSpan` is clamped FIRST so the two price clamps compose deterministically
 * (the centre band is derived from the FINAL span, never a pre-clamp one).
 * Without a {@link TimeWindow} `colCenter` stays unclamped — panning freely
 * through all of history is the legacy point, and it stays O(1).
 */
export function clampCamera(s: CameraState, limits: CameraLimits): CameraState {
  // USER zoom-out bound, not the framing bound: a state produced by fit/reset/
  // setPriceFrame is already ≤ rows ≤ maxRowSpanZoom, so this never shrinks a
  // framed span. (The colSpan branch below is the same decoupling for time.)
  const rowSpan = clamp(s.rowSpan, MIN_ROW_SPAN, limits.maxRowSpanZoom);
  const bounds = rowCenterBounds(rowSpan, limits);
  // Zoom-out bound, not the framing bound: a state produced by fit/reset is
  // already ≤ maxColSpan ≤ maxColSpanFor, so this never shrinks a framed span.
  const colSpan = clamp(s.colSpan, limits.minColSpan, maxColSpanFor(limits));
  const cb = colCenterBounds(colSpan, limits);
  const colCenter =
    cb !== null && Number.isFinite(s.colCenter) ? clamp(s.colCenter, cb.lo, cb.hi) : s.colCenter;
  return {
    colCenter,
    colSpan,
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
  // A non-finite delta (a pathological pointer/wheel event) would poison the
  // camera permanently — NaN survives every clamp because both clamp branches
  // compare false. Ignore the whole gesture instead.
  if (!Number.isFinite(dCols) || !Number.isFinite(dRows)) return s;
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
 * the span clamps. The span clamps against {@link maxColSpanFor} (the
 * resident-aware cap) BEFORE the anchor math so the zoom-out floor does not
 * re-shrink the span afterwards and break the anchoring; the remaining
 * colCenter bound from {@link colCenterBounds} is inherent, exactly like the
 * price overscroll bounds.
 */
export function zoomTime(
  s: CameraState,
  limits: CameraLimits,
  factor: number,
  anchorCol: number,
): CameraState {
  // NaN/0/negative factors and non-finite anchors would survive the span clamp
  // (NaN fails both comparisons) and poison colCenter via the anchor math.
  // Leave the state — including its follow flags — exactly as it was.
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(anchorCol)) return s;
  const newSpan = clamp(s.colSpan * factor, limits.minColSpan, maxColSpanFor(limits));
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
 * Zoom-out runs to `maxRowSpanZoom`, which equals the grid height — the full
 * band is the widest meaningful view (see {@link limitsFor}).
 */
export function zoomPrice(
  s: CameraState,
  limits: CameraLimits,
  factor: number,
  anchorRow: number,
): CameraState {
  // Same NaN/0/negative guard as zoomTime — poison-proof by construction.
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(anchorRow)) return s;
  const newSpan = clamp(s.rowSpan * factor, MIN_ROW_SPAN, limits.maxRowSpanZoom);
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
  // FRAMING lock: fit shows the whole grid (never more), regardless of how far
  // the user zoomed out before — maxRowSpanZoom is a USER gesture cap only.
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
 * on. This is the session-boot / ring-recreation frame: the renderer calls it
 * whenever a new grid is created (createRing / resetForSession). The Go-Live
 * (`R`) ACTION does NOT route here — it uses {@link follow}, so re-arming the
 * live edge keeps the user's price zoom and price-follow mode. When a range is
 * given the view is immediately correct; the renderer's per-column follow
 * reframes the span to the canvas next.
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

  /**
   * Refresh the known TIME data window (see {@link TimeWindow}). Called by the
   * renderer on every view update; only affects the NEXT gesture/gated frame.
   *
   * Deliberately does NOT re-clamp the current state: an existing view is a
   * product of a legal op, and re-clamping here would mutate states the e2e
   * harness installs directly through `setViewForTest` / `setView` (a wide
   * synthetic framing the gl4 mip spec depends on) or a scrollback frame that
   * the resident window is still growing under. The clamps apply to the ops,
   * which is where a user gesture can actually leave the data.
   */
  setTimeWindow(window: TimeWindow | null): void {
    this.limits = { ...this.limits, timeWindow: window };
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
   *  mode alone (the caller only reaches here while it is 'fit'). FRAMING
   *  lock: the renderer's auto-fit path frames to the GRID, never past it —
   *  maxRowSpanZoom is a user-gesture cap only, so it is not applied here
   *  (fit/reset share the same rows lock). */
  setPriceFrame(rowBottom: number, rowSpan: number): void {
    const span = clamp(rowSpan, MIN_ROW_SPAN, this.limits.rows);
    this.state = clampCamera(
      { ...this.state, rowCenter: rowBottom + span / 2, rowSpan: span },
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
