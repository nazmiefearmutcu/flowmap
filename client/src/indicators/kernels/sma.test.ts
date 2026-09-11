/**
 * Streaming SMA kernel vs the old branch's golden math. The naive reference is
 * a deliberate per-window re-sum (O(n·period)) so it cannot drift with the
 * kernel's rolling accumulator.
 */

import { describe, expect, it } from 'vitest';

import { createSma } from './sma';
import type { CandleInput } from './types';

function closes(values: number[]): CandleInput[] {
  return values.map((c) => ({ o: c, h: c, l: c, c, v: 1 }));
}

function naiveSma(values: number[], period: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    let s = 0;
    for (let j = i - period + 1; j <= i; j += 1) s += values[j];
    return Number.isNaN(s) ? null : s / period;
  });
}

describe('sma kernel', () => {
  it('matches the naive reference on the old golden sequence', () => {
    const values = [2, 4, 6, 8, 10];
    const k = createSma(3);
    const got = closes(values).map((c) => k.push(c)[0]);
    const want = naiveSma(values, 3);
    expect(got).toEqual([null, null, 4, 6, 8]);
    for (let i = 0; i < want.length; i += 1) {
      if (want[i] === null) expect(got[i]).toBeNull();
      else expect(got[i]).toBeCloseTo(want[i] as number, 12);
    }
  });

  it('emits nulls through a NaN window and recovers once it exits', () => {
    const values = [1, 2, Number.NaN, 4, 5, 6];
    const k = createSma(3);
    const got = closes(values).map((c) => k.push(c)[0]);
    expect(got).toEqual([null, null, null, null, null, 5]);
    expect(got[5]).toBeCloseTo(5, 12); // (4+5+6)/3 — clean, not NaN-poisoned
  });

  it('period 1 is the identity', () => {
    const k = createSma(1);
    expect(closes([5, -3, 42]).map((c) => k.push(c)[0])).toEqual([5, -3, 42]);
  });

  it('reset clears state and replays identically', () => {
    const values = closes([1, 2, 3, 4, 5, 6, 7, 8]);
    const k = createSma(4);
    values.forEach((c) => k.push(c));
    k.reset();
    const again = values.map((c) => k.push(c)[0]);
    const fresh = createSma(4);
    expect(again).toEqual(values.map((c) => fresh.push(c)[0]));
  });

  it('peek mirrors push without committing', () => {
    const k = createSma(3);
    k.push(closes([2, 4])[0]);
    k.push(closes([2, 4])[1]);
    expect(k.peek({ o: 6, h: 6, l: 6, c: 6, v: 1 })[0]).toBe(4);
    expect(k.peek({ o: 6, h: 6, l: 6, c: 6, v: 1 })[0]).toBe(4); // still 4 — no commit
    expect(k.push({ o: 6, h: 6, l: 6, c: 6, v: 1 })[0]).toBe(4);
  });

  it('rejects invalid periods', () => {
    expect(() => createSma(0)).toThrow(RangeError);
    expect(() => createSma(2.5)).toThrow(RangeError);
  });
});
