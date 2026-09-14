/**
 * Theme identity registry (lane CE).
 *
 * A theme is a stable string id — the contract for persistence
 * (localStorage `flowmap.theme`), the `data-theme` attribute on
 * `<html>` (which themes.css keys off), and the canvas palette bridge.
 * `midnight` is the DEFAULT and is visually identical to the unprefixed
 * shell (it re-declares the exact `ui/theme.css` values).
 *
 * CVD safety: every theme's bid/ask pair separates by LIGHTNESS as well as
 * hue (never hue alone), and `sea` additionally swaps the sell channel to
 * blue and warn to violet (deuteranopia-safe, ported from the old branch's
 * `theme/palettes.ts` `-deut` tones).
 *
 * Canvas bridge: WebGL/2D overlays must not hardcode colors — they call
 * {@link getCanvasPalette}, which reads the LIVE computed CSS variables so
 * canvas layers always match the DOM chrome. A pure resolver
 * ({@link resolveCanvasPalette}) keeps the computed→palette mapping
 * unit-testable without a real stylesheet engine.
 *
 * Chart palette (campaign 2026-09-11): {@link ThemeMeta.chart} carries the
 * chart-surface ink, chip plate and the per-theme density/synth RAMPS the GL
 * renderer uploads when the `theme` colormap is active. Since the bookmap
 * overhaul (S2-Q1) midnight's density is its OWN theme row (no longer a copy of
 * the frozen `gl/lut.ts` FLOW row); its `synth` stays a byte-copy of the frozen
 * SYNTH §7 row (no gl import — chart.test.ts pins both behaviors).
 */

export type ThemeId =
  | 'midnight'
  | 'paper'
  | 'swiss'
  | 'amber'
  | 'sea'
  | 'paper-deut'
  | 'contrast';

/** Colors canvas overlay layers need (bg/grid/text/bid/ask/accent). */
export interface CanvasPalette {
  /** Canvas void — matches `--bg`. */
  bg: string;
  /** Grid / hairline strokes — matches `--line`. */
  grid: string;
  /** Overlay label ink — matches `--text`. */
  text: string;
  /** Buy / bid channel — matches `--accent`. */
  bid: string;
  /** Sell / ask channel — matches `--sell`. */
  ask: string;
  /** Emphasis accent (crosshair, selections) — matches `--accent-bright`. */
  accent: string;
}

/** Which CSS variable each canvas palette field reads. */
export const CANVAS_VAR_FOR: Readonly<Record<keyof CanvasPalette, string>> = {
  bg: '--bg',
  grid: '--line',
  text: '--text',
  bid: '--accent',
  ask: '--sell',
  accent: '--accent-bright',
};

/** One control point of a themed chart ramp; `t` runs 0 (low) → 1 (high). */
export interface ChartStop {
  readonly t: number;
  readonly rgb: readonly [number, number, number];
}

/**
 * The chart surface a theme paints: chip ink, the GL background and the
 * density/synth ramps. Consumed by the `theme` colormap path (renderer LUT
 * store) and the F5 ink bridge; mirrored 1:1 into `--chart-*` CSS tokens
 * (registry.test.ts asserts the mirror).
 */
export interface ChartPalette {
  bg: string;
  ink: string;
  inkDim: string;
  chipBg: string;
  chipBorder: string;
  accent: string;
  gutterBg: string;
  grid: string;
  /**
   * Per-theme gridline opacity (TS-only; no CSS token). The shipped dark
   * canvas value is 0.14; light themes raise it so the composited grid clears
   * ≥1.4:1 on {@link bg} (a 0.14 hairline vanishes on paper/white). The GL/2D
   * bridge applies it to the `grid` overlay entry when provided; omitted = the
   * entry's shipped alpha (byte-identity).
   */
  gridAlpha?: number;
  axis: string;
  price: string;
  /**
   * Fired/triggered alert ink for chip plates (mirrors `--chart-sell`).
   * Consumed by CSS directly — the overlay palette has no entry for it.
   */
  sell: string;
  /** Caution ink for chip plates (mirrors `--chart-warn`), same contract. */
  warn: string;
  /** Real-depth ramp, low → high density, rooted at {@link bg}. */
  density: readonly ChartStop[];
  /** Synthetic-depth ramp (honesty §7), rooted at {@link bg}. */
  synth: readonly ChartStop[];
}

export interface ThemeMeta {
  id: ThemeId;
  /** Human name (picker rows, status text). */
  label: string;
  mode: 'dark' | 'light';
  /** Why the theme is color-vision-deficiency safe. */
  cvd: string;
  /**
   * Fallback canvas palette (mirrors the theme's `--bg/--line/--text/
   * --accent/--sell/--accent-bright` values in themes.css; asserted equal
   * by registry.test.ts). Used only when computed styles are unavailable.
   */
  canvas: CanvasPalette;
  /**
   * Chart palette + the theme's density/synth ramps (mirrors the theme's
   * `--chart-*` values; ramps are pinned by chart.test.ts).
   */
  chart: ChartPalette;
}

/** Cycling / picker order. Midnight first = default. */
export const THEME_IDS: readonly ThemeId[] = [
  'midnight',
  'paper',
  'swiss',
  'amber',
  'sea',
  'paper-deut',
  'contrast',
];

export const DEFAULT_THEME_ID: ThemeId = 'midnight';

export const THEMES: Readonly<Record<ThemeId, ThemeMeta>> = {
  midnight: {
    id: 'midnight',
    label: 'Midnight',
    mode: 'dark',
    cvd: 'teal/red bid-ask separated by lightness; the pinned renderer hues',
    canvas: {
      bg: '#050709',
      grid: '#1a2030',
      text: '#e6edf3',
      bid: '#1fb6a6',
      ask: '#d3524f',
      accent: '#33d6c4',
    },
    chart: {
      bg: '#05080e',
      ink: '#e6edf3',
      inkDim: '#93a1b4',
      chipBg: 'rgba(8, 11, 17, 0.92)',
      chipBorder: '#1a2030',
      accent: '#33d6c4',
      gutterBg: '#0e121a',
      grid: '#788496',
      gridAlpha: 0.14,
      axis: '#a3b0c2',
      price: '#f5f8fc',
      sell: '#e8635f',
      warn: '#d6a13a',
      // S2-Q1 decoupling (bookmap overhaul): midnight no longer aliases the
      // frozen FLOW row — this is its own Bookmap-class density ramp, served
      // from the THEME row (gl/lut RAMP_THEME 5). Sequence: near-black navy →
      // azure → indigo (long COOL band, b ≥ g through t ≤ 0.5), a purple/
      // magenta knee at t 0.54–0.66, then a short warm band to a cream/gold
      // core (max channel ≤ 235, never white — the price-line contract).
      // Rec.601 stop luma: 7.8 → 26.8 → 61.6 → 78.1 → 109.5 → 134.5 → 175.0 →
      // 206.5 (strictly increasing ⇒ luminance-monotone raster). The F
      // transfer curve (white point p99.7, log-compress above the knee) is
      // what the field maps through; this ramp is authored against it.
      density: [
        { t: 0.0, rgb: [5, 8, 14] },
        { t: 0.18, rgb: [11, 26, 72] },
        { t: 0.4, rgb: [24, 64, 148] },
        { t: 0.54, rgb: [64, 64, 188] },
        { t: 0.6, rgb: [168, 66, 180] },
        { t: 0.66, rgb: [222, 92, 124] },
        { t: 0.84, rgb: [246, 162, 56] },
        { t: 1.0, rgb: [235, 205, 130] },
      ],
      // Structural copy of gl/lut.ts SYNTH_STOPS (frozen §7 amber row).
      synth: [
        { t: 0.0, rgb: [6, 3, 0] },
        { t: 0.25, rgb: [80, 30, 0] },
        { t: 0.55, rgb: [180, 90, 0] },
        { t: 0.8, rgb: [240, 170, 30] },
        { t: 1.0, rgb: [255, 240, 200] },
      ],
    },
  },
  paper: {
    id: 'paper',
    label: 'Paper',
    mode: 'light',
    cvd: 'deep teal/red on light ground, ≥4.5:1 data contrast',
    canvas: {
      bg: '#f3f1ea',
      grid: '#d6d0c0',
      text: '#24272d',
      bid: '#0e7c72',
      ask: '#b3383d',
      accent: '#0a6158',
    },
    chart: {
      bg: '#f3f1ea',
      ink: '#24272d',
      inkDim: '#57606c',
      chipBg: 'rgba(255, 253, 248, 0.92)',
      chipBorder: '#d6d0c0',
      accent: '#0a6158',
      gutterBg: '#ebe8dd',
      grid: '#5a6472',
      gridAlpha: 0.35,
      axis: '#3a414d',
      price: '#0a6158',
      sell: '#99272c',
      warn: '#8a6410',
      // Ink on paper (F8 / QA4-H1): the low/mid band carries STRUCTURE —
      // cool steel (t≈0.08) → steel blue → slate/azure → indigo — instead of
      // the old near-neutral `#c8cdd2` at t=0.2 that left ~55–70% of the
      // sheet as a chroma≈1.5 gray fog plateau. Chroma rises fast while luma
      // falls; deliberately teal-free so the teal price/accent ink stays
      // ≥48 Chebyshev from every stop (chart.test.ts).
      density: [
        { t: 0.0, rgb: [243, 241, 234] },
        { t: 0.08, rgb: [206, 214, 226] },
        { t: 0.22, rgb: [168, 186, 213] },
        { t: 0.42, rgb: [112, 138, 188] },
        { t: 0.62, rgb: [66, 86, 152] },
        { t: 0.82, rgb: [36, 44, 108] },
        { t: 1.0, rgb: [22, 28, 66] },
      ],
      // Warm sepia ink family, clearly channel-separated from the cool density.
      synth: [
        { t: 0.0, rgb: [243, 241, 234] },
        { t: 0.28, rgb: [205, 150, 85] },
        { t: 0.55, rgb: [150, 95, 45] },
        { t: 0.8, rgb: [95, 60, 30] },
        { t: 1.0, rgb: [55, 32, 14] },
      ],
    },
  },
  swiss: {
    id: 'swiss',
    label: 'Swiss',
    mode: 'light',
    cvd: 'true-black ink on white; AAA-grade lightness separation',
    canvas: {
      bg: '#ffffff',
      grid: '#2b2b2b',
      text: '#000000',
      bid: '#00695f',
      ask: '#a52a1d',
      accent: '#004d45',
    },
    chart: {
      bg: '#ffffff',
      ink: '#000000',
      inkDim: '#1f1f1f',
      chipBg: 'rgba(255, 255, 255, 0.92)',
      chipBorder: '#2b2b2b',
      accent: '#004d45',
      gutterBg: '#f0f0f0',
      grid: '#808080',
      gridAlpha: 0.4,
      axis: '#333333',
      price: '#a52a1d',
      sell: '#7f1a10',
      warn: '#7a5800',
      // Monochrome ink: white → grey → near-black. The red price ink is the
      // theme's sell accent, never white.
      density: [
        { t: 0.0, rgb: [255, 255, 255] },
        { t: 0.25, rgb: [190, 190, 190] },
        { t: 0.5, rgb: [120, 120, 120] },
        { t: 0.75, rgb: [55, 55, 55] },
        { t: 1.0, rgb: [12, 12, 12] },
      ],
      // Sepia ink, channel-separated from the grey density.
      synth: [
        { t: 0.0, rgb: [255, 255, 255] },
        { t: 0.25, rgb: [215, 175, 120] },
        { t: 0.5, rgb: [165, 110, 55] },
        { t: 0.75, rgb: [110, 65, 30] },
        { t: 1.0, rgb: [62, 34, 12] },
      ],
    },
  },
  amber: {
    id: 'amber',
    label: 'Amber',
    mode: 'dark',
    cvd: 'mint bid vs coral ask differ in lightness on warm ground',
    canvas: {
      bg: '#0f0c06',
      grid: '#352b14',
      text: '#ede0bd',
      bid: '#35c99e',
      ask: '#e06a5a',
      accent: '#5fe3ba',
    },
    chart: {
      bg: '#0c090b',
      ink: '#ede0bd',
      inkDim: '#b3a67f',
      chipBg: 'rgba(16, 12, 8, 0.92)',
      chipBorder: '#352b14',
      accent: '#5fe3ba',
      gutterBg: '#1c1709',
      grid: '#8a7c60',
      gridAlpha: 0.14,
      axis: '#c9b98e',
      price: '#f5f8fc',
      sell: '#f08577',
      warn: '#e0a83e',
      // Inferno-family on the warm ground: violet/magenta head → ember → gold.
      // The ground is a cool plum-black so the head can stay (b ≥ g) — the
      // §7 cool-field contract the warm synth ramp leans on.
      density: [
        { t: 0.0, rgb: [12, 9, 11] },
        { t: 0.16, rgb: [34, 18, 58] },
        { t: 0.34, rgb: [78, 24, 110] },
        { t: 0.5, rgb: [130, 32, 120] },
        { t: 0.62, rgb: [196, 60, 70] },
        { t: 0.78, rgb: [240, 120, 30] },
        { t: 0.9, rgb: [250, 180, 45] },
        { t: 1.0, rgb: [255, 225, 95] },
      ],
      // Warm amber synth, held ≥48 Chebyshev from the density path at every stop.
      synth: [
        { t: 0.0, rgb: [12, 9, 11] },
        { t: 0.25, rgb: [86, 52, 12] },
        { t: 0.5, rgb: [170, 110, 30] },
        { t: 0.72, rgb: [200, 175, 90] },
        { t: 1.0, rgb: [255, 235, 160] },
      ],
    },
  },
  sea: {
    id: 'sea',
    label: 'Sea',
    mode: 'dark',
    cvd: 'deuteranopia-safe: sell → blue, warn → violet (off the red-green axis)',
    canvas: {
      bg: '#050709',
      grid: '#1a2030',
      text: '#e6edf3',
      bid: '#1fb6a6',
      ask: '#4f7fd6',
      accent: '#33d6c4',
    },
    chart: {
      bg: '#050709',
      ink: '#e6edf3',
      inkDim: '#93a1b4',
      chipBg: 'rgba(8, 11, 17, 0.92)',
      chipBorder: '#1a2030',
      accent: '#33d6c4',
      gutterBg: '#0e121a',
      grid: '#788496',
      gridAlpha: 0.14,
      axis: '#a3b0c2',
      price: '#f5f8fc',
      sell: '#6f9ae2',
      warn: '#b78ce0',
      // Navy → azure → ice-cyan top; cool all the way up.
      density: [
        { t: 0.0, rgb: [5, 7, 9] },
        { t: 0.14, rgb: [10, 26, 58] },
        { t: 0.32, rgb: [16, 58, 110] },
        { t: 0.5, rgb: [30, 110, 170] },
        { t: 0.68, rgb: [60, 170, 210] },
        { t: 0.85, rgb: [110, 215, 235] },
        { t: 1.0, rgb: [135, 230, 245] },
      ],
      // Amber synth against the cool field (readable honesty contrast).
      synth: [
        { t: 0.0, rgb: [5, 7, 9] },
        { t: 0.25, rgb: [74, 40, 10] },
        { t: 0.5, rgb: [150, 90, 20] },
        { t: 0.75, rgb: [225, 150, 40] },
        { t: 1.0, rgb: [255, 235, 170] },
      ],
    },
  },
  'paper-deut': {
    id: 'paper-deut',
    label: 'Paper Deut',
    mode: 'light',
    cvd: 'deuteranopia-safe light: sell → blue, warn → violet on paper (off the red-green axis)',
    canvas: {
      bg: '#f3f1ea',
      grid: '#d6d0c0',
      text: '#24272d',
      bid: '#0a655c',
      ask: '#2f5fc4',
      accent: '#075149',
    },
    chart: {
      bg: '#f3f1ea',
      ink: '#24272d',
      inkDim: '#57606c',
      chipBg: 'rgba(255, 253, 248, 0.92)',
      chipBorder: '#d6d0c0',
      accent: '#075149',
      gutterBg: '#ebe8dd',
      grid: '#5a6472',
      gridAlpha: 0.35,
      axis: '#3a414d',
      price: '#075149',
      sell: '#24499c',
      warn: '#6d3fa8',
      // Same ink-on-paper family as `paper` (F8 / QA4-H1): periwinkle-steel
      // low band → slate azure → violet-leaning indigo, slightly cooler/softer
      // stop spacing than `paper` and never the old neutral gray at low t.
      density: [
        { t: 0.0, rgb: [243, 241, 234] },
        { t: 0.1, rgb: [208, 213, 228] },
        { t: 0.26, rgb: [170, 182, 216] },
        { t: 0.46, rgb: [116, 134, 192] },
        { t: 0.64, rgb: [74, 88, 158] },
        { t: 0.82, rgb: [40, 48, 124] },
        { t: 1.0, rgb: [24, 28, 72] },
      ],
      synth: [
        { t: 0.0, rgb: [243, 241, 234] },
        { t: 0.28, rgb: [200, 148, 88] },
        { t: 0.55, rgb: [145, 92, 48] },
        { t: 0.8, rgb: [92, 58, 28] },
        { t: 1.0, rgb: [52, 30, 12] },
      ],
    },
  },
  contrast: {
    id: 'contrast',
    label: 'High Contrast',
    mode: 'dark',
    cvd: 'high-contrast dark: true-black ground, AAA ink (21:1), bright bid/ask (≥7:1)',
    canvas: {
      bg: '#000000',
      grid: '#3d3d3d',
      text: '#ffffff',
      bid: '#00e0c0',
      ask: '#ff5f5f',
      accent: '#4dffe0',
    },
    chart: {
      bg: '#000000',
      ink: '#ffffff',
      inkDim: '#d9d9d9',
      chipBg: 'rgba(0, 0, 0, 0.92)',
      chipBorder: '#3d3d3d',
      accent: '#4dffe0',
      gutterBg: '#0a0a0a',
      grid: '#6e6e6e',
      gridAlpha: 0.14,
      axis: '#c9c9c9',
      price: '#ffffff',
      sell: '#ff8a8a',
      warn: '#ffcc00',
      // Classic family on true black: deep blue → cyan → bright yellow.
      density: [
        { t: 0.0, rgb: [0, 0, 0] },
        { t: 0.14, rgb: [8, 20, 80] },
        { t: 0.36, rgb: [0, 110, 190] },
        { t: 0.55, rgb: [30, 200, 225] },
        { t: 0.78, rgb: [235, 235, 50] },
        { t: 1.0, rgb: [255, 245, 60] },
      ],
      // Warm amber synth: distinct from the blue/cyan/yellow density path.
      synth: [
        { t: 0.0, rgb: [0, 0, 0] },
        { t: 0.25, rgb: [80, 40, 0] },
        { t: 0.5, rgb: [170, 100, 20] },
        { t: 0.72, rgb: [215, 150, 30] },
        { t: 1.0, rgb: [255, 235, 150] },
      ],
    },
  },
};

/** Narrow an unknown stored value to a ThemeId. */
export function isThemeId(value: string | null | undefined): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}

/** The theme after `id` in {@link THEME_IDS} order, wrapping at the end. */
export function nextTheme(id: ThemeId): ThemeId {
  const i = THEME_IDS.indexOf(id);
  return THEME_IDS[(i + 1) % THEME_IDS.length];
}

/**
 * Pure palette resolver: map computed CSS-variable values onto the canvas
 * palette, falling back field-wise to the theme's registry literals when a
 * value is missing/blank (e.g. no stylesheet engine). `getVar` returns the
 * raw computed value for a custom-property name.
 */
export function resolveCanvasPalette(
  id: ThemeId,
  getVar: (name: string) => string,
): CanvasPalette {
  const fallback = THEMES[id].canvas;
  const out = {} as Record<keyof CanvasPalette, string>;
  for (const field of Object.keys(CANVAS_VAR_FOR) as Array<keyof CanvasPalette>) {
    const raw = getVar(CANVAS_VAR_FOR[field]).trim();
    out[field] = raw !== '' ? raw : fallback[field];
  }
  return out;
}
