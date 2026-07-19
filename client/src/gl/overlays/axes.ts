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

import { fmtClock, fmtClockMs, priceDecimals, priceTickModel, timeTickModel } from './axisTicks';
import type { GridMap } from './coords';
import { OVERLAY } from './palette';
import type { TextLayer } from '../textLayer';

const PRICE_TARGET = 8;
const TIME_TARGET = 7;

export interface AxisLabel {
  /** CSS-px position along the gutter (y for price, x for time). */
  pos: number;
  label: string;
}

/** Price ticks with their gutter y (CSS px). Empty when no price affine. */
export function priceAxisModel(gm: GridMap, cssH: number): AxisLabel[] {
  if (gm.price === null) return [];
  const pLo = gm.rowToPrice(gm.view.rowOffset);
  const pHi = gm.rowToPrice(gm.view.rowOffset + gm.view.rowScale);
  const { step, ticks } = priceTickModel(pLo, pHi, PRICE_TARGET, gm.price.step);
  // Decimals from the TICK step, not the finer grid step, so whole-number ticks
  // don't show a spurious '.00'.
  const dec = priceDecimals(step > 0 ? step : gm.price.step);
  const out: AxisLabel[] = [];
  for (const price of ticks) {
    const y = gm.cssY(gm.priceToRow(price));
    if (y < -1 || y > cssH + 1) continue;
    out.push({ pos: y, label: price.toFixed(dec) });
  }
  return out;
}

/** Time ticks with their gutter x (CSS px). Empty when no time affine. */
export function timeAxisModel(gm: GridMap, cssW: number): AxisLabel[] {
  if (!gm.hasEvents) return [];
  const tLo = gm.colToTsNs(gm.view.colOffset);
  const tHi = gm.colToTsNs(gm.view.colOffset + gm.view.colScale);
  if (tLo === null || tHi === null) return [];
  const { step, ticks } = timeTickModel(tLo, tHi, TIME_TARGET);
  // Sub-second cadences (250 ms / 25 ms) need the millisecond format, else every
  // row collapses to the same HH:MM:SS label.
  const fmt = step > 0n && step < 1_000_000_000n ? fmtClockMs : fmtClock;
  const out: AxisLabel[] = [];
  for (const t of ticks) {
    const x = gm.cssX(gm.tsToCol(t));
    if (x < -1 || x > cssW + 1) continue;
    out.push({ pos: x, label: fmt(t) });
  }
  return out;
}

/**
 * Price tick gutter-y positions only (no label strings). For {@link drawGridlines},
 * which needs positions but throws labels away — this avoids the per-dirty-frame
 * toFixed allocation.
 */
export function priceTickPositions(gm: GridMap, cssH: number): number[] {
  if (gm.price === null) return [];
  const pLo = gm.rowToPrice(gm.view.rowOffset);
  const pHi = gm.rowToPrice(gm.view.rowOffset + gm.view.rowScale);
  const out: number[] = [];
  for (const price of priceTickModel(pLo, pHi, PRICE_TARGET, gm.price.step).ticks) {
    const y = gm.cssY(gm.priceToRow(price));
    if (y < -1 || y > cssH + 1) continue;
    out.push(y);
  }
  return out;
}

/**
 * Time tick gutter-x positions only (no label strings). For {@link drawGridlines};
 * avoids building/discarding fmtClock strings every dirty frame.
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

/** Draw the right-hand price axis into its gutter layer. */
export function drawPriceAxis(layer: TextLayer, gm: GridMap): void {
  layer.clear();
  const model = priceAxisModel(gm, layer.height);
  for (const t of model) {
    layer.line(0, t.pos, 4, t.pos, OVERLAY.axis.css, 1);
    layer.text(7, t.pos, t.label, { baseline: 'middle', color: OVERLAY.axis.css, size: 10 });
  }
}

/** Draw the bottom time axis into its gutter layer. */
export function drawTimeAxis(layer: TextLayer, gm: GridMap): void {
  layer.clear();
  const cssW = layer.width;
  const model = timeAxisModel(gm, cssW);
  const last = model.length - 1;
  for (let i = 0; i < model.length; i++) {
    const t = model[i];
    layer.line(t.pos, 0, t.pos, 4, OVERLAY.axis.css, 1);
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
    layer.text(x, 15, t.label, { align, baseline: 'alphabetic', color: OVERLAY.axis.css, size: 10 });
  }
}

/** Faint gridlines over the heatmap at the price/time ticks (orientation aid). */
export function drawGridlines(text: TextLayer, gm: GridMap): void {
  const cssW = text.width;
  const cssH = text.height;
  // Use the label-free position variants: gridlines only need pixel positions, so
  // building/discarding toFixed/fmtClock strings every dirty frame is wasted work.
  for (const y of priceTickPositions(gm, cssH)) {
    text.line(0, y, cssW, y, OVERLAY.grid.css, 1);
  }
  for (const x of timeTickPositions(gm, cssW)) {
    text.line(x, 0, x, cssH, OVERLAY.grid.css, 1);
  }
}
