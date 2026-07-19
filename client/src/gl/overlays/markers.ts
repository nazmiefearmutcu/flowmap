/**
 * Event markers overlay (§2 G2, §7, §8.3, M2 T10).
 *
 * Event glyphs on the time axis / at their price, colored per kind:
 *   - liquidation           → filled triangle at its price (hot orange)
 *   - gap / session_break    → full-height vertical hatch at its column (grey)
 *   - large_lot / iceberg / halt / luld / info → small diamond at price/top (amber)
 * A short label is drawn next to each visible glyph (the "tooltip"), capped so a
 * cluster never floods the canvas. Markers live in a bounded ring (oldest first
 * evicted) and only visible ones are drawn → O(visible).
 *
 * Honesty (§7): the overlay only ever draws markers the FEED actually sent, so
 * the kinds present are exactly the ones the capability advertises
 * (`capability.markers`) — e.g. equity keyless emits only `gap`. Nothing is
 * fabricated; a feed that emits no markers shows nothing.
 */

import { toBigNs } from './coords';
import type { OverlayFrame } from './frame';
import { OVERLAY } from './palette';
import type { Marker, MarkerKind } from '../../proto/types';

const KIND_CODE: Record<MarkerKind, number> = {
  liquidation: 0,
  halt: 1,
  luld: 2,
  gap: 3,
  session_break: 4,
  large_lot: 5,
  iceberg: 6,
  info: 7,
};
const CODE_LABEL = ['LIQ', 'HALT', 'LULD', 'GAP', 'BRK', 'LOT', 'ICE', 'INFO'];
/** Kinds rendered as a full-height vertical line rather than a price glyph. */
const VERTICAL = new Set([KIND_CODE.gap, KIND_CODE.session_break]);

export interface MarkerOptions {
  capacity?: number;
  /** Max labels drawn per frame (glyphs are always drawn). */
  maxLabels?: number;
  glyphPx?: number;
}

const DEFAULTS: Required<MarkerOptions> = { capacity: 2000, maxLabels: 24, glyphPx: 7 };

export class Markers {
  private opts: Required<MarkerOptions>;
  private readonly ts: BigInt64Array;
  private readonly price: Float64Array;
  private readonly kind: Uint8Array;
  private head = 0;
  private count = 0;

  constructor(opts: MarkerOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    const n = this.opts.capacity;
    this.ts = new BigInt64Array(n);
    this.price = new Float64Array(n);
    this.kind = new Uint8Array(n);
  }

  get length(): number {
    return this.count;
  }

  add(m: Marker): void {
    const n = this.opts.capacity;
    this.ts[this.head] = toBigNs(m.ts_ns);
    this.price[this.head] = m.price === null ? Number.NaN : m.price;
    this.kind[this.head] = KIND_CODE[m.kind] ?? KIND_CODE.info;
    this.head = (this.head + 1) % n;
    if (this.count < n) this.count += 1;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
  }

  draw(frame: OverlayFrame): void {
    const { gm, solid, text } = frame;
    if (!gm.hasEvents || this.count === 0) return;
    const n = this.opts.capacity;
    const cssW = gm.dims.cssW;
    const cssH = gm.dims.cssH;
    const gx = gm.pxToClipW(this.opts.glyphPx);
    const gy = gm.pxToClipH(this.opts.glyphPx);

    solid.begin();
    let labels = 0;
    const pending: Array<{ cssX: number; cssY: number; label: string; color: string }> = [];

    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + n) % n;
      const colf = gm.tsToCol(this.ts[idx]) + 0.5;
      const cx = gm.clipX(colf);
      if (cx < -1.04 || cx > 1.04) continue;
      const code = this.kind[idx];

      if (VERTICAL.has(code)) {
        // Full-height vertical hatch (time event, no price).
        solid.addThickLine(cx, -1, cx, 1, 1.2, OVERLAY.gap.gl, cssW, cssH);
        if (labels < this.opts.maxLabels) {
          pending.push({ cssX: gm.cssX(colf) + 3, cssY: 12, label: CODE_LABEL[code], color: OVERLAY.gap.css });
          labels++;
        }
        continue;
      }

      const p = this.price[idx];
      const hasPrice = Number.isFinite(p);
      const cy = hasPrice ? gm.clipY(gm.priceToRow(p) + 0.5) : 0.94; // near top when no price
      if (cy < -1.04 || cy > 1.04) continue;

      if (code === KIND_CODE.liquidation) {
        // Upward triangle centered on the price.
        solid.addTri(cx, cy + gy, cx - gx, cy - gy, cx + gx, cy - gy, OVERLAY.liquidation.gl);
      } else {
        // Diamond glyph for the other event kinds.
        solid.addQuad(cx, cy + gy, cx + gx, cy, cx, cy - gy, cx - gx, cy, OVERLAY.event.gl);
      }
      if (labels < this.opts.maxLabels) {
        const color = code === KIND_CODE.liquidation ? OVERLAY.liquidation.css : OVERLAY.event.css;
        pending.push({
          cssX: gm.cssX(colf) + this.opts.glyphPx + 2,
          // Match the glyph's near-top position when there is no price (glyph
          // draws at clip y 0.94); otherwise cssY(0) maps to grid row 0 (bottom)
          // and the label lands off-canvas.
          cssY: hasPrice ? gm.cssY(gm.priceToRow(p) + 0.5) + 3 : 12,
          label: CODE_LABEL[code],
          color,
        });
        labels++;
      }
    }
    solid.flush();

    // Labels last so glyphs never overpaint them.
    for (const l of pending) {
      text.text(l.cssX, l.cssY, l.label, { color: l.color, size: 9, weight: 600 });
    }
  }
}
