/**
 * MACD kernel — fast EMA − slow EMA, signal EMA over the MACD line, histogram.
 * Composes three SMA-seeded EMA cores (emaCore.ts), so the math and the
 * warm-up alignment are exactly the old branch's `macd()`: the MACD line opens
 * after `slow − 1` closes, the signal after the first `signalPeriod` non-null
 * MACD values (the same compacted-tail policy, naturally expressed by feeding
 * the signal core only defined MACD values).
 */

import { createEmaCore } from './emaCore';
import { intParam, type CandleInput, type IndicatorKernel, type KernelValues } from './types';

export function createMacd(fast: number, slow: number, signalPeriod: number): IndicatorKernel {
  intParam('fast', fast, 1);
  intParam('slow', slow, 1);
  intParam('signalPeriod', signalPeriod, 1);
  if (fast >= slow) {
    throw new RangeError(`fast must be < slow, got ${fast} >= ${slow}`);
  }
  const fastE = createEmaCore(fast);
  const slowE = createEmaCore(slow);
  const sigE = createEmaCore(signalPeriod);
  const out: KernelValues = [null, null, null];

  function step(c: CandleInput, commit: boolean): KernelValues {
    const f = commit ? fastE.commit(c.c) : fastE.peek(c.c);
    const s = commit ? slowE.commit(c.c) : slowE.peek(c.c);
    const m = f !== null && s !== null ? f - s : null;
    const sig = m === null ? null : commit ? sigE.commit(m) : sigE.peek(m);
    out[0] = m;
    out[1] = sig;
    out[2] = m !== null && sig !== null ? m - sig : null;
    return out;
  }

  return {
    outputKeys: ['macd', 'signal', 'hist'],
    push(c) {
      return step(c, true);
    },
    peek(c) {
      return step(c, false);
    },
    reset() {
      fastE.reset();
      slowE.reset();
      sigE.reset();
    },
  };
}
