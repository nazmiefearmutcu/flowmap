/**
 * Deterministic e2e hook for the WebGL2 heatmap (T4 verification).
 *
 * Installed on `window.__flowmapTest` ONLY when the app is opened with
 * `?test=heatmap` (see App.tsx) so production builds never expose it. It lets a
 * Playwright spec drive the real renderer in a real browser and read pixels
 * back — GL cannot be meaningfully unit-mocked. Live wiring to the WS stream is
 * T5; this hook feeds synthetic columns instead.
 */

import type { GLContext } from './context';
import { initGL } from './context';
import { Heatmap, selectLevel, type HeatmapView } from './heatmap';
import { createLUTTexture, RAMP_SYNTH, RAMP_THERMAL } from './lut';
import { MipChain } from './mips';
import { COLS_PER_TILE, TileRing, type ResidentRange } from './tileRing';

export interface FlowmapTestApi {
  /**
   * Create context+ring+lut+heatmap on the canvas at a fixed pixel size. Pass
   * `mips=true` (T7) to build + attach the SUM-mip chain so zoom-out sampling
   * exercises the coarse levels (requires EXT_color_buffer_float; the returned
   * `mipsEnabled` reports whether it was actually created).
   */
  init(rows: number, layers: number, width?: number, height?: number, mips?: boolean): {
    maxTextureImageUnits: number;
    maxArrayTextureLayers: number;
    maxTextureSize: number;
    colorBufferFloat: boolean;
    canvasWidth: number;
    canvasHeight: number;
    mipsEnabled: boolean;
    maxMipLevel: number;
  };
  /** Append one synthetic column. `ask` null → SYNTH_PROFILE (amber ramp path). */
  appendColumn(colSeq: number, bid: number[], ask: number[] | null): void;
  setEncoding(decodeScale: number, norm: number, synth?: boolean): void;
  setView(view: HeatmapView): void;
  /** Fit-to-resident view (fills the canvas with all resident columns). */
  fitView(): HeatmapView;
  render(): void;
  /** Draw fresh, then read back RGBA bytes (origin bottom-left). */
  readPixels(x: number, y: number, w: number, h: number): number[];
  residentRange(): ResidentRange | null;
  /** The SUM-mip level the current view+canvas would sample (T7 diagnostics). */
  levelInfo(): { rowsPerPixel: number; level: number; blk: number; nRowTaps: number };
  dispose(): void;
}

interface HookState {
  ctx: GLContext;
  ring: TileRing;
  heatmap: Heatmap;
  mips: MipChain | null;
  view: HeatmapView;
}

export function installHeatmapTestHook(canvas: HTMLCanvasElement): void {
  let state: HookState | null = null;

  const api: FlowmapTestApi = {
    init(rows, layers, width = 512, height = 512, mips = false) {
      canvas.width = width;
      canvas.height = height;
      // EXT_color_buffer_float may be absent on some CI GL backends; the
      // array-texture path this task delivers does not need it, so warn-only
      // here to keep the harness runnable. Production keeps it a hard require.
      const ctx = initGL(canvas, { requireColorBufferFloat: false });
      const ring = new TileRing(ctx.gl, rows, layers);
      const lut = createLUTTexture(ctx.gl);
      const heatmap = new Heatmap(ctx, ring, lut);
      // SUM-mip chain (T7): only when requested AND float FBOs are available.
      let mipChain: MipChain | null = null;
      if (mips && ctx.caps.colorBufferFloat) {
        mipChain = new MipChain(ctx, COLS_PER_TILE, rows, layers);
        heatmap.mips = mipChain;
      }
      state = { ctx, ring, heatmap, mips: mipChain, view: heatmap.fitView() };
      return {
        maxTextureImageUnits: ctx.caps.maxTextureImageUnits,
        maxArrayTextureLayers: ctx.caps.maxArrayTextureLayers,
        maxTextureSize: ctx.caps.maxTextureSize,
        colorBufferFloat: ctx.caps.colorBufferFloat,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        mipsEnabled: mipChain !== null,
        maxMipLevel: mipChain ? mipChain.maxLevel : 0,
      };
    },

    appendColumn(colSeq, bid, ask) {
      if (!state) throw new Error('__flowmapTest: init() first');
      state.ring.append(
        colSeq,
        0,
        Float32Array.from(bid),
        ask === null ? null : Float32Array.from(ask),
        state.ring.rows,
      );
      // Incremental SUM-mip regen for the affected 4/16-column group (T7).
      state.mips?.updateFrom(state.ring, colSeq);
    },

    setEncoding(decodeScale, norm, synth = false) {
      if (!state) throw new Error('__flowmapTest: init() first');
      state.heatmap.encoding = {
        decodeScale,
        norm,
        ramp: synth ? RAMP_SYNTH : RAMP_THERMAL,
      };
    },

    setView(view) {
      if (!state) throw new Error('__flowmapTest: init() first');
      state.view = view;
    },

    fitView() {
      if (!state) throw new Error('__flowmapTest: init() first');
      state.view = state.heatmap.fitView();
      return state.view;
    },

    render() {
      if (!state) throw new Error('__flowmapTest: init() first');
      state.heatmap.draw(state.view);
    },

    readPixels(x, y, w, h) {
      if (!state) throw new Error('__flowmapTest: init() first');
      // Redraw immediately before reading so the back buffer is fresh even
      // without preserveDrawingBuffer (the compositor may have cleared it
      // between JS turns).
      state.heatmap.draw(state.view);
      const buf = new Uint8Array(w * h * 4);
      state.ctx.gl.readPixels(x, y, w, h, state.ctx.gl.RGBA, state.ctx.gl.UNSIGNED_BYTE, buf);
      return Array.from(buf);
    },

    residentRange() {
      if (!state) throw new Error('__flowmapTest: init() first');
      return state.ring.residentRange();
    },

    levelInfo() {
      if (!state) throw new Error('__flowmapTest: init() first');
      const maxLevel = state.mips ? state.mips.maxLevel : 0;
      const rowsPerPixel = state.view.rowScale / Math.max(1, state.ctx.gl.drawingBufferHeight);
      return { rowsPerPixel, ...selectLevel(rowsPerPixel, maxLevel) };
    },

    dispose() {
      if (!state) return;
      state.mips?.dispose();
      state.heatmap.dispose();
      state.ring.dispose();
      state = null;
    },
  };

  (window as unknown as { __flowmapTest: FlowmapTestApi }).__flowmapTest = api;
}
