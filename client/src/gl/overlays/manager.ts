/**
 * Overlay manager (§8.3 overlays, M2 T10).
 *
 * Owns the two shared GL batches, the over-heatmap text layer, the optional
 * price/time gutter layers, and every overlay instance; routes the canonical
 * stream (Trade/BBO/BarColumn/Marker) into them; and draws them in the spec order
 * (heatmap already drawn → profile → vwap → bbo → bubbles → markers → text/axes)
 * each dirty frame. The renderer holds ONE of these and calls {@link draw} after
 * the heatmap pass — keeping renderer.ts focused on the tile ring / camera.
 *
 * Everything is O(visible): each overlay only emits geometry for the columns in
 * the viewport, so the §10 perf gate is untouched (the renderer additionally
 * skips the whole overlay pass when there is no epoch / during a perf run).
 */

import { drawGridlines, drawPriceAxis, drawTimeAxis } from './axes';
import { Bbo, type BboState } from './bbo';
import { Bubbles } from './bubbles';
import { GridMap, type PriceMap, type SurfaceDims, type TimeMap } from './coords';
import { DEFAULT_OVERLAY_VISIBILITY, type OverlayFrame, type OverlayVisibility } from './frame';
import { Markers } from './markers';
import { OVERLAY } from './palette';
import { PointBatch, SolidBatch } from './primitives';
import { Profile } from './profile';
import { Vwap } from './vwap';
import { TextLayer } from '../textLayer';
import type { HeatmapView } from '../heatmap';
import type { BarColumn, BBO, Marker, Trade } from '../../proto/types';

/** Everything one overlay frame needs from the renderer. */
export interface OverlayDrawContext {
  view: HeatmapView;
  dims: SurfaceDims;
  dpr: number;
  resident: { oldest: number; newest: number } | null;
  capability: Record<string, unknown> | null;
  time: TimeMap | null;
  price: PriceMap | null;
  /** Exact density arrays for the profile (from the CPU column cache). */
  columnArrays: (col: number) => { bid: Float32Array; ask: Float32Array | null } | null;
  /** Newest column's book (for the L2-derived BBO fallback), or null. */
  newestArrays: { bid: Float32Array; ask: Float32Array | null } | null;
}

export class OverlayManager {
  private solid: SolidBatch;
  private points: PointBatch;
  private readonly text: TextLayer;
  private priceAxis: TextLayer | null = null;
  private timeAxis: TextLayer | null = null;

  private readonly bubbles = new Bubbles();
  private readonly bbo = new Bbo();
  private readonly vwap = new Vwap();
  private readonly profile = new Profile();
  private readonly markers = new Markers();

  private visibility: OverlayVisibility = { ...DEFAULT_OVERLAY_VISIBILITY };

  /** A real BBO print from the feed (preferred over the L2-derived fallback). */
  private channelBbo: BboState | null = null;
  private hasChannelBbo = false;

  constructor(gl: WebGL2RenderingContext, glCanvas: HTMLCanvasElement) {
    this.solid = new SolidBatch(gl);
    this.points = new PointBatch(gl);
    this.text = TextLayer.over(glCanvas);
  }

  /**
   * Rebuild the GL batches after a `webglcontextrestored` (their programs +
   * buffers were invalidated by the loss). The 2D text layer and all overlay
   * DATA (bounded rings/maps) survive untouched.
   *
   * We do NOT dispose the old batches: their GL objects were already freed by the
   * loss, and calling `deleteProgram`/`deleteBuffer` on the stale handles raises
   * INVALID_OPERATION on the restored context — which the very next `checkGLError`
   * (the ring/heatmap rebuild) would surface as a throw, aborting recovery. The
   * JS wrappers are simply replaced (and GC'd). Any residual error is drained so
   * the subsequent rebuild starts from a clean GL error queue.
   */
  recreateGL(gl: WebGL2RenderingContext): void {
    this.solid = new SolidBatch(gl);
    this.points = new PointBatch(gl);
    // eslint-disable-next-line no-empty
    while (gl.getError() !== gl.NO_ERROR) {
      /* drain any stale error so the ring/heatmap rebuild's checkGLError is clean */
    }
  }

  /** Wrap the price/time gutter canvases (App-owned) for tick drawing. */
  attachAxes(priceCanvas: HTMLCanvasElement | null, timeCanvas: HTMLCanvasElement | null): void {
    this.priceAxis = priceCanvas ? new TextLayer(priceCanvas, false) : null;
    this.timeAxis = timeCanvas ? new TextLayer(timeCanvas, false) : null;
  }

  setVisibility(v: Partial<OverlayVisibility>): void {
    this.visibility = { ...this.visibility, ...v };
  }

  getVisibility(): OverlayVisibility {
    return { ...this.visibility };
  }

  setBubbleMinSize(minSize: number): void {
    this.bubbles.setOptions({ minSize });
  }

  // --- stream routing -----------------------------------------------------------

  onTrade(t: Trade): void {
    this.bubbles.add(t);
  }

  onBbo(b: BBO): void {
    this.channelBbo = {
      bidPx: b.bid_px,
      bidSz: b.bid_sz,
      askPx: b.ask_px,
      askSz: b.ask_sz,
      source: 'bbo',
    };
    this.hasChannelBbo = true;
  }

  onBar(b: BarColumn): void {
    this.vwap.add(b);
  }

  onMarker(m: Marker): void {
    this.markers.add(m);
  }

  /** Prune per-window overlay memory (VWAP map) to the resident range. */
  prune(oldest: number, newest: number, pad = 64): void {
    this.vwap.prune(oldest, newest, pad);
  }

  /** Drop all overlay data (context loss / go-live re-seed / test reset). */
  reset(): void {
    this.bubbles.reset();
    this.bbo.reset();
    this.vwap.reset();
    this.markers.reset();
    this.channelBbo = null;
    this.hasChannelBbo = false;
  }

  /** Overlay data counts + last profile result (deterministic e2e assertions). */
  debug(): {
    bubbles: number;
    markers: number;
    vwap: number;
    hasChannelBbo: boolean;
    profilePoc: number;
    profileMax: number;
  } {
    return {
      bubbles: this.bubbles.length,
      markers: this.markers.length,
      vwap: this.vwap.size,
      hasChannelBbo: this.hasChannelBbo,
      profilePoc: this.profile.last?.pocRow ?? -1,
      profileMax: this.profile.last?.max ?? 0,
    };
  }

  /** Whether any overlay could draw (used by the renderer to skip cheaply). */
  get anyVisible(): boolean {
    const v = this.visibility;
    return v.bubbles || v.bbo || v.vwap || v.profile || v.markers || v.axes;
  }

  // --- draw ---------------------------------------------------------------------

  draw(ctx: OverlayDrawContext): void {
    const gm = new GridMap(ctx.view, ctx.dims, ctx.time, ctx.price);
    const frame: OverlayFrame = {
      gm,
      solid: this.solid,
      points: this.points,
      text: this.text,
      resident: ctx.resident,
      capability: ctx.capability,
      columnArrays: ctx.columnArrays,
    };

    // Text layer: size to the viewport, clear once, draw faint gridlines behind.
    this.text.syncSize(ctx.dims.cssW, ctx.dims.cssH, ctx.dpr);
    this.text.clear();
    if (this.visibility.axes) drawGridlines(this.text, gm);

    // GL overlays in spec draw order (each flushes its own geometry → z-order).
    if (this.visibility.profile) this.profile.draw(frame);
    if (this.visibility.vwap) this.vwap.draw(frame);
    if (this.visibility.bbo) {
      this.bbo.set(this.effectiveBbo(ctx));
      this.bbo.draw(frame);
    }
    if (this.visibility.bubbles) this.bubbles.draw(frame);
    if (this.visibility.markers) this.markers.draw(frame);

    // Honesty badges (§7): surface reduced-fidelity states on the text layer.
    this.drawHonestyBadges(ctx);

    // Axes into their gutters (share the viewport dimension → aligned).
    if (this.visibility.axes) {
      if (this.priceAxis) {
        this.priceAxis.syncSize(this.priceAxis.canvas.clientWidth, ctx.dims.cssH, ctx.dpr);
        drawPriceAxis(this.priceAxis, gm);
      }
      if (this.timeAxis) {
        this.timeAxis.syncSize(ctx.dims.cssW, this.timeAxis.canvas.clientHeight, ctx.dpr);
        drawTimeAxis(this.timeAxis, gm);
      }
    }
  }

  /** Channel BBO if the feed carries it, else the L2-derived inside quote. */
  private effectiveBbo(ctx: OverlayDrawContext): BboState | null {
    if (this.hasChannelBbo) return this.channelBbo;
    const depth = ctx.capability?.depth;
    if (depth !== 'L2' || ctx.price === null || ctx.newestArrays === null) return null;
    return deriveL2Bbo(ctx.newestArrays.bid, ctx.newestArrays.ask, ctx.price);
  }

  private drawHonestyBadges(ctx: OverlayDrawContext): void {
    const cap = ctx.capability;
    if (!cap) return;
    const badges: Array<{ text: string; color: string }> = [];
    if (this.visibility.bubbles && typeof cap.tape === 'string' && cap.tape !== 'tick') {
      badges.push({ text: 'BUBBLES 1m AGG', color: OVERLAY.event.css });
    }
    if (this.visibility.vwap && cap.vwap === 'approx') {
      badges.push({ text: 'VWAP approx', color: OVERLAY.vwap.css });
    }
    let y = 14;
    for (const b of badges) {
      this.text.badge(6, y, b.text, { align: 'left', color: b.color, size: 9, bg: OVERLAY.badgeBg });
      y += 18;
    }
  }

  dispose(): void {
    this.solid.dispose();
    this.points.dispose();
    this.text.dispose();
    // Gutter canvases are App-owned (not disposed here).
  }
}

/**
 * Inside quote from an L2 book column: best bid = highest row carrying bid
 * density (closest to the spread), best ask = lowest row carrying ask density.
 * Pure — exact reading of the book the server sent, not a fabricated quote.
 */
export function deriveL2Bbo(
  bid: Float32Array,
  ask: Float32Array | null,
  price: PriceMap,
): BboState | null {
  let bidRow = -1;
  for (let r = bid.length - 1; r >= 0; r--) {
    if (bid[r] > 0) {
      bidRow = r;
      break;
    }
  }
  let askRow = -1;
  if (ask !== null) {
    for (let r = 0; r < ask.length; r++) {
      if (ask[r] > 0) {
        askRow = r;
        break;
      }
    }
  }
  if (bidRow < 0 && askRow < 0) return null;
  return {
    bidPx: bidRow >= 0 ? price.p0 + bidRow * price.step : Number.NaN,
    bidSz: bidRow >= 0 ? bid[bidRow] : 0,
    askPx: askRow >= 0 ? price.p0 + askRow * price.step : Number.NaN,
    askSz: askRow >= 0 && ask !== null ? ask[askRow] : 0,
    source: 'l2',
  };
}
