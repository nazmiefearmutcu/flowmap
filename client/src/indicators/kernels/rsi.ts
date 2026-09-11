/**
 * RSI kernel — Wilder's Relative Strength Index over candle closes.
 * Identical math to the old branch's `rsi()`: simple-mean seed of the first
 * `period` deltas, then the Wilder recurrence `avg = (prev·(p−1)+cur)/p`;
 * degenerate averages → 50 (flat) / 100 (pure gains) / 0 (pure losses); a NaN
 * delta folds to ZERO change (gap deviation pinned by the old tests) instead
 * of poisoning the averages. O(1) per push.
 */

import { intParam, type CandleInput, type IndicatorKernel, type KernelValues } from './types';

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function createRsi(period: number): IndicatorKernel {
  intParam('period', period, 1);
  let prevClose: number | null = null;
  let deltas = 0;
  let sumG = 0;
  let sumL = 0;
  let avgG = 0;
  let avgL = 0;
  const out: KernelValues = [null];

  function step(c: CandleInput, commit: boolean): KernelValues {
    const v = c.c;
    const pc = prevClose;
    if (commit) prevClose = v;
    if (pc === null) {
      out[0] = null; // the first close has no delta
      return out;
    }
    const d0 = v - pc;
    const d = Number.isNaN(d0) ? 0 : d0; // gap deviation: NaN delta = no change
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    if (deltas < period) {
      const n = deltas + 1;
      const g = sumG + gain;
      const l = sumL + loss;
      if (commit) {
        deltas = n;
        sumG = g;
        sumL = l;
        if (n === period) {
          avgG = g / period;
          avgL = l / period;
        }
      }
      out[0] = n === period ? rsiFrom(g / period, l / period) : null;
      return out;
    }
    const g2 = (avgG * (period - 1) + gain) / period;
    const l2 = (avgL * (period - 1) + loss) / period;
    if (commit) {
      avgG = g2;
      avgL = l2;
    }
    out[0] = rsiFrom(g2, l2);
    return out;
  }

  return {
    outputKeys: ['rsi'],
    push(c) {
      return step(c, true);
    },
    peek(c) {
      return step(c, false);
    },
    reset() {
      prevClose = null;
      deltas = 0;
      sumG = 0;
      sumL = 0;
      avgG = 0;
      avgL = 0;
    },
  };
}
