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
