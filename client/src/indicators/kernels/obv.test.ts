/**
 * Streaming OBV kernel vs the old branch's goldens (adapted from volume=1 to
 * real candle volume): up adds, down subtracts, flat holds, first close plants
 * the baseline at 0.
 */

import { describe, expect, it } from 'vitest';

import { createObv } from './obv';
import type { CandleInput } from './types';

function candles(pairs: [close: number, v: number][]): CandleInput[] {
  return pairs.map(([c, v]) => ({ o: c, h: c, l: c, c, v }));
}

function feed(pairs: [number, number][]): (number | null)[] {
  const k = createObv();
  return candles(pairs).map((c) => k.push(c)[0]);
}

describe('obv kernel', () => {
  it('rising closes accumulate volume (old golden [0,1,2,3,4] with v=1)', () => {
    expect(feed([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]])).toEqual([0, 1, 2, 3, 4]);
  });

  it('falling closes subtract (old golden [0,−1,−2,−3])', () => {
    expect(feed([[5, 1], [4, 1], [3, 1], [2, 1]])).toEqual([0, -1, -2, -3]);
  });

  it('weighted volumes and flat closes (old goldens)', () => {
    expect(feed([[1, 10], [2, 10], [3, 10]])).toEqual([0, 10, 20]);
    expect(feed([[1, 5], [2, 5], [1, 5]])).toEqual([0, 5, 0]);
  });

  it('a non-finite close or volume leaves the line null and state untouched', () => {
    const k = createObv();
    k.push(candles([[1, 5]])[0]);
    k.push(candles([[2, 5]])[0]); // cum 5
    expect(k.push({ o: 0, h: Number.NaN, l: 0, c: Number.NaN, v: 5 })[0]).toBeNull();
    expect(k.push(candles([[1, Number.NaN]])[0])[0]).toBeNull();
    // The NaN close became prevClose; a gap close carries the total, no delta.
    expect(k.push(candles([[1, 5]])[0])[0]).toBe(5);
    expect(k.push(candles([[2, 5]])[0])[0]).toBe(10); // and deltas resume from there
  });

  it('peek mirrors push without committing', () => {
    const k = createObv();
    candles([[1, 5], [2, 5]]).forEach((c) => k.push(c));
    expect(k.peek(candles([[3, 5]])[0])[0]).toBe(10);
    expect(k.peek(candles([[3, 5]])[0])[0]).toBe(10);
    expect(k.push(candles([[3, 5]])[0])[0]).toBe(10);
  });

  it('reset replays identically', () => {
    const pairs: [number, number][] = [[1, 5], [2, 5], [1, 5], [2, 7]];
    const k = createObv();
    candles(pairs).forEach((c) => k.push(c));
    k.reset();
    const fresh = createObv();
    expect(candles(pairs).map((c) => k.push(c)[0])).toEqual(
      candles(pairs).map((c) => fresh.push(c)[0]),
    );
  });
});
