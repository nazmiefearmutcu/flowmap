/**
 * Deep scroll-back history backfill (§8.3 residency, M2 T8).
 *
 * The full-res tile ring holds a bounded recent window (the residency budget,
 * see gl/tileRing). When the user pans LEFT past the oldest resident column and
 * older data still exists, the {@link HistoryLoader} issues a `HistoryRequest`
 * for the missing range, splices the returned `depth_cols` back into the ring at
 * their TRUE absolute col_seq (the ring self-slides its window backward and
 * evicts the live edge — the LRU end), and regenerates the affected SUM-mips.
 *
 * Design notes upheld here:
 *
 * - **col_seq ↔ before_t mapping.** Each column carries its own `t0_ns`, so the
 *   loader tracks `(col_seq → t0_ns)` for resident columns as they arrive (live
 *   or backfilled). To fetch the page immediately older than the oldest resident
 *   column it requests `before_t = t0_ns(oldestResident)` — the server's
 *   `history(before_t, n)` is EXCLUSIVE, returning the n most-recent columns with
 *   `t0 < before_t`, i.e. exactly the ones just older than what we hold. When the
 *   exact t0 is unavailable it falls back to `oldestT0 − k·dt_ns` (the spec's
 *   fallback). No dependence on col_seq==interval-index (the sim skips seqs on
 *   capped gaps), so the mapping is robust.
 *
 * - **Coalescing / debounce.** At most ONE request is in flight; `ensureVisible`
 *   is a cheap O(1) guard (compares the visible left edge to the resident oldest)
 *   so it can run every frame without history-proportional work — the §10 perf
 *   gate requires the per-frame path stay O(visible), not O(history).
 *
 * - **Start of history.** The server reports `oldest_available_t_ns`; when a
 *   response is empty or we have reached that bound (or col_seq 0), the loader
 *   latches `startOfHistory` and stops spinning — scroll-back is exhausted, not a
 *   busy-loop.
 *
 * - **Deep zoom-out.** When the price mip level-2 is engaged (or the time span
 *   exceeds the full-res budget) the view renders from the SUM-mips and native
 *   full-res residency is neither achievable nor needed, so backfill is
 *   suppressed — we never try to re-populate the whole extent full-res.
 *
 * The loader is transport-agnostic: it depends only on an injected
 * `requestHistory` (the store's) and a `spliceColumn` sink (the renderer's), so
 * the range-computation + debounce logic is unit-testable with a fake.
 */

import type { DepthColumn, HistoryResponse } from '../proto/types';
import type { ResidentRange } from '../gl/tileRing';

/** How close (in columns) the visible left edge must get to the oldest resident
 *  column before a prefetch fires. One viewport-ish margin so data is ready
 *  before the user reaches the edge. */
const PREFETCH_MARGIN_COLS = 64;
/** Max columns per HistoryRequest (mirrors the server's HISTORY_MAX_COLS clamp). */
export const HISTORY_PAGE_COLS = 256;
/** Keep the visible span resident: never fetch so many that the just-viewed
 *  columns get evicted in the same slide. Leave this much headroom. */
const RESIDENT_HEADROOM_COLS = 32;

export interface HistoryLoaderDeps {
  /** Request a page of history (the store's `requestHistory`). */
  requestHistory: (before_t: bigint, n: number) => Promise<HistoryResponse>;
  /** Splice one returned column into the ring + mips + CPU caches (renderer). */
  spliceColumn: (col: DepthColumn) => void;
  /** Current full-res resident window (renderer → ring). */
  residentRange: () => ResidentRange | null;
  /** Full-res budget in columns (ring capacity). */
  budgetCols: () => number;
  /** Nominal column interval in ns for the before_t fallback (epoch dt_ns). */
  dtNs: () => number;
  /** Called after a batch splices (renderer marks dirty / refits). Optional. */
  onSpliced?: (resp: HistoryResponse) => void;
}

/** The view facts the per-frame guard needs (all O(1), no history scan). */
export interface VisibleState {
  /** Absolute column at the viewport's left edge (floor of colOffset). */
  leftCol: number;
  /** Columns across the viewport (time span). */
  span: number;
  /** SUM-mip level the heatmap would sample this frame (0/1/2). */
  level: number;
}

export class HistoryLoader {
  private readonly deps: HistoryLoaderDeps;

  /** (col_seq → t0_ns) for columns we've seen — pruned to the resident window. */
  private readonly colT0 = new Map<number, bigint>();
  /** Oldest col_seq we have a t0 for (anchors the dt fallback). */
  private oldestKnownSeq = -1;
  private oldestKnownT0 = 0n;

  private inFlightBeforeT: bigint | null = null;
  private startOfHistoryFlag = false;
  private requestCountN = 0;
  private lastError: string | null = null;
  /** Server's oldest retained t0 (from the latest response); 0 until known. */
  private oldestAvailableT0 = 0n;

  constructor(deps: HistoryLoaderDeps) {
    this.deps = deps;
  }

  /** Record a column's (col_seq, t0_ns) as it enters the ring (live or backfill). */
  noteColumn(colSeq: number, t0Ns: bigint): void {
    this.colT0.set(colSeq, t0Ns);
    if (this.oldestKnownSeq < 0 || colSeq < this.oldestKnownSeq) {
      this.oldestKnownSeq = colSeq;
      this.oldestKnownT0 = t0Ns;
    }
    this.pruneCache();
  }

  /** Drop cached t0s well below the resident window so the map stays bounded. */
  private pruneCache(): void {
    const range = this.deps.residentRange();
    if (!range) return;
    const floor = range.oldest - HISTORY_PAGE_COLS * 2;
    if (this.colT0.size <= this.deps.budgetCols() + HISTORY_PAGE_COLS * 2) return;
    for (const seq of this.colT0.keys()) {
      if (seq < floor) this.colT0.delete(seq);
    }
  }

  /**
   * Per-frame guard (called only when the view moved). O(1): if the visible left
   * edge has come within the prefetch margin of the oldest resident column and
   * older data exists, fire one coalesced HistoryRequest. Deep zoom-out (level-2
   * or span beyond the budget) renders from mips and never backfills.
   */
  ensureVisible(v: VisibleState): void {
    if (this.inFlightBeforeT !== null) return; // one request at a time
    if (this.startOfHistoryFlag) return; // scroll-back exhausted
    // Deep zoom-out renders from the SUM-mips / shows the whole resident extent,
    // so full-res backfill is neither achievable nor useful: never re-populate
    // the whole extent. Suppressed when the price mip level-2 is engaged, or when
    // the time span spans the entire budget (the whole ring is already on screen
    // — backfilling would only evict what's being viewed).
    if (v.level >= 2) return;
    if (v.span >= this.deps.budgetCols()) return;

    const range = this.deps.residentRange();
    if (!range) return;
    // Nothing to do while the view is still comfortably inside the resident
    // window (this also means normal live-follow, where the left edge sits far
    // from the oldest column, never touches the scroll-back path).
    if (v.leftCol > range.oldest - PREFETCH_MARGIN_COLS) return;
    // We WANT older data but the window already reaches absolute col_seq 0 —
    // scroll-back is exhausted at the very start of the stream.
    if (range.oldest <= 0) {
      this.startOfHistoryFlag = true;
      return;
    }

    const beforeT = this.beforeTFor(range.oldest);
    if (beforeT === null) return;
    // Already at/behind the server's oldest retained column → exhausted.
    if (this.oldestAvailableT0 > 0n && beforeT <= this.oldestAvailableT0) {
      this.startOfHistoryFlag = true;
      return;
    }

    // Page size: leave the visible span resident so it doesn't evict itself.
    // Must be an integer — the wire `n_cols` field is a u32.
    const room = this.deps.budgetCols() - Math.ceil(v.span) - RESIDENT_HEADROOM_COLS;
    const n = Math.max(1, Math.min(HISTORY_PAGE_COLS, Math.floor(room)));
    void this.fetch(beforeT, n);
  }

  /** before_t for the page immediately older than `oldestResidentSeq`. */
  private beforeTFor(oldestResidentSeq: number): bigint | null {
    const exact = this.colT0.get(oldestResidentSeq);
    if (exact !== undefined) return exact;
    if (this.oldestKnownSeq < 0) return null;
    // Fallback (spec): oldest known t0 minus the seq gap × dt.
    const dt = BigInt(Math.max(1, Math.round(this.deps.dtNs())));
    const gap = BigInt(this.oldestKnownSeq - oldestResidentSeq);
    return this.oldestKnownT0 - gap * dt;
  }

  private async fetch(beforeT: bigint, n: number): Promise<void> {
    this.inFlightBeforeT = beforeT;
    this.requestCountN += 1;
    try {
      const resp = await this.deps.requestHistory(beforeT, n);
      this.oldestAvailableT0 = resp.oldest_available_t_ns;
      // Splice ascending (oldest first) so each lands adjacent to the window.
      const cols = resp.depth_cols;
      if (cols.length === 0) {
        // Nothing older on the server → scroll-back exhausted.
        this.startOfHistoryFlag = true;
      } else {
        for (const col of cols) {
          this.noteColumn(col.col_seq, col.t0_ns);
          this.deps.spliceColumn(col);
        }
        // If this batch already reaches the start of history — absolute col_seq
        // 0, or the server's oldest retained column — the next request would
        // return nothing, so pre-latch to skip that wasted empty round-trip.
        // (col_seq 0 is checked explicitly because the sim's t0 base is 0, so a
        // t0-only test would be ambiguous with the "no columns → 0" sentinel.)
        const reachedStart =
          cols.some((c) => c.col_seq === 0) ||
          (this.oldestAvailableT0 > 0n && cols.some((c) => c.t0_ns <= this.oldestAvailableT0));
        if (reachedStart) this.startOfHistoryFlag = true;
        this.deps.onSpliced?.(resp);
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      // Transient (timeout / disconnect): do NOT latch exhaustion; a later pan
      // retries. Just clear in-flight so the next frame can re-issue.
    } finally {
      this.inFlightBeforeT = null;
    }
  }

  /** Clear scroll-back state (e.g. on go-live / re-subscribe / context restore). */
  reset(): void {
    this.inFlightBeforeT = null;
    this.startOfHistoryFlag = false;
  }

  // --- diagnostics (dev hook / e2e) --------------------------------------------

  /** Number of HistoryRequests issued so far. */
  get requestCount(): number {
    return this.requestCountN;
  }
  /** Whether a request is currently in flight. */
  get inFlight(): boolean {
    return this.inFlightBeforeT !== null;
  }
  /** Whether scroll-back has hit the start of available history. */
  get startOfHistory(): boolean {
    return this.startOfHistoryFlag;
  }
  /** Last request error message (or null). */
  get error(): string | null {
    return this.lastError;
  }
}
