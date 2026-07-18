/**
 * Heatmap colormaps (§8.3 / §9).
 *
 * Two ramps live side by side in one 256×2 RGBA8 atlas texture so the fragment
 * shader can select a ramp with a single uniform and a single texture bind:
 *   - row 0 (RAMP_THERMAL): thermal density ramp — near-black → deep blue →
 *     cyan → yellow → white as density rises (the dominant heatmap look).
 *   - row 1 (RAMP_SYNTH): a distinct single-hue amber ramp for SYNTH_PROFILE
 *     mode, so synthetic density reads as visually different from real L2 depth.
 *
 * `buildThermalLUT` / `buildSynthLUT` / `buildLUTAtlas` are pure (return
 * Uint8Array) so the ramp shape is unit-testable without a GL context.
 */

import { MODE_SYNTH_PROFILE } from '../proto/types';

export const LUT_SIZE = 256;

/** Atlas rows — the `u_ramp` uniform in the fragment shader indexes these. */
export const RAMP_THERMAL = 0;
export const RAMP_SYNTH = 1;

/**
 * Colormap row for a density column (§7 / §8.3): SYNTHETIC equity depth renders
 * in the single-hue amber ramp so it reads as visually distinct from real L2/L1
 * depth; everything else uses the thermal ramp. The honesty signal is the
 * capability `depth` tier (``"SYNTH"`` / legacy ``"SYNTH_PROFILE"``), NOT the
 * wire render mode — two-sided synthetic depth ships as ``MODE_L1_BAND`` (so it
 * renders bid+ask) yet must still colour as synthetic; keying off the tier keeps
 * that honest. ``mode === MODE_SYNTH_PROFILE`` is a fallback for when no
 * capability is known. Pure so the selection is unit-testable without a GL
 * context.
 */
export function rampForMode(mode: number, depth?: unknown): number {
  const synthetic = depth === 'SYNTH' || depth === 'SYNTH_PROFILE';
  return synthetic || mode === MODE_SYNTH_PROFILE ? RAMP_SYNTH : RAMP_THERMAL;
}

interface Stop {
  /** Normalized position along the ramp, 0..1. */
  t: number;
  /** sRGB bytes, 0..255. */
  rgb: [number, number, number];
}

// Thermal: near-black → deep blue → cyan → yellow → white. Control-point
// luminance is monotonically increasing so the ramp always brightens with
// density (piecewise-linear interpolation between monotone endpoints stays
// monotone), which the LUT test locks in.
const THERMAL_STOPS: Stop[] = [
  { t: 0.0, rgb: [2, 4, 12] },
  { t: 0.15, rgb: [10, 22, 92] },
  { t: 0.4, rgb: [0, 130, 200] },
  { t: 0.62, rgb: [24, 208, 224] },
  { t: 0.8, rgb: [232, 232, 44] },
  { t: 1.0, rgb: [255, 255, 255] },
];

// Synth: single-hue amber, near-black → deep amber → bright gold. Also
// monotone in luminance.
const SYNTH_STOPS: Stop[] = [
  { t: 0.0, rgb: [6, 3, 0] },
  { t: 0.25, rgb: [80, 30, 0] },
  { t: 0.55, rgb: [180, 90, 0] },
  { t: 0.8, rgb: [240, 170, 30] },
  { t: 1.0, rgb: [255, 240, 200] },
];

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

export function buildThermalLUT(): Uint8Array {
  return buildRamp(THERMAL_STOPS);
}

export function buildSynthLUT(): Uint8Array {
  return buildRamp(SYNTH_STOPS);
}

/**
 * Pack both ramps into a single 256×2 RGBA8 buffer (row 0 thermal, row 1
 * synth) laid out row-major, ready for `texImage2D(..., 256, 2, ...)`.
 */
export function buildLUTAtlas(): Uint8Array {
  const atlas = new Uint8Array(LUT_SIZE * 2 * 4);
  atlas.set(buildThermalLUT(), 0);
  atlas.set(buildSynthLUT(), LUT_SIZE * 4);
  return atlas;
}

/** Upload the LUT atlas as a 256×2 RGBA8 NEAREST-filtered texture. */
export function createLUTTexture(gl: WebGL2RenderingContext, atlas = buildLUTAtlas()): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('flowmap/lut: gl.createTexture returned null');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    LUT_SIZE,
    2,
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
