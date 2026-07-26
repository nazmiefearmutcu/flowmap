/**
 * CVD (cumulative volume delta) data holder.
 *
 * CVD is `Σ(buy volume − sell volume)` over the session — a running signed total
 * that leads/confirms price. Each {@link BarColumn} already carries the
 * session-cumulative value in `cvd_cum` (the server's Grid accumulates it from
 * per-trade aggressor side), so this overlay is pure rendering of existing data.
 *
 * Unlike VWAP or the price line, CVD is NOT a price, so it cannot share the price
 * grid's vertical axis — it renders in a SEPARATE lower pane (see ui/CvdPane).
 * This class therefore only owns the DATA (col_seq → cvd_cum, pruned to the
 * resident window exactly like {@link Vwap}); the pane reads {@link series} for
 * the visible columns and maps them through the SAME horizontal camera transform
 * as the heatmap, so dragging the chart back/forward drags CVD in lock-step.
 *
 * Honesty (§7): CVD is only meaningful when the feed carries a real aggressor
 * side. For keyless equity (`side_src = na`) `cvd_cum` stays ~0 and the pane must
 * badge it "not measurable" rather than draw a flat zero line — the capability
 * dict drives that, not this data class.
 */

import type { BarColumn } from '../../proto/types';

export interface CvdPoint {
  col: number;
  cvd: number;
}

export class Cvd {
  /** Absolute col_seq → session-cumulative CVD. */
  private readonly values = new Map<number, number>();

  /** Record / refresh a column's cumulative CVD at its absolute col_seq. */
  add(bar: BarColumn): void {
    if (Number.isFinite(bar.cvd_cum)) this.values.set(bar.col_seq, bar.cvd_cum);
  }

  get size(): number {
    return this.values.size;
  }

  /** Drop columns outside `[oldest-pad, newest+pad]` (bounds memory to the window). */
  prune(oldest: number, newest: number, pad = 0): void {
    const lo = oldest - pad;
    const hi = newest + pad;
    for (const seq of this.values.keys()) {
      if (seq < lo || seq > hi) this.values.delete(seq);
    }
  }

  reset(): void {
    this.values.clear();
  }

  /** CVD value at a column (for tests / readouts), or NaN. */
  valueAt(colSeq: number): number {
    const v = this.values.get(colSeq);
    return v === undefined ? Number.NaN : v;
  }

  /**
   * Points inside `[loCol, hiCol]` in ascending column order (one per column).
   *
   * Iterates the map's ENTRIES (bounded by the ~resident point count), not the
   * dense integer span — so a fully-zoomed-out time axis (colSpan up to ~1M after
   * the zoom-out decoupling) still costs O(residentPoints), not O(span). The map
   * is insertion-ordered, so the survivors are sorted by column before returning.
   */
  series(loCol: number, hiCol: number): CvdPoint[] {
    const lo = Math.ceil(loCol);
    const hi = Math.floor(hiCol);
    const out: CvdPoint[] = [];
    for (const [c, v] of this.values) {
      if (c < lo || c > hi) continue;
      if (!Number.isFinite(v)) continue;
      out.push({ col: c, cvd: v });
    }
    out.sort((a, b) => a.col - b.col);
    return out;
  }
}
