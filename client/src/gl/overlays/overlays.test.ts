import { describe, expect, it } from 'vitest';

import {
  Bubbles,
  bubbleAlpha,
  bubbleRadiusPx,
  histBucketFor,
  refFromHistogram,
  HIST_BUCKETS,
  type BubbleScale,
} from './bubbles';
import { GridMap, type TimeMap } from './coords';
import type { OverlayFrame } from './frame';
import {
  PRICE_GLOW_ALPHA,
  PRICE_GLOW_WIDTH,
  PRICE_LINE_WIDTH,
  PRICE_LEVEL_ALPHA,
  PRICE_LEVEL_DASH,
  PRICE_STUB_ALPHA,
  PriceLine,
  withAlpha,
} from './priceLine';
import { deriveL2Bbo } from './manager';
import { accumulateProfile } from './profile';
import { sessionVwap } from './vwap';
import { makeHybrid, rowToPrice } from '../priceScale';

/**
 * Live BTCUSDT anchor — measured from the owner's own recordings
 * (`~/.flowmap/recordings/binance-spot/BTCUSDT`, 40 part files, n=278 prints):
 *   p50 5.3e-4 · p75 6.4e-3 · p90 3.0e-2 · p95 6.9e-2 · p99 2.5e-1 · max 1.07
 * The adaptive reference lands on p90 ≈ 0.03; the band is 6–24 px diameter.
 */
const LIVE_REF = 0.03;
const BUBBLE_SCALE: BubbleScale = {
  refSize: LIVE_REF,
  baseRadiusPx: 5,
  minRadiusPx: 3,
  maxRadiusPx: 12,
};

describe('bubbleRadiusPx (√-area scaling, 6–24 px band)', () => {
  it('maps the reference (p90) print to the base radius', () => {
    expect(bubbleRadiusPx(LIVE_REF, BUBBLE_SCALE)).toBeCloseTo(5);
  });
  it('scales with √size', () => {
    expect(bubbleRadiusPx(0.12, BUBBLE_SCALE)).toBeCloseTo(10); // 4× size → 2× radius
  });
  it('clamps to the min/max radius', () => {
    expect(bubbleRadiusPx(0, BUBBLE_SCALE)).toBe(3);
    expect(bubbleRadiusPx(1e9, BUBBLE_SCALE)).toBe(12);
  });
  it('spreads the measured live BTC percentiles across the band', () => {
    // p75 → floor (6 px dot), p90 → 10 px, p95 → ~15 px, p99/max → cap (24 px).
    // Pre-F25 (refSize 4, cap 20) EVERY print below ~2 BTC measured 2–4 px of
    // ink (QA19 H5 = 3/10); these pins are the measured calibration.
    expect(bubbleRadiusPx(6.4e-3, BUBBLE_SCALE)).toBe(3);
    expect(bubbleRadiusPx(3.0e-2, BUBBLE_SCALE)).toBeCloseTo(5);
    expect(bubbleRadiusPx(6.9e-2, BUBBLE_SCALE)).toBeCloseTo(5 * Math.sqrt(6.9e-2 / LIVE_REF));
    expect(bubbleRadiusPx(2.5e-1, BUBBLE_SCALE)).toBe(12);
    expect(bubbleRadiusPx(1.07, BUBBLE_SCALE)).toBe(12);
  });
});

describe('adaptive size reference (p90 of the session tape)', () => {
  const ANCHOR = 5n * 250_000_000n;
  const DT = 250_000_000;
  const gm = (): GridMap =>
    new GridMap(
      { colOffset: 0, colScale: 10, rowOffset: 0, rowScale: 100 },
      { drawW: 800, drawH: 400, cssW: 800, cssH: 400 },
      { anchorSeq: 5, anchorT0Ns: ANCHOR, dtNs: DT },
      { p0: 0, step: 0.5 },
    );
  /** ts for a fractional column under the affine above (col 5 = the anchor). */
  const tsOfCol = (col: number): bigint => ANCHOR + BigInt(Math.round((col - 5) * DT));
  const sink = (out: number[]) => ({
    begin: () => {},
    add: (_x: number, _y: number, s: number) => {
      out.push(s);
    },
    flush: () => {},
  });

  it('histBucketFor is monotonic and clamps to the table', () => {
    expect(histBucketFor(0)).toBe(0);
    expect(histBucketFor(1e-9)).toBe(0);
    expect(histBucketFor(1e9)).toBe(HIST_BUCKETS - 1);
    expect(histBucketFor(0.03)).toBeGreaterThan(histBucketFor(0.003));
  });

  it('refFromHistogram returns the p90 bucket centre, 0 when empty', () => {
    const hist = new Uint32Array(HIST_BUCKETS);
    expect(refFromHistogram(hist, 0)).toBe(0);
    hist[histBucketFor(1)] = 10;
    // Bucket resolution is 1/3 decade, so the centre is within ±half a bucket
    // (≈ ×1.47) of the true sample — a ±8% radius effect, not a size error.
    const r = refFromHistogram(hist, 10);
    expect(Math.abs(Math.log10(r))).toBeLessThanOrEqual((16 / HIST_BUCKETS) * 0.5);
  });

  it('a live-shaped tape yields refSize ≈ p90 and spreads the ladder', () => {
    const emitted: number[] = [];
    const b = new Bubbles();
    // 40 floor prints (off-view left — still counted in the histogram) + the
    // ladder, whose two 0.03 prints put p90 on the measured BTC bucket.
    for (let i = 0; i < 40; i++) {
      b.add({ ts_ns: -1_000_000_000n, price: 5, size: 0.0005, side: 1 } as never);
    }
    const ladder = [0.03, 0.03, 0.07, 0.25, 1];
    ladder.forEach((s, i) => {
      b.add({ ts_ns: tsOfCol(5.5 + i), price: 5, size: s, side: i % 2 } as never);
    });
    b.draw({ gm: gm(), points: sink(emitted), resident: null } as unknown as OverlayFrame);

    // Newest first: 1 → cap (24 px), 0.25 → cap, 0.07 → ~14.9, 0.03 → ~9.7.
    expect(emitted).toHaveLength(5);
    expect(emitted[0]).toBeCloseTo(24, 0);
    expect(emitted[1]).toBeCloseTo(24, 0);
    expect(emitted[2]).toBeCloseTo(14.9, 0);
    expect(emitted[3]).toBeCloseTo(9.7, 0);
  });

  it('honours a fixed refSize override', () => {
    const b = new Bubbles({ refSize: 2 });
    expect(b.refSize()).toBe(2);
    b.add({ ts_ns: ANCHOR, price: 5, size: 2, side: 1 } as never);
    expect(b.refSize()).toBe(2); // override wins over the histogram
  });

  it('reset clears the tape and the adaptive reference', () => {
    const b = new Bubbles();
    b.add({ ts_ns: ANCHOR, price: 5, size: 1, side: 1 } as never);
    b.reset();
    expect(b.length).toBe(0);
    expect(b.refSize()).toBe(1); // empty histogram fallback
  });
});

describe('overlap thinning (F25 clutter control)', () => {
  const ANCHOR = 5n * 250_000_000n;
  const DT = 250_000_000;
  const gm = (): GridMap =>
    new GridMap(
      { colOffset: 0, colScale: 10, rowOffset: 0, rowScale: 100 },
      { drawW: 800, drawH: 400, cssW: 800, cssH: 400 },
      { anchorSeq: 5, anchorT0Ns: ANCHOR, dtNs: DT },
      { p0: 0, step: 0.5 },
    );
  const tsOfCol = (col: number): bigint => ANCHOR + BigInt(Math.round((col - 5) * DT));
  const sink = (out: number[]) => ({
    begin: () => {},
    add: (x: number) => {
      out.push(x);
    },
    flush: () => {},
  });

  it('keeps the newest print when two land on the same pixel', () => {
    const xs: number[] = [];
    const b = new Bubbles();
    b.add({ ts_ns: tsOfCol(6), price: 5, size: 1, side: 1 } as never);
    b.add({ ts_ns: tsOfCol(6), price: 5, size: 1, side: 1 } as never);
    b.draw({ gm: gm(), points: sink(xs), resident: null } as unknown as OverlayFrame);
    expect(xs).toHaveLength(1);
  });

  it('keeps prints separated by more than the radius sum', () => {
    const xs: number[] = [];
    const b = new Bubbles();
    b.add({ ts_ns: tsOfCol(6), price: 5, size: 1, side: 1 } as never);
    b.add({ ts_ns: tsOfCol(8), price: 5, size: 1, side: 1 } as never); // 160 px away
    b.draw({ gm: gm(), points: sink(xs), resident: null } as unknown as OverlayFrame);
    expect(xs).toHaveLength(2);
  });

  it('thins a dense chain but never the first print of a frame', () => {
    const xs: number[] = [];
    const b = new Bubbles();
    // 9 prints ~4 px apart (0.05 col at colScale 10) — a chain the radius sum
    // (2×4.8 px at ref≈1) fully covers, so the field thins to a few marks.
    for (let i = 0; i < 9; i++) {
      b.add({ ts_ns: tsOfCol(5.5 + i * 0.05), price: 5, size: 1, side: 1 } as never);
    }
    b.draw({ gm: gm(), points: sink(xs), resident: null } as unknown as OverlayFrame);
    expect(xs.length).toBeGreaterThanOrEqual(1);
    expect(xs.length).toBeLessThan(9);
  });
});

describe('sessionVwap (cumulative num/den)', () => {
  it('divides cumulative price·vol by cumulative vol', () => {
    expect(sessionVwap(200, 2)).toBe(100);
  });
  it('is NaN with an empty denominator (no volume yet)', () => {
    expect(Number.isNaN(sessionVwap(5, 0))).toBe(true);
  });
});

describe('accumulateProfile (volume-by-price over columns)', () => {
  it('sums bid+ask density per row and finds the POC', () => {
    const cols: Record<number, { bid: Float32Array; ask: Float32Array | null }> = {
      0: { bid: Float32Array.from([1, 2, 0, 0]), ask: Float32Array.from([0, 0, 3, 4]) },
      1: { bid: Float32Array.from([1, 2, 0, 0]), ask: Float32Array.from([0, 0, 3, 4]) },
    };
    const r = accumulateProfile(0, 1, 0, 3, (c) => cols[c] ?? null);
    expect(Array.from(r.bins)).toEqual([2, 4, 6, 8]);
    expect(r.max).toBe(8);
    expect(r.pocRow).toBe(3);
    expect(r.rowLo).toBe(0);
  });

  it('skips uncached columns without error', () => {
    const r = accumulateProfile(0, 5, 0, 1, () => null);
    expect(r.max).toBe(0);
    expect(r.pocRow).toBe(-1);
  });

  it('reuses a caller-supplied buffer with identical results (B-8 scratch path)', () => {
    const cols: Record<number, { bid: Float32Array; ask: Float32Array | null }> = {
      0: { bid: Float32Array.from([1, 2, 0, 0]), ask: Float32Array.from([0, 0, 3, 4]) },
      1: { bid: Float32Array.from([1, 2, 0, 0]), ask: Float32Array.from([0, 0, 3, 4]) },
    };
    const get = (c: number) => cols[c] ?? null;
    const fresh = accumulateProfile(0, 1, 0, 3, get);

    // A taller frame first: the scratch grows beyond the next window's need.
    const scratch = new Float64Array(10);
    const reused = accumulateProfile(0, 1, 0, 3, get, undefined, scratch);
    expect(Array.from(reused.bins)).toEqual(Array.from(fresh.bins));
    expect(reused.bins.length).toBe(4); // EXACTLY the window, not the scratch tail
    expect(reused.bins.buffer).toBe(scratch.buffer); // zero-copy reuse
    // Stale tail values from the previous (taller) frame must not leak in.
    scratch[1] = 999;
    const again = accumulateProfile(0, 1, 0, 3, get, undefined, scratch);
    expect(Array.from(again.bins)).toEqual(Array.from(fresh.bins));
  });
});

describe('accumulateProfile — mip-block row bound (survey #4)', () => {
  const ROWS = 16;

  /** A uniform background of 1 with a wall at `wallRow` in every column. */
  function wallGrid(
    cols: number,
    wallRow: number,
    wallVal: number,
  ): (c: number) => { bid: Float32Array; ask: Float32Array | null } | null {
    const perCol = new Map<number, { bid: Float32Array; ask: Float32Array | null }>();
    for (let c = 0; c < cols; c++) {
      const bid = new Float32Array(ROWS).fill(1);
      bid[wallRow] = wallVal;
      perCol.set(c, { bid, ask: null });
    }
    return (c) => perCol.get(c) ?? null;
  }

  it('scans one row per stride and keeps the POC on a block-aligned wall', () => {
    const get = wallGrid(2, 8, 99); // wall at absolute row 8 = a 4-block start
    const full = accumulateProfile(0, 1, 0, ROWS - 1, get);
    expect(full.pocRow).toBe(8);
    expect(full.max).toBe(2 * 99); // two columns — the wall row (background replaced)
    expect(full.sampled, 'stride=1 is the exact pass').toBe(false);

    const sampled = accumulateProfile(0, 1, 0, ROWS - 1, get, undefined, undefined, 4);
    expect(sampled.pocRow).toBe(8); // the max SCANNED cell - the shown profile
    expect(sampled.max).toBe(2 * 99);
    expect(sampled.sampled, 'stride>1 is a subsample (R1-M1 honesty flag)').toBe(true);
    // Unscanned rows stay zero (they are never drawn); the scanned rows are the
    // absolute 4-block starts.
    const nonzero = Array.from(sampled.bins)
      .map((v, i) => (v > 0 ? i : -1))
      .filter((i) => i >= 0);
    expect(nonzero).toEqual([0, 4, 8, 12]);
  });

  it('aligns sampled rows to the ABSOLUTE grid when rowLo is not a multiple', () => {
    const r = accumulateProfile(0, 0, 2, 9, wallGrid(1, 8, 5), undefined, undefined, 4);
    // Window [2,9], stride 4 → absolute rows 4 and 8, NOT 2 + k·4.
    const sampledRows = Array.from(r.bins)
      .map((v, i) => (v > 0 ? i + 2 : -1))
      .filter((i) => i >= 0);
    expect(sampledRows).toEqual([4, 8]);
  });

  it('bounds scanned cells to ceil(span/stride) per column (cost envelope)', () => {
    // A read-counting Float32Array proxy: every numeric index read is one cell.
    let reads = 0;
    const countingCol = (): { bid: Float32Array; ask: Float32Array | null } => {
      const bid = new Float32Array(ROWS).fill(1);
      const proxied = new Proxy(bid, {
        get(target, prop) {
          if (typeof prop === 'string' && /^\d+$/.test(prop)) reads += 1;
          // `target` as the receiver: TypedArray integer-index getters reject a
          // Proxy receiver, and the test only needs the read COUNT.
          return Reflect.get(target, prop, target);
        },
      }) as unknown as Float32Array;
      return { bid: proxied, ask: null };
    };

    reads = 0;
    accumulateProfile(0, 9, 0, ROWS - 1, countingCol); // 10 cols × 16 rows
    expect(reads).toBe(160);

    reads = 0;
    accumulateProfile(0, 9, 0, ROWS - 1, countingCol, undefined, undefined, 4);
    expect(reads).toBe(40); // 10 cols × 4 block-start samples — the display resolution
  });

  it('stride=1 (the default) is bit-identical to the historical full scan', () => {
    const get = wallGrid(3, 7, 42);
    expect(accumulateProfile(0, 2, 0, ROWS - 1, get, undefined, undefined, 1)).toEqual(
      accumulateProfile(0, 2, 0, ROWS - 1, get),
    );
  });

  it('documents the subsample limit: a quiet block can lose to a sampled loud row (R1-M1)', () => {
    // Rows 0..3 each density 1 (true 4-row block sum 4); row 4 density 3
    // (block sum 3). A true block-sum profile would put the POC in the row-0
    // block; the sampled pass sees row 0 (=1) < row 4 (=3) and reports row 4.
    // The divergence is exactly why the result is flagged `sampled` and the
    // overlay prints "≈POC" instead of an exact price claim.
    const bid = Float32Array.from([1, 1, 1, 1, 3, 0, 0, 0]);
    const sampled = accumulateProfile(
      0,
      0,
      0,
      7,
      () => ({ bid, ask: null }),
      undefined,
      undefined,
      4,
    );
    expect(sampled.sampled).toBe(true);
    expect(sampled.pocRow).toBe(4); // sampled winner, NOT the block-sum winner (0)
  });
});

describe('deriveL2Bbo (inside quote from the L2 book)', () => {
  it('picks the highest bid row and lowest ask row', () => {
    const bid = Float32Array.from([1, 2, 0, 0, 0]);
    const ask = Float32Array.from([0, 0, 5, 0, 3]);
    const b = deriveL2Bbo(bid, ask, { p0: 50, step: 0.5 });
    expect(b).not.toBeNull();
    expect(b!.source).toBe('l2');
    expect(b!.bidPx).toBeCloseTo(50 + 1 * 0.5); // highest bid row = 1
    expect(b!.bidSz).toBe(2);
    expect(b!.askPx).toBeCloseTo(50 + 2 * 0.5); // lowest ask row = 2
    expect(b!.askSz).toBe(5);
  });

  it('returns null for an empty book', () => {
    expect(deriveL2Bbo(new Float32Array(4), new Float32Array(4), { p0: 0, step: 1 })).toBeNull();
  });

  it('maps rows through the SCALE accessor on a hybrid grid, not p0 + row·step', () => {
    // Hybrid scale: the raw `p0 + row·step` (core values) is WRONG outside the
    // core — a wing row's price depends on where it sits (coords.ts contract).
    const scale = makeHybrid({ mid: 60_000, rows: 4096, coreRows: 2048, coreStep: 0.5, upMult: 11, dnFloor: 0.01 });
    expect(scale).not.toBeNull();
    const s = scale!;
    const price = { p0: s.coreP0, step: s.coreStep, scale: s };
    const bid = new Float32Array(s.rows);
    const ask = new Float32Array(s.rows);
    const bidRow = s.dnRows; // bottom of the core
    const wingRow = 2; // deep inside the lower LOG wing
    bid[bidRow] = 3;
    ask[wingRow] = 4;
    const b = deriveL2Bbo(bid, ask, price)!;
    expect(b.bidPx).toBe(rowToPrice(s, bidRow));
    expect(b.askPx).toBe(rowToPrice(s, wingRow));
    // The exact assertion of the bug: the old arithmetic disagrees on the wing.
    expect(b.askPx).not.toBeCloseTo(price.p0 + wingRow * price.step, 0);
    // ...while inside the core both agree.
    expect(b.bidPx).toBeCloseTo(price.p0 + (bidRow - s.dnRows) * price.step, 6);
  });
});

describe('L6 price-line ink tuning', () => {
  // Shipped constants this lane intentionally moved (brief L6 §1).
  const VIEW = { colOffset: 0, colScale: 10, rowOffset: 0, rowScale: 100 };
  const DIMS = { drawW: 800, drawH: 400, cssW: 800, cssH: 400 };
  const PRICE = { p0: 0, step: 0.5 };
  const TIME: TimeMap = { anchorSeq: 5, anchorT0Ns: 5n * 250_000_000n, dtNs: 250_000_000 };

  it('pins the tightened widths/alphas (no area-wash constant — F4 removed it)', () => {
    expect(PRICE_LINE_WIDTH).toBe(2.0);
    expect(PRICE_GLOW_WIDTH).toBe(6.0);
    expect(PRICE_GLOW_ALPHA).toBe(0.16);
    expect(PRICE_LEVEL_ALPHA).toBe(0.28);
    expect(PRICE_STUB_ALPHA).toBe(0.7);
    expect(PRICE_LEVEL_DASH).toEqual([3, 6]);
  });

  it('withAlpha re-stamps alpha and keeps the rgb channels', () => {
    expect(withAlpha('rgba(210, 225, 245, 0.07)', 0.09)).toBe('rgba(210, 225, 245, 0.09)');
    expect(withAlpha('#ff00aa', 0.3)).toBe('rgba(255, 0, 170, 0.3)');
    expect(withAlpha('not-a-color', 0.5)).toBe('not-a-color');
  });

  it('draw paints glow/stub/core/level and NEVER an area fill (F4: QA3 H-1 wash removed)', () => {
    const g = new GridMap(VIEW, DIMS, TIME, PRICE);
    const pl = new PriceLine();
    pl.add({ col_seq: 4, c: 5 } as never);
    pl.add({ col_seq: 5, c: 7 } as never);
    const fill: string[] = [];
    const dash: Array<{ color: string; pattern?: number[] }> = [];
    const lines: Array<{ width: number; alpha?: number }> = [];
    const text = {
      fillUnder: (_p: unknown[], _yBase: number, top: string) => {
        // The full-height wash was the measured defect (luma ~25 vs bg 7.8,
        // tiling over reconstruct). Any call here is a regression.
        fill.push(top);
      },
      polyline: (_p: unknown[], o: { width: number; alpha?: number }) => {
        lines.push({ width: o.width, alpha: o.alpha });
      },
      dashedLine: (
        _x0: number,
        _y0: number,
        _x1: number,
        _y1: number,
        color: string,
        pattern?: number[],
      ) => {
        dash.push({ color, pattern });
      },
    };
    pl.draw({ gm: g, text, resident: null } as unknown as OverlayFrame);

    expect(fill).toEqual([]); // NO area wash — the line + glow carry the trace
    expect(lines[0]).toEqual({ width: 6, alpha: 0.16 }); // glow (softened W6 swarm2)
    expect(lines[1]).toEqual({ width: 2, alpha: 0.7 }); // right-edge stub
    expect(lines[2]).toEqual({ width: 2, alpha: undefined }); // bright core
    expect(dash[0].color).toBe('rgba(245, 248, 252, 0.28)'); // quieter level
    expect(dash[0].pattern).toEqual([3, 6]); // calmer long-dash texture
    // The call must hand the layer a FRESH array — canvas dash state is sticky,
    // and the exported readonly const must never be mutated by a caller.
    expect(dash[0].pattern).not.toBe(PRICE_LEVEL_DASH);
  });
});

describe('L6 bubble ink (alpha cap via the palette path)', () => {
  it('caps the palette alpha at 0.85, hue untouched, and leaves low alphas alone', () => {
    expect(bubbleAlpha([0.12, 0.71, 0.65, 0.95])).toBe(0.85);
    expect(bubbleAlpha([0.88, 0.33, 0.33, 0.8])).toBe(0.8);
  });

  it('draw emits the capped alpha into the point batch', () => {
    const g = new GridMap(
      { colOffset: 0, colScale: 10, rowOffset: 0, rowScale: 100 },
      { drawW: 800, drawH: 400, cssW: 800, cssH: 400 },
      { anchorSeq: 5, anchorT0Ns: 5n * 250_000_000n, dtNs: 250_000_000 },
      { p0: 0, step: 0.5 },
    );
    const ink: number[][] = [];
    const points = {
      begin: () => {},
      add: (_x: number, _y: number, _s: number, c: readonly number[]) => {
        ink.push([...c]);
      },
      flush: () => {},
    };
    const b = new Bubbles();
    b.add({ ts_ns: 5n * 250_000_000n, price: 5, size: 60, side: 1 } as never);
    b.draw({ gm: g, points, resident: null } as unknown as OverlayFrame);
    expect(ink).toHaveLength(1);
    expect(ink[0][3]).toBeLessThanOrEqual(0.85);
    expect(ink[0][3]).toBeGreaterThan(0);
  });
});
