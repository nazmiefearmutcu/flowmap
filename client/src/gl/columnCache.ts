/**
 * CPU column cache for the crosshair readout (§8.3, M2 T9).
 *
 * The crosshair must show the EXACT resting size at a hovered `(time, price)`
 * cell — read from the precise f32 values the renderer appended, NEVER from the
 * GPU-filtered / SUM-mip texels (those are approximate: f16-quantized, saturated
 * at 60 000, and — at coarse levels — column-averaged / row-summed). So we keep a
 * compact CPU-side cache of the exact `bid`/`ask` Float32Arrays for columns in or
 * near the viewport, keyed by ABSOLUTE `col_seq`, bounded by an LRU cap and by an
 * explicit prune to the resident window. It doubles as the §8.3 instant-recovery
 * source after a WebGL context loss.
 *
 * The arrays are the very ones the renderer uploads. `decode.ts` builds each
 * DepthColumn's `bid`/`ask` as a fresh Float32Array over a COPIED slice of the
 * frame (never a view that pins the socket buffer), and finalized columns are
 * immutable, so the cache holds references directly — no extra copy. Callers must
 * not mutate an array after `put` (the live decode path never does).
 *
 * Pure CPU, no GL: eviction, pruning and grouped `sizeAt` are all unit-testable
 * without a WebGL context (see columnCache.test.ts).
 */

/** Exact summed resting size at a cell (or grouped cell). */
export interface CellSize {
  bid: number;
  ask: number;
}

interface Entry {
  bid: Float32Array;
  ask: Float32Array | null;
  rows: number;
  epoch: number;
  t0_ns: bigint;
}

/** Default cap on retained columns. At 2048 rows ≈ 16 KB/col → ≤ ~32 MB. */
export const DEFAULT_CAPACITY_COLS = 2048;

export class ColumnCache {
  readonly capacity: number;
  /** Insertion/access-ordered map → oldest entry is the first key (LRU). */
  private readonly map = new Map<number, Entry>();

  constructor(opts: { capacity?: number } = {}) {
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY_COLS);
  }

  /** Number of columns currently cached. */
  get size(): number {
    return this.map.size;
  }

  /**
   * Cache (or refresh) one column's exact arrays at absolute `col_seq`. A refresh
   * (the in-progress right-edge column re-sent each flush) overwrites in place and
   * marks the entry most-recently-used. Evicts the LRU column past the cap.
   */
  put(colSeq: number, bid: Float32Array, ask: Float32Array | null, t0_ns: bigint, epoch = 0): void {
    // Re-insert to move to the most-recently-used end of the Map's order.
    if (this.map.has(colSeq)) this.map.delete(colSeq);
    this.map.set(colSeq, { bid, ask, rows: bid.length, epoch, t0_ns });
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Whether an absolute col_seq is cached. */
  has(colSeq: number): boolean {
    return this.map.has(colSeq);
  }

  /**
   * Read-only view of a cached column's exact `bid`/`ask` density arrays (the
   * volume profile sums these), or null when the column is not cached. Does NOT
   * touch LRU order (a bulk profile sweep must not reorder the crosshair cache).
   * Callers must treat the returned arrays as immutable.
   */
  arrays(colSeq: number): { bid: Float32Array; ask: Float32Array | null } | null {
    const e = this.map.get(colSeq);
    return e === undefined ? null : { bid: e.bid, ask: e.ask };
  }

  /** The nanosecond start time of a cached column, or null if absent. */
  timeAt(colSeq: number): bigint | null {
    return this.map.get(colSeq)?.t0_ns ?? null;
  }

  /** The epoch a cached column was appended under, or null if absent. */
  epochAt(colSeq: number): number | null {
    return this.map.get(colSeq)?.epoch ?? null;
  }

  /**
   * The EXACT summed resting size at `(colSeq, rowStart)`, summing `groupRows`
   * consecutive rows `[rowStart, rowStart+groupRows)` (clamped to the grid) so a
   * tick-grouped / zoomed-out view reports the total of the grouped price levels —
   * exactly as the heatmap sums them. `groupRows` defaults to 1 (a single cell).
   * Marks the column most-recently-used. Returns null when the column is not
   * cached (deep history the renderer has not fetched) so the caller can render a
   * price with "—" for size.
   */
  sizeAt(colSeq: number, rowStart: number, groupRows = 1): CellSize | null {
    const e = this.map.get(colSeq);
    if (e === undefined) return null;
    // Touch: promote to most-recently-used.
    this.map.delete(colSeq);
    this.map.set(colSeq, e);

    const g = Math.max(1, Math.floor(groupRows));
    const lo = Math.max(0, Math.floor(rowStart));
    const hi = Math.min(e.rows, lo + g);
    let bidSum = 0;
    let askSum = 0;
    for (let r = lo; r < hi; r++) {
      bidSum += e.bid[r];
      if (e.ask !== null) askSum += e.ask[r];
    }
    return { bid: bidSum, ask: askSum };
  }

  /**
   * Drop every cached column outside `[oldest - pad, newest + pad]` — the renderer
   * calls this with the resident window so the cache tracks the viewed region and
   * far scroll-back / evicted-live columns are released. O(cached columns).
   */
  prune(oldest: number, newest: number, pad = 0): void {
    const lo = oldest - pad;
    const hi = newest + pad;
    for (const colSeq of this.map.keys()) {
      if (colSeq < lo || colSeq > hi) this.map.delete(colSeq);
    }
  }

  reset(): void {
    this.map.clear();
  }
}
