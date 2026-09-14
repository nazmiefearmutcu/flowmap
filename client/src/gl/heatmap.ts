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
import type { ViewportNormalizer } from './normalize';
import {
  DEFAULT_RECON_FLOOR_SCALE,
  reconFloorFor,
  RegionTracker,
  REGION_LIVE,
} from './regionFloor';
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
const REGION_UNIT = 5;

/**
 * Default perceptual display gamma (§8.3). Order-flow density is heavy-tailed:
 * the median active cell is a few percent of the viewport white point while
 * walls sit at 10-100×, so the below-knee exponent decides how much of the
 * faint field is visible at all.
 *
 * Wave 3 / F10 (2026-09-14, owner "hâlâ yarak gibi" = still too dark): with
 * DEFAULT_TOLERANCE = 0 the floor no longer hides faint cells, but F2 measured
 * that ~28pp of the newly-painted fill differed from background by ≤3 luma —
 * sub-perceptual on the frozen ramp head (#05080E). F10's frozen-BTC A/B
 * (runtime `setContrast` emulation, same data per condition; see
 * swarm2/F10.md §A/B) measured the below-knee lift as the only lever that
 * moves that band: at γ 0.86 the sub-3-luma share of the crop is 15.5pp and
 * the crop median is 20.0 luma; at γ 0.653 it is 3.5pp / 27.1 luma while the
 * wall band is untouched (knee p97 → LUT 217, white → 255, max luma 204 in
 * every state; gVar 104 → 96 = dilution from the joined mids, not wall
 * flattening). 0.653 = gammaForContrast(17) — the default slider position.
 *
 * The old 0.86 stays available on the Contrast slider (which reaches 1.4);
 * nothing else in the chain changed: f(0)=0 (background), f(knee)=lowSpan,
 * f(1)=1 (LUT 255) are still exact. Pinned equal to
 * gammaForContrast(DEFAULT_CONTRAST) by the tests.
 */
export const DEFAULT_DISPLAY_GAMMA = 0.653;

/**
 * Map a 0–100 "Contrast" slider to a display gamma. HIGHER contrast → HIGHER
 * gamma → a darker mid-field with punchier walls (more separation); LOWER
 * contrast → lower gamma → the field is lifted flat/bright (washed, less
 * separation). The default ({@link DEFAULT_CONTRAST}, 17) lands on 0.653 —
 * the wave-3 below-knee low-end lift (see {@link DEFAULT_DISPLAY_GAMMA}).
 * Clamped to the legible band [0.5, 1.4].
 */
export function gammaForContrast(contrast: number): number {
  const c = Math.min(100, Math.max(0, contrast));
  return 0.5 + (c / 100) * 0.9;
}

/** Slider position (0–100) whose gamma equals the default — the reset point. */
export const DEFAULT_CONTRAST = 17;

/**
 * Above-knee log-compression strength of the two-segment transfer curve
 * (Bookmap-class overhaul, lane F). `u_gamma` owns the below-knee lift; this
 * constant owns the upper segment: the wall band (p97..p99.7) no longer clamps
 * into the top few LUT entries but spreads across `log1p` space. Fixed (not a
 * user setting) — the Contrast slider keeps its single below-knee-gamma meaning.
 */
export const TRANSFER_LOG_SCALE = 6.0;

/**
 * Output span of the BELOW-knee transfer segment (calibration fix 2026-09-13,
 * owner report "heatmap buga girdi"). The knee sits at `p97 / p99.7` in
 * t-space — a SMALL fraction on heavy-tailed books (≈0.18 live BTC) — so a
 * curve whose below-knee segment ends at `k` capped ~97% of active cells at
 * LUT ≤ k·255 (≈45): the field read as black in recorded/scrollback regions
 * while only walls glowed. The below-knee segment now owns a FIXED output
 * share [0, lowSpan] (the mids stay visible under the gamma lift) and the
 * above-knee log compression owns the wall band [lowSpan, 1]. Both endpoints
 * stay exact (f(0)=0, f(1)=1); the segments meet continuously at the knee.
 */
export const TRANSFER_LOW_SPAN = 0.85;

/**
 * Knee fraction used when no {@link ViewportNormalizer} is attached (unit tests,
 * the synthetic e2e hook): `u_knee = 0.55`. With a normalizer attached the draw
 * uploads the live `knee / white` ratio (clamped [0.05, 0.95]) instead.
 */
export const DEFAULT_KNEE_FRACTION = 0.55;

/** Clamp the per-frame knee fraction into the legible, division-safe band. */
function clampKneeFraction(v: number): number {
  return Math.min(0.95, Math.max(0.05, Number.isFinite(v) ? v : DEFAULT_KNEE_FRACTION));
}

/**
 * The two-segment transfer curve (Bookmap-class overhaul) — the TS mirror of
 * the fragment shader's post-floor mapping, for tests:
 *
 *   t <= k : t = S * pow(t / k, gamma)                              // lift, span S
 *   t >  k : t = S + (1-S) * log(1 + L*(t-k)/(1-k)) / log(1 + L)    // wall compress
 *
 * `S = lowSpan` (default {@link TRANSFER_LOW_SPAN}) is the output share the
 * below-knee segment owns — see the constant's docblock for why fixing it at
 * `k` (the original lane-F formula) crushed the heavy-tail mid-field to black.
 * Endpoints are exact (f(0) = 0 → background, f(1) = 1 → LUT 255) and the two
 * segments meet continuously at the knee (both equal `S`). Gaussian-free, pure.
 */
export function transferCurve(
  t: number,
  {
    knee,
    gamma,
    logScale,
    lowSpan,
  }: { knee: number; gamma: number; logScale: number; lowSpan?: number },
): number {
  const tc = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  const k = Number.isFinite(knee)
    ? Math.min(0.999999, Math.max(0.000001, knee))
    : DEFAULT_KNEE_FRACTION;
  const g = Number.isFinite(gamma) ? Math.max(1e-6, gamma) : 1;
  const L = Number.isFinite(logScale) && logScale > 0 ? logScale : TRANSFER_LOG_SCALE;
  const S =
    typeof lowSpan === 'number' && Number.isFinite(lowSpan) && lowSpan > 0 && lowSpan < 1
      ? lowSpan
      : TRANSFER_LOW_SPAN;
  if (tc <= k) return S * Math.pow(tc / k, g);
  return S + (1 - S) * (Math.log1p((L * (tc - k)) / (1 - k)) / Math.log1p(L));
}

/**
 * Largest black point the Tolerance slider can reach. Raised from 0.5 to 0.85 so
 * the control has real reach — at the top of the slider it hides sub-threshold
 * density up to 85% of the white point, cutting a genuinely noisy field down to
 * just the walls. Still capped well below 1: at `floor → 1` the `1/(1-floor)`
 * re-expansion (scale = 6.67× here) degenerates and even the white percentile
 * maps to LUT entry 0 — a black screen — which would break the "both endpoints
 * stay fixed" promise rather than implement it.
 */
export const TOLERANCE_MAX_FLOOR = 0.85;

/** Curve exponent for the slider → floor map. Between linear (1) and the old
 *  square (2): eased enough to keep fine control at the low end, but with real
 *  bite through the mid-slider where the field actually gets cleaned up. */
export const TOLERANCE_CURVE = 1.4;

/**
 * Default Tolerance slider position. Wave 3 / F10 (2026-09-14): 5 → 0.
 *
 * History: 15 (floor ≈ 0.060) was the "empty heatmap" default and read black
 * out of the box; 5 (floor ≈ 0.013 × the row footprint) cut ≈56% of active
 * cells on the heavy-tail model. F2's display-policy A/B (frozen BTC window,
 * same data across conditions) measured that even 5 leaves the field
 * discontinuous: with the floor at 0 the rows carrying ink went 59.2% → 98.6%
 * and non-background pixels 45.2% → 95.6% (void 54.8% → 4.4%) — the only
 * candidate that reaches the Bookmap continuity target (D3-C1: no cell that
 * has data may render background). The isolated-speck count DROPPED (5 → 1
 * component; the faint cells connect instead of dotting), and the wall band is
 * untouched (knee/white outputs and max luma unchanged). The one honest cost —
 * the added faint fill needs low-end brightness to be legible — is carried by
 * {@link DEFAULT_DISPLAY_GAMMA}'s below-knee lift, not by this slider.
 *
 * Slider 0 is (and always was) an exact algebraic no-op: floor 0 keeps the
 * shader's remap the identity. Existing installs persist their stored
 * tolerance; pushing the new default to them needs a settings migration
 * (flagged in swarm2/F10.md — settings.ts is outside this lane).
 */
export const DEFAULT_TOLERANCE = 0;

/**
 * Map a 0–100 "Tolerance" slider to the shader's black point.
 *
 * Eased (exponent {@link TOLERANCE_CURVE}), not linear, because the useful floors
 * are small: order-flow density is heavy-tailed, so a floor around 1–2% of the
 * white point separates the real ladder from the specks without hiding the field
 * (a cell needs that fraction of the white point to paint at all). The default
 * is now 0 — the F2-measured continuity endpoint (see {@link DEFAULT_TOLERANCE});
 * the eased curve still gives fine control when a denoise IS wanted, reaching
 * the cap at 100.
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
 * `selectLevel`/`Heatmap.draw` row-mip threshold (rpp >= 1.5) — the row-mip
 * eligibility edge. Wave 3 / F10: 2.5 → 1.5 to close D4's 2.0–2.5 barcode zone
 * with the row-mip chain's DENSE Gaussian kernel (the level-0 triple is
 * structurally sparse — its ±dy taps do not overlap an isolated single-row
 * level when dy > 1 row; D4 measured 98% sub-3-px edges at rpp 2.07).
 */
const ROW_MIP_EDGE = 1.5;

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
  // Row-only decoupling (campaign visual 2026-09-11, R2-M1): the ROW axis alone
  // needs 4-row grouping (at rpp >= {@link ROW_MIP_EDGE}), and when the time
  // axis is NOT zoomed out (cpp < 1.5) that grouping is done WITHOUT the
  // 4-column averaging the 4x4 SUM mip applies — the owner's scrolled-back /
  // reconstructed regime (rpp 3.05, cpp < 1) keeps crisp cell edges instead of
  // 4-column blocks. The flag is additive: level/blk stay the historical
  // SUM-path fields so every pre-existing consumer output is unchanged, and the
  // draw derives the actual row-mip taps (blk 4) itself. A tick-grouping floor
  // keeps the forced SUM path (the floor is an explicit user choice of block
  // size).
  //
  // Wave 3 / F10 (D4 zones): the edge moved 2.5 → {@link ROW_MIP_EDGE} (1.5).
  // D4 measured that one wheel notch in from the default (rpp 2.07) landed in a
  // barcode dead zone — the rowFade renormalization zeroed the row-mip path
  // exactly through [2.0, 2.5] while the level-0 triple at dy 4.55 rows paints
  // isolated levels as three sparse hairlines instead of a band. The row-mip
  // chain IS the dense kernel; engaging it from 1.5 with a continuous weight
  // (see rowFadeFor) removes the cliff.
  const rowOnly = rpp >= ROW_MIP_EDGE && cpp < 1.5 && floorLevel === 0;
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
 * Gaussian field-sampler law (Bookmap-class overhaul, lane F; replaces the
 * crisp/3-tap-blur cross-fade). The historical kernel was either a fixed
 * 3-column blur (sub-pixel columns) or hard nearest-cell sampling (deep zoom);
 * both produced artifacts at their opposite ends (confetti vs 40–200 px
 * smear/step aliasing). The new sampler is one width-scaled Gaussian on the
 * TIME axis, `sigma` pinned in SCREEN pixels:
 *
 *   sigmaCols = clamp(SMOOTH_SIGMA_PX * colsPerPixel · dpr, 0.12, 2.0)
 *   taps      = 9 (offsets −4..+4) when sigmaCols > 0.12, else 1 (pure bilinear)
 *
 * so the edge response stays ~`2.563 * 2.5 ≈ 6.4 px` (10–90) at deep zoom and
 * only sharpens as columns become sub-pixel (the 2.0-column cap). The vertical
 * axis is untouched — price stays crisp. Non-finite input degrades to the
 * minimum plan (single bilinear tap).
 *
 * F14 §L2 DPR portability (wave 4, 2026-09-14): the screen pixel here is a
 * **CSS pixel**, NOT a framebuffer pixel. The caller ({@link Heatmap.draw})
 * converts the framebuffer-denominated footprints to CSS px with the
 * device-pixel ratio (`colsPerPixel = colScale / drawingBufferWidth · dpr` /
 * `rowsPerPixel · dpr`) BEFORE applying any law, so a retina panel renders the
 * same CSS edge widths as DPR1 instead of a ~2× harder field (at DPR2 the
 * un-scaled law measured 1-tap barcodes, 96–98% sub-3-px hairlines). DPR1 is
 * byte-identical: the ratio reads exactly 1 there.
 */
export const SMOOTH_SIGMA_PX = 2.5;
/** Odd tap budget baked into the GLSL loop bound (offsets −4..+4). */
export const SMOOTH_MAX_TAPS = 9;
/** Sigma floor in column units — guards the div-by-zero / one-column smear. */
const SMOOTH_SIGMA_COLS_MIN = 0.12;
/** Sigma ceiling in column units — beyond this the edge smears multi-cell. */
const SMOOTH_SIGMA_COLS_MAX = 2.0;
/**
 * Tap-count tiers (perf calibration, lane F): the frame uploads only the taps
 * whose Gaussian weight is non-negligible at its sigma — the full 9-tap table
 * failed the SwiftShader p10 draw gate (33.7 ms). Boundaries in COLUMN units:
 * σ ≤ 0.35 → 1 tap, ≤ 0.75 → 3, ≤ 1.25 → 5, else 9. HONESTY (review R1-M1):
 * these are ±1.3–1.6σ truncations, so the effective second moment is NOT
 * preserved — measured σ_eff shifts ~11–13% downward at tier boundaries
 * (0.35→0.18, 0.75→0.67, 1.25→1.11). The tiers are a perf trade, not a claim
 * of sigma preservation; the visual acceptance bars (smooth-zoom spec) are
 * the arbiter.
 */
const SMOOTH_TAPS_TIERS: readonly { maxSigma: number; taps: number }[] = [
  { maxSigma: 0.35, taps: 1 },
  { maxSigma: 0.75, taps: 3 },
  { maxSigma: 1.25, taps: 5 },
  { maxSigma: Number.POSITIVE_INFINITY, taps: 9 },
];

export interface SmoothPlan {
  /** Gaussian sigma in COLUMN units (never 0 — 1-tap plans keep the min). */
  sigmaCols: number;
  /** Odd tap count, one of 1/3/5/9, ≤ {@link SMOOTH_MAX_TAPS}. */
  taps: number;
}

/**
 * Map the time-axis footprint (`colsPerPixel`, SCREEN = CSS pixels — the
 * caller scales the framebuffer footprint by the device-pixel ratio, see
 * {@link SMOOTH_SIGMA_PX} / F14 §L2) to the frame's sampler plan. Pure and
 * monotone in `colsPerPixel`; non-finite input (and negatives) degrade to the
 * minimum plan. `taps` follows the tier table above; the truncation is honest
 * about its cost (see {@link SMOOTH_TAPS_TIERS} — effective σ shifts ≲13%
 * downward at tier boundaries, a perf trade whose result the smooth-zoom
 * pixel bars enforce). In CSS units the plan is DPR-invariant:
 * `smoothPlanFor(cpp_fb · dpr)` is the same plan at every DPR for the same
 * CSS framing.
 */
export function smoothPlanFor(colsPerPixel: number): SmoothPlan {
  const cpp = Number.isFinite(colsPerPixel) ? Math.max(0, colsPerPixel) : 0;
  const sigmaCols = Math.min(
    SMOOTH_SIGMA_COLS_MAX,
    Math.max(SMOOTH_SIGMA_COLS_MIN, SMOOTH_SIGMA_PX * cpp),
  );
  let taps = SMOOTH_MAX_TAPS;
  for (const tier of SMOOTH_TAPS_TIERS) {
    if (sigmaCols <= tier.maxSigma) {
      taps = tier.taps;
      break;
    }
  }
  return { sigmaCols, taps };
}

/** Vertical softening target in SCREEN (CSS) pixels (barcode fix, 2026-09-13). */
export const SMOOTH_ROW_SIGMA_PX = 2.2;
/**
 * Cap on the total vertical blend band in SCREEN (CSS) pixels (barcode fix
 * wave 2, 2026-09-14). The triple spans ±dy rows → `2·dy / rowsPerPixel`
 * screen px; the pixel-denominated dy already bounds that at `2·sigma_px` =
 * 4.4 px. The cap is the guard for a future sigma raise (and documents the
 * ≤10 px acceptance bound) — it never binds at the shipped 2.2 px sigma.
 */
export const SMOOTH_ROW_BAND_MAX_PX = 10;

/**
 * Vertical (price-axis) softening offset in ROW units for a draw — the
 * barcode killer (owner: "barkod görünüm var hala default olarak"; wave-2
 * mandate 2026-09-14). A live book concentrates liquidity on single price
 * ROWS; the rows-per-pixel at the DEFAULT book zoom is ~3, so each level
 * paints as a hard 1-px hairline. The shader blends a 0.25/0.5/0.25 triple at
 * ±dy rows around each sample, turning each level into a soft band (the
 * Bookmap look).
 *
 * dy is PIXEL-denominated and ACTIVE at every zoom: `dy = sigma_px ·
 * rowsPerPixel · dpr` makes ±dy a constant ~{@link SMOOTH_ROW_SIGMA_PX} CSS
 * px worth of rows (a level spreads over ~2·sigma_px px, edge 10–90 ≈ 4 px —
 * soft, never a hairline, under the mush bar). The old `rpp >= 2 → 0` cutoff
 * made the mechanism inert EXACTLY at the default (rpp ≈ 3) — the field
 * stayed a barcode; the cutoff is gone. The only 0 endpoint left is
 * non-finite / non-positive input (legacy single-sample path for a poisoned
 * view). The shader applies this triple in BOTH display paths: the level-0
 * field (`fieldAt`) and the deep-row mip fetch (`rowMipSoft`, converted to
 * 4-row texel units by the draw's `* 0.25`), so the default view — which
 * rides the row-mip path — is softened too.
 *
 * `rowsPerPixel` is in SCREEN = CSS pixels (the caller scales the
 * framebuffer footprint by the device-pixel ratio, see {@link SMOOTH_SIGMA_PX}
 * / F14 §L2), so at DPR2 the kernel covers twice the ROWS for the same CSS
 * framing and the band measures the same CSS px. DPR1 is byte-identical.
 */
export function rowSmoothDyFor(rowsPerPixel: number): number {
  if (!Number.isFinite(rowsPerPixel) || rowsPerPixel <= 0) return 0;
  const dyRows = SMOOTH_ROW_SIGMA_PX * rowsPerPixel;
  const capRows = (SMOOTH_ROW_BAND_MAX_PX / 2) * rowsPerPixel;
  return Math.min(dyRows, capRows);
}

/** Deep-row softening enable (see {@link rowMipSoftenFor}) — 1 mip-row step. */
export const SMOOTH_ROW_MIP_DY = 1;

/**
 * CPU Gaussian tap table for a plan: `taps` symmetric offsets centered on 0
 * (so the shader's fixed `for t < u_smoothTaps` loop reads the CENTERED
 * subset) and `exp(-0.5 * (off / sigma)^2)` weights, normalized to sum 1 here
 * — the shader re-normalizes over the VALID taps only, so window edges fold
 * to the core. Uploaded as uniforms (padded to 9): no per-fragment `exp`
 * (driver determinism across SwiftShader/GPU).
 */
function gaussianTaps(
  sigmaCols: number,
  taps: number,
): { offsets: Float32Array; weights: Float32Array } {
  const offsets = new Float32Array(SMOOTH_MAX_TAPS);
  const weights = new Float32Array(SMOOTH_MAX_TAPS);
  const count = Math.max(1, Math.min(SMOOTH_MAX_TAPS, Math.round(taps)));
  const half = (count - 1) / 2;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const off = i - half;
    const rel = off / sigmaCols;
    const w = Math.exp(-0.5 * rel * rel);
    offsets[i] = off;
    weights[i] = w;
    sum += w;
  }
  for (let i = 0; i < count; i++) weights[i] /= sum;
  return { offsets, weights };
}

/**
 * Row-mip cross-fade weight (resolution-transition polish, lane P; wave-3
 * edge moved to {@link ROW_MIP_EDGE} by F10 per D4's zone map).
 *
 * The historical row LOD switch was a hard threshold: rpp < 2.5 sampled the
 * level-0 single-row bilinear, rpp >= 2.5 sampled the 4-row-sum mip — a
 * measured brightness/pop spike in the zoom ladder through rpp 2.4–3.9 (the
 * band where row aggregation flips). This ramps the handoff instead:
 *
 *   - rpp <= 1.5  → 0 (pure level-0 rows, EXACT legacy output)
 *   - rpp >= 2.5  → 1 (pure row-mip sums, EXACT post-4.1 output)
 *   - in between  → linear (rpp−1.5)/1.0
 *
 * The lower edge is the F10 coverage extension (D4 zones: "2.0–2.5 rowFade
 * renormalization cliff" and "0.70–2.0 the pixel triple misses the feature").
 * At the old [2.0, 3.0] ramp the renormalization zeroed the row-mip weight
 * through [2.0, 2.5], so one wheel notch in from the default (rpp 2.07) rode
 * the SPARSE level-0 triple (dy 4.55 rows → three disconnected hairlines);
 * D4 measured 98% sub-3-px edges there. Ramping from 1.5 gives that zone a
 * real row-mip share (2.07 → 0.57) while the DEFAULT keeps the completed
 * handoff F1 calibrated (rpp ≥ 2.5 → pure row-mip). Both endpoints stay exact:
 * 1.5 → 0 is the legacy level-0 sample, 2.5 → 1 is the full row path.
 *
 * Non-finite input degrades to 0 (the legacy level-0 path) rather than
 * poisoning the blend weight. NOTE the DRAW applies this only inside the
 * row-mip eligibility regime — see {@link effectiveRowMode}, which is the
 * single source of truth for the uploaded weight.
 */
export function rowFadeFor(rowsPerPixel: number): number {
  if (!Number.isFinite(rowsPerPixel) || rowsPerPixel <= ROW_MIP_EDGE) return 0;
  if (rowsPerPixel >= 2.5) return 1;
  // Linear ramp (see levelBlendFor): uniform weight deltas minimize the max
  // per-step pop; the edge is exact (knee = rowFadeFor(ROW_MIP_EDGE) = 0, so
  // effectiveRowMode's renormalization is the identity).
  return (rowsPerPixel - ROW_MIP_EDGE) / (2.5 - ROW_MIP_EDGE);
}

/**
 * The draw-side effective row mode for a frame — the SINGLE source of truth for
 * `{rowOnly, rowFade}`. `Heatmap.draw` and `testHook.levelInfo` both call this,
 * so the reported selection can never drift from the painted one.
 *
 * Eligibility (`rowEligible`) is `selectLevel`'s `rowOnly` regime: rpp >=
 * {@link ROW_MIP_EDGE}, a deep time zoom, and no tick-grouping floor. Outside
 * it the time-zoomed-out SUM path, a forced tick-grouping floor, and the
 * rpp < ROW_MIP_EDGE level-0 path keep their exact historical output. Inside
 * the regime the weight from {@link rowFadeFor} is renormalized against the
 * edge knee — with the edge at 1.5 that knee is exactly 0, so the ramp is
 * continuous from the legacy level-0 sample (fade 0) to the full row path
 * (fade 1 at rpp 2.5) with no step at either end.
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

/**
 * Deep-row softening enable for a draw (barcode fix, 2026-09-13; wave-2
 * 2026-09-14 composes it with {@link rowSmoothDyFor}). When the price axis
 * collapses rows into sub-pixel footprints (the row-mip regime, rpp >=
 * {@link ROW_MIP_EDGE} — the same edge {@link effectiveRowMode} uses), a single
 * price level paints as a ~1-px hairline at the DEFAULT book zoom (rpp ~3): the
 * owner's "barkod" look. The shader then blends each 4-row mip texel with its
 * MIP-row neighbours, and — since wave 2 — wraps that fetch in the SAME
 * pixel-denominated 0.25/0.5/0.25 triple the level-0 field uses (`rowMipSoft`
 * in the shader, offset = `rowSmoothDyFor(rpp) / 4` mip texels). Without the
 * triple the isolated-wall exemption kept exactly the single-level spikes
 * crisp, which is what defeated the first fix at the default. Returns exactly
 * 0 outside the regime so the historical single-fetch row path stays
 * byte-exact.
 */
export function rowMipSoftenFor(rowsPerPixel: number): number {
  if (!Number.isFinite(rowsPerPixel)) return 0;
  return rowsPerPixel >= ROW_MIP_EDGE ? SMOOTH_ROW_MIP_DY : 0;
}

/** Deep-row Gaussian target in SCREEN (CSS) pixels (barcode fix, 2026-09-13). */
export const SMOOTH_ROW_MIP_SIGMA_PX = 2.0;
/** Deep-row Gaussian tap count (offsets -3..3 in 4-row mip texels). */
export const SMOOTH_ROW_MIP_TAPS = 7;

/**
 * The deep-row Gaussian weights for a draw — the vertical counterpart of
 * {@link smoothPlanFor}'s column kernel. Taps sit on integer 4-row mip texels
 * (offset -3..3); the Gaussian sigma is pinned in SCREEN (CSS) pixels and
 * converted to texel units by `SMOOTH_ROW_MIP_SIGMA_PX · rpp / 4` (one mip
 * texel = 4 rows), clamped to [0.4, 2.5] texels so the kernel stays inside the
 * 7-tap support at both ends of the regime. Normalized to sum 1 (edge taps
 * clamp to the grid edge in the shader). At the rpp ~3.05 default zoom sigma ≈
 * 1.2 texels → a ~5 px soft band with a smooth falloff (the shader
 * reconstructs between texels bilinearly), replacing the hard 1-px hairline
 * the owner reported.
 *
 * `rowsPerPixel` is in SCREEN = CSS pixels (same convention as
 * {@link rowSmoothDyFor}); the caller scales the framebuffer footprint by the
 * device-pixel ratio (F14 §L2), so the same CSS framing gets the same texel
 * sigma at every DPR. DPR1 is byte-identical.
 */
export function rowMipWeightsFor(rowsPerPixel: number): Float32Array {
  const w = new Float32Array(SMOOTH_ROW_MIP_TAPS);
  const half = (SMOOTH_ROW_MIP_TAPS - 1) / 2;
  const rpp = Number.isFinite(rowsPerPixel) ? Math.max(1e-6, rowsPerPixel) : 1;
  const sigmaTexels = Math.min(2.5, Math.max(0.4, (SMOOTH_ROW_MIP_SIGMA_PX * rpp) / 4));
  let sum = 0;
  for (let i = 0; i < SMOOTH_ROW_MIP_TAPS; i++) {
    const off = (i - half) / sigmaTexels;
    const val = Math.exp(-0.5 * off * off);
    w[i] = val;
    sum += val;
  }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  return w;
}

/**
 * Device-pixel ratio the softness/selection footprints are denominated against
 * (F14 §L2 handoff, wave 4 / F20). The renderer sizes the drawing buffer as
 * `round(cssWidth · window.devicePixelRatio)` (renderer.ts `resize()` — the
 * same source as the overlay gutters' `ctx.dpr`), so this is the exact ratio
 * between the framebuffer and CSS spaces the view math divides by. The draw
 * multiplies the framebuffer footprints (`rowsPerPixel`, `colsPerPixel`) by
 * this ratio before any law or LOD selection runs. A missing/poisoned value
 * degrades to 1 (DPR1, the calibrated and byte-pinned state).
 */
function drawingDpr(): number {
  if (typeof window === 'undefined') return 1;
  const ratio = window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
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

/**
 * Upload a float uniform array. Real WebGL2 contexts always expose
 * `uniform1fv`; the optional-call guard lets the jsdom FakeGL (which predates
 * array uniforms) degrade to a no-op instead of throwing mid-draw.
 */
function uploadFloatArray(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation | null,
  data: Float32Array,
): void {
  const fn = (
    gl as unknown as {
      uniform1fv?: (loc: WebGLUniformLocation | null, v: Float32Array) => void;
    }
  ).uniform1fv;
  if (typeof fn === 'function') fn.call(gl, location, data);
}

type UniformName =
  | 'u_tiles'
  | 'u_mip1'
  | 'u_mip2'
  | 'u_rowMip1'
  | 'u_lut'
  | 'u_region'
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
  | 'u_floorRecon'
  | 'u_floorScaleRecon'
  | 'u_ramp'
  | 'u_channel'
  | 'u_level'
  | 'u_blk'
  | 'u_nRowTaps'
  | 'u_levelFade'
  | 'u_nRowTapsFine'
  | 'u_rowOnly'
  | 'u_rowFade'
  | 'u_knee'
  | 'u_logScale'
  | 'u_lowSpan'
  | 'u_smoothTaps'
  | 'u_smoothOffsets'
  | 'u_smoothWeights'
  | 'u_rowSmoothDy'
  | 'u_rowMipSoften'
  | 'u_rowMipWeights';

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
   * Knee fraction uploaded when {@link normalizer} is NOT attached (unit tests,
   * synthetic e2e hook): {@link DEFAULT_KNEE_FRACTION}. With a normalizer
   * attached the draw computes `clamp(knee/white, 0.05, 0.95)` from the live
   * EMA pair instead (Bookmap-class overhaul, lane F).
   */
  knee = DEFAULT_KNEE_FRACTION;

  /**
   * Output span of the below-knee transfer segment (calibration fix
   * 2026-09-13): {@link TRANSFER_LOW_SPAN}. A per-Heatmap field so tests can
   * pin the upload without reaching into the shader constant.
   */
  lowSpan = TRANSFER_LOW_SPAN;

  /**
   * Optional viewport normalizer attachment (lane F): when set, the draw reads
   * `currentPercentiles` (the same EMA the renderer feeds `u_norm`) for the
   * per-frame `u_knee = clamp(knee/white, 0.05, 0.95)`. The renderer wires this
   * on creation; without it the {@link knee} fallback is used.
   */
  normalizer: ViewportNormalizer | null = null;

  /**
   * Per-REGION black point (lane F17; D5 lever L1, owner's scrollback
   * complaint). The shipped Tolerance floor is calibrated on the LIVE book;
   * reconstructed (stretched-candle) columns carry a different density scale
   * (measured recon/live ≈ 0.5× on BTC but ≈26× on ETH), so one global floor
   * hides the recon carpet. Columns tagged {@link RegionTracker} as reconstructed
   * get `floor × reconFloorScale` instead — a RELATIVE cut (same t-space as the
   * live floor), never an absolute brightness lift. 1 = inert: every column
   * (tagged or not) paints with the exact shipped live floor. Live columns stay
   * byte-identical for any value: untagged/stale slots resolve to REGION_LIVE.
   */
  reconFloorScale = DEFAULT_RECON_FLOOR_SCALE;

  /**
   * Per-column region tags in ring-slot space (pure; see gl/regionFloor.ts).
   * The caller (renderer / e2e harness) classifies columns and calls
   * `regions.mark`/`markRange` — the next draw uploads the changed mask as ONE
   * RGBA8 array texture (colsPerTile × 1 × layers, `r` byte = 255 for recon).
   * Nothing marked → the mask is all zero and the shader selects the live floor
   * for every fragment (bit-identical to the pre-region pipeline).
   */
  readonly regions: RegionTracker;

  private readonly regionTex: WebGLTexture;
  /** Interleaved RGBA upload mirror for {@link regionTex} (slot-indexed tags). */
  private readonly regionTexData: Uint8Array;
  /** Tag revision last uploaded to {@link regionTex} (-1 = never). */
  private regionRevApplied = -1;

  /** Uploaded region floors from the last draw (diagnostics/tests). */
  private lastRegion = { floorRecon: 0, floorScaleRecon: 1, reconColumns: 0 };

  /**
   * Gaussian sampler + cross-fade diagnostics from the LAST {@link draw} (lane
   * F): the time-axis footprint, the sampler plan, and the row/level fade
   * weights that were uploaded. Defaults to the plan at `colsPerPixel = 1`
   * before the first draw.
   */
  private lastSample = {
    colsPerPixel: 1,
    smoothSigma: smoothPlanFor(1).sigmaCols,
    smoothTaps: smoothPlanFor(1).taps,
    rowDy: 0,
    rowMipSoften: 0,
    rowMipSigma: 0,
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

    // Per-region mask (lane F17): one RGBA8 texel per COLUMN in ring-slot space
    // (colsPerTile × 1 × layers), red byte 0 = live / 255 = reconstructed. Kept
    // zero-initialized (immutable storage zero-fills) so the default pipeline is
    // the exact pre-region one. Re-uploaded as ONE texSubImage3D when the
    // RegionTracker revision changes (see draw) — never per fragment.
    this.regions = new RegionTracker(tileRing.capacityCols);
    this.regionTexData = new Uint8Array(tileRing.capacityCols * 4);
    const regionTex = gl.createTexture();
    if (!regionTex) throw new Error('flowmap/heatmap: region texture alloc failed');
    this.regionTex = regionTex;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, regionTex);
    gl.texStorage3D(
      gl.TEXTURE_2D_ARRAY,
      1,
      gl.RGBA8,
      tileRing.colsPerTile,
      1,
      tileRing.layers,
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

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

    const loc = (n: string) => gl.getUniformLocation(this.program, n);
    this.u = {
      u_tiles: loc('u_tiles'),
      u_mip1: loc('u_mip1'),
      u_mip2: loc('u_mip2'),
      u_rowMip1: loc('u_rowMip1'),
      u_lut: loc('u_lut'),
      u_region: loc('u_region'),
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
      u_floorRecon: loc('u_floorRecon'),
      u_floorScaleRecon: loc('u_floorScaleRecon'),
      u_ramp: loc('u_ramp'),
      u_channel: loc('u_channel'),
      u_level: loc('u_level'),
      u_blk: loc('u_blk'),
      u_nRowTaps: loc('u_nRowTaps'),
      u_levelFade: loc('u_levelFade'),
      u_nRowTapsFine: loc('u_nRowTapsFine'),
      u_rowOnly: loc('u_rowOnly'),
      u_rowFade: loc('u_rowFade'),
      u_knee: loc('u_knee'),
      u_logScale: loc('u_logScale'),
      u_lowSpan: loc('u_lowSpan'),
      u_smoothTaps: loc('u_smoothTaps'),
      u_smoothOffsets: loc('u_smoothOffsets[0]'),
      u_smoothWeights: loc('u_smoothWeights[0]'),
      u_rowSmoothDy: loc('u_rowSmoothDy'),
      u_rowMipSoften: loc('u_rowMipSoften'),
      u_rowMipWeights: loc('u_rowMipWeights[0]'),
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

    // Per-region mask (lane F17): one RGBA8 texel per ring column. Bound every
    // draw; re-uploaded as a single texSubImage3D only when the tag revision
    // moved, so the steady-state cost is a bind + a uniform.
    gl.activeTexture(gl.TEXTURE0 + REGION_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.regionTex);
    gl.uniform1i(this.u.u_region, REGION_UNIT);
    if (this.regionRevApplied !== this.regions.revision) {
      this.uploadRegions();
      this.regionRevApplied = this.regions.revision;
    }

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
    // Two-segment transfer curve (lane F; low-span calibrated 2026-09-13): the
    // knee fraction comes from the normalizer's EMA pair when attached (the
    // SAME merged CDF the renderer feeds `u_norm` from), else the module-default
    // fallback. `u_lowSpan` fixes how much of the ramp the below-knee segment
    // owns (heavy-tail mid-field must not be capped at the knee fraction).
    const pcts = this.normalizer !== null ? this.normalizer.currentPercentiles : null;
    const kneeFraction =
      pcts !== null && Number.isFinite(pcts.white) && pcts.white > 0
        ? clampKneeFraction(pcts.knee / pcts.white)
        : clampKneeFraction(this.knee);
    gl.uniform1f(this.u.u_knee, kneeFraction);
    gl.uniform1f(this.u.u_logScale, TRANSFER_LOG_SCALE);
    gl.uniform1f(this.u.u_lowSpan, this.lowSpan);
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
    // CSS-px denomination (F14 §L2, wave 4 / F20): every softness kernel AND
    // the row-axis LOD regime below is defined in SCREEN = CSS pixels. The
    // framebuffer footprints are scaled by the device-pixel ratio here (the
    // CPU scale factor) so a retina panel renders the SAME CSS softness as
    // DPR1 — without this, DPR2 halved both footprints: the column Gaussian
    // fell to the 1-tap tier and rpp 1.525 disabled the row-mip regime, so the
    // default view painted a 96–98% sub-3-px-px barcode (measured, F20).
    // DPR1 reads exactly 1 — the calibrated output is byte-identical — and the
    // SELECTION inputs (selectLevel/levelBlendFor/effectiveRowMode) now ride
    // the same CSS quantities, so the same CSS view picks the same level and
    // row regime at every DPR.
    const dpr = drawingDpr();
    const rppCss = rowsPerPixel * dpr;
    const cppCss = colsPerPixel * dpr;
    const sel = selectLevel(rppCss, maxLevel, cppCss, this.levelFloor);
    // Row-mip cross-fade (lane P; see rowFadeFor/effectiveRowMode). The hard
    // row-mip threshold pops while zooming; instead the row-mip blend weight
    // ramps smoothly across the row-mip eligibility regime (sel.rowOnly:
    // rpp >= 1.5, deep time zoom, no tick-grouping floor), renormalized to 0 at
    // the regime edge so the switch has no step. Any fade > 0 uploads the
    // row-mip geometry explicitly — level 0 / 4-ROW block, taps = ceil(rpp/4)
    // (the row-mip texel is 4 rows tall) — because the shader's blend branch
    // ignores u_level for the row term. With `blk = 4` the pinned `/float(blk)`
    // × `if (u_rowOnly == 1) intensity *= float(blk)` pair cancels, so the mix
    // ramps raw 1-row sample → 4-row sum and both endpoints stay exact. The
    // floor below scales by the same `nRowTaps * blk` row footprint as every
    // other path. Ineligible frames (no usable chain, cpp zoomed out, forced
    // floor, rpp < 1.5) keep the legacy selection verbatim.
    const rowEligible = sel.rowOnly === true && mips !== null && mips.rowUsable;
    const rowFade = effectiveRowMode(rppCss, rowEligible).rowFade;
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
      nRowTaps = Math.max(1, Math.min(4, Math.ceil(rppCss / 4)));
    } else {
      const fp = Math.max(rppCss, cppCss);
      const blend = levelBlendFor(fp, maxLevel, this.levelFloor);
      if (blend.fade <= 0) {
        level = sel.level;
        blk = sel.blk;
        nRowTaps = sel.nRowTaps;
      } else {
        level = blend.level;
        blk = 4 ** level;
        nRowTaps = Math.max(1, Math.min(4, Math.ceil(rppCss / blk)));
        levelFade = blend.fade;
        nRowTapsFine = Math.max(1, Math.min(4, Math.ceil(rppCss / (blk / 4))));
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

    // Gaussian field sampler (lane F; see smoothPlanFor): one width-scaled
    // kernel on the TIME axis, per-draw constants (sigma/weights computed here,
    // no per-fragment exp). The plan covers the whole zoom range coherently —
    // no recompile, no crisp/blur handoff.
    const plan = smoothPlanFor(cppCss);
    const taps = gaussianTaps(plan.sigmaCols, plan.taps);
    // Vertical softening (barcode fix; wave 2: pixel-denominated, active at
    // every zoom; F14 §L2: CSS-denominated via `rppCss`) — see rowSmoothDyFor.
    // 0 only for a poisoned view; the shader now applies this triple in BOTH
    // the level-0 field and the deep-row mip fetch (the latter via
    // `u_rowSmoothDy * 0.25`), so the DEFAULT view — which rides the row-mip
    // path — is softened too.
    const rowDy = rowSmoothDyFor(rppCss);
    // Deep-row softening (barcode fix): 1 inside the row-mip regime so the
    // 4-row texel fetch gains the vertical Gaussian (see rowMipWeightsFor /
    // rowMipSoftenFor) wrapped in the rowSmoothDyFor triple. Only the row-mip
    // branches read it; 0 keeps their exact historical single-fetch output.
    const rowMipSoften = rowMipSoftenFor(rppCss);
    const rowMipWeights = rowMipWeightsFor(rppCss);
    const rowMipSigma = rowMipSoften > 0 ? (SMOOTH_ROW_MIP_SIGMA_PX * rppCss) / 4 : 0;
    this.lastSample = {
      // Framebuffer-denominated, as every pre-F14 caller reported it; the
      // CSS-side footprint is `colsPerPixel · dpr` (see drawingDpr).
      colsPerPixel,
      smoothSigma: plan.sigmaCols,
      smoothTaps: plan.taps,
      rowDy,
      rowMipSoften,
      rowMipSigma,
      rowFade,
      levelFade,
      finerLevel,
    };
    gl.uniform1i(this.u.u_smoothTaps, plan.taps);
    uploadFloatArray(gl, this.u.u_smoothOffsets, taps.offsets);
    uploadFloatArray(gl, this.u.u_smoothWeights, taps.weights);
    gl.uniform1f(this.u.u_rowSmoothDy, rowDy);
    gl.uniform1f(this.u.u_rowMipSoften, rowMipSoften);
    uploadFloatArray(gl, this.u.u_rowMipWeights, rowMipWeights);

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
    // Per-REGION floor (lane F17; D5 lever L1): reconstructed columns use a
    // RELATIVE cut of the live slider floor (× reconFloorScale) — scaled by the
    // SAME nRowTaps·blk row footprint, so the t-space semantics match at every
    // zoom. scale 1 (the default-safe endpoint) uploads values bit-equal to the
    // live pair; with no tagged columns the shader's live branch is selected
    // anyway, keeping live pixels byte-identical.
    const rawRecon = reconFloorFor(this.floor, this.reconFloorScale);
    const floorRecon = Math.min(
      TOLERANCE_MAX_FLOOR,
      Math.max(0, rawRecon) * nRowTaps * blk,
    );
    const floorScaleRecon = 1 / Math.max(1 - floorRecon, 1e-6);
    gl.uniform1f(this.u.u_floorRecon, floorRecon);
    gl.uniform1f(this.u.u_floorScaleRecon, floorScaleRecon);
    this.lastRegion = {
      floorRecon,
      floorScaleRecon,
      reconColumns: this.regions.reconColumns,
    };

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    checkGLError(gl, 'Heatmap.draw');
  }

  /**
   * The sampler plan + cross-fade weights the LAST {@link draw} uploaded —
   * `colsPerPixel`, the Gaussian plan (see {@link smoothPlanFor}), the
   * vertical softening offset (see {@link rowSmoothDyFor}), the effective
   * row-mip cross-fade weight (see {@link effectiveRowMode}) and the SUM-mip
   * level cross-fade (see {@link levelBlendFor}; `finerLevel` is -1 whenever no
   * second sample exists). Defaults to the `colsPerPixel = 1` plan
   * (`{ colsPerPixel: 1, smoothSigma: 2, smoothTaps: 9, rowDy: 0, rowFade: 0,
   * levelFade: 0, finerLevel: -1 }`) before the first draw. Diagnostics/tests
   * only (testHook.levelInfo).
   */
  sampleInfo(): {
    colsPerPixel: number;
    smoothSigma: number;
    smoothTaps: number;
    rowDy: number;
    rowMipSoften: number;
    rowMipSigma: number;
    rowFade: number;
    levelFade: number;
    finerLevel: number;
  } {
    return { ...this.lastSample };
  }

  /**
   * Per-region diagnostics from the LAST draw (lane F17): the uploaded recon
   * floor pair and the number of tracker-tagged reconstructed columns. The mask
   * texture itself is slot-addressed; tests assert the uniforms and the
   * `texSubImage3D` transcript instead (see heatmap.test.ts).
   */
  regionInfo(): { floorRecon: number; floorScaleRecon: number; reconColumns: number } {
    return { ...this.lastRegion };
  }

  /**
   * Re-upload the whole region mask as ONE texSubImage3D from the slot-indexed
   * {@link RegionTracker.tags} array (capacity × 4 bytes — 64 KiB at the
   * production ring, and only on revision change). Red 0/255 so the shader's
   * `> 0.5` test is exact; alpha carries a mirror for debug readback.
   */
  private uploadRegions(): void {
    const gl = this.gl;
    const tags = this.regions.tags;
    const data = this.regionTexData;
    for (let i = 0; i < tags.length; i++) {
      const v = tags[i] === REGION_LIVE ? 0 : 255;
      const o = i * 4;
      data[o] = v;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = v;
    }
    gl.activeTexture(gl.TEXTURE0 + REGION_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.regionTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      0,
      this.tileRing.colsPerTile,
      1,
      this.tileRing.layers,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    );
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
    gl.deleteTexture(this.regionTex);
  }
}
