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
import {
  Heatmap,
  effectiveRowMode,
  levelBlendFor,
  selectLevel,
  type HeatmapView,
} from './heatmap';
import {
  createLUTTexture,
  rampForMode,
  RAMP_SYNTH,
  RAMP_INFERNO,
  RAMP_THEME,
  RAMP_THEME_SYNTH,
  setThemeStops,
  uploadLUTAtlas,
  type Colormap,
  type RampStop,
} from './lut';
import { MipChain } from './mips';
import { MODE_L2 } from '../proto/types';
import { COLS_PER_TILE, TileRing, type ResidentRange } from './tileRing';

/** Additive per-draw sampler diagnostics (campaign visual 2026-09-11). */
export interface HeatmapSampleInfo {
  colsPerPixel: number;
  colBlur: number;
  colCell: number;
  /** Row-mip cross-fade weight of the last draw (lane P; 0..1). */
  rowFade: number;
  /** SUM-mip level cross-fade weight of the last draw (wave P2; 0..1). */
  levelFade: number;
  /** Finer level blended into the last draw (k-1), or -1 for a pure level. */
  finerLevel: number;
}

/**
 * L3's `Heatmap.sampleInfo()` — read through an optional handle so this lane
 * type-checks before/after that method lands; values default 1/1/0/0 (before
 * the first draw) exactly as the contract specifies.
 */
function sampleInfoOf(heatmap: Heatmap): HeatmapSampleInfo {
  const fn = (
    heatmap as unknown as {
      sampleInfo?: () => HeatmapSampleInfo;
    }
  ).sampleInfo;
  if (typeof fn === 'function') return fn.call(heatmap);
  return { colsPerPixel: 1, colBlur: 1, colCell: 0, rowFade: 0, levelFade: 0, finerLevel: -1 };
}

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
  /**
   * Register theme stops into the lut store and re-upload atlas rows 5/6
   * (campaign visual 2026-09-11). `null`/`null` restores the flow/synth identity.
   */
  setThemeRamp(density: readonly RampStop[] | null, synth: readonly RampStop[] | null): void;
  /** Select a colormap family row via the real {@link rampForMode} rule; with
   *  `'theme'` the theme-owned rows 5/6 are used (register them first). */
  setColormap(colormap: Colormap): void;
  setView(view: HeatmapView): void;
  /** Fit-to-resident view (fills the canvas with all resident columns). */
  fitView(): HeatmapView;
  render(): void;
  /** Draw fresh, then read back RGBA bytes (origin bottom-left). */
  readPixels(x: number, y: number, w: number, h: number): number[];
  residentRange(): ResidentRange | null;
  /**
   * The SUM-mip level the current view+canvas would sample (T7 diagnostics),
   * plus (campaign visual 2026-09-11) the last-draw level-0 sampler weights:
   * `colsPerPixel` (view scale), `colBlur` (3-tap column blend amount) and
   * `colCell` (crisp nearest-column cell weight). Defaults 1/1/0 before a draw.
   * `rowOnly`/`rowFade` mirror the real draw's lane-P row-mip selection: they
   * come from the SAME {@link effectiveRowMode} helper the draw calls (fade > 0
   * && a usable row chain), so the report can never drift from the paint.
   * `levelFade`/`finerLevel` likewise mirror the wave-P2 SUM-mip level
   * cross-fade through the SAME {@link levelBlendFor} helper: fade 0 means the
   * legacy level upload (no second sample, finerLevel -1); inside a transition
   * band `finerLevel` is the level blended in (k-1). The row path never blends
   * levels, so both read 0/-1 while `rowFade > 0`.
   */
  levelInfo(): {
    rowsPerPixel: number;
    level: number;
    blk: number;
    nRowTaps: number;
    colsPerPixel: number;
    colBlur: number;
    colCell: number;
    rowOnly: boolean;
    rowFade: number;
    levelFade: number;
    finerLevel: number;
  };
  /**
   * Set the tick-grouping mip floor (contract P1; campaign 4) on the hook's
   * Heatmap: 0 = off, 1 = 4-row cells, 2 = 16-row cells (clamped to the chain).
   * Lets the e2e lane pixel-probe that a forced level actually SUMS rows.
   */
  setLevelFloor(levelFloor: number): void;
  /** `levelInfo` evaluated WITH a candidate floor (no mutation). */
  levelInfoWithFloor(levelFloor: number): { rowsPerPixel: number; level: number; blk: number; nRowTaps: number };
  dispose(): void;
}

interface HookState {
  ctx: GLContext;
  ring: TileRing;
  heatmap: Heatmap;
  /** The LUT texture handed to the Heatmap — re-specified by `setThemeRamp`. */
  lut: WebGLTexture;
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
      state = { ctx, ring, heatmap, lut, mips: mipChain, view: heatmap.fitView() };
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
        ramp: synth ? RAMP_SYNTH : RAMP_INFERNO,
      };
    },

    setThemeRamp(density, synth) {
      if (!state) throw new Error('__flowmapTest: init() first');
      setThemeStops(density && synth ? { density, synth } : null);
      uploadLUTAtlas(state.ctx.gl, state.lut);
    },

    setColormap(colormap) {
      if (!state) throw new Error('__flowmapTest: init() first');
      const themed =
        colormap === 'theme' ? { density: RAMP_THEME, synth: RAMP_THEME_SYNTH } : null;
      state.heatmap.encoding = {
        ...state.heatmap.encoding,
        ramp: rampForMode(MODE_L2, 'L2', colormap, themed),
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
      const gl = state.ctx.gl;
      const maxLevel = state.mips ? state.mips.maxLevel : 0;
      const rowsPerPixel = state.view.rowScale / Math.max(1, gl.drawingBufferHeight);
      const colsPerPixel = state.view.colScale / Math.max(1, gl.drawingBufferWidth);
      // Lane P: `rowOnly`/`rowFade` mirror the draw's selection through the SAME
      // helper the draw uses (with the same tick-grouping floor folded into the
      // eligibility), so the additive report can never drift from the paint.
      const sel = selectLevel(rowsPerPixel, maxLevel, colsPerPixel, state.heatmap.levelFloor);
      const rowEligible = sel.rowOnly === true && state.mips !== null && state.mips.rowUsable;
      const field = effectiveRowMode(rowsPerPixel, rowEligible);
      // Wave P2: mirror the draw's SUM-path level cross-fade for the CURRENT
      // view through the same pure helper. The row path owns the row axis and
      // never blends levels, so it reports fade 0 / finer -1.
      const blend = levelBlendFor(
        Math.max(rowsPerPixel, colsPerPixel),
        maxLevel,
        state.heatmap.levelFloor,
      );
      return {
        rowsPerPixel,
        ...sel,
        ...sampleInfoOf(state.heatmap),
        rowOnly: field.rowOnly,
        rowFade: field.rowFade,
        levelFade: field.rowFade > 0 ? 0 : blend.fade,
        finerLevel: field.rowFade > 0 ? -1 : blend.finerLevel,
      };
    },

    setLevelFloor(levelFloor) {
      if (!state) throw new Error('__flowmapTest: init() first');
      const maxLevel = state.mips ? state.mips.maxLevel : 0;
      state.heatmap.levelFloor = Math.max(0, Math.min(maxLevel, Math.floor(levelFloor) || 0));
    },

    levelInfoWithFloor(levelFloor) {
      if (!state) throw new Error('__flowmapTest: init() first');
      const maxLevel = state.mips ? state.mips.maxLevel : 0;
      const rowsPerPixel = state.view.rowScale / Math.max(1, state.ctx.gl.drawingBufferHeight);
      return { rowsPerPixel, ...selectLevel(rowsPerPixel, maxLevel, 1, levelFloor) };
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
