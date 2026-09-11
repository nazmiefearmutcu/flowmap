/**
 * EMA kernel — SMA-seeded exponential moving average over candle closes.
 * Identical math to the old branch's `ema()` (see emaCore.ts for the seeding
 * rationale and the skip-and-carry NaN policy). O(1) per push.
 */

import { createEmaCore } from './emaCore';
import { intParam, type CandleInput, type IndicatorKernel, type KernelValues } from './types';

export function createEma(period: number): IndicatorKernel {
  intParam('period', period, 1);
  const core = createEmaCore(period);
  const out: KernelValues = [null];

  function step(c: CandleInput, commit: boolean): KernelValues {
    out[0] = commit ? core.commit(c.c) : core.peek(c.c);
    return out;
  }

  return {
    outputKeys: ['ema'],
    push(c) {
      return step(c, true);
    },
    peek(c) {
      return step(c, false);
    },
    reset() {
      core.reset();
    },
  };
}
