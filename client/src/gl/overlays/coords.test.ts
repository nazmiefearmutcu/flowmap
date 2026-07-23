import { describe, expect, it } from 'vitest';

import {
  GridMap,
  remapRow,
  remapRowSpan,
  toBigNs,
  visibleColRange,
  type PriceMap,
  type SurfaceDims,
} from './coords';
import type { HeatmapView } from '../heatmap';
import { makeHybrid, priceToRow, rowToPrice } from '../priceScale';

const view: HeatmapView = { colOffset: 100, colScale: 200, rowOffset: 50, rowScale: 100 };
const dims: SurfaceDims = { drawW: 1600, drawH: 800, cssW: 800, cssH: 400 };
const dtNs = 25_000_000;
const anchorT0Ns = BigInt(399) * BigInt(dtNs);
const time = { anchorSeq: 399, anchorT0Ns, dtNs };
const price = { p0: 50, step: 0.5 };

function gm(): GridMap {
  return new GridMap(view, dims, time, price);
}

describe('GridMap time/price affines', () => {
  it('maps ts_ns → column and back (exact within an epoch)', () => {
    const g = gm();
    expect(g.tsToCol(anchorT0Ns)).toBe(399);
    expect(g.tsToCol(anchorT0Ns + BigInt(dtNs))).toBe(400);
    expect(g.tsToCol(anchorT0Ns - BigInt(dtNs) * 10n)).toBe(389);
    expect(g.colToTsNs(399)).toBe(anchorT0Ns);
    expect(g.colToTsNs(400)).toBe(anchorT0Ns + BigInt(dtNs));
  });

  it('maps price → row and back', () => {
    const g = gm();
    expect(g.priceToRow(50)).toBe(0);
    expect(g.priceToRow(100)).toBe(100);
    expect(g.rowToPrice(100)).toBe(100);
    expect(g.rowToPrice(0)).toBe(50);
  });

  it('reports hasEvents only when both affines are present', () => {
    expect(gm().hasEvents).toBe(true);
    expect(new GridMap(view, dims, null, price).hasEvents).toBe(false);
    expect(new GridMap(view, dims, time, null).hasEvents).toBe(false);
  });

  it('returns NaN mappings when an affine is missing', () => {
    const g = new GridMap(view, dims, null, null);
    expect(Number.isNaN(g.tsToCol(0n))).toBe(true);
    expect(Number.isNaN(g.priceToRow(100))).toBe(true);
    expect(g.colToTsNs(10)).toBeNull();
  });
});

describe('GridMap grid → clip (WebGL, y-up)', () => {
  it('maps the view edges to the NDC box', () => {
    const g = gm();
    expect(g.clipX(100)).toBeCloseTo(-1);
    expect(g.clipX(300)).toBeCloseTo(1);
    expect(g.clipX(200)).toBeCloseTo(0);
    expect(g.clipY(50)).toBeCloseTo(-1); // bottom row
    expect(g.clipY(150)).toBeCloseTo(1); // top row
  });
});

describe('GridMap grid → CSS px (2D, y-down)', () => {
  it('maps columns to x and rows to y (y flipped)', () => {
    const g = gm();
    expect(g.cssX(100)).toBeCloseTo(0);
    expect(g.cssX(300)).toBeCloseTo(800);
    expect(g.cssY(50)).toBeCloseTo(400); // bottom row → bottom of the canvas
    expect(g.cssY(150)).toBeCloseTo(0); // top row → top
    expect(g.cssY(100)).toBeCloseTo(200);
  });

  it('converts pixel sizes to clip deltas and device px', () => {
    const g = gm();
    expect(g.pxToClipW(400)).toBeCloseTo(1); // 400px = half the 800px width
    expect(g.pxToClipH(200)).toBeCloseTo(1);
    expect(g.pxToDevice(1)).toBeCloseTo(2); // dpr = drawW/cssW = 2
  });
});

describe('toBigNs (cold-JSON ns may be number, hot ns is bigint)', () => {
  it('passes a bigint through unchanged', () => {
    expect(toBigNs(1101502477868n)).toBe(1101502477868n);
  });
  it('converts an integer number (small cold-JSON ts_ns) to bigint', () => {
    // Marker.ts_ns below 2^53 arrives as a plain number → must not blow up a
    // BigInt64Array store (the live-sim regression).
    expect(toBigNs(321388319477)).toBe(321388319477n);
  });
  it('is safe to store into a BigInt64Array', () => {
    const ring = new BigInt64Array(1);
    ring[0] = toBigNs(321388319477); // would throw if passed the raw number
    expect(ring[0]).toBe(321388319477n);
  });
});

describe('visibleColRange', () => {
  it('clamps the visible span to the resident window', () => {
    expect(visibleColRange(view, { oldest: 120, newest: 250 })).toEqual({ lo: 120, hi: 250 });
    expect(visibleColRange(view, null)).toEqual({ lo: 100, hi: 300 });
  });

  it('returns null when the view is entirely outside the resident window', () => {
    expect(visibleColRange(view, { oldest: 500, newest: 600 })).toBeNull();
  });
});

describe('remapRow / remapRowSpan — surviving an epoch re-anchor', () => {
  // The server bumps the epoch and moves p0 when mid leaves the grid's central
  // band. The tile ring is epoch-agnostic and the shader applies ONE row affine,
  // so a user-locked price window must be re-expressed or it silently points at
  // different prices.
  const A: PriceMap = { p0: 100, step: 0.5 };
  const B: PriceMap = { p0: 150, step: 0.5 }; // pure translation (p0 +50)

  it('preserves the PRICE a row denotes across a p0 shift', () => {
    // row 40 in A is price 120; in B that is row (120-150)/0.5 = -60.
    expect(remapRow(40, A, B)).toBe(-60);
  });

  it('is the identity when the epochs share an affine', () => {
    expect(remapRow(40, A, A)).toBe(40);
    expect(remapRowSpan(120, A, A)).toBe(120);
  });

  it('round-trips exactly', () => {
    expect(remapRow(remapRow(40, A, B), B, A)).toBeCloseTo(40, 9);
  });

  it('rescales a span by the step ratio only (p0 cancels)', () => {
    const C: PriceMap = { p0: 999, step: 2 };
    expect(remapRowSpan(120, A, C)).toBe(30); // 120 * 0.5 / 2
  });

  it('returns NaN — not a bogus row — when the target affine is unusable', () => {
    const dead: PriceMap = { p0: 0, step: 0 };
    expect(Number.isNaN(remapRow(40, A, dead))).toBe(true);
    expect(Number.isNaN(remapRowSpan(40, A, dead))).toBe(true);
  });
});

describe('GridMap under a NON-UNIFORM price scale', () => {
  // A hybrid scale: linear core with log wings. The whole point is that a row's
  // price height depends on where it sits, so every mapping must go through the
  // scale rather than the two representative scalars.
  const hybrid = makeHybrid({
    mid: 60_000,
    rows: 4096,
    coreRows: 2048,
    coreStep: 0.5,
    upMult: 11,
    dnFloor: 0.01,
  })!;
  const pm: PriceMap = { p0: hybrid.coreP0, step: hybrid.coreStep, scale: hybrid };
  const gm = new GridMap(view, dims, null, pm);

  it('maps rows and prices through the SCALE, not p0 + row*step', () => {
    const linearAnswer = pm.p0 + 3900 * pm.step;
    expect(gm.rowToPrice(3900)).not.toBeCloseTo(linearAnswer, 0);
    // ...and agrees with the scale module exactly.
    expect(gm.rowToPrice(3900)).toBe(rowToPrice(hybrid, 3900));
    expect(gm.priceToRow(500_000)).toBe(priceToRow(hybrid, 500_000));
  });

  it('round-trips through the GridMap accessors', () => {
    for (const r of [10, 1348, 2400, 3400, 4000]) {
      expect(gm.priceToRow(gm.rowToPrice(r))).toBeCloseTo(r, 6);
    }
  });

  it('reports a POSITION-DEPENDENT row height', () => {
    const inCore = gm.stepAtRow(hybrid.dnRows + 100);
    const inWing = gm.stepAtRow(hybrid.dnRows + hybrid.coreRows + 100);
    expect(inCore).toBeCloseTo(0.5, 9); // native ladder preserved
    expect(inWing).toBeGreaterThan(inCore * 10); // wings are far coarser
  });

  it('still reports a CONSTANT row height on a linear map (no regression)', () => {
    const lin = new GridMap(view, dims, null, { p0: 100, step: 0.5 });
    expect(lin.stepAtRow(0)).toBe(0.5);
    expect(lin.stepAtRow(9999)).toBe(0.5);
  });

  it('remapRowSpan measures the span WHERE it sits under a non-uniform scale', () => {
    // Same span, two places on the same grid → different price distances, so a
    // remap that ignored position would silently resize the user's price zoom.
    const other = makeHybrid({
      mid: 66_000, // the epoch re-anchored 10% higher
      rows: 4096,
      coreRows: 2048,
      coreStep: 0.5,
      upMult: 11,
      dnFloor: 0.01,
    })!;
    const to: PriceMap = { p0: other.coreP0, step: other.coreStep, scale: other };
    const inCore = remapRowSpan(200, pm, to, hybrid.dnRows + 1000);
    const inWing = remapRowSpan(200, pm, to, hybrid.dnRows + hybrid.coreRows + 300);
    expect(inCore).not.toBeCloseTo(inWing, 1);
    // Both stay finite and positive — a remap must never invert the axis.
    expect(inCore).toBeGreaterThan(0);
    expect(inWing).toBeGreaterThan(0);
  });

  it('remapRow preserves the PRICE a row denotes across epochs', () => {
    const other = makeHybrid({
      mid: 66_000, rows: 4096, coreRows: 2048, coreStep: 0.5, upMult: 11, dnFloor: 0.01,
    })!;
    const to: PriceMap = { p0: other.coreP0, step: other.coreStep, scale: other };
    for (const r of [500, 2000, 3500]) {
      const price = rowToPrice(hybrid, r);
      expect(rowToPrice(other, remapRow(r, pm, to))).toBeCloseTo(price, 3);
    }
  });

  it('keeps the linear remap arithmetic EXACT (byte-identical fast path)', () => {
    const a: PriceMap = { p0: 100, step: 0.5 };
    const b: PriceMap = { p0: 150, step: 0.5 };
    expect(remapRow(40, a, b)).toBe(-60);
    expect(remapRowSpan(120, a, b)).toBe(120);
    expect(remapRowSpan(120, a, { p0: 999, step: 2 })).toBe(30);
  });
});
