/**
 * Depth-stream seam detection (QA3 C-1 honesty).
 *
 * A session reattach can merge two grids into one ring: the old session's live
 * columns (250 ms cadence) followed by a reconstructed block from a DIFFERENT
 * grid (e.g. 3.75 s stretched candles) whose wall-times can even run BACKWARD
 * relative to the columns they land after. The ring addresses columns by
 * absolute `col_seq`, so the splice "succeeds" and the chart shows two windows
 * with a hard jump — and, before this module, no gap marker for the big seam
 * (the trailing one already carried a server-emitted marker).
 *
 * This is pure geometry-free arithmetic on (epoch, col_seq, t0_ns):
 *
 * - **backward**: the next column's wall-time is earlier than the previous
 *   column's by more than the tolerance. Time never legitimately runs backward
 *   on a live stream (replay SEEK is excluded by the caller), so this is always
 *   a seam.
 * - **warp**: the t0 delta between consecutive columns disagrees with
 *   `(col_seq delta) × dt` by more than the tolerance, with both columns in the
 *   same epoch (a re-anchor is announced as a new epoch; comparing across
 *   epochs would false-positive on a dt change).
 *
 * Warp is reported only for the FIRST inconsistent pair of a run
 * ({@link SeamTracker}): the reconstructed block is internally uniform, so a
 * naive rule would emit one marker per column (513 in the measured QA3 repro).
 * Backward always reports — it is the corruption signature itself.
 */

import { MsgType, type Marker } from '../proto/types';

/** Minimal shape the detector needs from a depth column. */
export interface SeamSample {
  epoch: number;
  col_seq: number;
  t0_ns: bigint;
}

export type SeamKind = 'backward' | 'warp';

export interface SeamVerdict {
  kind: SeamKind;
  /** `next.t0_ns − prev.t0_ns` (ns; negative for a backward seam). */
  deltaNs: bigint;
  /** `(next.col_seq − prev.col_seq) × dt` when dt is known, else null. */
  expectedNs: bigint | null;
}

/**
 * Absolute floor for a "real" seam. Cadence jitter and formation updates are
 * far below this; the measured reconstructed-block warp (~3.5 s) and the
 * boundary backward jumps (−9 s, −30 min) are far above it.
 */
export const SEAM_MIN_DEVIATION_NS = 1_000_000_000n; // 1 s

/** A legitimate cadence is trusted within `max(dt × 4, 1 s)`. */
export const SEAM_DT_FACTOR = 4n;

/** The deviation below which a delta is considered consistent. */
export function seamToleranceNs(dtNs: bigint | null): bigint {
  const fromDt = dtNs !== null && dtNs > 0n ? dtNs * SEAM_DT_FACTOR : 0n;
  return fromDt > SEAM_MIN_DEVIATION_NS ? fromDt : SEAM_MIN_DEVIATION_NS;
}

/**
 * Does the step from `prev` to `next` cross a seam? Returns null for a
 * consistent step, for a forming/duplicate re-send (`col_seq` not advancing),
 * and for a warp that cannot be evaluated (dt unknown or epoch change).
 */
export function detectDepthSeam(
  prev: SeamSample,
  next: SeamSample,
  dtNs: bigint | null,
): SeamVerdict | null {
  // Forming columns re-send the SAME col_seq and a reconnect snapshot may
  // re-send OLDER ones; neither moves the timeline, so neither is a seam.
  if (next.col_seq <= prev.col_seq) return null;
  const deltaNs = next.t0_ns - prev.t0_ns;
  const tol = seamToleranceNs(dtNs);
  if (deltaNs < 0n && -deltaNs > tol) {
    return { kind: 'backward', deltaNs, expectedNs: null };
  }
  if (dtNs !== null && dtNs > 0n && next.epoch === prev.epoch) {
    const expectedNs = BigInt(next.col_seq - prev.col_seq) * dtNs;
    const dev = deltaNs > expectedNs ? deltaNs - expectedNs : expectedNs - deltaNs;
    if (dev > tol) return { kind: 'warp', deltaNs, expectedNs };
  }
  return null;
}

/** A `gap` Marker placed at a seam's resumption side (`ts_ns` = next column t0). */
export function seamGapMarker(tsNs: bigint, text = 'history seam'): Marker {
  return { type: MsgType.MARKER, ts_ns: tsNs, kind: 'gap', text, price: null, size: null };
}

/**
 * Stateful stream observer: tracks the last accepted column and suppresses
 * repeated warp reports inside one inconsistent run (a reconstructed block is
 * warped on EVERY internal pair; only its head is news).
 */
export class SeamTracker {
  private last: SeamSample | null = null;
  /** Was the previous step consistent? Warp fires only on the first bad step. */
  private runConsistent = true;

  /**
   * Feed one accepted depth column (post-dedup). Returns a verdict to surface
   * when the step crossed a seam, else null.
   */
  observe(sample: SeamSample, dtNs: bigint | null): SeamVerdict | null {
    const prev = this.last;
    // Never regress the cursor: a forming column shares the seq, a snapshot
    // re-send may be older (the connection's dedup normally drops finalized
    // re-sends; forming ones pass through), and comparing against a regressed
    // cursor would fabricate seams.
    if (prev !== null && sample.col_seq <= prev.col_seq) {
      if (sample.col_seq < prev.col_seq) return null;
      this.last = sample; // same seq: adopt the latest forming sample
      return null;
    }
    this.last = sample;
    if (prev === null) return null;
    const verdict = detectDepthSeam(prev, sample, dtNs);
    if (verdict === null) {
      this.runConsistent = true;
      return null;
    }
    const fire = verdict.kind === 'backward' || this.runConsistent;
    this.runConsistent = false;
    return fire ? verdict : null;
  }

  /** Drop all state (session switch / reconnect into a new session). */
  reset(): void {
    this.last = null;
    this.runConsistent = true;
  }
}
