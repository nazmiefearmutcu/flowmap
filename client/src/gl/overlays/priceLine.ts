/**
 * Last-price line overlay (§2 G2, §8.3).
 *
 * A bright polyline of the per-column CLOSE price over time — the "price line"
 * a chart user expects on top of the liquidity heatmap. Each {@link BarColumn}
 * carries OHLC, so this reads `bar.c` (the column's last trade) and plots one
 * vertex per visible column, exactly like {@link Vwap} — O(visible).
 *
 * Why this exists as its own overlay: the heatmap DENSITY is the book, and the
 * BBO overlay only draws the CURRENT inside quote as two full-width lines (a
 * single value, no history). Neither gives a persistent price TRACE, so users
 * were reading the trade-bubble trail as "the price line" — and that trail used
 * to evict on the left before the heatmap did, so the price appeared to get
 * deleted. This overlay is keyed by absolute `col_seq` and pruned to the SAME
 * resident window as the heatmap, so it persists exactly as far back as the
 * depth history and never truncates independently.
 *
 * It draws on the 2D text layer (NOT the GL batches): canvas stroking gives
 * anti-aliased joins and a gradient wash that raw GL triangles cannot, which is
 * the difference between a chart-grade line and a jagged one. Three passes — a
 * soft area wash under the line, a wide translucent glow, then the bright core —
 * plus a short solid stub that carries the trace to the right gutter. It also
 * paints the dashed last-price level marker across the chart (the TradingView
 * signature) and exposes {@link last} so the price axis can draw the matching
 * right-edge price pill.
 */

import type { OverlayFrame } from './frame';
import { OVERLAY, parseCssColor } from './palette';
import type { BarColumn } from '../../proto/types';
import { visibleColRange } from './coords';
import type { Pt } from '../textLayer';

/** CSS-px width of the bright price-line core. */
export const PRICE_LINE_WIDTH = 2.0;
/** CSS-px width of the translucent glow drawn underneath the core. */
export const PRICE_GLOW_WIDTH = 6.0;
/** Alpha of the wide glow pass (over the near-white core color). */
export const PRICE_GLOW_ALPHA = 0.22;
/** Alpha of the area wash's TOP stop (the bottom stop stays transparent).
 *  `OVERLAY.priceFillTop` / `OVERLAY.priceLevel` are palette-lane owned; the
 *  price-line slice re-stamps their alpha here so hues stay palette-owned. */
export const PRICE_FILL_TOP_ALPHA = 0.09;
/** Alpha of the dashed last-price level marker (quieter than the trace). */
export const PRICE_LEVEL_ALPHA = 0.30;
/** CSS-px length of the solid stub bridging the trace to the right gutter. */
export const PRICE_STUB_PX = 10;
/** Alpha of the right-edge stub (subtle; the core pass stays the brightest ink). */
export const PRICE_STUB_ALPHA = 0.7;

/**
 * Re-stamp a css color's alpha, keeping its rgb (hue) untouched. Pure; an
 * unparseable input passes through unchanged. Used for the price-line family
 * whose rgb is owned by the palette bridge while the alpha is tuned here.
 */
export function withAlpha(css: string, alpha: number): string {
  const rgb = parseCssColor(css);
  return rgb === null ? css : `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/** The most recent close: the column with the highest col_seq ever added. */
export interface LastClose {
  col: number;
  price: number;
}

export class PriceLine {
  /** Absolute col_seq → close price. */
  private readonly closes = new Map<number, number>();
  /** Newest close (highest col_seq seen) — O(1) maintenance, O(1) read. */
  private lastClose: LastClose | null = null;

  /** Record / refresh a column's close price at its absolute col_seq. */
  add(bar: BarColumn): void {
    if (!Number.isFinite(bar.c)) return;
    this.closes.set(bar.col_seq, bar.c);
    if (this.lastClose === null || bar.col_seq >= this.lastClose.col) {
      this.lastClose = { col: bar.col_seq, price: bar.c };
    }
  }

  get size(): number {
    return this.closes.size;
  }

  /** Drop columns outside `[oldest-pad, newest+pad]` (bounds memory to the window). */
  prune(oldest: number, newest: number, pad = 0): void {
    const lo = oldest - pad;
    const hi = newest + pad;
    for (const seq of this.closes.keys()) {
      if (seq < lo || seq > hi) this.closes.delete(seq);
    }
  }

  /**
   * Re-init ONLY the session high-water cursor (`lastClose`). A replaced session
   * restarts `col_seq` at 0; without this the col_seq-max would keep `last()`
   * frozen on the old session's price (dashed level + axis pill; survey S1 D5).
   * `reset()` calls this and additionally drops the per-column data.
   */
  resetCursor(): void {
    this.lastClose = null;
  }

  reset(): void {
    this.closes.clear();
    this.resetCursor();
  }

  /** The newest close (for the price-axis pill), or null with no data. */
  last(): LastClose | null {
    return this.lastClose;
  }

  /** Close price at a column (for tests / readouts), or NaN. */
  valueAt(colSeq: number): number {
    const v = this.closes.get(colSeq);
    return v === undefined ? Number.NaN : v;
  }

  draw(frame: OverlayFrame): void {
    const { gm, text } = frame;
    if (!gm.hasEvents || this.closes.size === 0) return;
    const range = visibleColRange(gm.view, frame.resident);
    if (range === null) return;

    // One vertex per visible column, in ascending column order. `+0.5` puts the
    // line on the row-CELL CENTRE — the same convention bubbles/markers use — so
    // the trace rides the density cell the heatmap paints instead of its top
    // boundary (survey S2 D3: the boundary convention split line and dots ~7px).
    const pts: Pt[] = [];
    for (let c = range.lo; c <= range.hi; c++) {
      const close = this.closes.get(c);
      if (close === undefined || !Number.isFinite(close)) continue;
      pts.push({ x: gm.cssX(c + 0.5), y: gm.cssY(gm.priceToRow(close) + 0.5) });
    }
    if (pts.length === 0) return;

    // Soft area wash under the line — the chart-grade "area" cue, kept faint so
    // the density field stays the protagonist.
    text.fillUnder(
      pts,
      gm.dims.cssH,
      withAlpha(OVERLAY.priceFillTop.css, PRICE_FILL_TOP_ALPHA),
      OVERLAY.priceFillBottom.css,
    );

    // Glow pass (wide, translucent) — flushed first so the bright core sits on
    // top; canvas AA + round joins make the two passes read as one smooth line.
    text.polyline(pts, {
      width: PRICE_GLOW_WIDTH,
      color: OVERLAY.price.css,
      alpha: PRICE_GLOW_ALPHA,
    });
    // Right-edge solid stub: carries the trace the last few px into the gutter
    // so the line reads where it meets the axis pill. Drawn BEFORE the core so
    // the core owns the joint; clamped to the chart surface (the pill lives in
    // the gutter canvas, so the two can never overlap).
    const newest = pts[pts.length - 1];
    const stubEnd = Math.min(gm.dims.cssW, newest.x + PRICE_STUB_PX);
    if (stubEnd - newest.x >= 1) {
      text.polyline([newest, { x: stubEnd, y: newest.y }], {
        width: PRICE_LINE_WIDTH,
        color: OVERLAY.price.css,
        alpha: PRICE_STUB_ALPHA,
      });
    }
    // Bright core pass.
    text.polyline(pts, { width: PRICE_LINE_WIDTH, color: OVERLAY.price.css });
    // A single visible vertex: draw a short dash so it's still visible.
    if (pts.length === 1) {
      text.dashedLine(pts[0].x - 4, pts[0].y, pts[0].x + 4, pts[0].y, OVERLAY.price.css, [99, 0], PRICE_LINE_WIDTH);
    }

    // Dashed last-price level marker across the chart, with a solid right-edge
    // stub that meets the axis pill drawn by drawPriceAxis. Row-cell centre,
    // matching the trace and the pill.
    const last = this.lastClose;
    if (last !== null && gm.price !== null) {
      const y = gm.cssY(gm.priceToRow(last.price) + 0.5);
      if (y >= -1 && y <= gm.dims.cssH + 1) {
        text.dashedLine(
          0,
          y,
          gm.dims.cssW,
          y,
          withAlpha(OVERLAY.priceLevel.css, PRICE_LEVEL_ALPHA),
          [2, 4],
          1,
        );
      }
    }
  }
}
