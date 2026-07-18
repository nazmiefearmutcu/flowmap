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
}

/** A thin 2D canvas layer; owns its `<canvas>` when created via {@link over}. */
export class TextLayer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly owned: boolean;
  private cssW = 0;
  private cssH = 0;

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
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    ctx.font = `${opts.weight ?? 400} ${opts.size ?? 11}px ${FONT_STACK}`;
    ctx.textAlign = opts.align ?? 'left';
    ctx.textBaseline = opts.baseline ?? 'alphabetic';
    ctx.fillStyle = opts.color ?? 'rgba(163, 176, 194, 1)';
    ctx.fillText(str, x, y);
  }

  /** A filled background badge with centered text — for price/BBO/marker labels. */
  badge(x: number, y: number, str: string, opts: BadgeOpts = {}): void {
    const ctx = this.ctx;
    const size = opts.size ?? 11;
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
    ctx.fillStyle = opts.bg ?? 'rgba(5, 8, 12, 0.82)';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.fillStyle = opts.color ?? 'rgba(230, 237, 243, 1)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(str, bx + pad, by + boxH / 2 + 0.5);
  }

  /** A thin 1px CSS-px line (axis ticks / rules on the text layer). */
  line(x0: number, y0: number, x1: number, y1: number, color: string, width = 1): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  dispose(): void {
    if (this.owned) this.canvas.remove();
  }
}
