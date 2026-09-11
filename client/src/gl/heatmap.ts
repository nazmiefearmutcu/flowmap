/**
 * The heatmap draw pass (§8.3 rendering).
 *
 * Owns the shader program, a full-viewport quad VAO, and the uniform wiring
 * that ties the tile ring + LUT together. `draw(view)` renders the resident
 * columns: it binds the two textures, pushes the view transform + encoding /
 * normalization / ramp uniforms, and issues ONE draw call. Panning/zooming is
 * purely a matter of the `view` uniforms (T6) — this pass never touches tile
 * pixels, upholding the §8.3 no-re-raster invariant.
 */

import { checkGLError, type GLContext } from './context';
import { RAMP_FLOW } from './lut';
import type { MipChain } from './mips';
import { HEATMAP_FRAG, HEATMAP_VERT } from './shaders/heatmap';
import { TileRing } from './tileRing';

/** Screen→grid mapping. col = colOffset + colScale·uv.x; row = rowOffset + rowScale·uv.y. */
export interface HeatmapView {
  colOffset: number;
  colScale: number;
  rowOffset: number;
  rowScale: number;
}

/** Value-encoding + colormap knobs (normally driven by §8.3 normalization). */
export interface HeatmapEncoding {
  /** Per-instrument fixed decode scale applied to raw density. */
  decodeScale: number;
  /** Normalization divisor (percentile) mapping intensity into ~[0,1]. */
  norm: number;
  /** Colormap row: RAMP_FLOW | RAMP_INFERNO | RAMP_SYNTH | RAMP_CLASSIC. */
  ramp: number;
}

/** The depth channel a user can view (contract C2; `Renderer.setDepthChannel`). */
export type DepthChannel = 'sum' | 'bid' | 'ask' | 'imbalance';

/** `DepthChannel` → the shader's `u_channel` code. */
export const DEPTH_CHANNEL_CODE: Record<DepthChannel, number> = {
  sum: 0,
  bid: 1,
  ask: 2,
  imbalance: 3,
};

export const DEFAULT_DEPTH_CHANNEL: DepthChannel = 'sum';

/** Clamp an arbitrary (settings-persisted) value to a valid channel. */
export function depthChannelOf(value: unknown): DepthChannel {
  return value === 'bid' || value === 'ask' || value === 'imbalance' ? value : 'sum';
}

const TILE_UNIT = 0;
const LUT_UNIT = 1;
const MIP1_UNIT = 2;
const MIP2_UNIT = 3;
const ROWMIP_UNIT = 4;

/**
 * Default perceptual display gamma (§8.3). Order-flow density is heavy-tailed:
 * the median active cell is a few percent of the viewport white point while
 * walls sit at 10-100×. A LIFTING curve (~0.45) paints every one of those
 * small orders at mid-ramp brightness and the field reads as a rainbow
 * barcode; the Bookmap-class default therefore sits at ~0.86, which keeps the
 * small sizes near the dark head of the ramp and reserves the warm top for
 * size worth reading. Walls and the white point stay pinned (pow fixes both
 * ends). The settings drawer can override this — see the "Contrast" control.
 * Pinned equal to gammaForContrast(DEFAULT_CONTRAST) by the tests.
 */
export const DEFAULT_DISPLAY_GAMMA = 0.86;

/**
 * Map a 0–100 "Contrast" slider to a display gamma. HIGHER contrast → HIGHER
 * gamma → a darker mid-field with punchier walls (more separation); LOWER
 * contrast → lower gamma → the field is lifted flat/bright (washed, less
 * separation). The default ({@link DEFAULT_CONTRAST}) lands on 0.86 — the
 * Bookmap-class dark-field default (see {@link DEFAULT_DISPLAY_GAMMA}).
 * Clamped to the legible band [0.5, 1.4].
 */
export function gammaForContrast(contrast: number): number {
  const c = Math.min(100, Math.max(0, contrast));
  return 0.5 + (c / 100) * 0.9;
}

/** Slider position (0–100) whose gamma equals the default — the reset point. */
export const DEFAULT_CONTRAST = 40;

/**
 * Largest black point the Tolerance slider can reach. Raised from 0.5 to 0.85 so
 * the control has real reach — at the top of the slider it hides sub-threshold
 * density up to 85% of the white point, cutting a genuinely noisy field down to
 * just the walls. Still capped well below 1: at `floor → 1` the `1/(1-floor)`
 * re-expansion (scale = 6.67× here) degenerates and even the p99 white point
 * maps to LUT entry 0 — a black screen — which would break the "both endpoints
 * stay fixed" promise rather than implement it.
 */
export const TOLERANCE_MAX_FLOOR = 0.85;

/** Curve exponent for the slider → floor map. Between linear (1) and the old
 *  square (2): eased enough to keep fine control at the low end, but with real
 *  bite through the mid-slider where the field actually gets cleaned up. */
export const TOLERANCE_CURVE = 1.4;

/**
 * Default Tolerance slider position. A gentle non-zero denoise (not the old
 * hard 0) so the app opens with the faintest sub-threshold specks already
 * suppressed and the tradeable liquidity reads cleaner out of the box. Slider 0
 * remains an exact algebraic no-op for anyone who wants every speck back.
 *
 * 15 (floor ≈ 0.060) was the "empty heatmap" default: order-flow density is
 * heavy-tailed, and with the p99 white point the MEDIAN active cell sat at ~2%
 * of norm — a third of the floor — so out of the box the whole ladder painted
 * background and only the walls showed. 5 maps to a floor of ≈ 0.013, which on
 * the same tail shape suppresses just the bottom quartile (the specks) while
 * the median cell (~4% of the p97 norm) clears the floor and reads as dark
 * indigo. The math is pinned by the "default visibility" test in
 * heatmap.test.ts (≈76% of active cells visible vs ≈26% before).
 */
export const DEFAULT_TOLERANCE = 5;

/**
 * Map a 0–100 "Tolerance" slider to the shader's black point.
 *
 * Eased (exponent {@link TOLERANCE_CURVE}), not linear, because the useful floors
 * are small: order-flow density is heavy-tailed and with the p97 white point the
 * median active cell lands near 4% of norm, so a floor around 1–2% separates the
 * real ladder from the specks without hiding the field (at the default floor of
 * ≈0.013 a cell needs ~1.3% of the white point to paint at all). The eased curve
 * gives fine control at the low end and meaningful bite through the middle,
 * reaching the cap at 100.
 *
 * Non-finite input yields 0 rather than NaN — a NaN floor would blank the entire
 * heatmap, and this is reachable from `window.__flowmapLive` in dev/e2e builds.
 * Slider 0 → floor 0 exactly (an algebraic no-op), preserved by construction.
 */
export function floorForTolerance(tolerance: number): number {
  if (!Number.isFinite(tolerance)) return 0;
  const t = Math.min(100, Math.max(0, tolerance)) / 100;
  return TOLERANCE_MAX_FLOOR * Math.pow(t, TOLERANCE_CURVE);
}

/** The mip level + tap geometry to sample this frame (see {@link selectLevel}). */
interface LevelSel {
  level: number;
  blk: number;
  nRowTaps: number;
  /**
   * Row-only mip selected (campaign visual 2026-09-11, R2-M1). Present ONLY
   * when true, so every pre-existing caller/assertion keeps its exact object
   * shape; the draw then overrides level/blk/taps itself (see {@link Heatmap.draw}).
   */
  rowOnly?: boolean;
}

/**
 * Choose the SUM-mip level from the pixel's footprint on BOTH axes.
 *
 * `rowsPerPixel` (price axis): how many price rows collapse into one device
 * pixel. `colPerPixel` (time axis): how many columns a device pixel spans when
 * the user zooms OUT in time — historically ignored, which made a time-zoomed-out
 * + price-zoomed-in view sample hundreds of columns per pixel through the 3-tap
 * level-0 blur (temporal aliasing: walls strobe while panning, thin events
 * vanish). Level L's texels sum a 4^L×4^L block, so the level picked is the
 * COARSER of the two axes' needs (`max`), clamped to `maxLevel`; the leftover row
 * footprint is covered by 1..4 finer-level taps summed in the shader.
 *
 * Per-level intensity/floor semantics are UNCHANGED: intensity sums
 * `nRowTaps` row-blocks and divides the column dimension by blk, so a view at a
 * given (level, taps) reads the same whether that level was chosen by the row or
 * the column axis — a col-driven level behaves exactly like a price zoom to the
 * same blk, and the black point keeps scaling by `nRowTaps·blk` (the row
 * footprint at that level). With no mips (`maxLevel === 0`) this is the
 * identity: level 0, one tap.
 *
 * `colPerPixel` defaults to 1 so every historical 2-arg call — and every
 * row-driven selection — produces EXACTLY the pre-axis output.
 *
 * `levelFloor` (contract P1, tick grouping) is a LOWER BOUND on the chosen
 * level: `Renderer.setTickGrouping(n)` passes the smallest level whose block
 * already groups at least `n` rows (`ceil(log4(n))`), so the displayed cell is
 * 4^level ≥ n rows. The floor is clamped to `maxLevel`; with no mips
 * (`maxLevel === 0`) it is ignored (there is no coarser texture to sample).
 * `levelFloor = 0` — the default, and every pre-tickGrouping call — reproduces
 * the exact previous output.
 *
 * `rowOnly: true` (campaign visual 2026-09-11, R2-M1) is a purely ADDITIVE flag:
 * present only when the row axis needs the 4-row mip at rpp >= 2.5, the time
 * axis is NOT zoomed out (cpp < 1.5) and no tick-grouping floor is active.
 * {@link Heatmap.draw} then samples the row-only chain (4-row sums of ONE
 * column) instead of the 4x4 SUM mip; level/blk/nRowTaps remain the historical
 * SUM-path fields so every pre-existing consumer output is unchanged.
 */
export function selectLevel(
  rowsPerPixel: number,
  maxLevel: number,
  colPerPixel = 1,
  levelFloor = 0,
): LevelSel {
  if (maxLevel <= 0) return { level: 0, blk: 1, nRowTaps: 1 };
  const rpp = Number.isFinite(rowsPerPixel) ? rowsPerPixel : 1;
  const cpp = Number.isFinite(colPerPixel) ? colPerPixel : 1;
  // log4 via log2/2: Math.log2 is exact for powers of two on V8, so the
  // level boundary at exact 4^k footprints no longer rides on log/log rounding.
  //
  // Campaign 4.1: the ROW axis switches to the 4-row SUM mip at rpp >= 2.5.
  // The old floor-at-4 left a 2-4 rows/pixel band on the level-0 single-row
  // sampler, which aliased into a hard per-price "barcode" on real books; the
  // mip gives the same footprint smoothing for ONE texel fetch, whereas a
  // per-pixel multi-tap sum measured over the §10 SwiftShader draw budget.
  // Below 2.5 the level-0 bilinear field is smooth (several pixels per row).
  const rowLevel = rpp >= 2.5 ? Math.max(1, Math.min(maxLevel, Math.floor(Math.log2(rpp) / 2))) : 0;
  const colLevel = cpp > 1 ? Math.min(maxLevel, Math.floor(Math.log2(cpp) / 2)) : 0;
  const floorLevel = Number.isFinite(levelFloor)
    ? Math.max(0, Math.min(maxLevel, Math.floor(levelFloor)))
    : 0;
  // Row-only decoupling (campaign visual 2026-09-11, R2-M1): at rpp >= 2.5 the
  // ROW axis alone needs 4-row grouping, and when the time axis is NOT zoomed
  // out (cpp < 1.5) that grouping is done WITHOUT the 4-column averaging the
  // 4x4 SUM mip applies — the owner's scrolled-back / reconstructed regime
  // (rpp 3.05, cpp < 1) keeps crisp cell edges instead of 4-column blocks. The
  // flag is additive: level/blk stay the historical SUM-path fields so every
  // pre-existing consumer output is unchanged, and the draw derives the actual
  // row-mip taps (blk 4) itself. A tick-grouping floor keeps the forced SUM
  // path (the floor is an explicit user choice of block size).
  const rowOnly = rpp >= 2.5 && cpp < 1.5 && floorLevel === 0;
  const level = Math.max(floorLevel, Math.max(0, Math.max(rowLevel, colLevel)));
  const blk = 4 ** level;
  // COVERAGE, not rounding (campaign 4.2): round(rpp/blk) picked 1 tap for rpp
  // in (4,6), leaving ~30% of the pixel's price footprint unsampled — when
  // price is zoomed far out that aliasing paints every price row as a dashed
  // line. ceil() guarantees the summed taps span the whole footprint; the ×4
  // clamp covers 64 rows at level 2, more than any viewport at the 4096-row
  // grid can demand.
  const nRowTaps = Math.max(1, Math.min(4, Math.ceil(rpp / blk)));
  return rowOnly ? { level, blk, nRowTaps, rowOnly: true } : { level, blk, nRowTaps };
}

/**
 * Smooth SUM-mip level cross-fade (campaign visual 2026-09-11, wave P2).
 *
 * The historical SUM-mip selector switched levels at hard 4^k footprints: at
 * colsPerPixel 4.0 the shader jumped from a single level-0 column sample to a
 * 4x4 SUM block (equivalently at 16.0 for level 2), a measured mean-luma spike
 * of 88.9 — 9.4x the median — exactly at the boundary. This returns a blend
 * plan instead: across a transition band [0.75*4^k, 4^k] the draw mixes the
 * FINER level (k-1) into the coarse level k with weight `fade` (smoothstep,
 * zero slope at both band ends), so the LOD change is continuous.
 *
 * Pure function, byte-identical outside the band:
 *   - fp <= 1 / non-finite / <= 0        -> pure level 0 (no finer sample).
 *   - fp < 0.75*4^k (outside the band)   -> pure level k-1 (fade 0; the draw
 *     then uploads the LEGACY selectLevel() values verbatim).
 *   - fp >= 4^k (k < maxLevel)           -> pure level k (fade 1; equals the
 *     old selectLevel() output at every historical switch point 4.0/16.0...).
 *   - 0.75*4^k < fp < 4^k                -> { level: k, finerLevel: k-1,
 *     fade: w } with w = smoothstep((fp/4^k - 0.75) / 0.25).
 *   - fp beyond 4^maxLevel               -> pure maxLevel (weight saturates).
 *   - `levelFloor > 0` (tick grouping) or `maxLevel < 1` -> fade 0: a forced
 *     or absent level must stay pure and bit-exact (the draw falls back to the
 *     legacy selectLevel() upload; nothing is blended).
 *
 * `fp` is the dominant footprint axis the selector uses,
 * `max(rowsPerPixel, colsPerPixel)`. `finerLevel` is -1 whenever no second
 * sample exists (fade 0 or 1); the draw reports it additively for diagnostics.
 */
export function levelBlendFor(
  fp: number,
  maxLevel: number,
  levelFloor = 0,
): { level: number; finerLevel: number; fade: number } {
  if (!Number.isFinite(fp) || fp <= 0) return { level: 0, finerLevel: -1, fade: 0 };
  const maxL = Number.isFinite(maxLevel) ? Math.max(0, Math.floor(maxLevel)) : 0;
  const floor = Number.isFinite(levelFloor)
    ? Math.max(0, Math.min(maxL, Math.floor(levelFloor)))
    : 0;
  if (maxL < 1 || floor > 0) {
    return { level: Math.max(0, Math.min(floor, maxL)), finerLevel: -1, fade: 0 };
  }
  // Smallest integer k with fp <= 4^k (log2 is exact for powers of two on V8,
  // so the 4^k boundaries never ride on log/log rounding).
  const kRaw = Math.ceil(Math.log2(fp) / 2);
  if (kRaw <= 0) return { level: 0, finerLevel: -1, fade: 0 };
  const k = Math.min(maxL, kRaw);
  const boundary = 4 ** k;
  // The band is deliberately WIDE (0.55..1.00 of the boundary): the LOD change
  // is a brightness ramp of the aggregation factor (up to 4x), so a narrow band
  // still concentrates it into a couple of wheel steps. 0.55..1.0 spreads the
  // same total change over ~4x more zoom range (zoom-ladder re-measured).
  // Exact band edges: the two pure regimes compare against their own constants
  // so fp == bandLo and fp == boundary are bit-exact endpoints (a t-formula
  // would land on 0.9999999999999999 and break endpoint byte-identity).
  const bandLo = boundary * 0.55;
  if (fp <= bandLo) return { level: k - 1, finerLevel: -1, fade: 0 };
  if (fp >= boundary) return { level: k, finerLevel: -1, fade: 1 };
  const t = (fp - bandLo) / (boundary - bandLo);
  // LINEAR ramp, not smoothstep: the pixel delta per zoom step is ~proportional
  // to the weight change, so a uniform ramp minimizes the MAX per-step pop
  // (smoothstep concentrated ~1.5x the average change in the band's middle —
  // measured on the zoom ladder). The band edges meet constant regimes, so the
  // slope kink there is sub-step and invisible.
  const w = t;
  return { level: k, finerLevel: k - 1, fade: w };
}

/**
 * Zoom-aware level-0 sampler mix (campaign 5, contract F4). The historical
 * level-0 kernel (bilinear + 0.25/0.5/0.25 column blur) spans ~4 columns; while
 * a column is sub-pixel that blur is the right anti-confetti filter, but at
 * deep zoom (one column over many pixels) it smears cell edges over 40–200 px
 * and never sharpens (S3 measurement).
 *
 * `colsPerPixel = view.colScale / drawingBufferWidth`:
 *   - cpp >= 1.5 → full blur, crisp off — columns are (sub-)pixel wide.
 *   - cpp <= 0.5 → blur off, full crisp cell sampling — flat data plateaus
 *     with hard time edges.
 *   - smoothstep cross-fade in between, so the two filters never pop while
 *     zooming; the weights always sum to 1.
 *
 * Non-finite input degrades to the conservative historical output (full blur).
 */
export function sampleMix(colsPerPixel: number): { blur: number; cell: number } {
  if (!Number.isFinite(colsPerPixel)) return { blur: 1, cell: 0 };
  if (colsPerPixel >= 1.5) return { blur: 1, cell: 0 };
  if (colsPerPixel <= 0.5) return { blur: 0, cell: 1 };
  // Resolution-transition polish (lane P): smoothstep the cross-fade instead of
  // the historical linear ramp, so the crisp/blur handoff has zero derivative at
  // BOTH ends — a zoom series through cpp 0.5..1.5 no longer shows the subtle
  // slope discontinuity the zoom-ladder probe caught at the crossover. `t` is
  // the complementary fraction (1 at cpp 0.5 → crisp, 0 at cpp 1.5 → blur), so
  // cell stays monotone decreasing as columns grow; 1.0 still lands exactly on
  // {0.5, 0.5}, and the endpoint branches above stay bit-exact.
  const t = (1.5 - colsPerPixel) / (1.5 - 0.5);
  const cell = t * t * (3 - 2 * t);
  return { blur: 1 - cell, cell };
}

/**
 * Row-mip cross-fade weight (resolution-transition polish, lane P).
 *
 * The historical row LOD switch was a hard threshold: rpp < 2.5 sampled the
 * level-0 single-row bilinear, rpp >= 2.5 sampled the 4-row-sum mip — a
 * measured brightness/pop spike in the zoom ladder through rpp 2.4–3.9 (the
 * band where row aggregation flips). This ramps the handoff instead:
 *
 *   - rpp <= 2.0  → 0 (pure level-0 rows, EXACT legacy output)
 *   - rpp >= 3.2  → 1 (pure row-mip sums, EXACT post-4.1 output)
 *   - in between  → smoothstep((rpp-2.0)/1.2), zero derivative at both ends
 *
 * Non-finite input degrades to 0 (the legacy level-0 path) rather than
 * poisoning the blend weight. NOTE the DRAW applies this only inside the
 * row-mip eligibility regime and renormalizes the edge — see
 * {@link effectiveRowMode}, which is the single source of truth for the
 * uploaded weight.
 */
export function rowFadeFor(rowsPerPixel: number): number {
  if (!Number.isFinite(rowsPerPixel) || rowsPerPixel <= 2.0) return 0;
  if (rowsPerPixel >= 4.5) return 1;
  // Linear ramp (see levelBlendFor): uniform weight deltas minimize the max
  // per-step pop; the regime edges are renormalized by effectiveRowMode anyway.
  return (rowsPerPixel - 2.0) / (4.5 - 2.0);
}

/** `selectLevel`'s row-mip threshold (rpp >= 2.5) — the fade's eligibility edge. */
const ROW_MIP_EDGE = 2.5;

/**
 * The draw-side effective row mode for a frame — the SINGLE source of truth for
 * `{rowOnly, rowFade}`. `Heatmap.draw` and `testHook.levelInfo` both call this,
 * so the reported selection can never drift from the painted one.
 *
 * The hard row-mip threshold (`selectLevel`'s `rowOnly`, which already encodes
 * rpp >= 2.5 AND a deep time zoom AND no tick-grouping floor) is replaced by a
 * smooth blend, but the regime edges themselves are preserved: a frame is only
 * eligible inside that regime (`rowEligible`), so the time-zoomed-out SUM path,
 * a forced tick-grouping floor, and the rpp < 2.5 level-0 path keep their exact
 * historical output. Inside the regime the weight from {@link rowFadeFor} is
 * RENORMALIZED to 0 at the regime edge (rpp 2.5) — the draw switches from the
 * legacy level-0 sample to the row-mip mix with a zero-weight blend, so there is
 * no step at the edge — and reaches 1 at rpp 3.2, fully continuous across the
 * measured 2.4–3.9 pop band.
 *
 * Without a usable row-mip chain (`rowUsable` false) the weight is 0: the
 * legacy selection is used verbatim.
 */
export function effectiveRowMode(
  rowsPerPixel: number,
  rowUsable: boolean,
  rowEligible = true,
): { rowOnly: boolean; rowFade: number } {
  if (!rowUsable || !rowEligible) return { rowOnly: false, rowFade: 0 };
  const raw = rowFadeFor(rowsPerPixel);
  const knee = rowFadeFor(ROW_MIP_EDGE);
  const rowFade = raw <= knee ? 0 : (raw - knee) / (1 - knee);
  return { rowOnly: rowFade > 0, rowFade };
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('flowmap/heatmap: createShader returned null');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new Error(`flowmap/heatmap: ${kind} shader compile failed: ${log}`);
  }
  return sh;
}

function linkProgram(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vert);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, frag);
  const prog = gl.createProgram();
  if (!prog) throw new Error('flowmap/heatmap: createProgram returned null');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  // Shaders can be detached/deleted once linked.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`flowmap/heatmap: program link failed: ${log}`);
  }
  return prog;
}

type UniformName =
  | 'u_tiles'
  | 'u_mip1'
  | 'u_mip2'
  | 'u_rowMip1'
  | 'u_lut'
  | 'u_colOffset'
  | 'u_colScale'
  | 'u_rowOffset'
  | 'u_rowScale'
  | 'u_capacityCols'
  | 'u_colsPerTile'
  | 'u_rows'
  | 'u_validFrom'
  | 'u_residentNewest'
  | 'u_decodeScale'
  | 'u_norm'
  | 'u_gamma'
  | 'u_floor'
  | 'u_floorScale'
  | 'u_ramp'
  | 'u_channel'
  | 'u_level'
  | 'u_blk'
  | 'u_nRowTaps'
  | 'u_levelFade'
  | 'u_nRowTapsFine'
  | 'u_rowOnly'
  | 'u_rowFade'
  | 'u_colBlur'
  | 'u_colCell';

export class Heatmap {
  readonly gl: WebGL2RenderingContext;
  private readonly tileRing: TileRing;
  private readonly lut: WebGLTexture;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quad: WebGLBuffer;
  private readonly u: Record<UniformName, WebGLUniformLocation | null>;

  /** SUM-mip chain (T7). null → the shader stays on the level-0 single-tap path. */
  mips: MipChain | null = null;

  encoding: HeatmapEncoding = { decodeScale: 1, norm: 1, ramp: RAMP_FLOW };

  /**
   * Perceptual display gamma applied to the normalized intensity before the LUT
   * (§8.3). Kept separate from {@link encoding} so it survives the per-session
   * encoding reassignments; the settings drawer's Contrast control writes it.
   */
  gamma = DEFAULT_DISPLAY_GAMMA;

  /**
   * Black point on the normalized intensity (§9 Tolerance), in the same units as
   * `t` BEFORE the mip footprint is folded in — `draw()` scales it per frame.
   * Kept outside {@link encoding} so `updateNormalization`'s per-frame
   * reassignment of that object cannot clobber it, exactly like {@link gamma}.
   */
  floor = 0;

  /**
   * Depth channel mode (§9, contract C2): the `u_channel` code fed to the
   * fragment shader — 0 sum (the default, bit-identical to pre-channel
   * releases), 1 bid, 2 ask, 3 imbalance (divergent row). Kept outside
   * {@link encoding} like {@link gamma}: the renderer owns the setting
   * (`setDepthChannel`) and re-applies it after every Heatmap re-creation,
   * forcing 'sum' whenever the honesty ramp is SYNTH (§7 — fabricated equity
   * depth never wears the directional bid/ask colors).
   */
  channel = DEPTH_CHANNEL_CODE.sum;

  /**
   * Tick-grouping floor on the SUM-mip level (contract P1):
   * `Renderer.setTickGrouping(n)` sets this to the smallest level whose 4^level
   * block already groups ≥ n rows (`ceil(log4(n))`), clamped to `maxLevel` at
   * draw time. 0 (the default) is a no-op — every draw selects EXACTLY the
   * level the pre-tickGrouping code picked. Kept outside {@link encoding}, like
   * {@link gamma}, so a re-creation on session reset / context restore can
   * re-apply the user's setting.
   */
  levelFloor = 0;

  /**
   * Scale-aware sampler state from the LAST {@link draw} (campaign 5, F4 + lane
   * P): `colsPerPixel` (time-axis footprint), the blur/cell weights, and the
   * row-mip cross-fade weight that were uploaded. Defaults to the zoomed-out
   * historical blur before the first draw.
   */
  private lastSample = {
    colsPerPixel: 1,
    colBlur: 1,
    colCell: 0,
    rowFade: 0,
    levelFade: 0,
    finerLevel: -1,
  };

  constructor(ctx: GLContext, tileRing: TileRing, lut: WebGLTexture) {
    const gl = ctx.gl;
    this.gl = gl;
    this.tileRing = tileRing;
    this.lut = lut;

    this.program = linkProgram(gl, HEATMAP_VERT, HEATMAP_FRAG);

    // Full-viewport quad as a triangle strip: (pos.xy, uv.xy) interleaved.
    // uv spans 0..1 with y up (uv.y 0 = bottom of the price grid).
    // prettier-ignore
    const verts = new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
       1,  1, 1, 1,
    ]);
    const quad = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (!quad || !vao) throw new Error('flowmap/heatmap: buffer/VAO alloc failed');
    this.quad = quad;
    this.vao = vao;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const stride = 4 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 2 * 4);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const loc = (n: UniformName) => gl.getUniformLocation(this.program, n);
    this.u = {
      u_tiles: loc('u_tiles'),
      u_mip1: loc('u_mip1'),
      u_mip2: loc('u_mip2'),
      u_rowMip1: loc('u_rowMip1'),
      u_lut: loc('u_lut'),
      u_colOffset: loc('u_colOffset'),
      u_colScale: loc('u_colScale'),
      u_rowOffset: loc('u_rowOffset'),
      u_rowScale: loc('u_rowScale'),
      u_capacityCols: loc('u_capacityCols'),
      u_colsPerTile: loc('u_colsPerTile'),
      u_rows: loc('u_rows'),
      u_validFrom: loc('u_validFrom'),
      u_residentNewest: loc('u_residentNewest'),
      u_decodeScale: loc('u_decodeScale'),
      u_norm: loc('u_norm'),
      u_gamma: loc('u_gamma'),
      u_floor: loc('u_floor'),
      u_floorScale: loc('u_floorScale'),
      u_ramp: loc('u_ramp'),
      u_channel: loc('u_channel'),
      u_level: loc('u_level'),
      u_blk: loc('u_blk'),
      u_nRowTaps: loc('u_nRowTaps'),
      u_levelFade: loc('u_levelFade'),
      u_nRowTapsFine: loc('u_nRowTapsFine'),
      u_rowOnly: loc('u_rowOnly'),
      u_rowFade: loc('u_rowFade'),
      u_colBlur: loc('u_colBlur'),
      u_colCell: loc('u_colCell'),
    };
    checkGLError(gl, 'Heatmap.ctor');
  }

  /**
   * A default view that fills the viewport with all resident columns and the
   * full price grid (single epoch). T6 replaces this with the pan/zoom camera.
   */
  fitView(): HeatmapView {
    const range = this.tileRing.residentRange();
    const colOffset = range ? range.oldest : 0;
    const colScale = range ? range.count : 1;
    return { colOffset, colScale, rowOffset: 0, rowScale: this.tileRing.rows };
  }

  draw(view: HeatmapView): void {
    const gl = this.gl;
    const range = this.tileRing.residentRange();

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0 + TILE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tileRing.texture);
    gl.uniform1i(this.u.u_tiles, TILE_UNIT);

    gl.activeTexture(gl.TEXTURE0 + LUT_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.uniform1i(this.u.u_lut, LUT_UNIT);

    // Bind the SUM-mip levels (T7). With no mip chain the ring texture is bound
    // here as a valid, complete stand-in — the shader never samples it because
    // level selection is forced to 0 below (u_level == 0 → u_tiles only). A
    // chain whose FBO went incomplete (MipChain.usable === false) is treated the
    // same way: the exact level-0 path instead of sampling broken mips.
    const mips = this.mips !== null && !this.mips.usable ? null : this.mips;
    const mip1 = mips ? mips.tex1 : this.tileRing.texture;
    const mip2 = mips && mips.tex2 ? mips.tex2 : this.tileRing.texture;
    gl.activeTexture(gl.TEXTURE0 + MIP1_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, mip1);
    gl.uniform1i(this.u.u_mip1, MIP1_UNIT);
    gl.activeTexture(gl.TEXTURE0 + MIP2_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, mip2);
    gl.uniform1i(this.u.u_mip2, MIP2_UNIT);
    // Row-only chain (R2-M1). No chain → the ring texture is a valid stand-in;
    // u_rowOnly is forced to 0 below so it is never sampled (same honesty
    // fallback as the SUM levels).
    const rowMip = mips ? mips.texRow1 : this.tileRing.texture;
    gl.activeTexture(gl.TEXTURE0 + ROWMIP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, rowMip);
    gl.uniform1i(this.u.u_rowMip1, ROWMIP_UNIT);

    gl.uniform1f(this.u.u_colOffset, view.colOffset);
    gl.uniform1f(this.u.u_colScale, view.colScale);
    gl.uniform1f(this.u.u_rowOffset, view.rowOffset);
    gl.uniform1f(this.u.u_rowScale, view.rowScale);

    gl.uniform1i(this.u.u_capacityCols, this.tileRing.capacityCols);
    gl.uniform1i(this.u.u_colsPerTile, this.tileRing.colsPerTile);
    gl.uniform1i(this.u.u_rows, this.tileRing.rows);
    // The painting window is [validFrom, residentNewest]: the resident window's
    // left edge, advanced past any gap whose slots still hold previous columns
    // (gl/tileRing validFromSeq). With no residents, validFrom(1) > newest(0)
    // makes every column out-of-range.
    gl.uniform1i(
      this.u.u_validFrom,
      range ? Math.max(this.tileRing.validFromSeq(), range.oldest) : 1,
    );
    gl.uniform1i(this.u.u_residentNewest, range ? range.newest : 0);

    gl.uniform1f(this.u.u_decodeScale, this.encoding.decodeScale);
    gl.uniform1f(this.u.u_norm, this.encoding.norm);
    gl.uniform1f(this.u.u_gamma, this.gamma);
    gl.uniform1i(this.u.u_ramp, this.encoding.ramp);
    gl.uniform1i(this.u.u_channel, this.channel);

    // Rows AND columns collapsing into one device pixel drive the mip level
    // (§8.3): coarser level as either axis zooms out — the column half is what
    // keeps a time-zoomed-out + price-zoomed-in view from aliasing through the
    // level-0 blur. rowScale/colScale are uniforms and the buffer size is fixed,
    // so this is one selection for the whole frame — a constant the shader
    // branches on coherently. mip *generation* is incremental (append time);
    // mip *sampling* is ≤4 texelFetch per pixel, keeping the draw O(1) in
    // history. `mips` (not this.mips): an unusable chain must level-select to 0.
    const maxLevel = mips ? mips.maxLevel : 0;
    const rowsPerPixel = view.rowScale / Math.max(1, gl.drawingBufferHeight);
    const colsPerPixel = view.colScale / Math.max(1, gl.drawingBufferWidth);
    const sel = selectLevel(rowsPerPixel, maxLevel, colsPerPixel, this.levelFloor);
    // Row-mip cross-fade (lane P; see rowFadeFor/effectiveRowMode). The hard
    // row-mip threshold pops while zooming; instead the row-mip blend weight
    // ramps smoothly across the row-mip eligibility regime (sel.rowOnly:
    // rpp >= 2.5, deep time zoom, no tick-grouping floor), renormalized to 0 at
    // the regime edge so the switch has no step. Any fade > 0 uploads the
    // row-mip geometry explicitly — level 0 / 4-ROW block, taps = ceil(rpp/4)
    // (the row-mip texel is 4 rows tall) — because the shader's blend branch
    // ignores u_level for the row term. With `blk = 4` the pinned `/float(blk)`
    // × `if (u_rowOnly == 1) intensity *= float(blk)` pair cancels, so the mix
    // ramps raw 1-row sample → 4-row sum and both endpoints stay exact. The
    // floor below scales by the same `nRowTaps * blk` row footprint as every
    // other path. Ineligible frames (no usable chain, cpp zoomed out, forced
    // floor, rpp < 2.5) keep the legacy selection verbatim.
    const rowEligible = sel.rowOnly === true && mips !== null && mips.rowUsable;
    const rowFade = effectiveRowMode(rowsPerPixel, rowEligible).rowFade;
    // SUM-mip level cross-fade (wave P2; see levelBlendFor). The hard 4^k LOD
    // switch is a measured brightness pop; outside a transition band the blend
    // is pure: `fade <= 0` uploads sel verbatim, `fade === 1` uploads the
    // coarse level k (4^k / taps / floor identical to the old output AT the
    // switch point). Inside the band the shader mixes the finer level in via
    // u_levelFade / u_nRowTapsFine. The row path above never blends levels: it
    // owns the row axis (level 0 + 4-row sums), so the SUM blend is skipped
    // while it is active.
    let level: number;
    let blk: number;
    let nRowTaps: number;
    let levelFade = 0;
    let nRowTapsFine = 1;
    let finerLevel = -1;
    if (rowFade > 0) {
      level = 0;
      blk = 4;
      nRowTaps = Math.max(1, Math.min(4, Math.ceil(rowsPerPixel / 4)));
    } else {
      const fp = Math.max(rowsPerPixel, colsPerPixel);
      const blend = levelBlendFor(fp, maxLevel, this.levelFloor);
      if (blend.fade <= 0) {
        level = sel.level;
        blk = sel.blk;
        nRowTaps = sel.nRowTaps;
      } else {
        level = blend.level;
        blk = 4 ** level;
        nRowTaps = Math.max(1, Math.min(4, Math.ceil(rowsPerPixel / blk)));
        levelFade = blend.fade;
        nRowTapsFine = Math.max(1, Math.min(4, Math.ceil(rowsPerPixel / (blk / 4))));
        finerLevel = blend.finerLevel;
      }
    }
    gl.uniform1i(this.u.u_level, level);
    gl.uniform1i(this.u.u_blk, blk);
    gl.uniform1i(this.u.u_nRowTaps, nRowTaps);
    gl.uniform1f(this.u.u_levelFade, levelFade);
    gl.uniform1i(this.u.u_nRowTapsFine, nRowTapsFine);
    gl.uniform1i(this.u.u_rowOnly, rowFade > 0 ? 1 : 0);
    gl.uniform1f(this.u.u_rowFade, rowFade);

    // Scale-aware level-0 sampler mix (campaign 5, F4; see sampleMix). Always
    // uploaded, so the zoomed-out path stays EXACTLY the historical filter and
    // the deep-zoom path switches to crisp cells without a shader recompile.
    const mix = sampleMix(colsPerPixel);
    this.lastSample = {
      colsPerPixel,
      colBlur: mix.blur,
      colCell: mix.cell,
      rowFade,
      levelFade,
      finerLevel,
    };
    gl.uniform1f(this.u.u_colBlur, mix.blur);
    gl.uniform1f(this.u.u_colCell, mix.cell);

    // Scale the black point by the pixel's ROW footprint. `intensity` sums
    // nRowTaps rows of a blk-row block and divides only the COLUMN dimension by
    // blk, and normMipScale(level) is 1 by design (gl/normalize.ts) — so t grows
    // with price zoom-out and an unscaled floor would hide a different amount of
    // size at every zoom. Clamped below 1 so the re-expansion never degenerates.
    const floor = Math.min(
      TOLERANCE_MAX_FLOOR,
      Math.max(0, this.floor) * nRowTaps * blk,
    );
    gl.uniform1f(this.u.u_floor, floor);
    gl.uniform1f(this.u.u_floorScale, 1 / Math.max(1 - floor, 1e-6));

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    checkGLError(gl, 'Heatmap.draw');
  }

  /**
   * The level-0 sampler mix the LAST {@link draw} uploaded — `colsPerPixel`
   * plus the blur/cell weights (see {@link sampleMix}), the effective row-mip
   * cross-fade weight (see {@link effectiveRowMode}) and the SUM-mip level
   * cross-fade (see {@link levelBlendFor}; `finerLevel` is -1 whenever no
   * second sample exists). Defaults to the zoomed-out historical blur
   * `{ colsPerPixel: 1, colBlur: 1, colCell: 0, rowFade: 0, levelFade: 0,
   * finerLevel: -1 }` before the first draw. Diagnostics/tests only
   * (testHook.levelInfo).
   */
  sampleInfo(): {
    colsPerPixel: number;
    colBlur: number;
    colCell: number;
    rowFade: number;
    levelFade: number;
    finerLevel: number;
  } {
    return { ...this.lastSample };
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
