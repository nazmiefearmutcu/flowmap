import { describe, expect, it } from 'vitest';

import { clampParam, defaultParams, defById, INDICATOR_DEFS } from './registry';
import { createMacd } from './kernels/macd';
import { createSma } from './kernels/sma';
import type { CandleInput } from './kernels/types';

const closes = (n: number, base = 100): CandleInput[] =>
  Array.from({ length: n }, (_, i) => {
    const c = base + Math.sin(i / 2) * 2;
    return { o: c, h: c + 1, l: c - 1, c, v: 1 + (i % 3) };
  });

describe('indicator registry', () => {
  it('exposes the eight required indicators with correct panes', () => {
    expect(INDICATOR_DEFS.map((d) => d.id)).toEqual([
      'sma',
      'ema',
      'vwap',
      'bb',
      'rsi',
      'macd',
      'atr',
      'obv',
    ]);
    const panes = Object.fromEntries(INDICATOR_DEFS.map((d) => [d.id, d.pane]));
    expect(panes).toEqual({
      sma: 'overlay',
      ema: 'overlay',
      vwap: 'overlay',
      bb: 'overlay',
      rsi: 'sub',
      macd: 'sub',
      atr: 'sub',
      obv: 'sub',
    });
  });

  it('every output key matches its kernel outputKeys, in order', () => {
    for (const def of INDICATOR_DEFS) {
      const kernel = def.create(defaultParams(def));
      expect(def.outputs.map((o) => o.key)).toEqual([...kernel.outputKeys]);
      kernel.reset();
    }
  });

  it('every param field is inside [min,max] at its default and clamps junk', () => {
    for (const def of INDICATOR_DEFS) {
      for (const f of def.params) {
        expect(f.default).toBeGreaterThanOrEqual(f.min);
        expect(f.default).toBeLessThanOrEqual(f.max);
        expect(clampParam(f, Number.NaN)).toBe(f.kind === 'int' ? Math.round(f.default) : f.default);
        expect(clampParam(f, f.min - 1000)).toBe(f.min);
        expect(clampParam(f, f.max + 1000)).toBe(f.max);
      }
    }
  });

  it('defaults create kernels that stream a full run without throwing', () => {
    const data = closes(120);
    for (const def of INDICATOR_DEFS) {
      const kernel = def.create(defaultParams(def));
      expect(() => {
        for (const c of data) kernel.push(c);
      }).not.toThrow();
      for (const v of kernel.peek(data[data.length - 1])) expect(v === null || Number.isFinite(v)).toBe(true);
    }
  });

  it('defaults carry sane classic values (SMA/BB/RSI/MACD per spec)', () => {
    expect(defaultParams(defById('sma')!)).toEqual({ period: 20 });
    expect(defaultParams(defById('bb')!)).toEqual({ period: 20, mult: 2 });
    expect(defaultParams(defById('rsi')!)).toEqual({ period: 14 });
    expect(defaultParams(defById('macd')!)).toEqual({ fast: 12, slow: 26, signal: 9 });
    expect(defaultParams(defById('atr')!)).toEqual({ period: 14 });
    expect(defaultParams(defById('vwap')!)).toEqual({});
  });

  it('create() clamps out-of-range params instead of producing broken kernels', () => {
    // period 0 clamps to the schema min (2) — a valid kernel, not a throw.
    const k = defById('sma')!.create({ period: 0 });
    expect(k.outputKeys).toEqual(['sma']);
    // MACD fast>=slow is unclappable (independent fields) → the kernel throws.
    expect(() => createMacd(26, 12, 9)).toThrow(RangeError);
    // …and the registry never constructs that state from DEFAULTS.
    expect(() => defById('macd')!.create(defaultParams(defById('macd')!))).not.toThrow();
  });

  it('defById returns null for unknown ids; colors are CSS var names', () => {
    expect(defById('nope')).toBeNull();
    for (const def of INDICATOR_DEFS) {
      for (const out of def.outputs) {
        expect(out.colorVar).toMatch(/^--indi-c[1-6]$/);
      }
    }
  });

  it('the factories bind the same math as the direct kernel constructors', () => {
    const data = closes(60, 50);
    const viaRegistry = defById('sma')!.create({ period: 5 });
    const direct = createSma(5);
    expect(data.map((c) => viaRegistry.push(c)[0])).toEqual(data.map((c) => direct.push(c)[0]));
  });
});
