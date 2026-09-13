/**
 * Price + time axes (§9: price axis right, time axis bottom), M2 T10.
 *
 * Drawn into the gutter {@link TextLayer}s (PriceAxis / TimeAxis canvases) each
 * dirty frame from the current camera, so ticks stay pinned to the heatmap under
 * pan/zoom: the price gutter shares the viewport's HEIGHT (row→y matches the
 * heatmap), the time gutter shares its WIDTH (col→x matches). Optional faint
 * gridlines are drawn on the over-heatmap text layer for orientation. Pure tick
 * math lives in axisTicks.ts; this is the placement/draw glue.
 *
 * Also exposes {@link priceAxisModel} / {@link timeAxisModel} — the computed
 * {label, pos} arrays — so the e2e can assert axis labels + alignment without
 * scraping canvas pixels.
 */

import {
  logPriceTickModel,
  priceDecimals,
  priceTickModel,
  timeLabelFormatter,
  timeTickModel,
} from './axisTicks';
import type { GridMap } from './coords';
import type { LastClose } from './priceLine';
import { OVERLAY } from './palette';
import { DEFAULT_TEXT_SIZE, type TextLayer } from '../textLayer';

const PRICE_TARGET = 8;
const TIME_TARGET = 7;

/** Price-axis tick-label size (CSS px) — the text layer's standard size, hoisted
 *  so axis typography reads as a named constant, not a scattered literal. */
export const AXIS_LABEL_SIZE = DEFAULT_TEXT_SIZE;
/** Price-axis tick-label weight (medium: the ladder reads as data, not chrome). */
export const AXIS_LABEL_WEIGHT = 500;
/** Price-axis major tick mark length (CSS px, 1 px wide). */
export const AXIS_TICK_LEN = 6;
/** Tick-mark opacity — deliberately below the label ink so the ticks read as
 *  subtle guides, not a second ladder (Bookmap-class axis: data is the ink). */
export const AXIS_TICK_ALPHA = 0.55;
/** Time-axis tick-label size (CSS px). Kept one step under the price ladder's
 *  11 px: the gutter is 22 px tall, and 11 px ms-precision labels ("00:00:00.000")
 *  would crowd the slot at narrow viewports (measured 10 px min gap at 640 px
 *  wide, deep-zoom ms regime — 11 px labels would close it). */
export const AXIS_TIME_LABEL_SIZE = 10;
/** Approximate advance width of the mono axis font (JetBrains Mono ≈ 0.6 em). */
const MONO_ADVANCE_EM = 0.6;

export interface AxisLabel {
  /** CSS-px position along the gutter (y for price, x for time). */
  pos: number;
  label: string;
}

/**
 * Price ticks with their gutter y (CSS px). Empty when no price affine.
 *
 * `labelWidthPx` (optional): usable label width in the gutter. When given and
 * a tick label would overflow it, decimals are reduced globally (never
 * per-label, so the ladder keeps one scale) down to 0 — review R2-M2: the
 * 11 px label on the frozen 62 px gutter clipped ≥9-char values (large
 * prices). Omitted → historical `toFixed(dec)` formatting exactly.
 */
export function priceAxisModel(gm: GridMap, cssH: number, labelWidthPx?: number): AxisLabel[] {
  if (gm.price === null) return [];
  const pLo = gm.rowToPrice(gm.view.rowOffset);
  const pHi = gm.rowToPrice(gm.view.rowOffset + gm.view.rowScale);
  const { step, ticks } = axisTicks(gm, pLo, pHi);
  // Decimals from the TICK step, not the finer grid step, so whole-number ticks
  // don't show a spurious '.00'.
  let dec = priceDecimals(step > 0 ? step : localStep(gm));
  if (
    labelWidthPx !== undefined &&
    Number.isFinite(labelWidthPx) &&
    labelWidthPx > 0 &&
    ticks.length > 0
  ) {
    const maxChars = Math.max(4, Math.floor(labelWidthPx / (AXIS_LABEL_SIZE * MONO_ADVANCE_EM)));
    // Global (uniform) decimal reduction: one ladder scale, no mixed readouts.
    while (dec > 0) {
      let longest = 0;
      for (const price of ticks) longest = Math.max(longest, price.toFixed(dec).length);
      if (longest <= maxChars) break;
      dec--;
    }
  }
  const out: AxisLabel[] = [];
  for (const price of ticks) {
    const y = gm.cssY(gm.priceToRow(price));
    if (y < -1 || y > cssH + 1) continue;
    out.push({ pos: y, label: price.toFixed(dec) });
  }
  return out;
}

/** The grid's row height at the CENTRE of the current view — the right
 *  "smallest meaningful step" for a non-uniform axis. */
function localStep(gm: GridMap): number {
  const s = gm.stepAtRow(gm.view.rowOffset + gm.view.rowScale / 2);
  return Number.isFinite(s) && s > 0 ? s : 0;
}

/**
 * Pick the tick ladder for the current price window.
 *
 * A uniform grid — and a non-uniform one the user has zoomed into the linear
 * core — takes the arithmetic ladder verbatim, so those axes are pixel-identical
 * to before. Only a genuinely wide window on a non-uniform scale (more than a
 * 1.5× price ratio top-to-bottom, which a linear axis cannot meaningfully even
 * express since its `pLo` may be negative) switches to a decade ladder, where a
 * single arithmetic step would otherwise be invisible at the bottom of the view
 * and the only tick at the top.
 */
function axisTicks(gm: GridMap, pLo: number, pHi: number): { step: number; ticks: number[] } {
  const nonUniform = gm.price?.scale !== undefined && gm.price.scale.kind !== 'linear';
  if (nonUniform && pLo > 0 && pHi / pLo > 1.5) {
    return { step: 0, ticks: logPriceTickModel(pLo, pHi, PRICE_TARGET).ticks };
  }
  return priceTickModel(pLo, pHi, PRICE_TARGET, localStep(gm) || gm.price!.step);
}

/** Time ticks with their gutter x (CSS px). Empty when no time affine. */
export function timeAxisModel(gm: GridMap, cssW: number): AxisLabel[] {
  if (!gm.hasEvents) return [];
  const tLo = gm.colToTsNs(gm.view.colOffset);
  const tHi = gm.colToTsNs(gm.view.colOffset + gm.view.colScale);
  if (tLo === null || tHi === null) return [];
  const { step, ticks } = timeTickModel(tLo, tHi, TIME_TARGET);
  // S4-Q5 adaptive labels: the millisecond format is reserved for genuinely
  // sub-second ladders (< 0.5 s) — 0.5 s ticks already read as clock seconds at
  // a glance, and every 1 s+ ladder before this change paid invisible `.mmm`.
  const fmt = timeLabelFormatter(step);
  const out: AxisLabel[] = [];
  for (const t of ticks) {
    const x = gm.cssX(gm.tsToCol(t));
    if (x < -1 || x > cssW + 1) continue;
    out.push({ pos: x, label: fmt(t) });
  }
  return out;
}

/**
 * Price tick gutter-y positions only (no label strings) — the string-free twin
 * of {@link priceAxisModel}: EXACTLY the labeled major ticks (same ladder, same
 * viewport filter), which is the gridline-coverage contract (lane C: no minor
 * tick may draw a line the axis does not label). For {@link drawGridlines},
 * which needs positions but throws labels away, this avoids the per-dirty-frame
 * toFixed allocation.
 */
export function priceTickPositions(gm: GridMap, cssH: number): number[] {
  if (gm.price === null) return [];
  const pLo = gm.rowToPrice(gm.view.rowOffset);
  const pHi = gm.rowToPrice(gm.view.rowOffset + gm.view.rowScale);
  const out: number[] = [];
  for (const price of axisTicks(gm, pLo, pHi).ticks) {
    const y = gm.cssY(gm.priceToRow(price));
    if (y < -1 || y > cssH + 1) continue;
    out.push(y);
  }
  return out;
}

/**
 * Time tick gutter-x positions only (no label strings) — the string-free twin of
 * {@link timeAxisModel}: EXACTLY the labeled time ticks. For
 * {@link drawGridlines}; avoids building/discarding fmtClock strings every
 * dirty frame.
 */
export function timeTickPositions(gm: GridMap, cssW: number): number[] {
  if (!gm.hasEvents) return [];
  const tLo = gm.colToTsNs(gm.view.colOffset);
  const tHi = gm.colToTsNs(gm.view.colOffset + gm.view.colScale);
  if (tLo === null || tHi === null) return [];
  const out: number[] = [];
  for (const t of timeTickModel(tLo, tHi, TIME_TARGET).ticks) {
    const x = gm.cssX(gm.tsToCol(t));
    if (x < -1 || x > cssW + 1) continue;
    out.push(x);
  }
  return out;
}

/**
 * Draw the right-hand price axis into its gutter layer.
 *
 * `last` (the newest close, when the price overlay is on) is drawn as a
 * near-white rounded pill pinned to the gutter edge at its price — the
 * TradingView "last price tag": the one number on the axis that matters gets a
 * plate, and it stays readable over any heatmap. Clamped into the gutter so a
 * last price at the very edge of the visible band keeps its tag.
 */
export function drawPriceAxis(layer: TextLayer, gm: GridMap, last: LastClose | null = null): void {
  layer.clear();
  const cssW = layer.width;
  const model = priceAxisModel(gm, layer.height, cssW - 6 - AXIS_TICK_LEN - 2);
  for (const t of model) {
    layer.line(0, t.pos, AXIS_TICK_LEN, t.pos, OVERLAY.axis.css, 1, AXIS_TICK_ALPHA);
    layer.text(cssW - 6, t.pos, t.label, {
      align: 'right',
      baseline: 'middle',
      color: OVERLAY.axis.css,
      size: AXIS_LABEL_SIZE,
      weight: AXIS_LABEL_WEIGHT,
    });
  }
  if (last === null || gm.price === null) return;
  const step = localStep(gm) || gm.price.step;
  const dec = priceDecimals(step > 0 ? step : gm.price.step);
  // Row-cell centre (`+0.5`), matching the price line and its dashed level —
  // the pill must sit on the cell the heatmap paints (survey S2 D3).
  const y = gm.cssY(gm.priceToRow(last.price) + 0.5);
  if (y < -8 || y > layer.height + 8) return;
  layer.badge(cssW - 3, Math.min(Math.max(y, 9), layer.height - 9), last.price.toFixed(dec), {
    align: 'right',
    bg: OVERLAY.pricePill.css,
    color: OVERLAY.pricePillText.css,
    size: 10,
    weight: 600,
    radius: 3,
  });
}

/** Draw the bottom time axis into its gutter layer. */
export function drawTimeAxis(layer: TextLayer, gm: GridMap): void {
  layer.clear();
  const cssW = layer.width;
  const model = timeAxisModel(gm, cssW);
  const last = model.length - 1;
  for (let i = 0; i < model.length; i++) {
    const t = model[i];
    layer.line(t.pos, 0, t.pos, AXIS_TICK_LEN, OVERLAY.axis.css, 1, AXIS_TICK_ALPHA);
    // Clamp the edge labels inward so the first/last time isn't half-clipped by
    // the gutters (the tick mark itself stays at t.pos).
    let x = t.pos;
    let align: CanvasTextAlign = 'center';
    if (i === 0) {
      align = 'left';
      x = Math.max(t.pos, 2);
    } else if (i === last) {
      align = 'right';
      x = Math.min(t.pos, cssW - 2);
    }
    layer.text(x, 15, t.label, {
      align,
      baseline: 'alphabetic',
      color: OVERLAY.axis.css,
      size: AXIS_TIME_LABEL_SIZE,
      weight: AXIS_LABEL_WEIGHT,
    });
  }
}

/**
 * Coincidence test for gridlines: two gutter positions rasterize onto the same
 * CSS-pixel row/column when their rounded values match (NaN never matches, so
 * the first iteration always draws).
 */
function sameGridline(a: number, b: number): boolean {
  return Math.round(a) === Math.round(b);
}

/**
 * Faint gridlines over the heatmap — LABELED ticks only (lane C coverage
 * contract): exactly one horizontal line per price-axis label and one vertical
 * line per time-axis label, at the label's own position. The position helpers
 * are the string-free twins of the label models, so no minor tick can produce a
 * line the axis does not label. Coincident positions (ticks rasterizing onto
 * one pixel row, e.g. an edge tick landing on a major) are drawn once.
 * Color/width stay `OVERLAY.grid` / 1 px (alpha is owned by the palette lane).
 */
export function drawGridlines(text: TextLayer, gm: GridMap): void {
  const cssW = text.width;
  const cssH = text.height;
  let prev = Number.NaN;
  for (const y of priceTickPositions(gm, cssH)) {
    if (sameGridline(y, prev)) continue;
    prev = y;
    text.line(0, y, cssW, y, OVERLAY.grid.css, 1);
  }
  prev = Number.NaN;
  for (const x of timeTickPositions(gm, cssW)) {
    if (sameGridline(x, prev)) continue;
    prev = x;
    text.line(x, 0, x, cssH, OVERLAY.grid.css, 1);
  }
}
