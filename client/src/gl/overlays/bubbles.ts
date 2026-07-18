/**
 * Trade bubbles overlay (§2 G2, §8.3, M2 T10).
 *
 * One round sprite per recent trade, positioned at (col from `ts_ns`, row from
 * `price`), radius ∝ √size (so area ≈ size), colored by aggressor side
 * (buy = teal, sell = red, unknown = grey). Trades live in a fixed-capacity ring
 * (oldest evicted first — the off-screen-left tail), and only the ones inside the
 * viewport are emitted, so the draw is O(visible) not O(history).
 *
 * Capability honesty (§7): when the tape is not real tick data
 * (`capability.tape !== 'tick'`, e.g. equity keyless 1-minute aggregates) the
 * overlay still plots what the feed gives but the renderer shows a "1m AGG"
 * badge; a feed with no trades at all renders nothing (never fabricated).
 */

import { toBigNs } from './coords';
import type { OverlayFrame } from './frame';
import { OVERLAY } from './palette';
import type { Trade } from '../../proto/types';
import { SIDE_BUY, SIDE_SELL } from '../../proto/types';

export interface BubbleOptions {
  /** Ring capacity (recent trades retained). */
  capacity?: number;
  /** Min trade size drawn (default 0 = show all). Configurable per §9 settings. */
  minSize?: number;
  /** Reference size mapped to `baseRadiusPx` (radius ∝ √(size/ref)). */
  refSize?: number;
  baseRadiusPx?: number;
  minRadiusPx?: number;
  maxRadiusPx?: number;
}

const DEFAULTS: Required<BubbleOptions> = {
  capacity: 6000,
  minSize: 0,
  refSize: 4,
  baseRadiusPx: 5,
  minRadiusPx: 2,
  maxRadiusPx: 26,
};

/** Bubble radius in CSS px for a trade size (√-area scaling, clamped). Pure. */
export function bubbleRadiusPx(size: number, opts: Required<BubbleOptions>): number {
  const s = Math.max(0, size);
  const r = opts.baseRadiusPx * Math.sqrt(s / Math.max(1e-9, opts.refSize));
  return Math.max(opts.minRadiusPx, Math.min(opts.maxRadiusPx, r));
}

export class Bubbles {
  private opts: Required<BubbleOptions>;
  private readonly ts: BigInt64Array;
  private readonly price: Float64Array;
  private readonly size: Float32Array;
  private readonly side: Uint8Array;
  private head = 0;
  private count = 0;

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
    this.ts[this.head] = toBigNs(t.ts_ns);
    this.price[this.head] = t.price;
    this.size[this.head] = t.size;
    this.side[this.head] = t.side;
    this.head = (this.head + 1) % n;
    if (this.count < n) this.count += 1;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
  }

  draw(frame: OverlayFrame): void {
    const { gm, points } = frame;
    if (!gm.hasEvents || this.count === 0) return;
    const n = this.opts.capacity;
    const minSize = this.opts.minSize;
    points.begin();
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + n) % n;
      const size = this.size[idx];
      if (size < minSize) continue;
      const colf = gm.tsToCol(this.ts[idx]) + 0.5; // center within the column
      const cx = gm.clipX(colf);
      if (cx < -1.04 || cx > 1.04) continue; // off-screen-left/right: skip
      const rowf = gm.priceToRow(this.price[idx]) + 0.5;
      const cy = gm.clipY(rowf);
      if (cy < -1.04 || cy > 1.04) continue;
      const rPx = bubbleRadiusPx(size, this.opts);
      const color =
        this.side[idx] === SIDE_BUY
          ? OVERLAY.buy.gl
          : this.side[idx] === SIDE_SELL
            ? OVERLAY.sell.gl
            : OVERLAY.unknown.gl;
      points.add(cx, cy, gm.pxToDevice(rPx * 2), color);
    }
    points.flush();
  }
}
