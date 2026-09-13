import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONTRAST,
  DEFAULT_DISPLAY_GAMMA,
  DEFAULT_KNEE_FRACTION,
  DEFAULT_TOLERANCE,
  DEFAULT_DEPTH_CHANNEL,
  DEPTH_CHANNEL_CODE,
  depthChannelOf,
  effectiveRowMode,
  floorForTolerance,
  gammaForContrast,
  Heatmap,
  levelBlendFor,
  rowFadeFor,
  selectLevel,
  SMOOTH_MAX_TAPS,
  SMOOTH_SIGMA_PX,
  smoothPlanFor,
  TOLERANCE_MAX_FLOOR,
  transferCurve,
  TRANSFER_LOG_SCALE,
  TRANSFER_LOW_SPAN,
  rowSmoothDyFor,
  rowMipSoftenFor,
  rowMipWeightsFor,
  SMOOTH_ROW_MIP_DY,
  SMOOTH_ROW_MIP_SIGMA_PX,
  SMOOTH_ROW_MIP_TAPS,
  SMOOTH_ROW_SIGMA_PX,
} from './heatmap';
import { buildImbalanceLUT, buildFlowLUT, LUT_SIZE } from './lut';
import { MipChain } from './mips';
import { makeFakeGL, type FakeGL } from './mockGL';
import { ViewportNormalizer } from './normalize';
import type { GLContext } from './context';
import { COLS_PER_TILE, TileRing } from './tileRing';
import { HEATMAP_FRAG } from './shaders/heatmap';

/** The shader's black-point remap, mirrored so its algebra is testable. */
function remap(t: number, floor: number): number {
  const scale = 1 / Math.max(1 - floor, 1e-6);
  const out = (t - floor) * scale;
  return out < 0 ? 0 : out > 1 ? 1 : out;
}

describe('floorForTolerance â€” the Tolerance slider â†’ shader black point', () => {
  it('is an exact no-op at slider 0 and a gentle denoise at the default', () => {
    // Slider 0 stays an exact algebraic identity â€” every pixel spec below relies
    // on it â€” but the app OPENS at a small non-zero default so faint specks are
    // pre-suppressed. The default sits in the 4â€“7 band: high enough to cut the
    // bottom quartile of the heavy tail, low enough (floor â‰ˆ 0.013, i.e. ~1.3%
    // of the white point) that the median cell (~4% of norm) clears it â€” the
    // old 15 (floor â‰ˆ 0.060) drowned the whole ladder, see the visibility test.
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
    // so the middle of the travel actually cleans the field up â€” the old square
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
  it('is the exact identity at floor 0 â€” every existing pixel spec is untouched', () => {
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

  it('keeps the WHITE point pinned â€” raising tolerance must not dim the walls', () => {
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
    // At floor â†’ 1 the 1/(1-floor) scale blows up and even the p99 white point
    // would map to 0, i.e. a black screen â€” the opposite of "endpoints fixed".
    const f = TOLERANCE_MAX_FLOOR;
    expect(f).toBeLessThan(1);
    expect(remap(1, f)).toBeCloseTo(1, 12);
    expect(remap((1 + f) / 2, f)).toBeCloseTo(0.5, 12);
  });
});

describe('gammaForContrast', () => {
  it('spans the legible band', () => {
    expect(gammaForContrast(0)).toBeCloseTo(0.5, 12);
    expect(gammaForContrast(100)).toBeCloseTo(1.4, 12);
  });

  it('is monotonic and clamps out-of-range input', () => {
    expect(gammaForContrast(20)).toBeLessThan(gammaForContrast(80));
    expect(gammaForContrast(-50)).toBe(gammaForContrast(0));
    expect(gammaForContrast(500)).toBe(gammaForContrast(100));
  });

  it('puts the default slider position at the dark-field default', () => {
    // Campaign 4.1 (Bookmap-class look): the default flips from a LIFTING
    // curve (0.456 â€” small orders painted mid-ramp = rainbow barcode) to a
    // dark-field curve, pinned equal to DEFAULT_DISPLAY_GAMMA.
    const g = gammaForContrast(DEFAULT_CONTRAST);
    expect(g).toBeGreaterThan(0.5);
    expect(g).toBeLessThan(1.4);
    expect(g).toBeCloseTo(0.86, 6);
    expect(g).toBeCloseTo(DEFAULT_DISPLAY_GAMMA, 6);
  });
});

describe('default visibility â€” the boxed heatmap must show the field, not just walls', () => {
  // Heavy-tail model: log-normal with Ïƒ chosen so the MEDIAN active cell is 2% of
  // the p99 white point (observed order-flow shape: a handful of walls dwarf the
  // ladder). Lane F moved the WHITE point to p99.7 while p97 stays the KNEE, so
  // every quantile below is derived from the same shape at the NEW white point.
  const SIGMA = Math.log(50) / 2.3263; // p99/median = exp(2.3263Â·Ïƒ) = 50 â†’ Ïƒ â‰ˆ 1.68
  const P99 = Math.exp(2.3263 * SIGMA);
  const P97 = Math.exp(1.8808 * SIGMA); // standard-normal quantile for 97%
  const P99_7 = Math.exp(2.7478 * SIGMA); // standard-normal quantile for 99.7%
  /** The live knee fraction once the normalizer is attached: p97 / p99.7. */
  const KNEE = P97 / P99_7;

  /** Standard-normal CDF (Abramowitzâ€“Stegun 26.2.17, |err| < 7.5e-8). */
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

  /** The fragment shader chain: normalize â†’ black point â†’ transfer â†’ LUT index. */
  function lut(cellDensity: number, norm: number, floor: number, gamma: number): number {
    const t = Math.min(1, Math.max(0, cellDensity / norm));
    const remapped = Math.min(1, Math.max(0, (t - floor) / Math.max(1 - floor, 1e-6)));
    return Math.round(
      transferCurve(remapped, { knee: KNEE, gamma, logScale: TRANSFER_LOG_SCALE }) * 255,
    );
  }

  /** Share of active cells above the floor (visible) on the model distribution. */
  function visibleFraction(floor: number, norm: number): number {
    const z = (Math.log(floor * norm) - Math.log(0.02 * P99)) / SIGMA;
    return 1 - phi(z);
  }

  it('keeps the upper field visible while the floor still cuts the quiet tail', () => {
    const floor = floorForTolerance(DEFAULT_TOLERANCE);
    const after = visibleFraction(floor, P99_7); // now: tol 5 + p99.7 white
    const before = visibleFraction(floorForTolerance(15), P99); // pre-fix: tol 15 + p99
    // The new white point is ~2.03Ã— the old one, so the same slider fraction
    // hides a lower quantile: â‰ˆ44% of active cells paint (vs â‰ˆ26% pre-fix); the
    // old >0.6 band belonged to the p97 white point and is deliberately gone.
    expect(after).toBeGreaterThan(0.35);
    expect(after).toBeLessThan(0.55);
    expect(before).toBeLessThan(0.35);
    expect(after).toBeGreaterThan(before * 1.5);
  });

  it('separates the wall band instead of clamping it (the point of the change)', () => {
    const floor = floorForTolerance(DEFAULT_TOLERANCE);
    const gamma = gammaForContrast(DEFAULT_CONTRAST);
    const kneeLut = lut(P97, P99_7, floor, gamma); // p97 == knee
    const p99Lut = lut(P99, P99_7, floor, gamma);
    const whiteLut = lut(P99_7, P99_7, floor, gamma);
    // The wall band spreads across the ramp instead of all clamping to the top:
    // p97 (the knee) now sits at the low-span boundary (≈LUT 209 — the fixed
    // 0.85 share, 2026-09-13), p99 mid-high (≈LUT 238), p99.7 white.
    expect(kneeLut).toBeGreaterThanOrEqual(195);
    expect(kneeLut).toBeLessThanOrEqual(228);
    expect(p99Lut).toBeGreaterThanOrEqual(225);
    expect(p99Lut).toBeLessThanOrEqual(250);
    expect(whiteLut).toBe(255);
    expect(whiteLut - kneeLut).toBeGreaterThan(40); // real spread, no flat band
  });

  it('hides everything below the floor exactly (LUT 0 == background)', () => {
    const floor = floorForTolerance(DEFAULT_TOLERANCE);
    const gamma = gammaForContrast(DEFAULT_CONTRAST);
    // At p99.7 white the median..p70 of the heavy model sits under the default
    // floor (the tolerance's job); p90 is the first decile of the field that
    // reads as a clear indigo-blue (≈LUT 80 with the fixed low span).
    expect(lut(cell(0), P99_7, floor, gamma)).toBe(0); // median
    expect(lut(cell(0.5244), P99_7, floor, gamma)).toBeLessThanOrEqual(20); // p70
    const p90Lut = lut(cell(1.2816), P99_7, floor, gamma);
    expect(p90Lut).toBeGreaterThanOrEqual(65);
    expect(p90Lut).toBeLessThanOrEqual(100);
    // Pre-fix regression pin: with floor ≈0.06 + p99 the median maps to LUT 0.
    expect(lut(cell(0), P99, floorForTolerance(15), gamma)).toBe(0);
  });
});

describe('selectLevel (SUM-mip selection) â€” unchanged by the tolerance work', () => {
  it('stays on level 0 when rows do not collapse', () => {
    expect(selectLevel(1, 2)).toEqual({ level: 0, blk: 1, nRowTaps: 1 });
    expect(selectLevel(0.25, 2)).toEqual({ level: 0, blk: 1, nRowTaps: 1 });
  });

  it('is the identity with no mip chain', () => {
    expect(selectLevel(64, 0)).toEqual({ level: 0, blk: 1, nRowTaps: 1 });
  });

  it('climbs a level per 4Ã— of rows-per-pixel, capped at maxLevel', () => {
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

  it('never under-samples the footprint (ceil, campaign 4.2)', () => {
    // rpp in (blk, 2*blk) previously rounded DOWN to one tap â€” a 5.8-row pixel
    // sampled 4 rows and painted dashed price rows when zoomed far out.
    for (const rpp of [4.1, 5, 5.8, 6, 7.9, 8.1, 12, 15.9, 16.1, 31.9, 60]) {
      const sel = selectLevel(rpp, 2);
      const covered = sel.nRowTaps * sel.blk;
      // The tap block spans the footprint whenever the clamp allows it; above
      // 64 rows (4 taps Ã— level-2 blk) the grid's own 4096-row cap takes over.
      if (covered < rpp) {
        expect(covered, `rpp ${rpp} must hit the 4-tap clamp`).toBe(64);
      }
      expect(covered).toBeGreaterThanOrEqual(Math.min(rpp, 64));
    }
  });

  it('lands EXACTLY on the level boundary at every exact 4^k footprint (log2)', () => {
    // log2 is exact for powers of two on V8, so the level boundaries must hold
    // far past where log/log drifting could bite (level 4+ = 256+ rows/px).
    for (let k = 0; k <= 13; k++) {
      expect(selectLevel(4 ** k, 16).level).toBe(k);
    }
    for (let k = 2; k <= 13; k++) {
      expect(selectLevel(4 ** k - 1, 16).level).toBe(k - 1);
    }
    // Campaign-4.1: the ROW axis reaches level 1 at rpp â‰¥ 2.5 (footprint
    // smoothing on the SUM mip instead of an aliasing level-0 single sample).
    expect(selectLevel(2.4, 16).level).toBe(0);
    expect(selectLevel(2.5, 16).level).toBe(1);
    expect(selectLevel(3, 16).level).toBe(1);
    expect(selectLevel(3.99, 16).level).toBe(1);
  });
});

describe('selectLevel â€” the TIME axis counts (survey #3)', () => {
  it('is bit-identical to the row-only selector when colsPerPixel is defaulted/1', () => {
    for (const rpp of [0.25, 1, 2, 4, 8, 64, 4096]) {
      expect(selectLevel(rpp, 2)).toEqual(selectLevel(rpp, 2, 1));
      expect(selectLevel(rpp, 2, 0.5)).toEqual(selectLevel(rpp, 2, 1));
    }
  });

  it('climbs a level for time zoom-out while price is zoomed IN (the aliasing fix)', () => {
    // Whole-session review gesture: colSpan â‰« drawingBufferWidth (hundreds of
    // columns per pixel) at rowsPerPixel â‰¤ 1 â€” historically forced level 0.
    expect(selectLevel(1, 2, 1).level).toBe(0);
    expect(selectLevel(1, 2, 4).level).toBe(1);
    expect(selectLevel(1, 2, 16).level).toBe(2);
    expect(selectLevel(1, 2, 4096).level).toBe(2); // clamped to maxLevel
    expect(selectLevel(0.5, 2, 8).level).toBe(1);
  });

  it('takes the COARSER of the two axes and never regresses below either', () => {
    expect(selectLevel(16, 2, 1).level).toBe(2); // rows dominate
    expect(selectLevel(1, 2, 16).level).toBe(2); // cols dominate
    expect(selectLevel(16, 2, 16).level).toBe(2); // both
    expect(selectLevel(4, 2, 2).level).toBe(1);
  });

  it('keeps the row-tap bookkeeping consistent at col-driven levels', () => {
    // A col-driven level with price zoomed IN collapses to ONE row tap (the
    // pixel's row footprint â‰¤ blk) â€” the same (level, taps) a price zoom to
    // that level would produce, so intensity semantics do not fork per axis.
    const sel = selectLevel(1, 2, 20);
    expect(sel).toEqual({ level: 2, blk: 16, nRowTaps: 1 });
    expect(selectLevel(1, 2, 8)).toEqual({ level: 1, blk: 4, nRowTaps: 1 });
    // Non-finite inputs degrade to the identity instead of poisoning the level.
    expect(selectLevel(Number.NaN, 2, 8)).toEqual({ level: 1, blk: 4, nRowTaps: 1 });
    expect(selectLevel(8, 2, Number.NaN)).toEqual(selectLevel(8, 2, 1));
  });
});

describe('selectLevel â€” tick-grouping floor (contract P1)', () => {
  it('levelFloor=0 (the default) is bit-identical to the pre-P1 selector', () => {
    for (const rpp of [0.25, 1, 2.5, 4, 8, 64, 4096]) {
      for (const cpp of [0.5, 1, 3, 16]) {
        expect(selectLevel(rpp, 2, cpp, 0)).toEqual(selectLevel(rpp, 2, cpp));
      }
    }
  });

  it('lifts the level to the floor while price is zoomed IN', () => {
    expect(selectLevel(1, 2, 1)).toEqual({ level: 0, blk: 1, nRowTaps: 1 });
    expect(selectLevel(1, 2, 1, 1)).toEqual({ level: 1, blk: 4, nRowTaps: 1 });
    expect(selectLevel(1, 2, 1, 2)).toEqual({ level: 2, blk: 16, nRowTaps: 1 });
  });

  it('never lowers the axis-driven level (the floor is a lower bound)', () => {
    // Rows already need level 2: a level-1 floor changes nothing.
    expect(selectLevel(16, 2, 1, 1).level).toBe(2);
    // The floor composes with a col-driven level the same way.
    expect(selectLevel(1, 2, 16, 1).level).toBe(2);
    expect(selectLevel(0.5, 2, 8, 1).level).toBe(1);
  });

  it('clamps the floor to maxLevel and ignores it with no mip chain', () => {
    expect(selectLevel(1, 1, 1, 2).level).toBe(1);
    expect(selectLevel(1, 0, 1, 2)).toEqual({ level: 0, blk: 1, nRowTaps: 1 });
  });

  it('keeps the row-tap footprint consistent at a forced level', () => {
    // Forced level 2 with price zoomed in: one 16-row tap, same as if the pixel
    // had demanded it â€” intensity/floor semantics do not fork.
    expect(selectLevel(1, 2, 1, 2)).toEqual({ level: 2, blk: 16, nRowTaps: 1 });
    // Forced level 1 but the pixel already covers 8 rows â†’ 2 taps of 4.
    expect(selectLevel(8, 2, 1, 1)).toEqual({ level: 1, blk: 4, nRowTaps: 2 });
    // Non-finite floors degrade to no floor.
    expect(selectLevel(1, 2, 1, Number.NaN)).toEqual(selectLevel(1, 2, 1));
  });
});

describe('depth channel modes (contract C2) â€” the intensity chain', () => {
  // A fixed synthetic column: a bid-heavy wall low in the grid, an ask band
  // higher up, mirrored here exactly as the fragment shader computes it.
  const bid = new Float32Array(16);
  const ask = new Float32Array(16);
  bid[3] = 250; // dominant bid wall
  bid[4] = 30;
  ask[9] = 120; // ask band
  ask[10] = 40;

  const DECODE = 1;
  const NORM = 100;
  const FLOOR = 0.01;
  const GAMMA = 0.45;
  const BLK = 1; // level 0: intensity = density (the common live view)

  /** The shader chain from acc.rg to the LUT index â€” mirrored 1:1 from GLSL. */
  function lutIndex(accR: number, accG: number, channel: number): number {
    // GLSL int() truncates toward zero â€” the historical LUT-index conversion.
    const toIdx = (t: number): number => Math.trunc(t * 255 + 0.5);
    if (channel === 3) {
      const denom = accR + accG;
      if (denom <= 0) return -1; // background() â€” flagged, not a ramp index
      const d = Math.min(1, Math.max(-1, (accR - accG) / denom));
      return toIdx(d * 0.5 + 0.5);
    }
    let intensity = (accR + accG) * DECODE / BLK;
    if (channel === 1) intensity = accR * DECODE / BLK;
    else if (channel === 2) intensity = accG * DECODE / BLK;
    const t1 = Math.min(1, Math.max(0, intensity / Math.max(NORM, 1e-9)));
    const scale = 1 / Math.max(1 - FLOOR, 1e-6);
    const t2 = Math.min(1, Math.max(0, (t1 - FLOOR) * scale));
    const t3 = transferCurve(t2, {
      knee: DEFAULT_KNEE_FRACTION,
      gamma: GAMMA,
      logScale: TRANSFER_LOG_SCALE,
    });
    return toIdx(t3);
  }

  it("defaults to 'sum' with the historical u_channel code 0", () => {
    expect(DEFAULT_DEPTH_CHANNEL).toBe('sum');
    expect(DEPTH_CHANNEL_CODE.sum).toBe(0);
    expect(DEPTH_CHANNEL_CODE.bid).toBe(1);
    expect(DEPTH_CHANNEL_CODE.ask).toBe(2);
    expect(DEPTH_CHANNEL_CODE.imbalance).toBe(3);
    expect(depthChannelOf(undefined)).toBe('sum');
    expect(depthChannelOf('nonsense')).toBe('sum');
    expect(depthChannelOf('ask')).toBe('ask');
  });

  it('mode 0 computes the EXACT historical intensity expression', () => {
    // The shader's intensity expression for mode 0 must remain the shipped
    // string â€” the golden pixel parity e2e depends on it verbatim. The transfer
    // AFTER it (lane F) is mirrored 1:1 in `lutIndex`.
    expect(HEATMAP_FRAG).toContain(
      'float intensity = (acc.r + acc.g) * u_decodeScale / float(blk);',
    );
    const toIdx = (t: number): number => Math.trunc(t * 255 + 0.5);
    for (let r = 0; r < 16; r++) {
      const expected = toIdx(
        transferCurve(
          Math.min(1, Math.max(0, ((bid[r] + ask[r]) / NORM - FLOOR) / (1 - FLOOR))),
          { knee: DEFAULT_KNEE_FRACTION, gamma: GAMMA, logScale: TRANSFER_LOG_SCALE },
        ),
      );
      expect(lutIndex(bid[r], ask[r], 0)).toBe(expected);
    }
  });

  it('bid/ask modes isolate one side; every mode renders the field distinctly', () => {
    for (let r = 0; r < 16; r++) {
      const sum = lutIndex(bid[r], ask[r], 0);
      const onlyBid = lutIndex(bid[r], ask[r], 1);
      const onlyAsk = lutIndex(bid[r], ask[r], 2);
      if (bid[r] > 0 && ask[r] === 0) {
        expect(onlyBid).toBe(sum); // bid-only cell: sum === bid
        expect(onlyAsk).toBeLessThan(sum); // ask channel paints it dimmer
      } else if (ask[r] > 0 && bid[r] === 0) {
        expect(onlyAsk).toBe(sum);
        expect(onlyBid).toBeLessThan(sum);
      }
      if (bid[r] > 0 && ask[r] > 0) {
        expect(onlyBid).toBeLessThan(sum);
        expect(onlyAsk).toBeLessThan(sum);
      }
    }
  });

  it('imbalance is signed, fixed-domain, and maps blue â†” neutral â†” orange', () => {
    const imb = buildImbalanceLUT();
    // Pure bid wall â†’ orange half of the divergent row; pure ask â†’ blue half.
    const bidIdx = lutIndex(250, 0, 3);
    const askIdx = lutIndex(0, 120, 3);
    expect(bidIdx).toBeGreaterThan(128); // t > 0.5
    expect(askIdx).toBeLessThan(128); // t < 0.5
    expect(imb[bidIdx * 4]).toBeGreaterThan(imb[bidIdx * 4 + 2]); // R > B (orange)
    expect(imb[askIdx * 4 + 2]).toBeGreaterThan(imb[askIdx * 4]); // B > R (blue)
    // Balanced density â†’ the quiet neutral midpoint, NOT background red.
    const mid = lutIndex(60, 60, 3);
    expect(mid).toBe(128);
    // Magnitude is brightness per side: stronger dominance â†’ farther from 128.
    expect(lutIndex(250, 10, 3)).toBeGreaterThan(lutIndex(120, 10, 3));
    expect(lutIndex(10, 250, 3)).toBeLessThan(lutIndex(10, 120, 3));
  });

  it('the divergent row is quiet at the midpoint and bright at both extremes', () => {
    const imb = buildImbalanceLUT();
    const flow = buildFlowLUT();
    const luma = (lut: Uint8Array, i: number): number =>
      0.299 * lut[i * 4] + 0.587 * lut[i * 4 + 1] + 0.114 * lut[i * 4 + 2];
    // Midpoint â‰ˆ the terminal background (a balanced book must not light up).
    expect(luma(imb, 128)).toBeLessThan(30);
    // Both extremes are bright and hue-pure (CVD-safe blue/orange axis).
    expect(luma(imb, 0)).toBeGreaterThan(120);
    expect(luma(imb, 255)).toBeGreaterThan(120);
    expect(imb[2]).toBeGreaterThan(imb[0]); // blue end: B > R
    expect(imb[255 * 4]).toBeGreaterThan(imb[255 * 4 + 2]); // orange end: R > B
    // The DENSITY default row is untouched by the append (sanity).
    expect(flow.length).toBe(LUT_SIZE * 4);
  });
});

describe('smoothPlanFor — the width-scaled Gaussian sampler plan (lane F)', () => {
  it('pins the law: sigma = clamp(2.5 * cpp, 0.12, 2.0) with 3-sigma tap tiers', () => {
    // Deep zoom: sigma in PIXELS is the constant 2.5 â†’ sigmaCols = 2.5 * cpp.
    expect(SMOOTH_SIGMA_PX).toBe(2.5);
    expect(SMOOTH_MAX_TAPS).toBe(9);
    expect(smoothPlanFor(0.5)).toEqual({ sigmaCols: 1.25, taps: 5 });
    expect(smoothPlanFor(0.25)).toEqual({ sigmaCols: 0.625, taps: 3 });
    expect(smoothPlanFor(0.125)).toEqual({ sigmaCols: 0.3125, taps: 1 });
    expect(smoothPlanFor(0.6)).toEqual({ sigmaCols: 1.5, taps: 9 });
  });

  it('clamps the sigma into [0.12, 2.0] columns and drops to 1 tap at the floor', () => {
    expect(smoothPlanFor(0)).toEqual({ sigmaCols: 0.12, taps: 1 });
    expect(smoothPlanFor(0.04)).toEqual({ sigmaCols: 0.12, taps: 1 }); // 0.1 < min
    expect(smoothPlanFor(0.06)).toEqual({ sigmaCols: 0.15, taps: 1 }); // above the floor, dead tail
    expect(smoothPlanFor(4)).toEqual({ sigmaCols: 2, taps: 9 });
    expect(smoothPlanFor(64)).toEqual({ sigmaCols: 2, taps: 9 });
  });

  it('is monotone non-decreasing in colsPerPixel and never leaves the band', () => {
    let prev = -1;
    let prevTaps = 0;
    for (let cpp = 0; cpp <= 4; cpp += 0.05) {
      const p = smoothPlanFor(cpp);
      expect(p.sigmaCols).toBeGreaterThanOrEqual(prev);
      expect(p.sigmaCols).toBeGreaterThanOrEqual(0.12);
      expect(p.sigmaCols).toBeLessThanOrEqual(2);
      expect([1, 3, 5, SMOOTH_MAX_TAPS]).toContain(p.taps);
      expect(p.taps).toBeGreaterThanOrEqual(prevTaps); // tiers never shrink
      prev = p.sigmaCols;
      prevTaps = p.taps;
    }
    expect(prev).toBe(2);
    expect(prevTaps).toBe(9);
  });

  it('falls back to the minimum plan on non-finite/negative input', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -3]) {
      expect(smoothPlanFor(v)).toEqual({ sigmaCols: 0.12, taps: 1 });
    }
  });
});

describe('rowSmoothDyFor — the vertical barcode-fix softening (2026-09-13)', () => {
  it('pins the screen-pixel target and the sub-pixel no-op endpoint', () => {
    expect(SMOOTH_ROW_SIGMA_PX).toBe(2.2);
    // rpp 0.43 (~2.3 px rows, the live-book default): soft band.
    expect(rowSmoothDyFor(0.43)).toBeCloseTo(2.2 * 0.43, 12);
    // Sub-pixel rows: exact legacy path (no soften).
    expect(rowSmoothDyFor(2.0)).toBe(0);
    expect(rowSmoothDyFor(3.5)).toBe(0);
    // Cap.
    expect(rowSmoothDyFor(1.0)).toBe(1.2);
    expect(rowSmoothDyFor(1.9)).toBe(1.2);
  });

  it('degrades non-finite / non-positive input to the legacy path', () => {
    expect(rowSmoothDyFor(0)).toBe(0);
    expect(rowSmoothDyFor(-2)).toBe(0);
    expect(rowSmoothDyFor(Number.NaN)).toBe(0);
    expect(rowSmoothDyFor(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('rowMipSoftenFor — deep-row (row-mip) softening gate (2026-09-13)', () => {
  it('pins the enable value and the sub-regime no-op endpoint', () => {
    expect(SMOOTH_ROW_MIP_DY).toBe(1);
    // Inside the row-mip regime (rpp >= 2.5): the vertical Gaussian that turns
    // the default-view sub-pixel-row hairlines into soft bands.
    expect(rowMipSoftenFor(2.5)).toBe(1);
    expect(rowMipSoftenFor(3.05)).toBe(1); // the live-book default zoom
    expect(rowMipSoftenFor(8)).toBe(1);
    // Outside: exact 0 — the historical single-fetch row path stays byte-exact.
    expect(rowMipSoftenFor(2.4999)).toBe(0);
    expect(rowMipSoftenFor(2.0)).toBe(0);
    expect(rowMipSoftenFor(0.5)).toBe(0);
    expect(rowMipSoftenFor(Number.NaN)).toBe(0);
    expect(rowMipSoftenFor(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('rowMipWeightsFor: normalized, symmetric, screen-sigma pinned', () => {
    expect(SMOOTH_ROW_MIP_TAPS).toBe(7);
    expect(SMOOTH_ROW_MIP_SIGMA_PX).toBe(2.0);
    const w = rowMipWeightsFor(3.05);
    expect(w.length).toBe(7);
    const sum = Array.from(w).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    // Symmetric around the center tap; center is the largest.
    for (let i = 0; i < 3; i++) expect(w[i]).toBeCloseTo(w[6 - i], 12);
    for (let i = 0; i < 7; i++) if (i !== 3) expect(w[3]).toBeGreaterThan(w[i]);
    // Sigma in texels = 1.6 * rpp / 4 (rpp 3.05 -> 1.22): the ±1 tap carries
    // exp(-0.5/sigma^2) of the center BEFORE normalization — bounded and > 0.5.
    const sigma = (SMOOTH_ROW_MIP_SIGMA_PX * 3.05) / 4;
    const ratio = Math.exp(-0.5 / (sigma * sigma));
    expect(w[2] / w[3]).toBeCloseTo(ratio, 6);
    // Clamps: tiny rpp -> sigma floor 0.4 (narrow kernel, center dominant);
    // huge rpp -> sigma ceiling 2.5 (near-uniform kernel).
    const narrow = rowMipWeightsFor(0.01);
    expect(narrow[3]).toBeGreaterThan(0.9);
    const wide = rowMipWeightsFor(512);
    expect(wide[0] / wide[3]).toBeGreaterThan(0.4);
    // Non-finite degrades to the rpp=1 kernel, never NaN.
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = rowMipWeightsFor(v);
      expect(Array.from(f).some((x) => Number.isNaN(x))).toBe(false);
      expect(Array.from(f).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    }
  });
});

describe('transferCurve — the two-segment transfer (low-span calibrated)', () => {
  const K = 0.4;
  const S = TRANSFER_LOW_SPAN;
  const base = { knee: K, gamma: 0.86, logScale: TRANSFER_LOG_SCALE };
  const above = (t: number): number =>
    S +
    (1 - S) *
      (Math.log1p((TRANSFER_LOG_SCALE * (t - K)) / (1 - K)) / Math.log1p(TRANSFER_LOG_SCALE));

  it('pins both endpoints exactly (f(0)=0 → background, f(1)=1 → LUT 255)', () => {
    expect(transferCurve(0, base)).toBe(0);
    expect(transferCurve(1, base)).toBe(1);
    expect(TRANSFER_LOG_SCALE).toBe(6.0);
    expect(TRANSFER_LOW_SPAN).toBe(0.85);
  });

  it('is continuous at the knee and matches both analytic branches', () => {
    expect(transferCurve(K, base)).toBeCloseTo(S, 12);
    expect(transferCurve(K - 1e-9, base)).toBeCloseTo(S, 6);
    expect(transferCurve(0.2, base)).toBeCloseTo(S * Math.pow(0.2 / K, 0.86), 12);
    expect(transferCurve(0.7, base)).toBeCloseTo(above(0.7), 12);
    // The below-knee segment owns a FIXED output share: a tiny knee (the live
    // heavy-tail case ≈0.18) must not cap the mid-field near LUT 45 — the
    // 2026-09-13 owner-reported black-field regression.
    expect(transferCurve(0.18, { ...base, knee: 0.18 })).toBeCloseTo(S, 12);
    expect(transferCurve(0.09, { ...base, knee: 0.18 })).toBeCloseTo(
      S * Math.pow(0.5, 0.86),
      12,
    );
  });

  it('is monotone non-decreasing across [0,1]', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = transferCurve(i / 100, base);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(prev).toBe(1);
  });

  it('clamps out-of-range t and degrades non-finite input safely', () => {
    expect(transferCurve(-1, base)).toBe(0);
    expect(transferCurve(2, base)).toBe(1);
    expect(transferCurve(Number.NaN, base)).toBe(0);
    expect(transferCurve(Number.POSITIVE_INFINITY, base)).toBe(0);
  });
});

describe('rowFadeFor / effectiveRowMode â€” the smooth row-mip cross-fade (lane P)', () => {
  it('is exactly 0 at/below 2.0 rows-per-pixel and on non-finite input', () => {
    expect(rowFadeFor(1.9)).toBe(0);
    expect(rowFadeFor(2.0)).toBe(0);
    expect(rowFadeFor(0.5)).toBe(0);
    expect(rowFadeFor(Number.NaN)).toBe(0);
    expect(rowFadeFor(Number.POSITIVE_INFINITY)).toBe(0);
    expect(rowFadeFor(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('is exactly 1 at/above 3.0 rows-per-pixel (the completed row-mip regime)', () => {
    expect(rowFadeFor(3.0)).toBe(1);
    expect(rowFadeFor(3.2)).toBe(1);
    expect(rowFadeFor(4.5)).toBe(1);
    expect(rowFadeFor(6)).toBe(1);
    expect(rowFadeFor(8)).toBe(1);
    expect(rowFadeFor(64)).toBe(1);
  });

  it('ramps linearly through the middle (band [2.0, 3.0])', () => {
    expect(rowFadeFor(2.5)).toBeCloseTo(0.5, 12);
    // t = (rpp-2.0)/1.0; quarter points.
    expect(rowFadeFor(2.25)).toBeCloseTo(0.25, 12);
    expect(rowFadeFor(2.75)).toBeCloseTo(0.75, 12);
    // W1 2026-09-13: the upper edge moved 4.5 -> 3.0. At the rpp ~3.05 default
    // zoom the old band left ~72% raw single-row weight, which kept hairlines
    // alive; 3.0 completes the mip handoff exactly at the default (both
    // endpoints exact). The e2e gesture now reads 1.0.
    expect(rowFadeFor(3.05)).toBe(1);
  });

  it('is monotonically non-decreasing across the band', () => {
    let prev = -1;
    for (let rpp = 1.0; rpp <= 5; rpp += 0.05) {
      const f = rowFadeFor(rpp);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
    expect(prev).toBe(1);
  });

  it('effectiveRowMode forces the legacy path without a usable/eligible row chain', () => {
    expect(effectiveRowMode(8, false)).toEqual({ rowOnly: false, rowFade: 0 });
    expect(effectiveRowMode(Number.NaN, true)).toEqual({ rowOnly: false, rowFade: 0 });
    expect(effectiveRowMode(8, true)).toEqual({ rowOnly: true, rowFade: 1 });
    // Eligibility (selectLevel's rowOnly regime: rpp >= 2.5, deep time zoom,
    // no tick-grouping floor) is the draw's second gate.
    expect(effectiveRowMode(8, true, false)).toEqual({ rowOnly: false, rowFade: 0 });
    expect(effectiveRowMode(2.6, false, true)).toEqual({ rowOnly: false, rowFade: 0 });
  });

  it('renormalizes the fade at the row-mip eligibility edge (continuous handoff)', () => {
    // The raw rowFadeFor knee at 2.5 is 0.5; the draw starts the blend at
    // weight 0 there so the switch from the level-0 sample to the row mix has
    // no step, then ramps to full row sums at 3.0. Both endpoints are exact.
    const knee = rowFadeFor(2.5);
    expect(knee).toBeGreaterThan(0);
    expect(knee).toBeLessThan(1);
    expect(effectiveRowMode(2.5, true).rowFade).toBe(0);
    expect(effectiveRowMode(3.0, true).rowFade).toBe(1);
    expect(effectiveRowMode(4.5, true).rowFade).toBe(1);
    expect(effectiveRowMode(2.8, true).rowFade).toBeCloseTo(
      (rowFadeFor(2.8) - knee) / (1 - knee),
      12,
    );
    expect(effectiveRowMode(3.05, true).rowFade).toBe(1);
  });

  it('is monotone in rpp and keeps rowOnly === (rowFade > 0)', () => {
    let prev = -1;
    for (let rpp = 1.0; rpp <= 5; rpp += 0.05) {
      const m = effectiveRowMode(rpp, true);
      expect(m.rowOnly).toBe(m.rowFade > 0);
      expect(m.rowFade).toBeGreaterThanOrEqual(prev);
      expect(m.rowFade).toBeGreaterThanOrEqual(0);
      expect(m.rowFade).toBeLessThanOrEqual(1);
      prev = m.rowFade;
    }
    expect(prev).toBe(1);
  });
});

describe('the row-mip cross-fade in the fragment shader source (lane P)', () => {
  it('declares u_rowFade and blends the level-0 sample with the row sums', () => {
    expect(HEATMAP_FRAG).toContain('uniform float u_rowFade;');
    expect(HEATMAP_FRAG).toContain(
      'acc = mix(acc, accRow, clamp(u_rowFade, 0.0, 1.0));',
    );
  });

  it('skips the row fetches at the legacy endpoint and the level-0 sample at the full endpoint', () => {
    expect(HEATMAP_FRAG).toContain('if (u_rowFade > 0.001) {');
    expect(HEATMAP_FRAG).toContain('if (u_rowFade >= 0.999) {');
    // The historical lane-P intensity correction still keys off u_rowOnly.
    expect(HEATMAP_FRAG).toContain('if (u_rowOnly == 1) intensity *= float(blk);');
  });
});

describe('the Gaussian sampler + transfer curve in the fragment shader source (lane F)', () => {
  it('declares the sampler/transfer uniforms and retires blur/crisp', () => {
    expect(HEATMAP_FRAG).toContain('uniform int u_smoothTaps;');
    expect(HEATMAP_FRAG).toContain('uniform float u_smoothOffsets[9];');
    expect(HEATMAP_FRAG).toContain('uniform float u_smoothWeights[9];');
    expect(HEATMAP_FRAG).toContain('uniform float u_knee;');
    expect(HEATMAP_FRAG).toContain('uniform float u_logScale;');
    expect(HEATMAP_FRAG).not.toContain('u_colBlur');
    expect(HEATMAP_FRAG).not.toContain('u_colCell');
    expect(HEATMAP_FRAG).not.toContain('crisp0');
  });

  it('loops the fixed 9-tap table, gating out-of-window taps and renormalizing', () => {
    expect(HEATMAP_FRAG).toContain('for (int t = 0; t < 9; t++) {');
    expect(HEATMAP_FRAG).toContain('if (t >= u_smoothTaps) break;');
    expect(HEATMAP_FRAG).toContain('float colAt = colf + off;');
    expect(HEATMAP_FRAG).toContain(
      'colAt < float(u_validFrom) - 0.5 || colAt > float(u_residentNewest) + 0.5',
    );
    expect(HEATMAP_FRAG).toContain('acc += fieldAt(colAt, rowf) * w;');
    expect(HEATMAP_FRAG).toContain('acc /= wsum;');
    expect(HEATMAP_FRAG).toContain(
      'fieldAt(clamp(colf, float(u_validFrom), float(u_residentNewest)), rowf)',
    );
  });

  it('softens the price axis vertically (barcode fix) with a 0-endpoint legacy path', () => {
    // The uniform + helper exist…
    expect(HEATMAP_FRAG).toContain('uniform float u_rowSmoothDy;');
    expect(HEATMAP_FRAG).toContain('vec2 fieldAt(float colf, float rowf) {');
    expect(HEATMAP_FRAG).toContain('if (u_rowSmoothDy <= 0.0) return bilinear0(colf, rowf);');
    expect(HEATMAP_FRAG).toContain(
      '0.25 * bilinear0(colf, rowf - u_rowSmoothDy)',
    );
    expect(HEATMAP_FRAG).toContain(
      '0.50 * bilinear0(colf, rowf)',
    );
    expect(HEATMAP_FRAG).toContain(
      '0.25 * bilinear0(colf, rowf + u_rowSmoothDy)',
    );
  });

  it('applies the transfer AFTER the black point with exact endpoints', () => {
    expect(HEATMAP_FRAG).toContain('t = clamp((t - u_floor) * u_floorScale, 0.0, 1.0);');
    expect(HEATMAP_FRAG).toContain('if (t <= k) {');
    expect(HEATMAP_FRAG).toContain('t = span * pow(t / k, u_gamma);');
    expect(HEATMAP_FRAG).toContain(
      'log(1.0 + u_logScale * (t - k) / (1.0 - k)) / log(1.0 + u_logScale)',
    );
    // The fixed below-knee span (2026-09-13 calibration) must be in the shader.
    expect(HEATMAP_FRAG).toContain('uniform float u_lowSpan;');
    expect(HEATMAP_FRAG).toContain('float span = u_lowSpan;');
    // The pinned historical intensity expression is untouched.
    expect(HEATMAP_FRAG).toContain(
      'float intensity = (acc.r + acc.g) * u_decodeScale / float(blk);',
    );
  });

  it('level-0 and the SUM finer side both sample the Gaussian (one kernel)', () => {
    expect(HEATMAP_FRAG).toContain('acc = sampleField0(colf, rowf);');
    const mipBranch = HEATMAP_FRAG.slice(HEATMAP_FRAG.indexOf('} else {'));
    expect(mipBranch).toContain('accF = sampleField0(colf, rowf);');
  });
});

describe('selectLevel â€” row-only mip at deep time zoom (campaign visual 2026-09-11, R2-M1)', () => {
  it('flags rowOnly for the collapsing-price / deep-time gesture', () => {
    const a = selectLevel(3.05, 2, 0.25);
    expect(a.rowOnly).toBe(true);
    expect(a.nRowTaps).toBe(1); // ceil(3.05 / 4)
    const b = selectLevel(6, 2, 0.1);
    expect(b.rowOnly).toBe(true);
    expect(b.nRowTaps).toBe(2); // ceil(6 / 4)
  });

  it('stays off when price is zoomed in, time is zoomed out, or there are no mips', () => {
    expect(selectLevel(1, 2, 0.2).rowOnly).toBeUndefined(); // rpp < 2.5
    expect(selectLevel(2.4, 2, 0.2).rowOnly).toBeUndefined();
    expect(selectLevel(3, 2, 2).rowOnly).toBeUndefined(); // cpp >= 1.5
    expect(selectLevel(3, 0, 0.2).rowOnly).toBeUndefined(); // no mip chain
  });

  it('yields to a tick-grouping floor (the historical forced SUM path)', () => {
    // The flag is additive: level/blk/nRowTaps keep the historical fields, so
    // every pre-existing consumer output is unchanged.
    const floored = selectLevel(8, 2, 1, 1);
    expect(floored.rowOnly).toBeUndefined();
    expect(floored).toEqual({ level: 1, blk: 4, nRowTaps: 2 });
  });
});

describe('the row-only mip path in the fragment shader source', () => {
  it('declares the row mip sampler + rowOnly uniform', () => {
    expect(HEATMAP_FRAG).toContain('uniform highp sampler2DArray u_rowMip1;');
    expect(HEATMAP_FRAG).toContain('uniform int u_rowOnly;');
  });

  it('samples 4-row sums of ONE column and undoes the SUM-path column division', () => {
    expect(HEATMAP_FRAG).toMatch(/texelFetch\(u_rowMip1,\s*ivec3\(x0,\s*y,\s*layer\),\s*0\)/);
    expect(HEATMAP_FRAG).toContain('if (u_rowOnly == 1) intensity *= float(blk);');
    // The pinned historical intensity expression is untouched.
    expect(HEATMAP_FRAG).toContain(
      'float intensity = (acc.r + acc.g) * u_decodeScale / float(blk);',
    );
  });

  it('applies the deep-row Gaussian through fetchRowMipGauss at BOTH row-mip sites', () => {
    expect(HEATMAP_FRAG).toContain('uniform float u_rowMipSoften;');
    expect(HEATMAP_FRAG).toContain('uniform float u_rowMipWeights[7];');
    expect(HEATMAP_FRAG).toContain('vec2 fetchRowMipGauss(int x, int layer, float yMip) {');
    // The bilinear reconstruction between mip texels + the uniform weights.
    expect(HEATMAP_FRAG).toContain('acc += v * u_rowMipWeights[k + 3];');
    // Edge-aware: isolated walls keep their own texel (SUM-mip contract — see
    // mips.spec.ts), dense level-stacks get the soft Gaussian (barcode fix).
    expect(HEATMAP_FRAG).toContain(
      'vec2 keep = clamp(1.0 - 2.0 * neighborMax / max(center, vec2(1e-6)), 0.0, 1.0);',
    );
    expect(HEATMAP_FRAG).toContain('return mix(acc, center, keep);');
    // Both the full row endpoint and the lane-P fade branch gate on the
    // 1-tap footprint; wider footprints keep the historical single-fetch loop.
    expect(HEATMAP_FRAG).toContain('if (u_rowMipSoften > 0.0 && u_nRowTaps == 1) {');
    expect(HEATMAP_FRAG).toContain('acc = fetchRowMipGauss(x0, layer, (rowf + 0.5) * 0.25 - 0.5);');
    expect(HEATMAP_FRAG).toContain('accRow = fetchRowMipGauss(x0, layer, (rowf + 0.5) * 0.25 - 0.5);');
    // The legacy row fetch still exists (byte-exact endpoint when soften is 0).
    expect(HEATMAP_FRAG).toMatch(/texelFetch\(u_rowMip1,\s*ivec3\(x0,\s*y,\s*layer\),\s*0\)/);
  });
});

describe('levelBlendFor â€” the SUM-mip LOD cross-fade (wave P2)', () => {
  it('is pure level 0 with no blend for tiny/non-finite footprints', () => {
    expect(levelBlendFor(0.5, 2)).toEqual({ level: 0, finerLevel: -1, fade: 0 });
    expect(levelBlendFor(1, 2)).toEqual({ level: 0, finerLevel: -1, fade: 0 });
    expect(levelBlendFor(0, 2)).toEqual({ level: 0, finerLevel: -1, fade: 0 });
    expect(levelBlendFor(-3, 2)).toEqual({ level: 0, finerLevel: -1, fade: 0 });
    expect(levelBlendFor(Number.NaN, 2)).toEqual({ level: 0, finerLevel: -1, fade: 0 });
    expect(levelBlendFor(Number.POSITIVE_INFINITY, 2)).toEqual({
      level: 0,
      finerLevel: -1,
      fade: 0,
    });
    expect(levelBlendFor(Number.NEGATIVE_INFINITY, 2)).toEqual({
      level: 0,
      finerLevel: -1,
      fade: 0,
    });
  });

  it('blends across the 4^1 boundary: pure 0 below 2.2, pure 1 at 4.0', () => {
    // 0.55*4 = 2.2 â€” the (widened) band start: fade 0, pure level 0 == old output.
    expect(levelBlendFor(2.2, 2)).toEqual({ level: 0, finerLevel: -1, fade: 0 });
    // Mid-band: 0 < fade < 1, coarse level k=1 with the finer level 0 mixed in.
    const band = levelBlendFor(3.2, 2);
    expect(band.level).toBe(1);
    expect(band.finerLevel).toBe(0);
    expect(band.fade).toBeGreaterThan(0);
    expect(band.fade).toBeLessThan(1);
    // t = 0.5 at fp = 4*(0.55 + 0.45*0.5) = 3.1 -> smoothstep midpoint exactly.
    expect(levelBlendFor(3.1, 2).fade).toBeCloseTo(0.5, 6);
    // Approaching 4.0 the coarse level dominates but the finer sample remains.
    const near = levelBlendFor(3.99, 2);
    expect(near.level).toBe(1);
    expect(near.finerLevel).toBe(0);
    expect(near.fade).toBeGreaterThan(0.99);
    expect(near.fade).toBeLessThan(1);
    // EXACTLY the old switch point: w = 1 -> pure coarse level 1 (no second sample).
    expect(levelBlendFor(4.0, 2)).toEqual({ level: 1, finerLevel: -1, fade: 1 });
    // Just past the boundary: pure level 1 again (the old output), no finer sample.
    expect(levelBlendFor(4.5, 2)).toEqual({ level: 1, finerLevel: -1, fade: 0 });
  });

  it('blends across the 4^2 boundary: pure 1 at 8.8, half at 12.4, pure 2 at 16', () => {
    expect(levelBlendFor(8.8, 2)).toEqual({ level: 1, finerLevel: -1, fade: 0 }); // 0.55*16
    const half = levelBlendFor(12.4, 2);
    expect(half.level).toBe(2);
    expect(half.finerLevel).toBe(1);
    expect(half.fade).toBeCloseTo(0.5, 6);
    const near = levelBlendFor(15.99, 2);
    expect(near.level).toBe(2);
    expect(near.fade).toBeGreaterThan(0.99);
    expect(near.fade).toBeLessThan(1);
    expect(levelBlendFor(16, 2)).toEqual({ level: 2, finerLevel: -1, fade: 1 });
  });

  it('saturates at maxLevel beyond 4^maxLevel (no infinite coarse climb)', () => {
    expect(levelBlendFor(64, 2)).toEqual({ level: 2, finerLevel: -1, fade: 1 });
    expect(levelBlendFor(1e6, 2)).toEqual({ level: 2, finerLevel: -1, fade: 1 });
    expect(levelBlendFor(4096, 2).level).toBe(2);
  });

  it('is monotone within each transition band (continuous handoff)', () => {
    for (const [lo, hi] of [
      [2.2, 4],
      [8.8, 16],
    ] as const) {
      let prev = -1;
      for (let i = 0; i <= 100; i++) {
        const fp = lo + ((hi - lo) * i) / 100;
        const { fade } = levelBlendFor(fp, 2);
        expect(fade).toBeGreaterThanOrEqual(prev);
        prev = fade;
      }
      expect(prev).toBe(1);
    }
  });

  it('matches selectLevel outside the bands (byte-identity at the old switch points)', () => {
    // Column-driven fps (rows stay at 1): the blend's pure endpoints must equal
    // the historical selector everywhere outside the (widened) bands. Inside the
    // bands they intentionally differ â€” that IS the cross-fade.
    for (const fp of [0.5, 1, 1.5, 2.0, 2.19, 4.0, 4.5, 8, 8.79, 16, 20, 64, 4096]) {
      expect(levelBlendFor(fp, 2).level, `fp ${fp}`).toBe(selectLevel(1, 2, fp).level);
    }
    // The fade-1 upload is the coarse 4^k the OLD selector picked at that fp.
    expect(levelBlendFor(4, 2)).toEqual({
      level: selectLevel(1, 2, 4).level,
      finerLevel: -1,
      fade: 1,
    });
    expect(levelBlendFor(16, 2)).toEqual({
      level: selectLevel(1, 2, 16).level,
      finerLevel: -1,
      fade: 1,
    });
  });

  it('refuses to blend a forced tick-grouping floor or an absent mip chain', () => {
    // A forced floor is an explicit user choice of block size: pure + bit-exact.
    expect(levelBlendFor(8, 2, 2)).toEqual({ level: 2, finerLevel: -1, fade: 0 });
    expect(levelBlendFor(3.5, 2, 1)).toEqual({ level: 1, finerLevel: -1, fade: 0 });
    // No mips (maxLevel 0) -> the identity path; a NaN floor degrades to 0.
    expect(levelBlendFor(8, 0)).toEqual({ level: 0, finerLevel: -1, fade: 0 });
    expect(levelBlendFor(8, 2, Number.NaN)).toEqual(levelBlendFor(8, 2));
  });
});

describe('the SUM-mip level cross-fade in the fragment shader source (wave P2)', () => {
  it('declares the fade uniforms and mixes the finer sample into the SUM branch', () => {
    expect(HEATMAP_FRAG).toContain('uniform float u_levelFade;');
    expect(HEATMAP_FRAG).toContain('uniform int u_nRowTapsFine;');
    expect(HEATMAP_FRAG).toContain(
      'acc = mix(accF * 4.0, acc, clamp(u_levelFade, 0.0, 1.0));',
    );
    expect(HEATMAP_FRAG).toContain('if (u_levelFade > 0.001) {');
    // The finer fetch lives in the SUM else-branch only (level 0 never blends).
    const mipBranch = HEATMAP_FRAG.slice(HEATMAP_FRAG.indexOf('} else {'));
    expect(mipBranch).toContain('fetchFine(');
    expect(mipBranch).toContain('int blkF = blk / 4;');
    // The pinned historical intensity expression is untouched.
    expect(HEATMAP_FRAG).toContain(
      'float intensity = (acc.r + acc.g) * u_decodeScale / float(blk);',
    );
  });

  it('leaves the level-0 and row-mip branches free of level-fade sampling', () => {
    const levelZero = HEATMAP_FRAG.slice(
      HEATMAP_FRAG.indexOf('} else if (u_level == 0) {'),
      HEATMAP_FRAG.indexOf('} else {'),
    );
    expect(levelZero).not.toContain('fetchFine(');
    expect(levelZero).not.toContain('u_levelFade');
  });
});

describe('Heatmap.draw â€” SUM-path level cross-fade uniform wiring (wave P2)', () => {
  function makeMipHeatmap(): { heatmap: Heatmap; gl: FakeGL } {
    const gl = makeFakeGL({ colorBufferFloat: true });
    const ctx: GLContext = {
      gl,
      caps: {
        maxTextureImageUnits: 16,
        maxArrayTextureLayers: 2048,
        maxTextureSize: 8192,
        colorBufferFloat: true,
      },
    };
    const ring = new TileRing(gl, 16, 1);
    const chain = new MipChain(ctx, COLS_PER_TILE, 16, 1);
    const heatmap = new Heatmap(ctx, ring, gl.createTexture()!);
    heatmap.mips = chain;
    for (let s = 0; s <= 7; s++) {
      const bid = new Float32Array(16);
      ring.append(s, 0, bid, new Float32Array(16), 16);
      chain.updateFrom(ring, s);
    }
    return { heatmap, gl };
  }

  function lastInt(gl: FakeGL, name: string): number | undefined {
    const calls = gl
      .callsOf('uniform1i')
      .filter((c) => (c.args[0] as { uniform?: string } | null)?.uniform === name);
    return calls.length > 0 ? (calls[calls.length - 1].args[1] as number) : undefined;
  }
  function lastFloat(gl: FakeGL, name: string): number | undefined {
    const calls = gl
      .callsOf('uniform1f')
      .filter((c) => (c.args[0] as { uniform?: string } | null)?.uniform === name);
    return calls.length > 0 ? (calls[calls.length - 1].args[1] as number) : undefined;
  }

  it('uploads the legacy selection below the band (fade 0, finerLevel -1)', () => {
    const { heatmap, gl } = makeMipHeatmap();
    // rpp 2 (< 2.5), cpp 2.1 (< 0.55*4): outside the band -> legacy level 0.
    heatmap.draw({ colOffset: 0, colScale: 2.1 * 320, rowOffset: 0, rowScale: 2 * 240 });
    expect(lastInt(gl, 'u_level')).toBe(0);
    expect(lastInt(gl, 'u_blk')).toBe(1);
    expect(lastInt(gl, 'u_nRowTaps')).toBe(2);
    expect(lastFloat(gl, 'u_levelFade')).toBe(0);
    expect(lastInt(gl, 'u_nRowTapsFine')).toBe(1);
    expect(heatmap.sampleInfo().finerLevel).toBe(-1);
  });

  it('uploads u_rowMipSoften only inside the row-mip regime (barcode fix)', () => {
    const { heatmap, gl } = makeMipHeatmap();
    // rpp 3.05 (the live-book default zoom), cpp 0.25: inside the regime.
    heatmap.draw({ colOffset: 0, colScale: 0.25 * 320, rowOffset: 600, rowScale: 3.05 * 240 });
    expect(lastFloat(gl, 'u_rowMipSoften')).toBe(SMOOTH_ROW_MIP_DY);
    expect(lastInt(gl, 'u_rowOnly')).toBe(1);
    // rpp 2.0: outside -> 0 (legacy level-0 path, dy=0 endpoint untouched).
    heatmap.draw({ colOffset: 0, colScale: 2.1 * 320, rowOffset: 0, rowScale: 2 * 240 });
    expect(lastFloat(gl, 'u_rowMipSoften')).toBe(0);
    expect(lastInt(gl, 'u_rowOnly')).toBe(0);
  });

  it('uploads the blend inside the band: coarse k=1 with the finer taps', () => {
    const { heatmap, gl } = makeMipHeatmap();
    // rpp 2, cpp 3.2 -> fp 3.2: k=1, linear fade = (3.2-2.2)/1.8 = 0.556.
    heatmap.draw({ colOffset: 0, colScale: 3.2 * 320, rowOffset: 0, rowScale: 2 * 240 });
    expect(lastInt(gl, 'u_level')).toBe(1);
    expect(lastInt(gl, 'u_blk')).toBe(4);
    expect(lastInt(gl, 'u_nRowTaps')).toBe(1); // ceil(2 / 4)
    expect(lastFloat(gl, 'u_levelFade')).toBeCloseTo(0.556, 3);
    expect(lastInt(gl, 'u_nRowTapsFine')).toBe(2); // ceil(2 / 1)
    const info = heatmap.sampleInfo();
    expect(info.levelFade).toBeCloseTo(0.556, 3);
    expect(info.finerLevel).toBe(0);
    expect(info.rowFade).toBe(0);
  });

  it('uploads pure coarse at the historical switch point (fade 1 == old output)', () => {
    const { heatmap, gl } = makeMipHeatmap();
    // rpp 2, cpp 4.0 -> fp 4.0: fade 1, pure level 1 with the OLD blk/taps.
    heatmap.draw({ colOffset: 0, colScale: 4 * 320, rowOffset: 0, rowScale: 2 * 240 });
    expect(lastInt(gl, 'u_level')).toBe(1);
    expect(lastInt(gl, 'u_blk')).toBe(4);
    expect(lastInt(gl, 'u_nRowTaps')).toBe(1);
    expect(lastFloat(gl, 'u_levelFade')).toBe(1);
    expect(heatmap.sampleInfo().finerLevel).toBe(-1);
  });

  it('keeps the row path free of level blending (rowFade owns the row axis)', () => {
    const { heatmap, gl } = makeMipHeatmap();
    // rpp 3.05 (row-mip regime), cpp 0.25: row path -> level 0 / blk 4 / rowOnly.
    heatmap.draw({ colOffset: 0, colScale: 0.25 * 320, rowOffset: 0, rowScale: 3.05 * 240 });
    expect(lastInt(gl, 'u_rowOnly')).toBe(1);
    expect(lastInt(gl, 'u_level')).toBe(0);
    expect(lastInt(gl, 'u_blk')).toBe(4);
    expect(lastFloat(gl, 'u_levelFade')).toBe(0);
    const info = heatmap.sampleInfo();
    expect(info.rowFade).toBeGreaterThan(0);
    expect(info.levelFade).toBe(0);
    expect(info.finerLevel).toBe(-1);
  });

  it('lane F: uploads the knee fallback, log scale and the CPU Gaussian tap table', () => {
    const { heatmap, gl } = makeMipHeatmap();
    // The jsdom FakeGL predates array uniforms; record the optional call so the
    // tap table can be asserted. Real WebGL2 always exposes uniform1fv.
    (gl as unknown as { uniform1fv: (...a: unknown[]) => void }).uniform1fv = (...a: unknown[]) =>
      gl.calls.push({ name: 'uniform1fv', args: a });
    heatmap.draw({ colOffset: 0, colScale: 0.5 * 320, rowOffset: 0, rowScale: 240 });
    // No normalizer attached: the module fallback fraction.
    expect(lastFloat(gl, 'u_knee')).toBeCloseTo(DEFAULT_KNEE_FRACTION, 12);
    expect(lastFloat(gl, 'u_logScale')).toBeCloseTo(TRANSFER_LOG_SCALE, 12);
    expect(lastFloat(gl, 'u_lowSpan')).toBeCloseTo(TRANSFER_LOW_SPAN, 12);
    // Vertical barcode-fix soften: rpp = 240/240 = 1 → capped 1.2 rows.
    expect(lastFloat(gl, 'u_rowSmoothDy')).toBeCloseTo(1.2, 12);
    // cpp 0.5 → sigma 1.25 columns → the 5-tap tier (≥3σ truncation).
    expect(lastInt(gl, 'u_smoothTaps')).toBe(5);
    const arrays = gl.callsOf('uniform1fv');
    const weights = arrays.find(
      (c) => (c.args[0] as { uniform?: string }).uniform === 'u_smoothWeights[0]',
    );
    const offsets = arrays.find(
      (c) => (c.args[0] as { uniform?: string }).uniform === 'u_smoothOffsets[0]',
    );
    expect(weights).toBeDefined();
    expect(offsets).toBeDefined();
    const o = offsets!.args[1] as Float32Array;
    const w = weights!.args[1] as Float32Array;
    // Centered subset: the shader's fixed loop reads [0..taps) = [-2,-1,0,1,2].
    expect(Array.from(o).slice(0, 5)).toEqual([-2, -1, 0, 1, 2]);
    expect(Array.from(o).slice(5)).toEqual([0, 0, 0, 0]);
    expect(w[2]).toBeGreaterThan(w[1]); // the core tap is the heaviest
    expect(Array.from(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    const info = heatmap.sampleInfo();
    expect(info.smoothSigma).toBeCloseTo(1.25, 12); // 2.5 * cpp 0.5
    expect(info.smoothTaps).toBe(5);
  });

  it('lane F: with a normalizer attached, uploads the clamped knee/white ratio', () => {
    const { heatmap, gl } = makeMipHeatmap();
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE, floor: 0 });
    n.addColumn(0, new Float32Array(100).fill(10), null);
    n.updateNorm({ oldest: 0, newest: 255 }, { lo: 0, hi: 2047 }, 0);
    heatmap.normalizer = n;
    heatmap.draw({ colOffset: 0, colScale: 320, rowOffset: 0, rowScale: 240 });
    const pcts = n.currentPercentiles;
    // Flat fixture: knee/white ≈ 1 → clamped to the top of the band.
    expect(lastFloat(gl, 'u_knee')).toBeCloseTo(
      Math.min(0.95, Math.max(0.05, pcts.knee / pcts.white)),
      12,
    );
    expect(lastFloat(gl, 'u_knee')).toBeCloseTo(0.95, 12);
  });

  it('lane F: a seeded-only normalizer still yields a safe in-band knee', () => {
    const { heatmap, gl } = makeMipHeatmap();
    const n = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE, floor: 0 });
    n.seed(42);
    heatmap.normalizer = n;
    heatmap.knee = 0.3; // must be ignored while a normalizer is attached
    heatmap.draw({ colOffset: 0, colScale: 320, rowOffset: 0, rowScale: 240 });
    const knee = lastFloat(gl, 'u_knee')!;
    expect(knee).toBeGreaterThanOrEqual(0.05);
    expect(knee).toBeLessThanOrEqual(0.95);
  });
});

