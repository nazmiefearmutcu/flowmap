/**
 * Canvas2D painter + hit-testing for chart drawings (campaign 3, lane CF —
 * ported from the old branch's drawings/painter.ts + hitTest.ts, re-anchored
 * from (col, price) chart space to (time-ns, price) data space).
 *
 * This module owns GEOMETRY only and is PURE with respect to the DOM: every
 * function takes an injected {@link DrawProjection} (data space ⇄ CSS px —
 * built by DrawingLayer from the ChartMapPair + the epoch affines) and a plain
 * 2D context. Anchors are mapped through the projection EVERY frame — caching
 * pixels would reintroduce the pan/zoom bug described in types.ts.
 *
 * Hot-loop hygiene: the per-frame paths are plain for-loops over scalars —
 * no intermediate arrays, no closures per drawing (the fib ladder reads the
 * frozen FIB_LEVELS tuple; hit-testing returns ONE best hit, never a list).
 * Each entry point wraps its work in save/restore so callers compose layers
 * without style leaks.
 */

import { FIB_LEVELS, fibPriceAt, timeSpan } from './model';
import type { ChartPoint, Drawing } from './types';

/** Anchor-handle square, CSS px (pro charting-style endpoint knob). */
export const HANDLE_SIZE = 7;
/** Select/hover tolerance in CSS px (hit-testing is forgiving, handles first). */
export const HIT_TOLERANCE_PX = 6;

/** Data space ⇄ CSS px. Built once per frame by DrawingLayer. */
export interface DrawProjection {
  /** Data time (ns) → CSS x. */
  xAt(tNs: bigint): number;
  /** Price → CSS y (y-DOWN; the projection owns the flip). */
  yAt(price: number): number;
  /** CSS x → data time, or null when the time affine is unknown. */
  tNsAt(x: number): bigint | null;
  /** CSS y → price, or null when the price affine is unknown. */
  priceAt(y: number): number | null;
}

/** What a hit landed on: a draggable handle (anchor) or the shape's body. */
export interface DrawingHit {
  id: string;
  kind: 'handle' | 'body';
  /** Anchor index when kind === 'handle'. */
  handle: number;
}

/** Distance from (px,py) to segment (ax,ay)-(bx,by), CSS px. */
export function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Squared-distance shortcut used where only comparisons matter. */
function within(x1: number, y1: number, x2: number, y2: number, tol: number): boolean {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy <= tol * tol;
}

/** Level ratio → tidy percentage label ('0.618' → '61.8'); kills float dust. */
export function fmtLevelPct(level: number): string {
  return `${Math.round(level * 1000) / 10}%`;
}

/** Compact price for the hline tag: integers bare, else precision by magnitude. */
export function fmtPriceTag(price: number): string {
  if (Number.isInteger(price)) return String(price);
  const abs = Math.abs(price);
  return price.toFixed(abs >= 100 ? 1 : abs >= 1 ? 2 : 5);
}

// --- hit-testing (pure; unit-tested with fixed projections) ---------------------

/**
 * Hit-test ONE drawing at CSS-px (x, y). Handles (anchor knobs) win first —
 * they are the resize affordance — then the shape's body. `tol` is CSS px
 * (default {@link HIT_TOLERANCE_PX}). Null when nothing is touched.
 */
export function hitTestDrawing(
  d: Drawing,
  x: number,
  y: number,
  proj: DrawProjection,
  tol: number = HIT_TOLERANCE_PX,
): DrawingHit | null {
  // Handles first (topmost affordance), checked back-to-front so the LAST
  // anchor wins a tie — it is the one the eye grabs.
  for (let i = d.points.length - 1; i >= 0; i -= 1) {
    const p = d.points[i];
    if (within(x, y, proj.xAt(p.tNs), proj.yAt(p.price), tol + HANDLE_SIZE / 2)) {
      return { id: d.id, kind: 'handle', handle: i };
    }
  }
  switch (d.tool) {
    case 'trendline': {
      const a = d.points[0];
      const b = d.points[1];
      const dist = distanceToSegment(
        x,
        y,
        proj.xAt(a.tNs),
        proj.yAt(a.price),
        proj.xAt(b.tNs),
        proj.yAt(b.price),
      );
      return dist <= tol ? { id: d.id, kind: 'body', handle: -1 } : null;
    }
    case 'hline': {
      const dy = Math.abs(y - proj.yAt(d.points[0].price));
      return dy <= tol ? { id: d.id, kind: 'body', handle: -1 } : null;
    }
    case 'hray': {
      // Horizontal ray: exact level from the anchor's x RIGHTWARD forever.
      const x0 = proj.xAt(d.points[0].tNs);
      if (x < x0 - tol) return null;
      const dy = Math.abs(y - proj.yAt(d.points[0].price));
      return dy <= tol ? { id: d.id, kind: 'body', handle: -1 } : null;
    }
    case 'rect': {
      const a = d.points[0];
      const b = d.points[1];
      const x0 = proj.xAt(a.tNs);
      const x1 = proj.xAt(b.tNs);
      const y0 = proj.yAt(a.price);
      const y1 = proj.yAt(b.price);
      const lox = Math.min(x0, x1);
      const hix = Math.max(x0, x1);
      const loy = Math.min(y0, y1);
      const hiy = Math.max(y0, y1);
      if (x < lox - tol || x > hix + tol || y < loy - tol || y > hiy + tol) return null;
      // Inside the rect (or on an edge within tol) is a body hit — the whole
      // wash is draggable, which is how these tools feel in every package.
      return { id: d.id, kind: 'body', handle: -1 };
    }
    case 'fib': {
      const [a, b] = d.points;
      const span = timeSpan(a, b);
      const xa = proj.xAt(span.from);
      const xb = proj.xAt(span.to);
      const lox = Math.min(xa, xb) - tol;
      const hix = Math.max(xa, xb) + tol;
      if (x < lox || x > hix) return null;
      // Any of the seven level lines within tol vertically is a body hit.
      for (let i = 0; i < FIB_LEVELS.length; i += 1) {
        const price = fibPriceAt(FIB_LEVELS[i], a, b);
        const dy = Math.abs(y - proj.yAt(price));
        if (dy <= tol) return { id: d.id, kind: 'body', handle: -1 };
      }
      return null;
    }
    case 'text': {
      const p = d.points[0];
      // A generous label-sized box, not a hairline: labels are the fattest
      // target on the chart because they carry no stroke.
      const px = proj.xAt(p.tNs);
      const py = proj.yAt(p.price);
      const pad = tol + 8;
      return within(x, y, px + pad / 2, py - pad / 2, pad)
        ? { id: d.id, kind: 'body', handle: -1 }
        : null;
    }
  }
}

/**
 * Hit-test ALL drawings TOP-DOWN (end of `items` = topmost paint order wins).
 * Single best hit or null — the hot path never materializes a list.
 */
export function hitTestDrawings(
  items: readonly Drawing[],
  x: number,
  y: number,
  proj: DrawProjection,
  tol: number = HIT_TOLERANCE_PX,
): DrawingHit | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const hit = hitTestDrawing(items[i], x, y, proj, tol);
    if (hit !== null) return hit;
  }
  return null;
}

// --- painting -------------------------------------------------------------------

/** One anchor handle: a filled square; `active` adds an accent ring. */
export function paintHandle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  active: boolean,
): void {
  const half = HANDLE_SIZE / 2;
  ctx.fillStyle = color;
  ctx.fillRect(x - half, y - half, HANDLE_SIZE, HANDLE_SIZE);
  if (active) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    const r = half + 2;
    ctx.strokeRect(x - r, y - r, 2 * r, 2 * r);
  }
}

/** A label font for canvas text (mirrors the axis text style). */
const LABEL_FONT = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const TEXT_FONT = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const TAG_PAD_X = 6;
const TAG_H = 16;
const TAG_MARGIN = 4;
const TAG_BG = 'rgba(5, 7, 9, 0.85)'; // --bg over the heatmap

export interface PaintOpts {
  /** CSS px extent of the drawing surface (for infinite lines + tags). */
  width: number;
  height: number;
  /** When it equals `d.id`, the shape's anchor handles are painted too. */
  selectedId?: string | null;
  /** Paint dashed + slightly transparent (the placement ghost). */
  draft?: boolean;
  /** Stroke color for the draft ghost + its handles (the pending style). */
  selectedColor?: string;
  /** Ghost stroke width (falls back to the default hairline). */
  draftWidth?: number;
}

/** Shared dash arrays — setLineDash copies, so these are never mutated. */
const SOLID_DASH: number[] = [];
const DASH_DASH: number[] = [4, 4];

/** Ghost-draft identity + fallback style (the pending drawing is ephemeral). */
const DRAFT_ID = '__draft__';
const DEFAULT_GHOST_COLOR = '#33d6c4';
const DEFAULT_GHOST_WIDTH = 2;

/**
 * Replay ONE finished drawing onto `ctx` in CSS px. Per tool: trendline
 * segment, hline full-width + right-edge price tag, hray from its anchor
 * rightward, rect wash + outline, the 7-level fib ladder with % labels, and
 * the text label. Selection adds one anchor handle per stored point. Dash
 * state is set/cleared per shape so no style leaks between drawings.
 */
export function paintDrawing(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  proj: DrawProjection,
  opts: PaintOpts,
): void {
  const { width } = opts;
  ctx.save();
  ctx.strokeStyle = d.style.color;
  ctx.fillStyle = d.style.color;
  ctx.lineWidth = d.style.width;
  ctx.setLineDash(opts.draft === true ? DASH_DASH : SOLID_DASH);
  if (opts.draft === true) ctx.globalAlpha = 0.7;
  const selected = opts.selectedId != null && d.id === opts.selectedId;

  switch (d.tool) {
    case 'trendline': {
      const a = d.points[0];
      const b = d.points[1];
      ctx.beginPath();
      ctx.moveTo(proj.xAt(a.tNs), proj.yAt(a.price));
      ctx.lineTo(proj.xAt(b.tNs), proj.yAt(b.price));
      ctx.stroke();
      break;
    }
    case 'hline': {
      const y = proj.yAt(d.points[0].price);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      // Right-edge price tag so the level is readable without tracing the line
      // to the axis.
      ctx.font = LABEL_FONT;
      const text = fmtPriceTag(d.points[0].price);
      const tagW = ctx.measureText(text).width + TAG_PAD_X * 2;
      ctx.fillStyle = TAG_BG;
      ctx.fillRect(width - TAG_MARGIN - tagW, y - TAG_H / 2, tagW, TAG_H);
      ctx.fillStyle = d.style.color;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, width - TAG_MARGIN - TAG_PAD_X, y);
      break;
    }
    case 'hray': {
      const p = d.points[0];
      const x0 = proj.xAt(p.tNs);
      const y = proj.yAt(p.price);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      // Origin knob so the ray's start is visible even off-selection.
      ctx.fillRect(x0 - 2, y - 2, 4, 4);
      break;
    }
    case 'rect': {
      const a = d.points[0];
      const b = d.points[1];
      const x0 = proj.xAt(a.tNs);
      const x1 = proj.xAt(b.tNs);
      const y0 = proj.yAt(a.price);
      const y1 = proj.yAt(b.price);
      const rx = Math.min(x0, x1);
      const ry = Math.min(y0, y1);
      ctx.globalAlpha = (opts.draft === true ? 0.5 : 1) * 0.12;
      ctx.fillRect(rx, ry, Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.globalAlpha = opts.draft === true ? 0.7 : 1;
      ctx.strokeRect(rx, ry, Math.abs(x1 - x0), Math.abs(y1 - y0));
      break;
    }
    case 'fib': {
      const [a, b] = d.points;
      const span = timeSpan(a, b);
      const xa = proj.xAt(span.from);
      const xb = proj.xAt(span.to);
      const labelX = Math.min(xa, xb);
      ctx.font = LABEL_FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      for (let i = 0; i < FIB_LEVELS.length; i += 1) {
        const level = FIB_LEVELS[i];
        const y = proj.yAt(fibPriceAt(level, a, b));
        // The 0% / 100% rails read stronger than the intermediate targets —
        // same convention as every mainstream charting package.
        ctx.globalAlpha = (opts.draft === true ? 0.7 : 1) * (level === 0 || level === 1 ? 1 : 0.75);
        ctx.beginPath();
        ctx.moveTo(xa, y);
        ctx.lineTo(xb, y);
        ctx.stroke();
        ctx.fillText(fmtLevelPct(level), labelX + 3, y - 2);
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'text': {
      if (d.text !== '') {
        const p = d.points[0];
        ctx.font = TEXT_FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(d.text, proj.xAt(p.tNs) + 4, proj.yAt(p.price));
      }
      break;
    }
  }

  if (selected) {
    ctx.setLineDash(SOLID_DASH);
    for (let i = 0; i < d.points.length; i += 1) {
      const p = d.points[i];
      paintHandle(ctx, proj.xAt(p.tNs), proj.yAt(p.price), d.style.color, false);
    }
  }
  ctx.restore();
}

/**
 * Live placement preview: the placed anchors plus, while a two-point shape is
 * one anchor short, a GHOST second anchor at `cursor` — the rubber band is
 * drawn as the real thing (a stretching trendline, a live rect wash, fib
 * levels breathing with the pointer), not a separate doodle. Single-anchor
 * tools never ghost (the layer shows their in-place handles only).
 */
export function paintDraft(
  ctx: CanvasRenderingContext2D,
  tool: Drawing['tool'],
  pts: readonly ChartPoint[],
  cursor: ChartPoint | null,
  proj: DrawProjection,
  opts: PaintOpts,
): void {
  if (pts.length === 0) return;
  const color = opts.selectedColor ?? DEFAULT_GHOST_COLOR;
  const twoPoint = tool === 'trendline' || tool === 'rect' || tool === 'fib';
  if (twoPoint && cursor !== null) {
    const style = { color, width: opts.draftWidth ?? DEFAULT_GHOST_WIDTH };
    const draft: Drawing =
      tool === 'trendline'
        ? { id: DRAFT_ID, tool, createdAt: 0, points: [pts[0], cursor], style }
        : tool === 'rect'
          ? { id: DRAFT_ID, tool, createdAt: 0, points: [pts[0], cursor], style }
          : { id: DRAFT_ID, tool: 'fib', createdAt: 0, points: [pts[0], cursor], style };
    paintDrawing(ctx, draft, proj, { ...opts, draft: true });
  }
  // Placed anchors get handles; the ghost cursor does not.
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    paintHandle(ctx, proj.xAt(p.tNs), proj.yAt(p.price), color, false);
  }
}

/**
 * Paint the WHOLE layer: clear, then each finished drawing in order (earlier
 * = deeper). The placement ghost is a separate `paintDraft` call the layer
 * composes after this one. Plain indexed loops — the hot path must not
 * allocate per drawing per frame.
 */
export function paintLayer(
  ctx: CanvasRenderingContext2D,
  items: readonly Drawing[],
  proj: DrawProjection,
  opts: PaintOpts,
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  for (let i = 0; i < items.length; i += 1) {
    paintDrawing(ctx, items[i], proj, opts);
  }
}
