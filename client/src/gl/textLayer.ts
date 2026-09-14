/**
 * 2D text layer (§8.3: "one 2D-canvas text layer", M2 T10).
 *
 * A single `<canvas>` for ALL overlay text — axis tick labels, BBO price badges,
 * marker labels, future readouts — layered over the GL canvas (or, for the price
 * / time gutters, its own canvas). Text can't go through GL cheaply, so it lives
 * here; it is positioned via the SAME camera ({@link GridMap} → CSS px) so labels
 * pan/zoom locked to the heatmap, and it is cleared+redrawn only on DIRTY frames
 * (never per-mouse-move), matching the renderer's dirty-only loop.
 *
 * The backing store is sized to DEVICE px (DPR-aware) and the context pre-scaled
 * by DPR, so all draw calls use CSS px coordinates and text is crisp on retina.
 * Pure DOM/2D — no GL — so it survives a WebGL context loss untouched.
 */

const FONT_STACK = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Default font size (CSS px) for {@link TextLayer.text} — exported so callers
 *  (e.g. the price axis) can name the standard size instead of re-declaring the
 *  literal; the method default is unchanged. */
export const DEFAULT_TEXT_SIZE = 11;
/** Default font size (CSS px) for {@link TextLayer.badge} plates (unused by axis
 *  pills today, which pass their own size; exported for the same reason). */
export const DEFAULT_BADGE_SIZE = 11;

export interface TextOpts {
  /** Font size in CSS px (default 11). */
  size?: number;
  /** Fill color (default a dim axis grey). */
  color?: string;
  /** Horizontal anchor (default 'left'). */
  align?: CanvasTextAlign;
  /** Vertical baseline (default 'alphabetic'). */
  baseline?: CanvasTextBaseline;
  /** Font weight (default 400). */
  weight?: number;
}

export interface BadgeOpts extends TextOpts {
  /** Background fill behind the text (default near-black chrome). */
  bg?: string;
  /** Padding in CSS px around the text (default 3). */
  pad?: number;
  /** Corner radius in CSS px (default 0 = square, the terminal look). */
  radius?: number;
}

/** A device-independent point in CSS-px coordinates on this layer. */
export interface Pt {
  x: number;
  y: number;
}

/** A thin 2D canvas layer; owns its `<canvas>` when created via {@link over}. */
export class TextLayer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly owned: boolean;
  private cssW = 0;
  private cssH = 0;
  /** Device-pixel ratio the backing store was last sized for (see syncSize). */
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, owned = false) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('flowmap/textLayer: 2D context unavailable');
    this.canvas = canvas;
    this.ctx = ctx;
    this.owned = owned;
  }

  /**
   * Create a text canvas layered exactly over `glCanvas` (same parent box),
   * click-through (`pointer-events: none`) so gestures/crosshair still reach the
   * GL canvas underneath.
   */
  static over(glCanvas: HTMLCanvasElement): TextLayer {
    const canvas = document.createElement('canvas');
    canvas.className = 'overlay-text';
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    const parent = glCanvas.parentElement ?? document.body;
    parent.appendChild(canvas);
    return new TextLayer(canvas, true);
  }

  get width(): number {
    return this.cssW;
  }
  get height(): number {
    return this.cssH;
  }

  /** Match the backing store to a CSS box at `dpr`; pre-scale so draws use CSS px. */
  syncSize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr > 0 ? dpr : 1;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /**
   * Snap a CSS-px coordinate so an axis-aligned hairline of CSS width `width`
   * rasterizes with BOTH stroke edges on device-pixel boundaries — the
   * condition for the stroke to cover whole device pixels instead of straddling
   * with 50% edge alpha:
   *   - odd device width (1 device px at DPR 1, 3 at DPR 3) → center on a device
   *     pixel CENTER: one crisp row/column, exactly the old DPR1 behavior;
   *   - even device width (1 CSS px at DPR 2 = 2 device px) → center on a device
   *     pixel BOUNDARY: two full rows/columns instead of the `0.5/1/0.5` smear
   *     that pixel-center snapping produces for even widths (QA10 M1).
   * The edges land at `round(v·dpr − dw/2)` and `+ dw` — both integers whenever
   * the device width `dw` is an integer, for every DPR.
   */
  private snapStroke(v: number, width: number): number {
    const dw = width * this.dpr;
    return (Math.round(v * this.dpr - dw / 2) + dw / 2) / this.dpr;
  }

  /** Clear the whole layer (call once at the start of a dirty frame). */
  clear(): void {
    // clearRect ignores the current transform's translate but respects scale;
    // clearing the full CSS box covers the device buffer since we only scale.
    this.ctx.clearRect(0, 0, this.cssW, this.cssH);
  }

  /** Draw a single line of text at CSS `(x, y)`. */
  text(x: number, y: number, str: string, opts: TextOpts = {}): void {
    const ctx = this.ctx;
    ctx.font = `${opts.weight ?? 400} ${opts.size ?? DEFAULT_TEXT_SIZE}px ${FONT_STACK}`;
    ctx.textAlign = opts.align ?? 'left';
    ctx.textBaseline = opts.baseline ?? 'alphabetic';
    ctx.fillStyle = opts.color ?? 'rgba(163, 176, 194, 1)';
    ctx.fillText(str, x, y);
  }

  /** A filled background badge with centered text — for price/BBO/marker labels. */
  badge(x: number, y: number, str: string, opts: BadgeOpts = {}): void {
    const ctx = this.ctx;
    const size = opts.size ?? DEFAULT_BADGE_SIZE;
    const pad = opts.pad ?? 3;
    const align = opts.align ?? 'left';
    const baseline = opts.baseline ?? 'middle';
    ctx.font = `${opts.weight ?? 500} ${size}px ${FONT_STACK}`;
    const w = ctx.measureText(str).width;
    const boxW = w + pad * 2;
    const boxH = size + pad * 2;
    let bx = x;
    if (align === 'right') bx = x - boxW;
    else if (align === 'center') bx = x - boxW / 2;
    let by = y - boxH / 2;
    if (baseline === 'top') by = y;
    else if (baseline === 'bottom') by = y - boxH;
    const r = Math.min(opts.radius ?? 0, boxH / 2, boxW / 2);
    if (r > 0) {
      ctx.beginPath();
      ctx.moveTo(bx + r, by);
      ctx.arcTo(bx + boxW, by, bx + boxW, by + boxH, r);
      ctx.arcTo(bx + boxW, by + boxH, bx, by + boxH, r);
      ctx.arcTo(bx, by + boxH, bx, by, r);
      ctx.arcTo(bx, by, bx + boxW, by, r);
      ctx.closePath();
      ctx.fillStyle = opts.bg ?? 'rgba(5, 8, 12, 0.82)';
      ctx.fill();
    } else {
      ctx.fillStyle = opts.bg ?? 'rgba(5, 8, 12, 0.82)';
      ctx.fillRect(bx, by, boxW, boxH);
    }
    ctx.fillStyle = opts.color ?? 'rgba(230, 237, 243, 1)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(str, bx + pad, by + boxH / 2 + 0.5);
  }

  /**
   * An anti-aliased polyline through CSS-px points (round joins/caps). This is
   * how the price line gets its TradingView-smooth look: 2D-canvas stroking has
   * real AA + join geometry, which the raw GL triangle batches cannot give.
   */
  polyline(pts: Pt[], opts: { width: number; color: string; alpha?: number } = { width: 1, color: '#fff' }): void {
    if (pts.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = opts.width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Fill the region between a polyline and a horizontal baseline with a vertical
   * gradient (top color under the line → bottom color, usually transparent).
   * The subtle "area under the price" wash a trading chart expects.
   */
  fillUnder(pts: Pt[], yBase: number, colorTop: string, colorBottom: string): void {
    if (pts.length < 2) return;
    const ctx = this.ctx;
    let yMin = pts[0].y;
    for (const p of pts) yMin = Math.min(yMin, p.y);
    if (yMin >= yBase) return;
    ctx.save();
    const grad = ctx.createLinearGradient(0, yMin, 0, yBase);
    grad.addColorStop(0, colorTop);
    grad.addColorStop(1, colorBottom);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, yBase);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(pts[pts.length - 1].x, yBase);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** A dashed 1px line (the last-price level marker across the chart). A
   *  horizontal run at hairline width snaps its constant axis to the device
   *  stroke grid (see {@link snapStroke}) so the dashes stay crisp; thicker or
   *  sloped runs keep anti-aliased placement. */
  dashedLine(x0: number, y0: number, x1: number, y1: number, color: string, dash: number[] = [4, 4], width = 1): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    if (width <= 1 && y0 === y1) {
      const y = this.snapStroke(y0, width);
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    } else {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** A thin 1px CSS-px line (axis ticks / rules on the text layer). Axis-aligned
   *  hairlines snap their constant axis onto the device STROKE grid — a 1px
   *  stroke drawn at a fractional coordinate covers two physical rows at 50%
   *  alpha each, and at DPR 2 the pixel-center convention smears it over THREE
   *  rows (0.5/1/0.5) — see {@link snapStroke}: odd device widths center on a
   *  device pixel, even widths land on a device boundary (2 clean device px at
   *  DPR 2). Snapping only the CONSTANT axis of an axis-aligned run keeps every
   *  other shape's anti-aliasing untouched. `alpha` (default 1) is for chrome
   *  that must read quieter than the labels it serves — e.g. the axis tick
   *  marks, which are deliberately dimmer than the tick text (§9 Bookmap-class
   *  axis: the ladder data is the ink, the ticks are guides). */
  line(x0: number, y0: number, x1: number, y1: number, color: string, width = 1, alpha = 1): void {
    const ctx = this.ctx;
    ctx.save();
    if (alpha !== 1) ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    if (width <= 1 && (y0 === y1 || x0 === x1)) {
      if (y0 === y1) {
        const y = this.snapStroke(y0, width);
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      } else {
        const x = this.snapStroke(x0, width);
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
      }
    } else {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    ctx.restore();
  }

  dispose(): void {
    if (this.owned) this.canvas.remove();
  }
}
