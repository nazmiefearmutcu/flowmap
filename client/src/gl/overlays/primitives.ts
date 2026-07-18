/**
 * Overlay GL primitives (§8.3 overlays, M2 T10).
 *
 * All the graphical overlays (bubbles, BBO, VWAP, profile, markers) draw with
 * exactly TWO tiny GL programs kept here:
 *
 *   - {@link SolidBatch} — colored triangles in CLIP space (y-up NDC). Lines,
 *     rects, triangles and thick polylines are all built CPU-side into triangles
 *     and streamed through one dynamic buffer. Per-vertex RGBA (with alpha) so a
 *     single flush can hold differently-colored/translucent shapes.
 *   - {@link PointBatch} — round anti-aliased points (gl.POINTS) for trade
 *     bubbles: per-instance clip position, device-px diameter, and RGBA.
 *
 * Overlays convert their grid/time/price coordinates to clip space through a
 * {@link GridMap} (see coords.ts) and hand this module CLIP-space geometry, so
 * the GL side is trivial and shares nothing with the heatmap program. Each
 * overlay does its own `begin() … flush()` so draw ORDER equals call order
 * (profile → vwap → bbo → bubbles → markers), i.e. z-order is honored without a
 * depth buffer. Cost is O(vertices) = O(visible), never O(history).
 *
 * Blending is standard src-alpha over the heatmap; the batch enables it on flush
 * and the heatmap re-disables BLEND at the top of its own draw, so no state
 * leaks. `checkGLError` guards every flush (a GL error throws, matching the
 * heatmap's own discipline and the e2e "no GL errors" gate).
 */

import { checkGLError } from '../context';

export type RGBA = readonly [number, number, number, number];

const SOLID_VERT = `#version 300 es
layout(location=0) in vec2 a_pos;   // clip space, y-up
layout(location=1) in vec4 a_color; // straight (non-premultiplied) RGBA
out vec4 v_color;
void main() {
  v_color = a_color;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const SOLID_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 o_color;
void main() {
  o_color = v_color;
}`;

const POINT_VERT = `#version 300 es
layout(location=0) in vec2 a_pos;    // clip space, y-up
layout(location=1) in float a_size;  // device px diameter
layout(location=2) in vec4 a_color;
out vec4 v_color;
void main() {
  v_color = a_color;
  gl_PointSize = a_size;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Round mask + a soft 1px edge so bubbles read as dots, not squares.
const POINT_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 o_color;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r = dot(d, d);
  if (r > 1.0) discard;
  float edge = smoothstep(1.0, 1.0 - fwidth(r) * 2.0, r);
  o_color = vec4(v_color.rgb, v_color.a * edge);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('flowmap/overlay: createShader returned null');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`flowmap/overlay: shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vert);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
  const prog = gl.createProgram();
  if (!prog) throw new Error('flowmap/overlay: createProgram returned null');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`flowmap/overlay: program link failed: ${log}`);
  }
  return prog;
}

/**
 * Perpendicular offset (in clip space) for a thick line from clip endpoints. The
 * segment direction is measured in PIXELS (so thickness is pixel-constant at any
 * aspect ratio), then the unit normal is scaled back to clip via the px→clip
 * ratios. Returns `[ox, oy]`, the half-width offset to add/subtract at each end.
 */
function lineNormalClip(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  halfWpxToClipX: number,
  halfWpxToClipY: number,
  cssW: number,
  cssH: number,
): [number, number] {
  // Endpoint delta in pixel space (clip→px: ×cssW/2, ×cssH/2).
  const dxPx = ((x1 - x0) * cssW) / 2;
  const dyPx = ((y1 - y0) * cssH) / 2;
  const len = Math.hypot(dxPx, dyPx) || 1;
  // Unit normal in pixel space, then scaled to clip by the half-width ratios.
  const nx = -dyPx / len;
  const ny = dxPx / len;
  return [nx * halfWpxToClipX, ny * halfWpxToClipY];
}

/** Colored-triangle batch in clip space. Reused across overlays; begin/flush. */
export class SolidBatch {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  /** 6 floats per vertex: x, y, r, g, b, a. */
  private data: Float32Array;
  private n = 0; // vertex count

  constructor(gl: WebGL2RenderingContext, initialVerts = 1024) {
    this.gl = gl;
    this.program = link(gl, SOLID_VERT, SOLID_FRAG);
    this.data = new Float32Array(initialVerts * 6);
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (!vao || !buffer) throw new Error('flowmap/overlay: solid VAO/buffer alloc failed');
    this.vao = vao;
    this.buffer = buffer;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  begin(): void {
    this.n = 0;
  }

  get vertexCount(): number {
    return this.n;
  }

  private ensure(extraVerts: number): void {
    const need = (this.n + extraVerts) * 6;
    if (need <= this.data.length) return;
    let cap = this.data.length;
    while (cap < need) cap *= 2;
    const grown = new Float32Array(cap);
    grown.set(this.data.subarray(0, this.n * 6));
    this.data = grown;
  }

  private vertex(x: number, y: number, c: RGBA): void {
    const o = this.n * 6;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = c[0];
    this.data[o + 3] = c[1];
    this.data[o + 4] = c[2];
    this.data[o + 5] = c[3];
    this.n += 1;
  }

  /** A clip-space triangle. */
  addTri(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, c: RGBA): void {
    this.ensure(3);
    this.vertex(x0, y0, c);
    this.vertex(x1, y1, c);
    this.vertex(x2, y2, c);
  }

  /** A clip-space quad from four corners (0-1-2, 0-2-3 winding-agnostic fill). */
  addQuad(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    c: RGBA,
  ): void {
    this.addTri(x0, y0, x1, y1, x2, y2, c);
    this.addTri(x0, y0, x2, y2, x3, y3, c);
  }

  /** An axis-aligned clip-space rect from opposite corners. */
  addRect(xa: number, ya: number, xb: number, yb: number, c: RGBA): void {
    this.addQuad(xa, ya, xb, ya, xb, yb, xa, yb, c);
  }

  /**
   * A thick line between two clip-space points, thickness in CSS px. `cssW/cssH`
   * are needed to make the width pixel-constant regardless of the view aspect.
   */
  addThickLine(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    widthPx: number,
    c: RGBA,
    cssW: number,
    cssH: number,
  ): void {
    const halfClipX = (widthPx * 1) / Math.max(1, cssW); // (px * 2/cssW) / 2
    const halfClipY = (widthPx * 1) / Math.max(1, cssH);
    const [ox, oy] = lineNormalClip(x0, y0, x1, y1, halfClipX, halfClipY, cssW, cssH);
    this.addQuad(
      x0 + ox,
      y0 + oy,
      x1 + ox,
      y1 + oy,
      x1 - ox,
      y1 - oy,
      x0 - ox,
      y0 - oy,
      c,
    );
  }

  /** Upload + draw the accumulated triangles (alpha-blended). No-op when empty. */
  flush(): void {
    if (this.n === 0) return;
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.n * 6), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, this.n);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    checkGLError(gl, 'SolidBatch.flush');
    this.n = 0;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.buffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}

/** Round-point batch for trade bubbles. Reused; begin/flush. */
export class PointBatch {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  /** 7 floats per point: x, y, sizePx, r, g, b, a. */
  private data: Float32Array;
  private n = 0;

  constructor(gl: WebGL2RenderingContext, initialPoints = 512) {
    this.gl = gl;
    this.program = link(gl, POINT_VERT, POINT_FRAG);
    this.data = new Float32Array(initialPoints * 7);
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (!vao || !buffer) throw new Error('flowmap/overlay: point VAO/buffer alloc failed');
    this.vao = vao;
    this.buffer = buffer;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 28, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  begin(): void {
    this.n = 0;
  }

  get pointCount(): number {
    return this.n;
  }

  private ensure(extra: number): void {
    const need = (this.n + extra) * 7;
    if (need <= this.data.length) return;
    let cap = this.data.length;
    while (cap < need) cap *= 2;
    const grown = new Float32Array(cap);
    grown.set(this.data.subarray(0, this.n * 7));
    this.data = grown;
  }

  /** One point at clip `(x,y)`, device-px `size` diameter, RGBA color. */
  add(x: number, y: number, size: number, c: RGBA): void {
    this.ensure(1);
    const o = this.n * 7;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = size;
    this.data[o + 3] = c[0];
    this.data[o + 4] = c[1];
    this.data[o + 5] = c[2];
    this.data[o + 6] = c[3];
    this.n += 1;
  }

  flush(): void {
    if (this.n === 0) return;
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.n * 7), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.POINTS, 0, this.n);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    checkGLError(gl, 'PointBatch.flush');
    this.n = 0;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.buffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
