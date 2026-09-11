/**
 * Shared SMA-seeded EMA state machine — the streaming twin of the old branch's
 * `ema()` (indicators/ema.ts), which documents WHY the seed matters: seeding
 * with the plain SMA of the first `period` finite closes makes the series
 * reproducible from any slice containing the seed window and puts the first
 * plotted point exactly on the SMA.
 *
 * Used directly by the EMA kernel and internally by MACD (fast/slow EMAs over
 * closes, signal EMA over the MACD line). Skip-and-carry: a non-finite input
 * yields null and is NOT ingested — state carries forward untouched.
 *
 * `commit(v)` mutates; `peek(v)` runs the identical arithmetic on temps.
 */

export interface EmaCore {
  /** Commit one value; null during warm-up / for non-finite input. */
  commit(v: number): number | null;
  /** Same result without touching state. */
  peek(v: number): number | null;
  reset(): void;
}

export function createEmaCore(period: number): EmaCore {
  const k = 2 / (period + 1);
  let ingested = 0;
  let sum = 0;
  let prev = Number.NaN;

  function step(v: number, commit: boolean): number | null {
    if (!Number.isFinite(v)) return null; // skip-and-carry
    if (ingested < period) {
      const next = ingested + 1;
      const nextSum = sum + v;
      if (next === period) {
        const seed = nextSum / period;
        if (commit) {
          ingested = next;
          sum = nextSum;
          prev = seed;
        }
        return seed;
      }
      if (commit) {
        ingested = next;
        sum = nextSum;
      }
      return null;
    }
    const out = v * k + prev * (1 - k);
    if (commit) prev = out;
    return out;
  }

  return {
    commit(v) {
      return step(v, true);
    },
    peek(v) {
      return step(v, false);
    },
    reset() {
      ingested = 0;
      sum = 0;
      prev = Number.NaN;
    },
  };
}
