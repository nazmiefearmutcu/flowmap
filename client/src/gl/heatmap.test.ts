import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONTRAST,
  DEFAULT_DISPLAY_GAMMA,
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
  sampleMix,
  selectLevel,
  TOLERANCE_MAX_FLOOR,
} from './heatmap';
import { buildImbalanceLUT, buildFlowLUT, LUT_SIZE } from './lut';
import { MipChain } from './mips';
import { makeFakeGL, type FakeGL } from './mockGL';
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
  // ladder). All quantiles below are derived from that one shape assumption.
  const SIGMA = Math.log(50) / 2.3263; // p99/median = exp(2.3263Â·Ïƒ) = 50 â†’ Ïƒ â‰ˆ 1.68
  const P99 = Math.exp(2.3263 * SIGMA);
  const P97 = Math.exp(1.8808 * SIGMA); // standard-normal quantile for 97%

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

  /** The fragment shader chain: normalize â†’ black point â†’ gamma â†’ LUT index. */
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

  it('keeps ~3Ã— more of the field visible than the pre-fix defaults', () => {
    const floor = floorForTolerance(DEFAULT_TOLERANCE);
    const before = visibleFraction(floorForTolerance(15), P99); // pre-fix: tol 15 + p99
    const after = visibleFraction(floor, P97); // now: tol 5 + p97
    expect(after).toBeGreaterThan(0.6); // â‰ˆ76% of active cells paint
    expect(before).toBeLessThan(0.35); // â‰ˆ26% before â€” walls only
    expect(after).toBeGreaterThan(before * 2);
  });

  it('keeps the median a dark visible indigo while the bottom quartile stays suppressed', () => {
    const floor = floorForTolerance(DEFAULT_TOLERANCE);
    const gamma = gammaForContrast(DEFAULT_CONTRAST);
    const medianLut = lut(cell(0), P97, floor, gamma);
    const lowLut = lut(cell(-0.6745), P97, floor, gamma); // 25th percentile
    // Campaign 4.1 dark-field default: the median active cell paints in the
    // DARK head of the ramp (â‰ˆLUT 13) â€” visible structure, not confetti. The
    // old lifting curve painted it at â‰ˆLUT 51 (bright indigo => barcode).
    expect(medianLut).toBeGreaterThanOrEqual(8);
    expect(medianLut).toBeLessThanOrEqual(30);
    expect(lowLut).toBeLessThanOrEqual(15); // still â‰ˆbackground
    // Pre-fix regression pin: with floor â‰ˆ0.06 + p99 the median maps to LUT 0.
    expect(lut(cell(0), P99, floorForTolerance(15), gamma)).toBe(0);
  });

  it('keeps the walls saturated at the default white point', () => {
    const floor = floorForTolerance(DEFAULT_TOLERANCE);
    const gamma = gammaForContrast(DEFAULT_CONTRAST);
    expect(lut(P97, P97, floor, gamma)).toBeGreaterThanOrEqual(250); // p97 â†’ white
    expect(lut(P99, P97, floor, gamma)).toBe(255); // p99 clamps to full brightness
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
    const t3 = Math.pow(t2, GAMMA);
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

  it('mode 0 computes the EXACT historical expression (bit-identity contract)', () => {
    // The shader's intensity expression for mode 0 must remain the shipped
    // string â€” the golden pixel parity e2e depends on it verbatim.
    expect(HEATMAP_FRAG).toContain(
      'float intensity = (acc.r + acc.g) * u_decodeScale / float(blk);',
    );
    // And the mirrored chain maps the fixed columns to the same indices the
    // pre-channel math produces ((bid+ask)/norm â†’ floor â†’ gamma â†’ 0..255).
    const toIdx = (t: number): number => Math.trunc(t * 255 + 0.5);
    for (let r = 0; r < 16; r++) {
      const expected = toIdx(
        Math.pow(
          Math.min(1, Math.max(0, ((bid[r] + ask[r]) / NORM - FLOOR) / (1 - FLOOR))),
          GAMMA,
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

describe('sampleMix â€” zoom-aware level-0 sampler mix (campaign 5, contract F4)', () => {
  it('is full blur at/above 1.5 cpp and full crisp at/below 0.5 cpp', () => {
    expect(sampleMix(1.5)).toEqual({ blur: 1, cell: 0 });
    expect(sampleMix(4)).toEqual({ blur: 1, cell: 0 });
    expect(sampleMix(0.5)).toEqual({ blur: 0, cell: 1 });
    expect(sampleMix(0.1)).toEqual({ blur: 0, cell: 1 });
  });

  it('is the smoothstep cross-fade between the two regimes (lane P)', () => {
    const mid = sampleMix(1.0);
    expect(mid.blur).toBeCloseTo(0.5, 12);
    expect(mid.cell).toBeCloseTo(0.5, 12);
    // t is the complementary fraction (1 at 0.5 cpp â†’ crisp, 0 at 1.5 â†’ blur),
    // so smoothstep tÂ²(3âˆ’2t) at cpp 0.75 (t = 0.75) = 0.84375 and at cpp 1.25
    // (t = 0.25) = 0.15625. Zero derivative at both endpoints â€” no pop.
    expect(sampleMix(0.75).cell).toBeCloseTo(0.84375, 12);
    expect(sampleMix(0.75).blur).toBeCloseTo(0.15625, 12);
    expect(sampleMix(1.25).cell).toBeCloseTo(0.15625, 12);
    expect(sampleMix(1.25).blur).toBeCloseTo(0.84375, 12);
  });

  it('keeps the weights summing to 1 and monotone across the band', () => {
    let prevBlur = -1;
    let prevCell = 2;
    for (let cpp = 0.1; cpp <= 4; cpp += 0.1) {
      const m = sampleMix(cpp);
      expect(m.blur + m.cell).toBeCloseTo(1, 12);
      expect(m.blur).toBeGreaterThanOrEqual(prevBlur);
      expect(m.cell).toBeLessThanOrEqual(prevCell);
      prevBlur = m.blur;
      prevCell = m.cell;
    }
  });

  it('falls back to the conservative historical blur on non-finite input', () => {
    expect(sampleMix(Number.NaN)).toEqual({ blur: 1, cell: 0 });
    expect(sampleMix(Number.POSITIVE_INFINITY)).toEqual({ blur: 1, cell: 0 });
    expect(sampleMix(Number.NEGATIVE_INFINITY)).toEqual({ blur: 1, cell: 0 });
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

  it('is exactly 1 at/above 4.5 rows-per-pixel (the post-4.1 row-only regime)', () => {
    expect(rowFadeFor(4.5)).toBe(1);
    expect(rowFadeFor(6)).toBe(1);
    expect(rowFadeFor(8)).toBe(1);
    expect(rowFadeFor(64)).toBe(1);
  });

  it('smoothsteps the middle: 0.5 at 3.25, zero slope at both ends', () => {
    // Widened band [2.0, 4.5] (coordinator): the LOD brightness ramp is spread
    // over ~4x more zoom range so no wheel step lands a concentrated step.
    expect(rowFadeFor(3.25)).toBeCloseTo(0.5, 12);
    // t = (rppâˆ’2.0)/2.5; quarter points of the smoothstep.
    expect(rowFadeFor(2.625)).toBeCloseTo(0.25, 12); // t = 0.25
    expect(rowFadeFor(3.875)).toBeCloseTo(0.75, 12); // t = 0.75
    // The e2e gesture (rpp â‰ˆ 3.05) sits in the band's lower half.
    const atGesture = rowFadeFor(3.05);
    expect(atGesture).toBeGreaterThan(0.3);
    expect(atGesture).toBeLessThan(0.5);
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
    // The raw rowFadeFor knee at 2.5 is ~0.104; the draw starts the blend at
    // weight 0 there so the switch from the level-0 sample to the row mix has
    // no step, then ramps to full row sums at 4.5. Both endpoints are exact.
    const knee = rowFadeFor(2.5);
    expect(knee).toBeGreaterThan(0);
    expect(knee).toBeLessThan(1);
    expect(effectiveRowMode(2.5, true).rowFade).toBe(0);
    expect(effectiveRowMode(4.5, true).rowFade).toBe(1);
    expect(effectiveRowMode(3.2, true).rowFade).toBeCloseTo(
      (rowFadeFor(3.2) - knee) / (1 - knee),
      12,
    );
    expect(effectiveRowMode(3.05, true).rowFade).toBeCloseTo(
      (rowFadeFor(3.05) - knee) / (1 - knee),
      12,
    );
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

describe('the scale-aware sampler in the fragment shader source', () => {
  it('declares the two mix uniforms', () => {
    expect(HEATMAP_FRAG).toContain('uniform float u_colBlur;');
    expect(HEATMAP_FRAG).toContain('uniform float u_colCell;');
  });

  it('scales the sampleField0 side weights by u_colBlur (validity checks kept)', () => {
    // Both side taps must keep their valid-window condition and multiply it by
    // the blur weight; wC closes the sum back to 1.
    expect(HEATMAP_FRAG).toContain('? 0.25 : 0.0) * u_colBlur');
    expect(HEATMAP_FRAG).toContain('1.0 - wL - wR');
  });

  it('cross-fades a crisp nearest-column sampler on the level-0 path only', () => {
    expect(HEATMAP_FRAG).toContain('int cx = int(floor(colf));');
    expect(HEATMAP_FRAG).toContain(
      'acc = mix(sampleField0(colf, rowf), crisp0(colf, rowf), u_colCell);',
    );
    // The SUM path's COARSE sample stays texelFetch-only; crisp0 appears there
    // solely as the FINER (level-0) side of the level cross-fade, so the fade's
    // zero endpoint reproduces the legacy level-0 display output exactly.
    const mipBranch = HEATMAP_FRAG.slice(HEATMAP_FRAG.indexOf('} else {'));
    const coarseLoop = mipBranch.slice(0, mipBranch.indexOf('if (u_levelFade > 0.001)'));
    expect(coarseLoop).not.toContain('crisp0(');
    expect(mipBranch).toContain('if (u_colCell >= 0.999) accF = crisp0(colf, rowf);');
  });

  it('L1: full-crisp short-circuits the blur fetches (no lazy mix in GLSL)', () => {
    expect(HEATMAP_FRAG).toContain('if (u_colCell >= 0.999) acc = crisp0(colf, rowf);');
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
});

