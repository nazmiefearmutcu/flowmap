/**
 * CPU column cache for the crosshair readout (§8.3, M2 T9) — ONE preallocated
 * slot-addressed pool (campaign 3, survey #5).
 *
 * The crosshair must show the EXACT resting size at a hovered `(time, price)`
 * cell — read from the precise f32 values the renderer appended, NEVER from the
 * GPU-filtered / SUM-mip texels (those are approximate: f16-quantized, saturated
 * at 60 000, and — at coarse levels — column-averaged / row-summed). So we keep
 * a compact CPU-side copy of the exact `bid`/`ask` densities for the resident
 * columns. It doubles as the §8.3 instant-recovery source after a WebGL context
 * loss.
 *
 * ### Paged pool storage (replaces the per-column entry objects)
 *
 * The historical implementation stored one `{bid, ask}` object + TWO retained
 * `Float32Array`s per column in a `Map` — ~16 k retained ArrayBuffers under the
 * ring-sized cache, with two fresh ArrayBuffer allocations per decoded column
 * (`decode.ts` `buffer.slice`) landing exactly on the append path (4–20
 * columns/s live, 512-per-page bursts on scroll-back).
 *
 * Now the pool is SLOT-ADDRESSED and PAGED: `capacity` slots are split into
 * pages of {@link COLUMN_CACHE_PAGE_SLOTS} (256) slots, and each page's
 * `Float32Array` (`pageSlots · rows · 2` floats) is allocated lazily on the
 * FIRST `put` that touches any of its slots (the row count is only known
 * then). A page allocates once and is reused forever after — steady-state
 * appends stay zero-alloc — but a fresh boot only pays for the columns it
 * actually caches, not the whole ring up front (the first fix-2026-09-10
 * whole-ring preallocation cost 256 MiB at 2048 rows / 16384 cols the moment
 * the first column landed). `cacheBytes` reports RESIDENT pages only.
 * `put` COPIES bid/ask into the slot's views — zero per-column allocations in
 * steady state, O(1) eviction, and the decode slices become
 * immediately-collectable young-gen garbage instead of retained heap.
 *
 * Slot addressing mirrors the GPU ring exactly (`slot = colSeq mod capacity`):
 * writing column `capacity` further wraps to the slot of the column being
 * evicted, so eviction is implicit and always ring-consistent. That trades the
 * old LRU order for ring parity — with the cache sized to the WHOLE ring (the
 * renderer's choice), a slot only ever evicts the column the ring itself
 * overwrote, so behavior is identical where it matters.
 *
 * `arrays()` returns subarray VIEWS into the pool (callers — the volume profile
 * and the L2-derived BBO — consume them synchronously within one draw; a later
 * `put` to the same slot mutates the view). `sizeAt` indexes the pool directly.
 *
 * Pure CPU, no GL (see columnCache.test.ts).
 */

/** Exact summed resting size at a cell (or grouped cell). */
export interface CellSize {
  bid: number;
  ask: number;
}

/** Default cap on retained columns when nothing sizes the cache explicitly.
 * NOTE: the renderer sizes the cache to the WHOLE ring (renderer.ts
 * ringLayersFor) so the profile/crosshair see every resident column. The CPU
 * footprint is PAGED (see {@link COLUMN_CACHE_PAGE_SLOTS}): only the pages the
 * session actually touches are ever allocated, so a fresh boot holds one or
 * two pages (MiBs), not the whole ring. */
export const DEFAULT_CAPACITY_COLS = 2048;

/** Slots per pool page: `page = slot >>> 8`. A page's Float32Array allocates
 * once — on the first put that touches any of its slots — and is reused for
 * the page's lifetime (until reset / a row-count change frees it). 256 slots ×
 * 2048 rows × 2 channels × 4 B = 4 MiB per page in the default renderer grid;
 * the whole 16384-slot ring tops out at 64 pages only if the session really
 * scrolls through all of it. Exported for tests + memory accounting. */
export const COLUMN_CACHE_PAGE_SLOTS = 256;
const PAGE_SHIFT = 8;
const PAGE_MASK = COLUMN_CACHE_PAGE_SLOTS - 1;

const FLAG_PRESENT = 1;
const FLAG_ASK = 2;

export class ColumnCache {
  readonly capacity: number;
  /**
   * The pool pages: page `p` holds `COLUMN_CACHE_PAGE_SLOTS` consecutive slots,
   * each slot `rows * 2` floats laid out [bid…, ask…]. Allocated lazily per
   * page on the first `put` touching it; all pages are freed and re-created if
   * a later column brings a different row count (the renderer resets the cache
   * on a grid-geometry change, so this is a defensive path).
   */
  private pages: (Float32Array | null)[];
  private poolRows = 0;
  /** Absolute col_seq each slot was last written for (Float64: u32 seqs exact). */
  private readonly seqs: Float64Array;
  private readonly t0s: BigInt64Array;
  private readonly epochs: Int32Array;
  /** Per-slot flags: bit0 present, bit1 ask-present. */
  private readonly flags: Uint8Array;
  private countN = 0;

  constructor(opts: { capacity?: number } = {}) {
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY_COLS);
    this.pages = new Array(Math.ceil(this.capacity / COLUMN_CACHE_PAGE_SLOTS)).fill(null);
    this.seqs = new Float64Array(this.capacity);
    this.t0s = new BigInt64Array(this.capacity);
    this.epochs = new Int32Array(this.capacity);
    this.flags = new Uint8Array(this.capacity);
  }

  /** Number of columns currently cached. */
  get size(): number {
    return this.countN;
  }

  /**
   * Bytes retained by the RESIDENT pool pages + the metadata typed arrays
   * (diagnostics, §10 memory accounting — `Renderer.stats().cacheBytes`).
   * Grows page-wise as the session touches new pages; 0 pool bytes before the
   * first put.
   */
  get byteLength(): number {
    let pool = 0;
    for (const page of this.pages) {
      if (page !== null) pool += page.byteLength;
    }
    return (
      pool +
      this.seqs.byteLength +
      this.t0s.byteLength +
      this.epochs.byteLength +
      this.flags.byteLength
    );
  }

  /** How many pool pages are currently allocated (tests + diagnostics). */
  get residentPageCount(): number {
    let n = 0;
    for (const page of this.pages) {
      if (page !== null) n++;
    }
    return n;
  }

  /** Ring-consistent slot for an absolute col_seq. */
  private slotOf(colSeq: number): number {
    return ((colSeq % this.capacity) + this.capacity) % this.capacity;
  }

  /**
   * Record the pool's row geometry (releasing every page on a change — a
   * row-count change invalidates every cached column).
   */
  private ensureRows(rows: number): void {
    if (this.poolRows === rows) return;
    this.pages.fill(null);
    this.poolRows = rows;
    this.flags.fill(0);
    this.countN = 0;
  }

  /** The page for `slot`, allocated on first touch (once per page lifetime). */
  private pageFor(slot: number): Float32Array {
    const p = slot >>> PAGE_SHIFT;
    let page = this.pages[p];
    if (page === null) {
      page = new Float32Array(COLUMN_CACHE_PAGE_SLOTS * this.poolRows * 2);
      this.pages[p] = page;
    }
    return page;
  }

  /**
   * Cache (or refresh) one column's exact arrays at absolute `col_seq`. COPIES
   * bid/ask into the slot's pool views (the only CPU cost of an append besides
   * metadata writes; no allocation). A refresh (the in-progress right-edge
   * column re-sent each flush) overwrites its slot in place. Writing a column
   * whose slot holds a different col_seq implicitly evicts it — ring parity.
   */
  put(colSeq: number, bid: Float32Array, ask: Float32Array | null, t0_ns: bigint, epoch = 0): void {
    this.ensureRows(bid.length);
    const rows = this.poolRows;
    const slot = this.slotOf(colSeq);
    const page = this.pageFor(slot); // allocates the page once, on first touch
    if ((this.flags[slot] & FLAG_PRESENT) === 0) this.countN++;
    const off = (slot & PAGE_MASK) * rows * 2;
    page.set(bid, off);
    if (ask !== null) page.set(ask, off + rows);
    this.seqs[slot] = colSeq;
    this.t0s[slot] = t0_ns;
    this.epochs[slot] = epoch;
    this.flags[slot] = FLAG_PRESENT | (ask !== null ? FLAG_ASK : 0);
  }

  /** Whether an absolute col_seq is cached (slot must still hold THAT column). */
  has(colSeq: number): boolean {
    const slot = this.slotOf(colSeq);
    return (this.flags[slot] & FLAG_PRESENT) !== 0 && this.seqs[slot] === colSeq;
  }

  /**
   * Read-only view of a cached column's exact `bid`/`ask` density arrays (the
   * volume profile sums these), or null when the column is not cached. The
   * views alias the pool: callers must treat them as immutable AND consume them
   * before the next `put` to the same slot (the overlay draw does — audited).
   * Does not allocate beyond the small wrapper + two subarray views.
   */
  arrays(colSeq: number): { bid: Float32Array; ask: Float32Array | null } | null {
    const slot = this.slotOf(colSeq);
    if ((this.flags[slot] & FLAG_PRESENT) === 0 || this.seqs[slot] !== colSeq) return null;
    const rows = this.poolRows;
    const page = this.pages[slot >>> PAGE_SHIFT]!;
    const off = (slot & PAGE_MASK) * rows * 2;
    return {
      bid: page.subarray(off, off + rows),
      ask:
        (this.flags[slot] & FLAG_ASK) !== 0
          ? page.subarray(off + rows, off + 2 * rows)
          : null,
    };
  }

  /** The nanosecond start time of a cached column, or null if absent. */
  timeAt(colSeq: number): bigint | null {
    const slot = this.slotOf(colSeq);
    if ((this.flags[slot] & FLAG_PRESENT) === 0 || this.seqs[slot] !== colSeq) return null;
    return this.t0s[slot];
  }

  /** The epoch a cached column was appended under, or null if absent. */
  epochAt(colSeq: number): number | null {
    const slot = this.slotOf(colSeq);
    if ((this.flags[slot] & FLAG_PRESENT) === 0 || this.seqs[slot] !== colSeq) return null;
    return this.epochs[slot];
  }

  /**
   * The EXACT summed resting size at `(colSeq, rowStart)`, summing `groupRows`
   * consecutive rows `[rowStart, rowStart+groupRows)` (clamped to the grid) so a
   * tick-grouped / zoomed-out view reports the total of the grouped price levels —
   * exactly as the heatmap sums them. `groupRows` defaults to 1 (a single cell).
   * Indexes the pool directly (no views, no allocation). Returns null when the
   * column is not cached (deep history the renderer has not fetched) so the
   * caller can render a price with "—" for size.
   */
  sizeAt(colSeq: number, rowStart: number, groupRows = 1): CellSize | null {
    const slot = this.slotOf(colSeq);
    if ((this.flags[slot] & FLAG_PRESENT) === 0 || this.seqs[slot] !== colSeq) return null;
    const rows = this.poolRows;
    const g = Math.max(1, Math.floor(groupRows));
    const lo = Math.max(0, Math.floor(rowStart));
    const hi = Math.min(rows, lo + g);
    const page = this.pages[slot >>> PAGE_SHIFT]!;
    const off = (slot & PAGE_MASK) * rows * 2;
    const pool = page;
    let bidSum = 0;
    let askSum = 0;
    const askPresent = (this.flags[slot] & FLAG_ASK) !== 0;
    for (let r = lo; r < hi; r++) {
      bidSum += pool[off + r];
      if (askPresent) askSum += pool[off + rows + r];
    }
    return { bid: bidSum, ask: askSum };
  }

  /**
   * Drop every cached column and release ALL pool pages (the next `put`
   * re-allocates the touched pages at the new session's row count — a symbol
   * switch may change it).
   */
  reset(): void {
    this.flags.fill(0);
    this.countN = 0;
    this.pages.fill(null);
    this.poolRows = 0;
  }
}
