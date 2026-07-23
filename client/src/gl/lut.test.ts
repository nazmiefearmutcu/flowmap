import { describe, expect, it } from 'vitest';

import {
  buildClassicLUT,
  buildInfernoLUT,
  buildLUTAtlas,
  buildSynthLUT,
  DEFAULT_COLORMAP,
  LUT_ROWS,
  LUT_SIZE,
  rampCssGradient,
  rampForColormap,
  rampForMode,
  RAMP_CLASSIC,
  SYNTH_HUE_SAFE_MAX,
  RAMP_INFERNO,
  RAMP_SYNTH,
} from './lut';
import { MODE_L1_BAND, MODE_L2, MODE_SYNTH_PROFILE } from '../proto/types';

// Rec.601 luma — a stand-in for perceived brightness. Every ramp is designed to
// brighten monotonically with density, which is what makes "hotter = higher
// density" read correctly on screen.
function luma(rgba: Uint8Array, i: number): number {
  return 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
}

function rgb(lut: Uint8Array, i: number): [number, number, number] {
  return [lut[i * 4], lut[i * 4 + 1], lut[i * 4 + 2]];
}

/** The coarse + per-sample monotonicity contract every ramp must satisfy. */
function expectMonotone(lut: Uint8Array): void {
  const marks = [0, 16, 32, 48, 64, 96, 128, 160, 192, 224, 240, 255];
  for (let k = 0; k < marks.length - 1; k++) {
    expect(luma(lut, marks[k + 1])).toBeGreaterThan(luma(lut, marks[k]));
  }
  // No meaningful sample-to-sample reversal (allow ±1 rounding wobble).
  for (let i = 0; i < LUT_SIZE - 1; i++) {
    expect(luma(lut, i + 1)).toBeGreaterThanOrEqual(luma(lut, i) - 1.0);
  }
}

describe('inferno LUT (the default ramp)', () => {
  const lut = buildInfernoLUT();

  it('is a 256×1 RGBA8 buffer with opaque alpha', () => {
    expect(lut.length).toBe(LUT_SIZE * 4);
    for (let i = 0; i < LUT_SIZE; i++) {
      expect(lut[i * 4 + 3]).toBe(255);
    }
  });

  it('starts near-black and ends near-white', () => {
    expect(luma(lut, 0)).toBeLessThan(10);
    expect(luma(lut, LUT_SIZE - 1)).toBeGreaterThan(245);
  });

  it('brightens monotonically', () => {
    expectMonotone(lut);
  });

  it('has a genuine RED band in the upper-middle — the point of the ramp', () => {
    // ~index 148 is the t≈0.58 stop: red-dominant, and unmistakably red rather
    // than orange or magenta (G and B both far below R, and close to each other).
    const [r, g, b] = rgb(lut, 148);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(90);
    expect(b).toBeLessThan(90);
    expect(Math.abs(g - b)).toBeLessThan(40);
  });

  it('separates the top of the range across FOUR hue families', () => {
    // This is exactly what the classic ramp fails to do: from index 96 up it is
    // all high-luminance cyan/yellow/white, so big vs. medium is hard to read.
    const violet = rgb(lut, 80); // B > G — cool
    const red = rgb(lut, 148); // R >> G,B
    const orange = rgb(lut, 190); // R > G > B, G climbing
    const gold = rgb(lut, 228); // R,G high, B low
    expect(violet[2]).toBeGreaterThan(violet[1]);
    expect(red[0]).toBeGreaterThan(red[1] + 100);
    expect(orange[1]).toBeGreaterThan(red[1]);
    expect(gold[1]).toBeGreaterThan(orange[1]);
    expect(gold[2]).toBeLessThan(gold[1]);
  });

  it('is cool (blue-dominant) at the low end', () => {
    const i = 48;
    expect(lut[i * 4 + 2]).toBeGreaterThan(lut[i * 4 + 0]);
  });

  it('is hue-disjoint from the synth ramp through the mid-field', () => {
    // The §7 honesty signal only works if the two ramps cannot be confused where
    // most of the screen lives. Synth is warm single-hue (G ≥ B); inferno's
    // mid-field is violet/magenta (B > G).
    const inf = rgb(buildInfernoLUT(), 128);
    const syn = rgb(buildSynthLUT(), 128);
    expect(inf[2]).toBeGreaterThan(inf[1]);
    expect(syn[1]).toBeGreaterThanOrEqual(syn[2]);
  });

  it('pins SYNTH_HUE_SAFE_MAX — the range where a pixel probe can prove §7', () => {
    // The §7 honesty proof is a pixel probe: "does synthetic depth render in a
    // visibly different ramp?". That probe is only sound where the two ramps are
    // hue-DISJOINT, and the honest answer is that they are not disjoint
    // everywhere: inferno legitimately passes through orange in its top third,
    // and so does the amber synth ramp. Faking a predicate that "proves"
    // otherwise would be a fake guarantee.
    //
    // The real, verified boundary: the synth ramp is WARM (G ≥ B) at every
    // index, while inferno is COOL (B ≥ G) for indices 0..149. So a probe on a
    // cell below that index discriminates, and one above it does not. e2e specs
    // asserting the §7 signal by pixel MUST keep their probe in that band; above
    // it they must fall back to `renderer.currentRamp === RAMP_SYNTH`.
    const inf = buildInfernoLUT();
    const syn = buildSynthLUT();

    for (let i = 0; i < SYNTH_HUE_SAFE_MAX; i++) {
      const [, g, b] = rgb(inf, i);
      expect(b, `inferno[${i}] must stay cool (B ≥ G) for the probe to be sound`)
        .toBeGreaterThanOrEqual(g);
    }
    // The first index where inferno turns warm — the exact edge of the band.
    const [, gEdge, bEdge] = rgb(inf, SYNTH_HUE_SAFE_MAX);
    expect(gEdge).toBeGreaterThan(bEdge);

    for (let i = 0; i < LUT_SIZE; i++) {
      const [r, g, b] = rgb(syn, i);
      expect(g, `synth[${i}] must be warm (G ≥ B) everywhere`).toBeGreaterThanOrEqual(b);
      expect(r, `synth[${i}] must stay red-dominant`).toBeGreaterThanOrEqual(g);
    }
  });
});

describe('classic LUT (the legacy thermal ramp)', () => {
  const lut = buildClassicLUT();

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
    const i = 48;
    expect(lut[i * 4 + 2]).toBeGreaterThan(lut[i * 4 + 0]);
  });

  it('brightens monotonically', () => {
    expectMonotone(lut);
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

  it('is unchanged by the ramp overhaul (the §7 signal must not drift)', () => {
    expect(rgb(lut, 0)).toEqual([6, 3, 0]);
    expect(rgb(lut, LUT_SIZE - 1)).toEqual([255, 240, 200]);
  });
});

describe('rampForColormap (§9 user choice)', () => {
  it('maps the two families to their atlas rows', () => {
    expect(rampForColormap('inferno')).toBe(RAMP_INFERNO);
    expect(rampForColormap('classic')).toBe(RAMP_CLASSIC);
  });

  it('defaults to inferno', () => {
    expect(rampForColormap(DEFAULT_COLORMAP)).toBe(RAMP_INFERNO);
  });
});

describe('rampForMode (§7 mode → colormap)', () => {
  it('maps SYNTH_PROFILE density to the amber ramp', () => {
    expect(rampForMode(MODE_SYNTH_PROFILE)).toBe(RAMP_SYNTH);
  });

  it('maps real L2 / L1 depth to the default (inferno) ramp', () => {
    expect(rampForMode(MODE_L2)).toBe(RAMP_INFERNO);
    expect(rampForMode(MODE_L1_BAND)).toBe(RAMP_INFERNO);
  });

  it('honours the user colormap for REAL depth', () => {
    expect(rampForMode(MODE_L2, 'L2', 'classic')).toBe(RAMP_CLASSIC);
    expect(rampForMode(MODE_L2, 'L2', 'inferno')).toBe(RAMP_INFERNO);
  });

  it('colours SYNTHETIC depth amber by its capability tier, not the render mode', () => {
    // Two-sided synthetic equity depth ships as MODE_L1_BAND (so it renders
    // bid+ask) but is still fabricated volume-at-price — it must NOT wear a
    // real-order-flow ramp. The honesty signal is capability.depth.
    expect(rampForMode(MODE_L1_BAND, 'SYNTH')).toBe(RAMP_SYNTH);
    expect(rampForMode(MODE_L1_BAND, 'SYNTH_PROFILE')).toBe(RAMP_SYNTH);
    // Real depth keeps a real-depth ramp.
    expect(rampForMode(MODE_L1_BAND, 'L1')).toBe(RAMP_INFERNO);
    expect(rampForMode(MODE_L2, 'L2')).toBe(RAMP_INFERNO);
  });

  it('NO colormap choice can dress synthetic depth as real depth', () => {
    for (const cm of ['inferno', 'classic'] as const) {
      expect(rampForMode(MODE_L1_BAND, 'SYNTH', cm)).toBe(RAMP_SYNTH);
      expect(rampForMode(MODE_SYNTH_PROFILE, undefined, cm)).toBe(RAMP_SYNTH);
    }
  });

  it('defaults an unknown mode to a real-depth ramp (never fabricates synth)', () => {
    expect(rampForMode(99)).toBe(RAMP_INFERNO);
    expect(rampForMode(99, 'L2')).toBe(RAMP_INFERNO);
  });
});

describe('LUT atlas', () => {
  it('stacks inferno (row 0), synth (row 1), classic (row 2) as 256×3 RGBA8', () => {
    const atlas = buildLUTAtlas();
    expect(atlas.length).toBe(LUT_SIZE * LUT_ROWS * 4);
    expect(atlas.slice(0, LUT_SIZE * 4)).toEqual(buildInfernoLUT());
    expect(atlas.slice(LUT_SIZE * 4, LUT_SIZE * 8)).toEqual(buildSynthLUT());
    expect(atlas.slice(LUT_SIZE * 8, LUT_SIZE * 12)).toEqual(buildClassicLUT());
  });

  it('pins the row indices the e2e parity matrix asserts numerically', () => {
    expect(RAMP_INFERNO).toBe(0); // "whatever real depth renders as"
    expect(RAMP_SYNTH).toBe(1); // the §7 honesty row
  });
});

describe('rampCssGradient (the legend must not drift from the texture)', () => {
  it('emits ordered sRGB stops spanning 0→100%', () => {
    const g = rampCssGradient(RAMP_INFERNO);
    expect(g.startsWith('rgb(2, 2, 8) 0.0%')).toBe(true);
    expect(g.endsWith('rgb(255, 248, 232) 100.0%')).toBe(true);
  });

  it('gives each row its own gradient', () => {
    expect(rampCssGradient(RAMP_SYNTH)).not.toBe(rampCssGradient(RAMP_INFERNO));
    expect(rampCssGradient(RAMP_CLASSIC)).not.toBe(rampCssGradient(RAMP_INFERNO));
  });

  it('falls back to the default ramp for an unknown row', () => {
    expect(rampCssGradient(99)).toBe(rampCssGradient(RAMP_INFERNO));
  });

  it('agrees with the rasterized texture at every stop', () => {
    // CSS interpolates sRGB linearly, exactly as buildRamp does — so this is an
    // identity, not an approximation.
    const lut = buildInfernoLUT();
    const re = /rgb\((\d+), (\d+), (\d+)\) ([\d.]+)%/g;
    const src = rampCssGradient(RAMP_INFERNO);
    let m: RegExpExecArray | null;
    let seen = 0;
    while ((m = re.exec(src)) !== null) {
      seen++;
      const i = Math.round((Number(m[4]) / 100) * (LUT_SIZE - 1));
      const [r, g, b] = rgb(lut, i);
      expect(Math.abs(r - Number(m[1]))).toBeLessThanOrEqual(1);
      expect(Math.abs(g - Number(m[2]))).toBeLessThanOrEqual(1);
      expect(Math.abs(b - Number(m[3]))).toBeLessThanOrEqual(1);
    }
    expect(seen).toBe(8); // every INFERNO_STOPS entry
  });
});
