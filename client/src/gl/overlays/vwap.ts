/**
 * Session VWAP overlay (§2 G2, §8.3, M2 T10).
 *
 * A polyline of session VWAP over time. Each {@link BarColumn} carries CUMULATIVE
 * `vwap_num_cum = Σ(price·vol)` and `vwap_den_cum = Σ vol` from the session start,
 * so session VWAP at a column is simply `num/den` (chosen over per-column deltas:
 * it's the standard anchored-session VWAP traders read, and monotone-cumulative
 * inputs make it robust to a dropped column). One vertex per visible column, so
 * the draw is O(visible).
 *
 * Works in both markets: crypto/equity tape seeds the cumulants; equity keyless
 * derives them from 1-minute bars (Σ typical×vol / Σ vol) — the renderer badges
 * that case "approx" (§7). No bars ⇒ nothing drawn.
 */

import type { OverlayFrame } from './frame';
import { OVERLAY } from './palette';
import type { BarColumn } from '../../proto/types';
import { visibleColRange } from './coords';

/** Session VWAP from cumulative sums, or NaN when denominator is empty. Pure. */
export function sessionVwap(numCum: number, denCum: number): number {
  return denCum > 0 ? numCum / denCum : Number.NaN;
}

interface Entry {
  num: number;
  den: number;
}

export class Vwap {
  private readonly bars = new Map<number, Entry>();

  /** Record / refresh a bar column's cumulants at its absolute col_seq. */
  add(bar: BarColumn): void {
    this.bars.set(bar.col_seq, { num: bar.vwap_num_cum, den: bar.vwap_den_cum });
  }

  get size(): number {
    return this.bars.size;
  }

  /** Drop bars outside `[oldest-pad, newest+pad]` (bounds memory to the window). */
  prune(oldest: number, newest: number, pad = 0): void {
    const lo = oldest - pad;
    const hi = newest + pad;
    for (const seq of this.bars.keys()) {
      if (seq < lo || seq > hi) this.bars.delete(seq);
    }
  }

  reset(): void {
    this.bars.clear();
  }

  /** VWAP value at a column (for tests / readouts), or NaN. */
  valueAt(colSeq: number): number {
    const e = this.bars.get(colSeq);
    return e ? sessionVwap(e.num, e.den) : Number.NaN;
  }

  draw(frame: OverlayFrame): void {
    const { gm, solid } = frame;
    if (!gm.hasEvents || this.bars.size === 0) return;
    const range = visibleColRange(gm.view, frame.resident);
    if (range === null) return;

    // Collect visible vertices in ascending column order (one per column).
    const pts: Array<{ x: number; y: number }> = [];
    for (let c = range.lo; c <= range.hi; c++) {
      const e = this.bars.get(c);
      if (e === undefined) continue;
      const v = sessionVwap(e.num, e.den);
      if (!Number.isFinite(v)) continue;
      pts.push({ x: gm.clipX(c + 0.5), y: gm.clipY(gm.priceToRow(v)) });
    }
    if (pts.length === 0) return;

    solid.begin();
    const cssW = gm.dims.cssW;
    const cssH = gm.dims.cssH;
    for (let i = 1; i < pts.length; i++) {
      solid.addThickLine(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, 1.6, OVERLAY.vwap.gl, cssW, cssH);
    }
    // A single visible vertex: draw a short dash so it's still visible.
    if (pts.length === 1) {
      const dx = gm.pxToClipW(3);
      solid.addThickLine(pts[0].x - dx, pts[0].y, pts[0].x + dx, pts[0].y, 1.6, OVERLAY.vwap.gl, cssW, cssH);
    }
    solid.flush();
  }
}
