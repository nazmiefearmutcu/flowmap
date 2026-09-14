/**
 * VolBars unit tests (swarm2 wave 4 F26 — Bookmap H7 volume strip).
 *
 * The bucket MATH is the contract: aggregation into screen buckets (with the
 * reconstructed-candle SPAN spread), the dominant-side color choice, honest
 * absence (no split -> no bar), prune/reset bounds, and the draw pass (p90 +
 * sqrt heights, bottom-anchored, gaps stay gaps). The draw test uses a
 * recording text-stub, so no canvas/GL is needed.
 */

import { describe, expect, it } from 'vitest';

import {
  VOLBAR_ALPHA,
  VOLBAR_MAX_BAR_PX,
  VOLBAR_MIN_STRIP_PX,
  VolBars,
  barColor,
  scatterVolumes,
  type VolBarPoint,
} from './volbars';
import { OVERLAY } from './palette';
import { GridMap, type SurfaceDims, type TimeMap, type PriceMap } from './coords';
import type { OverlayFrame } from './frame';
import type { BarColumn } from '../../proto/types';
import type { HeatmapView } from '../heatmap';

function pt(col: number, buy: number, sell: number, span = 1): VolBarPoint {
  return { col, buy, sell, span };
}

/** A BarColumn carrying only the fields the strip reads. */
function bar(col: number, volBuy: number, volSell: number): BarColumn {
  return { col_seq: col, vol_buy: volBuy, vol_sell: volSell } as unknown as BarColumn;
}

interface LineCall {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  width: number;
  alpha: number;
}

interface Harness {
  frame: OverlayFrame;
  calls: LineCall[];
}

/**
 * Frame with a recording text stub over a REAL GridMap. Defaults: 10 columns
 * ([0..9]) mapped across the full 100 CSS px canvas → one bucket per column,
 * 10-px buckets, resident clamp [0..9].
 */
function harness(
  view?: Partial<HeatmapView>,
  dims?: Partial<SurfaceDims>,
  resident: { oldest: number; newest: number } | null = { oldest: 0, newest: 9 },
): Harness {
  const calls: LineCall[] = [];
  const v = { colOffset: 0, colScale: 10, rowOffset: 0, rowScale: 10, ...view } as HeatmapView;
  const d: SurfaceDims = { drawW: 100, drawH: 100, cssW: 100, cssH: 100, ...dims };
  const gm = new GridMap(v, d, null as TimeMap | null, null as PriceMap | null);
  const text = {
    line: (x0: number, y0: number, x1: number, y1: number, color: string, width: number, alpha: number) => {
      calls.push({ x0, y0, x1, y1, color, width, alpha });
    },
  };
  const frame = { gm, text, resident } as unknown as OverlayFrame;
  return { frame, calls };
}

describe('scatterVolumes (bucket math)', () => {
  it('maps columns to equal-width buckets and sums each side', () => {
    const buy = new Float64Array(5);
    const sell = new Float64Array(5);
    // span 10 (cols 0..9) over 5 buckets -> 2 columns per bucket.
    const max = scatterVolumes(
      [pt(0, 1, 2), pt(1, 3, 0), pt(2, 0, 4), pt(9, 5, 5)],
      0,
      9,
      buy,
      sell,
    );
    expect(Array.from(buy)).toEqual([4, 0, 0, 0, 5]);
    expect(Array.from(sell)).toEqual([2, 4, 0, 0, 5]);
    expect(max).toBe(10); // bucket 4 total = 5 + 5
  });

  it('spreads a span-k point evenly across k columns (reconstructed candles)', () => {
    const buy = new Float64Array(5);
    const sell = new Float64Array(5);
    // One candle bar: 8 buy over 4 columns (cols 0..3), 5 buckets of 2 columns.
    const max = scatterVolumes([pt(0, 8, 0, 4)], 0, 9, buy, sell);
    expect(Array.from(buy)).toEqual([4, 4, 0, 0, 0]);
    expect(max).toBe(4);
  });

  it('ignores columns outside the range and non-finite volumes', () => {
    const buy = new Float64Array(2);
    const sell = new Float64Array(2);
    const max = scatterVolumes(
      [pt(-1, 100, 0), pt(10, 100, 0), pt(3, Number.NaN, 1), pt(4, 1, Number.POSITIVE_INFINITY), pt(8, 2, 1)],
      0,
      9,
      buy,
      sell,
    );
    expect(Array.from(buy)).toEqual([0, 2]);
    expect(Array.from(sell)).toEqual([0, 1]);
    expect(max).toBe(3);
  });

  it('returns 0 for an empty input or a degenerate range', () => {
    const buy = new Float64Array(3);
    const sell = new Float64Array(3);
    expect(scatterVolumes([], 0, 9, buy, sell)).toBe(0);
    expect(scatterVolumes([pt(0, 1, 1)], 5, 4, buy, sell)).toBe(0);
  });
});

describe('barColor (dominant side)', () => {
  it('picks the buy token when buy dominates, sell otherwise, buy on ties', () => {
    expect(barColor(3, 1)).toBe(OVERLAY.buy.css);
    expect(barColor(0, 2)).toBe(OVERLAY.sell.css);
    expect(barColor(2, 2)).toBe(OVERLAY.buy.css);
  });

  it('returns null for an empty (no-volume) bucket', () => {
    expect(barColor(0, 0)).toBeNull();
    expect(barColor(Number.NaN, Number.NaN)).toBeNull();
  });
});

describe('VolBars data store', () => {
  it('stores only columns WITH a taker split (honest absence)', () => {
    const vb = new VolBars();
    vb.add(bar(1, 0, 0)); // keyless equity / SIDE_UNKNOWN only
    vb.add(bar(2, Number.NaN, Number.NaN)); // absent fields
    expect(vb.size).toBe(0);
    expect(vb.valueAt(1)).toBeNull();
    vb.add(bar(3, 2.5, 1));
    expect(vb.size).toBe(1);
    expect(vb.valueAt(3)).toMatchObject({ col: 3, buy: 2.5, sell: 1 });
  });

  it('clamps negative volumes to zero and still stores a nonzero counterpart', () => {
    const vb = new VolBars();
    vb.add(bar(4, -5, 2));
    expect(vb.valueAt(4)).toMatchObject({ col: 4, buy: 0, sell: 2 });
  });

  it('infers a reconstructed candle span from the NEXT bar event; live stays 1', () => {
    const vb = new VolBars();
    vb.add(bar(0, 8, 2)); // candle A (1-minute stretch keyed to its first column)
    vb.add(bar(16, 0, 0)); // candle B: zero split -> closes A's span, not stored
    vb.add(bar(32, 4, 1)); // candle C
    expect(vb.valueAt(0)!.span).toBe(16);
    expect(vb.valueAt(16)).toBeNull(); // zero-split candle: honest gap
    expect(vb.valueAt(32)!.span).toBe(1); // still open -> default
    // Live columns: every event closes a span of 1.
    vb.add(bar(33, 3, 1));
    expect(vb.valueAt(32)!.span).toBe(1);
  });

  it('prunes outside [oldest-pad, newest+pad] and reset() clears', () => {
    const vb = new VolBars();
    for (const c of [0, 5, 10, 15]) vb.add(bar(c, 1, 1));
    vb.prune(5, 10, 2); // keep 3..12
    expect(vb.size).toBe(2);
    expect(vb.valueAt(5)).not.toBeNull();
    expect(vb.valueAt(10)).not.toBeNull();
    expect(vb.valueAt(0)).toBeNull();
    expect(vb.valueAt(15)).toBeNull();
    vb.reset();
    expect(vb.size).toBe(0);
  });
});

describe('VolBars.draw (bottom strip pass)', () => {
  it('draws nothing without data (no fake bars)', () => {
    const vb = new VolBars();
    const { frame, calls } = harness();
    vb.draw(frame);
    expect(calls).toHaveLength(0);
  });

  it('draws one bottom-anchored bar per non-empty bucket, height by the visible p90 + sqrt curve', () => {
    const vb = new VolBars();
    vb.add(bar(0, 10, 0)); // bucket 0, total 10 (the visible p90 cap)
    vb.add(bar(1, 0, 5)); // bucket 1, total 5 (half the cap)
    const { frame, calls } = harness();
    vb.draw(frame);

    expect(calls).toHaveLength(2);
    const [a, b] = calls;
    // Bucket 0: centre x = 0 + 0.5*10 = 5; yBase = cssH - 1 = 99.
    expect(a.x0).toBe(5);
    expect(a.x1).toBe(5);
    expect(a.y0).toBe(99);
    expect(a.y1).toBe(99 - VOLBAR_MIN_STRIP_PX); // at/above the cap -> full height
    expect(a.color).toBe(OVERLAY.buy.css);
    expect(a.alpha).toBe(VOLBAR_ALPHA);
    expect(a.width).toBe(Math.min(VOLBAR_MAX_BAR_PX, 10 - 2)); // gap 2 when wide
    // Bucket 1: sqrt(0.5) of the strip (monotonic lift of the mids), sell color.
    expect(b.x0).toBe(15);
    expect(b.y1).toBeCloseTo(99 - Math.sqrt(0.5) * VOLBAR_MIN_STRIP_PX, 6);
    expect(b.color).toBe(OVERLAY.sell.css);
  });

  it('clamps a whale to full height instead of crushing the other bars (auto-contrast)', () => {
    const vb = new VolBars();
    for (let c = 0; c < 9; c++) vb.add(bar(c, c + 1, 0)); // totals 1..9
    vb.add(bar(9, 100, 0)); // one whale: linear-vs-max would crush everything
    const { frame, calls } = harness();
    vb.draw(frame);

    expect(calls).toHaveLength(10);
    expect(calls[9].y1).toBe(99 - VOLBAR_MIN_STRIP_PX); // whale -> clamped full
    // The p90 cap (~9) keeps the mids readable: total 4 -> sqrt(4/9) of the strip.
    const mid = calls[3];
    expect(mid.y1).toBeCloseTo(99 - Math.sqrt(4 / 9) * VOLBAR_MIN_STRIP_PX, 6);
  });

  it('spreads a reconstructed candle across its columns (no 16x spike)', () => {
    const vb = new VolBars();
    // Candle A: 16 buy over a 16-column stretch, keyed to col 0.
    vb.add(bar(0, 16, 0));
    vb.add(bar(16, 0, 0)); // next candle event closes A's span
    vb.add(bar(16, 4, 0)); // candle B: a live-scale bucket for comparison
    const { frame, calls } = harness();
    vb.draw(frame);
    // A is now spread evenly: cols 0..15 each carry 1 buy -> buckets 0..9.
    expect(calls.length).toBe(10);
    // All A buckets (0..9) have equal height; B (col 16, bucket 16) is out of
    // the resident clamp here, so every drawn bucket is an A slice of 1.
    for (const c of calls) expect(c.y1).toBe(99 - VOLBAR_MIN_STRIP_PX);
  });

  it('aggregates per pixel when the view is wider than the canvas; gaps stay gaps', () => {
    const vb = new VolBars();
    // 10 visible columns over a 5-px canvas -> 5 buckets of 2 columns.
    vb.add(bar(0, 1, 1));
    vb.add(bar(1, 2, 0)); // joins bucket 0 -> total 4
    for (let c = 2; c <= 6; c++) vb.add(bar(c, 0, 0)); // no trades: span closers only
    vb.add(bar(7, 3, 0)); // bucket 3
    const { frame, calls } = harness(undefined, { cssW: 5 });
    vb.draw(frame);
    expect(calls).toHaveLength(2); // buckets 1,2,4 stay empty: no ink
    // Bucket width 1 px: centre = xLo + (b + 0.5) * bw.
    expect(calls[0].x0).toBe(0.5);
    expect(calls[1].x0).toBe(3.5);
    expect(calls[0].width).toBe(1);
    expect(calls[0].color).toBe(OVERLAY.buy.css); // 3 buy vs 1 sell
  });

  it('skips columns outside the resident clamp (honest gap)', () => {
    const vb = new VolBars();
    vb.add(bar(1, 5, 0));
    for (let c = 2; c <= 7; c++) vb.add(bar(c, 0, 0));
    vb.add(bar(8, 5, 0));
    const { frame, calls } = harness(undefined, undefined, { oldest: 5, newest: 9 });
    vb.draw(frame);
    expect(calls).toHaveLength(1);
    // Resident lo=5 -> xLo = cssX(5) = 50; col 8 lands in bucket 3 of 5.
    expect(calls[0].x0).toBe(85);
  });

  it('never draws more buckets than canvas pixels (perf bound)', () => {
    const vb = new VolBars();
    for (let c = 0; c < 10; c++) vb.add(bar(c, 1, 0));
    const { frame, calls } = harness(undefined, { cssW: 3 });
    vb.draw(frame);
    expect(calls.length).toBeLessThanOrEqual(3);
  });
});
