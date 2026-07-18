/**
 * Replay transport helpers (§9 timeline, T12) — pure, unit-tested.
 *
 * The speed ladder the transport exposes, and the map from a seek-scrubber
 * fraction ∈ [0,1] to the absolute nanosecond timestamp sent in a `Seek{t}`
 * control message. Keeping the fraction→ns math here (rather than inline in the
 * component) lets the test lock the boundary behaviour (clamp, empty extent).
 */

/** The discrete replay speeds the transport offers (§9: 1–100×). */
export const SPEED_STEPS = [1, 2, 5, 10, 50, 100] as const;
export type ReplaySpeed = (typeof SPEED_STEPS)[number];

/** A session time extent in absolute ns (inclusive start, inclusive end). */
export interface TimeExtent {
  startNs: bigint;
  endNs: bigint;
}

/** Clamp an arbitrary number to a valid speed step (nearest ≤, floor to 1×). */
export function clampSpeed(x: number): ReplaySpeed {
  let best: ReplaySpeed = SPEED_STEPS[0];
  for (const s of SPEED_STEPS) {
    if (s <= x) best = s;
  }
  return best;
}

/**
 * Map a scrubber fraction to the seek target ns within `extent`. `fraction` is
 * clamped to [0,1]; a zero/negative-width extent seeks to its start. bigint math
 * throughout so nanosecond precision is never lost to float rounding.
 */
export function seekTargetNs(fraction: number, extent: TimeExtent): bigint {
  const f = fraction <= 0 ? 0 : fraction >= 1 ? 1 : fraction;
  const span = extent.endNs - extent.startNs;
  if (span <= 0n) return extent.startNs;
  // Scale in integer space: round(f * span) via a 1e6 fixed-point ratio.
  const num = BigInt(Math.round(f * 1_000_000));
  return extent.startNs + (span * num) / 1_000_000n;
}

/** Inverse of {@link seekTargetNs}: a ns position → its [0,1] fraction of the extent. */
export function fractionOfExtent(ns: bigint, extent: TimeExtent): number {
  const span = extent.endNs - extent.startNs;
  if (span <= 0n) return 0;
  const off = ns - extent.startNs;
  if (off <= 0n) return 0;
  if (off >= span) return 1;
  return Number(off) / Number(span);
}
