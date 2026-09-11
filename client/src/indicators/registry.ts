/**
 * Indicator registry (campaign 3, lane CG) — the single source of truth the
 * IndicatorPicker renders from and the overlay canvas computes with.
 *
 * Each descriptor binds:
 *  - identity + display name (English; the UI never derives labels from ids);
 *  - a typed params schema (min/max/step/default) so the picker can render and
 *    clamp editors without knowing any indicator math;
 *  - the output series (keys + pane placement `overlay` | `sub` + a default
 *    color expressed as a CSS variable so themes own the palette);
 *  - a factory binding the params into a streaming kernel (kernels/*.ts).
 *
 * Adding an indicator = a kernels/ module + one entry here. Nothing else in the
 * lane needs to change.
 */

import { createAtr } from './kernels/atr';
import { createBollinger } from './kernels/bollinger';
import { createEma } from './kernels/ema';
import { createMacd } from './kernels/macd';
import { createObv } from './kernels/obv';
import { createRsi } from './kernels/rsi';
import { createSma } from './kernels/sma';
import { createVwap } from './kernels/vwap';
import type { IndicatorKernel } from './kernels/types';

/** Where a series draws: over the price chart, or in the sub-pane strip below it. */
export type IndicatorPane = 'overlay' | 'sub';

/** One editable numeric parameter. */
export interface ParamField {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Integers snap in the editor; floats allow decimals. */
  kind: 'int' | 'float';
}

/** One plottable output series of an indicator. */
export interface OutputSpec {
  key: string;
  label: string;
  /** Theme-owned default color, as a CSS custom property name. */
  colorVar: string;
  /** MACD-style histograms render as bars from the zero line. */
  histogram?: boolean;
}

export interface IndicatorDef {
  id: string;
  name: string;
  pane: IndicatorPane;
  params: readonly ParamField[];
  outputs: readonly OutputSpec[];
  /** Validated/clamped params (per schema) → a fresh streaming kernel. */
  create(params: Readonly<Record<string, number>>): IndicatorKernel;
}

/** Clamp + coerce one param against its schema (pickers and persisted junk). */
export function clampParam(field: ParamField, value: unknown): number {
  const v = typeof value === 'number' ? value : Number(value);
  let out = Number.isFinite(v) ? v : field.default;
  out = Math.min(field.max, Math.max(field.min, out));
  return field.kind === 'int' ? Math.round(out) : out;
}

/** Params object with every schema default applied. */
export function defaultParams(def: IndicatorDef): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of def.params) out[p.key] = p.default;
  return out;
}

/** 1-based CSS var suffix per output slot (indicators.css defines --indi-c1..6). */
function colorVar(n: number): string {
  return `--indi-c${n}`;
}

const sInt = (key: string, label: string, min: number, max: number, def: number): ParamField => ({
  key,
  label,
  min,
  max,
  step: 1,
  default: def,
  kind: 'int',
});

/** All indicators the picker can offer, in stable display order. */
export const INDICATOR_DEFS: readonly IndicatorDef[] = [
  {
    id: 'sma',
    name: 'SMA',
    pane: 'overlay',
    params: [sInt('period', 'Period', 2, 500, 20)],
    outputs: [{ key: 'sma', label: 'SMA', colorVar: colorVar(1) }],
    create: (p) => createSma(clampParam(sInt('period', 'Period', 2, 500, 20), p.period)),
  },
  {
    id: 'ema',
    name: 'EMA',
    pane: 'overlay',
    params: [sInt('period', 'Period', 2, 500, 20)],
    outputs: [{ key: 'ema', label: 'EMA', colorVar: colorVar(2) }],
    create: (p) => createEma(clampParam(sInt('period', 'Period', 2, 500, 20), p.period)),
  },
  {
    id: 'vwap',
    name: 'VWAP (session)',
    pane: 'overlay',
    params: [],
    outputs: [{ key: 'vwap', label: 'VWAP', colorVar: colorVar(3) }],
    create: () => createVwap(),
  },
  {
    id: 'bb',
    name: 'Bollinger Bands',
    pane: 'overlay',
    params: [sInt('period', 'Period', 2, 500, 20), { key: 'mult', label: 'StdDev', min: 0.5, max: 10, step: 0.5, default: 2, kind: 'float' }],
    outputs: [
      { key: 'basis', label: 'Basis', colorVar: colorVar(1) },
      { key: 'upper', label: 'Upper', colorVar: colorVar(4) },
      { key: 'lower', label: 'Lower', colorVar: colorVar(4) },
    ],
    create: (p) =>
      createBollinger(
        clampParam(sInt('period', 'Period', 2, 500, 20), p.period),
        clampParam({ key: 'mult', label: 'StdDev', min: 0.5, max: 10, step: 0.5, default: 2, kind: 'float' }, p.mult),
      ),
  },
  {
    id: 'rsi',
    name: 'RSI',
    pane: 'sub',
    params: [sInt('period', 'Period', 2, 200, 14)],
    outputs: [{ key: 'rsi', label: 'RSI', colorVar: colorVar(5) }],
    create: (p) => createRsi(clampParam(sInt('period', 'Period', 2, 200, 14), p.period)),
  },
  {
    id: 'macd',
    name: 'MACD',
    pane: 'sub',
    params: [sInt('fast', 'Fast', 2, 200, 12), sInt('slow', 'Slow', 3, 400, 26), sInt('signal', 'Signal', 1, 100, 9)],
    outputs: [
      { key: 'macd', label: 'MACD', colorVar: colorVar(1) },
      { key: 'signal', label: 'Signal', colorVar: colorVar(2) },
      { key: 'hist', label: 'Histogram', colorVar: colorVar(5), histogram: true },
    ],
    create: (p) =>
      createMacd(
        clampParam(sInt('fast', 'Fast', 2, 200, 12), p.fast),
        clampParam(sInt('slow', 'Slow', 3, 400, 26), p.slow),
        clampParam(sInt('signal', 'Signal', 1, 100, 9), p.signal),
      ),
  },
  {
    id: 'atr',
    name: 'ATR',
    pane: 'sub',
    params: [sInt('period', 'Period', 2, 200, 14)],
    outputs: [{ key: 'atr', label: 'ATR', colorVar: colorVar(6) }],
    create: (p) => createAtr(clampParam(sInt('period', 'Period', 2, 200, 14), p.period)),
  },
  {
    id: 'obv',
    name: 'OBV',
    pane: 'sub',
    params: [],
    outputs: [{ key: 'obv', label: 'OBV', colorVar: colorVar(3) }],
    create: () => createObv(),
  },
];

/** Descriptor for `id`, or null for an unknown id (callers must handle it). */
export function defById(id: string): IndicatorDef | null {
  return INDICATOR_DEFS.find((d) => d.id === id) ?? null;
}
