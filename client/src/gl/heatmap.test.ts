import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONTRAST,
  DEFAULT_TOLERANCE,
  floorForTolerance,
  gammaForContrast,
  selectLevel,
  TOLERANCE_MAX_FLOOR,
} from './heatmap';

/** The shader's black-point remap, mirrored so its algebra is testable. */
function remap(t: number, floor: number): number {
  const scale = 1 / Math.max(1 - floor, 1e-6);
  const out = (t - floor) * scale;
  return out < 0 ? 0 : out > 1 ? 1 : out;
}

describe('floorForTolerance — the Tolerance slider → shader black point', () => {
  it('is off (an exact no-op) at the default', () => {
    expect(DEFAULT_TOLERANCE).toBe(0);
    expect(floorForTolerance(DEFAULT_TOLERANCE)).toBe(0);
  });

  it('is monotonically increasing across the slider', () => {
    let prev = -1;
    for (let v = 0; v <= 100; v += 5) {
      const f = floorForTolerance(v);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });

  it('reaches exactly the cap at 100 and never exceeds it', () => {
    expect(floorForTolerance(100)).toBeCloseTo(TOLERANCE_MAX_FLOOR, 12);
    expect(floorForTolerance(1e9)).toBeCloseTo(TOLERANCE_MAX_FLOOR, 12);
  });

  it('is QUADRATIC, so the low end of the slider has fine control', () => {
    // Density is heavy-tailed and gamma lifts the mids hard, so the useful
    // floors are tiny; a linear map would waste most of the travel.
    expect(floorForTolerance(50)).toBeCloseTo(TOLERANCE_MAX_FLOOR * 0.25, 12);
    expect(floorForTolerance(10)).toBeCloseTo(TOLERANCE_MAX_FLOOR * 0.01, 12);
    // Half the slider buys a quarter of the floor — the defining property.
    expect(floorForTolerance(50)).toBeLessThan(floorForTolerance(100) / 2);
  });

  it('clamps negatives and refuses NaN (a NaN floor blanks the heatmap)', () => {
    expect(floorForTolerance(-40)).toBe(0);
    expect(floorForTolerance(Number.NaN)).toBe(0);
    expect(floorForTolerance(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('the black-point remap the fragment shader applies', () => {
  it('is the exact identity at floor 0 — every existing pixel spec is untouched', () => {
    for (const t of [0, 0.001, 0.25, 0.5, 0.9999, 1]) {
      expect(remap(t, 0)).toBe(t);
    }
  });

  it('collapses everything at or below the floor to LUT entry 0 (= background)', () => {
    const f = floorForTolerance(60);
    expect(remap(0, f)).toBe(0);
    expect(remap(f, f)).toBe(0);
    expect(remap(f * 0.5, f)).toBe(0);
  });

  it('keeps the WHITE point pinned — raising tolerance must not dim the walls', () => {
    // Without the re-expansion, the survivors would land on [f,1] of the LUT and
    // the whole field would darken as the slider rises.
    for (const v of [0, 25, 50, 75, 100]) {
      expect(remap(1, floorForTolerance(v))).toBeCloseTo(1, 12);
    }
  });

  it('re-expands the survivors monotonically', () => {
    const f = floorForTolerance(50);
    let prev = -1;
    for (let t = f; t <= 1; t += 0.05) {
      const out = remap(t, f);
      expect(out).toBeGreaterThanOrEqual(prev);
      prev = out;
    }
  });

  it('does not degenerate at the cap (the reason the cap exists)', () => {
    // At floor → 1 the 1/(1-floor) scale blows up and even the p99 white point
    // would map to 0, i.e. a black screen — the opposite of "endpoints fixed".
    const f = TOLERANCE_MAX_FLOOR;
    expect(f).toBeLessThan(1);
    expect(remap(1, f)).toBeCloseTo(1, 12);
    expect(remap((1 + f) / 2, f)).toBeCloseTo(0.5, 12);
  });
});

describe('gammaForContrast', () => {
  it('spans the legible band', () => {
    expect(gammaForContrast(0)).toBeCloseTo(0.28, 12);
    expect(gammaForContrast(100)).toBeCloseTo(0.72, 12);
  });

  it('is monotonic and clamps out-of-range input', () => {
    expect(gammaForContrast(20)).toBeLessThan(gammaForContrast(80));
    expect(gammaForContrast(-50)).toBe(gammaForContrast(0));
    expect(gammaForContrast(500)).toBe(gammaForContrast(100));
  });

  it('puts the default slider position inside the band', () => {
    // NOTE deliberately NOT asserted equal to DEFAULT_DISPLAY_GAMMA: the real
    // value is 0.456, not 0.45. The module docblock used to claim otherwise.
    const g = gammaForContrast(DEFAULT_CONTRAST);
    expect(g).toBeGreaterThan(0.28);
    expect(g).toBeLessThan(0.72);
    expect(g).toBeCloseTo(0.456, 6);
  });
});

describe('selectLevel (SUM-mip selection) — unchanged by the tolerance work', () => {
  it('stays on level 0 when rows do not collapse', () => {
    expect(selectLevel(1, 2)).toEqual({ level: 0, blk: 1, nRowTaps: 1 });
    expect(selectLevel(0.25, 2)).toEqual({ level: 0, blk: 1, nRowTaps: 1 });
  });

  it('is the identity with no mip chain', () => {
    expect(selectLevel(64, 0)).toEqual({ level: 0, blk: 1, nRowTaps: 1 });
  });

  it('climbs a level per 4× of rows-per-pixel, capped at maxLevel', () => {
    expect(selectLevel(4, 2).level).toBe(1);
    expect(selectLevel(16, 2).level).toBe(2);
    expect(selectLevel(4096, 2).level).toBe(2);
  });

  it('covers the leftover footprint with 1..4 finer taps', () => {
    const sel = selectLevel(8, 2);
    expect(sel.level).toBe(1);
    expect(sel.blk).toBe(4);
    expect(sel.nRowTaps).toBe(2);
    expect(selectLevel(4096, 2).nRowTaps).toBeLessThanOrEqual(4);
  });
});
