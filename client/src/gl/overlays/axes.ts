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

import { fmtClock, priceDecimals, priceTicks, timeTicks } from './axisTicks';
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
  const dec = priceDecimals(gm.price.step);
  const out: AxisLabel[] = [];
  for (const price of priceTicks(pLo, pHi, PRICE_TARGET, gm.price.step)) {
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
  const out: AxisLabel[] = [];
  for (const t of timeTicks(tLo, tHi, TIME_TARGET)) {
    const x = gm.cssX(gm.tsToCol(t));
    if (x < -1 || x > cssW + 1) continue;
    out.push({ pos: x, label: fmtClock(t) });
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
  const model = timeAxisModel(gm, layer.width);
  for (const t of model) {
    layer.line(t.pos, 0, t.pos, 4, OVERLAY.axis.css, 1);
    layer.text(t.pos, 15, t.label, { align: 'center', baseline: 'alphabetic', color: OVERLAY.axis.css, size: 10 });
  }
}

/** Faint gridlines over the heatmap at the price/time ticks (orientation aid). */
export function drawGridlines(text: TextLayer, gm: GridMap): void {
  const cssW = text.width;
  const cssH = text.height;
  for (const t of priceAxisModel(gm, cssH)) {
    text.line(0, t.pos, cssW, t.pos, OVERLAY.grid.css, 1);
  }
  for (const t of timeAxisModel(gm, cssW)) {
    text.line(t.pos, 0, t.pos, cssH, OVERLAY.grid.css, 1);
  }
}
