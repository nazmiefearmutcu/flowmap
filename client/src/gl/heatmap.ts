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
import { RAMP_THERMAL } from './lut';
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
  /** Colormap row: RAMP_THERMAL | RAMP_SYNTH. */
  ramp: number;
}

const TILE_UNIT = 0;
const LUT_UNIT = 1;
const MIP1_UNIT = 2;
const MIP2_UNIT = 3;

/** The mip level + tap geometry to sample this frame (see {@link selectLevel}). */
interface LevelSel {
  level: number;
  blk: number;
  nRowTaps: number;
}

/**
 * Choose the SUM-mip level from how many price rows collapse into one device
 * pixel (`rowsPerPixel`). Level L's texels sum a 4^L×4^L block, so the coarsest
 * level whose block is ≤ the pixel footprint is picked; the leftover is covered
 * by 1..4 finer-level taps summed in the shader (the "in-between zoom" case).
 * With no mips (`maxLevel === 0`) this is the identity: level 0, one tap.
 */
export function selectLevel(rowsPerPixel: number, maxLevel: number): LevelSel {
  if (maxLevel <= 0 || rowsPerPixel <= 1) return { level: 0, blk: 1, nRowTaps: 1 };
  const level = Math.max(0, Math.min(maxLevel, Math.floor(Math.log(rowsPerPixel) / Math.log(4))));
  const blk = 4 ** level;
  const nRowTaps = Math.max(1, Math.min(4, Math.round(rowsPerPixel / blk)));
  return { level, blk, nRowTaps };
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
  | 'u_lut'
  | 'u_colOffset'
  | 'u_colScale'
  | 'u_rowOffset'
  | 'u_rowScale'
  | 'u_capacityCols'
  | 'u_colsPerTile'
  | 'u_rows'
  | 'u_residentOldest'
  | 'u_residentNewest'
  | 'u_decodeScale'
  | 'u_norm'
  | 'u_ramp'
  | 'u_level'
  | 'u_blk'
  | 'u_nRowTaps';

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

  encoding: HeatmapEncoding = { decodeScale: 1, norm: 1, ramp: RAMP_THERMAL };

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
      u_lut: loc('u_lut'),
      u_colOffset: loc('u_colOffset'),
      u_colScale: loc('u_colScale'),
      u_rowOffset: loc('u_rowOffset'),
      u_rowScale: loc('u_rowScale'),
      u_capacityCols: loc('u_capacityCols'),
      u_colsPerTile: loc('u_colsPerTile'),
      u_rows: loc('u_rows'),
      u_residentOldest: loc('u_residentOldest'),
      u_residentNewest: loc('u_residentNewest'),
      u_decodeScale: loc('u_decodeScale'),
      u_norm: loc('u_norm'),
      u_ramp: loc('u_ramp'),
      u_level: loc('u_level'),
      u_blk: loc('u_blk'),
      u_nRowTaps: loc('u_nRowTaps'),
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
    // level selection is forced to 0 below (u_level == 0 → u_tiles only).
    const mips = this.mips;
    const mip1 = mips ? mips.tex1 : this.tileRing.texture;
    const mip2 = mips && mips.tex2 ? mips.tex2 : this.tileRing.texture;
    gl.activeTexture(gl.TEXTURE0 + MIP1_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, mip1);
    gl.uniform1i(this.u.u_mip1, MIP1_UNIT);
    gl.activeTexture(gl.TEXTURE0 + MIP2_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, mip2);
    gl.uniform1i(this.u.u_mip2, MIP2_UNIT);

    gl.uniform1f(this.u.u_colOffset, view.colOffset);
    gl.uniform1f(this.u.u_colScale, view.colScale);
    gl.uniform1f(this.u.u_rowOffset, view.rowOffset);
    gl.uniform1f(this.u.u_rowScale, view.rowScale);

    gl.uniform1i(this.u.u_capacityCols, this.tileRing.capacityCols);
    gl.uniform1i(this.u.u_colsPerTile, this.tileRing.colsPerTile);
    gl.uniform1i(this.u.u_rows, this.tileRing.rows);
    gl.uniform1i(this.u.u_residentOldest, range ? range.oldest : 1);
    // With no residents, oldest(1) > newest(0) makes every column out-of-range.
    gl.uniform1i(this.u.u_residentNewest, range ? range.newest : 0);

    gl.uniform1f(this.u.u_decodeScale, this.encoding.decodeScale);
    gl.uniform1f(this.u.u_norm, this.encoding.norm);
    gl.uniform1i(this.u.u_ramp, this.encoding.ramp);

    // Rows collapsing into one device pixel drive the mip level (§8.3): coarser
    // level as price zooms out. rowScale is a uniform and the buffer height is
    // fixed, so this is one selection for the whole frame — a constant the shader
    // branches on coherently. mip *generation* is incremental (append time); mip
    // *sampling* is ≤4 texelFetch per pixel, keeping the draw O(1) in history.
    const maxLevel = this.mips ? this.mips.maxLevel : 0;
    const rowsPerPixel = view.rowScale / Math.max(1, gl.drawingBufferHeight);
    const sel = selectLevel(rowsPerPixel, maxLevel);
    gl.uniform1i(this.u.u_level, sel.level);
    gl.uniform1i(this.u.u_blk, sel.blk);
    gl.uniform1i(this.u.u_nRowTaps, sel.nRowTaps);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    checkGLError(gl, 'Heatmap.draw');
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
