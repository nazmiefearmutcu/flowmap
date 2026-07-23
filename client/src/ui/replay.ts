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

/**
 * Format a ns duration as `HH:MM:SS.mmm` for the transport readout. All bigint
 * math so long sessions never lose precision; negatives clamp to zero.
 */
export function formatDurationNs(ns: bigint): string {
  const n = ns < 0n ? 0n : ns;
  const totalMs = n / 1_000_000n;
  const ms = totalMs % 1000n;
  const totalSec = totalMs / 1000n;
  const sec = totalSec % 60n;
  const totalMin = totalSec / 60n;
  const min = totalMin % 60n;
  const hrs = totalMin / 60n;
  const p2 = (x: bigint): string => x.toString().padStart(2, '0');
  const p3 = (x: bigint): string => x.toString().padStart(3, '0');
  return `${p2(hrs)}:${p2(min)}:${p2(sec)}.${p3(ms)}`;
}

/**
 * Next speed on the ladder, wrapping. `dir` = +1 steps up, -1 steps down. Built
 * on {@link clampSpeed} so an off-ladder store value (or a stale persisted one)
 * is snapped onto the ladder before stepping, rather than jumping to 1×.
 *
 * This is what lets ONE cycling button expose the whole 1–100× range: the six
 * discrete steps stay the domain, only the presentation collapses.
 */
export function nextSpeed(current: number, dir: 1 | -1 = 1): ReplaySpeed {
  const snapped = clampSpeed(current);
  const i = SPEED_STEPS.indexOf(snapped);
  const n = SPEED_STEPS.length;
  return SPEED_STEPS[(i + dir + n) % n];
}

/** What the transport is doing right now — the one thing its pill must say. */
export type TransportPhase = 'live-following' | 'live-detached' | 'replay-playing' | 'replay-paused';

/**
 * Classify the transport state. `following` is the CAMERA's time-follow flag,
 * not the connection: in live mode the pill reports whether the chart is pinned
 * to now or scrolled back, which is the only thing the user can act on there.
 */
export function transportPhase(
  isReplay: boolean,
  paused: boolean,
  following: boolean,
): TransportPhase {
  if (isReplay) return paused ? 'replay-paused' : 'replay-playing';
  return following ? 'live-following' : 'live-detached';
}

/**
 * Pill text for a phase. Deliberately about the CAMERA, never "LIVE"/"OFFLINE":
 * the TopBar's connection chip already owns feed health, and a second widget
 * saying LIVE in a different sense would make the word meaningless.
 */
export function phaseLabel(phase: TransportPhase, speed: number): string {
  switch (phase) {
    case 'live-following':
      return 'FOLLOWING';
    case 'live-detached':
      return 'SCROLLED BACK';
    case 'replay-playing':
      return `REPLAY ${speed}× PLAYING`;
    case 'replay-paused':
      return `REPLAY ${speed}× PAUSED`;
  }
}

/** How far behind the live edge the view sits, in ns, from a column count. */
export function behindNs(behindCols: number, dtNs: number): bigint {
  if (!(behindCols > 0) || !(dtNs > 0)) return 0n;
  return BigInt(Math.round(behindCols * dtNs));
}

/**
 * `HH:MM:SS` — no milliseconds. {@link formatDurationNs} always appends `.mmm`,
 * which churns every frame and is unreadable on a glanceable "how far back am I"
 * badge; this is the coarse variant for that badge.
 */
export function formatDurationCoarseNs(ns: bigint): string {
  const n = ns < 0n ? 0n : ns;
  const totalSec = n / 1_000_000_000n;
  const sec = totalSec % 60n;
  const totalMin = totalSec / 60n;
  const min = totalMin % 60n;
  const hrs = totalMin / 60n;
  const p2 = (x: bigint): string => x.toString().padStart(2, '0');
  return `${p2(hrs)}:${p2(min)}:${p2(sec)}`;
}
