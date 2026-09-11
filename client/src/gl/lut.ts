/**
 * Heatmap colormaps (§8.3 / §9).
 *
 * Seven ramps live side by side in one 256×7 RGBA8 atlas texture so the fragment
 * shader can select a ramp with a single uniform and a single texture bind:
 *   - row 0 (RAMP_INFERNO): density ramp — near-black → indigo → violet →
 *     magenta → RED → orange → saturated gold as density rises.
 *   - row 1 (RAMP_SYNTH): a distinct single-hue amber ramp for SYNTHETIC equity
 *     depth, so fabricated density reads as visually different from real L2.
 *   - row 2 (RAMP_CLASSIC): the legacy thermal ramp (blue → cyan → yellow →
 *     saturated yellow-gold), kept as a user-selectable option.
 *   - row 3 (RAMP_FLOW): the identity/default "deep water" ramp (near-black
 *     slate → dark navy → deep teal → sage → sand → bright gold). See FLOW_STOPS.
 *   - row 4 (RAMP_IMBALANCE): the DIVERGENT row for the depth-channel
 *     `imbalance` mode (§9 channel modes) — NOT a density ramp: signed
 *     (bid−ask)/(bid+ask) maps through it, ask-dominant → blue, bid-dominant →
 *     orange, balanced → near-background neutral. Magnitude is brightness on
 *     each side; the blue↔orange axis is the CVD-safe divergent pair.
 *   - row 5 (RAMP_THEME): the ACTIVE theme's density ramp — uploaded from the
 *     theme registry via {@link setThemeStops}. Falls back to FLOW_STOPS when no
 *     theme is registered, so the identity (midnight) path is byte-identical.
 *   - row 6 (RAMP_THEME_SYNTH): the active theme's synthetic-depth ramp (same
 *     store + fallback to SYNTH_STOPS). Never used to dress synthetic depth in a
 *     real-depth ramp — {@link rampForMode} keeps the §7 honesty tier first.
 *
 * **Why the default changed.** The classic thermal ramp crosses half its
 * luminance range by LUT index 96 and spent its top third in bright
 * cyan/yellow/white (its old endpoint was literally white): a wall and a
 * mid-sized resting order land in visually adjacent colours and the field
 * reads as "blue with bright stripes". The inferno family spreads the same
 * range across FOUR distinct hue families (indigo / magenta / red /
 * orange-gold) and caps in saturated gold rather than white, so relative
 * density is legible by hue, not just by brightness.
 *
 * **Why the tops are gold, not white.** The price line overlay is white, so a
 * white ramp top would make a max-density wall indistinguishable from the
 * price line. Both real-depth ramps therefore end in saturated gold/yellow —
 * still their brightest stops (luma stays monotone), but blue-starved, so the
 * two never merge.
 *
 * **Why not yellow → red.** Every ramp here must be monotone in
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
export const RAMP_FLOW = 3;
/** Divergent imbalance row (signed bid↔ask dominance) — never a `u_ramp`
 *  density ramp; the channel-3 shader branch fetches it directly. */
export const RAMP_IMBALANCE = 4;
/** Active theme density ramp (uploaded via {@link setThemeStops}). */
export const RAMP_THEME = 5;
/** Active theme synthetic-depth ramp (uploaded via {@link setThemeStops}). */
export const RAMP_THEME_SYNTH = 6;

/**
 * Rows 0 (REAL depth) and 1 (SYNTH amber) are pinned by the e2e parity matrix —
 * new ramps therefore append and never renumber. Row 4 appends the divergent
 * imbalance row; rows 5/6 append the theme-owned ramps (campaign visual
 * 2026-09-11); rows 0..4 keep their exact bytes (pinned by golden tests).
 */
export const LUT_ROWS = 7;

/** The colormap families a user can choose between (the §9 Settings knob).
 *  `'theme'` follows the active theme's chart palette; the legacy three pin
 *  the shipped dark ramps regardless of theme. */
export type Colormap = 'theme' | 'flow' | 'inferno' | 'classic';

export const DEFAULT_COLORMAP: Colormap = 'theme';

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

/** A ramp control point. Structural type — theme ramps are `ChartStop` shaped. */
export interface RampStop {
  /** Normalized position along the ramp, 0..1. */
  readonly t: number;
  /** sRGB bytes, 0..255. */
  readonly rgb: readonly [number, number, number];
}

/** A theme's chart palettes, as the renderer receives them from the registry. */
export interface ThemeRampStops {
  readonly density: readonly RampStop[];
  readonly synth: readonly RampStop[];
}

/**
 * Active theme stops (module-level, not per-renderer): the atlas rows 5/6 and
 * the legend gradients are global singletons, and the renderer keeps a single
 * live instance. `null` → rows 5/6 default to FLOW_STOPS / SYNTH_STOPS, which
 * makes the `midnight` + `'theme'` path byte-identical to the legacy flow path.
 */
let themeStops: ThemeRampStops | null = null;

/** Register the active theme's ramps (or null for the flow/synth identity). */
export function setThemeStops(stops: ThemeRampStops | null): void {
  themeStops = stops;
}

// Inferno: near-black → indigo → violet → magenta → RED → orange → gold. The
// endpoint is SATURATED gold (blue-starved), never white — a max-density wall
// must stay distinct from the white price line overlay. Rec.601 luma at the
// stops runs 2.7 → 22.1 → 44.8 → 66.7 → 89.9 → 128.6 → 183.1 → 207.6: strictly
// increasing, so the rasterized ramp is luminance-monotone (luma is linear in
// RGB, and linear interpolation between monotone endpoints stays monotone).
// The red band lands at t ≈ 0.58.
const INFERNO_STOPS: RampStop[] = [
  { t: 0.0, rgb: [2, 2, 8] },
  { t: 0.12, rgb: [26, 12, 64] },
  { t: 0.28, rgb: [78, 18, 96] },
  { t: 0.44, rgb: [140, 26, 84] },
  { t: 0.58, rgb: [196, 44, 48] },
  { t: 0.72, rgb: [234, 96, 20] },
  { t: 0.86, rgb: [250, 176, 44] },
  { t: 1.0, rgb: [255, 216, 40] },
];

// Classic (the legacy thermal ramp): near-black → deep blue → cyan → yellow →
// saturated yellow-gold (was white — same reason as inferno: the white price
// line must not blend into the top of the ramp). Control-point luminance is
// monotonically increasing.
const CLASSIC_STOPS: RampStop[] = [
  { t: 0.0, rgb: [2, 4, 12] },
  { t: 0.15, rgb: [10, 22, 92] },
  { t: 0.4, rgb: [0, 130, 200] },
  { t: 0.62, rgb: [24, 208, 224] },
  { t: 0.8, rgb: [232, 232, 44] },
  { t: 1.0, rgb: [255, 228, 32] },
];

// Synth: single-hue amber, near-black → deep amber → bright gold. Also
// monotone in luminance. Deliberately warm-single-hue (R ≥ G ≥ B through the
// mid-range) so it stays hue-disjoint from every real-depth ramp.
const SYNTH_STOPS: RampStop[] = [
  { t: 0.0, rgb: [6, 3, 0] },
  { t: 0.25, rgb: [80, 30, 0] },
  { t: 0.55, rgb: [180, 90, 0] },
  { t: 0.8, rgb: [240, 170, 30] },
  { t: 1.0, rgb: [255, 240, 200] },
];

// Flow (the DEFAULT ramp) — the Bookmap-class "aurora" thermal (campaign 4.1):
// near-black slate → deep navy → blue → indigo → violet → magenta-orange →
// amber → gold. Redesigned against what the previous teal/sage ramp still got
// wrong on real crypto books:
//   1. The cool head is BLUE/INDIGO (no green): teal lines over a dark field
//      read as cheap phosphor; blue-violet is the ordered-book vocabulary
//      traders already know from Bookmap.
//   2. The field stays DARK through its lower ~55% — with the dark-field gamma
//      default (gl/heatmap DEFAULT_DISPLAY_GAMMA ≈ 0.86) the median resting
//      cell paints in the near-black head, so the ladder does not scream.
//   3. Warmth is EARNED and arrives FAST: hue crosses from violet to amber
//      between index ≈146 and ≈152, so an orange/gold pixel is unambiguous
//      "size worth reading", not ambient noise.
// Rec.601 luma at the stops: 7.8 → 22.9 → 47.8 → 63.2 → 100.1 → 141.7 →
// 179.2 → 218.5 — strictly increasing, so the rasterized ramp is
// luminance-monotone. The endpoint is bright gold (blue-starved, luma > 200,
// never white), so the e2e "wall is bright gold, distinct from the white price
// line" contract still holds; the low half stays COOL (B ≥ G) through index
// 146, so the §7 synthetic-depth cool-pixel probe stays sound.
const FLOW_STOPS: RampStop[] = [
  { t: 0.0, rgb: [5, 8, 14] },
  { t: 0.16, rgb: [10, 22, 60] },
  { t: 0.34, rgb: [20, 48, 120] },
  { t: 0.5, rgb: [60, 48, 150] },
  { t: 0.55, rgb: [160, 60, 150] },
  { t: 0.59, rgb: [232, 112, 58] },
  { t: 0.8, rgb: [250, 170, 40] },
  { t: 1.0, rgb: [255, 225, 90] },
];

// Imbalance (the DIVERGENT row): signed order-flow imbalance d=(bid−ask)/(bid+ask)
// maps t = d·0.5 + 0.5 onto this row. Design constraints, in priority order:
//   1. DIVERGENT, not monotone: balanced density must read QUIET (the midpoint is
//      a near-background dark slate, so a calm two-sided book does not light up),
//      while both extremes get BRIGHT — magnitude = brightness per side.
//   2. CVD-SAFE axis: blue ↔ orange is the canonical deuteranopia/protanopia-safe
//      divergent pair (never red↔green).
//   3. The side hue is unambiguous at every magnitude: ask-side is B-dominant
//      (B > R) at every stop below the midpoint; bid-side is R-dominant above it.
// Per-side luminance is monotone away from the midpoint (blue side darkens toward
// neutral, orange side brightens away from it) — pinned by lut.test.ts.
const IMBALANCE_STOPS: RampStop[] = [
  { t: 0.0, rgb: [148, 202, 255] }, // d = −1: strong ask dominance — bright ice blue
  { t: 0.18, rgb: [62, 128, 196] }, // clear blue
  { t: 0.38, rgb: [24, 52, 92] }, // deep blue, quieting
  { t: 0.5, rgb: [11, 15, 22] }, // d = 0: balanced — near-background neutral slate
  { t: 0.62, rgb: [92, 62, 26] }, // deep amber, waking
  { t: 0.82, rgb: [204, 128, 46] }, // clear orange
  { t: 1.0, rgb: [255, 206, 110] }, // d = +1: strong bid dominance — bright amber
];

/** Atlas row → stop list for the FROZEN rows 0..4 (theme rows live in the
 *  store; see {@link stopsForRow}). */
const RAMP_STOPS: Record<number, readonly RampStop[]> = {
  [RAMP_INFERNO]: INFERNO_STOPS,
  [RAMP_SYNTH]: SYNTH_STOPS,
  [RAMP_CLASSIC]: CLASSIC_STOPS,
  [RAMP_FLOW]: FLOW_STOPS,
  [RAMP_IMBALANCE]: IMBALANCE_STOPS,
};

/** Atlas row → stop list, resolving the theme-owned rows 5/6 from the store.
 *  The single source of truth for the GPU texture AND the HTML legend gradient,
 *  so they can never drift apart. */
function stopsForRow(row: number): readonly RampStop[] {
  if (row === RAMP_THEME) return themeStops?.density ?? FLOW_STOPS;
  if (row === RAMP_THEME_SYNTH) return themeStops?.synth ?? SYNTH_STOPS;
  return RAMP_STOPS[row] ?? RAMP_STOPS[RAMP_INFERNO];
}

/**
 * The clearColor matching a ramp's background — LUT entry 0 of `row`, normalized
 * for `gl.clearColor`. The single source of truth for the terminal near-black:
 * the fragment shader's `background()` samples the SAME stop, so a cleared
 * canvas (pre-data, session reset) and a zero-density pixel are bit-identical
 * instead of the clear flashing rgb(2,4,7) under the ramp's rgb(5,8,14).
 * Rows {@link RAMP_THEME}/{@link RAMP_THEME_SYNTH} follow the theme store.
 */
export function clearColorForRamp(row: number = RAMP_FLOW): [number, number, number, number] {
  const stops = stopsForRow(row);
  const [r, g, b] = stops[0].rgb;
  return [r / 255, g / 255, b / 255, 1];
}

/** Atlas row for a user colormap choice (real depth only — see rampForMode).
 *  `'theme'` maps to the FLOW row: the actual themed row is resolved by
 *  {@link rampForMode} and the renderer only when a non-midnight theme exists. */
export function rampForColormap(colormap: Colormap): number {
  if (colormap === 'classic') return RAMP_CLASSIC;
  if (colormap === 'theme' || colormap === 'flow') return RAMP_FLOW;
  return RAMP_INFERNO;
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
 * can never override it. `themed` carries the theme-owned atlas rows to use for
 * the `'theme'` family (the renderer passes null for the midnight identity, so
 * the observable rows stay RAMP_FLOW/RAMP_SYNTH). Pure, so the selection is
 * unit-testable without GL.
 */
export function rampForMode(
  mode: number,
  depth?: unknown,
  colormap: Colormap = DEFAULT_COLORMAP,
  themed: { density: number; synth: number } | null = null,
): number {
  const synthetic = depth === 'SYNTH' || depth === 'SYNTH_PROFILE';
  if (synthetic || mode === MODE_SYNTH_PROFILE) return themed?.synth ?? RAMP_SYNTH;
  if (colormap === 'theme') return themed?.density ?? RAMP_FLOW;
  return rampForColormap(colormap);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function sampleRamp(stops: readonly RampStop[], t: number): readonly [number, number, number] {
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
export function buildRamp(stops: readonly RampStop[]): Uint8Array {
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

export function buildFlowLUT(): Uint8Array {
  return buildRamp(FLOW_STOPS);
}

/** The divergent imbalance ramp (row 4). NOT luminance-monotone by design. */
export function buildImbalanceLUT(): Uint8Array {
  return buildRamp(IMBALANCE_STOPS);
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
  return gradientOfStops(stopsForRow(row));
}

/**
 * {@link rampCssGradient} with the stop list REVERSED (top ↔ bottom) — the
 * divergent imbalance legend paints the ASK side at the TOP of the bar so the
 * legend matches the chart's vertical layout (asks above the mid, bids below),
 * while the LUT row itself is untouched. Same stop list, same source of truth.
 */
export function rampCssGradientReversed(row: number): string {
  const stops = stopsForRow(row);
  return gradientOfStops([...stops].reverse());
}

function gradientOfStops(stops: readonly RampStop[]): string {
  const parts = stops.map((s) => {
    const [r, g, b] = s.rgb.map((v) => Math.round(v));
    return `rgb(${r}, ${g}, ${b}) ${(s.t * 100).toFixed(1)}%`;
  });
  return parts.join(', ');
}

/**
 * Pack every ramp into a single 256×LUT_ROWS RGBA8 buffer laid out row-major,
 * ready for `texImage2D(..., 256, LUT_ROWS, ...)`. Rows 5/6 come from the theme
 * store (`theme` defaults to it); null → the flow/synth identity bytes.
 */
export function buildLUTAtlas(theme: ThemeRampStops | null = themeStops): Uint8Array {
  const atlas = new Uint8Array(LUT_SIZE * LUT_ROWS * 4);
  atlas.set(buildInfernoLUT(), RAMP_INFERNO * LUT_SIZE * 4);
  atlas.set(buildSynthLUT(), RAMP_SYNTH * LUT_SIZE * 4);
  atlas.set(buildClassicLUT(), RAMP_CLASSIC * LUT_SIZE * 4);
  atlas.set(buildFlowLUT(), RAMP_FLOW * LUT_SIZE * 4);
  atlas.set(buildImbalanceLUT(), RAMP_IMBALANCE * LUT_SIZE * 4);
  atlas.set(buildRamp(theme?.density ?? FLOW_STOPS), RAMP_THEME * LUT_SIZE * 4);
  atlas.set(buildRamp(theme?.synth ?? SYNTH_STOPS), RAMP_THEME_SYNTH * LUT_SIZE * 4);
  return atlas;
}

/**
 * Re-specify an EXISTING LUT texture with a fresh atlas, keeping the texture
 * object (and therefore every sampler binding — the renderer's Heatmap holds a
 * readonly handle). Used when the theme stops change mid-session.
 */
export function uploadLUTAtlas(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture,
  atlas: Uint8Array = buildLUTAtlas(),
): void {
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
  gl.bindTexture(gl.TEXTURE_2D, null);
}

/** Upload the LUT atlas as a 256×LUT_ROWS RGBA8 NEAREST-filtered texture. */
export function createLUTTexture(gl: WebGL2RenderingContext, atlas = buildLUTAtlas()): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('flowmap/lut: gl.createTexture returned null');
  uploadLUTAtlas(gl, tex, atlas);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}
