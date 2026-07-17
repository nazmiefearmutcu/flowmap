/**
 * WebGL2 context bring-up (§8.3).
 *
 * Creates the one context the whole renderer shares, probes the capability
 * limits the tile-ring residency math depends on, and requires the extensions
 * the mip/FBO passes (a later task) will need. `EXT_color_buffer_float` is a
 * hard requirement per §8.3 — it makes RG16F color-renderable so the SUM
 * downsample passes can render into float FBOs. The array texture + texelFetch
 * sampling this task delivers works without it, so `requireColorBufferFloat`
 * can be relaxed to a warning in environments (e.g. some CI GL backends) that
 * lack it; production keeps it hard.
 */

export interface GLCaps {
  /** MAX_TEXTURE_IMAGE_UNITS — the 16-unit bind limit texelFetch sidesteps. */
  maxTextureImageUnits: number;
  /** MAX_ARRAY_TEXTURE_LAYERS — caps how many tile layers a ring can hold. */
  maxArrayTextureLayers: number;
  /** MAX_TEXTURE_SIZE — caps rows (price grid height) and cols-per-tile. */
  maxTextureSize: number;
  /** Whether EXT_color_buffer_float was obtained (float FBOs available). */
  colorBufferFloat: boolean;
}

export interface GLContext {
  gl: WebGL2RenderingContext;
  caps: GLCaps;
}

export interface InitGLOptions {
  /**
   * Throw if EXT_color_buffer_float is absent (default true, per §8.3). Set
   * false to downgrade to a console warning when only the array-texture path
   * is needed and the backend lacks the extension.
   */
  requireColorBufferFloat?: boolean;
  /**
   * Keep the drawing buffer contents after compositing (default false). The
   * live renderer (T5) draws only on dirty frames; without this the compositor
   * clears the buffer between draws and idle frames would flash blank. Costs
   * some driver-side optimization, so only the display path sets it.
   */
  preserveDrawingBuffer?: boolean;
}

const GL_ERROR_NAMES: Record<number, string> = {
  0x0500: 'INVALID_ENUM',
  0x0501: 'INVALID_VALUE',
  0x0502: 'INVALID_OPERATION',
  0x0505: 'OUT_OF_MEMORY',
  0x0506: 'INVALID_FRAMEBUFFER_OPERATION',
  0x0507: 'CONTEXT_LOST_WEBGL',
};

/**
 * Throw if the GL error queue is non-empty, tagging the failure with `label`.
 * Drains the queue so one error does not mask later checks. No-op on success —
 * cheap enough to sprinkle after every state-changing batch during bring-up.
 */
export function checkGLError(gl: WebGL2RenderingContext, label: string): void {
  const errors: string[] = [];
  // Bounded loop: never spin forever if the context is lost.
  for (let i = 0; i < 16; i++) {
    const e = gl.getError();
    if (e === gl.NO_ERROR) break;
    errors.push(GL_ERROR_NAMES[e] ?? `0x${e.toString(16)}`);
  }
  if (errors.length > 0) {
    throw new Error(`flowmap/gl: GL error(s) at ${label}: ${errors.join(', ')}`);
  }
}

export function initGL(canvas: HTMLCanvasElement, opts: InitGLOptions = {}): GLContext {
  const requireColorBufferFloat = opts.requireColorBufferFloat ?? true;

  const gl = canvas.getContext('webgl2', {
    antialias: false,
    premultipliedAlpha: false,
    // Depth/stencil are useless for a 2D heatmap; skip the allocation.
    depth: false,
    stencil: false,
    preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
  });
  if (!gl) {
    throw new Error('flowmap/gl: WebGL2 is not available in this browser/context');
  }

  const colorBufferFloat = gl.getExtension('EXT_color_buffer_float') !== null;
  if (!colorBufferFloat) {
    const msg =
      'flowmap/gl: EXT_color_buffer_float is required (§8.3: RG16F must be ' +
      'color-renderable for the SUM mip passes)';
    if (requireColorBufferFloat) {
      throw new Error(msg);
    }
    console.warn(`${msg} — continuing (array-texture path only; mips unavailable)`);
  }

  const caps: GLCaps = {
    maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
    maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    colorBufferFloat,
  };

  checkGLError(gl, 'initGL');
  return { gl, caps };
}
