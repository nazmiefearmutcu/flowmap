/**
 * Session VWAP kernel — Σ(typical·volume)/Σ(volume) anchored at session start
 * (the first candle after the kernel was created / last reset).
 *
 * Typical price = (h+l+c)/3 — the candle stream carries a real range, unlike
 * the old close-only proxy. A candle with a non-finite typical or volume is
 * skipped (null, state untouched); Σvolume = 0 → null (the old zero-cumulant
 * rule). O(1) per push.
 */

import type { CandleInput, IndicatorKernel, KernelValues } from './types';

export function createVwap(): IndicatorKernel {
  let cumPV = 0;
  let cumV = 0;
  const out: KernelValues = [null];

  function step(c: CandleInput, commit: boolean): KernelValues {
    const typical = (c.h + c.l + c.c) / 3;
    if (Number.isFinite(typical) && Number.isFinite(c.v)) {
      const pv = cumPV + typical * c.v;
      const vol = cumV + c.v;
      if (commit) {
        cumPV = pv;
        cumV = vol;
      }
      out[0] = vol > 0 ? pv / vol : null;
    } else {
      out[0] = null;
    }
    return out;
  }

  return {
    outputKeys: ['vwap'],
    push(c) {
      return step(c, true);
    },
    peek(c) {
      return step(c, false);
    },
    reset() {
      cumPV = 0;
      cumV = 0;
    },
  };
}
