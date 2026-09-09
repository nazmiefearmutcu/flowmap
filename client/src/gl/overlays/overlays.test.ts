import { describe, expect, it } from 'vitest';

import { bubbleRadiusPx, type BubbleOptions } from './bubbles';
import { deriveL2Bbo } from './manager';
import { accumulateProfile } from './profile';
import { sessionVwap } from './vwap';
import { makeHybrid, rowToPrice } from '../priceScale';

const BUBBLE_DEFAULTS: Required<BubbleOptions> = {
  capacity: 120_000,
  minSize: 0,
  refSize: 4,
  baseRadiusPx: 4.5,
  minRadiusPx: 2.5,
  maxRadiusPx: 20,
};

describe('bubbleRadiusPx (√-area scaling, clamped)', () => {
  it('maps the reference size to the base radius', () => {
    expect(bubbleRadiusPx(4, BUBBLE_DEFAULTS)).toBeCloseTo(4.5);
  });
  it('scales with √size', () => {
    expect(bubbleRadiusPx(16, BUBBLE_DEFAULTS)).toBeCloseTo(9); // 4.5·√(16/4)
  });
  it('clamps to the min/max radius', () => {
    expect(bubbleRadiusPx(0, BUBBLE_DEFAULTS)).toBe(2.5);
    expect(bubbleRadiusPx(1e9, BUBBLE_DEFAULTS)).toBe(20);
  });
  it('keeps small trades as dots and big prints under the cap', () => {
    // size=1: raw 4.5·√(1/4)=2.25 → clamped to the 2.5px minimum (5px dot).
    expect(bubbleRadiusPx(1, BUBBLE_DEFAULTS)).toBe(2.5);
    // size=10: 4.5·√(10/4) ≈ 7.1px.
    expect(bubbleRadiusPx(10, BUBBLE_DEFAULTS)).toBeCloseTo(4.5 * Math.sqrt(10 / 4));
    // size=100: raw 4.5·√(100/4)=22.5 → capped at 20px (40px diameter, was 88px).
    expect(bubbleRadiusPx(100, BUBBLE_DEFAULTS)).toBe(20);
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
