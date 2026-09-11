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
  buy: { gl: rgba(31, 182, 166, 0.95), css: css(31, 182, 166) },
  /** Aggressive sell (hits the bid). */
  sell: { gl: rgba(224, 84, 84, 0.95), css: css(224, 84, 84) },
  /** Unknown-aggressor trade (equity keyless / N/A side). Neutral grey. */
  unknown: { gl: rgba(150, 160, 176, 0.8), css: css(150, 160, 176) },
  /** Best-bid line + badge. */
  bid: { gl: rgba(31, 182, 166, 0.95), css: css(31, 182, 166) },
  /** Best-ask line + badge. */
  ask: { gl: rgba(224, 84, 84, 0.95), css: css(224, 84, 84) },
  /** Last-price line over the heatmap — bright near-white so it reads as THE
   *  price, clearly apart from the colored density, VWAP (violet) and BBO. */
  price: { gl: rgba(245, 248, 252, 0.98), css: css(245, 248, 252) },
  /** Soft glow drawn under the price line to fatten it without hard edges. */
  priceGlow: { gl: rgba(245, 248, 252, 0.22), css: css(245, 248, 252, 0.22) },
  /** Area wash under the price line (text-layer gradient, top → bottom). Kept
   *  very faint: the density field is the protagonist, the wash only seats the
   *  line visually. */
  priceFillTop: { gl: rgba(245, 248, 252, 0.07), css: css(210, 225, 245, 0.07) },
  priceFillBottom: { gl: rgba(245, 248, 252, 0.0), css: css(210, 225, 245, 0) },
  /** Dashed last-price level marker (quieter than the line itself). */
  priceLevel: { gl: rgba(245, 248, 252, 0.38), css: css(245, 248, 252, 0.38) },
  /** Price-axis pill: near-white plate, near-black text (the axis "last" tag). */
  pricePill: { gl: rgba(245, 248, 252, 0.95), css: css(245, 248, 252, 0.95) },
  pricePillText: { gl: rgba(10, 14, 20, 1), css: css(10, 14, 20) },
  /** Session VWAP polyline — distinct violet so it reads apart from buy/sell. */
  vwap: { gl: rgba(196, 142, 255, 0.95), css: css(196, 142, 255) },
  /** CVD (cumulative volume delta) line in the lower pane. Amber-gold. */
  cvd: { gl: rgba(232, 176, 74, 0.98), css: css(232, 176, 74) },
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

// --- theme bridge (campaign 3 INT; fix 2026-09-10 F1-2) ---------------------------
//
// The literal table above IS the `midnight` theme. `applyOverlayPalette` rewrites
// the runtime values of the SEMANTIC bid/ask entries so the GL + 2D overlay
// layers follow the active shell theme; `applyOverlayPalette(null)` restores the
// original literals byte-for-byte. App.tsx calls the bridge for non-default
// themes and passes null on `midnight`, so the default rendering stays
// pixel-identical (the bridge is never invoked for it).
//
// DARK-ISLAND RULE (fix 2026-09-10 F1-2): the WebGL canvas background is
// ramp-derived and ALWAYS dark (`clearColorForRamp` — lut.ts), in every theme.
// The chart is therefore a dark island inside light shells too, and its ink must
// NOT follow the theme: `text`, `grid` and the `bg`-derived pill/badge plate stay
// the midnight literals in ALL themes. Only the semantic `bid`/`ask` (and their
// buy/sell twins) follow the theme — that is what keeps e.g. `sea`'s CVD-safe
// sell→blue recolor working without ever inking the dark canvas with light-theme
// near-black text.
//
// Deliberately NOT themed (categorical accents that read on light and dark ground):
// vwap / cvd / profile / poc / liquidation / event / gap / unknown.

/** Structural shape of the theme registry's canvas palette (theme/registry.ts). */
export interface OverlayThemePalette {
  bg: string;
  grid: string;
  text: string;
  bid: string;
  ask: string;
  accent: string;
}

interface OverlayColor {
  gl: RGBA;
  css: string;
}

/** Snapshot of the shipped `midnight` values, taken before any bridge call.
 *  DEEP-copied: `setColor` below mutates the live entries in place, so a shallow
 *  snapshot would alias them and lose the originals. */
const MIDNIGHT: Record<string, OverlayColor | string> = Object.fromEntries(
  Object.entries(OVERLAY).map(([k, v]) => [
    k,
    typeof v === 'string'
      ? v
      : { ...v, gl: [...v.gl] as unknown as RGBA },
  ]),
);

/** Parse a CSS color (#rgb, #rrggbb, rgb(), rgba()) into [r, g, b, a] 0-255 / 0-1. */
export function parseCssColor(input: string): [number, number, number, number] | null {
  const s = input.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1];
    const r = parseInt(h.length === 3 ? h[0] + h[0] : h.slice(0, 2), 16);
    const g = parseInt(h.length === 3 ? h[1] + h[1] : h.slice(2, 4), 16);
    const b = parseInt(h.length === 3 ? h[2] + h[2] : h.slice(4, 6), 16);
    return [r, g, b, 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter((p) => p !== '');
    if (parts.length < 3) return null;
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    const a = parts.length > 3 ? Number(parts[3]) : 1;
    if (![r, g, b, a].every(Number.isFinite)) return null;
    return [r, g, b, a];
  }
  return null;
}

/** Write a themed color into one OVERLAY entry, preserving its original alphas. */
function setColor(rec: Record<string, OverlayColor | string>, key: string, rgb: readonly [number, number, number, number], glA: number, cssA: number): void {
  const cur = rec[key] as OverlayColor;
  const gl: RGBA = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, glA];
  cur.gl = gl;
  cur.css = rgbaStr(rgb[0], rgb[1], rgb[2], cssA);
}

function rgbaStr(r: number, g: number, b: number, a: number): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Feed a theme's SEMANTIC colors into the overlay palette, or `null` to restore
 * the shipped `midnight` literals. Idempotent; a throwing/unparseable field is
 * skipped (the previous value stays), so a bad computed style can never blank
 * the overlays.
 *
 * DARK-ISLAND RULE (fix 2026-09-10 F1-2): only `bid`/`ask` are consumed — the
 * canvas is ramp-dark in every theme, so `text`/`grid`/`bg` are deliberately
 * IGNORED and the chart's ink, grid and pill plates stay the midnight literals
 * in all themes.
 */
export function applyOverlayPalette(p: OverlayThemePalette | null): void {
  const rec = OVERLAY as unknown as Record<string, OverlayColor | string>;
  if (p === null) {
    for (const key of Object.keys(MIDNIGHT)) {
      const v = MIDNIGHT[key];
      rec[key] = typeof v === 'string' ? v : { ...v, gl: [...v.gl] as unknown as RGBA };
    }
    return;
  }
  const bid = parseCssColor(p.bid);
  const ask = parseCssColor(p.ask);
  if (bid) {
    setColor(rec, 'buy', bid, 0.95, 1);
    setColor(rec, 'bid', bid, 0.95, 1);
  }
  if (ask) {
    setColor(rec, 'sell', ask, 0.95, 1);
    setColor(rec, 'ask', ask, 0.95, 1);
  }
  // p.text / p.grid / p.bg intentionally unused: the chart is a dark island in
  // every theme (see the bridge docblock above).
}
