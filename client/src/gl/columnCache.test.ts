import { afterEach, describe, expect, it, vi } from 'vitest';

import { COLUMN_CACHE_PAGE_SLOTS, ColumnCache } from './columnCache';

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

describe('ring-parity slot eviction (pool storage)', () => {
  it('never exceeds capacity and evicts by slot = colSeq mod capacity (ring wrap parity)', () => {
    const c = new ColumnCache({ capacity: 3 });
    for (const s of [1, 2, 3]) c.put(s, new Float32Array([s]), null, BigInt(s));
    expect(c.size).toBe(3);

    // Slot(4) = 1 → writing col 4 clobbers col 1, exactly like the GPU ring wrap.
    c.put(4, new Float32Array([4]), null, 4n);
    expect(c.size).toBe(3);
    expect(c.has(1)).toBe(false);
    expect(c.has(2)).toBe(true);
    expect(c.has(3)).toBe(true);
    expect(c.has(4)).toBe(true);

    // The wrapped window is contiguous: cols 2,3,4 in slots 2,0,1.
    expect(c.sizeAt(2, 0)).toEqual({ bid: 2, ask: 0 });
    expect(c.sizeAt(3, 0)).toEqual({ bid: 3, ask: 0 });
    expect(c.sizeAt(4, 0)).toEqual({ bid: 4, ask: 0 });
  });

  it('a wrapped-away column reads as absent (stale slot ≠ that column)', () => {
    const c = new ColumnCache({ capacity: 2 });
    c.put(10, new Float32Array([1]), null, 0n);
    c.put(12, new Float32Array([2]), null, 0n); // slot 0 — replaces col 10
    expect(c.has(10)).toBe(false); // slot 0 now belongs to col 12
    expect(c.has(12)).toBe(true);
    expect(c.timeAt(10)).toBeNull();
    expect(c.timeAt(12)).not.toBeNull();
  });

  it('re-putting the in-progress column refreshes it in place (no growth)', () => {
    const c = new ColumnCache({ capacity: 4 });
    c.put(10, new Float32Array([1, 1]), null, 100n);
    c.put(10, new Float32Array([9, 9]), null, 200n); // in-progress re-send
    expect(c.size).toBe(1);
    expect(c.sizeAt(10, 0, 2)).toEqual({ bid: 18, ask: 0 });
    expect(c.timeAt(10)).toBe(200n);
  });

  it('SIZED TO THE RING: a full wrap cycle keeps the newest ring-width of columns', () => {
    const c = new ColumnCache({ capacity: 16 });
    for (let s = 0; s < 40; s++) c.put(s, Float32Array.of(s), null, BigInt(s));
    expect(c.size).toBe(16);
    for (let s = 24; s < 40; s++) expect(c.has(s), `col ${s}`).toBe(true);
    for (let s = 0; s < 24; s++) expect(c.has(s), `col ${s}`).toBe(false);
  });
});

describe('pool storage — allocation-free steady-state append', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('put copies into ONE preallocated pool: no buffer slicing, no pool replacement', () => {
    const c = new ColumnCache({ capacity: 8 });
    const rows = 4;
    // Warm up: the pool is allocated lazily on the first put.
    c.put(0, new Float32Array(rows), new Float32Array(rows), 0n);
    const byteLength = c.byteLength;
    expect(byteLength).toBeGreaterThan(0);

    // The allocation spy: pool writes are plain typed-array copies. Anything
    // that sliced a fresh ArrayBuffer per column (the old decode path the
    // cache used to retain) would show up here.
    const sliceSpy = vi.spyOn(ArrayBuffer.prototype, 'slice');

    // Wrap the ring twice (16 puts over 8 slots): steady state.
    for (let s = 1; s <= 16; s++) {
      const bid = new Float32Array(rows);
      const ask = new Float32Array(rows);
      bid[s % rows] = s;
      ask[s % rows] = 2 * s;
      c.put(s, bid, ask, BigInt(s), 1);
    }

    expect(sliceSpy).not.toHaveBeenCalled();
    expect(c.size).toBe(8);
    expect(c.byteLength).toBe(byteLength); // pool + metadata: FIXED footprint

    // Exactness survives the copies (spot-check the newest window).
    expect(c.sizeAt(16, 16 % rows)).toEqual({ bid: 16, ask: 32 });
    expect(c.timeAt(16)).toBe(16n);
    expect(c.epochAt(16)).toBe(1);
  });

  it('arrays() returns views INTO the pool that read the copied values', () => {
    const c = new ColumnCache({ capacity: 4 });
    const { bid, ask } = ramp(8);
    c.put(100, bid, ask, 5n);
    const a = c.arrays(100);
    expect(a).not.toBeNull();
    expect(Array.from(a!.bid)).toEqual(Array.from(bid));
    expect(Array.from(a!.ask!)).toEqual(Array.from(ask));
    expect(a!.bid.length).toBe(8);
    expect(a!.ask!.length).toBe(8);
  });

  it('a row-count change re-allocates the pool (grid-geometry change defense)', () => {
    const c = new ColumnCache({ capacity: 4 });
    c.put(1, new Float32Array(8), null, 0n);
    expect(c.has(1)).toBe(true);
    c.put(2, new Float32Array(16), null, 0n); // different rows → pool rebuilt
    expect(c.has(1)).toBe(false); // old slots did not survive the rebuild
    expect(c.has(2)).toBe(true);
    expect(c.size).toBe(1);
  });
});

describe('paged pool — lazy per-page allocation (fix 2026-09-10 F1-1)', () => {
  const ROWS = 64;
  const PAGE_BYTES = COLUMN_CACHE_PAGE_SLOTS * ROWS * 2 * 4; // one resident page

  function metaBytes(c: ColumnCache): number {
    return c.byteLength - c.residentPageCount * PAGE_BYTES;
  }

  it('a boot-sized cache with fewer puts than one page holds exactly ONE page', () => {
    // Renderer sizing: capacity = whole ring (16384). Pre-fix this allocated
    // 16384·rows·2 floats on the first put; paged it is exactly one page.
    const c = new ColumnCache({ capacity: 16384 });
    for (let s = 0; s < 5; s++) c.put(s, new Float32Array(ROWS), new Float32Array(ROWS), 0n);
    expect(c.residentPageCount).toBe(1);
    expect(c.byteLength).toBe(metaBytes(c) + PAGE_BYTES);
    // ...and nowhere near the whole-ring pool (16384·64·2·4 = 8 MiB of pages).
    expect(c.byteLength).toBeLessThan(metaBytes(c) + (16384 / COLUMN_CACHE_PAGE_SLOTS) * PAGE_BYTES);
  });

  it('pages allocate on first touch only — re-puts into resident pages never allocate', () => {
    const c = new ColumnCache({ capacity: 1024 }); // 4 pages of 256
    c.put(0, new Float32Array(ROWS), null, 0n);
    expect(c.residentPageCount).toBe(1);
    expect(c.byteLength).toBe(metaBytes(c) + PAGE_BYTES);

    // 3 more pages touched by seq (slots 256/512/768), then a full ring wrap of
    // RE-puts into already-resident pages: zero new pages, fixed footprint.
    for (const s of [256, 512, 768]) c.put(s, new Float32Array(ROWS), null, 0n);
    expect(c.residentPageCount).toBe(4);
    const resident = c.byteLength;
    for (let s = 0; s < 1024; s++) c.put(s % 1024, new Float32Array(ROWS), null, 0n);
    expect(c.residentPageCount).toBe(4);
    expect(c.byteLength).toBe(resident);
  });

  it('a row-count change releases every page; reset() releases every page', () => {
    const c = new ColumnCache({ capacity: 600 });
    c.put(1, new Float32Array(ROWS), null, 0n);
    c.put(300, new Float32Array(ROWS), null, 0n); // second page
    expect(c.residentPageCount).toBe(2);
    c.put(2, new Float32Array(ROWS * 2), null, 0n); // rows changed → all old pages freed
    // The row-change put re-allocates only ITS OWN page; the two old-geometry
    // pages were released and their columns dropped.
    expect(c.residentPageCount).toBe(1);
    expect(c.has(1)).toBe(false);
    expect(c.has(300)).toBe(false);
    expect(c.size).toBe(1);
    // Only the touched page of the new geometry comes back.
    c.put(30, new Float32Array(ROWS * 2), null, 0n);
    expect(c.residentPageCount).toBe(1);
    c.reset();
    expect(c.residentPageCount).toBe(0);
    expect(c.byteLength).toBe(metaBytes(c));
  });

  it('values stay exact across page boundaries (slot addressing = slot & 255)', () => {
    const c = new ColumnCache({ capacity: 512 });
    const mk = (v: number): Float32Array => {
      const a = new Float32Array(1);
      a[0] = v;
      return a;
    };
    c.put(254, mk(254), null, 254n); // page 0, near its end
    c.put(255, mk(255), null, 255n); // page 0, last slot
    c.put(256, mk(256), null, 256n); // page 1, first slot
    c.put(510, mk(510), null, 510n); // page 1
    expect(c.sizeAt(254, 0)).toEqual({ bid: 254, ask: 0 });
    expect(c.sizeAt(255, 0)).toEqual({ bid: 255, ask: 0 });
    expect(c.sizeAt(256, 0)).toEqual({ bid: 256, ask: 0 });
    expect(c.sizeAt(510, 0)).toEqual({ bid: 510, ask: 0 });
    expect(c.arrays(256)!.bid[0]).toBe(256);
    expect(c.timeAt(256)).toBe(256n);
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
  it('empties the cache and releases the pool (session switch re-allocates)', () => {
    const c = new ColumnCache();
    const metaBytes = c.byteLength; // slot metadata exists from the constructor
    expect(metaBytes).toBeGreaterThan(0);
    c.put(1, new Float32Array([1]), null, 0n);
    expect(c.byteLength).toBeGreaterThan(metaBytes); // the pool is retained
    c.reset();
    expect(c.size).toBe(0);
    expect(c.has(1)).toBe(false);
    expect(c.byteLength).toBe(metaBytes); // pool released; metadata persists
  });
});
