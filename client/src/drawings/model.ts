/**
 * Pure model operations over finished {@link Drawing}s (campaign 3, lane CF —
 * ported from the old branch's drawings/model-ish helpers: fib.ts, store's
 * withPoints/translate, bbox.ts). No canvas, no storage, no React: every
 * function is (data in) → (new data out) and rebuilds drawings rather than
 * splicing their anchor tuples in place, so each member's arity stays part of
 * its type (see types.ts) and reference-changed outputs mean "this moved" for
 * cheap store selectors.
 */

import {
  clampWidth,
  POINTS_PER_TOOL,
  type ChartPoint,
  type Drawing,
  type DrawingTool,
  type DrawStyle,
} from './types';

/**
 * Fibonacci retracement levels between two data-space anchors — the classic
 * ratio set traders expect from every charting package.
 *
 * Level semantics: 0 anchors at p1.price (the retracement END), 1 at p0.price
 * (the origin), so an up-move drawn p0→p1 shows its pullback targets between
 * them as positive fractions of the move. 0.5 rides along even though it is
 * not a Fib ratio — traders expect it on every platform, and omitting it would
 * read as a bug rather than purity. 0.786 is √0.618.
 */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

/** Price of one level: 0 → p1.price, 1 → p0.price, linear in between. */
export function fibPriceAt(level: number, p0: ChartPoint, p1: ChartPoint): number {
  return p1.price + (p0.price - p1.price) * level;
}

/** The [from, to] time span a fib (or rect) band covers, ascending. */
export function timeSpan(a: ChartPoint, b: ChartPoint): { from: bigint; to: bigint } {
  return a.tNs <= b.tNs ? { from: a.tNs, to: b.tNs } : { from: b.tNs, to: a.tNs };
}

/**
 * Assemble a finished drawing with the exact tuple its tool promises. Every
 * call site passes arity-complete points (the draft controller guarantees it
 * via POINTS_PER_TOOL); a defensive length check keeps a caller bug from
 * writing a drawing the painter cannot index.
 */
export function createDrawing(
  tool: DrawingTool,
  points: readonly ChartPoint[],
  style: DrawStyle,
  id: string,
  createdAt: number,
): Drawing | null {
  if (points.length !== POINTS_PER_TOOL[tool]) return null;
  const norm: DrawStyle = { color: style.color, width: clampWidth(style.width) };
  const base = { id, createdAt, style: norm };
  const p = points;
  switch (tool) {
    case 'hline':
    case 'hray':
      return { ...base, tool, points: [p[0]] };
    case 'text':
      return { ...base, tool, points: [p[0]], text: '' };
    case 'trendline':
    case 'rect':
    case 'fib':
      return { ...base, tool, points: [p[0], p[1]] };
  }
}

/**
 * Rebuild `d` against a fresh anchor list, preserving identity (id / tool /
 * createdAt / style) AND the text payload. Exhaustive over DrawingTool, so
 * adding a tool breaks compile here until its arity is handled. Callers must
 * pass exactly POINTS_PER_TOOL[tool] anchors (asserted by construction in the
 * store, which only ever maps in place).
 */
export function withPoints(d: Drawing, points: readonly ChartPoint[]): Drawing {
  switch (d.tool) {
    case 'hline':
    case 'hray':
      return { ...d, points: [points[0]] };
    case 'text':
      return { ...d, points: [points[0]], text: d.text };
    case 'trendline':
    case 'rect':
    case 'fib':
      return { ...d, points: [points[0], points[1]] };
  }
}

/** Move ONE anchor of a drawing; an out-of-range index is a no-op. */
export function movePoint(d: Drawing, index: number, p: ChartPoint): Drawing {
  if (!Number.isInteger(index) || index < 0 || index >= d.points.length) return d;
  return withPoints(d, d.points.map((q, i) => (i === index ? p : q)));
}

/** Shift every anchor of a drawing by a data-space delta (dt ns, dprice). */
export function translateDrawing(d: Drawing, dtNs: bigint, dPrice: number): Drawing {
  if (dtNs === 0n && dPrice === 0) return d;
  return withPoints(
    d,
    d.points.map((q) => ({ tNs: q.tNs + dtNs, price: q.price + dPrice })),
  );
}

/** Return `d` with a clamped style patch applied (identity-safe). */
export function restyleDrawing(d: Drawing, patch: Partial<DrawStyle>): Drawing {
  const style: DrawStyle = {
    color: patch.color ?? d.style.color,
    width: clampWidth(patch.width ?? d.style.width),
  };
  if (style.color === d.style.color && style.width === d.style.width) return d;
  return { ...d, style };
}

/** A drawing's data-space bounding box: (minT, maxT, minP, maxP). */
export function drawingBounds(d: Drawing): {
  tMin: bigint;
  tMax: bigint;
  pMin: number;
  pMax: number;
} {
  let tMin = d.points[0].tNs;
  let tMax = d.points[0].tNs;
  let pMin = d.points[0].price;
  let pMax = d.points[0].price;
  for (let i = 1; i < d.points.length; i += 1) {
    const p = d.points[i];
    if (p.tNs < tMin) tMin = p.tNs;
    if (p.tNs > tMax) tMax = p.tNs;
    if (p.price < pMin) pMin = p.price;
    if (p.price > pMax) pMax = p.price;
  }
  return { tMin, tMax, pMin, pMax };
}
