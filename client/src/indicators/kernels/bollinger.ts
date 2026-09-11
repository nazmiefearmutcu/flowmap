/**
 * Bollinger Bands kernel — SMA basis ± mult·σ over the trailing window.
 * Ported math contract from the old branch's `bollinger()`:
 *  - σ is the POPULATION standard deviation (ddof=0) — the market-standard
 *    default, pinned there by a naive-reference test;
 *  - bands are null EXACTLY where the basis is null (unfilled or NaN-poisoned
 *    window) — never a silently narrower band;
 *  - catastrophic-cancellation guard: |sumsq − n·mean²| < 1e-12·max(1, sumsq)
 *    clamps σ to exactly 0 so a flat window yields bands == basis bit-for-bit.
 */

import { createRolling } from './rolling';
import { intParam, posParam, type CandleInput, type IndicatorKernel, type KernelValues } from './types';

/** Relative cancellation-guard floor (old branch SIGMA_EPS_REL). */
const SIGMA_EPS_REL = 1e-12;

export function createBollinger(period: number, mult: number): IndicatorKernel {
  intParam('period', period, 1);
  posParam('mult', mult);
  const roll = createRolling(period);
  const out: KernelValues = [null, null, null];

  function step(c: CandleInput, commit: boolean): KernelValues {
    const r = roll.add(c.c, commit);
    if (!r.full || r.nan !== 0) {
      out[0] = null;
      out[1] = null;
      out[2] = null;
      return out;
    }
    const mean = r.sum / period;
    const dev = r.sumsq - period * mean * mean;
    const sigma =
      Math.abs(dev) < SIGMA_EPS_REL * Math.max(1, r.sumsq)
        ? 0
        : Math.sqrt(Math.max(0, dev) / period);
    out[0] = mean;
    out[1] = mean + mult * sigma;
    out[2] = mean - mult * sigma;
    return out;
  }

  return {
    outputKeys: ['basis', 'upper', 'lower'],
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
