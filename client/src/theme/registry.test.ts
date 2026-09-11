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

/** WCAG relative luminance for a `#rrggbb` literal. */
function relLum(hex: string): number {
  const c = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const lin = [r, g, b].map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio between two `#rrggbb` literals. */
function contrast(a: string, b: string): number {
  const [hi, lo] = relLum(a) > relLum(b) ? [relLum(a), relLum(b)] : [relLum(b), relLum(a)];
  return (hi + 0.05) / (lo + 0.05);
}

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

  /** Chart-island tokens (fix 2026-09-10 F1-3): fixed dark values for chips
   *  rendered inside the always-dark GL chart. Deliberately NOT theme-owned —
   *  see the dedicated test below. */
  function isChartToken(name: string): boolean {
    return name.startsWith('--chart-');
  }

  it('every theme declares every THEME variable ui/theme.css owns — no more, no less', () => {
    const root = varNames(blockOf(uiCss, ':root'));
    expect(root.size).toBeGreaterThan(40); // sanity: the sheet really has tokens
    const themeVars = [...root].filter((n) => !isChartToken(n));
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

  it('NO theme block redefines a --chart-* token (the chart is a dark island in every theme)', () => {
    const root = varNames(blockOf(uiCss, ':root'));
    const chartTokens = [...root].filter(isChartToken);
    expect(chartTokens, 'the chart-island tokens exist on :root').toEqual([
      '--chart-ink',
      '--chart-ink-dim',
      '--chart-chip-bg',
      '--chart-chip-border',
      '--chart-accent',
      '--chart-gutter-bg',
    ]);
    for (const id of THEME_IDS) {
      const body = blockOf(themesCss, `:root[data-theme='${id}']`);
      const redefined = [...varNames(body)].filter(isChartToken);
      expect(redefined, `${id} must not redefine chart-island tokens`).toEqual([]);
    }
  });

  it('midnight is visually identical to :root — every theme-owned value matches', () => {
    const rootBody = blockOf(uiCss, ':root');
    const midnightBody = blockOf(themesCss, ":root[data-theme='midnight']");
    for (const name of varNames(rootBody)) {
      if (isChartToken(name)) continue; // fixed dark-island values, not theme-owned
      expect(valueOf(midnightBody, name)).toBe(valueOf(rootBody, name));
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
