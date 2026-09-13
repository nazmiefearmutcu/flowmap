/**
 * CVD lower pane (§ indicators).
 *
 * A thin strip beneath the heatmap that plots cumulative volume delta on its own
 * signed value axis. It is deliberately a SEPARATE canvas (CVD is not a price, so
 * it can't share the price grid), but it is horizontally LOCKED to the chart: it
 * reads the same `renderer.timeline()` window the heatmap draws with and maps
 * each column through {@link cvdColToX}, so panning / zooming / scrolling back in
 * time moves CVD in exact lock-step (the "RSI-style aligned sub-panel" behaviour).
 *
 * It checks a cheap signature (view window, newest column, pane size, feed
 * capability) and repaints only when it actually changes — a changed frame runs
 * at full frame rate, while an idle pane backs off to a slow poll instead of
 * spinning rAF at 60 fps with nothing to paint.
 *
 * Honesty (§7): CVD needs a real aggressor side. When the feed reports
 * `capability.cvd === 'na'` (keyless equity), the value would be a meaningless
 * flat zero, so the pane says so instead of drawing a line.
 */

import { useEffect, useRef, type RefObject } from 'react';

import type { Renderer } from '../gl/renderer';
import { OVERLAY } from '../gl/overlays/palette';
import { useFlowMapStore } from '../state/store';
import { cvdProject, cvdValueToY, fmtCvd, type ProjectedPoint } from './cvd';

interface CvdPaneProps {
  rendererRef: RefObject<Renderer | null>;
}

const AXIS = 'rgba(163, 176, 194, 0.75)';
const AXIS_FAINT = 'rgba(120, 132, 150, 0.28)';
const BG_FALLBACK = 'rgba(9, 12, 16, 1)';
/** Shipped amber fade of the CVD area fill (midnight/dark grounds). */
const AMBER_FILL_TOP = 'rgba(232, 176, 74, 0.26)';
const AMBER_FILL_MID = 'rgba(232, 176, 74, 0.10)';
const AMBER_FILL_BOTTOM = 'rgba(232, 176, 74, 0.02)';

/** Parse `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` to sRGB bytes. */
function parseColor(raw: string): [number, number, number] | null {
  const s = raw.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      return [
        Number.parseInt(h[0] + h[0], 16),
        Number.parseInt(h[1] + h[1], 16),
        Number.parseInt(h[2] + h[2], 16),
      ];
    }
    if (h.length === 6 || h.length === 8) {
      return [
        Number.parseInt(h.slice(0, 2), 16),
        Number.parseInt(h.slice(2, 4), 16),
        Number.parseInt(h.slice(4, 6), 16),
      ];
    }
    return null;
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
  if (!fn) return null;
  return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
}

/** Re-emit a resolvable CSS color at a fixed alpha (null when unparsable). */
function withAlpha(raw: string, alpha: number): string | null {
  const rgb = parseColor(raw);
  if (!rgb) return null;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/** WCAG relative luminance of a resolved CSS color (0 when unparsable). */
function relLuma(raw: string): number {
  const rgb = parseColor(raw);
  if (!rgb) return 0;
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** Pane ink resolved from the chart tokens (R1-H3). */
export interface CvdInk {
  ground: string;
  axis: string;
  zero: string;
  series: string;
  fillTop: string;
  fillMid: string;
  fillBottom: string;
  /** Ground-colored halo under the series stroke — separates the line from the
   *  same-hue fill (Bookmap "line over area" casing). */
  lineCasing: string;
  /** Last-value pill: solid series plate + ground text (the axis-pill grammar). */
  pillText: string;
  /** Small ground plate behind the top-left `CVD` tag + the baseline `0` label. */
  tagPlate: string;
}

/**
 * Resolve the pane's ground/ink from the `--chart-*` tokens at paint time so a
 * themed (light) chart ground is not painted with midnight literals. On a LIGHT
 * ground (`--chart-bg` relative luminance ≥ 0.5) the series + fill follow
 * `--chart-price`; on dark grounds the shipped amber series is kept
 * byte-identical. Labels follow `--chart-axis`, the zero baseline follows
 * `--chart-grid` at the shipped 0.28 alpha. Every token falls back to the
 * literal it replaced when unresolvable.
 */
export function resolveCvdInk(getVar: (name: string) => string): CvdInk {
  const raw = (name: string): string => getVar(name).trim();
  const ground = raw('--chart-bg') || BG_FALLBACK;
  const light = relLuma(ground) >= 0.5;
  const price = light ? raw('--chart-price') : '';
  return {
    ground,
    axis: withAlpha(raw('--chart-axis'), 0.75) ?? AXIS,
    zero: withAlpha(raw('--chart-grid'), 0.28) ?? AXIS_FAINT,
    series: withAlpha(price, 1) ?? OVERLAY.cvd.css,
    fillTop: withAlpha(price, 0.26) ?? AMBER_FILL_TOP,
    fillMid: withAlpha(price, 0.1) ?? AMBER_FILL_MID,
    fillBottom: withAlpha(price, 0.02) ?? AMBER_FILL_BOTTOM,
    lineCasing: withAlpha(ground, 0.55) ?? 'rgba(9, 12, 16, 0.55)',
    pillText: withAlpha(ground, 1) ?? 'rgba(9, 12, 16, 1)',
    tagPlate: withAlpha(ground, 0.72) ?? 'rgba(9, 12, 16, 0.72)',
  };
}


export function CvdPane({ rendererRef }: CvdPaneProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Reused projection buffer: one allocation that grows to the widest repaint,
  // then zero garbage per repaint (see cvd.ts cvdProject).
  const xyBufRef = useRef<ProjectedPoint[]>([]);
  // Read the honesty flag reactively; everything else is polled off the renderer.
  const cvdCap = useFlowMapStore((s) => (s.capability?.cvd as string | undefined) ?? null);
  const cvdCapRef = useRef<string | null>(cvdCap);
  cvdCapRef.current = cvdCap;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let pollTimer = 0;
    let lastSig = '';
    let idleStep = 0;
    // Idle backoff: a CHANGED frame re-arms at the next animation frame; an
    // unchanged one doubles its wait (capped) so an idle pane polls a few times
    // a second instead of spinning rAF at 60 fps with nothing to paint. Any
    // visible change snaps straight back to the full frame rate.
    const IDLE_MAX_MS = 250;
    const scheduleNext = (painted: boolean): void => {
      idleStep = painted ? 0 : Math.min(idleStep + 1, 8);
      const wait = painted ? 0 : Math.min(IDLE_MAX_MS, 2 ** idleStep);
      if (wait === 0) {
        raf = requestAnimationFrame(draw);
      } else {
        pollTimer = window.setTimeout(() => {
          raf = requestAnimationFrame(draw);
        }, wait);
      }
    };

    // One repaint of the pane. Split out of `draw` so the signature check (and
    // the idle scheduling) can wrap it without the paint's own early returns
    // (`na` capability, no timeline, empty series) skipping the reschedule.
    const paint = (
      r: Renderer | null,
      tl: ReturnType<Renderer['timeline']> | null,
      cap: string | null,
      cssW: number,
      cssH: number,
      dpr: number,
    ): void => {
      // Resize the drawing buffer to device pixels (once per size change).
      const wantW = Math.round(cssW * dpr);
      const wantH = Math.round(cssH * dpr);
      if (canvas.width !== wantW || canvas.height !== wantH) {
        canvas.width = wantW;
        canvas.height = wantH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      // R1-H3: resolve ground + ink from the live chart tokens each paint, so a
      // themed light ground gets ink that is actually visible on it.
      const ink = resolveCvdInk((name) => getComputedStyle(canvas).getPropertyValue(name));
      ctx.fillStyle = ink.ground;
      ctx.fillRect(0, 0, cssW, cssH);

      // Top-left tag on a small ground plate so it stays legible over the fill.
      ctx.font = '10px ui-monospace, monospace';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillStyle = ink.tagPlate;
      ctx.fillRect(4, 2, 28, 13);
      ctx.fillStyle = ink.series;
      ctx.fillText('CVD', 7, 4);

      // Honesty: no usable aggressor side → don't draw a fake flat zero.
      if (cap === 'na') {
        ctx.fillStyle = ink.axis;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('not measurable for this feed (no trade side)', cssW / 2, cssH / 2);
        return;
      }

      if (!tl || !r) return;
      const lo = Math.floor(tl.viewStartCol);
      const hi = Math.ceil(tl.viewEndCol);
      const pts = r.cvdSeries(lo, hi);
      if (pts.length === 0) return;

      // Single-pass, zero-allocation projection (bounds + x + y in place over a
      // reused buffer) — the old per-repaint `pts.map(...)` triple churned three
      // fresh arrays on every column flush.
      const proj = cvdProject(pts, tl.viewStartCol, tl.viewEndCol, cssW, cssH, xyBufRef.current);
      const bounds = proj.bounds;
      const xy = proj.xy;
      const zeroY = cvdValueToY(0, bounds, cssH);

      // Zero baseline (dashed, faint) — follows `--chart-grid` on light grounds.
      ctx.strokeStyle = ink.zero;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(cssW, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Build the polyline in the shared x transform (already projected above).

      // Filled area between the line and the zero baseline — a three-stop
      // vertical fade (strongest at the line, already quiet by mid-pane, gone
      // at the baseline) so the strip reads as an under-line wash instead of a
      // flat muddy slab.
      const yMin = xy.reduce((m, p) => Math.min(m, p.y), xy[0].y);
      const grad = ctx.createLinearGradient(0, yMin, 0, zeroY);
      grad.addColorStop(0, ink.fillTop);
      grad.addColorStop(0.4, ink.fillMid);
      grad.addColorStop(1, ink.fillBottom);
      ctx.beginPath();
      ctx.moveTo(xy[0].x, zeroY);
      for (const p of xy) ctx.lineTo(p.x, p.y);
      ctx.lineTo(xy[xy.length - 1].x, zeroY);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // The CVD line itself, stroked twice over one path: a ground-colored
      // casing first (invisible over the ground, separates the line from the
      // same-hue fill), then the series stroke.
      ctx.beginPath();
      ctx.moveTo(xy[0].x, xy[0].y);
      for (let i = 1; i < xy.length; i++) ctx.lineTo(xy[i].x, xy[i].y);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = ink.lineCasing;
      ctx.lineWidth = 3.4;
      ctx.stroke();
      ctx.strokeStyle = ink.series;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      // Baseline "0" marker on a small ground plate (drawn over the fill, so it
      // stays readable when the wash covers the baseline side).
      ctx.fillStyle = ink.tagPlate;
      ctx.fillRect(3, zeroY - 13, 13, 12);
      ctx.fillStyle = ink.axis;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('0', 6, zeroY - 2);

      // Latest value pill pinned to the right edge at the line end (the axis
      // pill grammar: solid series plate, ground text) — readable over both the
      // fill and the ground, unlike the old free-floating corner text.
      const last = pts[pts.length - 1];
      const lastXY = xy[xy.length - 1];
      ctx.fillStyle = ink.series;
      ctx.beginPath();
      ctx.arc(lastXY.x, lastXY.y, 2.4, 0, Math.PI * 2);
      ctx.fill();

      const label = fmtCvd(last.cvd);
      const tw = label.length * 6.2 + 12; // 10px mono advance ≈ 6.2px
      const ph = 14;
      const cr = 3;
      const px = cssW - tw - 2;
      const py = Math.min(Math.max(lastXY.y - ph / 2, 2), cssH - ph - 2);
      ctx.beginPath();
      ctx.moveTo(px + cr, py);
      ctx.lineTo(px + tw - cr, py);
      ctx.arc(px + tw - cr, py + cr, cr, -Math.PI / 2, 0);
      ctx.lineTo(px + tw, py + ph - cr);
      ctx.arc(px + tw - cr, py + ph - cr, cr, 0, Math.PI / 2);
      ctx.lineTo(px + cr, py + ph);
      ctx.arc(px + cr, py + ph - cr, cr, Math.PI / 2, Math.PI);
      ctx.lineTo(px, py + cr);
      ctx.arc(px + cr, py + cr, cr, Math.PI, 1.5 * Math.PI);
      ctx.closePath();
      ctx.fillStyle = ink.series;
      ctx.fill();
      ctx.fillStyle = ink.pillText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, px + tw / 2, py + ph / 2 + 0.5);
    };

    const draw = (): void => {
      const r = rendererRef.current;
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const cap = cvdCapRef.current;
      let painted = false;
      if (cssW !== 0 && cssH !== 0) {
        const tl = r?.timeline() ?? null;
        // The newest (forming) column's CVD mutates while every view field stays
        // fixed in follow mode, so fold its value into the signature — otherwise
        // the live tip + readout freeze until the next column is born. O(1) map
        // lookup. Signature: repaint only when something visible changed. The
        // applied theme is part of the signature so a theme switch re-inks a
        // quiet pane immediately (the tokens live on documentElement).
        const themeKey = document.documentElement.dataset.theme ?? '';
        const tipCvd = tl && r ? r.cvdValueAt(tl.newestSeq) : Number.NaN;
        const sig = tl
          ? `${cssW}x${cssH}|${dpr}|${cap}|${themeKey}|${tl.viewStartCol.toFixed(2)}|${tl.viewEndCol.toFixed(2)}|${tl.newestSeq}|${Number.isFinite(tipCvd) ? tipCvd : ''}`
          : `${cssW}x${cssH}|${dpr}|${cap}|${themeKey}|empty`;
        if (sig !== lastSig) {
          lastSig = sig;
          paint(r, tl, cap, cssW, cssH, dpr);
          painted = true;
        }
      }
      scheduleNext(painted);
    };

    scheduleNext(true); // first frame at full rate; the signature throttles after
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(pollTimer);
    };
  }, [rendererRef]);

  return (
    <section className="cvd-pane" data-testid="cvd-pane" aria-label="Cumulative volume delta">
      <canvas ref={canvasRef} className="cvd-pane__canvas" aria-hidden="true" />
    </section>
  );
}
