/**
 * Auto-follow policy — the pure math behind per-axis follow (§8.3, camera.ts).
 *
 * `camera.ts` owns the transform; this module owns the DECISIONS that drive it:
 * which axes a drag releases, where "the price" currently is, whether it has
 * drifted far enough to be worth recentring, and how fast the view eases there.
 * All of it is pure and DOM-free (the `input/keys.ts` precedent), so the policy
 * is unit-testable without a GL context or a live feed — see follow.test.ts.
 *
 * The two rules worth stating up front, because both encode a bug that a naive
 * implementation ships:
 *
 *  - **Drag kill uses PEAK displacement from the pointerdown origin, not a
 *    signed running sum.** A drag 100 px right then 96 px back nets to +4 px;
 *    with a signed sum it would keep time-follow armed and the view would snap
 *    to the live edge the instant the user released — after they had very
 *    obviously taken manual control. Peak |displacement| per axis cannot be
 *    gamed that way, and a flat per-axis threshold (rather than an axis-
 *    dominance ratio) means a deliberately horizontal drag provably keeps price
 *    tracking while a 3 px twitch releases nothing.
 *
 *  - **Recentring targets the FULL tracked row, not the deadband edge.** Easing
 *    only to the edge re-triggers on the very next column (price keeps drifting)
 *    and produces a continuous crawl; targeting the centre buys
 *    `PRICE_DEADBAND_FRACTION/2` of the span as hysteresis before the next
 *    recentre can fire.
 */

import type { HeatmapView } from './heatmap';
import { KILL_BOTH, KILL_NONE, KILL_PRICE, KILL_TIME, type FollowKill } from './camera';

/**
 * Fraction of the viewport height treated as "price is still comfortably on
 * screen". 0.6 = the middle 60%; once the tracked row leaves it, the view
 * recentres. Below ~0.4 the view chases every tick; above ~0.8 price reaches the
 * edge of the screen before anything happens.
 */
export const PRICE_DEADBAND_FRACTION = 0.6;

/**
 * Exponential time constant (ms) for the recentre glide. ~90 ms reads as a
 * deliberate camera move rather than a teleport, and settles inside 3 frames at
 * 60 fps. Same family as the normalizer's EMA glide (gl/normalize.ts), which
 * exists for exactly this "don't snap the display on a regime change" reason.
 */
export const PRICE_GLIDE_TAU_MS = 90;

/** Settle threshold (rows): closer than this to the target and the glide stops. */
export const PRICE_SNAP_ROWS = 0.25;

/**
 * Peak drag displacement (CSS px) on one axis before that axis's follow is
 * released. Pointermove deltas are 1–3 px, so anything smaller releases follow
 * on hand tremor; anything much larger makes a deliberate small nudge feel inert.
 */
export const PAN_KILL_MIN_PX = 6;

/**
 * Which follows a positional drag releases, from the PEAK absolute displacement
 * on each axis since pointerdown. A drag that never travels `PAN_KILL_MIN_PX`
 * vertically keeps price-follow armed, which is the whole point: scrolling back
 * through time must not cost you price tracking.
 */
export function panFollowKill(peakDx: number, peakDy: number): FollowKill {
  const killTime = Math.abs(peakDx) >= PAN_KILL_MIN_PX;
  const killPrice = Math.abs(peakDy) >= PAN_KILL_MIN_PX;
  if (killTime && killPrice) return KILL_BOTH;
  if (killTime) return KILL_TIME;
  if (killPrice) return KILL_PRICE;
  return KILL_NONE;
}

/**
 * The row the price window should stay centred on, from ONE column's already-
 * scanned book geometry:
 *   - `bidTop` — highest row with bid > 0 (−1 when the bid side is empty),
 *   - `askBot` — lowest row with ask > 0 (−1 when the ask side is empty),
 *   - `[lo, hi]` — the column's overall non-zero row extent (−1/−1 when empty).
 *
 * Two-sided and uncrossed (`askBot > bidTop`) → the inside-quote midpoint, which
 * is the closest thing to "the price" that needs no BBO channel, no capability
 * check and no overlay state. Otherwise (one-sided SYNTH_PROFILE books, a
 * crossed snapshot mid-update) → the extent midpoint. Empty column → null, and
 * the caller keeps the previous tracked row rather than jumping to row 0.
 */
export function trackedRow(
  bidTop: number,
  askBot: number,
  lo: number,
  hi: number,
): number | null {
  if (bidTop >= 0 && askBot >= 0 && askBot > bidTop) return (bidTop + askBot + 1) / 2;
  if (lo >= 0 && hi >= lo) return (lo + hi + 1) / 2;
  return null;
}

/**
 * The new `rowCenter` to ease toward, or null when the tracked row is still
 * inside the deadband and the view should not move at all. Returning null (not
 * "the current centre") is what lets the caller skip the redraw entirely.
 */
export function priceFollowTarget(
  rowCenter: number,
  rowSpan: number,
  tracked: number | null,
): number | null {
  if (tracked === null || !Number.isFinite(tracked) || !(rowSpan > 0)) return null;
  const half = (rowSpan * PRICE_DEADBAND_FRACTION) / 2;
  return Math.abs(tracked - rowCenter) <= half ? null : tracked;
}

/**
 * Frame-rate-independent exponential ease toward `target`. The two guards are
 * deliberately SPLIT: a non-positive `tauMs` means "no easing configured", so
 * jump; a non-positive `dtMs` means "no time has passed", so hold. Collapsing
 * them into one guard that returns `target` teleports the view on any frame the
 * clock reports a zero delta.
 */
export function approach(current: number, target: number, dtMs: number, tauMs: number): number {
  if (!(tauMs > 0)) return target;
  if (!(dtMs > 0)) return current;
  return current + (target - current) * (1 - Math.exp(-dtMs / tauMs));
}

/** Whether an absolute column falls inside the view's horizontal window. */
export function isColVisible(view: HeatmapView, col: number): boolean {
  return col >= view.colOffset && col < view.colOffset + view.colScale;
}

/**
 * How many columns the view's right edge sits behind the newest column — 0 when
 * pinned to (or past) the live edge. Drives the transport's `−HH:MM:SS`
 * behind-readout once multiplied by the epoch's `dt_ns`.
 */
export function colsBehind(view: HeatmapView, newestSeq: number): number {
  const right = view.colOffset + view.colScale;
  const behind = newestSeq + 1 - right;
  return behind > 0 ? behind : 0;
}
