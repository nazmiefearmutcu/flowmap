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
 * It is drawn prominently: a soft translucent glow underneath a thick bright
 * core, so it stays legible over the busiest heatmap without hiding it.
 */

import type { OverlayFrame } from './frame';
import { OVERLAY } from './palette';
import type { BarColumn } from '../../proto/types';
import { visibleColRange } from './coords';

/** CSS-px width of the bright price-line core. */
export const PRICE_LINE_WIDTH = 2.8;
/** CSS-px width of the translucent glow drawn underneath the core. */
export const PRICE_GLOW_WIDTH = 6.5;

export class PriceLine {
  /** Absolute col_seq → close price. */
  private readonly closes = new Map<number, number>();

  /** Record / refresh a column's close price at its absolute col_seq. */
  add(bar: BarColumn): void {
    if (Number.isFinite(bar.c)) this.closes.set(bar.col_seq, bar.c);
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

  reset(): void {
    this.closes.clear();
  }

  /** Close price at a column (for tests / readouts), or NaN. */
  valueAt(colSeq: number): number {
    const v = this.closes.get(colSeq);
    return v === undefined ? Number.NaN : v;
  }

  draw(frame: OverlayFrame): void {
    const { gm, solid } = frame;
    if (!gm.hasEvents || this.closes.size === 0) return;
    const range = visibleColRange(gm.view, frame.resident);
    if (range === null) return;

    // One vertex per visible column, in ascending column order.
    const pts: Array<{ x: number; y: number }> = [];
    for (let c = range.lo; c <= range.hi; c++) {
      const close = this.closes.get(c);
      if (close === undefined || !Number.isFinite(close)) continue;
      pts.push({ x: gm.clipX(c + 0.5), y: gm.clipY(gm.priceToRow(close)) });
    }
    if (pts.length === 0) return;

    const cssW = gm.dims.cssW;
    const cssH = gm.dims.cssH;

    // Glow pass (wide, translucent) — flushed first so the bright core sits on top.
    solid.begin();
    for (let i = 1; i < pts.length; i++) {
      solid.addThickLine(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, PRICE_GLOW_WIDTH, OVERLAY.priceGlow.gl, cssW, cssH);
    }
    solid.flush();

    // Bright core pass.
    solid.begin();
    for (let i = 1; i < pts.length; i++) {
      solid.addThickLine(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, PRICE_LINE_WIDTH, OVERLAY.price.gl, cssW, cssH);
    }
    // A single visible vertex: draw a short dash so it's still visible.
    if (pts.length === 1) {
      const dx = gm.pxToClipW(4);
      solid.addThickLine(pts[0].x - dx, pts[0].y, pts[0].x + dx, pts[0].y, PRICE_LINE_WIDTH, OVERLAY.price.gl, cssW, cssH);
    }
    solid.flush();
  }
}
