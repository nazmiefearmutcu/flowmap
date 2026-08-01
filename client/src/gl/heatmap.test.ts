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
  it('is an exact no-op at slider 0 and a gentle denoise at the default', () => {
    // Slider 0 stays an exact algebraic identity — every pixel spec below relies
    // on it — but the app OPENS at a small non-zero default so faint specks are
    // pre-suppressed. The default sits in the 4–7 band: high enough to cut the
    // bottom quartile of the heavy tail, low enough (floor ≈ 0.013, i.e. ~1.3%
    // of the white point) that the median cell (~4% of norm) clears it — the
    // old 15 (floor ≈ 0.060) drowned the whole ladder, see the visibility test.
    expect(floorForTolerance(0)).toBe(0);
    expect(DEFAULT_TOLERANCE).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_TOLERANCE).toBeLessThanOrEqual(7);
    const dflt = floorForTolerance(DEFAULT_TOLERANCE);
    expect(dflt).toBeGreaterThan(0.005);
    expect(dflt).toBeLessThan(0.02); // well below the old ~0.06 that hid the field
  });

  it('is monotonically increasing across the slider', () => {
    let prev = -1;
    for (let v = 0; v <= 100; v += 5) {
      const f = floorForTolerance(v);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });

  it('reaches exactly the (raised) cap at 100 and never exceeds it', () => {
    expect(TOLERANCE_MAX_FLOOR).toBeGreaterThan(0.5); // stronger reach than before
    expect(TOLERANCE_MAX_FLOOR).toBeLessThan(1); // but never degenerate
    expect(floorForTolerance(100)).toBeCloseTo(TOLERANCE_MAX_FLOOR, 12);
    expect(floorForTolerance(1e9)).toBeCloseTo(TOLERANCE_MAX_FLOOR, 12);
  });

  it('is eased (between linear and square) for mid-slider bite + low-end control', () => {
    // Mid-slider sits between pure-quadratic (0.25 of the cap) and linear (0.5),
    // so the middle of the travel actually cleans the field up — the old square
    // wasted it. The low end still stays fine-grained.
    const midFrac = floorForTolerance(50) / TOLERANCE_MAX_FLOOR;
    expect(midFrac).toBeGreaterThan(0.25);
    expect(midFrac).toBeLessThan(0.5);
    expect(floorForTolerance(10)).toBeLessThan(floorForTolerance(50) / 3);
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

describe('default visibility — the boxed heatmap must show the field, not just walls', () => {
  // Heavy-tail model: log-normal with σ chosen so the MEDIAN active cell is 2% of
  // the p99 white point (observed order-flow shape: a handful of walls dwarf the
  // ladder). All quantiles below are derived from that one shape assumption.
  const SIGMA = Math.log(50) / 2.3263; // p99/median = exp(2.3263·σ) = 50 → σ ≈ 1.68
  const P99 = Math.exp(2.3263 * SIGMA);
  const P97 = Math.exp(1.8808 * SIGMA); // standard-normal quantile for 97%

  /** Standard-normal CDF (Abramowitz–Stegun 26.2.17, |err| < 7.5e-8). */
  function phi(z: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
    const p =
      d *
      t *
      (0.31938153 +
        t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z >= 0 ? 1 - p : p;
  }

  /** Cell density at the standard-normal quantile z (median = 2% of p99). */
  function cell(z: number): number {
    return 0.02 * P99 * Math.exp(z * SIGMA);
  }

  /** The fragment shader chain: normalize → black point → gamma → LUT index. */
  function lut(cellDensity: number, norm: number, floor: number, gamma: number): number {
    const t = Math.min(1, Math.max(0, cellDensity / norm));
    const remapped = Math.min(1, Math.max(0, (t - floor) / Math.max(1 - floor, 1e-6)));
    return Math.round(Math.pow(remapped, gamma) * 255);
  }

  /** Share of active cells above the floor (visible) on the model distribution. */
  function visibleFraction(floor: number, norm: number): number {
    const z = (Math.log(floor * norm) - Math.log(0.02 * P99)) / SIGMA;
    return 1 - phi(z);
  }

  it('keeps ~3× more of the field visible than the pre-fix defaults', () => {
    const floor = floorForTolerance(DEFAULT_TOLERANCE);
    const before = visibleFraction(floorForTolerance(15), P99); // pre-fix: tol 15 + p99
    const after = visibleFraction(floor, P97); // now: tol 5 + p97
    expect(after).toBeGreaterThan(0.6); // ≈76% of active cells paint
    expect(before).toBeLessThan(0.35); // ≈26% before — walls only
    expect(after).toBeGreaterThan(before * 2);
  });

  it('lifts the median cell off background while the bottom quartile stays suppressed', () => {
    const floor = floorForTolerance(DEFAULT_TOLERANCE);
    const gamma = gammaForContrast(DEFAULT_CONTRAST);
    const medianLut = lut(cell(0), P97, floor, gamma);
    const lowLut = lut(cell(-0.6745), P97, floor, gamma); // 25th percentile
    expect(medianLut).toBeGreaterThanOrEqual(40); // ≈LUT 51 — visible dark indigo
    expect(lowLut).toBeLessThanOrEqual(15); // ≈LUT 10 — still ~background
    // Pre-fix regression pin: with floor ≈0.06 + p99 the median maps to LUT 0.
    expect(lut(cell(0), P99, floorForTolerance(15), gamma)).toBe(0);
  });

  it('keeps the walls saturated at the default white point', () => {
    const floor = floorForTolerance(DEFAULT_TOLERANCE);
    const gamma = gammaForContrast(DEFAULT_CONTRAST);
    expect(lut(P97, P97, floor, gamma)).toBeGreaterThanOrEqual(250); // p97 → white
    expect(lut(P99, P97, floor, gamma)).toBe(255); // p99 clamps to full brightness
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
