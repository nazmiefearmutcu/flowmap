/**
 * Streaming indicator kernel contract (campaign 3, lane CG).
 *
 * The old-branch indicator library was array-in/array-out (a full recompute per
 * render). On a live tape that is O(n) per bucket forever; these kernels are
 * the SAME math restructured as O(1)-per-push streaming state machines:
 *
 *   create(params) → { push(candle), peek(candle), reset() }
 *
 * - `push` ingests one CLOSED candle and commits it to the state machine,
 *   returning the output values aligned with {@link IndicatorKernel.outputKeys}.
 * - `peek` computes the values AS IF `candle` were pushed — for the FORMING
 *   (still-accumulating) candle — without mutating any state. The returned
 *   array is the kernel's reused scratch: read it, never retain it.
 * - All outputs are `number | null` where null = honest warm-up gap (the old
 *   library's alignment contract, kept verbatim).
 *
 * Inputs are whole candles (not bare closes) so ATR can use h/l and OBV/VWAP
 * can use volume; kernels that only need closes ignore the rest.
 */

/** One candle in kernel input space (structurally the synth's output). */
export interface CandleInput {
  o: number;
  h: number;
  l: number;
  c: number;
  /** Trade size accumulated in the bucket (0 allowed; VWAP/OBV skip-by-null). */
  v: number;
}

/** Reused output values aligned 1:1 with `outputKeys` (scratch — do not retain). */
export type KernelValues = (number | null)[];

export interface IndicatorKernel {
  /** Stable output names, in draw order (e.g. `['macd', 'signal', 'hist']`). */
  readonly outputKeys: readonly string[];
  /** Commit one closed candle; returns the freshly written scratch values. */
  push(c: CandleInput): KernelValues;
  /** Values as-if-pushed, state untouched (for the forming candle). */
  peek(c: CandleInput): KernelValues;
  /** Drop all state (session/timeframe/param change → caller re-feeds history). */
  reset(): void;
}

/** Validate an integer parameter (the old library's RangeError contract). */
export function intParam(name: string, v: number, min: number): number {
  if (!Number.isInteger(v) || v < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${v}`);
  }
  return v;
}

/** Validate a strictly positive parameter. */
export function posParam(name: string, v: number): number {
  if (!(v > 0)) {
    throw new RangeError(`${name} must be > 0, got ${v}`);
  }
  return v;
}
