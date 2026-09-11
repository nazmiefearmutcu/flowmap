/**
 * Chart-drawing types (campaign 3, lane CF — ported from the old branch's
 * drawings/types.ts, re-anchored).
 *
 * WHY DATA-SPACE ANCHORS (time-ns + price), NEVER PIXELS
 * An anchor stored in pixels dies three ways at once: pan once and the line no
 * longer passes through what it was drawn ABOUT; zoom and it stretches with the
 * viewport instead of the market; reload (or replay to another clock) and it
 * points at whatever happens to be on screen then. So anchors live in the two
 * coordinates that survive every camera:
 *   - `tNs`   — absolute event time in epoch nanoseconds. Column affines move
 *              (history pages in, epochs re-anchor) but a wall's timestamp does
 *              not, so a drawing pinned to it rides the SAME market event under
 *              pan / zoom / replay seek alike;
 *   - `price` — grid-independent, and safe under a hybrid non-uniform row scale
 *              too, because the painter goes through the injected projection's
 *              price mapping rather than assuming linear rows.
 * The cost is paid once in the render path: anchors are mapped through the
 * CURRENT projection every frame — cached pixels would quietly reintroduce the
 * bug above (see drawings/painter.ts).
 *
 * TUPLE ARITY AS TYPES: each concrete drawing narrows `points` to an exact
 * readonly tuple, so a finished drawing hands renderers index-safe endpoints
 * with zero length checks. A HALF-DRAWN shape (second anchor still chasing the
 * cursor) is deliberately NOT a member of {@link Drawing} at all — the type
 * system cannot watch mouse events, so {@link isComplete} polices that
 * boundary at runtime instead.
 */

/**
 * Every drawing tool the toolbar offers. Persisted verbatim in DrawingsDoc.
 * Six pro-charting staples: two-point lines/boxes, the level + ray family, the
 * fib retracement ladder, and the text label.
 */
export type DrawingTool = 'trendline' | 'hline' | 'hray' | 'rect' | 'fib' | 'text';

/**
 * One data-space anchor: absolute event time (nanoseconds, bigint — epoch times
 * exceed 2^53) and a raw price. Never pixels, never rows: rows renumber when
 * the epoch re-centres, pixels renumber every frame.
 */
export interface ChartPoint {
  tNs: bigint;
  price: number;
}

/** Per-drawing stroke style. Colors are user-chosen hex; width in CSS px. */
export interface DrawStyle {
  color: string;
  width: number;
}

/** Fields every drawing shares. `points` is widest here; subtypes narrow it. */
export interface DrawingBase {
  /** Opaque unique id; stable across saves. */
  id: string;
  /** Discriminant — every consumer switches on this. */
  tool: DrawingTool;
  /**
   * Data-space anchors, in placement order. Readonly because the arity is part
   * of each member's type: letting callers push/splice would silently un-type
   * every tuple in the union.
   */
  readonly points: readonly ChartPoint[];
  /** Placement start, ms epoch — undo/ordering bookkeeping, never rendered. */
  createdAt: number;
  /** Stroke style (color + width), chosen from the toolbar swatches. */
  style: DrawStyle;
}

/** Two anchors joined by a finite segment. */
export interface TrendlineDrawing extends DrawingBase {
  tool: 'trendline';
  readonly points: readonly [ChartPoint, ChartPoint];
}

/** One anchor; infinite horizontal line at `points[0].price`. Time is ignored. */
export interface HLineDrawing extends DrawingBase {
  tool: 'hline';
  readonly points: readonly [ChartPoint];
}

/**
 * One anchor; a horizontal ray that starts at `points[0]` and extends RIGHT
 * (forward in time) forever — "the level holds from here on".
 */
export interface HRayDrawing extends DrawingBase {
  tool: 'hray';
  readonly points: readonly [ChartPoint];
}

/** Two anchors as opposite corners; edges stay axis-aligned. */
export interface RectDrawing extends DrawingBase {
  tool: 'rect';
  readonly points: readonly [ChartPoint, ChartPoint];
}

/** Two anchors define level 0 and 100%; the ratio ladder is a painter concern. */
export interface FibDrawing extends DrawingBase {
  tool: 'fib';
  readonly points: readonly [ChartPoint, ChartPoint];
}

/** One anchor placing the text caret; the label itself is `text`. */
export interface TextDrawing extends DrawingBase {
  tool: 'text';
  readonly points: readonly [ChartPoint];
  /** The label. Empty string renders nothing — the honest "not typed yet". */
  text: string;
}

/** Any finished drawing. Narrow on `tool`, or via {@link isDrawingTool}. */
export type Drawing =
  | TrendlineDrawing
  | HLineDrawing
  | HRayDrawing
  | RectDrawing
  | FibDrawing
  | TextDrawing;

/**
 * The persisted/session document. `version` is a LITERAL so old payloads fail
 * to typecheck loudly when the shape ever evolves, instead of silently
 * decoding into today's assumptions.
 */
export interface DrawingsDoc {
  version: 1;
  drawings: Drawing[];
}

/**
 * Anchor count each tool needs before it may enter the document. One map, not
 * per-tool constants, because the placement controller asks "how many clicks
 * left?" generically while placing ANY tool — and an exhaustive Record turns
 * "added a tool, forgot its arity" into a compile error here rather than a
 * runtime drawing that never completes.
 */
export const POINTS_PER_TOOL: Readonly<Record<DrawingTool, number>> = {
  trendline: 2,
  hline: 1,
  hray: 1,
  rect: 2,
  fib: 2,
  text: 1,
};

/**
 * Whether `d` carries its full arity and may be promoted from the in-progress
 * draft into the persisted document. The single source of truth for that
 * boundary — renderers may assume every Drawing they receive satisfies it.
 */
export function isComplete(d: Drawing): boolean {
  return d.points.length === POINTS_PER_TOOL[d.tool];
}

/** Is `value` one of the known tools (e.g. when reloading a saved doc)? */
export function isDrawingTool(value: unknown): value is DrawingTool {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(POINTS_PER_TOOL, value)
  );
}

/** Stroke-width bounds the width stepper clamps to (CSS px). */
export const MIN_WIDTH = 1;
export const MAX_WIDTH = 6;

/** The default new-drawing style: the theme's teal accent, hairline weight. */
export const DEFAULT_STYLE: DrawStyle = { color: '#33d6c4', width: 2 };

/** Clamp a stroke width into {@link MIN_WIDTH}..{@link MAX_WIDTH}. */
export function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return DEFAULT_STYLE.width;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));
}
