/**
 * Theme chart-ramp invariants (campaign 2026-09-11, contract F1).
 *
 * The chart's density/synth ramps become theme-owned: each theme carries its
 * own stop tables, and this spec proves programmatically that they satisfy the
 * design contract:
 *   - both ramps are rooted at the chart background; 5–8 stops, t = 0 → 1;
 *   - strictly luma-monotone in the mode direction (dark up, light down);
 *   - dark density tops are bright + saturated (never merge with the white
 *     price line); dark heads stay cool (b ≥ g) through t ≤ 0.5;
 *   - light density tops stay dark ink (luma ≤ 90);
 *   - synth stops are warm and sit ≥ 48 Chebyshev from the nearest density
 *     stop (the §7 honesty separation; the shared t = 0 background anchor is
 *     the one intended coincidence);
 *   - price ink is ≥ 48 Chebyshev from every density stop and from the bg,
 *     and clears 3:1 on light grounds;
 *   - midnight's ramps rasterize BYTE-IDENTICAL to the shipped gl/lut.ts
 *     FLOW/SYNTH rows (cross-import is test-only — production is structural).
 */
import { describe, expect, it } from 'vitest';

import { buildFlowLUT, buildSynthLUT, LUT_SIZE } from '../gl/lut';
import { THEMES, THEME_IDS, type ChartStop, type ThemeId } from './registry';

/** Rec.601 luma — the perceptual scale gl/lut.test.ts pins. */
function luma(rgb: readonly [number, number, number]): number {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

/** Parse `#rrggbb` / `rgb()` / `rgba()` into 0-255 rgb. */
function parseCss(value: string): [number, number, number] {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (!fn) throw new Error(`chart.test: unparseable css color: ${value}`);
  const parts = fn[1].split(/[\s,]+/).filter((p) => p !== '').map(Number);
  return [parts[0], parts[1], parts[2]];
}

/** WCAG relative luminance of an rgb triple. */
function relLum(rgb: readonly number[]): number {
  const lin = rgb.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio between two rgb triples. */
function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = relLum(a) > relLum(b) ? [relLum(a), relLum(b)] : [relLum(b), relLum(a)];
  return (hi + 0.05) / (lo + 0.05);
}

/** Parse `#rrggbb` / `rgb()` / `rgba()` into 0-255 rgb + alpha. */
function parseCssAlpha(value: string): [number, number, number, number] {
  const v = value.trim();
  const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (!fn) {
    const rgb = parseCss(v);
    return [rgb[0], rgb[1], rgb[2], 1];
  }
  const parts = fn[1].split(/[\s,]+/).filter((p) => p !== '').map(Number);
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

/** Composite an rgba foreground over an opaque rgb ground. */
function compositeOver(
  fg: readonly [number, number, number, number],
  ground: readonly [number, number, number],
): [number, number, number] {
  return [0, 1, 2].map((i) => fg[3] * fg[i] + (1 - fg[3]) * ground[i]) as [
    number,
    number,
    number,
  ];
}

/** Chebyshev (max-channel) distance between two rgb triples. */
function chebyshev(a: readonly number[], b: readonly number[]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** Density stop whose `t` is closest to `t`. */
function nearestByT(stops: readonly ChartStop[], t: number): readonly [number, number, number] {
  let best = stops[0];
  let bestD = Infinity;
  for (const stop of stops) {
    const d = Math.abs(stop.t - t);
    if (d < bestD) {
      bestD = d;
      best = stop;
    }
  }
  return best.rgb;
}

function rampsOf(id: ThemeId): ReadonlyArray<readonly [string, readonly ChartStop[]]> {
  return [
    ['density', THEMES[id].chart.density],
    ['synth', THEMES[id].chart.synth],
  ];
}

/** Rasterize a stop list exactly like gl/lut buildRamp (sRGB lerp + round). */
function rasterize(stops: readonly ChartStop[]): Uint8Array {
  const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
  const sample = (t: number): [number, number, number] => {
    const tc = clamp01(t);
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (tc <= first.t) return [first.rgb[0], first.rgb[1], first.rgb[2]];
    if (tc >= last.t) return [last.rgb[0], last.rgb[1], last.rgb[2]];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (tc >= a.t && tc <= b.t) {
        const f = (tc - a.t) / (b.t - a.t);
        return [
          a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f,
          a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f,
          a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f,
        ];
      }
    }
    return [last.rgb[0], last.rgb[1], last.rgb[2]];
  };
  const out = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const [r, g, b] = sample(i / (LUT_SIZE - 1));
    out[i * 4 + 0] = Math.round(r);
    out[i * 4 + 1] = Math.round(g);
    out[i * 4 + 2] = Math.round(b);
    out[i * 4 + 3] = 255;
  }
  return out;
}

function sampleLuma(lut: Uint8Array, i: number): number {
  return 0.299 * lut[i * 4] + 0.587 * lut[i * 4 + 1] + 0.114 * lut[i * 4 + 2];
}

describe('theme chart ramps (F1)', () => {
  it('ramps have 5–8 stops, ordered t=0 → t=1', () => {
    for (const id of THEME_IDS) {
      for (const [name, ramp] of rampsOf(id)) {
        expect(ramp.length, `${id}.${name} length`).toBeGreaterThanOrEqual(5);
        expect(ramp.length, `${id}.${name} length`).toBeLessThanOrEqual(8);
        expect(ramp[0].t, `${id}.${name} start`).toBe(0);
        expect(ramp[ramp.length - 1].t, `${id}.${name} end`).toBe(1);
        for (let i = 1; i < ramp.length; i++) {
          expect(ramp[i].t, `${id}.${name} t order @${i}`).toBeGreaterThan(ramp[i - 1].t);
        }
      }
    }
  });

  it('both ramps are rooted at the chart background (the shared anchor)', () => {
    for (const id of THEME_IDS) {
      const { bg, density, synth } = THEMES[id].chart;
      expect(density[0].rgb, `${id} density anchor`).toEqual(parseCss(bg));
      if (id === 'midnight') {
        // midnight.synth is the frozen shipped SYNTH_STOPS row (byte-identity
        // pinned below); its warm near-black start is intentionally not the bg.
        continue;
      }
      expect(synth[0].rgb, `${id} synth anchor`).toEqual(parseCss(bg));
    }
  });

  it('both ramps are strictly luma-monotone in the mode direction', () => {
    for (const id of THEME_IDS) {
      const theme = THEMES[id];
      for (const [name, ramp] of rampsOf(id)) {
        for (let i = 1; i < ramp.length; i++) {
          const prev = luma(ramp[i - 1].rgb);
          const cur = luma(ramp[i].rgb);
          if (theme.mode === 'dark') {
            expect(cur, `${id}.${name} luma @${ramp[i].t}`).toBeGreaterThan(prev);
          } else {
            expect(cur, `${id}.${name} luma @${ramp[i].t}`).toBeLessThan(prev);
          }
        }
      }
    }
  });

  it('dark density tops are bright and saturated — they never merge with the white price line', () => {
    for (const id of THEME_IDS) {
      if (THEMES[id].mode !== 'dark') continue;
      const density = THEMES[id].chart.density;
      const top = density[density.length - 1].rgb;
      expect(luma(top), `${id} top luma`).toBeGreaterThanOrEqual(190);
      expect(Math.min(...top), `${id} top saturation`).toBeLessThanOrEqual(140);
    }
  });

  it('dark density heads stay cool (b ≥ g) through t ≤ 0.5', () => {
    for (const id of THEME_IDS) {
      if (THEMES[id].mode !== 'dark') continue;
      for (const stop of THEMES[id].chart.density) {
        if (stop.t <= 0.5) {
          expect(stop.rgb[2], `${id} head@${stop.t} cool`).toBeGreaterThanOrEqual(stop.rgb[1]);
        }
      }
    }
  });

  it('light density tops are dark ink (luma ≤ 90)', () => {
    for (const id of THEME_IDS) {
      if (THEMES[id].mode !== 'light') continue;
      const density = THEMES[id].chart.density;
      const top = density[density.length - 1].rgb;
      expect(luma(top), `${id} top luma`).toBeLessThanOrEqual(90);
    }
  });

  it('density rasters never reverse sample-to-sample (≤1 luma rounding wobble)', () => {
    for (const id of THEME_IDS) {
      const lut = rasterize(THEMES[id].chart.density);
      for (let i = 0; i < LUT_SIZE - 1; i++) {
        const a = sampleLuma(lut, i);
        const b = sampleLuma(lut, i + 1);
        if (THEMES[id].mode === 'dark') {
          expect(b, `${id} raster @${i}`).toBeGreaterThanOrEqual(a - 1);
        } else {
          expect(b, `${id} raster @${i}`).toBeLessThanOrEqual(a + 1);
        }
      }
    }
  });

  it('synth ramps are warm (r ≥ b) beyond the shared background anchor', () => {
    for (const id of THEME_IDS) {
      const synth = THEMES[id].chart.synth;
      for (let i = 1; i < synth.length; i++) {
        expect(synth[i].rgb[0], `${id} synth warm @${synth[i].t}`).toBeGreaterThanOrEqual(
          synth[i].rgb[2],
        );
      }
    }
  });

  it('every themed synth stop sits ≥48 Chebyshev from the nearest density stop', () => {
    for (const id of THEME_IDS) {
      if (id === 'midnight') continue; // frozen legacy pair — §7 proof is hue-based (e2e)
      const { density, synth } = THEMES[id].chart;
      for (let i = 1; i < synth.length; i++) {
        const stop = synth[i];
        const d = chebyshev(stop.rgb, nearestByT(density, stop.t));
        expect(d, `${id} synth@${stop.t} separation`).toBeGreaterThanOrEqual(48);
      }
    }
  });

  it('price ink is ≥48 Chebyshev from every density stop and from the chart bg', () => {
    for (const id of THEME_IDS) {
      const { bg, price, density } = THEMES[id].chart;
      const priceRgb = parseCss(price);
      expect(chebyshev(priceRgb, parseCss(bg)), `${id} price vs bg`).toBeGreaterThanOrEqual(48);
      for (const stop of density) {
        expect(
          chebyshev(priceRgb, stop.rgb),
          `${id} price vs density@${stop.t}`,
        ).toBeGreaterThanOrEqual(48);
      }
    }
  });

  it('light theme price ink clears 3:1 WCAG and is a saturated accent, never white', () => {
    for (const id of THEME_IDS) {
      if (THEMES[id].mode !== 'light') continue;
      const { bg, price } = THEMES[id].chart;
      const priceRgb = parseCss(price);
      expect(contrast(priceRgb, parseCss(bg)), `${id} price contrast`).toBeGreaterThanOrEqual(3);
      expect(
        Math.max(...priceRgb) - Math.min(...priceRgb),
        `${id} price is saturated`,
      ).toBeGreaterThanOrEqual(40);
    }
  });

  it('every theme declares gridAlpha; light themes raise it so the composited grid clears 1.4:1 (L-4)', () => {
    for (const id of THEME_IDS) {
      const { mode, chart } = THEMES[id];
      expect(chart.gridAlpha, `${id} gridAlpha declared`).toBeTypeOf('number');
      if (mode === 'dark') {
        expect(chart.gridAlpha, `${id} dark gridAlpha = shipped 0.14`).toBe(0.14);
        continue;
      }
      expect(chart.gridAlpha, `${id} light gridAlpha floor`).toBeGreaterThanOrEqual(0.25);
      expect(chart.gridAlpha, `${id} light gridAlpha cap`).toBeLessThanOrEqual(0.6);
      const bg = parseCss(chart.bg);
      const grid = parseCss(chart.grid);
      const composited = compositeOver([grid[0], grid[1], grid[2], chart.gridAlpha as number], bg);
      expect(contrast(composited, bg), `${id} grid vs bg`).toBeGreaterThanOrEqual(1.4);
    }
  });

  it('chart sell/warn state inks clear 4.5:1 on the composited chip plate (M-3)', () => {
    for (const id of THEME_IDS) {
      const { chipBg, bg, sell, warn } = THEMES[id].chart;
      const plate = compositeOver(parseCssAlpha(chipBg), parseCss(bg));
      for (const [name, ink] of [['sell', sell], ['warn', warn]] as const) {
        expect(parseCss(ink), `${id} ${name} parses`).toHaveLength(3);
        expect(contrast(parseCss(ink), plate), `${id} ${name} on chip plate`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('midnight ramps rasterize byte-identical to the shipped FLOW / SYNTH LUTs', () => {
    expect(rasterize(THEMES.midnight.chart.density)).toEqual(buildFlowLUT());
    expect(rasterize(THEMES.midnight.chart.synth)).toEqual(buildSynthLUT());
  });
});
