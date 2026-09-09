/**
 * SUM-mips for correct zoom-out (§8.3, M2 T7).
 *
 * When the price axis is zoomed OUT, many rows collapse into one screen pixel.
 * A plain average-downsampled mip (what `generateMipmap` produces) would render
 * a 500-lot liquidity wall surrounded by empty ticks as ~500/16 — walls DILUTE
 * exactly when you zoom out, the opposite of what an order-flow heatmap must
 * show. Tick-grouping requires the SUMMED resting size, so mips are SUMS, not
 * averages, and `generateMipmap` is NEVER used.
 *
 * This module builds two extra array textures alongside the {@link TileRing}:
 *
 *   - level-1: `colsPerTile/4 × rows/4 × layers`  (each texel = SUM of a 4×4 block of level 0)
 *   - level-2: `colsPerTile/16 × rows/16 × layers`(each texel = SUM of a 4×4 block of level 1)
 *
 * Both are `RG16F` and color-renderable (needs `EXT_color_buffer_float`, a hard
 * §8.3 requirement) so the downsample runs on the GPU: an FBO ping-pong where a
 * fragment shader reads the finer level via `texelFetch` and writes the 4×4 sum
 * into the coarser level's FBO-attached layer. The per-texel coordinate mapping
 * matches the ring exactly (same layer, x/4^L within the tile), so the heatmap
 * shader's slot→(layer,x) addressing and residency/wrap logic are unchanged — it
 * just fetches from a coarser texture and folds the block rescale into the
 * normalization divisor.
 *
 * Incremental generation (NOT per frame — that is the whole point of the O(1)
 * draw): `updateFrom(ring, appendedColSeq)` runs the level-1 pass for the just-
 * completed group of 4 columns on every 4th append (when `x % 4 === 3`) and the
 * level-2 pass on every 16th (when `x % 16 === 15`). Each pass renders exactly
 * one coarser column (a 1×rowsL viewport), so the amortized cost is well under
 * one pass per append and is independent of history depth. Because the ring
 * capacity (`256 × layers`) is a multiple of 16, a group of 4/16 consecutive
 * ring slots always holds 4/16 consecutive column sequences even across a ring
 * wrap, so the group alignment stays valid.
 *
 * Saturation: sums are clamped at 60 000 (f16 max is 65 504; a fully-dense 4×4
 * block of near-max values, compounded across levels, would otherwise overflow).
 * Saturation is visually inert because the normalization percentile sits far
 * below it, and the crosshair readout comes from the CPU cache, not these texels.
 */

import { checkGLError, type GLContext } from './context';
import type { TileRing } from './tileRing';

const DOWNSAMPLE_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

// 4×4 SUM downsample. Output coords come from gl_FragCoord (the 1-wide viewport
// is offset to the target column, so int(gl_FragCoord.x) IS that column). Each
// output texel sums the 4×4 block of the finer level rooted at (4·ox, 4·oy).
//
// validFrom gating: after any col_seq gap (reconnect resume, go-live after deep
// scroll-back) the ring slots between the old resident window and the new first
// column still hold PREVIOUS columns. Level 0 masks those stale texels with
// u_validFrom (see shaders/heatmap.ts); the mips must apply the SAME gate while
// summing, or a pre-gap column bakes into the mip forever and a zoomed-out view
// shows a permanently over-bright block. Within the group being summed the four
// source columns are exactly [u_groupNewest-3 .. u_groupNewest] (group-aligned
// appends), so each tap's absolute col_seq is known and anything below
// u_validFrom contributes zero.
export const DOWNSAMPLE_FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform highp sampler2DArray u_src;
uniform int u_srcLayer;
// First VALID absolute col_seq (TileRing.validFromSeq) and the newest absolute
// col_seq of the 4-column group this pass sums (see updateFrom).
uniform int u_validFrom;
uniform int u_groupNewest;

out vec4 outColor;

void main() {
  int ox = int(gl_FragCoord.x);
  int oy = int(gl_FragCoord.y);
  int bx = ox * 4;
  int by = oy * 4;
  vec2 s = vec2(0.0);
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      // Mask the source column against the valid window BEFORE summing (the
      // level-0 rule, applied at the source): stale pre-gap texels contribute 0.
      if (u_groupNewest - 3 + i >= u_validFrom) {
        s += texelFetch(u_src, ivec3(bx + i, by + j, u_srcLayer), 0).rg;
      }
    }
  }
  // Saturate (not wrap): keep an extreme wall inside the f16 range across levels.
  s = min(s, vec2(60000.0));
  outColor = vec4(s, 0.0, 0.0);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('flowmap/mips: createShader returned null');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`flowmap/mips: shader compile failed: ${log}`);
  }
  return sh;
}

function allocLevel(
  gl: WebGL2RenderingContext,
  cols: number,
  rows: number,
  layers: number,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('flowmap/mips: createTexture returned null');
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RG16F, cols, rows, layers);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  return tex;
}

/**
 * The ABSOLUTE col_seqs a level-1 group's SUM covers (the group ENDS at
 * `groupNewest` — appends are group-aligned, so the four ring slots hold these
 * columns). The validFrom mask in {@link DOWNSAMPLE_FRAG} is applied per member.
 * Exposed so the group arithmetic stays unit-checkable next to the shader.
 */
export function mipGroupCols(groupNewest: number): [number, number, number, number] {
  return [groupNewest - 3, groupNewest - 2, groupNewest - 1, groupNewest];
}

export class MipChain {
  readonly gl: WebGL2RenderingContext;
  readonly colsPerTile: number;
  readonly rows: number;
  readonly layers: number;
  /** Highest level present (1 = only level-1, 2 = level-1 + level-2). */
  readonly maxLevel: number;

  /** level-1 texture (colsPerTile/4 × rows/4 × layers). */
  readonly tex1: WebGLTexture;
  /** level-2 texture (colsPerTile/16 × rows/16 × layers), or null when maxLevel<2. */
  readonly tex2: WebGLTexture | null;

  private readonly prog: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quad: WebGLBuffer;
  private readonly fbo: WebGLFramebuffer;
  private readonly uSrc: WebGLUniformLocation | null;
  private readonly uSrcLayer: WebGLUniformLocation | null;
  private readonly uValidFrom: WebGLUniformLocation | null;
  private readonly uGroupNewest: WebGLUniformLocation | null;
  /**
   * False once a downsample pass finds its FBO incomplete (a driver/alloc
   * failure must not silently paint garbage). The chain then renders nothing
   * further and the heatmap falls back to the level-0 path (`Heatmap.draw` and
   * the renderer's level selection both consult this).
   */
  private usableFlag = true;

  /** Whether the FBO passes are (still) known-complete — see {@link usableFlag}. */
  get usable(): boolean {
    return this.usableFlag;
  }

  constructor(ctx: GLContext, colsPerTile: number, rows: number, layers: number) {
    const gl = ctx.gl;
    if (!ctx.caps.colorBufferFloat) {
      throw new Error(
        'flowmap/mips: EXT_color_buffer_float required (§8.3: RG16F must be color-renderable for SUM mip FBO passes)',
      );
    }
    if (colsPerTile % 16 !== 0) {
      throw new Error(`flowmap/mips: colsPerTile ${colsPerTile} must be a multiple of 16`);
    }
    if (rows % 4 !== 0) {
      throw new Error(`flowmap/mips: rows ${rows} must be a multiple of 4 for level-1 mips`);
    }
    this.gl = gl;
    this.colsPerTile = colsPerTile;
    this.rows = rows;
    this.layers = layers;
    this.maxLevel = rows % 16 === 0 ? 2 : 1;

    this.tex1 = allocLevel(gl, colsPerTile / 4, rows / 4, layers);
    this.tex2 = this.maxLevel >= 2 ? allocLevel(gl, colsPerTile / 16, rows / 16, layers) : null;

    // Downsample program + a clip-space quad (viewport clips to one column).
    const vs = compile(gl, gl.VERTEX_SHADER, DOWNSAMPLE_VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, DOWNSAMPLE_FRAG);
    const prog = gl.createProgram();
    if (!prog) throw new Error('flowmap/mips: createProgram returned null');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`flowmap/mips: downsample link failed: ${log}`);
    }
    this.prog = prog;
    this.uSrc = gl.getUniformLocation(prog, 'u_src');
    this.uSrcLayer = gl.getUniformLocation(prog, 'u_srcLayer');
    this.uValidFrom = gl.getUniformLocation(prog, 'u_validFrom');
    this.uGroupNewest = gl.getUniformLocation(prog, 'u_groupNewest');

    const quad = gl.createBuffer();
    const vao = gl.createVertexArray();
    const fbo = gl.createFramebuffer();
    if (!quad || !vao || !fbo) throw new Error('flowmap/mips: buffer/VAO/FBO alloc failed');
    this.quad = quad;
    this.vao = vao;
    this.fbo = fbo;

    // prettier-ignore
    const verts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    checkGLError(gl, 'MipChain.ctor');
  }

  /**
   * Regenerate the mip columns affected by appending `appendedColSeq`. Runs the
   * level-1 pass when the 4-column group is complete (`x % 4 === 3`) and the
   * level-2 pass when the 16-column group is complete (`x % 16 === 15`). No-op on
   * other appends — that is what keeps generation incremental and O(1).
   */
  updateFrom(ring: TileRing, appendedColSeq: number): void {
    // A chain whose FBO went incomplete renders nothing further; the heatmap has
    // already been told (via `usable`) to stay on the level-0 path.
    if (!this.usableFlag) return;

    const cap = ring.capacityCols;
    const slot = ((appendedColSeq % cap) + cap) % cap;
    const x0 = slot % this.colsPerTile;
    const layer = (slot / this.colsPerTile) | 0;

    if (x0 % 4 === 3) {
      // level-0 → level-1: write coarser column x0/4 from level-0 columns [x0-3 .. x0].
      // Mask each source column against the ring's validFrom gate so a pre-gap
      // column never bakes into the SUM (see DOWNSAMPLE_FRAG).
      this.pass(
        ring.texture,
        this.tex1,
        (x0 / 4) | 0,
        this.rows / 4,
        layer,
        ring.validFromSeq(),
        appendedColSeq,
      );
    }
    if (this.tex2 !== null && x0 % 16 === 15) {
      // level-1 → level-2: write coarser column x0/16 from the 4 level-1
      // columns just built. Those sources were each validFrom-masked at their
      // OWN build time — after a gap growth, the three columns completed
      // BEFORE the growth carry pre-gap data, so baking them here would smear
      // the gap into a level-2 texel (the exact bug the level-1 mask fixed,
      // one level up). Skip until the whole 16-column group is unambiguously
      // post-gap; the stale texel self-heals when the ring wraps this group.
      if (appendedColSeq - 15 >= ring.validFromSeq()) {
        this.pass(this.tex1, this.tex2, (x0 / 16) | 0, this.rows / 16, layer, null, appendedColSeq);
      }
    }

    // Restore the default framebuffer so the display draw targets the screen.
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    checkGLError(this.gl, 'MipChain.updateFrom');
  }

  private pass(
    srcTex: WebGLTexture,
    dstTex: WebGLTexture,
    dstCol: number,
    dstRows: number,
    layer: number,
    /** validFrom gate for the level-0 source (absolute col_seqs), or null to disable. */
    maskFrom: number | null,
    groupNewest: number,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, dstTex, 0, layer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    // Honest fallback: an incomplete FBO (allocation failure, driver limits)
    // would leave the pass drawing into nothing / garbage. Disable the chain —
    // the heatmap falls back to the exact level-0 path — instead of baking
    // broken mips that a zoomed-out view would sample forever.
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this.usableFlag = false;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return;
    }

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    // Rasterize exactly the one destination column; gl_FragCoord.x -> dstCol.
    gl.viewport(dstCol, 0, 1, dstRows);

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, srcTex);
    gl.uniform1i(this.uSrc, 0);
    gl.uniform1i(this.uSrcLayer, layer);
    gl.uniform1i(this.uValidFrom, maskFrom !== null ? maskFrom : -0x7fffffff);
    gl.uniform1i(this.uGroupNewest, groupNewest);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteFramebuffer(this.fbo);
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog);
    gl.deleteTexture(this.tex1);
    if (this.tex2 !== null) gl.deleteTexture(this.tex2);
  }
}
