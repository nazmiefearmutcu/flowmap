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
// Colormap atlas: 256x4 RGBA8 — row 0 inferno, row 1 synth amber, row 2 classic
// thermal, row 3 flow (the default).
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

// Colormap row: 0 = inferno (default), 1 = synth (amber), 2 = classic thermal.
uniform int u_ramp;

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

// The level-0 field sample: bilinear + a light 1-texel column blur
// (0.25 / 0.5 / 0.25). Per-interval book noise is exactly ONE column wide, so
// the blur collapses the confetti while a wall — present in all three columns —
// keeps its true magnitude. Row resolution is untouched: price structure stays
// crisp, time gets the smoothing. Blur neighbours that fall outside the VALID
// window (the live edge's not-yet-written future column, the oldest valid
// edge) are dropped and their weight folded into the core, so the newest column
// paints at full weight instead of blending against an empty slot.
vec2 sampleField0(float colf, float rowf) {
  float wL = colf - 1.0 >= float(u_validFrom) ? 0.25 : 0.0;
  float wR = colf + 1.0 <= float(u_residentNewest) ? 0.25 : 0.0;
  float wC = 1.0 - wL - wR;
  return bilinear0(colf - 1.0, rowf) * wL
       + bilinear0(colf, rowf) * wC
       + bilinear0(colf + 1.0, rowf) * wR;
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
  if (u_level == 0) {
    // Smooth continuous field (see sampleField0).
    acc = sampleField0(colf, rowf);
  } else {
    // Zoomed out: exact SUM path over the coarse level (unchanged).
    acc = vec2(0.0);
    for (int t = 0; t < 4; t++) {
      if (t >= u_nRowTaps) break;
      int y = y0 + t;
      if (y < 0 || y >= rowsL) continue;
      acc += fetchLevel(xL, y, layer);
    }
  }

  // Price rows are SUMMED across the block + taps (a 500-lot wall stays ~500 when
  // tick-grouped). The block's COLUMN dimension is the only thing averaged out
  // (/blk), so a persistent wall reads at its true size, not blk x brighter — and
  // NOT diluted the way an average mip (which divides by blk*blk = the full 16^L)
  // would. That /blk is the "1/16^L rescale folded into normalization" from §8.3,
  // reduced to the wall-preserving 1/4^L (T9 replaces this with a per-level
  // histogram percentile).
  float intensity = (acc.r + acc.g) * u_decodeScale / float(blk);
  float t = clamp(intensity / max(u_norm, 1e-9), 0.0, 1.0);
  // Black point, then the perceptual display curve. Order matters: clipping
  // AFTER gamma would clip a curve, not a density, and the floor would mean a
  // different amount of size at every contrast setting.
  t = clamp((t - u_floor) * u_floorScale, 0.0, 1.0);
  // Perceptual display curve: brighten the mid-field, keep black + white fixed.
  t = pow(t, u_gamma);

  int li = int(t * 255.0 + 0.5);
  fragColor = texelFetch(u_lut, ivec2(li, u_ramp), 0);
}
`;
