/**
 * Viewport-percentile normalization (§8.3, M2 T9).
 *
 * The heatmap's contrast must normalize to the VISIBLE window, not the live edge.
 * If you pan into an overnight, low-liquidity region it should renormalize so the
 * (dimmer) structure there stays visible — instead of staying scaled to the
 * brighter live edge and rendering the old region as near-black.
 *
 * Mechanism (all CPU, all O(tiles-in-view) — never O(history)):
 *
 *   1. A coarse **per-tile 256-bin histogram** of NON-ZERO density is maintained
 *      incrementally as columns are appended/backfilled. One tile = one
 *      `colsPerTile`-wide block of columns (the tile-array layer the ring uses),
 *      keyed by ABSOLUTE tile index `floor(colSeq/colsPerTile)`. Bins are
 *      **logarithmic** — order-flow density is heavy-tailed (a handful of walls
 *      dwarf the ladder), so log bins spend resolution where the mass is and a
 *      p99 lands on a meaningful bin instead of saturating the top linear bin.
 *
 *   2. On pan/zoom (or every dirty frame) the tiles covering the visible column
 *      range have their histograms **summed** (a few × 256 adds, <1 ms) and the
 *      configured percentile (p99 by default) is read off the merged CDF with
 *      in-bin log interpolation. This is `O(tiles in view)`, not `O(columns)`:
 *      the merge touches ~`colSpan/colsPerTile` histograms regardless of how many
 *      columns those tiles hold.
 *
 *   3. The raw percentile is **EMA-smoothed** frame-to-frame (~0.3 s settle at
 *      60 fps) so the divisor glides into a new regime instead of flickering.
 *      `Hello.norm_seed` seeds frame 0.
 *
 *   4. **Mip coordination (the T7 seam).** Level-L mip texels SUM a 4^L×4^L block,
 *      so a naive normalization would have to multiply the percentile by the sum
 *      factor `4^L` to keep a coarser level's brighter texels inside [0,1]. BUT
 *      the T7 heatmap fragment shader already folds the *wall-preserving* `1/4^L`
 *      (`/blk`) back out of `intensity` BEFORE dividing by `u_norm`
 *      (`intensity = (accR+accG)*decodeScale/blk`). The sum factor and T7's
 *      rescale therefore CANCEL: the level-0 density percentile is already on the
 *      shader's per-pixel intensity scale for the dominant (p99, wall-like)
 *      structure, so the net mip scaling applied here is **unity**. Multiplying by
 *      `4^L` on top of T7's `1/4^L` would double-apply and make walls vanish on
 *      zoom-out — the exact bug the SUM-mip exists to prevent. See
 *      {@link mipSumFactor} / {@link t7ShaderRescale} / {@link normMipScale}: the
 *      `mipLevel` argument is honored, the two factors are made explicit, and
 *      their product is 1.
 *
 * The class is PURE CPU with no GL — histogram merge, percentile, EMA and tile
 * eviction are all unit-testable without a WebGL context (see normalize.test.ts).
 */

export const DEFAULT_BINS = 256;
export const DEFAULT_PERCENTILE = 99;
/** Log-bin range low edge (density below this clamps into bin 0). */
export const DEFAULT_HIST_MIN = 1 / 64; // 0.015625
/** Log-bin range high edge (density above this clamps into the top bin). */
export const DEFAULT_HIST_MAX = 65536; // f16 territory; walls sit well below
/** Per-call EMA weight on the fresh percentile (~90% settle in ~15 calls ≈ 0.25 s @60fps). */
export const DEFAULT_EMA_ALPHA = 0.15;
/** Floor on the returned norm so a tiny seed / empty viewport can't blow out intensity. */
export const DEFAULT_NORM_FLOOR = 4;
/** Default cap on retained per-tile histograms (≥ ring layers + margin). */
export const DEFAULT_MAX_TILES = 128;
/** EMA is "settled" once |raw − ema| ≤ this fraction of ema (drives redraw-until-settled). */
const SETTLE_EPS = 0.02;

export interface ColRange {
  /** Oldest visible absolute col_seq (inclusive). */
  oldest: number;
  /** Newest visible absolute col_seq (inclusive). */
  newest: number;
}

export interface RowRange {
  /** Lowest visible row (inclusive). */
  lo: number;
  /** Highest visible row (inclusive). */
  hi: number;
}

export interface NormalizeConfig {
  bins?: number;
  percentile?: number;
  colsPerTile?: number;
  histMin?: number;
  histMax?: number;
  emaAlpha?: number;
  floor?: number;
  maxTiles?: number;
}

/** The SUM-mip sum factor for level L: level-L texels sum a 4^L×4^L block. */
export function mipSumFactor(level: number): number {
  return 4 ** Math.max(0, Math.floor(level));
}

/**
 * The rescale T7's heatmap shader already folds into `intensity` (`/blk` where
 * blk = 4^L), reduced from the spec's naive `1/16^L` to the wall-preserving
 * `1/4^L`. This is DONE IN THE SHADER, not here — exposed so the coordination is
 * explicit and checkable.
 */
export function t7ShaderRescale(level: number): number {
  return 1 / mipSumFactor(level);
}

/**
 * Net mip scaling applied to the viewport percentile so it lands on the shader's
 * per-pixel intensity scale. Equals `mipSumFactor(L) × t7ShaderRescale(L) === 1`
 * for every L: the sum factor is exactly cancelled by T7's in-shader `/4^L`
 * (§8.3 "fold the block rescale into normalization", coordinated so it is NOT
 * double-applied). Kept as a function so a future averaging-mip convention has a
 * single place to reintroduce a real factor.
 */
export function normMipScale(level: number): number {
  return mipSumFactor(level) * t7ShaderRescale(level);
}

export class ViewportNormalizer {
  readonly bins: number;
  readonly percentile: number;
  readonly colsPerTile: number;
  readonly floor: number;
  readonly alpha: number;
  readonly maxTiles: number;

  private readonly logMin: number;
  private readonly logMax: number;
  private readonly binScale: number; // bins / (logMax - logMin)

  /** Absolute tile index → 256-bin non-zero-density histogram. */
  private readonly tiles = new Map<number, Int32Array>();
  /** Scratch merge accumulator (reused; never leaks between calls). */
  private readonly merged: Int32Array;

  private ema = 0;
  private seeded = false;
  /** Last raw viewport percentile computed (pre-EMA); for the settle test. */
  private lastRaw = 0;

  constructor(cfg: NormalizeConfig = {}) {
    this.bins = cfg.bins ?? DEFAULT_BINS;
    this.percentile = cfg.percentile ?? DEFAULT_PERCENTILE;
    this.colsPerTile = cfg.colsPerTile ?? 256;
    this.floor = cfg.floor ?? DEFAULT_NORM_FLOOR;
    this.alpha = cfg.emaAlpha ?? DEFAULT_EMA_ALPHA;
    this.maxTiles = cfg.maxTiles ?? DEFAULT_MAX_TILES;

    const histMin = cfg.histMin ?? DEFAULT_HIST_MIN;
    const histMax = cfg.histMax ?? DEFAULT_HIST_MAX;
    this.logMin = Math.log(histMin);
    this.logMax = Math.log(histMax);
    this.binScale = this.bins / (this.logMax - this.logMin);
    this.merged = new Int32Array(this.bins);
  }

  /** Seed the EMA (frame 0) from `Hello.norm_seed`. Floored, no-op if ≤0. */
  seed(norm: number): void {
    if (!(norm > 0)) return;
    this.ema = Math.max(norm, this.floor);
    this.lastRaw = this.ema;
    this.seeded = true;
  }

  /** Whether any non-zero density has been binned (else the seed/floor holds). */
  hasData(): boolean {
    return this.tiles.size > 0;
  }

  /** Number of per-tile histograms currently retained (bounded ≤ maxTiles). */
  get retainedTiles(): number {
    return this.tiles.size;
  }

  /** Current EMA-smoothed norm (what was last fed to `u_norm`), floored. */
  get current(): number {
    return Math.max(this.ema, this.floor);
  }

  /** Map a strictly-positive density to a log bin index in [0, bins-1]. */
  private binOf(v: number): number {
    const idx = Math.floor((Math.log(v) - this.logMin) * this.binScale);
    return idx < 0 ? 0 : idx >= this.bins ? this.bins - 1 : idx;
  }

  /** Absolute tile index for an absolute col_seq. */
  private tileOf(colSeq: number): number {
    return Math.floor(colSeq / this.colsPerTile);
  }

  /**
   * Fold one column's NON-ZERO densities (bid, and ask when present) into its
   * tile histogram. Called for every appended / spliced column — O(rows), a
   * handful per second live. Zeros are skipped so the distribution reflects
   * active price levels only (which also makes the visible row range moot at
   * tile granularity: empty rows never enter the histogram).
   */
  addColumn(colSeq: number, bid: Float32Array, ask: Float32Array | null): void {
    const tile = this.tileOf(colSeq);
    let hist = this.tiles.get(tile);
    if (hist === undefined) {
      this.evictIfFull(tile);
      hist = new Int32Array(this.bins);
      this.tiles.set(tile, hist);
    }
    const n = bid.length;
    for (let r = 0; r < n; r++) {
      const b = bid[r];
      if (b > 0) hist[this.binOf(b)]++;
      if (ask !== null) {
        const a = ask[r];
        if (a > 0) hist[this.binOf(a)]++;
      }
    }
  }

  /** Evict the retained tile farthest from `nearTile` when the cap is reached. */
  private evictIfFull(nearTile: number): void {
    if (this.tiles.size < this.maxTiles) return;
    let victim = -1;
    let bestDist = -1;
    for (const t of this.tiles.keys()) {
      const d = Math.abs(t - nearTile);
      if (d > bestDist) {
        bestDist = d;
        victim = t;
      }
    }
    if (victim >= 0) this.tiles.delete(victim);
  }

  /**
   * RAW merged viewport percentile (no EMA), already multiplied by the mip
   * scaling ({@link normMipScale}, = 1). Sums the histograms of every retained
   * tile that overlaps `[col.oldest, col.newest]` and reads the percentile off
   * the merged CDF with in-bin log interpolation. `O(tiles in view)`.
   *
   * `row` is accepted per the T9 contract but NOT used to sub-filter: the coarse
   * per-tile histograms are deliberately not row-partitioned (that would cost
   * O(rows) storage per tile and break the O(tiles) budget), and non-zero-only
   * binning already restricts the distribution to the active price band.
   */
  viewportPercentile(col: ColRange, _row: RowRange, mipLevel: number): number {
    const merged = this.merged;
    merged.fill(0);
    let total = 0;
    const tLo = this.tileOf(col.oldest);
    const tHi = this.tileOf(col.newest);
    for (let t = tLo; t <= tHi; t++) {
      const hist = this.tiles.get(t);
      if (hist === undefined) continue;
      for (let b = 0; b < this.bins; b++) {
        const c = hist[b];
        if (c !== 0) {
          merged[b] += c;
          total += c;
        }
      }
    }
    if (total === 0) return Math.max(this.ema, this.floor);

    const rank = (this.percentile / 100) * total;
    let cum = 0;
    let bin = this.bins - 1;
    for (let b = 0; b < this.bins; b++) {
      const next = cum + merged[b];
      if (next >= rank) {
        bin = b;
        // Fraction through this bin's count where the rank falls.
        const inBin = merged[b] > 0 ? (rank - cum) / merged[b] : 0;
        const logv = this.logMin + (bin + inBin) / this.binScale;
        return Math.max(Math.exp(logv), this.floor) * normMipScale(mipLevel);
      }
      cum = next;
    }
    const logv = this.logMin + (bin + 1) / this.binScale;
    return Math.max(Math.exp(logv), this.floor) * normMipScale(mipLevel);
  }

  /**
   * Recompute the raw viewport percentile and EMA-step toward it, returning the
   * smoothed, floored norm to feed `u_norm`. Call once per dirty frame (or on
   * view-settle). O(tiles in view).
   */
  updateNorm(col: ColRange, row: RowRange, mipLevel: number): number {
    const raw = this.viewportPercentile(col, row, mipLevel);
    this.lastRaw = raw;
    if (!this.seeded) {
      this.ema = raw;
      this.seeded = true;
    } else {
      this.ema += this.alpha * (raw - this.ema);
    }
    return Math.max(this.ema, this.floor);
  }

  /** Whether the EMA has essentially reached the last raw target (settle gate). */
  get settled(): boolean {
    const denom = Math.max(this.ema, this.floor);
    return Math.abs(this.lastRaw - this.ema) <= SETTLE_EPS * denom;
  }

  reset(): void {
    this.tiles.clear();
    this.merged.fill(0);
    this.ema = 0;
    this.lastRaw = 0;
    this.seeded = false;
  }
}
