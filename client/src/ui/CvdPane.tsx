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
 * It re-reads the transform every animation frame but only repaints when the view
 * window, the newest column, the pane size, or the feed capability actually
 * changes — so an idle chart costs nothing.
 *
 * Honesty (§7): CVD needs a real aggressor side. When the feed reports
 * `capability.cvd === 'na'` (keyless equity), the value would be a meaningless
 * flat zero, so the pane says so instead of drawing a line.
 */

import { useEffect, useRef, type RefObject } from 'react';

import type { Renderer } from '../gl/renderer';
import { OVERLAY } from '../gl/overlays/palette';
import { useFlowMapStore } from '../state/store';
import { cvdBounds, cvdColToX, cvdValueToY, fmtCvd } from './cvd';

interface CvdPaneProps {
  rendererRef: RefObject<Renderer | null>;
}

const AXIS = 'rgba(163, 176, 194, 0.75)';
const AXIS_FAINT = 'rgba(120, 132, 150, 0.28)';
const BG = 'rgba(9, 12, 16, 1)';

export function CvdPane({ rendererRef }: CvdPaneProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
    let lastSig = '';

    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      const r = rendererRef.current;
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW === 0 || cssH === 0) return;

      const tl = r?.timeline() ?? null;
      const cap = cvdCapRef.current;
      // The newest (forming) column's CVD mutates while every view field stays
      // fixed in follow mode, so fold its value into the signature — otherwise the
      // live tip + readout freeze until the next column is born. O(1) map lookup.
      const tipCvd = tl && r ? r.cvdValueAt(tl.newestSeq) : Number.NaN;
      // Signature: repaint only when something visible changed.
      const sig = tl
        ? `${cssW}x${cssH}|${dpr}|${cap}|${tl.viewStartCol.toFixed(2)}|${tl.viewEndCol.toFixed(2)}|${tl.newestSeq}|${Number.isFinite(tipCvd) ? tipCvd : ''}`
        : `${cssW}x${cssH}|${dpr}|${cap}|empty`;
      if (sig === lastSig) return;
      lastSig = sig;

      // Resize the drawing buffer to device pixels (once per size change).
      const wantW = Math.round(cssW * dpr);
      const wantH = Math.round(cssH * dpr);
      if (canvas.width !== wantW || canvas.height !== wantH) {
        canvas.width = wantW;
        canvas.height = wantH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, cssW, cssH);

      // Top-left tag.
      ctx.font = '10px ui-monospace, monospace';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillStyle = OVERLAY.cvd.css;
      ctx.fillText('CVD', 6, 4);

      // Honesty: no usable aggressor side → don't draw a fake flat zero.
      if (cap === 'na') {
        ctx.fillStyle = AXIS;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('not measurable for this feed (no trade side)', cssW / 2, cssH / 2);
        return;
      }

      if (!tl) return;
      const lo = Math.floor(tl.viewStartCol);
      const hi = Math.ceil(tl.viewEndCol);
      const pts = r!.cvdSeries(lo, hi);
      if (pts.length === 0) return;

      const bounds = cvdBounds(pts.map((p) => p.cvd));
      const zeroY = cvdValueToY(0, bounds, cssH);

      // Zero baseline (dashed, faint).
      ctx.strokeStyle = AXIS_FAINT;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(cssW, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Build the polyline in the shared x transform.
      const xy = pts.map((p) => ({
        x: cvdColToX(p.col, tl.viewStartCol, tl.viewEndCol, cssW),
        y: cvdValueToY(p.cvd, bounds, cssH),
      }));

      // Filled area between the line and the zero baseline.
      ctx.beginPath();
      ctx.moveTo(xy[0].x, zeroY);
      for (const p of xy) ctx.lineTo(p.x, p.y);
      ctx.lineTo(xy[xy.length - 1].x, zeroY);
      ctx.closePath();
      ctx.fillStyle = 'rgba(232, 176, 74, 0.16)';
      ctx.fill();

      // The CVD line itself.
      ctx.beginPath();
      ctx.moveTo(xy[0].x, xy[0].y);
      for (let i = 1; i < xy.length; i++) ctx.lineTo(xy[i].x, xy[i].y);
      ctx.strokeStyle = OVERLAY.cvd.css;
      ctx.lineWidth = 1.6;
      ctx.stroke();

      // Latest value marker + label on the right.
      const last = pts[pts.length - 1];
      const lastXY = xy[xy.length - 1];
      ctx.fillStyle = OVERLAY.cvd.css;
      ctx.beginPath();
      ctx.arc(lastXY.x, lastXY.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(fmtCvd(last.cvd), cssW - 6, 4);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [rendererRef]);

  return (
    <section className="cvd-pane" data-testid="cvd-pane" aria-label="Cumulative volume delta">
      <canvas ref={canvasRef} className="cvd-pane__canvas" aria-hidden="true" />
    </section>
  );
}
