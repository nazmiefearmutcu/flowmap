/**
 * Heatmap colormaps (§8.3 / §9).
 *
 * Three ramps live side by side in one 256×3 RGBA8 atlas texture so the fragment
 * shader can select a ramp with a single uniform and a single texture bind:
 *   - row 0 (RAMP_INFERNO): the DEFAULT density ramp — near-black → indigo →
 *     violet → magenta → RED → orange → gold → white as density rises.
 *   - row 1 (RAMP_SYNTH): a distinct single-hue amber ramp for SYNTHETIC equity
 *     depth, so fabricated density reads as visually different from real L2.
 *   - row 2 (RAMP_CLASSIC): the legacy thermal ramp (blue → cyan → yellow →
 *     white), kept as a user-selectable option.
 *
 * **Why the default changed.** The classic thermal ramp crosses half its
 * luminance range by LUT index 96 and is near-white from ~160 up, so its top two
 * thirds are all bright cyan/yellow/white: a wall and a mid-sized resting order
 * land in visually adjacent colours and the field reads as "blue with bright
 * stripes". The inferno family spreads the same range across FOUR distinct hue
 * families (indigo / magenta / red / orange-gold) before saturating to white, so
 * relative density is legible by hue, not just by brightness.
 *
 * **Why not yellow → red → white.** Every ramp here must be monotone in
 * luminance — the whole point is that hotter reads as brighter, and lut.test.ts
 * locks it. Pure red has a LOWER luma than yellow, so putting red above yellow
 * would make the ramp dip and a big order would read *darker* than a medium one.
 * Inferno reaches a strong red at ~70% of full luminance, on the way up, which
 * satisfies both constraints at once.
 *
 * **Honesty (§7) outranks the user's colormap choice.** {@link rampForMode}
 * evaluates the synthetic-depth tier FIRST and unconditionally, so no setting
 * can dress fabricated equity depth in a real-depth ramp.
 *
 * `buildRamp` / `buildLUTAtlas` are pure (return Uint8Array) so ramp shape,
 * monotonicity and selection are all unit-testable without a GL context.
 */

import { MODE_SYNTH_PROFILE } from '../proto/types';

export const LUT_SIZE = 256;

/** Atlas rows — the `u_ramp` uniform in the fragment shader indexes these. */
export const RAMP_INFERNO = 0;
export const RAMP_SYNTH = 1;
export const RAMP_CLASSIC = 2;

/**
 * Row 0 is "whatever REAL depth renders as" — a contract the e2e parity matrix
 * asserts numerically. RAMP_SYNTH is pinned at row 1 for the same reason. New
 * ramps therefore append at row 2 and above; they never renumber these two.
 */
export const LUT_ROWS = 3;

/** The colormap families a user can choose between (the §9 Settings knob). */
export type Colormap = 'inferno' | 'classic';

export const DEFAULT_COLORMAP: Colormap = 'inferno';

/**
 * Highest LUT index at which a PIXEL probe can still prove the §7 synthetic-
 * depth signal.
 *
 * The signal is "synthetic depth wears a visibly different ramp". That is only
 * checkable by colour where the two ramps are hue-disjoint — and honestly, they
 * are not disjoint everywhere: inferno passes through orange in its top third,
 * and so does the amber synth ramp. Below this index inferno is COOL (B ≥ G)
 * while the synth ramp is WARM (G ≥ B) at every index, so a probe there
 * discriminates cleanly. Above it, a spec must assert
 * `renderer.currentRamp === RAMP_SYNTH` instead of sampling a pixel.
 * lut.test.ts pins both halves of that claim.
 */
export const SYNTH_HUE_SAFE_MAX = 150;

interface Stop {
  /** Normalized position along the ramp, 0..1. */
  t: number;
  /** sRGB bytes, 0..255. */
  rgb: [number, number, number];
}

// Inferno: near-black → indigo → violet → magenta → RED → orange → gold →
// white. Rec.601 luma at the stops runs 2.7 → 22.1 → 44.8 → 66.7 → 89.9 →
// 128.6 → 183.1 → 248.3: strictly increasing, so the rasterized ramp is
// luminance-monotone (luma is linear in RGB, and linear interpolation between
// monotone endpoints stays monotone). The red band lands at t ≈ 0.58.
const INFERNO_STOPS: Stop[] = [
  { t: 0.0, rgb: [2, 2, 8] },
  { t: 0.12, rgb: [26, 12, 64] },
  { t: 0.28, rgb: [78, 18, 96] },
  { t: 0.44, rgb: [140, 26, 84] },
  { t: 0.58, rgb: [196, 44, 48] },
  { t: 0.72, rgb: [234, 96, 20] },
  { t: 0.86, rgb: [250, 176, 44] },
  { t: 1.0, rgb: [255, 248, 232] },
];

// Classic (the legacy thermal ramp): near-black → deep blue → cyan → yellow →
// white. Control-point luminance is monotonically increasing.
const CLASSIC_STOPS: Stop[] = [
  { t: 0.0, rgb: [2, 4, 12] },
  { t: 0.15, rgb: [10, 22, 92] },
  { t: 0.4, rgb: [0, 130, 200] },
  { t: 0.62, rgb: [24, 208, 224] },
  { t: 0.8, rgb: [232, 232, 44] },
  { t: 1.0, rgb: [255, 255, 255] },
];

// Synth: single-hue amber, near-black → deep amber → bright gold. Also
// monotone in luminance. Deliberately warm-single-hue (R ≥ G ≥ B through the
// mid-range) so it stays hue-disjoint from every real-depth ramp.
const SYNTH_STOPS: Stop[] = [
  { t: 0.0, rgb: [6, 3, 0] },
  { t: 0.25, rgb: [80, 30, 0] },
  { t: 0.55, rgb: [180, 90, 0] },
  { t: 0.8, rgb: [240, 170, 30] },
  { t: 1.0, rgb: [255, 240, 200] },
];

/** Atlas row → stop list. The single source of truth for both the GPU texture
 *  and the HTML legend gradient, so they can never drift apart. */
const RAMP_STOPS: Record<number, Stop[]> = {
  [RAMP_INFERNO]: INFERNO_STOPS,
  [RAMP_SYNTH]: SYNTH_STOPS,
  [RAMP_CLASSIC]: CLASSIC_STOPS,
};

/** Atlas row for a user colormap choice (real depth only — see rampForMode). */
export function rampForColormap(colormap: Colormap): number {
  return colormap === 'classic' ? RAMP_CLASSIC : RAMP_INFERNO;
}

/**
 * Colormap row for a density column (§7 / §8.3). SYNTHETIC equity depth renders
 * in the single-hue amber ramp so it reads as visually distinct from real L2/L1
 * depth; everything else uses the user's chosen ramp. The honesty signal is the
 * capability `depth` tier (``"SYNTH"`` / legacy ``"SYNTH_PROFILE"``), NOT the
 * wire render mode — two-sided synthetic depth ships as ``MODE_L1_BAND`` (so it
 * renders bid+ask) yet must still colour as synthetic; keying off the tier keeps
 * that honest. ``mode === MODE_SYNTH_PROFILE`` is a fallback for when no
 * capability is known.
 *
 * The synthetic test runs FIRST and unconditionally, so the `colormap` argument
 * can never override it. Pure, so the selection is unit-testable without GL.
 */
export function rampForMode(
  mode: number,
  depth?: unknown,
  colormap: Colormap = DEFAULT_COLORMAP,
): number {
  const synthetic = depth === 'SYNTH' || depth === 'SYNTH_PROFILE';
  if (synthetic || mode === MODE_SYNTH_PROFILE) return RAMP_SYNTH;
  return rampForColormap(colormap);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function sampleRamp(stops: Stop[], t: number): [number, number, number] {
  const tc = clamp01(t);
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (tc <= first.t) return first.rgb;
  if (tc >= last.t) return last.rgb;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (tc >= a.t && tc <= b.t) {
      const f = (tc - a.t) / (b.t - a.t);
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f,
      ];
    }
  }
  return last.rgb;
}

/** Rasterize a stop list into a 256×1 RGBA8 ramp (alpha = 255). */
export function buildRamp(stops: Stop[]): Uint8Array {
  const out = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const [r, g, b] = sampleRamp(stops, i / (LUT_SIZE - 1));
    out[i * 4 + 0] = Math.round(r);
    out[i * 4 + 1] = Math.round(g);
    out[i * 4 + 2] = Math.round(b);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function buildInfernoLUT(): Uint8Array {
  return buildRamp(INFERNO_STOPS);
}

export function buildClassicLUT(): Uint8Array {
  return buildRamp(CLASSIC_STOPS);
}

export function buildSynthLUT(): Uint8Array {
  return buildRamp(SYNTH_STOPS);
}

/**
 * A CSS `linear-gradient` colour-stop list for an atlas row, low → high.
 *
 * Built from the SAME stop list the texture is rasterized from, so the legend is
 * not an approximation of the heatmap's ramp — it is the same function. CSS
 * interpolates sRGB channels linearly by default, exactly as {@link buildRamp}
 * does, so the two agree at every point rather than only at the stops.
 */
export function rampCssGradient(row: number): string {
  const stops = RAMP_STOPS[row] ?? RAMP_STOPS[RAMP_INFERNO];
  const parts = stops.map((s) => {
    const [r, g, b] = s.rgb.map((v) => Math.round(v));
    return `rgb(${r}, ${g}, ${b}) ${(s.t * 100).toFixed(1)}%`;
  });
  return parts.join(', ');
}

/**
 * Pack every ramp into a single 256×LUT_ROWS RGBA8 buffer laid out row-major,
 * ready for `texImage2D(..., 256, LUT_ROWS, ...)`.
 */
export function buildLUTAtlas(): Uint8Array {
  const atlas = new Uint8Array(LUT_SIZE * LUT_ROWS * 4);
  atlas.set(buildInfernoLUT(), RAMP_INFERNO * LUT_SIZE * 4);
  atlas.set(buildSynthLUT(), RAMP_SYNTH * LUT_SIZE * 4);
  atlas.set(buildClassicLUT(), RAMP_CLASSIC * LUT_SIZE * 4);
  return atlas;
}

/** Upload the LUT atlas as a 256×LUT_ROWS RGBA8 NEAREST-filtered texture. */
export function createLUTTexture(gl: WebGL2RenderingContext, atlas = buildLUTAtlas()): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('flowmap/lut: gl.createTexture returned null');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    LUT_SIZE,
    LUT_ROWS,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    atlas,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}
