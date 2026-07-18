import { describe, expect, it } from 'vitest';

import {
  buildLUTAtlas,
  buildSynthLUT,
  buildThermalLUT,
  LUT_SIZE,
  rampForMode,
  RAMP_SYNTH,
  RAMP_THERMAL,
} from './lut';
import { MODE_L1_BAND, MODE_L2, MODE_SYNTH_PROFILE } from '../proto/types';

// Rec.601 luma — a stand-in for perceived brightness. Both ramps are designed
// to brighten monotonically with density, which is what makes "hotter = higher
// density" read correctly on screen.
function luma(rgba: Uint8Array, i: number): number {
  return 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
}

describe('thermal LUT', () => {
  const lut = buildThermalLUT();

  it('is a 256×1 RGBA8 buffer with opaque alpha', () => {
    expect(lut.length).toBe(LUT_SIZE * 4);
    for (let i = 0; i < LUT_SIZE; i++) {
      expect(lut[i * 4 + 3]).toBe(255);
    }
  });

  it('starts near-black and ends bright white', () => {
    expect(luma(lut, 0)).toBeLessThan(10);
    expect(luma(lut, LUT_SIZE - 1)).toBeGreaterThan(245);
    // White endpoint: all channels maxed.
    expect(lut[(LUT_SIZE - 1) * 4 + 0]).toBe(255);
    expect(lut[(LUT_SIZE - 1) * 4 + 1]).toBe(255);
    expect(lut[(LUT_SIZE - 1) * 4 + 2]).toBe(255);
  });

  it('is cold (blue-dominant) at the low end', () => {
    // A quarter of the way up should still be a cool blue: B > R.
    const i = 48;
    expect(lut[i * 4 + 2]).toBeGreaterThan(lut[i * 4 + 0]);
  });

  it('brightens monotonically', () => {
    // Coarse strictly-increasing trend (immune to per-sample rounding).
    const marks = [0, 16, 32, 48, 64, 96, 128, 160, 192, 224, 240, 255];
    for (let k = 0; k < marks.length - 1; k++) {
      expect(luma(lut, marks[k + 1])).toBeGreaterThan(luma(lut, marks[k]));
    }
    // No meaningful sample-to-sample reversal (allow ±1 rounding wobble).
    for (let i = 0; i < LUT_SIZE - 1; i++) {
      expect(luma(lut, i + 1)).toBeGreaterThanOrEqual(luma(lut, i) - 1.0);
    }
  });
});

describe('synth (amber) LUT', () => {
  const lut = buildSynthLUT();

  it('is a 256×1 RGBA8 buffer', () => {
    expect(lut.length).toBe(LUT_SIZE * 4);
  });

  it('starts near-black and ends bright', () => {
    expect(luma(lut, 0)).toBeLessThan(10);
    expect(luma(lut, LUT_SIZE - 1)).toBeGreaterThan(230);
  });

  it('is a warm single hue (R ≥ G ≥ B) through the mid-range', () => {
    const i = 128;
    expect(lut[i * 4 + 0]).toBeGreaterThanOrEqual(lut[i * 4 + 1]);
    expect(lut[i * 4 + 1]).toBeGreaterThanOrEqual(lut[i * 4 + 2]);
  });

  it('brightens monotonically (coarse)', () => {
    const marks = [0, 32, 64, 96, 128, 160, 192, 224, 255];
    for (let k = 0; k < marks.length - 1; k++) {
      expect(luma(lut, marks[k + 1])).toBeGreaterThan(luma(lut, marks[k]));
    }
  });
});

describe('rampForMode (§7 mode → colormap)', () => {
  it('maps SYNTH_PROFILE density to the amber ramp', () => {
    expect(rampForMode(MODE_SYNTH_PROFILE)).toBe(RAMP_SYNTH);
  });

  it('maps real L2 / L1 depth to the thermal ramp', () => {
    expect(rampForMode(MODE_L2)).toBe(RAMP_THERMAL);
    expect(rampForMode(MODE_L1_BAND)).toBe(RAMP_THERMAL);
  });

  it('defaults an unknown mode to thermal (never fabricates the synth look)', () => {
    expect(rampForMode(99)).toBe(RAMP_THERMAL);
  });
});

describe('LUT atlas', () => {
  it('stacks thermal (row 0) over synth (row 1) as 256×2 RGBA8', () => {
    const atlas = buildLUTAtlas();
    expect(atlas.length).toBe(LUT_SIZE * 2 * 4);
    const thermal = buildThermalLUT();
    const synth = buildSynthLUT();
    // Row 0 == thermal.
    expect(atlas.slice(0, LUT_SIZE * 4)).toEqual(thermal);
    // Row 1 == synth.
    expect(atlas.slice(LUT_SIZE * 4)).toEqual(synth);
  });
});
