/**
 * Event markers overlay (§2 G2, §7, §8.3, M2 T10).
 *
 * Event glyphs on the time axis / at their price, colored per kind:
 *   - liquidation           → filled triangle at its price (hot orange)
 *   - gap / session_break    → full-height vertical hatch at its column (grey)
 *   - large_lot / iceberg / halt / luld / info → small diamond at price/top (amber)
 *
 * DECLUTTER POLICY (F16, QA14 gapstack): labels used to overprint when several
 * markers landed in one viewport (six "GAP" chips in the same 40 px). The label
 * pass now:
 *   1. collapses same-kind labels within a pixel radius into ONE badge with a
 *      count ("GAP ×6") — the COUNT carries how many markers were merged;
 *   2. stacks remaining overlapping labels vertically (bounded pitch) so no two
 *      label boxes can overprint;
 *   3. caps the visible labels by priority — gap/session_break > seam (transport
 *      history-seam markers carry a "seam" note in their text) > other kinds —
 *      so the most load-bearing labels survive a busy frame.
 *
 * Honesty (§7): every marker still draws its GLYPH / full-height hatch — the
 * declutter only affects the text chips. Collapsed counts say how many markers
 * the single chip stands for, so no real gap is ever hidden, and the overlay
 * only ever draws markers the FEED actually sent (kinds present = exactly the
 * ones the capability advertises, e.g. equity keyless emits only `gap`).
 *
 * SEAM ANCHORING (F22, F9-L1): a time-instant marker (gap/session_break) whose
 * `ts_ns` is one of the ring's per-column t0 KNOTS is drawn ON that knot's left
 * edge — the column boundary the instant denotes. This matters at a reattach
 * seam, where the piecewise table is locally NON-monotonic (a reconstructed
 * block's t0 runs backward of the columns it lands after) and the coords.ts
 * ascending binary search otherwise interpolates a seam marker's knot several
 * block columns INTO the block (or, centered at +0.5, half a block column in).
 * Measured F9-L1: the trailing seam badge sat ~4 block columns inside the
 * block; the leading one half a block column in. With a knot match the leading
 * badge sits exactly at the first column of the discontinuity and the trailing
 * one at the block end (their shared boundary is the knot column's left edge);
 * markers with no knot keep the column-center placement.
 *
 * Markers live in a bounded ring (oldest first evicted) and only visible ones
 * are drawn → O(visible).
 */

import { toBigNs, type TimeSlots } from './coords';
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

/** Label font size (CSS px) — matches the draw call. */
const LABEL_SIZE = 9;
/** Conservative per-char advance of the label font at {@link LABEL_SIZE}. */
const LABEL_CHAR_W = 5.6;
/** Vertical pitch of stacked labels (CSS px); also the box height. */
const LABEL_PITCH = 12;
/** Same-kind labels closer than this collapse into one counted badge. */
const COLLAPSE_PX = 44;
/** Same-lane tolerance for collapsing (top lane vs price-row labels). */
const COLLAPSE_DY = 14;
/** Bounded vertical displacement attempts before a label is drawn in place. */
const STACK_MAX = 6;
/**
 * Search radius (columns) for the exact t0 knot of a time-instant marker. The
 * knot is at most a seam-jump/cadence away from the naive interpolation (the
 * measured F9-L1 burial is ~3-4 block columns), so this is generous while
 * keeping the scan bounded and allocation-free.
 */
const KNOT_SCAN_COLS = 512;

export interface MarkerOptions {
  capacity?: number;
  /** Max labels drawn per frame (glyphs/hatches are always drawn). */
  maxLabels?: number;
  glyphPx?: number;
}

const DEFAULTS: Required<MarkerOptions> = { capacity: 2000, maxLabels: 24, glyphPx: 7 };

/** One visible label before declutter. */
interface LabelCand {
  x: number;
  y: number;
  code: number;
  seam: boolean;
  rank: number;
}

/** A collapsed label group (count >= 1). */
interface LabelGroup {
  x: number;
  y: number;
  lastX: number;
  code: number;
  seam: boolean;
  rank: number;
  count: number;
}

export class Markers {
  private opts: Required<MarkerOptions>;
  private readonly ts: BigInt64Array;
  private readonly price: Float64Array;
  private readonly kind: Uint8Array;
  /** 1 when the marker text identifies a transport history seam (F9). */
  private readonly seam: Uint8Array;
  private head = 0;
  private count = 0;

  // Reused declutter scratch (a dirty frame should not allocate per marker).
  private readonly cands: LabelCand[] = [];
  private readonly groups: LabelGroup[] = [];

  constructor(opts: MarkerOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    const n = this.opts.capacity;
    this.ts = new BigInt64Array(n);
    this.price = new Float64Array(n);
    this.kind = new Uint8Array(n);
    this.seam = new Uint8Array(n);
  }

  get length(): number {
    return this.count;
  }

  add(m: Marker): void {
    const n = this.opts.capacity;
    this.ts[this.head] = toBigNs(m.ts_ns);
    this.price[this.head] = m.price === null ? Number.NaN : m.price;
    this.kind[this.head] = KIND_CODE[m.kind] ?? KIND_CODE.info;
    this.seam[this.head] = m.text ? (/seam/i.test(m.text) ? 1 : 0) : 0;
    this.head = (this.head + 1) % n;
    if (this.count < n) this.count += 1;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
  }

  /** Label priority: gap > seam > other (the cap keeps the top ranks). */
  private rankOf(code: number, seam: boolean): number {
    if (!seam && (code === KIND_CODE.gap || code === KIND_CODE.session_break)) return 0;
    if (seam) return 1;
    return 2;
  }

  private labelOf(code: number, seam: boolean): string {
    return seam ? 'SEAM' : CODE_LABEL[code];
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
    this.cands.length = 0;

    // Pass 1: glyphs/hatches for EVERY visible marker + label candidates
    // (unbounded here — priority/collapse decide what the text pass keeps).
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + n) % n;
      const code = this.kind[idx];
      const seam = this.seam[idx] === 1;
      const ts = this.ts[idx];
      let colf = gm.tsToCol(ts);
      if (VERTICAL.has(code)) {
        // Time-instant markers anchor on their exact column knot when the
        // piecewise table has one (F22/F9-L1): the hatch and chip land on the
        // discontinuity edge, not half a block column inside it. A seam's knot
        // can sit far from the naive mapping (coords.ts's range guard hands the
        // block region to the live affine → off-view), so seam markers get a
        // full-table fallback when the bounded local scan misses.
        let knot = this.knotCol(gm, ts, colf, false);
        if (knot === null && seam) knot = this.knotCol(gm, ts, colf, true);
        colf = knot === null ? colf + 0.5 : knot;
      } else {
        colf += 0.5; // center within the column
      }
      const cx = gm.clipX(colf);
      if (cx < -1.04 || cx > 1.04) continue;

      if (VERTICAL.has(code)) {
        // Full-height vertical hatch (time event, no price).
        solid.addThickLine(cx, -1, cx, 1, 1.2, OVERLAY.gap.gl, cssW, cssH);
        this.pushCand(gm.cssX(colf) + 3, 12, code, seam);
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
      this.pushCand(
        gm.cssX(colf) + this.opts.glyphPx + 2,
        // Match the glyph's near-top position when there is no price (glyph
        // draws at clip y 0.94); otherwise cssY(0) maps to grid row 0 (bottom)
        // and the label lands off-canvas.
        hasPrice ? gm.cssY(gm.priceToRow(p) + 0.5) + 3 : 12,
        code,
        seam,
      );
    }
    solid.flush();

    this.drawLabels(text);
  }

  private pushCand(x: number, y: number, code: number, seam: boolean): void {
    this.cands.push({ x, y, code, seam, rank: this.rankOf(code, seam) });
  }

  /**
   * The column whose t0 knot IS this marker's instant, or null. The piecewise
   * table is the ring's own per-column truth, but a reattach seam makes it
   * locally non-monotonic, and coords.ts's ascending binary search can then
   * interpolate a seam marker's ts — which IS one of the knots — several block
   * columns into the block (measured F9-L1: the trailing seam ~4 block columns
   * early), or reject it outright (ts below the table's first knot → the live
   * affine → the leading badge maps off-view). A knot is a column boundary, so
   * matching it places the badge exactly on the discontinuity (leading) / the
   * block end (trailing).
   *
   * Compared in float64 — the table's own storage domain (`slotT0` is written
   * as `Number(t0_ns)`, and the marker ts is converted the same way), so the
   * equality is exact for a knot that came from the same wire bigint. Searches
   * outward from the naive column; `full` lifts the {@link KNOT_SCAN_COLS}
   * bound (seam markers only — their knot may be anywhere in the table while
   * the naive mapping is nonsense). Null lets the caller keep the center
   * placement; allocation-free either way.
   */
  private knotCol(gm: OverlayFrame['gm'], ts: bigint, naive: number, full: boolean): number | null {
    const slots: TimeSlots | undefined = gm.time?.slots;
    if (slots === undefined) return null;
    const t0 = slots.t0;
    const n = t0.length;
    if (n === 0 || !Number.isFinite(naive)) return null;
    const tsf = Number(ts);
    if (!Number.isFinite(tsf)) return null;
    let at = Math.round(naive) - slots.startSeq;
    if (at < 0) at = 0;
    else if (at >= n) at = n - 1;
    if (t0[at] === tsf) return slots.startSeq + at;
    const max = full ? n : KNOT_SCAN_COLS;
    for (let d = 1; d <= max; d++) {
      const a = at - d;
      if (a >= 0 && t0[a] === tsf) return slots.startSeq + a;
      const b = at + d;
      if (b < n && t0[b] === tsf) return slots.startSeq + b;
      if (a < 0 && b >= n) return null;
    }
    return null;
  }

  /**
   * Collapse → cap → stack → draw. Groups are built rank-major (gap > seam >
   * marker) and x-minor, so the cap truncates the least load-bearing labels
   * first and collapse runs read left to right.
   */
  private drawLabels(text: OverlayFrame['text']): void {
    const cands = this.cands;
    cands.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.x - b.x));

    const groups = this.groups;
    groups.length = 0;
    for (const c of cands) {
      let merged = false;
      // Same-kind runs chain along x (single-linkage within COLLAPSE_PX).
      for (let g = groups.length - 1; g >= 0; g--) {
        const gr = groups[g];
        if (gr.rank !== c.rank || gr.code !== c.code || gr.seam !== c.seam) continue;
        if (Math.abs(c.y - gr.y) > COLLAPSE_DY) continue;
        if (Math.abs(c.x - gr.lastX) <= COLLAPSE_PX) {
          gr.count += 1;
          gr.lastX = c.x;
          merged = true;
          break;
        }
      }
      if (!merged) {
        groups.push({ x: c.x, y: c.y, lastX: c.x, code: c.code, seam: c.seam, rank: c.rank, count: 1 });
      }
    }

    // Priority cap: gap-family first, then seams, then everything else.
    const limit = Math.min(groups.length, this.opts.maxLabels);
    const placed: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
    for (let g = 0; g < limit; g++) {
      const gr = groups[g];
      const label = this.labelOf(gr.code, gr.seam) + (gr.count > 1 ? ` ×${gr.count}` : '');
      const w = label.length * LABEL_CHAR_W;
      // Bounded vertical displacement so overlapping label boxes never print
      // over each other (hatches stay put — only the chip moves).
      let y = gr.y;
      for (let t = 0; t < STACK_MAX; t++) {
        const box = { x0: gr.x, x1: gr.x + w, y0: y - LABEL_SIZE, y1: y + 3 };
        let hit = false;
        for (const b of placed) {
          if (box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0) {
            hit = true;
            break;
          }
        }
        if (!hit) break;
        y += LABEL_PITCH;
      }
      placed.push({ x0: gr.x, x1: gr.x + w, y0: y - LABEL_SIZE, y1: y + 3 });
      const color =
        gr.seam || gr.code === KIND_CODE.gap || gr.code === KIND_CODE.session_break
          ? OVERLAY.gap.css
          : gr.code === KIND_CODE.liquidation
            ? OVERLAY.liquidation.css
            : OVERLAY.event.css;
      text.text(gr.x, y, label, { color, size: LABEL_SIZE, weight: 600 });
    }
  }
}
