import { describe, expect, it } from 'vitest';

import { cvdBounds, cvdColToX, cvdProject, cvdValueToY, fmtCvd } from './cvd';

describe('cvdBounds — signed value range always spanning zero', () => {
  it('includes 0 even when all values are positive', () => {
    const b = cvdBounds([10, 20, 30]);
    expect(b.min).toBeLessThanOrEqual(0);
    expect(b.max).toBeGreaterThan(30);
  });
  it('includes 0 even when all values are negative', () => {
    const b = cvdBounds([-5, -20]);
    expect(b.max).toBeGreaterThanOrEqual(0);
    expect(b.min).toBeLessThan(-20);
  });
  it('falls back to a drawable range for an empty / flat series', () => {
    expect(cvdBounds([])).toEqual({ min: -1, max: 1 });
    expect(cvdBounds([0, 0, 0])).toEqual({ min: -1, max: 1 });
  });
  it('ignores non-finite values', () => {
    const b = cvdBounds([10, Number.NaN, 20]);
    expect(b.max).toBeGreaterThan(20);
  });
});

describe('cvdValueToY — higher value is higher on screen (smaller y)', () => {
  const b = { min: -100, max: 100 };
  it('maps the max to the top and the min to the bottom (inside the pad)', () => {
    expect(cvdValueToY(100, b, 100, 4)).toBeCloseTo(4);
    expect(cvdValueToY(-100, b, 100, 4)).toBeCloseTo(96);
  });
  it('maps 0 to the vertical centre for a symmetric range', () => {
    expect(cvdValueToY(0, b, 100, 4)).toBeCloseTo(50);
  });
});

describe('cvdColToX — matches the heatmap column-centre transform', () => {
  it('maps a column centre through the [start,end) window to pixels', () => {
    // window [10,20), width 200 → each column is 20px, centre offset +0.5.
    expect(cvdColToX(10, 10, 20, 200)).toBeCloseTo(10); // (10.5-10)/10 * 200
    expect(cvdColToX(19, 10, 20, 200)).toBeCloseTo(190); // (19.5-10)/10 * 200
  });
  it('is safe when the window has zero width', () => {
    expect(Number.isFinite(cvdColToX(5, 5, 5, 100))).toBe(true);
  });
});

describe('fmtCvd — compact signed magnitude', () => {
  it('signs and abbreviates', () => {
    expect(fmtCvd(0)).toBe('0');
    expect(fmtCvd(1500)).toBe('+1.5k');
    expect(fmtCvd(-2_400_000)).toBe('−2.40M');
    expect(fmtCvd(42)).toBe('+42');
  });
  it('handles non-finite input', () => {
    expect(fmtCvd(Number.NaN)).toBe('—');
  });
});

describe('cvdProject — single-pass, zero-allocation projection', () => {
  const pts = [
    { col: 10, cvd: 100 },
    { col: 15, cvd: -50 },
    { col: 19, cvd: 25 },
  ];

  it('matches the two-pass composition exactly (bounds + per-point x/y)', () => {
    const ref = cvdBounds(pts.map((p) => p.cvd));
    const proj = cvdProject(pts, 10, 20, 200, 100);
    expect(proj.bounds).toEqual(ref);
    expect(proj.count).toBe(3);
    pts.forEach((p, i) => {
      expect(proj.xy[i]!.x).toBeCloseTo(cvdColToX(p.col, 10, 20, 200));
      expect(proj.xy[i]!.y).toBeCloseTo(cvdValueToY(p.cvd, ref, 100));
    });
  });

  it('is index-aligned: the output length equals the input length', () => {
    const proj = cvdProject(pts, 10, 20, 200, 100);
    expect(proj.xy).toHaveLength(3);
    expect(cvdProject([], 10, 20, 200, 100).xy).toHaveLength(0);
  });

  it('reuses the caller buffer without leaking stale cells from larger repaints', () => {
    const buf: { x: number; y: number }[] = [];
    const big = cvdProject(pts, 10, 20, 200, 100, buf);
    expect(buf).toBe(big.xy); // same array object, no per-repaint allocation
    const small = cvdProject([pts[0]], 10, 20, 200, 100, buf);
    expect(small.xy).toHaveLength(1); // truncated, not padded with old cells
    expect(small.xy[0]!.x).toBeCloseTo(big.xy[0]!.x);
    // Growing again refills cleanly.
    const regrown = cvdProject(pts, 10, 20, 200, 100, buf);
    expect(regrown.xy).toHaveLength(3);
    expect(Number.isFinite(regrown.xy[2]!.y)).toBe(true);
  });

  it('includes zero in the projected bounds (signed baseline rule)', () => {
    const proj = cvdProject([{ col: 0, cvd: 5 }], 0, 10, 100, 100);
    expect(proj.bounds.min).toBeLessThanOrEqual(0);
    expect(proj.bounds.max).toBeGreaterThanOrEqual(0);
  });
});
