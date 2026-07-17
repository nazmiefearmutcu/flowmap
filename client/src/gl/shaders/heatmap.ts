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
uniform sampler2DArray u_tiles;
// Colormap atlas: 256x2 RGBA8, row 0 thermal, row 1 synth.
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
uniform int u_residentOldest;
uniform int u_residentNewest;

// Value encoding + normalization (§8.3). intensity = (bid+ask) * decodeScale,
// then divided by the normalization percentile to land in ~[0,1].
uniform float u_decodeScale;
uniform float u_norm;

// Colormap row: 0 = thermal, 1 = synth (amber).
uniform int u_ramp;

vec4 background() {
  // LUT entry 0 is the near-black floor — reuse it so out-of-range and
  // zero-density read identically.
  return texelFetch(u_lut, ivec2(0, u_ramp), 0);
}

void main() {
  float colf = u_colOffset + u_colScale * v_uv.x;
  float rowf = u_rowOffset + u_rowScale * v_uv.y;
  int col = int(floor(colf));
  int row = int(floor(rowf));

  if (row < 0 || row >= u_rows || col < u_residentOldest || col > u_residentNewest) {
    fragColor = background();
    return;
  }

  int slot = col % u_capacityCols;
  int layer = slot / u_colsPerTile;
  int x = slot % u_colsPerTile;

  vec2 d = texelFetch(u_tiles, ivec3(x, row, layer), 0).rg;
  float intensity = (d.r + d.g) * u_decodeScale;
  float t = clamp(intensity / max(u_norm, 1e-9), 0.0, 1.0);

  int li = int(t * 255.0 + 0.5);
  fragColor = texelFetch(u_lut, ivec2(li, u_ramp), 0);
}
`;
