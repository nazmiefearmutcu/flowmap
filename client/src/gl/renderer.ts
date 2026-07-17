/**
 * Live renderer (§8.3, M2 T5 + T6) — the end-to-end visible path with pan/zoom.
 *
 * Wires the store's high-frequency column stream to the WebGL2 heatmap:
 *
 *   store.onStream(msg)  →  TileRing.append  →  Camera (view)  →  rAF draw
 *
 * The renderer owns the GL context, one {@link TileRing}, one {@link Heatmap},
 * the thermal LUT, and one {@link Camera}. It subscribes to the store's
 * `onStream` callback (the module-scoped listener Set — NOT React state, so a
 * live feed never triggers a re-render) and, on every {@link DepthColumn},
 * uploads the column into the ring; when the camera is FOLLOWING it re-derives
 * the auto-follow frame so the right edge tracks the newest `col_seq`.
 *
 * T6 view transform: pan/zoom is the {@link Camera} — five scalars → four view
 * uniforms. A user gesture (wheel/drag/keyboard, see input/gestures) turns follow
 * OFF and the view is whatever the camera says; `F`/`R` turn it back on. A
 * column, once uploaded, is NEVER re-uploaded or re-rasterized on pan/zoom
 * (§8.3): interaction cost is O(1) in history depth — this is exactly the v1
 * 1-fps bug (CPU re-raster of all history every pan frame) structurally removed.
 *
 * Rendering is rAF-driven but redraws ONLY when `dirty` is set (new column, view
 * change, or resize) — idle frames cost nothing. The GL context uses
 * `preserveDrawingBuffer` so a skipped frame keeps the last image on screen.
 *
 * Bar/Trade/BBO/Marker stream messages are ignored here (overlays are T10) but
 * never crash the renderer. Mips (T7) and history backfill (T8) are out of scope.
 */

import { COLS_PER_TILE, TileRing } from './tileRing';
import { Heatmap, type HeatmapView } from './heatmap';
import { createLUTTexture, RAMP_SYNTH, RAMP_THERMAL } from './lut';
import { initGL, type GLContext } from './context';
import { Camera, limitsFor } from './camera';
import { attachGestures, type CameraController } from '../input/gestures';
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

/** Timing samples from a scripted pan/zoom perf run (test hook). */
export interface PerfResult {
  /** rAF frame-to-frame deltas in ms. */
  deltas: number[];
  /** Per-frame draw+finish cost in ms (the history-independent metric). */
  drawMs: number[];
  /** Frames drawn during the run. */
  frames: number;
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
/** Keyboard pan step as a fraction of the current viewport span. */
const KEY_PAN_FRAC = 0.15;
/** Near-black clear color (matches the CSS --bg so the canvas has no seam). */
const BG = [0.008, 0.016, 0.027, 1] as const;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

interface PerfRun {
  kind: 'pan' | 'zoom';
  deadline: number;
  deltas: number[];
  drawMs: number[];
  lastTs: number;
  panStep: number;
  zoomAnchor: number;
  zoomDir: number;
  zoomMax: number;
  resolve: (r: PerfResult) => void;
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly store: RendererStore;
  private readonly opts: Required<RendererOptions>;

  private readonly ctx: GLContext;
  private readonly lut: WebGLTexture;
  private readonly camera: Camera;

  // Created lazily on the first column, once the row count is known.
  private ring: TileRing | null = null;
  private heatmap: Heatmap | null = null;
  /** Per-slot non-zero row extent (lo/hi), -1 = empty. Sized to ring capacity. */
  private extentLo: Int32Array | null = null;
  private extentHi: Int32Array | null = null;

  private newestSeq = -1;
  private view: HeatmapView;

  private dirty = false;
  private running = true;
  private rafId = 0;

  // Perf instrumentation (test hooks): draw bookkeeping + a scripted run.
  private drawCountN = 0;
  private lastDrawEndTsN = 0;
  private perf: PerfRun | null = null;

  private readonly unsubscribeStream: () => void;
  private readonly resizeObserver: ResizeObserver;
  private readonly gesturesDispose: () => void;

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

    // Provisional limits until the first column reveals the row count; follow ON.
    this.camera = new Camera(limitsFor(1, this.opts.capacityColsTarget));
    this.view = this.camera.toView();

    // Match the backing store to the CSS box, then paint the background once so
    // the pre-data canvas is the terminal near-black, not transparent garbage.
    this.resize();
    const gl = this.ctx.gl;
    gl.clearColor(BG[0], BG[1], BG[2], BG[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);

    this.gesturesDispose = attachGestures(canvas, this.makeController());

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

  /** Whether the camera is auto-following the live right edge. Diagnostics. */
  get following(): boolean {
    return this.camera.follow;
  }

  /** A copy of the current view uniforms. Diagnostics / e2e. */
  get viewSnapshot(): HeatmapView {
    return { ...this.view };
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.gesturesDispose();
    this.unsubscribeStream();
    this.heatmap?.dispose();
    this.ring?.dispose();
    this.ctx.gl.deleteTexture(this.lut);
  }

  // --- gesture control (input/gestures → Camera) --------------------------------

  private makeController(): CameraController {
    const cssW = (): number => Math.max(1, this.canvas.clientWidth);
    const cssH = (): number => Math.max(1, this.canvas.clientHeight);
    return {
      panByPixels: (dx, dy) => {
        // Natural drag: content follows the cursor. Right → earlier columns
        // (colCenter decreases); down → higher rows (rowCenter increases).
        const dCols = -(dx / cssW()) * this.view.colScale;
        const dRows = (dy / cssH()) * this.view.rowScale;
        this.camera.pan(dCols, dRows);
        this.onCameraChanged();
      },
      zoomTimeAtPixel: (factor, cursorX) => {
        const anchorCol = this.view.colOffset + this.view.colScale * (cursorX / cssW());
        this.camera.zoomTime(factor, anchorCol);
        this.onCameraChanged();
      },
      zoomPriceAtPixel: (factor, cursorY) => {
        // uv.y = 0 at the bottom of the grid; the cursor's y grows downward.
        const uvY = 1 - cursorY / cssH();
        const anchorRow = this.view.rowOffset + this.view.rowScale * uvY;
        this.camera.zoomPrice(factor, anchorRow);
        this.onCameraChanged();
      },
      panTimeSteps: (dir) => {
        this.camera.pan(dir * this.view.colScale * KEY_PAN_FRAC, 0);
        this.onCameraChanged();
      },
      panPriceSteps: (dir) => {
        this.camera.pan(0, dir * this.view.rowScale * KEY_PAN_FRAC);
        this.onCameraChanged();
      },
      zoomTimeCentered: (factor) => {
        this.camera.zoomTime(factor, this.camera.state.colCenter);
        this.onCameraChanged();
      },
      toggleFollow: () => {
        if (this.camera.follow) {
          this.camera.state.follow = false; // freeze on the current view
        } else {
          this.camera.state.follow = true;
          this.updateView(); // snap back to the live edge immediately
        }
        this.dirty = true;
      },
      goLive: () => {
        this.camera.reset(this.residentRange(), this.ring?.rows);
        this.updateView();
        this.dirty = true;
      },
    };
  }

  /** A user gesture changed the camera: recompute uniforms, request a redraw. */
  private onCameraChanged(): void {
    this.view = this.camera.toView();
    this.dirty = true;
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

    // Real geometry known: update the camera's clamps and (re)frame live.
    this.camera.setLimits(limitsFor(rows, cap));
    this.camera.reset(this.ring.residentRange(), rows);
  }

  // --- view + draw --------------------------------------------------------------

  /**
   * Recompute the view uniforms. When FOLLOWING, re-derive the auto-follow frame
   * (time pinned to the newest columns, price fit to the visible book) and hand
   * it to the camera; when the user has taken over (follow off) the camera's
   * pan/zoom state is authoritative and only the uniform cache is refreshed.
   */
  private updateView(): void {
    if (this.camera.follow) this.applyFollowFrame();
    this.view = this.camera.toView();
  }

  /** Time = right edge at newest; price = fit to non-zero book over the window. */
  private applyFollowFrame(): void {
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
    const colLeft = newest - visible + 1;

    // Price fit: union of non-zero row extents over the visible columns.
    let lo = Infinity;
    let hi = -Infinity;
    const oldestVisible = Math.max(colLeft, range.oldest);
    for (let s = oldestVisible; s <= newest; s++) {
      const slot = ((s % cap) + cap) % cap;
      const elo = this.extentLo![slot];
      if (elo < 0) continue;
      const ehi = this.extentHi![slot];
      if (elo < lo) lo = elo;
      if (ehi > hi) hi = ehi;
    }

    let rowBottom: number;
    let rowSpan: number;
    if (hi < lo) {
      // No non-zero rows yet: show the whole price grid.
      rowBottom = 0;
      rowSpan = ring.rows;
    } else {
      const pad = Math.max(MIN_ROW_PAD, Math.round((hi - lo) * ROW_PAD_FRACTION));
      const bottom = Math.max(0, lo - pad);
      const top = Math.min(ring.rows, hi + pad + 1);
      rowBottom = bottom;
      rowSpan = Math.max(1, top - bottom);
    }

    this.camera.setFollowFrame(colLeft, visible, rowBottom, rowSpan);
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
    // Visible-column count depends on CSS width; refit (follow) and repaint.
    this.updateView();
    this.dirty = true;
  }

  private frame = (ts: number): void => {
    if (!this.running) return;

    const perf = this.perf;
    if (perf) {
      if (perf.lastTs > 0) perf.deltas.push(ts - perf.lastTs);
      perf.lastTs = ts;
      this.stepPerf(perf);
      this.dirty = true; // force a redraw every frame while measuring
    }

    if (this.dirty && this.heatmap !== null) {
      const t0 = performance.now();
      this.heatmap.draw(this.view);
      if (perf) {
        // Flush the (software) GL pipeline so the sample is the true frame cost.
        this.ctx.gl.finish();
        perf.drawMs.push(performance.now() - t0);
      }
      this.dirty = false;
      this.drawCountN++;
      this.lastDrawEndTsN = performance.now();
    }

    if (perf && ts >= perf.deadline) {
      this.perf = null;
      perf.resolve({ deltas: perf.deltas, drawMs: perf.drawMs, frames: perf.drawMs.length });
    }

    this.rafId = requestAnimationFrame(this.frame);
  };

  /** Apply this frame's scripted camera op during a perf run. */
  private stepPerf(perf: PerfRun): void {
    if (perf.kind === 'pan') {
      // Scroll the view steadily back through history (real pan op, follow off).
      this.camera.pan(perf.panStep, 0);
    } else {
      const span = this.camera.state.colSpan;
      if (span <= this.camera.limits.minColSpan * 1.5) perf.zoomDir = 1;
      else if (span >= perf.zoomMax) perf.zoomDir = -1;
      const f = perf.zoomDir < 0 ? 0.97 : 1 / 0.97;
      this.camera.zoomTime(f, perf.zoomAnchor);
    }
    this.view = this.camera.toView();
  }

  // --- test-only perf hooks (driven by tests/e2e/perf.spec) ---------------------

  /** Frames drawn so far (monotonic). */
  get drawCount(): number {
    return this.drawCountN;
  }

  /** performance.now() at the end of the last draw (input→frame latency proxy). */
  get lastDrawEndTs(): number {
    return this.lastDrawEndTsN;
  }

  /**
   * Preload `count` deterministic synthetic columns (wall + noise) straight into
   * a fresh ring sized to hold them at `rows` height — bypassing the network so
   * the §10 perf gate can measure pan/zoom over a real 10 k-column history.
   * Returns the ring geometry + allocation bytes for the memory gate.
   */
  preloadSynthetic(count: number, rows: number): {
    rows: number;
    layers: number;
    capacityCols: number;
    ringBytes: number;
    resident: number;
  } {
    if (rows > this.ctx.caps.maxTextureSize) {
      throw new Error(`preloadSynthetic: rows ${rows} > MAX_TEXTURE_SIZE ${this.ctx.caps.maxTextureSize}`);
    }
    this.heatmap?.dispose();
    this.ring?.dispose();
    this.heatmap = null;
    this.ring = null;

    const wantLayers = Math.ceil(count / COLS_PER_TILE);
    const layers = clamp(wantLayers, 2, this.ctx.caps.maxArrayTextureLayers);
    const ring = new TileRing(this.ctx.gl, rows, layers);
    const heatmap = new Heatmap(this.ctx, ring, this.lut);
    this.ring = ring;
    this.heatmap = heatmap;
    const cap = ring.capacityCols;
    this.extentLo = new Int32Array(cap).fill(-1);
    this.extentHi = new Int32Array(cap).fill(-1);
    this.camera.setLimits(limitsFor(rows, cap));

    const bid = new Float32Array(rows);
    const ask = new Float32Array(rows);
    const n = Math.min(count, cap);
    for (let s = 0; s < n; s++) {
      fillSyntheticColumn(bid, ask, s, rows);
      ring.append(s, 0, bid, ask, rows);
      const slot = s % cap;
      const [lo, hi] = columnExtent(bid, ask, rows);
      this.extentLo[slot] = lo;
      this.extentHi[slot] = hi;
    }
    this.newestSeq = n - 1;
    heatmap.encoding = { decodeScale: 1, norm: 150, ramp: RAMP_THERMAL };
    this.camera.reset(ring.residentRange(), rows);
    this.updateView();
    this.dirty = true;

    // RG16F storage: colsPerTile × rows × layers texels × 2 channels × 2 bytes.
    const ringBytes = COLS_PER_TILE * rows * layers * 2 * 2;
    return { rows, layers, capacityCols: cap, ringBytes, resident: n };
  }

  /** Run a scripted continuous PAN for `durationMs`; resolves with frame timing. */
  perfPan(durationMs: number, panStepCols = 2): Promise<PerfResult> {
    this.camera.state.follow = false;
    return new Promise((resolve) => {
      this.perf = {
        kind: 'pan',
        deadline: performance.now() + durationMs,
        deltas: [],
        drawMs: [],
        lastTs: 0,
        panStep: panStepCols,
        zoomAnchor: 0,
        zoomDir: -1,
        zoomMax: 0,
        resolve,
      };
    });
  }

  /** Run a scripted continuous time ZOOM for `durationMs`; resolves with timing. */
  perfZoom(durationMs: number): Promise<PerfResult> {
    this.camera.state.follow = false;
    const range = this.residentRange();
    const zoomMax = Math.min(
      this.camera.limits.maxColSpan,
      range ? Math.max(64, range.count) : 2000,
    );
    return new Promise((resolve) => {
      this.perf = {
        kind: 'zoom',
        deadline: performance.now() + durationMs,
        deltas: [],
        drawMs: [],
        lastTs: 0,
        panStep: 0,
        zoomAnchor: this.camera.state.colCenter,
        zoomDir: -1,
        zoomMax,
        resolve,
      };
    });
  }
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

/**
 * Deterministic synthetic depth column for the perf preload: a slowly drifting
 * bright "wall" (a liquidity band) plus sparse low-density noise. Pure function
 * of (colSeq, row) so the preload is reproducible and cheap (O(rows)).
 */
function fillSyntheticColumn(bid: Float32Array, ask: Float32Array, s: number, rows: number): void {
  const center = (rows >> 1) + Math.round(Math.sin(s * 0.02) * rows * 0.1);
  for (let r = 0; r < rows; r++) {
    bid[r] = 0;
    ask[r] = 0;
    const dist = Math.abs(r - center);
    if (dist <= 2) {
      bid[r] = 100;
      ask[r] = 100;
    } else {
      // Cheap integer hash → sparse noise so the heatmap isn't a bare wall.
      const h = ((s * 2654435761 + r * 40503) >>> 0) % 1000;
      if (h < 150) {
        const v = (h / 1000) * 12;
        if (r < center) bid[r] = v;
        else ask[r] = v;
      }
    }
  }
}
