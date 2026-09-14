/**
 * Bottom volume-bar strip (Bookmap H7; swarm2 wave 4, F26).
 *
 * A histogram of TRADED volume along the chart's bottom edge, directly above
 * the time axis — the Bookmap "volume bars" component our chart lacked
 * (reference decomposition D3 §H7 scored it 1.5/10: "we have none"). One bar
 * per visible time bucket: height ∝ buy+sell volume aggregated into the bucket,
 * color = the bucket's dominant aggressor side (theme `buy`/`sell` tokens).
 *
 * Data: every {@link BarColumn} already carries the per-interval taker split
 * (`vol_buy`/`vol_sell` — the server Grid accumulates them from real aggressor
 * sides), and reconstructed crypto history carries the same split from kline
 * taker volumes. Columns WITHOUT a split (keyless equity, SIDE_UNKNOWN-only
 * trades) are never drawn: absence stays a gap, never a fake bar (§7 honesty).
 *
 * Rendering: ONE 2D-canvas pass over the visible buckets, on the shared text
 * layer (the same canvas the price line uses — real canvas AA at 1 px). Buckets
 * are screen-space: `bucketCount = min(visible columns, canvas px)`, so a
 * fully zoomed-out view collapses to ≤ one bucket per pixel and the cost is
 * O(visible buckets) ≤ O(canvas width), never O(history). The bucket scratch
 * arrays are instance-owned and reused, so a dirty frame allocates nothing.
 */

import type { OverlayFrame } from './frame';
import { OVERLAY } from './palette';
import type { BarColumn } from '../../proto/types';
import { visibleColRange } from './coords';

/** One stored bucket source: a column's taker-split volume. */
export interface VolBarPoint {
  col: number;
  buy: number;
  sell: number;
  /**
   * How many grid columns the volume OCCUPIES. `1` for a live interval column;
   * larger for a reconstructed candle bar, which the server keys to its group's
   * FIRST column while its volume covers the whole candle (backfill.py:
   * "One bar per candle, keyed to the group's FIRST column"). The draw spreads
   * each point across `span` buckets so a 1-minute reconstructed candle reads at
   * the same per-column scale as live 250 ms buckets instead of spiking 16×.
   */
  span: number;
}

/** Strip height as a fraction of the chart height (clamped, see constants). */
export const VOLBAR_HEIGHT_FRAC = 0.07;
/** Minimum strip height (CSS px) — readable on very short charts. */
export const VOLBAR_MIN_STRIP_PX = 16;
/** Maximum strip height (CSS px) — Bookmap's default strip is a low band. */
export const VOLBAR_MAX_STRIP_PX = 44;
/** Minimum bar height (CSS px) for a bucket that carries any volume — a
 *  nonzero bucket must be visible, but one pixel is the honest minimum. */
export const VOLBAR_MIN_PX = 1;
/** Maximum bar width (CSS px) when zoomed in far (bars thin down as buckets
 *  outnumber pixels; they never fatten into blocks). */
export const VOLBAR_MAX_BAR_PX = 14;
/** Bar opacity over the heatmap (Bookmap's bars read solid but not paper). */
export const VOLBAR_ALPHA = 0.92;
/** Height auto-contrast percentile over the VISIBLE nonzero buckets. Bookmap's
 *  internal contrast follows the visible distribution (KB), not the max: a
 *  single whale on a linear-vs-max scale crushes every other bar to a whisker
 *  (measured live BTC: p50 = 17% of p90). Anything at/above this percentile
 *  clamps to full height (the upper-cutoff behaviour Bookmap documents). */
export const VOLBAR_CAP_PERCENTILE = 0.9;

/**
 * The themed color for a bucket with `buy`/`sell` volume totals: the dominant
 * side's theme token (teal/red family, theme-bridged), or null when the bucket
 * carries no split volume (skip — honest gap). Ties go to buy (deterministic).
 */
export function barColor(buy: number, sell: number): string | null {
  if (!(buy + sell > 0)) return null;
  return buy >= sell ? OVERLAY.buy.css : OVERLAY.sell.css;
}

/**
 * Scatter per-column volumes into `bucketCount`-many equal-width buckets
 * spanning the inclusive column range `[lo, hi]`, accumulating into the
 * caller-provided arrays (index 0..n-1; n = min(buy.length, sell.length)).
 * Returns the maximum bucket total (`buy+sell`) — the strip's normalizer — or
 * 0 when nothing was scattered. Pure apart from the output arrays; the draw
 * path and the unit tests exercise this exact kernel.
 */
export function scatterVolumes(
  points: Iterable<VolBarPoint>,
  lo: number,
  hi: number,
  buy: Float64Array,
  sell: Float64Array,
): number {
  const n = Math.min(buy.length, sell.length);
  const span = hi - lo + 1;
  if (n <= 0 || !(span > 0)) return 0;
  for (const p of points) {
    if (!Number.isFinite(p.buy) || !Number.isFinite(p.sell)) continue;
    const width = Math.max(1, p.span | 0);
    const share = 1 / width;
    for (let j = 0; j < width; j++) {
      const col = p.col + j;
      if (!(col >= lo) || !(col <= hi)) continue;
      const b = Math.min(n - 1, Math.max(0, Math.floor(((col - lo) / span) * n)));
      buy[b] += p.buy * share;
      sell[b] += p.sell * share;
    }
  }
  let max = 0;
  for (let b = 0; b < n; b++) {
    const t = buy[b] + sell[b];
    if (t > max) max = t;
  }
  return max;
}

/**
 * Persistent volume-bar data + the bottom-strip renderer. Keyed by absolute
 * `col_seq` and pruned to the SAME resident window as every other overlay, so
 * the strip pans/zooms locked to the heatmap and its memory stays bounded.
 */
export class VolBars {
  /** Absolute col_seq → taker-split volume (empty splits are not stored). */
  private readonly points = new Map<number, VolBarPoint>();
  /** Last STORED point whose span is still open (closed by the next bar event). */
  private openPoint: VolBarPoint | null = null;
  /** Reused per-frame bucket scratch (no allocation on a dirty frame). */
  private buyScratch = new Float64Array(0);
  private sellScratch = new Float64Array(0);
  private totalScratch = new Float64Array(0);

  /**
   * Record a column's traded volume. A column without a taker split
   * (vol_buy + vol_sell <= 0 — keyless equity, unknown-side-only trades) is
   * not stored: the strip then draws NOTHING there rather than a fake bar.
   *
   * `span` is inferred from the NEXT bar EVENT: the server keys one bar per
   * reconstructed candle to the group's first column, so the column distance
   * to the following candle is exactly the stretch that bar's volume covers
   * (backfill.py). Live bars arrive one per column → span 1. A zero-split
   * candle still closes the previous span (it is an event with a col_seq),
   * it just never opens one of its own.
   */
  add(bar: BarColumn): void {
    const col = bar.col_seq;
    const open = this.openPoint;
    if (open !== null && col > open.col) {
      open.span = col - open.col;
      this.openPoint = null;
    }
    const buy = Number.isFinite(bar.vol_buy) ? Math.max(0, bar.vol_buy) : 0;
    const sell = Number.isFinite(bar.vol_sell) ? Math.max(0, bar.vol_sell) : 0;
    if (buy + sell <= 0) return;
    let point = this.points.get(col);
    if (point === undefined) {
      point = { col, buy, sell, span: 1 };
      this.points.set(col, point);
    } else {
      point.buy = buy;
      point.sell = sell;
    }
    this.openPoint = point;
  }

  get size(): number {
    return this.points.size;
  }

  /** Drop columns outside `[oldest-pad, newest+pad]` (bounds memory to the window). */
  prune(oldest: number, newest: number, pad = 0): void {
    const lo = oldest - pad;
    const hi = newest + pad;
    for (const seq of this.points.keys()) {
      if (seq < lo || seq > hi) this.points.delete(seq);
    }
  }

  /** Drop every stored column (context loss / go-live re-seed / test reset). */
  reset(): void {
    this.points.clear();
    this.openPoint = null;
  }

  /** Volume at a column (for tests / readouts), or null when absent. */
  valueAt(colSeq: number): VolBarPoint | null {
    return this.points.get(colSeq) ?? null;
  }

  /**
   * Draw the strip: bottom-anchored bars, one per visible time bucket, heights
   * normalized to the visible p90 with a sqrt lift (Bookmap auto-contrast +
   * upper cutoff; see VOLBAR_CAP_PERCENTILE). Nothing is drawn for empty
   * buckets or when no visible column carries a split — the heatmap shows
   * through unchanged.
   */
  draw(frame: OverlayFrame): void {
    const { gm, text } = frame;
    if (this.points.size === 0) return;
    const range = visibleColRange(gm.view, frame.resident);
    if (range === null) return;
    const span = range.hi - range.lo + 1;
    if (!(span > 0)) return;

    // One bucket per visible column, but never more than one per canvas pixel:
    // zoomed-out views aggregate per pixel (O(canvas width)), zoomed-in views
    // keep per-column bars (Bookmap's histogram granularity).
    const cssW = Math.max(1, Math.floor(gm.dims.cssW));
    const buckets = Math.max(1, Math.min(span, cssW));
    let buy = this.buyScratch;
    let sell = this.sellScratch;
    if (buy.length < buckets) {
      this.buyScratch = buy = new Float64Array(buckets);
      this.sellScratch = sell = new Float64Array(buckets);
    } else {
      buy.fill(0, 0, buckets);
      sell.fill(0, 0, buckets);
    }
    const max = scatterVolumes(this.points.values(), range.lo, range.hi, buy, sell);
    if (max <= 0) return;

    // Auto-contrast reference: the p90 of the VISIBLE nonzero bucket totals
    // (Bookmap follows the visible distribution; linear-vs-max crushed live
    // BTC's median bar to ~0.2% of the strip). Computed on the reused scratch —
    // zeros sort to the front, the nonzero tail carries the percentile.
    let totals = this.totalScratch;
    if (totals.length < buckets) this.totalScratch = totals = new Float64Array(buckets);
    let nonzero = 0;
    for (let b = 0; b < buckets; b++) {
      const t = buy[b] + sell[b];
      totals[b] = t;
      if (t > 0) nonzero++;
    }
    totals.subarray(0, buckets).sort();
    const rank = Math.ceil(VOLBAR_CAP_PERCENTILE * nonzero) - 1;
    const cap = totals[buckets - nonzero + rank];
    if (!(cap > 0)) return;

    const xLo = gm.cssX(range.lo);
    const xHi = gm.cssX(range.hi + 1);
    const bw = (xHi - xLo) / buckets;
    if (!(bw > 0)) return;

    const stripH = Math.max(
      VOLBAR_MIN_STRIP_PX,
      Math.min(VOLBAR_MAX_STRIP_PX, gm.dims.cssH * VOLBAR_HEIGHT_FRAC),
    );
    // Hairline gaps only once bars are wide enough to need them; when a bucket
    // is ~1 px the bars stay contiguous (barcode-free by construction — the
    // strip is ink, not hairlines floating in a void).
    const gap = bw >= 3 ? Math.min(2, bw * 0.25) : 0;
    const barW = Math.max(1, Math.min(VOLBAR_MAX_BAR_PX, bw - gap));
    const yBase = gm.dims.cssH - 1;

    for (let b = 0; b < buckets; b++) {
      const total = buy[b] + sell[b];
      if (total <= 0) continue; // honest gap: no volume, no bar
      const color = barColor(buy[b], sell[b]);
      if (color === null) continue;
      // sqrt lift: monotonic in volume, but the mids read as a histogram
      // instead of a floor of 1-px whiskers; the p90 clamp keeps the top flat
      // like Bookmap's upper cutoff (values above `cap` all reach full height).
      const h = Math.max(VOLBAR_MIN_PX, Math.sqrt(Math.min(1, total / cap)) * stripH);
      const x = xLo + (b + 0.5) * bw;
      text.line(x, yBase, x, yBase - h, color, barW, VOLBAR_ALPHA);
    }
  }
}
