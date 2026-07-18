import { describe, expect, it } from 'vitest';

import { bubbleRadiusPx, type BubbleOptions } from './bubbles';
import { deriveL2Bbo } from './manager';
import { accumulateProfile } from './profile';
import { sessionVwap } from './vwap';

const BUBBLE_DEFAULTS: Required<BubbleOptions> = {
  capacity: 6000,
  minSize: 0,
  refSize: 4,
  baseRadiusPx: 5,
  minRadiusPx: 2,
  maxRadiusPx: 26,
};

describe('bubbleRadiusPx (√-area scaling, clamped)', () => {
  it('maps the reference size to the base radius', () => {
    expect(bubbleRadiusPx(4, BUBBLE_DEFAULTS)).toBeCloseTo(5);
  });
  it('scales with √size', () => {
    expect(bubbleRadiusPx(16, BUBBLE_DEFAULTS)).toBeCloseTo(10); // 5·√(16/4)
  });
  it('clamps to the min/max radius', () => {
    expect(bubbleRadiusPx(0, BUBBLE_DEFAULTS)).toBe(2);
    expect(bubbleRadiusPx(1e9, BUBBLE_DEFAULTS)).toBe(26);
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
});
