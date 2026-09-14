/**
 * Heatmap shaders (§8.3 rendering). Inline GLSL ES 3.00 template strings — kept
 * in a dedicated module so they read like `.vert`/`.frag` files without pulling
 * in a raw-import loader.
 *
 * The view is a uniform (colOffset/colScale, rowOffset/rowScale) — NOT baked —
 * so T6 can drive pan/zoom by writing uniforms only, never re-uploading pixels.
 * The row→price affine is likewise a per-draw concern (T6/T8); here rows map
 * straight to texture rows for a single epoch.
 */

export const HEATMAP_VERT = /* glsl */ `#version 300 es
precision highp float;

// Clip-space quad; a_uv spans the viewport region we paint (0..1).
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_uv;

out vec2 v_uv;

void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

export const HEATMAP_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

in vec2 v_uv;
out vec4 fragColor;

// Density tiles: RG16F, R = bid, G = ask. texelFetch only — no filtering.
uniform highp sampler2DArray u_tiles;
// SUM-mip levels (§8.3 / T7). Each texel of level L is the SUM of a 4^L x 4^L
// block of level 0 — walls stay walls when zoomed out. When mips are absent the
// caller binds u_tiles here too (they are never sampled while u_level == 0).
uniform highp sampler2DArray u_mip1; // level 1: colsPerTile/4 x rows/4
uniform highp sampler2DArray u_mip2; // level 2: colsPerTile/16 x rows/16
// Row-only mip (campaign visual 2026-09-11, R2-M1): each texel sums 4 ROWS of
// ONE column — no column summing. Sampled only when u_rowOnly == 1.
uniform highp sampler2DArray u_rowMip1; // colsPerTile x rows/4
// Colormap atlas: 256x5 RGBA8 — row 0 inferno, row 1 synth amber, row 2 classic
// thermal, row 3 flow (the default), row 4 divergent imbalance (channel 3 only).
uniform sampler2D u_lut;

// View transform (screen uv -> absolute column/row). Driven by T6; identity-ish
// here. col = colOffset + colScale * uv.x, row = rowOffset + rowScale * uv.y.
uniform float u_colOffset;
uniform float u_colScale;
uniform float u_rowOffset;
uniform float u_rowScale;

// Ring addressing.
uniform int u_capacityCols;
uniform int u_colsPerTile;
uniform int u_rows;
// First resident col_seq whose slot is KNOWN to hold that column (gl/tileRing
// Residency.validFromSeq). Equal to the resident window's oldest EXCEPT after a
// gap forward growth (deep scroll-back releasing on go-live, a reconnect
// resume), where the slots between the window's oldest and the gap edge still
// hold PREVIOUS columns — those must paint background, not stale texels.
uniform int u_validFrom;
uniform int u_residentNewest;

// Value encoding + normalization (§8.3). intensity = (bid+ask) * decodeScale,
// then divided by the normalization percentile to land in ~[0,1].
uniform float u_decodeScale;
uniform float u_norm;
// Perceptual display curve (§8.3). Order-flow density is heavy-tailed, so a
// LINEAR map against the p99 white-point crushes ~99% of levels into the near-
// black floor and the field reads as black-with-walls. u_gamma < 1 (≈0.45)
// raises the mids while fixing the black + white endpoints (pow(0)=0, pow(1)=1),
// so the continuous thermal field becomes legible. One ALU op, uniform-only —
// no per-column CPU cost, the O(1)-in-history invariant is untouched.
uniform float u_gamma;

// Two-segment transfer curve (Bookmap-class overhaul; low-span calibrated
// 2026-09-13 after the owner-reported dark-field regression). u_knee is the
// CPU's clamp(kneeNorm / white, 0.05, 0.95) — the fraction of u_norm where the
// curve switches from the below-knee gamma lift to the above-knee log
// compression. u_lowSpan fixes the output share the BELOW-knee segment owns
// (TRANSFER_LOW_SPAN, 0.72): letting it end at k (the original formula)
// capped ~97% of active cells at LUT <= k*255 on heavy-tailed books and
// rendered the field black. u_logScale is the fixed module constant
// TRANSFER_LOG_SCALE. Endpoints stay exact: f(0) = 0, f(1) = 1 (LUT 255).
uniform float u_knee;
uniform float u_logScale;
uniform float u_lowSpan;

// Black point (§9 "Tolerance"). Density below u_floor collapses to LUT entry 0 —
// bit-identical to what background() returns — so small resting size falls back
// to background instead of painting, and only liquidity worth reading survives.
// The survivors are RE-EXPANDED by u_floorScale (= 1/(1-u_floor), precomputed on
// the CPU) so the white point still lands on the viewport percentile rather than
// dimming as the floor rises: both endpoints stay fixed, which is the promise the
// gamma curve below also keeps. At u_floor == 0 this is algebraically and
// numerically the identity, so every existing pixel spec is untouched.
//
// NOTE u_floor arrives ALREADY scaled by the frame's rows-per-pixel footprint
// (nRowTaps * blk). intensity SUMS rows and only divides the COLUMN dimension
// by blk, so t grows with price zoom-out; an unscaled floor would silently mean
// something different at every zoom level.
uniform float u_floor;
uniform float u_floorScale;

// Per-REGION black point (lane F17; D5 lever L1). Reconstructed (stretched
// 1 m-candle) columns carry a different density scale from the live book —
// measured recon/live ≈ 0.5× on BTC but ≈26× on ETH — so ONE global floor is
// calibrated for at most one regime and the dim side reads as background. The
// mask below tags each ring slot as live (0) or reconstructed (1); tagged
// columns use u_floorRecon / u_floorScaleRecon (a RELATIVE cut of the live
// floor — same t-space, same row-footprint scaling) while LIVE columns keep
// the exact shipped u_floor / u_floorScale pair. With no tagged columns the
// mask is all zero and every fragment takes the live branch, so live pixels
// stay byte-identical by construction.
uniform highp sampler2DArray u_region; // RGBA8, 1 row: r > 0.5 = reconstructed
uniform float u_floorRecon;
uniform float u_floorScaleRecon;

// Colormap row: 0 = inferno (default), 1 = synth (amber), 2 = classic thermal.
uniform int u_ramp;

// Depth channel mode (§9 channel modes, contract C2). Coherent uniform branch:
//   0 = sum        — (bid+ask) total density, the default and the historical
//                    expression, bit-identical to pre-channel releases.
//   1 = bid        — bid density only (acc.r).
//   2 = ask        — ask density only (acc.g).
//   3 = imbalance  — signed (bid−ask)/(bid+ask), FIXED [−1,1] domain (no
//                    histogram fit), mapped through the divergent atlas row 4
//                    (ask = blue, balanced = quiet neutral, bid = orange).
uniform int u_channel;

// The divergent atlas row (gl/lut.ts RAMP_IMBALANCE). The density u_ramp is NOT
// redirected in channel 3 — honesty (§7) and the background() readout keep
// sampling the density ramp; only the imbalance branch indexes this row.
const int RAMP_IMBALANCE = 4;

// Mip level selection (§8.3 / T7). All three are per-draw CONSTANTS (the CPU
// derives them from rows-per-pixel, which is a uniform), so every branch below
// is coherent across the frame — no divergence, ~as cheap as a direct fetch.
//   u_level    : 0/1/2 — which level to sample (coarser as more rows collapse).
//   u_blk      : 4^u_level — the linear downsample factor at that level.
//   u_nRowTaps : 1..4 — finer-level taps summed to cover the pixel's row footprint
//                (the "in-between zoom" manual SUM).
uniform int u_level;
uniform int u_blk;
uniform int u_nRowTaps;

// SUM-mip level cross-fade (campaign visual 2026-09-11, wave P2). The hard LOD
// switch at 4^k footprints is a measured brightness pop; the CPU ramps this
// weight 0→1 across the boundary band [0.75*4^k, 4^k]. 0 = pure legacy upload
// (the finer fetch is skipped entirely); 1 = pure coarse level (the mix carries
// no finer weight). In between the finer level (u_level-1) is summed with its
// own geometry (u_nRowTapsFine taps) and scaled by 4.0 so the pinned /blk
// intensity expression below stays exact at BOTH endpoints: the finer level's
// blk is blk/4, and mix(accF*4, acc, w)*/blk equals accF/(blk/4) at w=0 and
// acc/blk at w=1. The ×4 is exact in powers of two.
uniform float u_levelFade;
uniform int u_nRowTapsFine;

// Row-only mip flag (campaign visual 2026-09-11, R2-M1). 1 when the price axis
// collapses rows per pixel (rpp >= 2.5) while the time axis is deep-zoomed
// (cpp < 1.5): the 4x4 SUM mip would paint 4-column blocks, so rows are summed
// through u_rowMip1 (ONE column per texel) instead. u_blk is then the row
// block (4) and u_nRowTaps the 4-row taps covering the pixel footprint; the
// intensity correction below undoes the SUM path's /blk column division.
// With the lane-P cross-fade active this stays 1 for the WHOLE fade so the
// /blk * blk pair cancels and the raw-scale mix is magnitude-correct.
uniform int u_rowOnly;

// Row-mip cross-fade weight (resolution-transition polish, lane P). 0 = pure
// level-0 single-row sampling (the exact legacy output); 1 = pure 4-row-sum
// row-mip sampling (the exact post-4.1 rowOnly output). In between the level-0
// sample and the row sums are blended so the LOD switch never pops while
// zooming (the CPU ramps this across the row-mip eligibility band, reaching 0
// at the old rpp 2.5 switch edge — no step — and 1 at rpp 3.2). The 0 endpoint
// skips the row fetches entirely; the 1 endpoint takes the full-row branch,
// skipping the level-0 sampler — both stay bit-exact to their historical paths.
uniform float u_rowFade;

// Gaussian field sampler (Bookmap-class overhaul, lane F). Per-draw constants
// derived from the view's cols-per-pixel (columns / drawingBufferWidth): a
// symmetric tap table around the sample column, sigma pinned in CSS screen
// pixels (2.5 CSS px → ~6.4 px 10–90 edge; the CPU scales the framebuffer
// footprint by the device-pixel ratio so retina keeps the same CSS softness —
// F14 §L2 / wave-4 F20) and capped at 2 columns as columns become sub-pixel.
// Taps outside [u_validFrom, u_residentNewest] contribute NOTHING
// and their weight is dropped from the normalizer, so window edges fold into
// the core and the newest column keeps full weight (tail-columns contract).
uniform int u_smoothTaps;
uniform float u_smoothOffsets[9];
uniform float u_smoothWeights[9];

// Vertical softening offset in ROW units (barcode fix 2026-09-13; wave-2
// 2026-09-14 pixel-denominated + active at every zoom, CPU: rowSmoothDyFor;
// wave-4 F20 CSS-denominated via the CPU's device-pixel-ratio scale).
// ~0 = single-sample legacy path (only a poisoned view); > 0 blends a
// 0.25/0.5/0.25 vertical triple at ±dy rows around each sample so single-row
// liquidity reads as a soft band instead of a hard hairline (the owner's
// default-look complaint). The offset scales with the row footprint
// (dy = sigma_css_px · rowsPerPixel · dpr), so the band stays ~constant in
// CSS pixels at every zoom and every DPR — including the rpp ~3 DEFAULT.
// Read by BOTH the level-0 field (fieldAt) and the deep-row mip fetch
// (rowMipSoft, where the draw's conversion is dy/4 mip texels).
uniform float u_rowSmoothDy;

// Deep-row softening (barcode fix 2026-09-13, CPU: rowMipSoftenFor +
// rowMipWeightsFor). 1 inside the row-mip regime (rpp >= 2.5). The row-mip
// texel is a 4-ROW density sum; a Gaussian across the MIP row axis (integer
// taps with manual bilinear reconstruction between texels, weights for the
// current rows-per-pixel uploaded as uniforms) spreads a price-level band over
// ~4 texels (~5 px at the default book zoom) so sub-pixel-row hairlines read
// as soft bands with a smooth 10-90 falloff. 0 keeps the historical
// single-fetch row path byte-exact.
uniform float u_rowMipSoften;
uniform float u_rowMipWeights[7];

vec4 background() {
  // LUT entry 0 is the near-black floor — reuse it so out-of-range and
  // zero-density read identically.
  return texelFetch(u_lut, ivec2(0, u_ramp), 0);
}

// One texel at the active mip level. u_level is uniform, so the branch is coherent.
vec2 fetchLevel(int x, int y, int layer) {
  if (u_level == 0) return texelFetch(u_tiles, ivec3(x, y, layer), 0).rg;
  if (u_level == 1) return texelFetch(u_mip1, ivec3(x, y, layer), 0).rg;
  return texelFetch(u_mip2, ivec3(x, y, layer), 0).rg;
}

// One texel at the FINER level during a wave-P2 LOD cross-fade: u_level 1 →
// level 0 (u_tiles), u_level 2 → level 1 (u_mip1). Only called from the SUM
// else-branch, where u_level >= 1 (level 0 never blends).
vec2 fetchFine(int x, int y, int layer) {
  if (u_level == 1) return texelFetch(u_tiles, ivec3(x, y, layer), 0).rg;
  return texelFetch(u_mip1, ivec3(x, y, layer), 0).rg;
}

// Deep-row Gaussian fetch (barcode fix): a Gaussian across the MIP row axis
// around the continuous mip coordinate yMip. Taps sit on integer mip texels
// with a manual bilinear reconstruction between neighbours, so the vertical
// profile is smooth (no box steps) and the 10-90 edge widens as intended. The
// weights come from rowMipWeightsFor (CPU) for the current rows-per-pixel;
// texels outside [0, rowsR) are reached through a clamped coordinate, so the
// price-grid edge behaves like an edge-replicated tap.
//
// EDGE-AWARE blend: a Gaussian alone spreads an ISOLATED single-level wall
// into a faint glow, which the SUM-mip contract forbids (a 500-lot wall must
// read at its true size — see tests/e2e/mips.spec.ts: the wall peak must stay
// comparable to native at every row footprint). keep = clamp(1 - 2·maxNbr/
// center, 0, 1) is a STRICT wall detector: a texel whose strongest vertical
// neighbour is under half its size (an isolated wall) keeps its own texel
// exactly; any level that is part of a stack (neighbour >= half) takes the
// full smooth Gaussian — those stacks are exactly the owner's "barcode".
vec2 fetchRowMipGauss(int x, int layer, float yMip) {
  int rowsR = u_rows / 4;
  vec2 acc = vec2(0.0);
  vec2 center = vec2(0.0);
  vec2 neighborMax = vec2(0.0);
  for (int k = -3; k <= 3; k++) {
    float yc = clamp(yMip + float(k), 0.0, float(rowsR - 1));
    int y0 = int(floor(yc));
    float fy = yc - float(y0);
    int y1 = min(y0 + 1, rowsR - 1);
    vec2 v = mix(
      texelFetch(u_rowMip1, ivec3(x, y0, layer), 0).rg,
      texelFetch(u_rowMip1, ivec3(x, y1, layer), 0).rg,
      fy
    );
    acc += v * u_rowMipWeights[k + 3];
    if (k == 0) center = v;
    else neighborMax = max(neighborMax, v);
  }
  vec2 keep = clamp(1.0 - 2.0 * neighborMax / max(center, vec2(1e-6)), 0.0, 1.0);
  return mix(acc, center, keep);
}

// Deep-row barcode killer, wave 2 (2026-09-14): the SAME pixel-denominated
// vertical triple the level-0 field uses (u_rowSmoothDy, CPU: rowSmoothDyFor),
// applied to the deep-row Gaussian. dyMip = u_rowSmoothDy * 0.25 converts the
// row-unit offset to 4-row mip texels. The center evaluation keeps the
// wall-preserving texel (fetchRowMipGauss' edge-aware keep), so an isolated
// single-level spike becomes a ~4–5 px soft band whose core still carries the
// SUM-mip magnitude — a gradient core, never a flat stripe, never a hairline.
// Each flank is a full Gaussian evaluation; the two flanks are what spread the
// isolated spikes the first fix left crisp. u_rowSmoothDy <= 0 (poisoned view)
// keeps the exact single-fetch path.
vec2 rowMipSoft(int x, int layer, float yMip, float dyMip) {
  if (u_rowSmoothDy <= 0.0) return fetchRowMipGauss(x, layer, yMip);
  return 0.25 * fetchRowMipGauss(x, layer, yMip - dyMip)
       + 0.50 * fetchRowMipGauss(x, layer, yMip)
       + 0.25 * fetchRowMipGauss(x, layer, yMip + dyMip);
}

// One level-0 texel at an ABSOLUTE column, clamped into the VALID resident
// window. Clamping the absolute column (not the tile-local x) kills both edge
// artifacts of the old fetch0: a half-texel tap outside the window now
// edge-replicates the nearest VALID column instead of blending a stale slot
// (the live edge used to dim against the not-yet-written next column), and a
// tap straddling a 256-column tile seam resolves through the ring's slot
// arithmetic into the neighbouring layer instead of duplicating the edge texel
// (a 1-texel discontinuity every tile boundary).
vec2 fetchCol(int colAbs, int y) {
  int c = clamp(colAbs, u_validFrom, u_residentNewest);
  int slot = c % u_capacityCols;
  y = clamp(y, 0, u_rows - 1);
  return texelFetch(u_tiles, ivec3(slot % u_colsPerTile, y, slot / u_colsPerTile), 0).rg;
}

// Bilinear sample of the resident density at a CONTINUOUS ABSOLUTE column. The
// absolute col_seq is folded into ring slot space (mod capacity, then layer +
// tile-column) HERE, inside the sampler — the caller passes the same absolute
// coordinate the view transform produces. Getting this wrong (fetching by
// absolute column without the mod) silently reads the wrong texel for every
// column beyond the first tile, which is exactly the "heatmap fades out after
// 256 columns" failure mode. Turns the blocky per-cell staircase into a
// continuous field when a cell covers several device pixels.
vec2 bilinear0(float colf, float rowf) {
  float xf = colf - 0.5;
  int x0 = int(floor(xf));
  float fx = xf - float(x0);
  float yf = rowf - 0.5;
  int y0 = int(floor(yf));
  float fy = yf - float(y0);
  vec2 a = fetchCol(x0, y0);
  vec2 b = fetchCol(x0 + 1, y0);
  vec2 c = fetchCol(x0, y0 + 1);
  vec2 d = fetchCol(x0 + 1, y0 + 1);
  return mix(mix(a, b, fx), mix(c, d, fx), fy);
}

// Vertical-softened field sample (barcode fix): the 0.25/0.5/0.25 row triple
// around rowf when u_rowSmoothDy > 0, else the exact single bilinear sample.
vec2 fieldAt(float colf, float rowf) {
  if (u_rowSmoothDy <= 0.0) return bilinear0(colf, rowf);
  return 0.25 * bilinear0(colf, rowf - u_rowSmoothDy)
       + 0.50 * bilinear0(colf, rowf)
       + 0.25 * bilinear0(colf, rowf + u_rowSmoothDy);
}

// The level-0 field sample: a symmetric Gaussian on the TIME axis (uniform
// offsets/weights, lane F) over the vertically-softened field (barcode fix) —
// time gets the width-scaled kernel, price gets the small screen-scaled
// triple. Taps that fall outside the VALID window (the live edge's
// not-yet-written future column, the oldest valid edge) are skipped and
// contribute NOTHING; the surviving weights re-normalize (wsum below), so the
// newest column paints at full weight instead of blending against an empty
// slot, and the kernel folds to the core at edges.
vec2 sampleField0(float colf, float rowf) {
  vec2 acc = vec2(0.0);
  float wsum = 0.0;
  for (int t = 0; t < 9; t++) {
    if (t >= u_smoothTaps) break;
    float off = u_smoothOffsets[t];
    float colAt = colf + off;
    if (colAt < float(u_validFrom) - 0.5 || colAt > float(u_residentNewest) + 0.5) continue;
    float w = u_smoothWeights[t];
    acc += fieldAt(colAt, rowf) * w;
    wsum += w;
  }
  if (wsum <= 0.0) {
    acc = fieldAt(clamp(colf, float(u_validFrom), float(u_residentNewest)), rowf);
  } else {
    acc /= wsum;
  }
  return acc;
}

void main() {
  float colf = u_colOffset + u_colScale * v_uv.x;
  float rowf = u_rowOffset + u_rowScale * v_uv.y;
  int col = int(floor(colf));
  int row = int(floor(rowf));

  if (row < 0 || row >= u_rows || col < u_validFrom || col > u_residentNewest) {
    fragColor = background();
    return;
  }

  int slot = col % u_capacityCols;
  int layer = slot / u_colsPerTile;
  int x0 = slot % u_colsPerTile;

  int blk = u_blk;
  int xL = x0 / blk;
  int rowsL = u_rows / blk;
  // Center the finer-level taps on the pixel's row footprint.
  int y0 = (row / blk) - (u_nRowTaps / 2);

  vec2 acc;
  if (u_rowFade >= 0.999) {
    // Full row-sum endpoint (lane P; exact legacy row-only mip, R2-M1): SUM
    // u_nRowTaps 4-row texels of THIS pixel's ONE column — a collapsing price
    // axis still groups rows, but the time axis keeps hard cell edges (no
    // 4-column block average). Bounds-clamped like the SUM path (a tap outside
    // the grid contributes nothing). No level-0 fetches at this endpoint.
    // Deep-row barcode fix: with a 1-tap footprint the sum is replaced by the
    // vertical Gaussian reconstruction (fetchRowMipGauss) wrapped in the
    // pixel-denominated triple (rowMipSoft) — same 4-row mip source, smooth
    // falloff that reaches the isolated single-level spikes too. Larger
    // footprints (rpp > 4, D4 zone a: 88–90% sub-3-px hairlines with the bare
    // loop) soften PER TAP through the same Gaussian + triple, so a collapsing
    // price axis spreads isolated levels instead of painting needles. A
    // non-finite/poisoned view (soften 0) keeps the exact historical loop.
    if (u_rowMipSoften > 0.0 && u_nRowTaps == 1) {
      acc = rowMipSoft(x0, layer, (rowf + 0.5) * 0.25 - 0.5, u_rowSmoothDy * 0.25);
    } else if (u_rowMipSoften > 0.0) {
      int rowsR = u_rows / 4;
      int yBase = (row / 4) - (u_nRowTaps / 2);
      acc = vec2(0.0);
      for (int t = 0; t < 4; t++) {
        if (t >= u_nRowTaps) break;
        int y = yBase + t;
        if (y < 0 || y >= rowsR) continue;
        acc += rowMipSoft(x0, layer, float(y), u_rowSmoothDy * 0.25);
      }
    } else {
      int rowsR = u_rows / 4;
      int yBase = (row / 4) - (u_nRowTaps / 2);
      acc = vec2(0.0);
      for (int t = 0; t < 4; t++) {
        if (t >= u_nRowTaps) break;
        int y = yBase + t;
        if (y < 0 || y >= rowsR) continue;
        acc += texelFetch(u_rowMip1, ivec3(x0, y, layer), 0).rg;
      }
    }
  } else if (u_level == 0) {
    // Width-scaled Gaussian field sampler (lane F; see sampleField0): one
    // continuous kernel across the whole zoom range — no crisp/blur handoff.
    acc = sampleField0(colf, rowf);
    // Row-mip cross-fade (lane P): inside the row-mip regime the CPU ramps a
    // weight from 0 at the old rpp 2.5 switch edge to full row sums by rpp 3.2,
    // so the hard LOD switch becomes a smooth, step-free ramp. The legacy
    // endpoint (<= 0.001) skips the row fetches entirely; the full endpoint was
    // handled by the branch above. acc is in raw (single-row) scale while
    // accRow is a 4-row sum; u_blk == 4 during the fade, so the /blk * blk
    // correction below leaves this raw-scale mix magnitude-correct.
    if (u_rowFade > 0.001) {
      vec2 accRow;
      // Deep-row barcode fix: 1-tap footprints use the smooth Gaussian
      // reconstruction wrapped in the pixel-denominated triple; wider
      // footprints soften per tap through the same kernel (see the full-row
      // endpoint above); soften 0 keeps the historical tap loop.
      if (u_rowMipSoften > 0.0 && u_nRowTaps == 1) {
        accRow = rowMipSoft(x0, layer, (rowf + 0.5) * 0.25 - 0.5, u_rowSmoothDy * 0.25);
      } else if (u_rowMipSoften > 0.0) {
        int rowsR = u_rows / 4;
        int yBase = (row / 4) - (u_nRowTaps / 2);
        accRow = vec2(0.0);
        for (int t = 0; t < 4; t++) {
          if (t >= u_nRowTaps) break;
          int y = yBase + t;
          if (y < 0 || y >= rowsR) continue;
          accRow += rowMipSoft(x0, layer, float(y), u_rowSmoothDy * 0.25);
        }
      } else {
        int rowsR = u_rows / 4;
        int yBase = (row / 4) - (u_nRowTaps / 2);
        accRow = vec2(0.0);
        for (int t = 0; t < 4; t++) {
          if (t >= u_nRowTaps) break;
          int y = yBase + t;
          if (y < 0 || y >= rowsR) continue;
          accRow += texelFetch(u_rowMip1, ivec3(x0, y, layer), 0).rg;
        }
      }
      acc = mix(acc, accRow, clamp(u_rowFade, 0.0, 1.0));
    }
  } else {
    // Zoomed out: the SUM path over the coarse level, plus the wave-P2 level
    // cross-fade when the CPU is ramping across a 4^k LOD boundary.
    acc = vec2(0.0);
    for (int t = 0; t < 4; t++) {
      if (t >= u_nRowTaps) break;
      int y = y0 + t;
      if (y < 0 || y >= rowsL) continue;
      acc += fetchLevel(xL, y, layer);
    }
    // Finer-level sample (u_level-1), scaled by 4.0 so the pinned /float(blk)
    // intensity below is exact at both endpoints (fade 0 → pure finer, fade 1 →
    // pure coarse; ×4 and ÷4 cancel in powers of two). When the finer level IS
    // level 0 the DISPLAY sampler (the Gaussian above) is the right source: the
    // draw switches to the level-0 branch at fade 0, so a raw texelFetch sum
    // here left a visible band-entry step (coordinator amendment on P2).
    // fade <= 0.001 skips these fetches entirely.
    if (u_levelFade > 0.001) {
      vec2 accF;
      if (u_level == 1) {
        accF = sampleField0(colf, rowf);
      } else {
        int blkF = blk / 4;
        int xLf = x0 / blkF;
        int rowsLf = u_rows / blkF;
        int y0f = (row / blkF) - (u_nRowTapsFine / 2);
        accF = vec2(0.0);
        for (int t = 0; t < 4; t++) {
          if (t >= u_nRowTapsFine) break;
          int y = y0f + t;
          if (y < 0 || y >= rowsLf) continue;
          accF += fetchFine(xLf, y, layer);
        }
      }
      acc = mix(accF * 4.0, acc, clamp(u_levelFade, 0.0, 1.0));
    }
  }

  // Imbalance channel: signed dominance on a FIXED [−1,1] domain — the norm /
  // black-point / gamma pipeline below is a density pipeline and must not touch
  // it (a gamma on a signed value would shift the neutral midpoint). The +eps
  // of the spec formula is subsumed by the denom > 0 guard: zero density paints
  // background() exactly like the other channels, keeping an empty field quiet.
  if (u_channel == 3) {
    float denom = acc.r + acc.g;
    if (denom <= 0.0) {
      fragColor = background();
      return;
    }
    float d = clamp((acc.r - acc.g) / denom, -1.0, 1.0);
    int li = int((d * 0.5 + 0.5) * 255.0 + 0.5);
    fragColor = texelFetch(u_lut, ivec2(li, RAMP_IMBALANCE), 0);
    return;
  }

  // Price rows are SUMMED across the block + taps (a 500-lot wall stays ~500 when
  // tick-grouped). The block's COLUMN dimension is the only thing averaged out
  // (/blk), so a persistent wall reads at its true size, not blk x brighter —
  // and NOT diluted the way an average mip (which divides by blk*blk = the full
  // 16^L) would. That /blk is the "1/16^L rescale folded into normalization"
  // from §8.3, reduced to the wall-preserving 1/4^L (T9 replaces this with a
  // per-level histogram percentile).
  //
  // The channel-0 expression is UNCHANGED historical code — mode 0 must stay
  // bit-identical to pre-channel releases (golden tests pin the LUT index chain).
  float intensity = (acc.r + acc.g) * u_decodeScale / float(blk);
  if (u_channel == 1) intensity = acc.r * u_decodeScale / float(blk);
  else if (u_channel == 2) intensity = acc.g * u_decodeScale / float(blk);
  // Row-only mip: blk is the 4-ROW block baked into each row-mip texel, but
  // the SUM path's /blk is a COLUMN average the row-mip never applied — undo
  // it so a row-mip view reads exactly like the SUM path at the same footprint.
  if (u_rowOnly == 1) intensity *= float(blk);
  float t = clamp(intensity / max(u_norm, 1e-9), 0.0, 1.0);
  // Black point, then the transfer curve. Order matters: clipping AFTER the
  // curve would clip a curve, not a density, and the floor would mean a
  // different amount of size at every contrast setting. The region mask
  // (lane F17) selects the live floor for every untagged column — mix(a,b,0)
  // is exactly a, so the shipped pixels are bit-identical — and the RELATIVE
  // recon floor for tagged (reconstructed) columns.
  int region = texelFetch(u_region, ivec3(x0, 0, layer), 0).r > 0.5 ? 1 : 0;
  float floorSel = mix(u_floor, u_floorRecon, float(region));
  float floorScaleSel = mix(u_floorScale, u_floorScaleRecon, float(region));
  t = clamp((t - floorSel) * floorScaleSel, 0.0, 1.0);
  // Two-segment transfer (low-span calibrated 2026-09-13): below the knee the
  // display gamma lifts the mid-field into a FIXED output share u_lowSpan of
  // the ramp; above it log compression spreads the wall band across
  // [u_lowSpan, 1] so cores differentiate instead of clamping. Both endpoints
  // stay fixed (f(0)=0, f(1)=1) because 1 + u_logScale*(1-k)/(1-k) = 1 + u_logScale.
  float k = u_knee;
  float span = u_lowSpan;
  if (t <= k) {
    t = span * pow(t / k, u_gamma);
  } else {
    t = span + (1.0 - span) * log(1.0 + u_logScale * (t - k) / (1.0 - k)) / log(1.0 + u_logScale);
  }

  int li = int(t * 255.0 + 0.5);
  fragColor = texelFetch(u_lut, ivec2(li, u_ramp), 0);
}
`;
