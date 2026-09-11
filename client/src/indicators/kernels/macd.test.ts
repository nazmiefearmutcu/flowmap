/**
 * Streaming MACD kernel vs the old branch's goldens: warm-up null counts
 * (macd at slow−1, signal/hist at slow+signal−2), the constant-series
 * convergence (fast EMA → value ⇒ macd → 0), and a naive batch reference.
 */

import { describe, expect, it } from 'vitest';

import { createMacd } from './macd';
import type { CandleInput } from './types';

function closes(values: number[]): CandleInput[] {
  return values.map((c) => ({ o: c, h: c, l: c, c, v: 1 }));
}

type MacdTriple = [number | null, number | null, number | null];

/** push() returns the kernel's SHARED scratch — snapshot the triple per call. */
function pushAll(k: ReturnType<typeof createMacd>, values: number[]): MacdTriple[] {
  return values.map((c) => {
    const out = k.push({ o: c, h: c, l: c, c, v: 1 });
    return [out[0], out[1], out[2]];
  });
}

/** Batch reference: old-branch `macd()` logic, independent loops. */
function batchMacd(values: number[], fast: number, slow: number, signal: number) {
  const emaOf = (period: number, src: number[]): ((number | null)[]) => {
    const kk = 2 / (period + 1);
    const out: (number | null)[] = new Array(src.length).fill(null);
    let seen = 0;
    let acc = 0;
    let prev = Number.NaN;
    for (let i = 0; i < src.length; i += 1) {
      const v = src[i];
      seen += 1;
      if (seen < period) acc += v;
      else if (seen === period) {
        acc += v;
        prev = acc / period;
        out[i] = prev;
      } else {
        prev = v * kk + prev * (1 - kk);
        out[i] = prev;
      }
    }
    return out;
  };
  const f = emaOf(fast, values);
  const s = emaOf(slow, values);
  const line: (number | null)[] = values.map((_, i) =>
    f[i] !== null && s[i] !== null ? (f[i] as number) - (s[i] as number) : null,
  );
  const dense: number[] = [];
  for (const m of line) if (m !== null) dense.push(m);
  const denseSig = emaOf(signal, dense);
  const sig: (number | null)[] = new Array(values.length).fill(null);
  let j = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== null) {
      sig[i] = denseSig[j];
      j += 1;
    }
  }
  const hist: (number | null)[] = values.map((_, i) =>
    line[i] !== null && sig[i] !== null ? (line[i] as number) - (sig[i] as number) : null,
  );
  return { line, sig, hist };
}

describe('macd kernel (12, 26, 9)', () => {
  const FAST = 12;
  const SLOW = 26;
  const SIG = 9;

  it('warm-up nulls: macd at slow−1, signal/hist at slow+signal−2 (old counts)', () => {
    const vals = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const outs = pushAll(createMacd(FAST, SLOW, SIG), vals);
    const leadingNull = (col: number): number => {
      let n = 0;
      while (n < outs.length && outs[n][col] === null) n += 1;
      return n;
    };
    expect(leadingNull(0)).toBe(SLOW - 1); // 25
    expect(leadingNull(1)).toBe(SLOW - 1 + SIG - 1); // 33
    expect(leadingNull(2)).toBe(33);
  });

  it('matches the naive batch reference value-for-value', () => {
    const vals = Array.from({ length: 120 }, (_, i) => 50 + ((i * 37) % 23) / 2);
    const want = batchMacd(vals, FAST, SLOW, SIG);
    const outs = pushAll(createMacd(FAST, SLOW, SIG), vals);
    for (let i = 0; i < vals.length; i += 1) {
      const [m, s, h] = outs[i];
      if (want.line[i] === null) expect(m).toBeNull();
      else expect(m).toBeCloseTo(want.line[i] as number, 10);
      if (want.sig[i] === null) expect(s).toBeNull();
      else expect(s).toBeCloseTo(want.sig[i] as number, 10);
      if (want.hist[i] === null) expect(h).toBeNull();
      else expect(h).toBeCloseTo(want.hist[i] as number, 10);
    }
  });

  it('a constant series converges the MACD line to 0 (old convergence pin)', () => {
    const vals = new Array(200).fill(100);
    const outs = pushAll(createMacd(FAST, SLOW, SIG), vals);
    for (let i = 40; i <= 140; i += 10) expect(outs[i][0]).toBeCloseTo(0, 6);
    expect(Math.abs(outs[199][0] as number)).toBeLessThan(1e-9);
  });

  it('rejects fast >= slow and non-positive periods', () => {
    expect(() => createMacd(26, 12, 9)).toThrow(RangeError);
    expect(() => createMacd(0, 12, 9)).toThrow(RangeError);
    expect(() => createMacd(12, 26, 0)).toThrow(RangeError);
  });

  it('peek mirrors push without committing', () => {
    const kern = createMacd(3, 6, 2);
    closes([1, 2, 3, 4, 5, 6, 7]).forEach((c) => kern.push(c));
    const a = kern.peek(closes([8])[0]).slice() as number[];
    const b = kern.peek(closes([8])[0]).slice() as number[];
    expect(a).toEqual(b); // uncommitted → identical
    const committed = kern.push(closes([8])[0]).slice() as number[];
    expect(a).toEqual(committed);
  });
});
