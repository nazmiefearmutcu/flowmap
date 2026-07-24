/**
 * Sparkline path math (pure, unit-tested) for the search palette's mini price
 * preview. Turns a short price series into an SVG polyline `d` string in a w×h
 * box, and reports the net direction so the caller can colour it up/down.
 */

/** SVG polyline `d` for `values` fitted into a `w`×`h` box with `pad` margin. */
export function sparkPath(values: readonly number[], w: number, h: number, pad = 1): string {
  const n = values.length;
  if (n === 0) return '';
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) return '';
  const span = max - min || 1;
  const iw = Math.max(1, w - pad * 2);
  const ih = Math.max(1, h - pad * 2);
  const step = n > 1 ? iw / (n - 1) : 0;
  let d = '';
  for (let i = 0; i < n; i++) {
    const x = pad + i * step;
    const y = pad + (1 - (values[i] - min) / span) * ih;
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

/** Net direction of a series: +1 up, -1 down, 0 flat/empty. */
export function sparkDirection(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const first = values[0];
  const last = values[values.length - 1];
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  return last > first ? 1 : last < first ? -1 : 0;
}

/** Compact signed percent, e.g. +3.21% / −0.50%. */
export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

/** Compact price, adapting decimals to magnitude. */
export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(4);
  return v.toPrecision(3);
}
