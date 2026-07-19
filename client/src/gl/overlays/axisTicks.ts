/**
 * Axis tick generation (§9: price axis right, time axis bottom). Pure + testable.
 *
 * Given the VISIBLE price / time range (derived from the camera each frame), pick
 * human-friendly tick positions ("nice" 1/2/5×10ᵏ prices; human time intervals)
 * and format their labels. The renderer maps each tick back to a pixel through
 * the shared {@link GridMap}, so the axes stay pinned to the heatmap under
 * pan/zoom. Cost is O(ticks) ≈ O(1) per frame.
 */

/** Round a rough interval up to the nearest 1, 2 or 5 × 10ᵏ. */
export function niceStep(rough: number): number {
  if (!(rough > 0) || !Number.isFinite(rough)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const f = rough / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * pow;
}

/** Price ticks plus the "nice" step chosen for them (empty ticks ⇒ step 0). */
export interface PriceTickModel {
  /** The nice step actually used (grid-clamped); 0 for a degenerate range. */
  step: number;
  ticks: number[];
}

/**
 * Ascending "nice" price ticks spanning `[pLo, pHi]`, ≈`targetCount` of them, and
 * never finer than `minStep` (the grid's price increment — no sub-tick labels),
 * together with the step chosen (so labels can derive minimal decimals from the
 * TICK step, not the finer grid step).
 */
export function priceTickModel(
  pLo: number,
  pHi: number,
  targetCount: number,
  minStep: number,
): PriceTickModel {
  const lo = Math.min(pLo, pHi);
  const hi = Math.max(pLo, pHi);
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return { step: 0, ticks: [] };
  let step = niceStep((hi - lo) / Math.max(1, targetCount));
  if (minStep > 0) step = Math.max(step, minStep);
  const out: number[] = [];
  const start = Math.ceil(lo / step) * step;
  // Guard against a pathological tiny step producing a huge array.
  for (let i = 0, p = start; p <= hi + step * 1e-9 && i < 1000; i++, p = start + i * step) {
    out.push(Number(p.toFixed(10)));
  }
  return { step, ticks: out };
}

/**
 * Ascending "nice" price ticks spanning `[pLo, pHi]`, ≈`targetCount` of them, and
 * never finer than `minStep` (the grid's price increment — no sub-tick labels).
 */
export function priceTicks(
  pLo: number,
  pHi: number,
  targetCount: number,
  minStep: number,
): number[] {
  return priceTickModel(pLo, pHi, targetCount, minStep).ticks;
}

/** Decimal places implied by a price step (so labels don't show noise digits). */
export function priceDecimals(step: number): number {
  if (!(step > 0)) return 2;
  return Math.min(8, Math.max(0, Math.ceil(-Math.log10(step))));
}

/** Human time intervals (ns) the time axis snaps to, ascending. */
const TIME_STEPS_NS: number[] = [
  1e6, // 1 ms
  5e6,
  1e7, // 10 ms
  2.5e7, // 25 ms (sim fast cadence)
  5e7,
  1e8, // 100 ms
  2.5e8, // 250 ms (crypto cadence)
  5e8,
  1e9, // 1 s
  2e9,
  5e9,
  1e10, // 10 s (keyless cadence)
  1.5e10,
  3e10, // 30 s
  6e10, // 1 min
  1.2e11,
  3e11, // 5 min
  6e11, // 10 min
  1.8e12, // 30 min
  3.6e12, // 1 h
];

/** The smallest human interval whose span gives ≤`targetCount` ticks. */
export function niceTimeStepNs(spanNs: number, targetCount: number): number {
  const want = spanNs / Math.max(1, targetCount);
  for (const s of TIME_STEPS_NS) {
    if (s >= want) return s;
  }
  return TIME_STEPS_NS[TIME_STEPS_NS.length - 1];
}

/** Time ticks (ns) plus the human interval chosen for them (empty ⇒ step 0). */
export interface TimeTickModel {
  /** The human interval actually used (ns); 0 for a degenerate span. */
  step: bigint;
  ticks: bigint[];
}

/**
 * Ascending time ticks (ns) spanning `[tLo, tHi]`, ≈`targetCount` of them, snapped
 * to a human interval and aligned to multiples of that interval, together with the
 * chosen step (so the axis can pick a sub-second format when step < 1 s).
 */
export function timeTickModel(
  tLoNs: bigint,
  tHiNs: bigint,
  targetCount: number,
): TimeTickModel {
  const lo = tLoNs < tHiNs ? tLoNs : tHiNs;
  const hi = tLoNs < tHiNs ? tHiNs : tLoNs;
  const spanNs = Number(hi - lo);
  if (!(spanNs > 0)) return { step: 0n, ticks: [] };
  const step = BigInt(Math.round(niceTimeStepNs(spanNs, targetCount)));
  if (step <= 0n) return { step: 0n, ticks: [] };
  const out: bigint[] = [];
  let t = (lo / step) * step;
  if (t < lo) t += step;
  for (let i = 0; t <= hi && i < 1000; i++, t += step) out.push(t);
  return { step, ticks: out };
}

/**
 * Ascending time ticks (ns) spanning `[tLo, tHi]`, ≈`targetCount` of them, snapped
 * to a human interval and aligned to multiples of that interval.
 */
export function timeTicks(tLoNs: bigint, tHiNs: bigint, targetCount: number): bigint[] {
  return timeTickModel(tLoNs, tHiNs, targetCount).ticks;
}

/** ns → HH:MM:SS (UTC; sim columns are session-relative so this reads T+). */
export function fmtClock(ns: bigint): string {
  const totalSec = Number(ns / 1_000_000_000n);
  if (!Number.isFinite(totalSec)) return '--:--:--';
  const s = ((totalSec % 60) + 60) % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600) % 24;
  const p = (v: number): string => String(v).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}

/** ns → HH:MM:SS.mmm when sub-second ticks are in play. */
export function fmtClockMs(ns: bigint): string {
  const ms = Number((ns / 1_000_000n) % 1000n);
  return `${fmtClock(ns)}.${String(((ms % 1000) + 1000) % 1000).padStart(3, '0')}`;
}
