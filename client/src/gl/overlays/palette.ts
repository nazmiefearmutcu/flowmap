/**
 * Overlay palette (§9 UI: trading-terminal, teal/red buy-sell accent pair).
 *
 * One source of truth for the overlay colors, in both forms the two layers need:
 * `gl` = normalized RGBA [0..1] for the GL primitives, `css` = a string for the
 * 2D text layer / axis labels. Buy = teal (the app accent), sell = red — matched
 * to the crosshair's bid/ask coloring so the whole surface reads as one system.
 */

import type { RGBA } from './primitives';

function rgba(r: number, g: number, b: number, a = 1): RGBA {
  return [r / 255, g / 255, b / 255, a] as const;
}
function css(r: number, g: number, b: number, a = 1): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export const OVERLAY = {
  /** Aggressive buy (hits the ask). App accent teal. */
  buy: { gl: rgba(31, 182, 166, 0.85), css: css(31, 182, 166) },
  /** Aggressive sell (hits the bid). */
  sell: { gl: rgba(224, 84, 84, 0.85), css: css(224, 84, 84) },
  /** Unknown-aggressor trade (equity keyless / N/A side). Neutral grey. */
  unknown: { gl: rgba(150, 160, 176, 0.7), css: css(150, 160, 176) },
  /** Best-bid line + badge. */
  bid: { gl: rgba(31, 182, 166, 0.9), css: css(31, 182, 166) },
  /** Best-ask line + badge. */
  ask: { gl: rgba(224, 84, 84, 0.9), css: css(224, 84, 84) },
  /** Session VWAP polyline — distinct violet so it reads apart from buy/sell. */
  vwap: { gl: rgba(196, 142, 255, 0.95), css: css(196, 142, 255) },
  /** Volume profile bars. */
  profile: { gl: rgba(120, 150, 200, 0.35), css: css(120, 150, 200) },
  /** Point-of-control (max) profile row. */
  poc: { gl: rgba(240, 196, 90, 0.8), css: css(240, 196, 90) },
  /** Liquidation marker glyph (a hot orange triangle). */
  liquidation: { gl: rgba(255, 138, 46, 0.95), css: css(255, 138, 46) },
  /** Gap / session-break vertical hatch. */
  gap: { gl: rgba(150, 160, 176, 0.6), css: css(150, 160, 176) },
  /** Iceberg / large-lot / halt / luld / info generic glyph. */
  event: { gl: rgba(214, 161, 58, 0.9), css: css(214, 161, 58) },
  /** Axis label + tick color. */
  axis: { gl: rgba(91, 102, 117, 1), css: css(163, 176, 194) },
  /** Faint gridline for axis ticks over the heatmap. */
  grid: { gl: rgba(120, 132, 150, 0.14), css: css(120, 132, 150, 0.14) },
  /** Text-badge background (near-black terminal chrome). */
  badgeBg: 'rgba(5, 8, 12, 0.82)',
} as const;
