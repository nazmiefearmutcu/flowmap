/**
 * The density tile ring (§8.3 storage).
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
 * Appending sequence `s` after the ring is full reuses the slot last held by
 * `s - capacityCols`, which is exactly the oldest resident column — so the ring
 * self-evicts oldest-first with no bookkeeping. Deep-scroll backfill / LRU
 * across multiple rings is T8; this is the fixed-size live ring.
 *
 * Per-epoch row transform seam: columns carry an `epoch`, and different epochs
 * map a given row index to different prices (§8.2). This ring stores raw
 * densities only and is epoch-agnostic; the row→price affine is a per-draw
 * uniform (see Heatmap). T6/T8 batch one draw per visible epoch. This task
 * assumes a single epoch and records the appended epoch for a future assertion
 * hook, but does not partition storage by epoch.
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

export class TileRing {
  readonly gl: WebGL2RenderingContext;
  readonly rows: number;
  readonly layers: number;
  readonly colsPerTile = COLS_PER_TILE;
  /** Total columns the ring can hold before it wraps. */
  readonly capacityCols: number;
  readonly texture: WebGLTexture;

  private firstSeq = -1;
  private lastSeq = -1;
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
   * converts to f16 on upload into RG16F. Non-monotonic colSeq is allowed (the
   * ring maps by absolute index) but resident-range tracking assumes forward
   * appends in the live path.
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

    if (this.firstSeq < 0) this.firstSeq = colSeq;
    if (colSeq > this.lastSeq) this.lastSeq = colSeq;
    if (colSeq < this.firstSeq) this.firstSeq = colSeq;
  }

  /** Absolute colSeq range currently resident (null before any append). */
  residentRange(): ResidentRange | null {
    if (this.lastSeq < 0) return null;
    const oldest = Math.max(this.firstSeq, this.lastSeq - this.capacityCols + 1);
    return { oldest, newest: this.lastSeq, count: this.lastSeq - oldest + 1 };
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}
