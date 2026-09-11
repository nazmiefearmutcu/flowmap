/**
 * ChartLegend (CP4, campaign 2026-09-11) — the key for the price-family lines.
 *
 * The chart's defaults paint five-plus horizontal marks (near-white last-price
 * line, its dashed level + area wash, violet VWAP, teal/red BBO pair, plus the
 * density field) and the old owner report read that as "several price lines"
 * (survey S4 D6). HeatLegend explains the density ramp; this row explains the
 * LINES, in the chart's own ink:
 *
 *   - Last price — near-white, the shipped `OVERLAY.price` literal;
 *   - VWAP       — violet `OVERLAY.vwap`;
 *   - BBO        — the teal/red pair (`OVERLAY.bid` / `OVERLAY.ask`);
 *   - Trades     — the same teal/red pair as dots (aggressive buy/sell prints).
 *
 * Colors are read from gl/overlays/palette.ts (the ONE source of truth the GL
 * and 2D layers paint from, including the theme bridge), so the legend can never
 * drift from the chart. DOM-only, non-interactive (`pointer-events:none`), and
 * pinned inside the always-dark chart island (--chart-* tokens, never theme ink
 * — the dark-island rule).
 */

import { OVERLAY } from '../gl/overlays/palette';
import { useTheme } from '../theme';
import './ChartLegend.css';

/** Swatch shape: a line (price-family), a teal/red line pair (BBO), or a dot pair (trades). */
type SwatchKind = 'line' | 'pair' | 'dots';

interface LegendItem {
  label: string;
  kind: SwatchKind;
  /** One color for `line`; two for `pair` / `dots`. */
  colors: readonly string[];
}

/**
 * Built at RENDER time (R2-M3): a theme switch rewrites the palette strings in
 * place (`applyOverlayPalette`), so a module-load snapshot could drift from the
 * chart's ink after `T`. The component subscribes via `useTheme()` so the
 * swatches always show what the renderer is currently painting.
 */
function legendItems(): LegendItem[] {
  return [
    { label: 'Last price', kind: 'line', colors: [OVERLAY.price.css] },
    { label: 'VWAP', kind: 'line', colors: [OVERLAY.vwap.css] },
    { label: 'BBO', kind: 'pair', colors: [OVERLAY.bid.css, OVERLAY.ask.css] },
    { label: 'Trades', kind: 'dots', colors: [OVERLAY.buy.css, OVERLAY.sell.css] },
  ];
}

export function ChartLegend(): JSX.Element {
  // Subscribe to theme switches: the DOM update re-reads OVERLAY (see above).
  useTheme();
  const items = legendItems();
  return (
    <div
      className="chart-legend"
      data-testid="chart-legend"
      role="img"
      aria-label="Chart legend: last price, VWAP, best bid and ask, trades"
    >
      {items.map((item) => (
        <span className="chart-legend__item" key={item.label}>
          {item.kind === 'line' && (
            <span
              className="chart-legend__line"
              data-swatch="line"
              style={{ background: item.colors[0] }}
              aria-hidden="true"
            />
          )}
          {item.kind === 'pair' && (
            <span className="chart-legend__pair" data-swatch="pair" aria-hidden="true">
              <span className="chart-legend__line" style={{ background: item.colors[0] }} />
              <span className="chart-legend__line" style={{ background: item.colors[1] }} />
            </span>
          )}
          {item.kind === 'dots' && (
            <span className="chart-legend__dots" data-swatch="dots" aria-hidden="true">
              <span className="chart-legend__dot" style={{ background: item.colors[0] }} />
              <span className="chart-legend__dot" style={{ background: item.colors[1] }} />
            </span>
          )}
          <span className="chart-legend__label">{item.label}</span>
        </span>
      ))}
    </div>
  );
}
