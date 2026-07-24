/**
 * Pure math for the CVD lower pane (unit-tested, no DOM — the replay.ts pattern).
 *
 * The pane draws the cumulative-volume-delta series in its own strip below the
 * heatmap. Horizontally it must map a column to the SAME x the heatmap/price-line
 * use, so dragging the chart drags CVD in lock-step; vertically it has its own
 * signed value axis (CVD is not a price). These helpers own both mappings so the
 * component stays a thin draw loop.
 */

export interface CvdBounds {
  min: number;
  max: number;
}

/**
 * Value bounds over the visible CVD points, ALWAYS spanning 0 (the baseline a
 * signed cumulative reads against), with a fallback range so a flat/empty series
 * is still drawable. A little headroom is added so the extreme point isn't glued
 * to the pane edge.
 */
export function cvdBounds(values: readonly number[]): CvdBounds {
  let min = 0;
  let max = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === 0 && max === 0) return { min: -1, max: 1 };
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

/**
 * Canvas y (top-down px) for a CVD value inside a strip of `height` px, leaving
 * `pad` px of margin top and bottom. Higher value → higher on screen (smaller y).
 */
export function cvdValueToY(v: number, b: CvdBounds, height: number, pad = 4): number {
  const span = b.max - b.min || 1;
  const t = (v - b.min) / span; // 0 at min, 1 at max
  const usable = Math.max(1, height - pad * 2);
  return pad + (1 - t) * usable;
}

/**
 * Canvas x (px) for a column, matching the heatmap/price-line transform exactly:
 * the column CENTER (`col + 0.5`) mapped through the view's [startCol, endCol)
 * window. `startCol`/`endCol` come straight from `renderer.timeline()`.
 */
export function cvdColToX(col: number, startCol: number, endCol: number, width: number): number {
  const span = endCol - startCol || 1;
  return ((col + 0.5 - startCol) / span) * width;
}

/** Compact signed label for a CVD magnitude (e.g. +1.2M, −45k, 0). */
export function fmtCvd(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const sign = v > 0 ? '+' : '−';
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}k`;
  if (a >= 1) return `${sign}${a.toFixed(0)}`;
  return `${sign}${a.toFixed(2)}`;
}
