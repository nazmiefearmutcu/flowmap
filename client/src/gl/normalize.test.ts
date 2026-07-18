import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NORM_FLOOR,
  mipSumFactor,
  normMipScale,
  t7ShaderRescale,
  ViewportNormalizer,
  type ColRange,
  type RowRange,
} from './normalize';

const COLS_PER_TILE = 256;
const ALL_ROWS: RowRange = { lo: 0, hi: 2047 };

/** Add one column of `count` identical `value` samples (bid only) at `colSeq`. */
function addConst(n: ViewportNormalizer, colSeq: number, value: number, count: number): void {
  const bid = new Float32Array(count).fill(value);
  n.addColumn(colSeq, bid, null);
}

/** Column range spanning tiles [tileLo, tileHi] inclusive. */
function tilesRange(tileLo: number, tileHi: number): ColRange {
  return { oldest: tileLo * COLS_PER_TILE, newest: tileHi * COLS_PER_TILE + (COLS_PER_TILE - 1) };
}

describe('mip sum-factor coordination with T7', () => {
  it('mipSumFactor is 4^L', () => {
    expect(mipSumFactor(0)).toBe(1);
    expect(mipSumFactor(1)).toBe(4);
    expect(mipSumFactor(2)).toBe(16);
  });

  it("T7's in-shader rescale is the exact inverse (1/4^L)", () => {
    for (const L of [0, 1, 2]) {
      expect(mipSumFactor(L) * t7ShaderRescale(L)).toBeCloseTo(1, 12);
    }
  });

  it('net normalization mip scale is unity at every level (no double-apply)', () => {
    expect(normMipScale(0)).toBe(1);
    expect(normMipScale(1)).toBe(1);
    expect(normMipScale(2)).toBe(1);
  });
});

describe('viewport percentile — histogram merge correctness', () => {
  it('reads a p99 near the true heavy-tail value', () => {
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE });
    // 900 samples of 10 + 100 samples of 100 → p99 lands in the 100-block.
    addConst(n, 0, 10, 900);
    addConst(n, 1, 100, 100);
    const p99 = n.viewportPercentile(tilesRange(0, 0), ALL_ROWS, 0);
    expect(p99).toBeGreaterThan(85);
    expect(p99).toBeLessThan(115);
  });

  it('reads a p50 near the bulk value (same data, median config)', () => {
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE, percentile: 50, floor: 0 });
    addConst(n, 0, 10, 900);
    addConst(n, 1, 100, 100);
    const p50 = n.viewportPercentile(tilesRange(0, 0), ALL_ROWS, 0);
    expect(p50).toBeGreaterThan(8);
    expect(p50).toBeLessThan(12);
  });

  it('bins bid AND ask samples when ask present', () => {
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE, percentile: 50, floor: 0 });
    n.addColumn(0, new Float32Array(50).fill(5), new Float32Array(50).fill(500));
    // Half the samples are 5, half are 500 → median sits between the two blocks.
    const p50 = n.viewportPercentile(tilesRange(0, 0), ALL_ROWS, 0);
    expect(p50).toBeGreaterThan(5);
    expect(p50).toBeLessThan(500);
  });

  it('ignores zeros (only active levels enter the distribution)', () => {
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE, percentile: 50, floor: 0 });
    const bid = new Float32Array(100);
    bid.fill(0);
    for (let i = 0; i < 10; i++) bid[i] = 42; // 10 nonzero, 90 zero
    n.addColumn(0, bid, null);
    const p50 = n.viewportPercentile(tilesRange(0, 0), ALL_ROWS, 0);
    // If zeros were counted, p50 would be ~0; they aren't, so it is ~42.
    expect(p50).toBeGreaterThan(35);
    expect(p50).toBeLessThan(50);
  });
});

describe('viewport scoping — normalize to the visible window, not the live edge', () => {
  it('a dim region and a bright region yield different percentiles', () => {
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE, floor: 0 });
    // Tile 0 (cols 0..255): dim ~8. Tile 5 (cols 1280..1535): bright ~200.
    addConst(n, 0, 8, 500);
    addConst(n, 5 * COLS_PER_TILE, 200, 500);

    const dim = n.viewportPercentile(tilesRange(0, 0), ALL_ROWS, 0);
    const bright = n.viewportPercentile(tilesRange(5, 5), ALL_ROWS, 0);

    expect(dim).toBeLessThan(20);
    expect(bright).toBeGreaterThan(150);
    // The whole point: panning from bright→dim renormalizes far downward.
    expect(bright / dim).toBeGreaterThan(5);
  });

  it('merges only the tiles the viewport covers (O(tiles-in-view), not history)', () => {
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE, floor: 0 });
    addConst(n, 0, 8, 500); // tile 0
    addConst(n, 5 * COLS_PER_TILE, 200, 500); // tile 5
    // A window covering both tiles blends the two distributions.
    const both = n.viewportPercentile(tilesRange(0, 5), ALL_ROWS, 0);
    const dim = n.viewportPercentile(tilesRange(0, 0), ALL_ROWS, 0);
    expect(both).toBeGreaterThan(dim); // bright tile pulls p99 up
  });

  it('empty viewport holds the current norm (no data → no flicker to zero)', () => {
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE });
    n.seed(42);
    const norm = n.viewportPercentile(tilesRange(100, 100), ALL_ROWS, 0);
    expect(norm).toBe(42); // == seeded ema, not the floor, not 0
  });

  it('floors the returned norm', () => {
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE, floor: 6 });
    addConst(n, 0, 0.001, 100); // below floor
    const norm = n.viewportPercentile(tilesRange(0, 0), ALL_ROWS, 0);
    expect(norm).toBeGreaterThanOrEqual(6);
  });
});

describe('EMA smoothing', () => {
  it('first updateNorm jumps to the raw value, later calls glide', () => {
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE, emaAlpha: 0.2, floor: 0 });
    addConst(n, 0, 10, 1000); // raw ≈ 10 over tile 0
    const first = n.updateNorm(tilesRange(0, 0), ALL_ROWS, 0);
    expect(first).toBeGreaterThan(8);
    expect(first).toBeLessThan(12);

    // Now the bright tile 5 enters view; the norm should glide UP, not jump.
    addConst(n, 5 * COLS_PER_TILE, 200, 1000);
    const second = n.updateNorm(tilesRange(5, 5), ALL_ROWS, 0);
    // One step of 0.2 toward ~200 from ~10 → ~48, well short of 200.
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThan(80);
  });

  it('seed sets the starting point and later data glides from it', () => {
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE, emaAlpha: 0.1, floor: 0 });
    n.seed(50);
    expect(n.current).toBe(50);
    addConst(n, 0, 100, 1000); // raw ≈ 100
    const v = n.updateNorm(tilesRange(0, 0), ALL_ROWS, 0);
    // 50 + 0.1*(100-50) = 55 (raw is ~100 within bin tolerance).
    expect(v).toBeGreaterThan(53);
    expect(v).toBeLessThan(58);
  });

  it('settles toward a steady raw over repeated calls', () => {
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE, emaAlpha: 0.3, floor: 0 });
    addConst(n, 0, 30, 1000);
    n.seed(300); // start far above the true ~30
    let v = 300;
    for (let i = 0; i < 40; i++) v = n.updateNorm(tilesRange(0, 0), ALL_ROWS, 0);
    expect(v).toBeGreaterThan(25);
    expect(v).toBeLessThan(35);
    expect(n.settled).toBe(true);
  });
});

describe('tile eviction (bounded — O(tiles), not O(history))', () => {
  it('never retains more than maxTiles and evicts the farthest tile', () => {
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE, maxTiles: 4, floor: 0 });
    for (let t = 0; t <= 3; t++) addConst(n, t * COLS_PER_TILE, 10, 10);
    expect(n.retainedTiles).toBe(4);

    // Insert a far tile 10 → evicts tile 0 (farthest from 10), stays at 4.
    addConst(n, 10 * COLS_PER_TILE, 99, 10);
    expect(n.retainedTiles).toBe(4);

    // Tile 0 is gone (its data no longer contributes); tile 10 is present.
    const tile0 = n.viewportPercentile(tilesRange(0, 0), ALL_ROWS, 0);
    const tile10 = n.viewportPercentile(tilesRange(10, 10), ALL_ROWS, 0);
    expect(tile0).toBe(n.current); // no data → holds current (seed/ema), not ~10
    expect(tile10).toBeGreaterThan(80);
  });
});

describe('reset', () => {
  it('clears tiles and EMA state', () => {
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE });
    addConst(n, 0, 10, 100);
    n.seed(50);
    n.reset();
    expect(n.hasData()).toBe(false);
    expect(n.retainedTiles).toBe(0);
    expect(n.current).toBe(DEFAULT_NORM_FLOOR);
  });
});
