/**
 * Fixed-size rolling accumulator behind the SMA / Bollinger kernels — the
 * streaming twin of the old branch's rolling-window passes.
 *
 * Tracks `sum`/`sumsq` over the trailing `period` values in O(1) per step.
 * NaN policy matches the old library verbatim: NaN never touches the
 * accumulators (adding it would poison `sum − NaN` long after eviction); it is
 * counted instead, and any NaN inside the window makes the output an honest
 * null until it has fully exited.
 *
 * `add(v, commit)` returns the POST-insertion stats; with `commit=false` the
 * identical arithmetic runs on temps (the kernels' peek path) and no state
 * moves. In a full ring, `head` always addresses the oldest element — the next
 * write slot IS the eviction slot.
 */

export interface RollingStats {
  sum: number;
  sumsq: number;
  /** NaNs currently inside the window. */
  nan: number;
  /** Whether `period` values are resident. */
  full: boolean;
}

export interface RollingSum {
  add(v: number, commit: boolean): RollingStats;
  reset(): void;
}

export function createRolling(period: number): RollingSum {
  const buf = new Float64Array(period);
  let head = 0;
  let count = 0;
  let sum = 0;
  let sumsq = 0;
  let nan = 0;

  return {
    add(v, commit) {
      let s = sum;
      let q = sumsq;
      let n = nan;
      let c = count;
      if (c === period) {
        const evict = buf[head];
        if (Number.isNaN(evict)) {
          n -= 1;
        } else {
          s -= evict;
          q -= evict * evict;
        }
      } else {
        c += 1;
      }
      if (Number.isNaN(v)) {
        n += 1;
      } else {
        s += v;
        q += v * v;
      }
      if (commit) {
        buf[head] = v;
        head = (head + 1) % period;
        sum = s;
        sumsq = q;
        nan = n;
        count = c;
      }
      return { sum: s, sumsq: q, nan: n, full: c === period };
    },

    reset() {
      buf.fill(0);
      head = 0;
      count = 0;
      sum = 0;
      sumsq = 0;
      nan = 0;
    },
  };
}
