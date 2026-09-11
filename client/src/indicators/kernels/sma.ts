/**
 * SMA kernel — streaming simple moving average over candle closes.
 * Math contract identical to the old branch's `sma()`: null until the window
 * is full; a NaN inside the window forces null (honest gap, never a shorter
 * average). O(1) per push via the rolling accumulator.
 */

import { createRolling } from './rolling';
import { intParam, type CandleInput, type IndicatorKernel, type KernelValues } from './types';

export function createSma(period: number): IndicatorKernel {
  intParam('period', period, 1);
  const roll = createRolling(period);
  const out: KernelValues = [null];

  function step(c: CandleInput, commit: boolean): KernelValues {
    const r = roll.add(c.c, commit);
    out[0] = r.full && r.nan === 0 ? r.sum / period : null;
    return out;
  }

  return {
    outputKeys: ['sma'],
    push(c) {
      return step(c, true);
    },
    peek(c) {
      return step(c, false);
    },
    reset() {
      roll.reset();
    },
  };
}
