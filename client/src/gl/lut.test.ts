import { describe, expect, it } from 'vitest';

import {
  buildClassicLUT,
  buildFlowLUT,
  buildImbalanceLUT,
  buildInfernoLUT,
  buildLUTAtlas,
  buildSynthLUT,
  clearColorForRamp,
  DEFAULT_COLORMAP,
  LUT_ROWS,
  LUT_SIZE,
  rampCssGradient,
  rampForColormap,
  rampForMode,
  RAMP_CLASSIC,
  SYNTH_HUE_SAFE_MAX,
  RAMP_FLOW,
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

  it('starts near-black and ends in saturated gold (never white)', () => {
    expect(luma(lut, 0)).toBeLessThan(10);
    expect(luma(lut, LUT_SIZE - 1)).toBeGreaterThan(200);
    // Gold endpoint: red-dominant, blue-starved — a max-density wall must not
    // merge into the white price line overlay.
    const [r, g, b] = rgb(lut, LUT_SIZE - 1);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(150);
    expect(b).toBeLessThan(100);
    expect(b).toBeLessThan(g);
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

describe('flow LUT (the default ramp)', () => {
  const lut = buildFlowLUT();

  it('is a 256×1 RGBA8 buffer with opaque alpha', () => {
    expect(lut.length).toBe(LUT_SIZE * 4);
    for (let i = 0; i < LUT_SIZE; i++) {
      expect(lut[i * 4 + 3]).toBe(255);
    }
  });

  it('starts near-black and ends in bright gold (never white)', () => {
    expect(luma(lut, 0)).toBeLessThan(10);
    expect(luma(lut, LUT_SIZE - 1)).toBeGreaterThan(200);
    // Gold endpoint: red-dominant, blue-starved — a max-density wall must not
    // merge into the white price line overlay (same contract as inferno's, and
    // the same numbers the e2e wall-pixel probe asserts).
    const [r, g, b] = rgb(lut, LUT_SIZE - 1);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(150);
    expect(b).toBeLessThan(150);
    expect(b).toBeLessThan(g);
  });

  it('brightens monotonically', () => {
    expectMonotone(lut);
  });

  it('keeps the field DARK and quiet through the lower half — the anti-soup contract', () => {
    // The median active cell (a few % of the p97 white point, gamma-lifted)
    // lands around the lower third of the ramp. That zone must stay dim and
    // desaturated: the baseline field may not shout.
    expect(luma(lut, 96)).toBeLessThan(58);
    // Still cool (B over G) there — no magenta/violet heat.
    expect(lut[96 * 4 + 2]).toBeGreaterThan(lut[96 * 4 + 1]);
  });

  it('earns its warmth: hue turns warm only in the top of the ramp', () => {
    // Just below the crossover the pixel is still green-dominant-over-red.
    expect(lut[178 * 4 + 1]).toBeGreaterThan(lut[178 * 4]);
    // At the sand stop it is unmistakably warm: red over green over blue.
    const [r, g, b] = rgb(lut, 224);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(170);
    expect(b).toBeLessThan(100);
  });

  it('stays cool (blue-dominant) at the low end', () => {
    const i = 48;
    expect(lut[i * 4 + 2]).toBeGreaterThan(lut[i * 4 + 0]);
  });

  it('keeps a cool probe band for the §7 synthetic-depth pixel check', () => {
    // Same soundness requirement as inferno's SYNTH_HUE_SAFE_MAX band: where
    // most of the screen lives, flow is COOL (B ≥ G), while the synth ramp is
    // WARM everywhere — so a cool pixel discriminates real depth from synthetic.
    for (let i = 0; i <= 146; i++) {
      expect(lut[i * 4 + 2], `flow[${i}] must stay cool (B ≥ G)`).toBeGreaterThanOrEqual(
        lut[i * 4 + 1],
      );
    }
    const [, g, b] = rgb(lut, 152);
    expect(g).toBeGreaterThan(b);
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

  it('starts near-black and ends in saturated yellow (never white)', () => {
    expect(luma(lut, 0)).toBeLessThan(10);
    expect(luma(lut, LUT_SIZE - 1)).toBeGreaterThan(200);
    // Saturated yellow endpoint: red-dominant, blue-starved — never white, so
    // the classic ramp top stays distinct from the white price line too.
    const [r, g, b] = rgb(lut, LUT_SIZE - 1);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(150);
    expect(b).toBeLessThan(100);
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
  it('maps the three families to their atlas rows', () => {
    expect(rampForColormap('flow')).toBe(RAMP_FLOW);
    expect(rampForColormap('inferno')).toBe(RAMP_INFERNO);
    expect(rampForColormap('classic')).toBe(RAMP_CLASSIC);
  });

  it('defaults to flow', () => {
    expect(rampForColormap(DEFAULT_COLORMAP)).toBe(RAMP_FLOW);
    expect(DEFAULT_COLORMAP).toBe('flow');
  });
});

describe('rampForMode (§7 mode → colormap)', () => {
  it('maps SYNTH_PROFILE density to the amber ramp', () => {
    expect(rampForMode(MODE_SYNTH_PROFILE)).toBe(RAMP_SYNTH);
  });

  it('maps real L2 / L1 depth to the default (flow) ramp', () => {
    expect(rampForMode(MODE_L2)).toBe(RAMP_FLOW);
    expect(rampForMode(MODE_L1_BAND)).toBe(RAMP_FLOW);
  });

  it('honours the user colormap for REAL depth', () => {
    expect(rampForMode(MODE_L2, 'L2', 'classic')).toBe(RAMP_CLASSIC);
    expect(rampForMode(MODE_L2, 'L2', 'inferno')).toBe(RAMP_INFERNO);
    expect(rampForMode(MODE_L2, 'L2', 'flow')).toBe(RAMP_FLOW);
  });

  it('colours SYNTHETIC depth amber by its capability tier, not the render mode', () => {
    // Two-sided synthetic equity depth ships as MODE_L1_BAND (so it renders
    // bid+ask) but is still fabricated volume-at-price — it must NOT wear a
    // real-order-flow ramp. The honesty signal is capability.depth.
    expect(rampForMode(MODE_L1_BAND, 'SYNTH')).toBe(RAMP_SYNTH);
    expect(rampForMode(MODE_L1_BAND, 'SYNTH_PROFILE')).toBe(RAMP_SYNTH);
    // Real depth keeps a real-depth ramp.
    expect(rampForMode(MODE_L1_BAND, 'L1')).toBe(RAMP_FLOW);
    expect(rampForMode(MODE_L2, 'L2')).toBe(RAMP_FLOW);
  });

  it('NO colormap choice can dress synthetic depth as real depth', () => {
    for (const cm of ['flow', 'inferno', 'classic'] as const) {
      expect(rampForMode(MODE_L1_BAND, 'SYNTH', cm)).toBe(RAMP_SYNTH);
      expect(rampForMode(MODE_SYNTH_PROFILE, undefined, cm)).toBe(RAMP_SYNTH);
    }
  });

  it('defaults an unknown mode to a real-depth ramp (never fabricates synth)', () => {
    expect(rampForMode(99)).toBe(RAMP_FLOW);
    expect(rampForMode(99, 'L2')).toBe(RAMP_FLOW);
  });
});

describe('LUT atlas', () => {
  it('stacks inferno/synth/classic/flow as 256×4 RGBA8', () => {
    const atlas = buildLUTAtlas();
    expect(atlas.length).toBe(LUT_SIZE * LUT_ROWS * 4);
    expect(atlas.slice(0, LUT_SIZE * 4)).toEqual(buildInfernoLUT());
    expect(atlas.slice(LUT_SIZE * 4, LUT_SIZE * 8)).toEqual(buildSynthLUT());
    expect(atlas.slice(LUT_SIZE * 8, LUT_SIZE * 12)).toEqual(buildClassicLUT());
    expect(atlas.slice(LUT_SIZE * 12, LUT_SIZE * 16)).toEqual(buildFlowLUT());
  });

  it('pins the row indices the e2e parity matrix asserts numerically', () => {
    expect(RAMP_INFERNO).toBe(0); // "whatever real depth renders as" (legacy)
    expect(RAMP_SYNTH).toBe(1); // the §7 honesty row
    expect(RAMP_FLOW).toBe(3); // the default real-depth row
  });
});

describe('rampCssGradient (the legend must not drift from the texture)', () => {
  it('emits ordered sRGB stops spanning 0→100%', () => {
    const g = rampCssGradient(RAMP_INFERNO);
    expect(g.startsWith('rgb(2, 2, 8) 0.0%')).toBe(true);
    expect(g.endsWith('rgb(255, 216, 40) 100.0%')).toBe(true);
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

describe('clearColorForRamp — the clear color IS LUT entry 0 (B-6, no reset flash)', () => {
  it('matches the ramp texture background byte-for-byte, for every ramp', () => {
    const luts: Record<number, Uint8Array> = {
      [RAMP_INFERNO]: buildInfernoLUT(),
      [RAMP_SYNTH]: buildSynthLUT(),
      [RAMP_CLASSIC]: buildClassicLUT(),
      [RAMP_FLOW]: buildFlowLUT(),
    };
    for (const [row, lut] of Object.entries(luts)) {
      const clear = clearColorForRamp(Number(row));
      expect(clear[0]).toBe(lut[0] / 255);
      expect(clear[1]).toBe(lut[1] / 255);
      expect(clear[2]).toBe(lut[2] / 255);
      expect(clear[3]).toBe(1);
    }
  });

  it('the DEFAULT (flow) background is the ramp rgb(5,8,14), not the old rgb(2,4,7)', () => {
    const bg = clearColorForRamp();
    expect(bg[0]).toBe(5 / 255);
    expect(bg[1]).toBe(8 / 255);
    expect(bg[2]).toBe(14 / 255);
  });

  it('falls back to inferno for an unknown row (never NaN into clearColor)', () => {
    expect(clearColorForRamp(999)).toEqual(clearColorForRamp(RAMP_INFERNO));
  });
});

describe('atlas golden bytes — rows 0..3 are BIT-IDENTICAL to pre-channel releases', () => {
  // Captured from buildLUTAtlas() before the divergent imbalance row (row 4)
  // was appended. Rows 0 (real depth) and 1 (synth amber) are pinned by the
  // e2e parity matrix; 2 and 3 by user-facing continuity. If one of these
  // bytes moves, a density ramp changed — that must NEVER ride along with an
  // unrelated feature.
  const GOLDEN: Record<string, string[]> = {
    row0: [
      '2,2,8,255', '3,2,10,255', '15,7,37,255', '28,12,65,255', '69,17,90,255',
      '115,23,89,255', '165,34,68,255', '195,44,49,255', '198,47,46,255',
      '209,62,39,255', '238,115,26,255', '251,181,43,255', '253,199,42,255',
      '255,215,40,255', '255,216,40,255',
    ],
    row1: [
      '6,3,0,255', '7,3,0,255', '25,10,0,255', '43,17,0,255', '80,30,0,255',
      '122,55,0,255', '164,80,0,255', '186,98,3,255', '189,102,5,255',
      '199,115,9,255', '229,155,24,255', '246,197,97,255', '251,219,150,255',
      '255,239,197,255', '255,240,200,255',
    ],
    row2: [
      '2,4,12,255', '2,4,14,255', '5,12,45,255', '9,19,79,255', '6,66,136,255',
      '1,120,190,255', '11,166,211,255', '19,193,219,255', '21,197,221,255',
      '33,209,217,255', '178,226,91,255', '241,230,39,255', '248,229,36,255',
      '255,228,32,255', '255,228,32,255',
    ],
    row3: [
      '5,8,14,255', '5,9,15,255', '10,17,27,255', '16,25,40,255', '23,42,60,255',
      '25,60,78,255', '31,83,92,255', '40,99,99,255', '42,101,100,255',
      '59,112,102,255', '137,147,98,255', '219,180,86,255', '237,199,95,255',
      '254,215,103,255', '255,216,104,255',
    ],
  };
  const SAMPLES = [0, 1, 16, 32, 64, 96, 128, 147, 150, 160, 192, 224, 240, 254, 255];

  it('the appended imbalance row did not renumber or rebyte rows 0..3', () => {
    const atlas = buildLUTAtlas();
    expect(LUT_ROWS).toBe(5); // appended, never renumbered
    for (let row = 0; row < 4; row++) {
      const golden = GOLDEN[`row${row}`];
      for (let k = 0; k < SAMPLES.length; k++) {
        const o = (row * LUT_SIZE + SAMPLES[k]) * 4;
        const got = `${atlas[o]},${atlas[o + 1]},${atlas[o + 2]},${atlas[o + 3]}`;
        expect(got, `row ${row} @ ${SAMPLES[k]}`).toBe(golden[k]);
      }
    }
  });
});

describe('imbalance LUT (row 4) — the DIVERGENT channel ramp', () => {
  const lut = buildImbalanceLUT();
  const luma = (i: number): number =>
    0.299 * lut[i * 4] + 0.587 * lut[i * 4 + 1] + 0.114 * lut[i * 4 + 2];

  it('is a 256x1 RGBA8 buffer with opaque alpha', () => {
    expect(lut.length).toBe(LUT_SIZE * 4);
    for (let i = 0; i < LUT_SIZE; i++) expect(lut[i * 4 + 3]).toBe(255);
  });

  it('is DIVERGENT: quiet dark neutral midpoint, bright blue and orange extremes', () => {
    expect(luma(128)).toBeLessThan(30); // balanced book stays near-background
    expect(luma(0)).toBeGreaterThan(120); // max ask dominance — bright
    expect(luma(255)).toBeGreaterThan(120); // max bid dominance — bright
    // NOT monotone overall (that would make it a density ramp).
    expect(luma(255)).toBeGreaterThan(luma(128));
    expect(luma(0)).toBeGreaterThan(luma(128));
  });

  it('is CVD-safe blue<->orange: ask side B-dominant, bid side R-dominant', () => {
    // Hue reads clearly everywhere except the few indices adjacent to the
    // neutral midpoint (smooth sRGB interpolation needs ~10 indices to swing
    // from the blue-tinted slate neutral to R-dominant amber) — the transition
    // band is pinned quiet by the luma assertion below.
    for (let i = 0; i <= 120; i++) {
      expect(lut[i * 4 + 2], `blue side @${i}`).toBeGreaterThan(lut[i * 4]);
    }
    for (let i = 140; i < LUT_SIZE; i++) {
      expect(lut[i * 4], `orange side @${i}`).toBeGreaterThan(lut[i * 4 + 2]);
    }
    for (let i = 120; i <= 140; i++) {
      expect(luma(i)).toBeLessThan(45); // transition band stays quiet
    }
  });

  it('is monotone in brightness AWAY from the midpoint on each side', () => {
    for (let i = 128; i < LUT_SIZE - 1; i++) {
      expect(luma(i + 1)).toBeGreaterThanOrEqual(luma(i) - 1.0);
    }
    for (let i = 1; i <= 128; i++) {
      expect(luma(i - 1)).toBeGreaterThanOrEqual(luma(i) - 1.0);
    }
  });
});
