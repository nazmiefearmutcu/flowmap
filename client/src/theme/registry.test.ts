/**
 * Theme registry tests (lane CE).
 *
 * The load-bearing invariant: EVERY theme declares EVERY variable that
 * `ui/theme.css` owns, parsed programmatically from both sheets — a var
 * added to the design system without theme coverage fails here. Also:
 * `midnight` must stay byte-identical to `:root` (default = today's look),
 * and each theme's registry canvas literals must match its CSS values.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CANVAS_VAR_FOR,
  DEFAULT_THEME_ID,
  THEMES,
  THEME_IDS,
  isThemeId,
  nextTheme,
  resolveCanvasPalette,
  type CanvasPalette,
  type ChartPalette,
  type ThemeId,
} from './registry';

const here = dirname(fileURLToPath(import.meta.url));
const uiCss = readFileSync(join(here, '../ui/theme.css'), 'utf8');
const themesCss = readFileSync(join(here, 'themes.css'), 'utf8');

/** Body of a `{...}` block for the first occurrence of `selector`. */
function blockOf(css: string, selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector ${selector} exists`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  expect(open).toBeGreaterThan(idx);
  expect(close).toBeGreaterThan(open);
  return css.slice(open + 1, close);
}

/** Declared custom-property names in a css block body. */
function varNames(body: string): Set<string> {
  return new Set(
    [...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]),
  );
}

/** Declared value of one custom property in a css block body (whitespace-normalized). */
function valueOf(body: string, name: string): string {
  const m = body.match(new RegExp(`${name.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+);`));
  expect(m, `${name} declared`).toBeTruthy();
  return (m as RegExpMatchArray)[1].replace(/\s+/g, ' ').trim();
}

/** WCAG contrast ratio between two css color literals. */
function contrast(a: string, b: string): number {
  return contrastRgb(parseCss(a), b);
}

/** Parse `#rrggbb` / `rgb()` / `rgba()` into 0-255 channels + alpha. */
function parseCss(value: string): [number, number, number, number] {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      1,
    ];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (!fn) throw new Error(`test helper: unparseable css color: ${value}`);
  const parts = fn[1].split(/[\s,]+/).filter((p) => p !== '').map(Number);
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

/** WCAG relative luminance of an rgb triple. */
function relLumRgb(rgb: readonly number[]): number {
  const lin = rgb.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast between an rgb triple and a css ground literal. */
function contrastRgb(rgb: readonly number[], ground: string): number {
  const g = parseCss(ground);
  const [hi, lo] = relLumRgb(rgb) > relLumRgb(g) ? [relLumRgb(rgb), relLumRgb(g)] : [relLumRgb(g), relLumRgb(rgb)];
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite an rgba() color over an opaque ground. */
function compositeOver(fg: readonly [number, number, number, number], ground: string): [number, number, number] {
  const bg = parseCss(ground);
  return [0, 1, 2].map((i) => fg[3] * fg[i] + (1 - fg[3]) * bg[i]) as [
    number,
    number,
    number,
  ];
}

/** Chebyshev (max-channel) distance between two rgb triples. */
function chebyshev(a: readonly number[], b: readonly number[]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

type ChartColorField = Exclude<keyof ChartPalette, 'density' | 'synth' | 'gridAlpha'>;

/** Which CSS variable each chart palette color field reads. */
const CHART_VAR_FOR: Readonly<Record<ChartColorField, string>> = {
  bg: '--chart-bg',
  ink: '--chart-ink',
  inkDim: '--chart-ink-dim',
  chipBg: '--chart-chip-bg',
  chipBorder: '--chart-chip-border',
  accent: '--chart-accent',
  gutterBg: '--chart-gutter-bg',
  grid: '--chart-grid',
  axis: '--chart-axis',
  price: '--chart-price',
  sell: '--chart-sell',
  warn: '--chart-warn',
};

describe('theme registry / css coverage', () => {
  it('ships the two campaign-4 a11y themes on top of the four contract themes', () => {
    for (const id of ['midnight', 'paper', 'swiss', 'amber'] as const) {
      expect(THEME_IDS).toContain(id);
    }
    expect(THEME_IDS).toContain('paper-deut');
    expect(THEME_IDS).toContain('contrast');
    expect(THEME_IDS.length).toBe(7);
    expect(new Set(THEME_IDS).size).toBe(THEME_IDS.length);
    expect(DEFAULT_THEME_ID).toBe('midnight');
    expect(THEME_IDS[0]).toBe('midnight');
  });

  /** Chart-palette tokens (theme-owned since campaign 2026-09-11): every
   *  theme declares all twelve; the F6 legacy-ramp override re-pins midnight's
   *  set when `data-chart-ramp` selects flow/inferno/classic. */
  function isChartToken(name: string): boolean {
    return name.startsWith('--chart-');
  }

  it('every theme declares every THEME variable ui/theme.css owns — no more, no less', () => {
    const root = varNames(blockOf(uiCss, ':root'));
    expect(root.size).toBeGreaterThan(40); // sanity: the sheet really has tokens
    const themeVars = [...root];
    for (const id of THEME_IDS) {
      const block = varNames(blockOf(themesCss, `:root[data-theme='${id}']`));
      for (const name of themeVars) {
        expect(block.has(name), `${id} declares ${name}`).toBe(true);
      }
      const missing = [...themeVars].filter((n) => !block.has(n));
      const extra = [...block].filter((n) => !themeVars.includes(n));
      expect(missing, `${id} missing vars`).toEqual([]);
      expect(extra, `${id} extra vars`).toEqual([]);
    }
  });

  it('every theme declares every --chart-* token — the chart palette is theme-owned', () => {
    const root = varNames(blockOf(uiCss, ':root'));
    const chartTokens = [...root].filter(isChartToken).sort();
    expect(chartTokens, 'the chart palette token set').toEqual([
      '--chart-accent',
      '--chart-axis',
      '--chart-bg',
      '--chart-chip-bg',
      '--chart-chip-border',
      '--chart-grid',
      '--chart-gutter-bg',
      '--chart-ink',
      '--chart-ink-dim',
      '--chart-price',
      '--chart-sell',
      '--chart-warn',
    ]);
    for (const id of THEME_IDS) {
      const declared = [
        ...varNames(blockOf(themesCss, `:root[data-theme='${id}']`)),
      ]
        .filter(isChartToken)
        .sort();
      expect(declared, `${id} chart tokens`).toEqual(chartTokens);
    }
  });

  it('the legacy-ramp override pins the midnight chart palette and comes last (F6)', () => {
    const selector = ":root[data-chart-ramp='flow'],";
    const body = blockOf(themesCss, selector);
    const rootBody = blockOf(uiCss, ':root');
    for (const name of [...varNames(rootBody)].filter(isChartToken)) {
      expect(valueOf(body, name), `override ${name}`).toBe(valueOf(rootBody, name));
    }
    expect(themesCss.indexOf(selector)).toBeGreaterThan(
      themesCss.indexOf(":root[data-theme='contrast']"),
    );
  });

  it('midnight is visually identical to :root — every value matches (chart tokens included)', () => {
    const rootBody = blockOf(uiCss, ':root');
    const midnightBody = blockOf(themesCss, ":root[data-theme='midnight']");
    for (const name of varNames(rootBody)) {
      expect(valueOf(midnightBody, name), `midnight ${name}`).toBe(valueOf(rootBody, name));
    }
  });

  it('each theme sets an explicit color-scheme', () => {
    for (const id of THEME_IDS) {
      const body = blockOf(themesCss, `:root[data-theme='${id}']`);
      expect(body).toMatch(/color-scheme:\s*(dark|light);/);
    }
  });

  it('registry canvas literals mirror each theme css values', () => {
    for (const id of THEME_IDS) {
      const body = blockOf(themesCss, `:root[data-theme='${id}']`);
      const canvas = THEMES[id].canvas;
      for (const field of Object.keys(CANVAS_VAR_FOR) as Array<keyof CanvasPalette>) {
        expect(valueOf(body, CANVAS_VAR_FOR[field])).toBe(canvas[field]);
      }
    }
  });

  it('registry chart literals mirror each theme css chart values (all ten tokens)', () => {
    for (const id of THEME_IDS) {
      const body = blockOf(themesCss, `:root[data-theme='${id}']`);
      const chart = THEMES[id].chart;
      for (const field of Object.keys(CHART_VAR_FOR) as ChartColorField[]) {
        expect(valueOf(body, CHART_VAR_FOR[field]), `${id} ${field}`).toBe(chart[field]);
      }
    }
  });

  it('chart ink clears 4.5:1 on the composited chip plate in every theme', () => {
    for (const id of THEME_IDS) {
      const body = blockOf(themesCss, `:root[data-theme='${id}']`);
      const plate = compositeOver(parseCss(valueOf(body, '--chart-chip-bg')), valueOf(body, '--chart-bg'));
      expect(contrastRgb(plate, valueOf(body, '--chart-ink')), `${id} chip ink`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('chart price ink clears 3:1 on the chart ground and stays ≥48 Chebyshev from every density stop', () => {
    for (const id of THEME_IDS) {
      const body = blockOf(themesCss, `:root[data-theme='${id}']`);
      const price = parseCss(valueOf(body, '--chart-price'));
      expect(contrastRgb(price, valueOf(body, '--chart-bg')), `${id} price on bg`).toBeGreaterThanOrEqual(3);
      for (const stop of THEMES[id].chart.density) {
        expect(chebyshev(price, stop.rgb), `${id} price vs density@${stop.t}`).toBeGreaterThanOrEqual(48);
      }
    }
  });

  it('chart sell/warn state inks clear 4.5:1 on the composited chip plate in every theme (M-3)', () => {
    for (const id of THEME_IDS) {
      const body = blockOf(themesCss, `:root[data-theme='${id}']`);
      const plate = compositeOver(parseCss(valueOf(body, '--chart-chip-bg')), valueOf(body, '--chart-bg'));
      for (const name of ['--chart-sell', '--chart-warn'] as const) {
        const ink = parseCss(valueOf(body, name));
        const [hi, lo] = relLumRgb(ink) > relLumRgb(plate) ? [relLumRgb(ink), relLumRgb(plate)] : [relLumRgb(plate), relLumRgb(ink)];
        expect((hi + 0.05) / (lo + 0.05), `${id} ${name} on chip plate`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('chart ink-dim clears 4.5:1 on the composited chip plate (livectl chip labels, H-2)', () => {
    for (const id of THEME_IDS) {
      const body = blockOf(themesCss, `:root[data-theme='${id}']`);
      const plate = compositeOver(parseCss(valueOf(body, '--chart-chip-bg')), valueOf(body, '--chart-bg'));
      const ink = parseCss(valueOf(body, '--chart-ink-dim'));
      const [hi, lo] = relLumRgb(ink) > relLumRgb(plate) ? [relLumRgb(ink), relLumRgb(plate)] : [relLumRgb(plate), relLumRgb(ink)];
      expect((hi + 0.05) / (lo + 0.05), `${id} ink-dim on chip plate`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('light themes raise gridAlpha so the composited grid clears 1.4:1 on the chart ground (L-4)', () => {
    for (const id of THEME_IDS) {
      const theme = THEMES[id];
      const body = blockOf(themesCss, `:root[data-theme='${id}']`);
      const bg = valueOf(body, '--chart-bg');
      const grid = parseCss(theme.chart.grid);
      const alpha = theme.chart.gridAlpha ?? 0.14;
      if (theme.mode === 'light') {
        expect(theme.chart.gridAlpha, `${id} declares gridAlpha`).toBeTypeOf('number');
        expect(theme.chart.gridAlpha, `${id} gridAlpha raised`).toBeGreaterThanOrEqual(0.25);
        const composited = compositeOver([grid[0], grid[1], grid[2], alpha], bg);
        expect(contrastRgb(composited, bg), `${id} grid vs chart bg`).toBeGreaterThanOrEqual(1.4);
      } else {
        // Dark themes keep the shipped 0.14 hairline (byte-identity).
        expect(theme.chart.gridAlpha ?? 0.14, `${id} dark gridAlpha`).toBe(0.14);
      }
    }
  });

  it('the two campaign-4 a11y themes meet their numeric contrast claims on their ground', () => {
    // text ≥ 7:1 (AAA body text), bid/ask/warn ≥ 4.5:1 (AA data channels).
    const bars: Record<string, { text: number; data: number }> = {
      'paper-deut': { text: 7, data: 4.5 },
      contrast: { text: 7, data: 4.5 },
    };
    for (const [id, bar] of Object.entries(bars)) {
      const body = blockOf(themesCss, `:root[data-theme='${id}']`);
      const bg = valueOf(body, '--bg');
      expect(contrast(valueOf(body, '--text'), bg), `${id} text on bg`).toBeGreaterThanOrEqual(
        bar.text,
      );
      for (const channel of ['--accent', '--sell', '--warn'] as const) {
        expect(contrast(valueOf(body, channel), bg), `${id} ${channel} on bg`).toBeGreaterThanOrEqual(
          bar.data,
        );
      }
    }
  });

  it('themes have unique labels and a valid mode', () => {
    const labels = THEME_IDS.map((id) => THEMES[id].label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const id of THEME_IDS) {
      expect(['dark', 'light']).toContain(THEMES[id].mode);
      expect(THEMES[id].cvd.length).toBeGreaterThan(0);
    }
  });
});

describe('registry helpers', () => {
  it('isThemeId narrows only known ids', () => {
    expect(isThemeId('midnight')).toBe(true);
    expect(isThemeId('sea')).toBe(true);
    expect(isThemeId('paper-deut')).toBe(true);
    expect(isThemeId('contrast')).toBe(true);
    expect(isThemeId('dark')).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
  });

  it('nextTheme cycles through registry order and wraps', () => {
    expect(nextTheme('midnight')).toBe('paper');
    expect(nextTheme('amber')).toBe('sea');
    expect(nextTheme('sea')).toBe('paper-deut');
    expect(nextTheme('contrast')).toBe('midnight');
  });

  it('nextTheme walks every id exactly once before wrapping (T covers all themes)', () => {
    const walked: ThemeId[] = [];
    let id: ThemeId = DEFAULT_THEME_ID;
    for (let i = 0; i < THEME_IDS.length; i++) {
      id = nextTheme(id);
      walked.push(id);
    }
    expect(walked).toEqual([...THEME_IDS.slice(1), THEME_IDS[0]]);
  });

  it('resolveCanvasPalette maps computed vars field-by-field', () => {
    const computed = new Map([
      ['--bg', ' #101010 '],
      ['--line', '#222222'],
      ['--text', '#eeeeee'],
      ['--accent', '#00ff00'],
      ['--sell', '#ff0000'],
      // --accent-bright missing on purpose → falls back field-wise
    ]);
    const palette = resolveCanvasPalette('midnight', (name) => computed.get(name) ?? '');
    expect(palette).toEqual({
      bg: '#101010',
      grid: '#222222',
      text: '#eeeeee',
      bid: '#00ff00',
      ask: '#ff0000',
      accent: THEMES.midnight.canvas.accent,
    });
  });

  it('resolveCanvasPalette falls back entirely when nothing computes', () => {
    expect(resolveCanvasPalette('paper', () => '')).toEqual(THEMES.paper.canvas);
  });
});
