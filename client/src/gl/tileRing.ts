/**
 * The density tile ring (§8.3 storage) + full-res residency (§8.3, M2 T8).
 *
 * One immutable `TEXTURE_2D_ARRAY`, `256 (cols/tile) × rows × layers`, `RG16F`
 * (R = bid density, G = ask density). A column append is a single
 * `texSubImage3D` writing one column (width 1, height `rows`) into one
 * (layer, x) slot — the ONLY GPU write that ever touches history. Panning and
 * zooming change draw uniforms only; a column, once uploaded, is never
 * re-uploaded (the §8.3 no-CPU-re-raster invariant).
 *
 * Addressing: an absolute `colSeq` maps to a flat ring slot
 * `slot = colSeq mod capacityCols`, and `(layer, x) = (slot / 256, slot % 256)`.
 * Because addressing is by ABSOLUTE col_seq, the ring holds ANY contiguous
 * window of ≤ `capacityCols` columns — not just the live tail. Writing a column
 * one past either end of the resident window overwrites (via the modulo wrap)
 * exactly the column `capacityCols` away, i.e. the far end of the window: the
 * ring self-evicts the least-recently-touched end with no bookkeeping. This is
 * what lets deep scroll-back (T8) splice OLDER columns at their true absolute
 * col_seq and slide the resident window backward through history — the live
 * edge (which the user has panned away from) is the LRU end that falls out.
 *
 * ### Full-res residency budget (§8.3 / §10 memory gate)
 *
 * Full-res tiles are memory-bounded. The budget is the ring capacity in columns
 * (`256 × layers`); at RG16F (2 channels × 2 bytes = 4 B/texel) one column is
 * `rows × 4` bytes:
 *
 *   layers=64 → capacity 16 384 cols → at 2048 rows: 16384·2048·4 = 134 MiB;
 *                                      at 4096 rows: 16384·4096·4 = 268 MiB.
 *
 * 16 384 cols is the spec's "~16 k recent columns"; it stays ≤ 256 MB at the
 * production 4096-row grid and well under the §10 300 MB GPU-memory gate. See
 * {@link fullResBytes}. Ranges older than this window are not held full-res —
 * scrolling into them issues a `HistoryRequest` (see net/history) that slides
 * the window back; deep zoom-out renders from the SUM-mips instead.
 *
 * The residency book-keeping (window + per-layer LRU clock) is a PURE object
 * ({@link Residency}) with no GL, so eviction/addressing is unit-testable
 * without a WebGL context.
 *
 * Per-epoch row transform seam: columns carry an `epoch`, and different epochs
 * map a given row index to different prices (§8.2). This ring stores raw
 * densities only and is epoch-agnostic; the row→price affine is a per-draw
 * uniform (see Heatmap). This task assumes a single epoch (the sim's) for the
 * spliced-column geometry and records the appended epoch for a future hook.
 */

import { checkGLError } from './context';

export const COLS_PER_TILE = 256;

export interface ResidentRange {
  /** Oldest resident absolute colSeq (inclusive). */
  oldest: number;
  /** Newest resident absolute colSeq (inclusive). */
  newest: number;
  /** Number of resident columns (newest - oldest + 1). */
  count: number;
}

export interface TileSlot {
  layer: number;
  x: number;
}

/**
 * Pure full-res residency book-keeping — the resident absolute-col_seq window
 * plus a per-tile-layer last-touched clock (the LRU record §8.3 asks for). No
 * GL: {@link TileRing} composes one and drives it from `append`, and the unit
 * tests drive it directly.
 *
 * The resident window is a single contiguous `[oldest, newest]` interval whose
 * width never exceeds `capacityCols` (the budget). `note(colSeq)` folds one
 * written column into the window:
 *   - empty ring        → window becomes `[colSeq, colSeq]`;
 *   - inside the window → in-place overwrite, window unchanged;
 *   - at/after newest   → grow forward; if that overflows the budget, drop the
 *                         oldest (which the modulo wrap physically overwrote);
 *   - at/before oldest  → grow backward; if that overflows, drop the newest.
 * The dropped end is always the one the modulo wrap actually clobbered, so the
 * reported window is exactly the set of slots still holding their column.
 */
export class Residency {
  readonly capacityCols: number;
  readonly colsPerTile: number;
  readonly layers: number;

  private oldest = -1;
  private newest = -1;
  private clock = 0;
  /** Last-touched logical clock per tile layer (LRU record; diagnostics). */
  private readonly layerTouch: Float64Array;

  constructor(capacityCols: number, colsPerTile: number, layers: number) {
    this.capacityCols = capacityCols;
    this.colsPerTile = colsPerTile;
    this.layers = layers;
    this.layerTouch = new Float64Array(layers);
  }

  /** Full-res residency budget in columns (== ring capacity). */
  get budgetCols(): number {
    return this.capacityCols;
  }

  /** Fold one written column at absolute `colSeq` into the resident window. */
  note(colSeq: number): void {
    const cap = this.capacityCols;
    if (this.oldest < 0) {
      this.oldest = colSeq;
      this.newest = colSeq;
    } else if (colSeq >= this.oldest && colSeq <= this.newest) {
      // In-place overwrite of a resident column — window unchanged.
    } else if (colSeq >= this.newest) {
      // Forward growth (adjacent live append, or a rare capped-gap skip).
      this.newest = colSeq;
      if (this.newest - this.oldest + 1 > cap) this.oldest = this.newest - cap + 1;
    } else {
      // Backward growth (deep scroll-back backfill splicing older columns).
      this.oldest = colSeq;
      if (this.newest - this.oldest + 1 > cap) this.newest = this.oldest + cap - 1;
    }
    // LRU touch for the layer this column landed in.
    const slot = ((colSeq % cap) + cap) % cap;
    const layer = (slot / this.colsPerTile) | 0;
    this.layerTouch[layer] = ++this.clock;
  }

  range(): ResidentRange | null {
    if (this.oldest < 0) return null;
    return { oldest: this.oldest, newest: this.newest, count: this.newest - this.oldest + 1 };
  }

  isResident(colSeq: number): boolean {
    return this.oldest >= 0 && colSeq >= this.oldest && colSeq <= this.newest;
  }

  /** The LRU layer order (oldest-touched first). Diagnostics / eviction proof. */
  lruLayerOrder(): number[] {
    return Array.from({ length: this.layers }, (_, i) => i).sort(
      (a, b) => this.layerTouch[a] - this.layerTouch[b],
    );
  }

  reset(): void {
    this.oldest = -1;
    this.newest = -1;
    this.clock = 0;
    this.layerTouch.fill(0);
  }
}

export class TileRing {
  readonly gl: WebGL2RenderingContext;
  readonly rows: number;
  readonly layers: number;
  readonly colsPerTile = COLS_PER_TILE;
  /** Total columns the ring can hold before it wraps (== full-res budget). */
  readonly capacityCols: number;
  readonly texture: WebGLTexture;

  /** Full-res residency window + LRU (pure; see {@link Residency}). */
  private readonly residency: Residency;
  /** Scratch RG-interleaved upload buffer, reused per append (no per-call alloc). */
  private readonly scratch: Float32Array;

  constructor(gl: WebGL2RenderingContext, rows: number, layers: number) {
    if (rows <= 0 || layers <= 0) {
      throw new Error(`flowmap/tileRing: rows and layers must be > 0 (got ${rows}, ${layers})`);
    }
    this.gl = gl;
    this.rows = rows;
    this.layers = layers;
    this.capacityCols = this.colsPerTile * layers;
    this.residency = new Residency(this.capacityCols, this.colsPerTile, layers);
    this.scratch = new Float32Array(rows * 2);

    const tex = gl.createTexture();
    if (!tex) throw new Error('flowmap/tileRing: gl.createTexture returned null');
    this.texture = tex;

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    // Immutable storage, one mip level (SUM mips are separate textures, T7).
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RG16F, this.colsPerTile, rows, layers);
    // texelFetch does its own indexing — NEAREST + clamp keep the texture
    // complete without implying any filtering.
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    checkGLError(gl, 'TileRing.alloc');
  }

  /** Map an absolute colSeq to its ring slot. Assumes colSeq ≥ 0. */
  locate(colSeq: number): TileSlot {
    const slot = ((colSeq % this.capacityCols) + this.capacityCols) % this.capacityCols;
    return { layer: (slot / this.colsPerTile) | 0, x: slot % this.colsPerTile };
  }

  /**
   * Append one finalized column at absolute `colSeq`. `bid` (and `ask` for L2 /
   * L1_BAND) must be length `rows`; `ask` is null for SYNTH_PROFILE (ask channel
   * uploads as 0). Densities are Float32 (server cast from f16); the driver
   * converts to f16 on upload into RG16F.
   *
   * Absolute-col_seq addressing means this is equally the LIVE-append path
   * (forward, colSeq = newest+1) and the T8 backfill splice path (older colSeq
   * landing in its true slot): the resident window (see {@link residentRange})
   * grows toward whichever end was written and evicts the far LRU end when the
   * budget is exceeded.
   */
  append(
    colSeq: number,
    _epoch: number,
    bid: Float32Array,
    ask: Float32Array | null,
    rows: number,
  ): void {
    if (rows !== this.rows) {
      throw new Error(`flowmap/tileRing: append rows ${rows} ≠ ring rows ${this.rows}`);
    }
    if (bid.length !== rows) {
      throw new Error(`flowmap/tileRing: bid length ${bid.length} ≠ rows ${rows}`);
    }
    if (ask !== null && ask.length !== rows) {
      throw new Error(`flowmap/tileRing: ask length ${ask.length} ≠ rows ${rows}`);
    }

    // Interleave into RG order [bid0, ask0, bid1, ask1, ...].
    const rg = this.scratch;
    if (ask !== null) {
      for (let r = 0; r < rows; r++) {
        rg[r * 2] = bid[r];
        rg[r * 2 + 1] = ask[r];
      }
    } else {
      for (let r = 0; r < rows; r++) {
        rg[r * 2] = bid[r];
        rg[r * 2 + 1] = 0;
      }
    }

    const { layer, x } = this.locate(colSeq);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      x, // xoffset — column within the tile
      0, // yoffset — full height
      layer, // zoffset — tile layer
      1, // width: one column
      rows, // height: all rows
      1, // depth: one layer
      gl.RG,
      gl.FLOAT,
      rg,
    );
    checkGLError(gl, 'TileRing.append');

    this.residency.note(colSeq);
  }

  /** Absolute colSeq range currently resident full-res (null before any append). */
  residentRange(): ResidentRange | null {
    return this.residency.range();
  }

  /** Whether `colSeq` is currently resident full-res (in the tile texture). */
  isResidentFullRes(colSeq: number): boolean {
    return this.residency.isResident(colSeq);
  }

  /** Full-res residency budget in columns (== ring capacity). */
  get budgetCols(): number {
    return this.capacityCols;
  }

  /** Full-res GPU bytes this ring holds (§10 memory gate): cap·rows·RG16F(4 B). */
  fullResBytes(): number {
    return this.capacityCols * this.rows * 4;
  }

  /** LRU tile-layer order (oldest-touched first). Diagnostics. */
  lruLayerOrder(): number[] {
    return this.residency.lruLayerOrder();
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}
