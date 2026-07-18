/**
 * BBO overlay (§2 G2, §8.3, M2 T10).
 *
 * The current best bid / best ask as two thin horizontal lines at their prices,
 * plus right-edge price-axis badges (size on the touch) via the text layer.
 *
 * Source (renderer-chosen, honesty per §7):
 *   - `'bbo'`  — a real {@link BBO} print from the feed (crypto BookTicker,
 *                equity L1). Preferred when the feed carries the channel.
 *   - `'l2'`   — inside quote DERIVED from the newest L2 depth column's book
 *                (highest bid row / lowest ask row). Used when the feed has a
 *                full L2 book but no separate BBO channel (e.g. the sim). The
 *                badge is tagged `·L2` so it's clear it's book-derived, not a
 *                distinct print — never fabricated.
 * A feed with neither (equity keyless / L1_BAND with no BBO) shows nothing.
 */

import type { OverlayFrame } from './frame';
import { OVERLAY } from './palette';

export type BboSource = 'bbo' | 'l2';

export interface BboState {
  bidPx: number;
  bidSz: number;
  askPx: number;
  askSz: number;
  source: BboSource;
}

/** Compact size label: integers plain, small values 1-2 decimals. */
function fmtSize(v: number): string {
  if (!(v > 0)) return '';
  if (v >= 1000) return v.toFixed(0);
  if (v >= 100) return v.toFixed(1);
  return v.toFixed(2);
}

export class Bbo {
  private current: BboState | null = null;

  set(state: BboState | null): void {
    this.current = state;
  }

  get(): BboState | null {
    return this.current;
  }

  reset(): void {
    this.current = null;
  }

  draw(frame: OverlayFrame): void {
    const bbo = this.current;
    const { gm, solid, text } = frame;
    if (bbo === null || gm.price === null) return;

    const cssW = gm.dims.cssW;
    const cssH = gm.dims.cssH;
    const decimals = gm.price.step > 0 ? Math.min(8, Math.max(0, Math.ceil(-Math.log10(gm.price.step)))) : 2;
    const tag = bbo.source === 'l2' ? ' ·L2' : '';

    const drawSide = (
      price: number,
      sz: number,
      color: (typeof OVERLAY)['bid'],
      key: string,
    ): void => {
      if (!Number.isFinite(price)) return; // one-sided book / unknown quote
      const rowf = gm.priceToRow(price);
      const y = gm.clipY(rowf);
      if (y < -1.02 || y > 1.02) return; // off-screen vertically
      solid.begin();
      solid.addThickLine(-1, y, 1, y, 1.4, color.gl, cssW, cssH);
      solid.flush();
      // Right-edge badge: e.g. "A 100.75 ×8·L2".
      const label = `${key} ${price.toFixed(decimals)}${sz > 0 ? ` ×${fmtSize(sz)}` : ''}${tag}`;
      const cy = gm.cssY(rowf);
      text.badge(cssW - 3, cy, label, { align: 'right', color: color.css, size: 10 });
    };

    drawSide(bbo.askPx, bbo.askSz, OVERLAY.ask, 'A');
    drawSide(bbo.bidPx, bbo.bidSz, OVERLAY.bid, 'B');
  }
}
