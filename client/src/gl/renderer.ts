/**
 * Live renderer (§8.3, M2 T5) — the first end-to-end visible path.
 *
 * Wires the store's high-frequency column stream to the WebGL2 heatmap:
 *
 *   store.onStream(msg)  →  TileRing.append  →  auto-follow view  →  rAF draw
 *
 * The renderer owns the GL context, one {@link TileRing}, one {@link Heatmap}
 * and the thermal LUT. It subscribes to the store's `onStream` callback (the
 * module-scoped listener Set — NOT React state, so a live feed never triggers a
 * re-render) and, on every {@link DepthColumn}, uploads the column into the ring
 * and re-derives the auto-follow view so the right edge tracks the newest
 * `col_seq`. Forming columns (`final=false`) re-append the same `col_seq`, which
 * overwrites the same tile slot in place (TileRing.append is idempotent per
 * `col_seq`), so the live right edge updates without shifting.
 *
 * Rendering is rAF-driven but redraws ONLY when a `dirty` flag is set (a new
 * column arrived, the view changed, or the canvas resized) — idle frames cost
 * nothing. The GL context is created with `preserveDrawingBuffer` so a skipped
 * frame keeps the last image on screen instead of flashing blank.
 *
 * Bar/Trade/BBO/Marker stream messages are ignored here (overlays are T10) but
 * never crash the renderer. Pan/zoom (T6), mips (T7) and history backfill (T8)
 * are out of scope: the view is a plain auto-follow fit.
 */

import { COLS_PER_TILE, TileRing } from './tileRing';
import { Heatmap, type HeatmapView } from './heatmap';
import { createLUTTexture, RAMP_SYNTH, RAMP_THERMAL } from './lut';
import { initGL, type GLContext } from './context';
import type { StreamMsg } from '../net/connection';
import type { FlowMapState } from '../state/store';
import { MODE_SYNTH_PROFILE, MsgType, type DepthColumn } from '../proto/types';

/** The renderer only needs the store's imperative surface, not the React hook. */
interface RendererStore {
  getState(): FlowMapState;
}

export interface RendererOptions {
  /**
   * Hard-require EXT_color_buffer_float (default false). T5 uses only the
   * array-texture path, which does not need float FBOs; the SUM-mip passes
   * (T7) will flip this to true for the display context.
   */
  requireColorBufferFloat?: boolean;
  /** Target ring capacity in columns; rounded up to whole tile layers. */
  capacityColsTarget?: number;
  /** Approximate on-screen width of one column, in CSS px (auto-follow count). */
  columnPx?: number;
  /** Cap on the auto-follow visible-column count. */
  maxVisibleCols?: number;
}

const DEFAULT_CAPACITY_COLS = 1024;
const DEFAULT_COLUMN_PX = 3;
const DEFAULT_MAX_VISIBLE = 512;
const MIN_VISIBLE_COLS = 32;
const ROW_PAD_FRACTION = 0.08;
const MIN_ROW_PAD = 3;
/** Floor on the normalization divisor so a tiny norm_seed can't blow out intensity. */
const NORM_FLOOR = 6;
/** Fallback norm when the server hasn't sent a norm_seed yet. */
const DEFAULT_NORM = 24;
/** Near-black clear color (matches the CSS --bg so the canvas has no seam). */
const BG = [0.008, 0.016, 0.027, 1] as const;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly store: RendererStore;
  private readonly opts: Required<RendererOptions>;

  private readonly ctx: GLContext;
  private readonly lut: WebGLTexture;

  // Created lazily on the first column, once the row count is known.
  private ring: TileRing | null = null;
  private heatmap: Heatmap | null = null;
  /** Per-slot non-zero row extent (lo/hi), -1 = empty. Sized to ring capacity. */
  private extentLo: Int32Array | null = null;
  private extentHi: Int32Array | null = null;

  private newestSeq = -1;
  private view: HeatmapView = { colOffset: 0, colScale: 1, rowOffset: 0, rowScale: 1 };

  private dirty = false;
  private running = true;
  private rafId = 0;

  private readonly unsubscribeStream: () => void;
  private readonly resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, store: RendererStore, options: RendererOptions = {}) {
    this.canvas = canvas;
    this.store = store;
    this.opts = {
      requireColorBufferFloat: options.requireColorBufferFloat ?? false,
      capacityColsTarget: options.capacityColsTarget ?? DEFAULT_CAPACITY_COLS,
      columnPx: options.columnPx ?? DEFAULT_COLUMN_PX,
      maxVisibleCols: options.maxVisibleCols ?? DEFAULT_MAX_VISIBLE,
    };

    this.ctx = initGL(canvas, {
      requireColorBufferFloat: this.opts.requireColorBufferFloat,
      // Dirty-only render loop: keep the last frame between draws (see file docs).
      preserveDrawingBuffer: true,
    });
    this.lut = createLUTTexture(this.ctx.gl);

    // Match the backing store to the CSS box, then paint the background once so
    // the pre-data canvas is the terminal near-black, not transparent garbage.
    this.resize();
    const gl = this.ctx.gl;
    gl.clearColor(BG[0], BG[1], BG[2], BG[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);

    this.unsubscribeStream = store.getState().onStream(this.onMessage);

    this.rafId = requestAnimationFrame(this.frame);
  }

  /** Newest absolute col_seq appended (or -1 before any column). Diagnostics. */
  get newestColSeq(): number {
    return this.newestSeq;
  }

  /** Resident absolute col_seq range (or null before any column). Diagnostics. */
  residentRange(): ReturnType<TileRing['residentRange']> {
    return this.ring ? this.ring.residentRange() : null;
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.unsubscribeStream();
    this.heatmap?.dispose();
    this.ring?.dispose();
    this.ctx.gl.deleteTexture(this.lut);
  }

  // --- stream handling ----------------------------------------------------------

  private onMessage = (msg: StreamMsg): void => {
    // Overlays (BarColumn / Trade / BBO / Marker) are T10 — ignore, never crash.
    if (msg.type !== MsgType.DEPTH_COL) return;
    this.onDepthColumn(msg);
  };

  private onDepthColumn(col: DepthColumn): void {
    const params = this.store.getState().epochs.get(col.epoch);
    const rows = params?.rows ?? col.bid.length;

    if (this.ring === null) this.createRing(rows);
    const ring = this.ring!;

    if (rows !== ring.rows || col.bid.length !== rows) {
      // A per-epoch row-count change needs a fresh ring (T8); until then a
      // mismatched column is dropped rather than corrupting the upload.
      console.warn(
        `[flowmap] depth column rows ${rows} (bid ${col.bid.length}) ≠ ring rows ${ring.rows}; skipping`,
      );
      return;
    }

    ring.append(col.col_seq, col.epoch, col.bid, col.ask, rows);

    const cap = ring.capacityCols;
    const slot = ((col.col_seq % cap) + cap) % cap;
    const [lo, hi] = columnExtent(col.bid, col.ask, rows);
    this.extentLo![slot] = lo;
    this.extentHi![slot] = hi;

    if (col.col_seq > this.newestSeq) this.newestSeq = col.col_seq;

    // Normalization: the server's per-session norm_seed (p99 of recent nonzero
    // density) is the right ramp divisor; floor it so a small seed can't wash out.
    const seed = this.store.getState().normSeed;
    const norm = seed && seed > 1 ? Math.max(seed, NORM_FLOOR) : DEFAULT_NORM;
    this.heatmap!.encoding = {
      decodeScale: 1,
      norm,
      ramp: col.mode === MODE_SYNTH_PROFILE ? RAMP_SYNTH : RAMP_THERMAL,
    };

    this.updateView();
    this.dirty = true;
  }

  private createRing(rows: number): void {
    if (rows > this.ctx.caps.maxTextureSize) {
      throw new Error(
        `flowmap/renderer: rows ${rows} exceed MAX_TEXTURE_SIZE ${this.ctx.caps.maxTextureSize}`,
      );
    }
    const maxLayers = this.ctx.caps.maxArrayTextureLayers;
    const wantLayers = Math.ceil(this.opts.capacityColsTarget / COLS_PER_TILE);
    const layers = clamp(wantLayers, 2, maxLayers);

    this.ring = new TileRing(this.ctx.gl, rows, layers);
    this.heatmap = new Heatmap(this.ctx, this.ring, this.lut);
    const cap = this.ring.capacityCols;
    this.extentLo = new Int32Array(cap).fill(-1);
    this.extentHi = new Int32Array(cap).fill(-1);
  }

  // --- view + draw --------------------------------------------------------------

  /**
   * Recompute the auto-follow view: time axis pinned to the newest columns,
   * price axis fit to the non-zero book rows across the visible window.
   */
  private updateView(): void {
    const ring = this.ring;
    if (ring === null) return;
    const range = ring.residentRange();
    if (range === null) return;

    const cap = ring.capacityCols;
    const cssW = Math.max(1, this.canvas.clientWidth);
    let visible = Math.round(cssW / this.opts.columnPx);
    visible = clamp(visible, MIN_VISIBLE_COLS, this.opts.maxVisibleCols);
    // Fill the width with what we have, then lock and scroll once it's full.
    visible = Math.min(visible, cap, range.count);

    const newest = range.newest;
    const colOffset = newest - visible + 1;

    // Price fit: union of non-zero row extents over the visible columns.
    let lo = Infinity;
    let hi = -Infinity;
    const oldestVisible = Math.max(colOffset, range.oldest);
    for (let s = oldestVisible; s <= newest; s++) {
      const slot = ((s % cap) + cap) % cap;
      const elo = this.extentLo![slot];
      if (elo < 0) continue;
      const ehi = this.extentHi![slot];
      if (elo < lo) lo = elo;
      if (ehi > hi) hi = ehi;
    }

    let rowOffset: number;
    let rowScale: number;
    if (hi < lo) {
      // No non-zero rows yet: show the whole price grid.
      rowOffset = 0;
      rowScale = ring.rows;
    } else {
      const pad = Math.max(MIN_ROW_PAD, Math.round((hi - lo) * ROW_PAD_FRACTION));
      const bottom = Math.max(0, lo - pad);
      const top = Math.min(ring.rows, hi + pad + 1);
      rowOffset = bottom;
      rowScale = Math.max(1, top - bottom);
    }

    this.view = { colOffset, colScale: visible, rowOffset, rowScale };
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, this.canvas.clientWidth);
    const ch = Math.max(1, this.canvas.clientHeight);
    const w = Math.max(1, Math.round(cw * dpr));
    const h = Math.max(1, Math.round(ch * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    // Visible-column count depends on CSS width; refit and repaint.
    this.updateView();
    this.dirty = true;
  }

  private frame = (): void => {
    if (!this.running) return;
    if (this.dirty && this.heatmap !== null) {
      this.heatmap.draw(this.view);
      this.dirty = false;
    }
    this.rafId = requestAnimationFrame(this.frame);
  };
}

/**
 * First and last row index carrying non-zero density (bid or ask). Returns
 * `[-1, -1]` when the column is entirely empty. Cheap linear scan — runs once
 * per appended column (≤ a few per second live).
 */
function columnExtent(
  bid: Float32Array,
  ask: Float32Array | null,
  rows: number,
): [number, number] {
  let lo = -1;
  let hi = -1;
  for (let r = 0; r < rows; r++) {
    if (bid[r] > 0 || (ask !== null && ask[r] > 0)) {
      if (lo < 0) lo = r;
      hi = r;
    }
  }
  return [lo, hi];
}
