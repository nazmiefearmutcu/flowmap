/**
 * A deterministic fake WebGL2 context + fake 2D context for jsdom unit tests.
 *
 * The gl/ modules exercise the real GPU only in the browser (see testHook.ts —
 * "GL cannot be meaningfully unit-mocked" for PIXELS). What CAN be unit-tested
 * without a GPU is the CPU behavior AROUND the GL calls: which folds happen,
 * whether the render loop survives a throw, what state the batches set, and
 * which uniforms a pass wires up. This fake records every call (name + args)
 * so tests assert on that transcript instead of pixels. Everything unimplemented
 * is a silent no-op; `EXT_color_buffer_float` is emulated via `colorBufferFloat`.
 */

export interface FakeGLCall {
  name: string;
  args: unknown[];
}

/** Minimal WebGL2 constant set the gl/ modules reference (real GL values). */
export const GL = {
  NO_ERROR: 0,
  COLOR_BUFFER_BIT: 16384,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
  VERTEX_SHADER: 35633,
  FRAGMENT_SHADER: 35632,
  COMPILE_STATUS: 35713,
  LINK_STATUS: 35714,
  TEXTURE_2D: 3553,
  TEXTURE_2D_ARRAY: 35866,
  TEXTURE_MIN_FILTER: 10241,
  TEXTURE_MAG_FILTER: 10240,
  TEXTURE_WRAP_S: 10242,
  TEXTURE_WRAP_T: 10243,
  UNPACK_ALIGNMENT: 3317,
  NEAREST: 9728,
  CLAMP_TO_EDGE: 33071,
  RG16F: 33322,
  RG: 33319,
  RGBA8: 32856,
  RGBA: 6408,
  UNSIGNED_BYTE: 5121,
  FLOAT: 5126,
  ARRAY_BUFFER: 34962,
  STATIC_DRAW: 35044,
  DYNAMIC_DRAW: 35048,
  TRIANGLES: 4,
  TRIANGLE_STRIP: 5,
  POINTS: 0,
  BLEND: 3042,
  DEPTH_TEST: 2929,
  ONE: 1,
  SRC_ALPHA: 770,
  ONE_MINUS_SRC_ALPHA: 771,
  TEXTURE0: 33984,
  FRAMEBUFFER: 36160,
  COLOR_ATTACHMENT0: 36064,
  FRAMEBUFFER_COMPLETE: 36053,
  FRAMEBUFFER_INCOMPLETE: 36054,
} as const;

export interface FakeGL extends WebGL2RenderingContext {
  calls: FakeGLCall[];
  /** When true, drawArrays throws (drives the frame-loop resilience tests). */
  failDraw: boolean;
  /** Mirrors the lost-context state isContextLost() reports. */
  contextLost: boolean;
  /** Calls matching `name`, in order. */
  callsOf(name: string): FakeGLCall[];
}

export interface FakeGLOptions {
  /** Emulate the EXT_color_buffer_float extension (needed for MipChain tests). */
  colorBufferFloat?: boolean;
  /** checkFramebufferStatus reports INCOMPLETE (drives the mip fallback tests). */
  incompleteFBO?: boolean;
}

export function makeFakeGL(opts: FakeGLOptions = {}): FakeGL {
  const calls: FakeGLCall[] = [];
  const record = (name: string) => (...args: unknown[]): void => {
    calls.push({ name, args });
  };
  const locs = new Map<string, Record<string, unknown>>();

  const gl = {
    ...GL,

    drawingBufferWidth: 320,
    drawingBufferHeight: 240,
    calls,
    failDraw: false,
    contextLost: false,

    callsOf(name: string): FakeGLCall[] {
      return calls.filter((c) => c.name === name);
    },

    getError: () => GL.NO_ERROR,
    getParameter: (p: number): number =>
      p === GL.MAX_TEXTURE_IMAGE_UNITS
        ? 16
        : p === GL.MAX_ARRAY_TEXTURE_LAYERS
          ? 2048
          : p === GL.MAX_TEXTURE_SIZE
            ? 8192
            : 0,
    getExtension: (name: string): unknown =>
      name === 'EXT_color_buffer_float' && opts.colorBufferFloat ? {} : null,
    isContextLost: (): boolean => gl.contextLost,

    createShader: () => ({}),
    shaderSource: record('shaderSource'),
    compileShader: record('compileShader'),
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: record('deleteShader'),

    createProgram: () => ({}),
    attachShader: record('attachShader'),
    linkProgram: record('linkProgram'),
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: record('deleteProgram'),
    getUniformLocation: (_p: unknown, name: string) => {
      let loc = locs.get(name);
      if (!loc) {
        loc = { uniform: name };
        locs.set(name, loc);
      }
      return loc;
    },
    useProgram: record('useProgram'),
    uniform1i: record('uniform1i'),
    uniform1f: record('uniform1f'),

    createTexture: () => ({}),
    bindTexture: record('bindTexture'),
    texStorage3D: record('texStorage3D'),
    texImage2D: record('texImage2D'),
    texSubImage3D: record('texSubImage3D'),
    texParameteri: record('texParameteri'),
    pixelStorei: record('pixelStorei'),
    activeTexture: record('activeTexture'),
    deleteTexture: record('deleteTexture'),

    createBuffer: () => ({}),
    bindBuffer: record('bindBuffer'),
    bufferData: record('bufferData'),
    deleteBuffer: record('deleteBuffer'),

    createVertexArray: () => ({}),
    bindVertexArray: record('bindVertexArray'),
    enableVertexAttribArray: record('enableVertexAttribArray'),
    vertexAttribPointer: record('vertexAttribPointer'),
    deleteVertexArray: record('deleteVertexArray'),

    viewport: record('viewport'),
    disable: record('disable'),
    enable: record('enable'),
    finish: record('finish'),
    clearColor: record('clearColor'),
    clear: record('clear'),
    blendFunc: record('blendFunc'),
    blendFuncSeparate: record('blendFuncSeparate'),
    bindFramebuffer: record('bindFramebuffer'),
    framebufferTextureLayer: record('framebufferTextureLayer'),
    drawBuffers: record('drawBuffers'),
    createFramebuffer: () => ({}),
    deleteFramebuffer: record('deleteFramebuffer'),
    checkFramebufferStatus: () =>
      opts.incompleteFBO ? GL.FRAMEBUFFER_INCOMPLETE : GL.FRAMEBUFFER_COMPLETE,

    drawArrays: (...args: unknown[]): void => {
      record('drawArrays')(...args);
      if (gl.failDraw) throw new Error('simulated GL draw failure');
    },
  };
  return gl as unknown as FakeGL;
}

/**
 * A fake 2D context for the TextLayer: style writes land, every draw method is
 * a no-op, and `measureText` returns a fixed width. Nothing records — the text
 * layer's output is not what the unit tests assert on.
 */
export function makeFake2D(): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {
    measureText: () => ({ width: 42 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
  };
  return new Proxy(target, {
    get(t, prop) {
      if (Reflect.has(t, prop)) return Reflect.get(t, prop);
      return () => undefined;
    },
    set(t, prop, value) {
      Reflect.set(t, prop, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}
