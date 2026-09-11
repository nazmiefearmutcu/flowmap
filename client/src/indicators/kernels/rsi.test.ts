/**
 * Streaming RSI kernel vs the old branch's goldens: hand-derived alternating
 * fractions, degenerate endpoints, the NaN-gap deviation pin, and a naive
 * Wilder reference (shared only in spirit — spelled out independently here).
 */

import { describe, expect, it } from 'vitest';

import { createRsi } from './rsi';
import type { CandleInput } from './types';

function closes(values: (number | null)[]): CandleInput[] {
  return values.map((c) => ({ o: c ?? 0, h: c ?? 0, l: c ?? 0, c: c as number, v: 1 }));
}

function naiveWilder(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  const from = (g: number, l: number): number =>
    l === 0 ? (g === 0 ? 50 : 100) : g === 0 ? 0 : 100 - 100 / (1 + g / l);
  let g = 0;
  let l = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = values[i] - values[i - 1];
    if (d > 0) g += d;
    else l -= d;
  }
  g /= period;
  l /= period;
  out[period] = from(g, l);
  for (let i = period + 1; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    g = (g * (period - 1) + (d > 0 ? d : 0)) / period;
    l = (l * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = from(g, l);
  }
  return out;
}

describe('rsi kernel', () => {
  it('hand-computed alternating case (period 3), ported fractions', () => {
    // values [1,2,3,2,4,3,5]: seed RSI 200/3, then 250/3, 2000/33, 235/3.
    const k = createRsi(3);
    const got = closes([1, 2, 3, 2, 4, 3, 5]).map((c) => k.push(c)[0]);
    const want = [null, null, null, 200 / 3, 250 / 3, 2000 / 33, 235 / 3];
    for (let i = 0; i < want.length; i += 1) {
      if (want[i] === null) expect(got[i]).toBeNull();
      else expect(got[i]).toBeCloseTo(want[i] as number, 12);
    }
  });

  it('degenerate endpoints: rising → 100, falling → 0, flat → 50', () => {
    const up = closes([1, 2, 3, 4, 5, 6, 7, 8]);
    const ku = createRsi(3);
    const gotUp = up.map((c) => ku.push(c)[0]);
    for (let i = 3; i < gotUp.length; i += 1) expect(gotUp[i]).toBe(100);

    const down = closes([9, 8, 7, 6, 5, 4]);
    const kd = createRsi(2);
    const gotDown = down.map((c) => kd.push(c)[0]);
    for (let i = 2; i < gotDown.length; i += 1) expect(gotDown[i]).toBe(0);

    const flat = closes([5, 5, 5, 5, 5]);
    const kf = createRsi(3);
    expect(flat.map((c) => kf.push(c)[0])).toEqual([null, null, null, 50, 50]);
  });

  it('length ≤ period yields all nulls; invalid periods throw', () => {
    const k = createRsi(3);
    expect(closes([1, 2, 3]).map((c) => k.push(c)[0])).toEqual([null, null, null]);
    expect(() => createRsi(0)).toThrow(RangeError);
    expect(() => createRsi(1.5)).toThrow(RangeError);
  });

  it('NaN gap folds to zero change (old deviation pin: [10,11,NaN,12,11] → 100,100,20)', () => {
    const k = createRsi(2);
    const got = closes([10, 11, Number.NaN, 12, 11]).map((c) => k.push(c)[0]);
    expect(got).toEqual([null, null, 100, 100, 20]);
  });

  it('matches the naive Wilder reference on a long mixed series', () => {
    const vals = [10, 11, 10.5, 12, 11.2, 13, 12.1, 14, 13.2, 15, 14, 16, 15.5, 15, 17];
    const k = createRsi(4);
    const got = closes(vals).map((c) => k.push(c)[0]);
    const want = naiveWilder(vals, 4);
    for (let i = 0; i < want.length; i += 1) expect(got[i]).toBeCloseTo(want[i] as number, 12);
  });

  it('peek mirrors push without committing', () => {
    const k = createRsi(2);
    closes([1, 2, 3]).forEach((c) => k.push(c));
    expect(k.push(closes([2])[0])[0]).toBeCloseTo(50, 12);
    k.reset();
    closes([1, 2, 3]).forEach((c) => k.push(c));
    expect(k.peek(closes([2])[0])[0]).toBeCloseTo(50, 12);
    expect(k.peek(closes([2])[0])[0]).toBeCloseTo(50, 12); // uncommitted
  });
});
