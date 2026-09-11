/**
 * OBV kernel — On-Balance Volume: cumulative ±volume on up/down closes.
 * Identical rules to the old branch's `obv()`: the first close plants 0; a
 * higher close adds the candle's volume, a lower one subtracts, an equal one
 * does nothing; a non-finite close OR volume leaves the line honestly null and
 * the state untouched. Real candle volume replaces the old volume=1 proxy.
 */

import type { CandleInput, IndicatorKernel, KernelValues } from './types';

export function createObv(): IndicatorKernel {
  let cum = 0;
  let prevClose: number | null = null;
  const out: KernelValues = [null];

  function step(c: CandleInput, commit: boolean): KernelValues {
    const close = c.c;
    const pc = prevClose;
    if (commit) prevClose = close;
    if (!Number.isFinite(close) || !Number.isFinite(c.v)) {
      out[0] = null;
      return out;
    }
    if (pc === null) {
      out[0] = 0; // the first close plants the baseline (cum stays 0)
      return out;
    }
    if (!Number.isFinite(pc)) {
      out[0] = cum; // gap in the closes: carry the running total, no delta
      return out;
    }
    let next = cum;
    if (close > pc) next = cum + c.v;
    else if (close < pc) next = cum - c.v;
    if (commit) cum = next;
    out[0] = next;
    return out;
  }

  return {
    outputKeys: ['obv'],
    push(c) {
      return step(c, true);
    },
    peek(c) {
      return step(c, false);
    },
    reset() {
      cum = 0;
      prevClose = null;
    },
  };
}
