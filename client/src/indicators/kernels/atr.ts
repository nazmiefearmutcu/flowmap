/**
 * ATR kernel — Wilder's Average True Range over real candle ranges.
 *
 * Unlike the old branch (a close-only fallback, its feed carrying no h/l), the
 * candle stream has a real range, so this is the TEXTBOOK true range:
 *   TR = max(h − l, |h − cPrev|, |l − cPrev|)
 * seeded with the SMA of the first `period` TRs and advanced with the Wilder
 * recurrence — the identical smoothing the old ATR applied. NaN policy kept:
 * a NaN TR (non-finite h/l/c) poisons the line (nulls) until reset; ±Inf
 * propagates as Infinity. O(1) per push.
 */

import { intParam, type CandleInput, type IndicatorKernel, type KernelValues } from './types';

export function createAtr(period: number): IndicatorKernel {
  intParam('period', period, 1);
  let prevClose: number | null = null;
  let trs = 0;
  let sumTR = 0;
  let avg = 0;
  let poisoned = false;
  const out: KernelValues = [null];

  function step(c: CandleInput, commit: boolean): KernelValues {
    if (poisoned) {
      out[0] = null;
      return out;
    }
    const pc = prevClose;
    if (commit) prevClose = c.c;
    if (pc === null) {
      out[0] = null; // the first candle has no previous close → no TR
      return out;
    }
    const tr = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
    if (Number.isNaN(tr)) {
      if (commit) poisoned = true;
      out[0] = null;
      return out;
    }
    if (trs < period) {
      const n = trs + 1;
      const s = sumTR + tr;
      if (commit) {
        trs = n;
        sumTR = s;
        if (n === period) avg = s / period;
      }
      out[0] = n === period ? s / period : null;
      return out;
    }
    const a = (avg * (period - 1) + tr) / period;
    if (commit) avg = a;
    out[0] = a;
    return out;
  }

  return {
    outputKeys: ['atr'],
    push(c) {
      return step(c, true);
    },
    peek(c) {
      return step(c, false);
    },
    reset() {
      prevClose = null;
      trs = 0;
      sumTR = 0;
      avg = 0;
      poisoned = false;
    },
  };
}
