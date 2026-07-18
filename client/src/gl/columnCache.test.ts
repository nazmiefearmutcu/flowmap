import { describe, expect, it } from 'vitest';

import { ColumnCache } from './columnCache';

/** A column whose bid[r]=r and ask[r]=10*r, for easy exact-sum assertions. */
function ramp(rows: number): { bid: Float32Array; ask: Float32Array } {
  const bid = new Float32Array(rows);
  const ask = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    bid[r] = r;
    ask[r] = 10 * r;
  }
  return { bid, ask };
}

describe('sizeAt — exact resting size', () => {
  it('returns the exact bid/ask at a single cell', () => {
    const c = new ColumnCache();
    const { bid, ask } = ramp(64);
    c.put(1000, bid, ask, 5n);
    expect(c.sizeAt(1000, 7)).toEqual({ bid: 7, ask: 70 });
    expect(c.sizeAt(1000, 0)).toEqual({ bid: 0, ask: 0 });
  });

  it('sums grouped rows (tick grouping / zoom-out)', () => {
    const c = new ColumnCache();
    const { bid, ask } = ramp(64);
    c.put(1000, bid, ask, 5n);
    // rows 4,5,6,7 → bid 4+5+6+7=22, ask 40+50+60+70=220.
    expect(c.sizeAt(1000, 4, 4)).toEqual({ bid: 22, ask: 220 });
  });

  it('clamps a group that runs past the top of the grid', () => {
    const c = new ColumnCache();
    const { bid, ask } = ramp(8); // rows 0..7
    c.put(1, bid, ask, 0n);
    // rowStart 6, group 4 → only rows 6,7 exist: bid 6+7=13, ask 60+70=130.
    expect(c.sizeAt(1, 6, 4)).toEqual({ bid: 13, ask: 130 });
  });

  it('returns null for an uncached column (deep history)', () => {
    const c = new ColumnCache();
    c.put(1000, new Float32Array(8), new Float32Array(8), 0n);
    expect(c.sizeAt(999, 0)).toBeNull();
  });

  it('handles SYNTH_PROFILE (ask null) as ask size 0', () => {
    const c = new ColumnCache();
    const bid = new Float32Array([1, 2, 3, 4]);
    c.put(1, bid, null, 0n);
    expect(c.sizeAt(1, 1, 2)).toEqual({ bid: 5, ask: 0 });
  });
});

describe('metadata lookups', () => {
  it('timeAt / epochAt return the stored values, null when absent', () => {
    const c = new ColumnCache();
    c.put(7, new Float32Array(4), null, 1234567890n, 3);
    expect(c.timeAt(7)).toBe(1234567890n);
    expect(c.epochAt(7)).toBe(3);
    expect(c.timeAt(8)).toBeNull();
    expect(c.epochAt(8)).toBeNull();
  });

  it('has() reflects membership', () => {
    const c = new ColumnCache();
    expect(c.has(1)).toBe(false);
    c.put(1, new Float32Array(2), null, 0n);
    expect(c.has(1)).toBe(true);
  });
});

describe('bounded LRU eviction', () => {
  it('never exceeds capacity and drops least-recently-used columns', () => {
    const c = new ColumnCache({ capacity: 3 });
    for (const s of [1, 2, 3]) c.put(s, new Float32Array([s]), null, BigInt(s));
    expect(c.size).toBe(3);

    c.put(4, new Float32Array([4]), null, 4n); // evicts col 1 (LRU)
    expect(c.size).toBe(3);
    expect(c.has(1)).toBe(false);
    expect(c.has(4)).toBe(true);
  });

  it('a sizeAt read promotes a column so it survives eviction', () => {
    const c = new ColumnCache({ capacity: 3 });
    for (const s of [1, 2, 3]) c.put(s, new Float32Array([s]), null, BigInt(s));
    c.sizeAt(1, 0); // touch col 1 → now most-recently-used; col 2 is LRU
    c.put(4, new Float32Array([4]), null, 4n);
    expect(c.has(1)).toBe(true); // survived
    expect(c.has(2)).toBe(false); // evicted instead
  });

  it('re-putting the in-progress column refreshes it in place (no growth)', () => {
    const c = new ColumnCache({ capacity: 4 });
    c.put(10, new Float32Array([1, 1]), null, 100n);
    c.put(10, new Float32Array([9, 9]), null, 200n); // in-progress re-send
    expect(c.size).toBe(1);
    expect(c.sizeAt(10, 0, 2)).toEqual({ bid: 18, ask: 0 });
    expect(c.timeAt(10)).toBe(200n);
  });
});

describe('prune to the resident window', () => {
  it('drops columns outside [oldest - pad, newest + pad]', () => {
    const c = new ColumnCache({ capacity: 100 });
    for (let s = 0; s < 20; s++) c.put(s, new Float32Array([s]), null, BigInt(s));
    c.prune(5, 12, 1); // keep [4, 13]
    expect(c.has(3)).toBe(false);
    expect(c.has(4)).toBe(true);
    expect(c.has(13)).toBe(true);
    expect(c.has(14)).toBe(false);
    expect(c.size).toBe(10); // cols 4..13
  });
});

describe('reset', () => {
  it('empties the cache', () => {
    const c = new ColumnCache();
    c.put(1, new Float32Array([1]), null, 0n);
    c.reset();
    expect(c.size).toBe(0);
    expect(c.has(1)).toBe(false);
  });
});
