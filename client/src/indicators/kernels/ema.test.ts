/**
 * Streaming EMA kernel vs the old branch's golden vectors (ema.test.ts, ported):
 * hand-checked chain, seed placement, skip-and-carry NaN policy.
 */

import { describe, expect, it } from 'vitest';

import { createEma } from './ema';
import type { CandleInput } from './types';

function closes(values: number[]): CandleInput[] {
  return values.map((c) => ({ o: c, h: c, l: c, c, v: 1 }));
}

function feed(k: ReturnType<typeof createEma>, values: number[]): (number | null)[] {
  return closes(values).map((c) => k.push(c)[0]);
}

describe('ema kernel', () => {
  it('hand-checked chain: [2,4,6,8,10], period 3 → seed 4, then k=0.5', () => {
    // Seed SMA(2,4,6) = 4 at the 3rd candle; 0.5·8 + 0.5·4 = 6; 0.5·10 + 0.5·6 = 8.
    expect(feed(createEma(3), [2, 4, 6, 8, 10])).toEqual([null, null, 4, 6, 8]);
  });

  it('emits leading nulls and places the seed at index period-1', () => {
    const out = feed(createEma(4), [1, 2, 3, 4, 5, 6]);
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect(out[3]).toBeCloseTo(2.5, 12); // SMA(1..4)
    expect(out[5]).toBeCloseTo(6 * 0.4 + (out[4] as number) * 0.6, 12); // k = 2/5
  });

  it('is the identity for period 1', () => {
    expect(feed(createEma(1), [5, -3, 42, 0])).toEqual([5, -3, 42, 0]);
  });

  it('skip-and-carry: NaN yields null there and state carries forward', () => {
    // Old golden: seed 3 at idx 1; NaN not ingested; 8·(2/3)+3·(1/3) = 19/3.
    expect(feed(createEma(2), [2, 4, Number.NaN, 8])).toEqual([null, 3, null, 19 / 3]);
  });

  it('never poisons: an all-NaN feed stays null', () => {
    expect(feed(createEma(2), [Number.NaN, Number.NaN, Number.NaN])).toEqual([null, null, null]);
  });

  it('cross-checks the streaming form against a batch EMA on a long run', () => {
    // Batch reference: the old branch's exact loop, run over the same closes.
    const values: number[] = [];
    let s = 20260826 >>> 0;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < 300; i += 1) values.push(Math.round(rand() * 1000) / 100);
    const period = 14;
    const k = 2 / (period + 1);
    let ingested = 0;
    let sum = 0;
    let prev = Number.NaN;
    const want = values.map((v) => {
      if (ingested < period) {
        sum += v;
        ingested += 1;
        if (ingested === period) {
          prev = sum / period;
          return prev;
        }
        return null;
      }
      prev = v * k + prev * (1 - k);
      return prev;
    });
    const got = feed(createEma(period), values);
    for (let i = 0; i < want.length; i += 1) expect(got[i]).toBeCloseTo(want[i] as number, 12);
  });

  it('reset replays identically; invalid periods throw', () => {
    const values = closes([1, 2, 3, 4, 5]);
    const k = createEma(3);
    values.forEach((c) => k.push(c));
    k.reset();
    expect(values.map((c) => k.push(c)[0])).toEqual([null, null, 2, 3, 4]);
    expect(() => createEma(0)).toThrow(RangeError);
    expect(() => createEma(1.5)).toThrow(RangeError);
  });
});
