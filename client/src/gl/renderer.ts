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
 * never crash the renderer.
 *
 * T8 deep scroll-back: the ring is a bounded full-res window over history. When
 * the user pans LEFT past the oldest resident column, the {@link HistoryLoader}
 * fetches older columns and splices them at their true absolute col_seq (the
 * ring slides its window back, evicting the live edge — see gl/tileRing). While
 * the user is scrolled back, live columns at the right edge are NOT written
 * (they'd steal the ring from the viewed region); they resume on go-live. A
 * `webglcontextlost` recreates every GL object and re-fetches the visible range.
 */

import { COLS_PER_TILE, TileRing } from './tileRing';
import { Heatmap, selectLevel, type HeatmapView } from './heatmap';
import { createLUTTexture, rampForMode, RAMP_THERMAL } from './lut';
import { MipChain } from './mips';
import { initGL, type GLContext } from './context';
import { Camera, limitsFor, screenToGrid } from './camera';
import { ViewportNormalizer } from './normalize';
import { ColumnCache } from './columnCache';
import { attachGestures, type CameraController } from '../input/gestures';
import { HistoryLoader } from '../net/history';
import type { StreamMsg } from '../net/connection';
import type { FlowMapState } from '../state/store';
import { MODE_L2, MsgType, type DepthColumn } from '../proto/types';
import { OverlayManager } from './overlays/manager';
import type { OverlayVisibility } from './overlays/frame';
import type { PriceMap, TimeMap } from './overlays/coords';

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

/**
 * Crosshair liquidity readout at a hovered pixel (§8.3, T9). Sizes come from the
 * exact CPU {@link ColumnCache}, NEVER from GPU-filtered/mip texels; price from
 * the epoch's row→price affine. `hasData` is false when the hovered column is not
 * cached (deep history) — the UI then shows the price but "—" for size.
 */
export interface CrosshairReadout {
  /** Absolute col_seq under the cursor (floor of the fractional column). */
  colSeq: number;
  /** Absolute row under the cursor (row 0 = bottom of the price grid). */
  row: number;
  /** Number of rows summed into the size (tick-grouping / mip block = 4^level). */
  group: number;
  /** Price at the hovered row via `p0 + row·tick·tick_multiple`, or null off-grid. */
  price: number | null;
  /** Price-format decimals derived from the tick, for the UI. */
  priceDecimals: number;
  /** Exact summed bid size at the (grouped) cell, or null when not cached. */
  bid: number | null;
  /** Exact summed ask size at the (grouped) cell, or null when not cached. */
  ask: number | null;
  /** Column start time (ns) from the cache, or null when not cached. */
  timeNs: bigint | null;
  /** Whether the cursor is over a resident column and an on-grid row. */
  inRange: boolean;
}

/**
 * Full-res residency budget (§8.3): 16 384 recent columns = 64 tile layers ×
 * 256 cols. At RG16F (4 B/texel) one column is rows·4 B, so the ring is
 * 16384·rows·4 B — 134 MiB at the sim's 2048 rows, 268 MiB at the production
 * 4096-row grid, both ≤ the §10 300 MB GPU-memory gate. Older ranges are not
 * held full-res; scroll-back re-fetches them (net/history) and deep zoom-out
 * renders from the SUM-mips.
 */
const DEFAULT_CAPACITY_COLS = 16_384;
const DEFAULT_COLUMN_PX = 3;
const DEFAULT_MAX_VISIBLE = 512;
const MIN_VISIBLE_COLS = 32;
const ROW_PAD_FRACTION = 0.08;
const MIN_ROW_PAD = 3;
/** Floor on the normalization divisor so a tiny norm_seed can't blow out intensity. */
const NORM_FLOOR = 6;
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

  // Rebuilt on `webglcontextrestored`, hence not readonly.
  private ctx: GLContext;
  private lut: WebGLTexture;
  private readonly camera: Camera;

  // Created lazily on the first column, once the row count is known.
  private ring: TileRing | null = null;
  private heatmap: Heatmap | null = null;
  /** SUM-mip chain for correct zoom-out (T7). null when float FBOs are absent. */
  private mips: MipChain | null = null;
  /** Per-slot non-zero row extent (lo/hi), -1 = empty. Sized to ring capacity. */
  private extentLo: Int32Array | null = null;
  private extentHi: Int32Array | null = null;
  /** Ring geometry, remembered so context-restore can rebuild identically. */
  private ringRows = 0;
  private ringLayers = 0;

  /** Deep scroll-back backfill (T8). Created with the ring. */
  private history: HistoryLoader | null = null;

  /** Viewport-percentile normalization (T9): per-tile histograms → u_norm. */
  private readonly normalizer: ViewportNormalizer;
  /** Exact CPU column cache (T9): the crosshair readout + instant-recovery data. */
  private readonly columnCache: ColumnCache;
  /** Overlays (T10): trades/BBO/VWAP/profile/markers + axes + text layer. */
  private overlays: OverlayManager;
  /** Column⇄time anchor for overlays: newest written column (any is valid). */
  private overlayAnchorSeq = -1;
  private overlayAnchorT0Ns = 0n;
  private overlayAnchorEpoch = 0;
  /** One-shot guard so a suppressed overlay-ingest error warns at most once. */
  private overlayIngestWarned = false;
  /** norm_seed applied once, the first time the server sends it. */
  private normSeeded = false;
  /** Fixed per-instrument decode scale (capability-driven; 1 for the sim). */
  private decodeScale = 1;
  /** Current colormap row (thermal / synth), set per column mode. */
  private ramp = RAMP_THERMAL;

  private newestSeq = -1;
  private view: HeatmapView;

  private dirty = false;
  /** The view moved this frame → ask the HistoryLoader to ensure visible range. */
  private viewMoved = false;
  private running = true;
  private rafId = 0;

  // Context-loss lifecycle (§8.3): recreate GL + re-fetch on restore.
  private contextLost = false;
  private contextLostCountN = 0;
  private contextRestoredCountN = 0;
  /** WEBGL_lose_context handle kept from the pre-loss ctx (e2e-driven loss). */
  private lostCtxExt: { loseContext(): void; restoreContext(): void } | null = null;

  // Perf instrumentation (test hooks): draw bookkeeping + a scripted run.
  private drawCountN = 0;
  private lastDrawEndTsN = 0;
  private perf: PerfRun | null = null;

  private readonly unsubscribeStream: () => void;
  private readonly resizeObserver: ResizeObserver;
  private readonly gesturesDispose: () => void;
  /** The camera-control surface the gestures drive; also the app-keyboard target. */
  private readonly controller: CameraController;

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

    // T9 CPU state (no GL) — histograms + exact column cache survive a context
    // loss, so they're built once here and kept across ring rebuilds.
    this.normalizer = new ViewportNormalizer({ colsPerTile: COLS_PER_TILE });
    this.columnCache = new ColumnCache();

    // Overlays (T10): own GL batches + a 2D text layer sibling over the canvas.
    this.overlays = new OverlayManager(this.ctx.gl, canvas);

    // Match the backing store to the CSS box, then paint the background once so
    // the pre-data canvas is the terminal near-black, not transparent garbage.
    this.resize();
    const gl = this.ctx.gl;
    gl.clearColor(BG[0], BG[1], BG[2], BG[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);

    // Context-loss recovery (§8.3): preventDefault on lost so the browser will
    // fire `restored`, where we rebuild every GL object + re-fetch the view.
    canvas.addEventListener('webglcontextlost', this.onContextLost as EventListener, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored as EventListener, false);

    this.controller = this.makeController();
    this.gesturesDispose = attachGestures(canvas, this.controller);

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

  /**
   * Active colormap row (RAMP_THERMAL 0 / RAMP_SYNTH 1) — the heatmap encoding's
   * ramp when a heatmap exists, else the mode selected by the last column.
   * Diagnostics / e2e (asserts a SYNTH_PROFILE session renders the amber ramp).
   */
  get currentRamp(): number {
    return this.heatmap?.encoding.ramp ?? this.ramp;
  }

  /** Full-res residency budget in columns (ring capacity). Diagnostics / e2e. */
  get residentBudgetCols(): number {
    return this.ring?.budgetCols ?? 0;
  }

  /** Whether an absolute col_seq is resident full-res. Diagnostics / e2e. */
  isResidentFullRes(colSeq: number): boolean {
    return this.ring?.isResidentFullRes(colSeq) ?? false;
  }

  /** Scroll-back backfill counters (or null before the ring exists). e2e hook. */
  historyStats(): {
    requestCount: number;
    inFlight: boolean;
    startOfHistory: boolean;
    error: string | null;
  } | null {
    if (!this.history) return null;
    return {
      requestCount: this.history.requestCount,
      inFlight: this.history.inFlight,
      startOfHistory: this.history.startOfHistory,
      error: this.history.error,
    };
  }

  /** Context-loss/restore counters. e2e recovery hook. */
  get contextLostCount(): number {
    return this.contextLostCountN;
  }
  get contextRestoredCount(): number {
    return this.contextRestoredCountN;
  }

  /** Force a WebGL context loss via WEBGL_lose_context (e2e only). */
  loseContextForTest(): boolean {
    const ext = this.ctx.gl.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    this.lostCtxExt = ext;
    ext.loseContext();
    return true;
  }

  /** Restore a context lost via {@link loseContextForTest} (e2e only). */
  restoreContextForTest(): void {
    this.lostCtxExt?.restoreContext();
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost as EventListener);
    this.canvas.removeEventListener(
      'webglcontextrestored',
      this.onContextRestored as EventListener,
    );
    this.gesturesDispose();
    this.unsubscribeStream();
    this.overlays.dispose();
    this.mips?.dispose();
    this.heatmap?.dispose();
    this.ring?.dispose();
    this.ctx.gl.deleteTexture(this.lut);
  }

  // --- overlays (T10) -----------------------------------------------------------

  /** Attach the App-owned price/time gutter canvases for axis drawing. */
  attachOverlaySurfaces(
    priceAxisCanvas: HTMLCanvasElement | null,
    timeAxisCanvas: HTMLCanvasElement | null,
  ): void {
    this.overlays.attachAxes(priceAxisCanvas, timeAxisCanvas);
    this.dirty = true;
  }

  /** Toggle which overlays render (App visibility state). */
  setOverlayVisibility(v: Partial<OverlayVisibility>): void {
    this.overlays.setVisibility(v);
    this.dirty = true;
  }

  /** Which overlays are currently on (App reads this to seed its toggles). */
  overlayVisibility(): OverlayVisibility {
    return this.overlays.getVisibility();
  }

  /** Bubble draw threshold (min trade size), §9 settings. */
  setBubbleMinSize(minSize: number): void {
    this.overlays.setBubbleMinSize(minSize);
    this.dirty = true;
  }

  /**
   * Read-only timeline geometry for the minimap + replay seek (§9, T12): the
   * resident column extent, the current visible window in absolute columns, and
   * the column⇄time base (anchor + dt) so a scrubber fraction maps to a real ns.
   * Null before the first column. Cheap — the Timeline polls it at ≤4 Hz.
   */
  timeline(): {
    oldestSeq: number;
    newestSeq: number;
    viewStartCol: number;
    viewEndCol: number;
    timeBase: { anchorSeq: number; anchorT0Ns: bigint; dtNs: number } | null;
  } | null {
    const range = this.residentRange();
    if (range === null) return null;
    return {
      oldestSeq: range.oldest,
      newestSeq: range.newest,
      viewStartCol: this.view.colOffset,
      viewEndCol: this.view.colOffset + this.view.colScale,
      timeBase: this.overlayTimeMap(),
    };
  }

  /** `Space` (live mode) / `F`: toggle auto-follow of the live right edge. */
  toggleFollow(): void {
    this.controller.toggleFollow();
  }

  /** Reset the view + re-enable follow (the `R` / Go-Live control). */
  goLive(): void {
    this.controller.goLive();
  }

  /**
   * Reset the heatmap renderer to a clean, empty slate for a NEW subscription
   * (a symbol / market switch). The DOM ladder + tape read the live book directly
   * and switch on their own; the GL heatmap, by contrast, holds a {@link TileRing}
   * of the OLD symbol's columns and a camera fit to the OLD price frame — so
   * WITHOUT this the new session's columns (a fresh epoch with a wildly different
   * `p0`) append onto the stale ring while the camera stays framed on the old
   * price range, and the old tiles keep showing. This is the M2 integration-gate
   * bug: switch sim→binance and the heatmap keeps painting sim's 88–128 band.
   *
   * The teardown mirrors the pre-first-column state (`ring === null`): the NEXT
   * {@link onDepthColumn} of the new session lazily rebuilds the ring at the new
   * symbol's row count via {@link createRing} — the LIVE path, so the ring/mips
   * sizing is correct even when the grid height changes — re-fits the camera, and
   * rebuilds the {@link HistoryLoader}. The CPU-side normalizer / column cache /
   * overlays are cleared, the (epoch, col_seq) auto-follow + overlay-anchor
   * cursors are rewound (so the new session's first, lower col_seq is accepted as
   * the newest), and the norm re-seeds from the new session's `norm_seed` on its
   * first column ({@link normSeeded} back to false).
   *
   * Distinct from the context-loss {@link recreateGL} (same symbol → same
   * geometry, GL objects revived in place, camera view preserved) and from the
   * perf / normalize / overlay preloads (which install a FIXED test geometry). A
   * bare reconnect that keeps the symbol must NOT call this — it would wipe
   * scrolled-back history — so App.tsx keys the trigger on market:symbol, not
   * sessionId. Safe to call before the first column too (a no-op teardown).
   */
  resetForSession(): void {
    // A lost context is mid-rebuild; its own `restored` path re-empties the ring.
    if (this.glLost()) return;

    // Tear down the GL heatmap objects; the next new-session column recreates
    // them at the new row count via createRing (matching the live-path sizing).
    this.mips?.dispose();
    this.heatmap?.dispose();
    this.ring?.dispose();
    this.mips = null;
    this.heatmap = null;
    this.ring = null;
    this.history = null;
    this.extentLo = null;
    this.extentHi = null;
    this.ringRows = 0;
    this.ringLayers = 0;

    // CPU-side state survives a context loss, but a NEW symbol invalidates it.
    this.normalizer.reset();
    this.columnCache.reset();
    this.overlays.reset();
    this.normSeeded = false;
    this.decodeScale = 1;
    this.ramp = RAMP_THERMAL;
    this.overlayIngestWarned = false;

    // Rewind the per-session cursors used for auto-follow + overlay anchoring so
    // the new session's first (typically lower) col_seq becomes the newest again.
    this.newestSeq = -1;
    this.overlayAnchorSeq = -1;
    this.overlayAnchorT0Ns = 0n;
    this.overlayAnchorEpoch = 0;

    // Camera back to the provisional live default (follow ON, like the ctor);
    // createRing re-fits to the new grid on the first column, then the per-column
    // follow frame fits the price axis to the new book.
    this.camera.setLimits(limitsFor(1, this.opts.capacityColsTarget));
    this.camera.reset(null);
    this.view = this.camera.toView();

    // Wipe the old image now — preserveDrawingBuffer would otherwise keep the
    // stale frame on screen until the first new-session column draws.
    const gl = this.ctx.gl;
    gl.clearColor(BG[0], BG[1], BG[2], BG[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.dirty = true;
    this.viewMoved = true;
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
        // Leaving scroll-back: allow live appends to re-anchor the ring at the
        // live edge and let the loader probe again on the next pan.
        this.history?.reset();
        this.updateView();
        this.dirty = true;
        this.viewMoved = true;
      },
    };
  }

  /** A user gesture changed the camera: recompute uniforms, request a redraw. */
  private onCameraChanged(): void {
    this.view = this.camera.toView();
    this.dirty = true;
    this.viewMoved = true;
  }

  // --- stream handling ----------------------------------------------------------

  private onMessage = (msg: StreamMsg): void => {
    if (msg.type === MsgType.DEPTH_COL) {
      this.onDepthColumn(msg);
      return;
    }
    // Overlays (T10): feed the overlay manager; a redraw is scheduled so the
    // sprites/lines/glyphs update in lock-step with the heatmap. Cheap — the
    // manager only stores into bounded rings/maps here (O(1)); drawing is
    // O(visible) on the next dirty frame. Guarded so a single malformed overlay
    // event can NEVER break the column stream / renderer (§8.3 lifecycle).
    try {
      switch (msg.type) {
        case MsgType.TRADE:
          this.overlays.onTrade(msg);
          break;
        case MsgType.BBO:
          this.overlays.onBbo(msg);
          break;
        case MsgType.BAR_COL:
          this.overlays.onBar(msg);
          break;
        case MsgType.MARKER:
          this.overlays.onMarker(msg);
          break;
        default:
          return;
      }
      this.dirty = true;
    } catch (err) {
      if (!this.overlayIngestWarned) {
        this.overlayIngestWarned = true;
        console.warn('[flowmap] overlay ingest error (suppressed; stream continues):', err);
      }
    }
  };

  private onDepthColumn(col: DepthColumn): void {
    // A lost context has no valid textures; drop until restore re-fetches.
    if (this.glLost()) return;

    const params = this.store.getState().epochs.get(col.epoch);
    const rows = params?.rows ?? col.bid.length;

    if (this.ring === null) this.createRing(rows);
    const ring = this.ring!;

    if (rows !== ring.rows || col.bid.length !== rows) {
      // A per-epoch row-count change needs a fresh ring; until then a mismatched
      // column is dropped rather than corrupting the upload.
      console.warn(
        `[flowmap] depth column rows ${rows} (bid ${col.bid.length}) ≠ ring rows ${ring.rows}; skipping`,
      );
      return;
    }

    if (col.col_seq > this.newestSeq) this.newestSeq = col.col_seq;

    // Deep scroll-back gate (T8): when the user has panned back into history
    // (follow off) and this live column sits past the resident window's right
    // edge, DON'T write it — it would wrap-evict the region being viewed. The
    // column stays on the server and is recoverable on go-live; the resident
    // window keeps tracking the scrolled-back region the loader is filling.
    const range = ring.residentRange();
    if (!this.camera.follow && range !== null && col.col_seq > range.newest + 1) {
      return;
    }

    this.writeColumn(col, rows);

    // Normalization (T9): seed the viewport normalizer once from the server's
    // per-session norm_seed (p99 of recent nonzero density) — thereafter u_norm
    // is the VIEWPORT percentile, recomputed per frame in updateNormalization().
    if (!this.normSeeded) {
      const seed = this.store.getState().normSeed;
      if (seed && seed > 0) {
        this.normalizer.seed(Math.max(seed, NORM_FLOOR));
        this.normSeeded = true;
      }
    }
    // Colormap follows the column's density mode (synth profile → amber ramp).
    // Apply it to the heatmap encoding right away so the ramp is correct even on
    // a frame where the viewport normalizer has no data yet (updateNormalization
    // early-returns then); it re-affirms the same ramp once histograms exist.
    this.ramp = rampForMode(col.mode);
    if (this.heatmap !== null && this.heatmap.encoding.ramp !== this.ramp) {
      this.heatmap.encoding = { ...this.heatmap.encoding, ramp: this.ramp };
    }

    this.updateView();
    this.dirty = true;
  }

  /**
   * Splice a backfilled history column (T8 loader sink). Same physical write as
   * a live append — the ring addresses by absolute col_seq, so an older column
   * lands in its true slot and slides the resident window backward.
   */
  private spliceColumn = (col: DepthColumn): void => {
    if (this.glLost()) return;
    const ring = this.ring;
    if (ring === null) return;
    const params = this.store.getState().epochs.get(col.epoch);
    const rows = params?.rows ?? col.bid.length;
    if (rows !== ring.rows || col.bid.length !== rows) {
      console.warn(`[flowmap] history column rows ${rows} ≠ ring rows ${ring.rows}; skipping`);
      return;
    }
    this.writeColumn(col, rows);
    this.dirty = true;
  };

  /**
   * The shared column write: upload the texel column, regenerate the affected
   * SUM-mip group (append-time, O(1) in history), refresh the per-slot non-zero
   * extent, and record (col_seq → t0_ns) for the loader's before_t mapping.
   */
  private writeColumn(col: DepthColumn, rows: number): void {
    const ring = this.ring!;
    ring.append(col.col_seq, col.epoch, col.bid, col.ask, rows);
    this.mips?.updateFrom(ring, col.col_seq);

    const cap = ring.capacityCols;
    const slot = ((col.col_seq % cap) + cap) % cap;
    const [lo, hi] = columnExtent(col.bid, col.ask, rows);
    this.extentLo![slot] = lo;
    this.extentHi![slot] = hi;

    // T9: feed the exact CPU cache (crosshair readout) and the per-tile
    // histogram (viewport normalization). The DepthColumn arrays are fresh,
    // immutable copies (decode.ts), so the cache holds references directly.
    this.columnCache.put(col.col_seq, col.bid, col.ask, col.t0_ns, col.epoch);
    this.normalizer.addColumn(col.col_seq, col.bid, col.ask);

    this.history?.noteColumn(col.col_seq, col.t0_ns);

    // Overlays (T10): remember an absolute (col_seq → t0_ns) anchor for the
    // ts_ns→column mapping (any resident column is a valid anchor within an
    // epoch), and keep the per-window VWAP map bounded to the resident range.
    this.overlayAnchorSeq = col.col_seq;
    this.overlayAnchorT0Ns = col.t0_ns;
    this.overlayAnchorEpoch = col.epoch;
    const r = ring.residentRange();
    if (r !== null) this.overlays.prune(r.oldest, r.newest);
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

    this.ringRows = rows;
    this.ringLayers = layers;
    this.ring = new TileRing(this.ctx.gl, rows, layers);
    this.heatmap = new Heatmap(this.ctx, this.ring, this.lut);
    this.mips?.dispose();
    this.mips = this.createMips(rows, layers);
    this.heatmap.mips = this.mips;
    const cap = this.ring.capacityCols;
    this.extentLo = new Int32Array(cap).fill(-1);
    this.extentHi = new Int32Array(cap).fill(-1);

    this.history = this.createHistoryLoader();

    // Real geometry known: update the camera's clamps and (re)frame live.
    this.camera.setLimits(limitsFor(rows, cap));
    this.camera.reset(this.ring.residentRange(), rows);
  }

  /** Wire a {@link HistoryLoader} to the store transport + this ring/mips. */
  private createHistoryLoader(): HistoryLoader {
    return new HistoryLoader({
      requestHistory: (before_t, n) => this.store.getState().requestHistory(before_t, n),
      spliceColumn: this.spliceColumn,
      residentRange: () => this.ring?.residentRange() ?? null,
      budgetCols: () => this.ring?.budgetCols ?? 0,
      dtNs: () => this.currentDtNs(),
      onSpliced: () => {
        this.dirty = true;
        // Re-arm the per-frame guard: if the visible range still isn't fully
        // resident (a wide pan needs several pages), the next frame fetches the
        // next page. Self-terminates once the left edge is covered — still O(1).
        this.viewMoved = true;
      },
    });
  }

  /** Current epoch's column interval (ns) for the loader's before_t fallback. */
  private currentDtNs(): number {
    const st = this.store.getState();
    const ep = st.gridEpoch !== null ? st.epochs.get(st.gridEpoch) : undefined;
    return ep?.dt_ns ?? 250_000_000;
  }

  /**
   * Build the SUM-mip chain when float FBOs are available and the row count
   * supports a 4× downsample. Returns null (single-level, level-0 draw path)
   * otherwise — the heatmap then renders exactly as it did pre-T7.
   */
  private createMips(rows: number, layers: number): MipChain | null {
    if (!this.ctx.caps.colorBufferFloat || rows % 4 !== 0) return null;
    return new MipChain(this.ctx, COLS_PER_TILE, rows, layers);
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
    this.viewMoved = true;
  }

  /** SUM-mip level the current view would sample (0/1/2) — drives backfill
   *  suppression on deep zoom-out (§8.3: level-2 renders from mips). */
  private currentLevel(): number {
    const maxLevel = this.mips ? this.mips.maxLevel : 0;
    const h = Math.max(1, this.ctx.gl.drawingBufferHeight);
    return selectLevel(this.view.rowScale / h, maxLevel).level;
  }

  /**
   * Recompute u_norm from the VISIBLE window (T9): merge the covered tiles'
   * histograms, extract the percentile, EMA-smooth, and fold the mip scaling.
   * O(tiles in view) — never O(history). Skipped when the normalizer has no data
   * (the perf preload path sets its own fixed norm and never feeds histograms),
   * so the §10 perf gate is untouched. When the EMA is still gliding this keeps
   * the frame dirty so the contrast settles smoothly (~0.3 s) instead of snapping.
   */
  private updateNormalization(): void {
    const ring = this.ring;
    const heatmap = this.heatmap;
    if (ring === null || heatmap === null || !this.normalizer.hasData()) return;

    const range = ring.residentRange();
    if (range === null) return;

    // Visible absolute column span, clamped to the resident window so the tile
    // merge stays bounded even on a whole-ring zoom-out (≤ ring layers).
    const left = Math.floor(this.view.colOffset);
    const right = Math.floor(this.view.colOffset + this.view.colScale);
    const oldest = Math.max(range.oldest, Math.min(left, right));
    const newest = Math.min(range.newest, Math.max(left, right));
    if (newest < oldest) return;

    const rowLo = Math.max(0, Math.floor(this.view.rowOffset));
    const rowHi = Math.min(ring.rows - 1, Math.floor(this.view.rowOffset + this.view.rowScale));
    const level = this.currentLevel();

    const norm = this.normalizer.updateNorm(
      { oldest, newest },
      { lo: rowLo, hi: rowHi },
      level,
    );
    heatmap.encoding = { decodeScale: this.decodeScale, norm, ramp: this.ramp };
    // Note: re-dirtying to keep the EMA gliding is done in frame() AFTER the
    // draw block clears `dirty` — setting it here would be overwritten.
  }

  /** Whether the viewport norm is still gliding toward its target (settle loop). */
  private normSettling(): boolean {
    return this.heatmap !== null && this.normalizer.hasData() && !this.normalizer.settled;
  }

  /**
   * Crosshair readout at a canvas CSS pixel (T9). Maps the pixel back through the
   * camera inverse to (col_seq, row), reads the EXACT summed size from the CPU
   * {@link ColumnCache} (never GPU/mip texels), and the price from the epoch's
   * row→price affine. Returns null before the first column. Grouped rows are
   * summed to match a tick-grouped / zoomed-out view (block = 4^level).
   */
  probeAt(cssX: number, cssY: number): CrosshairReadout | null {
    const ring = this.ring;
    if (ring === null) return null;

    const cssW = Math.max(1, this.canvas.clientWidth);
    const cssH = Math.max(1, this.canvas.clientHeight);
    const { colf, rowf } = screenToGrid(this.view, cssX, cssY, cssW, cssH);
    const colSeq = Math.floor(colf);
    const row = Math.floor(rowf);
    const rows = ring.rows;
    const onGrid = row >= 0 && row < rows;

    const range = ring.residentRange();
    const inRange =
      range !== null && colSeq >= range.oldest && colSeq <= range.newest && onGrid;

    // Epoch geometry for row→price (single-epoch sim; per-column epoch when known).
    const st = this.store.getState();
    const epoch = this.columnCache.epochAt(colSeq) ?? st.gridEpoch ?? 0;
    const params = st.epochs.get(epoch);
    const step = params ? params.tick * params.tick_multiple : 0;
    const price = params && onGrid ? params.p0 + row * step : null;
    const priceDecimals = step > 0 ? Math.min(8, Math.max(0, Math.ceil(-Math.log10(step)))) : 2;

    // Exact grouped size (block = 4^level rows, aligned like the shader).
    const blk = 4 ** this.currentLevel();
    const rowStart = Math.floor(row / blk) * blk;
    const size = onGrid ? this.columnCache.sizeAt(colSeq, rowStart, blk) : null;

    return {
      colSeq,
      row,
      group: blk,
      price,
      priceDecimals,
      bid: size ? size.bid : null,
      ask: size ? size.ask : null,
      timeNs: this.columnCache.timeAt(colSeq),
      inRange,
    };
  }

  // --- overlay draw (T10) -------------------------------------------------------

  /**
   * Draw the overlays over the heatmap for the current view. All O(visible): each
   * overlay emits geometry only for the columns/rows in the viewport. Returns
   * early (no cost) when nothing can be placed — no epoch geometry yet, or every
   * overlay is toggled off.
   */
  private drawOverlays(): void {
    if (this.glLost()) return;
    const overlays = this.overlays;
    if (!overlays.anyVisible) return;
    const price = this.overlayPriceMap();
    const time = this.overlayTimeMap();
    // Need at least a price affine (axes/BBO/profile) or a time affine (events);
    // with neither there is nothing to map onto the camera.
    if (price === null && time === null) return;

    const gl = this.ctx.gl;
    const range = this.ring?.residentRange() ?? null;
    overlays.draw({
      view: this.view,
      dims: {
        drawW: gl.drawingBufferWidth,
        drawH: gl.drawingBufferHeight,
        cssW: Math.max(1, this.canvas.clientWidth),
        cssH: Math.max(1, this.canvas.clientHeight),
      },
      dpr: window.devicePixelRatio || 1,
      resident: range ? { oldest: range.oldest, newest: range.newest } : null,
      capability: this.store.getState().capability,
      time,
      price,
      columnArrays: (col) => this.columnCache.arrays(col),
      newestArrays: this.newestSeq >= 0 ? this.columnCache.arrays(this.newestSeq) : null,
    });
  }

  /** Row→price affine for the current grid epoch, or null before any epoch. */
  private overlayPriceMap(): PriceMap | null {
    const st = this.store.getState();
    const ep = st.gridEpoch !== null ? st.epochs.get(st.gridEpoch) : undefined;
    if (ep === undefined) return null;
    return { p0: ep.p0, step: ep.tick * ep.tick_multiple };
  }

  /** Column⇄time affine anchored on the newest written column, or null. */
  private overlayTimeMap(): TimeMap | null {
    if (this.overlayAnchorSeq < 0) return null;
    const ep = this.store.getState().epochs.get(this.overlayAnchorEpoch);
    const dtNs = ep?.dt_ns ?? this.currentDtNs();
    return { anchorSeq: this.overlayAnchorSeq, anchorT0Ns: this.overlayAnchorT0Ns, dtNs };
  }

  // --- context-loss lifecycle (§8.3) --------------------------------------------

  /** GL context lost: preventDefault so the browser will restore it, then stop
   *  touching the (now invalid) GL objects until `restored` rebuilds them. */
  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
    this.contextLostCountN += 1;
    this.perf = null; // any in-flight perf run is void
  };

  /** GL context restored: rebuild every GL object and re-fetch the visible range
   *  (the ring came back empty). Live appends also resume repopulating. */
  private onContextRestored = (): void => {
    this.contextRestoredCountN += 1;
    this.recreateGL();
    this.contextLost = false;
    this.dirty = true;
    this.viewMoved = true;
  };

  /** Rebuild ctx + LUT + ring + heatmap + mips after a restore, preserving the
   *  camera view, then re-fetch the columns the viewport needs. */
  private recreateGL(): void {
    // getContext on the restored canvas returns the same (now-revived) context;
    // re-obtain extension handles + caps and rebuild all GPU resources.
    this.ctx = initGL(this.canvas, {
      requireColorBufferFloat: this.opts.requireColorBufferFloat,
      preserveDrawingBuffer: true,
    });
    this.lut = createLUTTexture(this.ctx.gl);
    // Overlay GL batches were invalidated by the loss — rebuild them (the 2D
    // text layer + overlay data survive).
    this.overlays.recreateGL(this.ctx.gl);

    const gl = this.ctx.gl;
    this.resize();
    gl.clearColor(BG[0], BG[1], BG[2], BG[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.ringRows > 0) {
      // Rebuild the ring/heatmap/mips at the same geometry; the ring is empty.
      this.mips = null;
      this.heatmap = null;
      this.ring = new TileRing(gl, this.ringRows, this.ringLayers);
      this.heatmap = new Heatmap(this.ctx, this.ring, this.lut);
      this.mips = this.createMips(this.ringRows, this.ringLayers);
      this.heatmap.mips = this.mips;
      const cap = this.ring.capacityCols;
      this.extentLo = new Int32Array(cap).fill(-1);
      this.extentHi = new Int32Array(cap).fill(-1);
      this.history = this.createHistoryLoader();
      this.camera.setLimits(limitsFor(this.ringRows, cap));
      // Recover by re-following the live edge: the ring came back empty and the
      // live feed is still flowing, so live appends re-populate the visible
      // range from the server within a couple of columns. (A deep-scroll-back
      // view is re-fetched again by the loader as soon as the user pans.)
      this.camera.reset(null, this.ringRows);
      this.updateView();
    }
  }

  /** True while the GL context is lost — including the window between the
   *  WEBGL_lose_context call and the `webglcontextlost` event firing. */
  private glLost(): boolean {
    return this.contextLost || this.ctx.gl.isContextLost();
  }

  private frame = (ts: number): void => {
    if (!this.running) return;
    // A lost context can't draw; wait for `restored` to rebuild GL.
    if (this.glLost()) {
      this.rafId = requestAnimationFrame(this.frame);
      return;
    }

    const perf = this.perf;
    if (perf) {
      if (perf.lastTs > 0) perf.deltas.push(ts - perf.lastTs);
      perf.lastTs = ts;
      this.stepPerf(perf);
      this.dirty = true; // force a redraw every frame while measuring
    }

    // T8: on frames where the view moved, ask the loader to ensure the visible
    // range is populated. This guard is O(1) (visible-left vs resident-oldest) —
    // never O(history) — so the §10 perf gate stays green.
    if (this.viewMoved && this.history !== null && this.ring !== null) {
      this.viewMoved = false;
      this.history.ensureVisible({
        leftCol: Math.floor(this.view.colOffset),
        span: this.view.colScale,
        level: this.currentLevel(),
      });
    }

    if (this.dirty && this.heatmap !== null) {
      // T9: refresh u_norm from the visible window before drawing (O(tiles),
      // outside the measured draw cost; a no-op during the perf preload run).
      this.updateNormalization();
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

      // Overlays (T10) draw OVER the heatmap, O(visible). Skipped during a perf
      // run (the measured drawMs is heatmap-only) and when there is no epoch to
      // map events/prices onto (perf preload) — so the §10 gate is untouched. A
      // throw here must never freeze the render loop (bookkeeping is already done
      // above), but IS surfaced asynchronously so a real GL error still fails the
      // §12 "no GL errors" gate.
      if (perf === null) {
        try {
          this.drawOverlays();
        } catch (err) {
          setTimeout(() => {
            throw err;
          }, 0);
        }
      }

      // Keep redrawing until the viewport norm reaches its target so the contrast
      // glides into a new regime (~0.3 s) instead of snapping. O(tiles)/frame for
      // the handful of settle frames; a no-op once converged and in the perf
      // preload path (no histogram data).
      if (this.normSettling()) this.dirty = true;
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

  /** SUM-mip level the current view samples (0/1/2). e2e scroll-back hook. */
  get currentMipLevel(): number {
    return this.currentLevel();
  }

  /** Deterministic time pan by `dCols` absolute columns (disables follow, like a
   *  drag). Drives the real T8 backfill on the next frame. e2e only. */
  panColumnsForTest(dCols: number): void {
    this.camera.pan(dCols, 0);
    this.onCameraChanged();
  }

  /** Deterministic price zoom (factor>1 = zoom out → coarser mip). e2e only. */
  zoomPriceForTest(factor: number): void {
    this.camera.zoomPrice(factor, this.camera.state.rowCenter);
    this.onCameraChanged();
  }

  /** Deterministic time zoom (factor>1 = zoom out; clamps at the ring width).
   *  e2e only. Used to reach the whole-ring deep-zoom-out (no-backfill) state. */
  zoomTimeForTest(factor: number): void {
    this.camera.zoomTime(factor, this.camera.state.colCenter);
    this.onCameraChanged();
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
    this.mips?.dispose();
    this.heatmap?.dispose();
    this.ring?.dispose();
    this.mips = null;
    this.heatmap = null;
    this.ring = null;
    // Perf harness bypasses the network — no scroll-back backfill in this mode.
    this.history = null;

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

  /**
   * Preload the T9 normalization/crosshair e2e scenario (network bypassed): two
   * equal-shaped density regions whose scales differ ×50 (a DIM overnight-style
   * region and a BRIGHT live-edge-style region), plus one KNOWN wall cell with a
   * distinctive exact size for the crosshair assertion. Columns go through the
   * REAL {@link writeColumn} path, so the ring, the per-tile histograms
   * (normalizer) AND the exact CPU cache are all populated exactly as live. The
   * caller sets the epoch params on the store, frames a region with
   * {@link setViewForTest}, and lets the real per-frame viewport normalization run.
   */
  preloadNormalizeScenario(): {
    rows: number;
    epoch: number;
    params: { epoch: number; tick: number; tick_multiple: number; dt_ns: number; p0: number; rows: number };
    dim: { colLo: number; colHi: number };
    bright: { colLo: number; colHi: number };
    /** Col windows strictly INSIDE each regime (inset from the mid-tile seam). */
    dimWindow: { colLo: number; colHi: number };
    brightWindow: { colLo: number; colHi: number };
    centerRow: number;
    band: { lo: number; hi: number };
    wall: { col: number; row: number; bid: number; price: number };
    capacityCols: number;
  } {
    const rows = 512;
    // Tile-aligned regions (colsPerTile = 256): dim = tiles 0-1, bright = tiles
    // 2-3. A regime boundary mid-tile would leak the brighter columns into the
    // dimmer viewport's merge (histograms are tile-granular by design, the §10
    // O(tiles) budget) — so the two regimes sit on whole-tile boundaries and the
    // measured windows are inset from the seam.
    const region = 512;
    const centerRow = 256;
    const tick = 0.5;
    const tickMultiple = 1;
    const dtNs = 25_000_000;
    const p0 = 100;
    const brightScale = 50;
    const wallCol = region + region / 2; // 768, mid of the bright region
    const wallRow = centerRow;
    const wallBid = 277; // distinctive exact value the crosshair must report

    this.mips?.dispose();
    this.heatmap?.dispose();
    this.ring?.dispose();
    this.mips = null;
    this.heatmap = null;
    this.ring = null;
    this.history = null;
    this.normalizer.reset();
    this.columnCache.reset();
    this.normSeeded = false;

    const total = 2 * region;
    const wantLayers = Math.ceil(total / COLS_PER_TILE);
    const layers = clamp(wantLayers, 2, this.ctx.caps.maxArrayTextureLayers);
    const ring = new TileRing(this.ctx.gl, rows, layers);
    this.ring = ring;
    this.heatmap = new Heatmap(this.ctx, ring, this.lut);
    this.mips = this.createMips(rows, layers);
    this.heatmap.mips = this.mips;
    const cap = ring.capacityCols;
    this.extentLo = new Int32Array(cap).fill(-1);
    this.extentHi = new Int32Array(cap).fill(-1);
    this.decodeScale = 1;
    this.ramp = RAMP_THERMAL;
    this.camera.setLimits(limitsFor(rows, cap));

    for (let s = 0; s < total; s++) {
      const scale = s < region ? 1 : brightScale;
      // Fresh arrays per column — the cache holds references (never scratch).
      const bid = new Float32Array(rows);
      const ask = new Float32Array(rows);
      for (let r = 0; r < rows; r++) {
        const d = Math.abs(r - centerRow);
        let v = 0;
        if (d <= 2) v = 5 * scale; // the persistent wall band
        else if (d <= 20) v = 0.6 * scale * (1 - d / 20); // ladder falloff
        if (v > 0) {
          if (r <= centerRow) bid[r] = v;
          else ask[r] = v;
        }
      }
      if (s === wallCol) bid[wallRow] = wallBid; // the known crosshair cell
      const col: DepthColumn = {
        type: MsgType.DEPTH_COL,
        epoch: 0,
        col_seq: s,
        t0_ns: BigInt(s) * BigInt(dtNs),
        mode: MODE_L2,
        final: true,
        bid,
        ask,
      };
      this.writeColumn(col, rows);
    }
    this.newestSeq = total - 1;

    // Frame the bright region initially; the spec reframes to compare regions.
    this.setViewForTest(region, region, centerRow - 40, 80);

    return {
      rows,
      epoch: 0,
      params: { epoch: 0, tick, tick_multiple: tickMultiple, dt_ns: dtNs, p0, rows },
      dim: { colLo: 0, colHi: region - 1 },
      bright: { colLo: region, colHi: total - 1 },
      // Inset 20 cols so the framed window's tiles are pure (no seam leak).
      dimWindow: { colLo: 20, colHi: region - 21 },
      brightWindow: { colLo: region + 20, colHi: total - 21 },
      centerRow,
      band: { lo: centerRow - 40, hi: centerRow + 40 },
      wall: { col: wallCol, row: wallRow, bid: wallBid, price: p0 + wallRow * tick * tickMultiple },
      capacityCols: cap,
    };
  }

  /** Set the view directly from edge/scale form (e2e framing). Follow off. */
  setViewForTest(colOffset: number, colScale: number, rowOffset: number, rowScale: number): void {
    this.camera.state = {
      colCenter: colOffset + colScale / 2,
      colSpan: colScale,
      rowCenter: rowOffset + rowScale / 2,
      rowSpan: rowScale,
      follow: false,
    };
    this.view = this.camera.toView();
    this.dirty = true;
    this.viewMoved = true;
  }

  /** Forward map a grid cell CENTER to canvas CSS pixels (e2e crosshair hover). */
  cellToCanvasCss(colSeq: number, row: number): { x: number; y: number } {
    const cssW = Math.max(1, this.canvas.clientWidth);
    const cssH = Math.max(1, this.canvas.clientHeight);
    const uvX = (colSeq + 0.5 - this.view.colOffset) / this.view.colScale;
    const uvY = (row + 0.5 - this.view.rowOffset) / this.view.rowScale;
    return { x: uvX * cssW, y: (1 - uvY) * cssH };
  }

  /** The EMA-smoothed norm currently fed to u_norm (e2e diagnostics). */
  get currentNorm(): number {
    return this.normalizer.current;
  }

  // --- overlay e2e hooks (driven by tests/e2e/overlays.spec) ---------------------

  /**
   * Ingest a synthetic overlay stream message (Trade/BBO/BarColumn/Marker) through
   * the real live path so the overlays populate exactly as from the socket. e2e
   * only — the spec builds the messages (with BigInt fields) in-page.
   */
  ingestForTest(msg: StreamMsg): void {
    this.onMessage(msg);
  }

  /**
   * Forward-map an overlay event `(ts_ns, price)` to canvas CSS px through the
   * SAME transform the overlays use (bubble/marker center), so the spec can
   * pixel-sample where a glyph must land. Null before any epoch/column.
   */
  overlayPointCss(tsNs: bigint, price: number): { x: number; y: number } | null {
    const priceMap = this.overlayPriceMap();
    const time = this.overlayTimeMap();
    if (priceMap === null || time === null) return null;
    const cssW = Math.max(1, this.canvas.clientWidth);
    const cssH = Math.max(1, this.canvas.clientHeight);
    const colf = time.anchorSeq + Number(tsNs - time.anchorT0Ns) / time.dtNs + 0.5;
    const rowf = (price - priceMap.p0) / priceMap.step + 0.5;
    const uvX = (colf - this.view.colOffset) / this.view.colScale;
    const uvY = (rowf - this.view.rowOffset) / this.view.rowScale;
    return { x: uvX * cssW, y: (1 - uvY) * cssH };
  }

  /** Overlay data counts + last profile result. e2e diagnostics. */
  overlayDebugForTest(): ReturnType<OverlayManager['debug']> {
    return this.overlays.debug();
  }

  /**
   * The BBO the overlay would draw for the CURRENT session (capability + newest
   * book), or null when it honestly draws nothing. e2e: a SYNTH_PROFILE keyless
   * equity session MUST return null — no fabricated bid/ask quote (§7).
   */
  overlayEffectiveBboForTest(): ReturnType<OverlayManager['effectiveBboForTest']> {
    const newest = this.newestSeq >= 0 ? this.columnCache.arrays(this.newestSeq) : null;
    return this.overlays.effectiveBboForTest(
      this.store.getState().capability,
      this.overlayPriceMap(),
      newest,
    );
  }

  /** Canvas CSS px y of a price row edge (for BBO / axis line sampling). e2e. */
  overlayRowCss(rowf: number): number {
    const cssH = Math.max(1, this.canvas.clientHeight);
    const uvY = (rowf - this.view.rowOffset) / this.view.rowScale;
    return (1 - uvY) * cssH;
  }

  /**
   * Preload a deterministic overlay scenario (network bypassed): a fresh ring of
   * depth columns with a persistent wall band + ladder (through the REAL
   * writeColumn path, so the column cache + time anchor populate as live), framed
   * to a recent window. The spec then publishes the epoch + capability to the
   * store and injects known Trade/BBO/BarColumn/Marker events via ingestForTest.
   * Returns plain numbers only (no BigInt — page.evaluate serializes to JSON).
   */
  preloadOverlayScenario(): {
    rows: number;
    epoch: number;
    params: { epoch: number; tick: number; tick_multiple: number; dt_ns: number; p0: number; rows: number };
    dtNs: number;
    p0: number;
    step: number;
    anchorSeq: number;
    anchorT0NsNum: number;
    oldest: number;
    newest: number;
    centerRow: number;
    view: { colOffset: number; colScale: number; rowOffset: number; rowScale: number };
    capacityCols: number;
  } {
    const rows = 256;
    const tick = 0.5;
    const tickMultiple = 1;
    const dtNs = 25_000_000;
    const p0 = 50;
    const centerRow = 100; // price 100.0 at step 0.5 → row (100-50)/0.5
    const total = 400;

    this.mips?.dispose();
    this.heatmap?.dispose();
    this.ring?.dispose();
    this.mips = null;
    this.heatmap = null;
    this.ring = null;
    this.history = null;
    this.normalizer.reset();
    this.columnCache.reset();
    this.overlays.reset();
    this.normSeeded = false;

    const wantLayers = Math.ceil(total / COLS_PER_TILE);
    const layers = clamp(wantLayers, 2, this.ctx.caps.maxArrayTextureLayers);
    const ring = new TileRing(this.ctx.gl, rows, layers);
    this.ring = ring;
    this.heatmap = new Heatmap(this.ctx, ring, this.lut);
    this.mips = this.createMips(rows, layers);
    this.heatmap.mips = this.mips;
    const cap = ring.capacityCols;
    this.extentLo = new Int32Array(cap).fill(-1);
    this.extentHi = new Int32Array(cap).fill(-1);
    this.decodeScale = 1;
    this.ramp = RAMP_THERMAL;
    this.camera.setLimits(limitsFor(rows, cap));

    for (let s = 0; s < total; s++) {
      const bid = new Float32Array(rows);
      const ask = new Float32Array(rows);
      for (let r = 0; r < rows; r++) {
        const d = Math.abs(r - centerRow);
        let v = 0;
        if (d <= 2) v = 6; // persistent wall band around the mid
        else if (d <= 24) v = 1.2 * (1 - d / 24); // ladder falloff
        if (v > 0) {
          if (r <= centerRow) bid[r] = v;
          else ask[r] = v;
        }
      }
      const col: DepthColumn = {
        type: MsgType.DEPTH_COL,
        epoch: 0,
        col_seq: s,
        t0_ns: BigInt(s) * BigInt(dtNs),
        mode: MODE_L2,
        final: true,
        bid,
        ask,
      };
      this.writeColumn(col, rows);
    }
    this.newestSeq = total - 1;
    this.heatmap.encoding = { decodeScale: 1, norm: 30, ramp: RAMP_THERMAL };

    // Frame the recent ~200 columns and a price band around the mid.
    const colScale = 200;
    const colOffset = total - colScale;
    const rowScale = 120;
    const rowOffset = centerRow - 60;
    this.setViewForTest(colOffset, colScale, rowOffset, rowScale);

    return {
      rows,
      epoch: 0,
      params: { epoch: 0, tick, tick_multiple: tickMultiple, dt_ns: dtNs, p0, rows },
      dtNs,
      p0,
      step: tick * tickMultiple,
      anchorSeq: this.overlayAnchorSeq,
      anchorT0NsNum: Number(this.overlayAnchorT0Ns),
      oldest: 0,
      newest: total - 1,
      centerRow,
      view: { colOffset, colScale, rowOffset, rowScale },
      capacityCols: cap,
    };
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
