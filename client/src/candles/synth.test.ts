import { describe, expect, it } from 'vitest';

import { createCandleSynth, DEFAULT_RING, DUP_WINDOW } from './synth';

const MIN = 60_000_000_000; // 1 minute in ns

/** Bucket-start helper: the ns of the start of bucket `n` on a 1m grid. */
const t = (minute: number, second = 0): bigint =>
  BigInt(minute) * BigInt(MIN) + BigInt(second) * 1_000_000_000n;

describe('candle synth — golden sequences', () => {
  it('builds one OHLCV candle per minute from a hand-checked trade run', () => {
    const s = createCandleSynth(MIN);
    // Minute 0: 100 → 104 high, 99 low, closes 102. Minute 1: one print 103.
    s.push(t(0, 0), 100, 2);
    s.push(t(0, 10), 104, 1);
    s.push(t(0, 20), 99, 3);
    s.push(t(0, 45), 102, 1.5);
    s.push(t(1, 5), 103, 4);
    const cs = s.candles();
    expect(cs.length).toBe(2);
    expect(cs[0]).toMatchObject({ o: 100, h: 104, l: 99, c: 102, v: 7.5, trades: 4 });
    expect(cs[0].t0Ns).toBe(0n);
    expect(cs[1]).toMatchObject({ o: 103, h: 103, l: 103, c: 103, v: 4, trades: 1 });
    expect(cs[1].t0Ns).toBe(BigInt(MIN));
    expect(s.count()).toBe(2);
  });

  it('an out-of-order trade merges into its older bucket without stealing the close', () => {
    const s = createCandleSynth(MIN);
    s.push(t(0, 5), 100, 1);
    s.push(t(0, 50), 105, 1); // close so far
    s.push(t(1, 5), 110, 1); // next bucket; the head is now minute 1
    s.push(t(0, 30), 95, 2); // LATE print for minute 0
    const cs = s.candles();
    expect(cs.length).toBe(2);
    expect(cs[0]).toMatchObject({ o: 100, h: 105, l: 95, c: 105 }); // close unchanged
    expect(cs[0].v).toBe(4);
    expect(cs[1].c).toBe(110);
  });

  it('a late trade at a bucket-boundary tie keeps the arrival-ordered close', () => {
    const s = createCandleSynth(MIN);
    s.push(t(0, 30), 100, 1);
    s.push(t(0, 30), 101, 1); // same ts — later arrival owns the close
    expect(s.candles()[0].c).toBe(101);
  });

  it('is idempotent: re-delivering the exact same trade is a no-op', () => {
    const s = createCandleSynth(MIN);
    const run: [bigint, number, number][] = [
      [t(0, 0), 100, 2],
      [t(0, 10), 104, 1],
      [t(0, 20), 99, 3],
      [t(1, 0), 103, 4],
    ];
    for (const [ts, p, v] of run) s.push(ts, p, v);
    const before = s.candles().map((c) => ({ ...c }));
    const verBefore = s.version();
    for (const [ts, p, v] of run) s.push(ts, p, v); // full replay of the last DUP_WINDOW trades
    expect(s.candles()).toEqual(before);
    expect(s.version()).toBe(verBefore);
    expect(s.stats().dupSkipped).toBe(run.length);
  });

  it('dedup covers only the recent window — honest about its reach', () => {
    const s = createCandleSynth(MIN);
    s.push(t(0, 0), 100, 1);
    // Push DUP_WINDOW distinct trades, then re-deliver the FIRST trade: it has
    // fallen out of the suppression window, so it merges again (volume doubles).
    for (let i = 1; i <= DUP_WINDOW; i += 1) s.push(t(1, i), 100 + i, 1);
    s.push(t(0, 0), 100, 1);
    const cs = s.candles();
    expect(cs[0].v).toBe(2); // re-merged: documented, not hidden
    expect(s.stats().dupSkipped).toBe(0);
    // But the o stays intact (merge semantics) and h/l widen correctly.
    expect(cs[0]).toMatchObject({ o: 100, h: 100, l: 100, c: 100 });
  });

  it('drops trades older than the resident window instead of resurrecting buckets', () => {
    const s = createCandleSynth(MIN, 4); // tiny ring to force eviction fast
    for (let i = 0; i < 8; i += 1) s.push(BigInt(i) * BigInt(MIN), 100 + i, 1);
    expect(s.count()).toBe(4);
    const before = s.candles().map((c) => ({ ...c }));
    s.push(t(0, 1), 999, 5); // bucket 0 was evicted long ago
    expect(s.candles()).toEqual(before);
    expect(s.stats().droppedLate).toBe(1);
  });

  it('keeps the newest candle across an eviction (ring slots recycle safely)', () => {
    const s = createCandleSynth(MIN, 4);
    for (let i = 0; i < 6; i += 1) s.push(BigInt(i) * BigInt(MIN), 100 + i, 1);
    const cs = s.candles();
    expect(cs.map((c) => c.bi)).toEqual([2, 3, 4, 5]);
    expect(cs[cs.length - 1].c).toBe(105);
  });

  it('non-finite prices/sizes and negative ts are quarantined', () => {
    const s = createCandleSynth(MIN);
    s.push(t(0, 0), Number.NaN, 1);
    s.push(t(0, 1), 100, Number.NaN);
    s.push(t(0, 2), Number.POSITIVE_INFINITY, 1);
    s.push(-1n, 100, 1);
    expect(s.candles()).toEqual([]);
    expect(s.stats().nonFinite).toBe(4);
  });

  it('gaps between minutes simply do not exist as candles', () => {
    const s = createCandleSynth(MIN);
    s.push(t(0, 0), 100, 1);
    s.push(t(3, 0), 101, 1); // minutes 1-2 silent
    expect(s.candles().map((c) => c.bi)).toEqual([0, 3]);
    expect(s.count()).toBe(2);
  });

  it('setTimeframe rebuilds buckets; same-value noop keeps state', () => {
    const s = createCandleSynth(MIN);
    s.push(t(0, 30), 100, 1);
    s.push(t(1, 30), 101, 1);
    s.setTimeframe(5 * MIN); // buckets are incompatible → the ring resets
    expect(s.candles()).toEqual([]);
    s.push(t(0, 30), 100, 1);
    s.push(t(1, 30), 101, 1);
    expect(s.candles()).toMatchObject([{ o: 100, h: 101, l: 100, c: 101, v: 2, trades: 2 }]);
    const snapshot = s.candles().map((c) => ({ ...c }));
    s.setTimeframe(5 * MIN); // noop — no reset
    expect(s.candles()).toEqual(snapshot);
    expect(() => createCandleSynth(0)).toThrow(RangeError);
    expect(() => createCandleSynth(Number.NaN)).toThrow(RangeError);
  });

  it('reset clears the ring but keeps the timeframe and counters', () => {
    const s = createCandleSynth(MIN);
    s.push(t(0, 0), 100, 1);
    s.reset();
    expect(s.candles()).toEqual([]);
    expect(s.timeframeNs).toBe(MIN);
    s.push(t(5, 0), 50, 1);
    expect(s.candles()).toMatchObject([{ o: 50, c: 50 }]);
    expect(s.stats().merged).toBe(2); // lifetime counters survive reset
  });

  it('handles the default ring size (2000 buckets) end to end', () => {
    const s = createCandleSynth(MIN);
    for (let i = 0; i < DEFAULT_RING + 50; i += 1) {
      s.push(BigInt(i) * BigInt(MIN), 100 + (i % 7), 1);
    }
    expect(s.count()).toBe(DEFAULT_RING);
    const cs = s.candles();
    expect(cs[0].bi).toBe(50);
    expect(cs[cs.length - 1].bi).toBe(DEFAULT_RING + 49);
  });
});
