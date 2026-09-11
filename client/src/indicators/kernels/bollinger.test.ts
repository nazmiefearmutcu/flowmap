/**
 * Streaming Bollinger kernel vs the old branch's goldens: the hand-checked
 * window (basis 3.8, σ √0.96/… from values 2..5), the flat-window σ=0 clamp,
 * the population-σ (ddof=0) naive reference, and NaN poisoning.
 */

import { describe, expect, it } from 'vitest';

import { createBollinger } from './bollinger';

const MULT = 2;

/** push() returns the kernel's SHARED scratch — snapshot the triple per call. */
function pushAll(
  k: ReturnType<typeof createBollinger>,
  values: number[],
): [number | null, number | null, number | null][] {
  return values.map((c) => {
    const out = k.push({ o: c, h: c, l: c, c, v: 1 });
    return [out[0], out[1], out[2]];
  });
}

/** Naive per-window population-σ reference (ddof=0 — the market standard). */
function naiveSigma(values: number[], period: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    const w = values.slice(i - period + 1, i + 1);
    const mean = w.reduce((a, b) => a + b, 0) / period;
    const dev = w.reduce((a, b) => a + (b - mean) * (b - mean), 0) / period;
    return Number.isNaN(dev) ? null : Math.sqrt(dev);
  });
}

describe('bollinger kernel', () => {
  it('hand-checked sliding windows: population σ, basis ± mult·σ', () => {
    // [2,3,5,4,5] period 4: window {2,3,5,4} mean 3.5, popVar 1.25;
    // window {3,5,4,5} mean 4.25, popVar 0.6875.
    const outs = pushAll(createBollinger(4, MULT), [2, 3, 5, 4, 5]);
    expect(outs[3][0]).toBeCloseTo(3.5, 12);
    expect(outs[3][1]).toBeCloseTo(3.5 + MULT * Math.sqrt(1.25), 12);
    expect(outs[3][2]).toBeCloseTo(3.5 - MULT * Math.sqrt(1.25), 12);
    // Window slides out the 2: {3,5,4,5} mean 4.25, var (1.5625+0.5625+0.0625+0.5625)/4
    expect(outs[4][0]).toBeCloseTo(4.25, 12);
    expect(outs[4][1]).toBeCloseTo(4.25 + MULT * Math.sqrt(0.6875), 12);
  });

  it('bands equal the basis bit-for-bit on a flat window (σ clamp)', () => {
    const outs = pushAll(createBollinger(4, MULT), [7, 7, 7, 7, 7, 7]);
    for (let i = 3; i < outs.length; i += 1) {
      expect(outs[i][0]).toBe(7);
      expect(outs[i][1]).toBe(7);
      expect(outs[i][2]).toBe(7);
    }
  });

  it('matches the naive population-σ reference on a mixed series', () => {
    const vals = [1, 2, 4, 8, 4, 8, 3, 9, 2, 6, 5, 5];
    const outs = pushAll(createBollinger(4, MULT), vals);
    const ref = naiveSigma(vals, 4);
    for (let i = 3; i < vals.length; i += 1) {
      expect(outs[i][0]).toBeCloseTo(vals.slice(i - 3, i + 1).reduce((a, b) => a + b, 0) / 4, 10);
      const s = ref[i] as number;
      expect(outs[i][1]).toBeCloseTo((outs[i][0] as number) + MULT * s, 10);
      expect(outs[i][2]! - (outs[i][0] as number)).toBeCloseTo(-MULT * s, 10);
    }
  });

  it('a NaN inside the window nulls every band until it exits', () => {
    const outs = pushAll(createBollinger(3, MULT), [1, 2, Number.NaN, 4, 5, 6]);
    expect(outs[2][0]).toBeNull();
    expect(outs[3][0]).toBeNull();
    expect(outs[4][0]).toBeNull(); // window {NaN,4,5}
    expect(outs[5][0]).toBe(5); // {4,5,6} — clean
  });

  it('invalid params throw; reset replays identically', () => {
    expect(() => createBollinger(0, 2)).toThrow(RangeError);
    expect(() => createBollinger(20, 0)).toThrow(RangeError);
    expect(() => createBollinger(20, Number.NaN)).toThrow(RangeError);
    const k = createBollinger(3, 2);
    pushAll(k, [1, 2, 3, 4, 5]);
    k.reset();
    const fresh = createBollinger(3, 2);
    expect(pushAll(k, [1, 2, 3, 4, 5])).toEqual(pushAll(fresh, [1, 2, 3, 4, 5]));
  });
});
