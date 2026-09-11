/**
 * Streaming VWAP kernel vs the old branch's volume-weighted goldens, adapted to
 * typical price (h+l+c)/3: with h=l=c the typical IS the close, so the old
 * `[1,2,3]`-style vectors transfer verbatim; weighted and zero-volume rules
 * are re-pinned with explicit volumes.
 */

import { describe, expect, it } from 'vitest';

import { createVwap } from './vwap';
import type { CandleInput } from './types';

function candles(pairs: [number, number][]): CandleInput[] {
  // [close, volume]; h=l=c so typical == close.
  return pairs.map(([c, v]) => ({ o: c, h: c, l: c, c, v }));
}

function feed(pairs: [number, number][]): (number | null)[] {
  const k = createVwap();
  return candles(pairs).map((c) => k.push(c)[0]);
}

describe('vwap kernel', () => {
  it('unit volume degenerates to the cumulative SMA (old golden [1,1.5,2])', () => {
    expect(feed([[1, 1], [2, 1], [3, 1]])).toEqual([1, 1.5, 2]);
  });

  it('weights by volume (old golden [10, 50/3, 140/6])', () => {
    expect(feed([[10, 1], [20, 2], [30, 3]])).toEqual([10, 50 / 3, 140 / 6]);
  });

  it('zero cumulative volume → null (old golden)', () => {
    expect(feed([[10, 0], [20, 0]])).toEqual([null, null]);
    expect(feed([[10, 0], [20, 1]])).toEqual([null, 20]);
    expect(feed([[10, 1], [20, 0], [30, 1]])).toEqual([10, 10, 20]);
  });

  it('uses the true typical price when h/l differ from the close', () => {
    // Candle: h=12, l=8, c=10 → typical 10; then h=14,l=10,c=14 → typical 38/3.
    const k = createVwap();
    expect(k.push({ o: 9, h: 12, l: 8, c: 10, v: 1 })[0]).toBe(10);
    expect(k.push({ o: 14, h: 14, l: 10, c: 14, v: 1 })[0]).toBeCloseTo((10 + 38 / 3) / 2, 12);
  });

  it('skips non-finite candles without corrupting the cumulants', () => {
    const k = createVwap();
    k.push({ o: 1, h: 1, l: 1, c: 1, v: 1 });
    expect(k.push({ o: 0, h: Number.NaN, l: 0, c: 0, v: 1 })[0]).toBeNull();
    expect(k.push({ o: 1, h: 1, l: 1, c: 1, v: Number.NaN })[0]).toBeNull();
    expect(k.push({ o: 1, h: 1, l: 1, c: 1, v: 1 })[0]).toBe(1); // still the first candle's price
  });

  it('reset re-anchors the session; peek does not commit', () => {
    const k = createVwap();
    k.push(candles([[10, 1]])[0]);
    k.reset();
    expect(k.push(candles([[20, 1]])[0])[0]).toBe(20);
    const k2 = createVwap();
    k2.push(candles([[10, 1]])[0]);
    k2.peek(candles([[20, 1]])[0]);
    expect(k2.push(candles([[20, 1]])[0])[0]).toBe(15); // 20 was never folded in twice
  });
});
