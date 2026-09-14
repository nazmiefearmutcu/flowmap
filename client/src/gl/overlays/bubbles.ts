/**
 * Trade bubbles overlay (§2 G2, §8.3, M2 T10).
 *
 * One round sprite per recent trade, positioned at (col from `ts_ns`, row from
 * `price`), radius ∝ √size (so area ≈ size), colored by aggressor side
 * (buy = teal, sell = red, unknown = grey). Trades live in a fixed-capacity ring
 * (oldest evicted first — the off-screen-left tail), and only the ones inside the
 * viewport are emitted, so the draw is O(visible) not O(history).
 *
 * SIZE POLICY (F25, Bookmap reference H5). Bookmap sizes dots by aggregated
 * volume *relative to the instrument's own tape* ("algorithm scales vs average
 * trade volume"), and its dots read ~10–24 px at default zoom. A fixed reference
 * cannot serve both BTC (median print ≈ 5e-4) and an instrument whose prints are
 * in the thousands — any constant floors one and caps the other. So the
 * reference is the tape's own p90, tracked in a small log-size histogram updated
 * O(1) per trade (no per-frame scan over the 120k ring, no allocation), and the
 * radius band spans 6–24 px diameter (`minRadiusPx` 3 … `maxRadiusPx` 12) with
 * `baseRadiusPx` 5 landing exactly on the p90 print.
 *
 * Measured anchor (owner's BTCUSDT recordings, n=278 prints):
 *   p50 5.3e-4 · p75 6.4e-3 · p90 3.0e-2 · p95 6.9e-2 · p99 2.5e-1 · max 1.07
 * → p75 = 6 px (floor) · p90 = 10 px · p95 = 15 px · p99+ = 24 px (cap).
 * Before F25 every print under ~2 BTC sat on the 6 px floor (2–4 px of ink),
 * which is exactly the "invisible specks" defect QA19 scored 3/10.
 *
 * CLUTTER (F25): bigger dots overlap; the draw thins them newest-first against
 * an 8 px occupancy grid (O(1) per print, no second pass, no merge) so a dense
 * chain along the trace reads as one mark instead of a row of specks.
 *
 * Capability honesty (§7): when the tape is not real tick data
 * (`capability.tape !== 'tick'`, e.g. equity keyless 1-minute aggregates) the
 * overlay still plots what the feed gives but the renderer shows a "1m AGG"
 * badge; a feed with no trades at all renders nothing (never fabricated).
 */

import { toBigNs } from './coords';
import type { OverlayFrame } from './frame';
import { OVERLAY } from './palette';
import type { RGBA } from './primitives';
import type { Trade } from '../../proto/types';
import { SIDE_BUY, SIDE_SELL } from '../../proto/types';

export interface BubbleOptions {
  /** Ring capacity (recent trades retained). */
  capacity?: number;
  /** Min trade size drawn (default 0 = show all). Configurable per §9 settings. */
  minSize?: number;
  /** Fixed reference size override (controlled tests / fixed-scale callers).
   *  Omitted = the overlay adapts to the session tape (p90, see the header). */
  refSize?: number;
  baseRadiusPx?: number;
  minRadiusPx?: number;
  maxRadiusPx?: number;
}

/** Fully resolved scale inputs for the pure radius function. */
export interface BubbleScale {
  refSize: number;
  baseRadiusPx: number;
  minRadiusPx: number;
  maxRadiusPx: number;
}

type ResolvedOptions = {
  capacity: number;
  minSize: number;
  refSize: number | undefined;
  baseRadiusPx: number;
  minRadiusPx: number;
  maxRadiusPx: number;
};

const DEFAULTS: ResolvedOptions = {
  // Large ring so the trade trail persists as far back as the heatmap does — the
  // old 6k cap evicted bubbles on the left while the depth history stayed, which
  // read as "the price trail gets deleted". The draw loop below breaks as soon as
  // it scans past the left edge, so this is still O(visible), not O(capacity).
  capacity: 120_000,
  minSize: 0,
  // Adaptive reference (p90 of the session tape); a fixed `refSize` overrides.
  refSize: undefined,
  // Radius band = 6–24 px diameter for meaningful sizes (Bookmap H5). The
  // reference print (p90) draws at the base radius; the cap keeps the biggest
  // prints from burying the price line and the heatmap.
  baseRadiusPx: 5,
  minRadiusPx: 3,
  maxRadiusPx: 12,
};

// --- adaptive size reference ------------------------------------------------------

const LOG_MIN = -8;
const LOG_MAX = 8;
/** Log-size histogram resolution (16 decades / 48 ≈ 1/3 decade per bucket). */
export const HIST_BUCKETS = 48;
const LOG_STEP = (LOG_MAX - LOG_MIN) / HIST_BUCKETS;
/** Decay cadence: every N adds the counts shrink ×0.75 (never below 1 while
 *  present), so a regime shift is followed instead of averaged forever. */
const HIST_DECAY_EVERY = 4096;

/** Log-size histogram bucket for a trade size (clamped to the table range). */
export function histBucketFor(size: number): number {
  if (!(size > 0) || !Number.isFinite(size)) return 0;
  const b = Math.floor((Math.log10(size) - LOG_MIN) / LOG_STEP);
  return Math.max(0, Math.min(HIST_BUCKETS - 1, b));
}

/** p90 from a size histogram: walk from the largest bucket down until 10% of the
 *  samples are covered; the reference is that bucket's geometric centre. 0 when
 *  the histogram is empty. Pure. */
export function refFromHistogram(hist: Uint32Array, total: number): number {
  if (total <= 0) return 0;
  const need = Math.max(1, Math.ceil(total * 0.1));
  let acc = 0;
  for (let b = hist.length - 1; b >= 0; b--) {
    acc += hist[b];
    if (acc >= need) return Math.pow(10, LOG_MIN + (b + 0.5) * LOG_STEP);
  }
  return Math.pow(10, LOG_MIN + 0.5 * LOG_STEP);
}

/** Bubble radius in CSS px for a trade size (√-area scaling, clamped). Pure. */
export function bubbleRadiusPx(size: number, opts: BubbleScale): number {
  const s = Math.max(0, size);
  const r = opts.baseRadiusPx * Math.sqrt(s / Math.max(1e-9, opts.refSize));
  return Math.max(opts.minRadiusPx, Math.min(opts.maxRadiusPx, r));
}

/**
 * Hard cap on the bubble ink alpha. The palette path (`applyOverlayPalette`)
 * owns the hue AND the base alpha per theme; the overlay clamps it so a dense
 * tape can never bury the field — bubbles stay context, not the protagonist.
 * Pure; rgb never touched.
 */
export const BUBBLE_MAX_ALPHA = 0.85;

export function bubbleAlpha(c: RGBA): number {
  return Math.min(c[3], BUBBLE_MAX_ALPHA);
}

/** Overlap-thinning occupancy cell size, CSS px. */
const THIN_CELL = 8;
/** Radius-sum fraction within which a print is treated as already marked. */
const THIN_FRAC = 0.5;

export class Bubbles {
  private opts: ResolvedOptions;
  private readonly ts: BigInt64Array;
  private readonly price: Float64Array;
  private readonly size: Float32Array;
  private readonly side: Uint8Array;
  /** Reused per-point ink tuple — the draw pass must not allocate per bubble. */
  private readonly ink: [number, number, number, number] = [0, 0, 0, 0];
  private head = 0;
  private count = 0;

  // Adaptive reference state (see the header). `refCache` 0 = recompute on draw.
  private readonly hist = new Uint32Array(HIST_BUCKETS);
  private histTotal = 0;
  private histAdds = 0;
  private refCache = 0;
  /** Reused scale tuple so the draw pass allocates nothing. */
  private readonly scale: BubbleScale = {
    refSize: 1,
    baseRadiusPx: DEFAULTS.baseRadiusPx,
    minRadiusPx: DEFAULTS.minRadiusPx,
    maxRadiusPx: DEFAULTS.maxRadiusPx,
  };

  // Overlap-thinning scratch: a generation-stamped occupancy grid over the CSS
  // surface (no per-frame clear, no allocation after the first frame).
  private thinGen: Int32Array | null = null;
  private thinData: Float32Array | null = null;
  private thinFrame = 0;
  private thinCellsW = 0;
  private thinCellsH = 0;

  constructor(opts: BubbleOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    const n = this.opts.capacity;
    this.ts = new BigInt64Array(n);
    this.price = new Float64Array(n);
    this.size = new Float32Array(n);
    this.side = new Uint8Array(n);
  }

  get length(): number {
    return this.count;
  }

  setOptions(opts: Partial<BubbleOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  /** Record a trade (evicts the oldest once the ring is full). */
  add(t: Trade): void {
    const n = this.opts.capacity;
    const size = Math.max(0, t.size);
    this.ts[this.head] = toBigNs(t.ts_ns);
    this.price[this.head] = t.price;
    this.size[this.head] = size;
    this.side[this.head] = t.side;
    this.head = (this.head + 1) % n;
    if (this.count < n) this.count += 1;
    // Adaptive reference bookkeeping: O(1) per trade; the decay pass below runs
    // once every 4096 adds (48 buckets — still O(1) amortized).
    this.hist[histBucketFor(size)] += 1;
    this.histTotal += 1;
    this.refCache = 0;
    if (++this.histAdds >= HIST_DECAY_EVERY) {
      this.histAdds = 0;
      let total = 0;
      for (let i = 0; i < this.hist.length; i++) {
        const v = (this.hist[i] * 3 + 1) >> 2; // ×0.75, floor 1 while present
        this.hist[i] = v;
        total += v;
      }
      this.histTotal = total;
    }
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.hist.fill(0);
    this.histTotal = 0;
    this.histAdds = 0;
    this.refCache = 0;
  }

  /** The scale in force for the next draw: fixed override or adaptive p90. */
  refSize(): number {
    if (this.opts.refSize !== undefined) return this.opts.refSize;
    if (this.refCache === 0) {
      const r = refFromHistogram(this.hist, this.histTotal);
      this.refCache = r > 0 ? r : 1;
    }
    return this.refCache;
  }

  draw(frame: OverlayFrame): void {
    const { gm, points } = frame;
    if (!gm.hasEvents || this.count === 0) return;
    const n = this.opts.capacity;
    const minSize = this.opts.minSize;
    const scale = this.scale;
    scale.refSize = this.refSize();
    scale.baseRadiusPx = this.opts.baseRadiusPx;
    scale.minRadiusPx = this.opts.minRadiusPx;
    scale.maxRadiusPx = this.opts.maxRadiusPx;
    this.beginThin(gm);
    points.begin();
    // Scan newest → oldest. Timestamps are monotonic in insertion order, so the
    // horizontal position decreases monotonically as we walk back: once a bubble
    // sits left of the viewport, every remaining (older) one does too → break.
    // That keeps the pass O(visible) no matter how large the ring is.
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + n) % n;
      const colf = gm.tsToCol(this.ts[idx]) + 0.5; // center within the column
      const cx = gm.clipX(colf);
      if (cx > 1.04) continue; // newer than the right edge (scrolled back): keep scanning
      if (cx < -1.04) break; // older than the left edge: all remaining are older too
      const size = this.size[idx];
      if (size < minSize) continue;
      const rowf = gm.priceToRow(this.price[idx]) + 0.5;
      const cy = gm.clipY(rowf);
      if (cy < -1.04 || cy > 1.04) continue;
      const rPx = bubbleRadiusPx(size, scale);
      // Overlap thinning (newest wins): skip a print already covered by a newer
      // bubble so dense chains stay legible. The survivor keeps its own size.
      if (this.thinned(gm, colf, rowf, rPx)) continue;
      const base =
        this.side[idx] === SIDE_BUY
          ? OVERLAY.buy.gl
          : this.side[idx] === SIDE_SELL
            ? OVERLAY.sell.gl
            : OVERLAY.unknown.gl;
      // Theme-aware ink: rgb from the palette path, alpha capped (≤ 0.85).
      const ink = this.ink;
      ink[0] = base[0];
      ink[1] = base[1];
      ink[2] = base[2];
      ink[3] = bubbleAlpha(base);
      points.add(cx, cy, gm.pxToDevice(rPx * 2), ink);
    }
    points.flush();
  }

  /** Reset the occupancy grid generation for a frame (no clearing pass). */
  private beginThin(gm: OverlayFrame['gm']): void {
    const cellsW = Math.max(1, Math.ceil(gm.dims.cssW / THIN_CELL) + 2);
    const cellsH = Math.max(1, Math.ceil(gm.dims.cssH / THIN_CELL) + 2);
    if (this.thinGen === null || this.thinCellsW !== cellsW || this.thinCellsH !== cellsH) {
      this.thinCellsW = cellsW;
      this.thinCellsH = cellsH;
      this.thinGen = new Int32Array(cellsW * cellsH);
      this.thinData = new Float32Array(cellsW * cellsH * 3);
      this.thinFrame = 0;
    }
    if (this.thinFrame >= 0x7ffffffe) {
      this.thinGen.fill(0);
      this.thinFrame = 0;
    }
    this.thinFrame += 1;
  }

  /**
   * True when a NEWER drawn bubble already covers this print's centre. O(1):
   * probe the 3×3 neighbourhood of the print's 8 px CSS cell; compare centre
   * distance against `THIN_FRAC · (rNew + rDrawn)`. Records the print when free.
   */
  private thinned(gm: OverlayFrame['gm'], colf: number, rowf: number, rPx: number): boolean {
    const gen = this.thinGen;
    const data = this.thinData;
    if (gen === null || data === null) return false;
    const px = gm.cssX(colf);
    const py = gm.cssY(rowf);
    const ix = Math.floor(px / THIN_CELL) + 1;
    const iy = Math.floor(py / THIN_CELL) + 1;
    const w = this.thinCellsW;
    for (let oy = -1; oy <= 1; oy++) {
      const row = (iy + oy) * w;
      for (let ox = -1; ox <= 1; ox++) {
        const cell = row + ix + ox;
        if (cell < 0 || cell >= gen.length || gen[cell] !== this.thinFrame) continue;
        const o = cell * 3;
        const dx = px - data[o];
        const dy = py - data[o + 1];
        const lim = THIN_FRAC * (rPx + data[o + 2]);
        if (dx * dx + dy * dy < lim * lim) return true;
      }
    }
    if (ix >= 0 && ix < w && iy >= 0 && iy < this.thinCellsH) {
      const cell = iy * w + ix;
      gen[cell] = this.thinFrame;
      const o = cell * 3;
      data[o] = px;
      data[o + 1] = py;
      data[o + 2] = rPx;
    }
    return false;
  }
}
