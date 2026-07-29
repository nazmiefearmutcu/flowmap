/**
 * Per-session admission control for depth columns (pure; the renderer owns the
 * GL side effects, this owns the decision — same split as gl/follow.ts).
 *
 * WHY. A symbol switch is asynchronous on both ends. `App.tsx` calls
 * `Renderer.resetForSession()` the instant the SUBSCRIPTION changes, which tears
 * the {@link TileRing} down to null and (via the store) clears `sessionId`,
 * `epochs` and `gridEpoch`. But the socket is still delivering the OLD session's
 * columns for as long as the round trip takes. Those columns find an empty epoch
 * table, so the row count falls back to `col.bid.length` — the PREVIOUS symbol's
 * geometry — and rebuild the ring at the wrong height. Every column of the new
 * geometry then mismatches the ring and is skipped, with nothing left in the
 * pipeline that would ever recreate it: a permanently blank heatmap. Crypto and
 * sim grids are 2048 rows, equity 4096 (and the `deep` band is 4096 too), so
 * crypto→equity was the reliably reproducible case.
 *
 * The book/tape store solves the same class of bug by clearing on `sessionId`
 * change, i.e. at the new session's Hello. This is the renderer's equivalent,
 * with one extra requirement: a gate that can latch shut is worse than the bug,
 * because a renderer that never draws has no way back. So there are TWO
 * independent guarantees here, and either one alone recovers the heatmap:
 *
 *  1. {@link sessionGateOpen} — the gate opens on the new session's Hello, AND
 *     it opens on any column whose epoch the store can size authoritatively.
 *     The second clause is the escape hatch: once geometry is a fact rather than
 *     a guess, there is nothing left to wait for.
 *  2. {@link planDepthColumn} — a row-count change REBUILDS the ring rather than
 *     skipping the column. So even if a stale column slips through and sizes the
 *     ring wrongly, the first column of the real geometry puts it right.
 */

/** What the renderer should do with one incoming depth column. */
export type DepthColumnPlan =
  | { action: 'drop'; reason: 'unattributed' | 'row-mismatch' }
  | { action: 'create'; rows: number }
  | { action: 'rebuild'; rows: number }
  | { action: 'write'; rows: number };

/**
 * Has the post-reset gate opened?
 *
 * @param gateSessionId  `sessionId` as it stood when `resetForSession()` ran
 *                       (normally already null — the store clears it on the
 *                       re-subscribe that triggered the reset).
 * @param storeSessionId `sessionId` now: non-null and different means the new
 *                       session's Hello has landed, which is the moment the
 *                       stream provably swapped.
 * @param epochRows      Rows the store's epoch table reports for THIS column's
 *                       epoch, or undefined when it has no entry. Defined means
 *                       the geometry is authoritative — accept and move on
 *                       rather than waiting for a Hello that may never come.
 */
export function sessionGateOpen(
  gateSessionId: string | null,
  storeSessionId: string | null,
  epochRows: number | undefined,
): boolean {
  if (storeSessionId !== null && storeSessionId !== gateSessionId) return true;
  return epochRows !== undefined;
}

/**
 * Decide how to admit one depth column, given the gate and the ring's geometry.
 *
 * `epochRows` (the server's own row count for the column's epoch) is preferred
 * over `colRows` (`col.bid.length`) whenever the store has it; the fallback to
 * `colRows` is only reachable with the gate open, i.e. when no session switch is
 * pending — the first-ever column and the `?perf` / `?normalize` harnesses,
 * which push columns with no store epochs at all.
 */
export function planDepthColumn(input: {
  /** True while a session reset is still waiting for the new session (gate shut). */
  awaitingSession: boolean;
  /** Rows from the store's epoch params for this column's epoch, if known. */
  epochRows: number | undefined;
  /** The column's own `bid.length`. */
  colRows: number;
  /** The current ring's row count, or null before the first column. */
  ringRows: number | null;
}): DepthColumnPlan {
  const { awaitingSession, epochRows, colRows, ringRows } = input;

  // Gate shut AND nothing authoritative to size by: this column cannot be
  // attributed to the session we are now rendering. Sizing the ring off it is
  // precisely the mistake — drop it and wait.
  if (awaitingSession) return { action: 'drop', reason: 'unattributed' };

  const rows = epochRows ?? colRows;

  // Self-inconsistent with its own epoch: uploading it would corrupt the
  // texture, and it is NOT evidence of a geometry change, so it must not
  // trigger a rebuild either.
  if (colRows !== rows) return { action: 'drop', reason: 'row-mismatch' };

  if (ringRows === null) return { action: 'create', rows };
  // A real geometry change. Rebuild — never skip: skipping leaves a ring nothing
  // will ever resize, which is a blank heatmap for the rest of the session.
  if (ringRows !== rows) return { action: 'rebuild', rows };
  return { action: 'write', rows };
}
