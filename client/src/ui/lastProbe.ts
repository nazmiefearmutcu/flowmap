/**
 * The last crosshair probe, shared between components (campaign 3, lane CD).
 *
 * Crosshair.tsx records every pointer probe here (it already computes the
 * readout); PriceAlerts reads it when `A` is pressed so the new alert lands at
 * exactly the price the user is pointing at. Plain module scope, no React
 * state, never on the render path — writers are pointer-rAF throttled already.
 */

export interface ProbeSpot {
  /** Price under the cursor, null when off-grid / no data. */
  price: number | null;
  /** Decimals to print `price` with. */
  priceDecimals: number;
  /** Cursor position, canvas CSS px. */
  x: number;
  y: number;
  /** Probe time, ms epoch (staleness checks). */
  at: number;
}

let last: ProbeSpot | null = null;

/** Record a probe (called by Crosshair). */
export function recordProbeSpot(s: ProbeSpot): void {
  last = s;
}

/** The most recent probe, or null before the first pointer-move. */
export function lastProbeSpot(maxAgeMs = 10 * 60_000): ProbeSpot | null {
  if (last === null) return null;
  if (Date.now() - last.at > maxAgeMs) return null; // stale — the cursor moved on long ago
  return last;
}

/** Test seam. */
export function resetProbeSpotForTest(): void {
  last = null;
}
