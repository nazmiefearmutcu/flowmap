/**
 * Per-REGION black-point support (lane F17; D5 lever L1, owner's scrollback
 * complaint 2026-09-13/14).
 *
 * The owner-visible problem (measured in `swarm2/D5.md`): one GLOBAL tolerance
 * floor is calibrated on the LIVE book, but the reconstructed (stretched
 * 1 m-candle) columns carry a different density scale — BTC recon sits at
 * ≈0.5× live (the floor hides it) while ETH recon sits at ≈26× live. A single
 * t-space floor therefore reads correctly for at most one regime. The fix is a
 * RELATIVE per-region floor: reconstructed columns keep their own floor
 * fraction of the viewport white (the slider floor × {@link
 * DEFAULT_RECON_FLOOR_SCALE}) while live columns keep the EXACT shipped floor —
 * live pixels stay byte-identical because an untagged column resolves to
 * {@link REGION_LIVE}.
 *
 * The region classification itself is a caller concern (the renderer derives
 * it from column cadence / history provenance); this module only stores the
 * per-COLUMN tags in RING-SLOT space (slot = colSeq mod capacity, exactly the
 * TileRing addressing) so the heatmap can upload them as one tiny mask texture.
 * A per-column stamp (the colSeq that wrote the slot) makes stale entries from
 * an evicted/reused ring slot impossible: a tag only counts for the column that
 * wrote it. Everything here is PURE (no GL) and unit-testable.
 */

/** Region kind stored per ring slot: live (the default) or reconstructed. */
export const REGION_LIVE = 0;
export const REGION_RECON = 1;
export type RegionKind = typeof REGION_LIVE | typeof REGION_RECON;

/**
 * Default multiplier applied to the Tolerance slider's floor for reconstructed
 * (tagged) columns — the relative L1 lever. 1 = exactly the live floor (an
 * inert mechanism); 0 = the tol-0 endpoint D5 measured as the coverage ceiling
 * (their depth-rich ETH window: 1.12 → 22.8 % ink). Calibrated on the live
 * stack (swarm2/F17.md, ETH recon 6477–8191, densest 373-col window):
 *   inert 1.05 % · ×0.5 1.21 % · ×0.25 1.33 % · ×0.1 1.39 % · ×0.02 1.44 % ·
 *   ×0 1.46 % · D5 tol0+norm-floor0 reference 1.45 %
 * i.e. 0.1 captures ~95 % of the achievable coverage while still keeping a
 * 10× denoise on the recon carpet. The multiplier is RELATIVE by construction
 * (a fraction of the viewport white in t-space), so the ≈0.5× (BTC) and ≈26×
 * (ETH) recon/live scale differences cannot blow it in either direction.
 */
export const DEFAULT_RECON_FLOOR_SCALE = 0.1;

/**
 * The recon-region floor BEFORE the per-frame row-footprint scaling: the live
 * slider floor × `scale`, clamped to [0, 1). `scale` outside (0, 1] is treated
 * as 1 (inert) so a poisoned setting can never hide MORE than the live floor or
 * invert the remap. Pure; non-finite inputs degrade to the live floor.
 */
export function reconFloorFor(floor: number, scale: number): number {
  const f = Number.isFinite(floor) ? Math.max(0, floor) : 0;
  if (!Number.isFinite(scale)) return f;
  const s = Math.min(1, Math.max(0, scale));
  return f * s;
}

/**
 * Per-column region tags in ring-slot space. Bounded by `capacity` (the
 * TileRing's column capacity); slot reuse is safe via the per-slot colSeq
 * stamp. `revision` increments on EVERY effective change so the heatmap can
 * re-upload its mask texture lazily at the next draw (no per-mark GL calls).
 */
export class RegionTracker {
  readonly capacity: number;
  /** Per-slot tag (`REGION_LIVE` | `REGION_RECON`); slot-indexed like the ring. */
  readonly tags: Uint8Array;
  private readonly stamps: Int32Array;
  private revisionN = 0;
  private reconCount = 0;

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`flowmap/regionFloor: capacity must be > 0 (got ${capacity})`);
    }
    this.capacity = Math.floor(capacity);
    this.tags = new Uint8Array(this.capacity);
    this.stamps = new Int32Array(this.capacity);
    this.stamps.fill(-1);
  }

  /** Bumped on every effective mark/clear (the mask texture is stale until re-read). */
  get revision(): number {
    return this.revisionN;
  }

  /** Columns currently tagged as reconstructed (diagnostics). */
  get reconColumns(): number {
    return this.reconCount;
  }

  /** True when at least one column is tagged reconstructed. */
  get hasRecon(): boolean {
    return this.reconCount > 0;
  }

  private slotOf(colSeq: number): number {
    const cap = this.capacity;
    return ((colSeq % cap) + cap) % cap;
  }

  /**
   * Tag one column. Returns whether anything changed. A slot holding a
   * DIFFERENT column's stamp counts as live until this call claims it (the
   * ring overwrote that column), so the recon counter never drifts.
   */
  mark(colSeq: number, kind: RegionKind): boolean {
    if (!Number.isFinite(colSeq)) return false;
    const c = Math.floor(colSeq);
    const slot = this.slotOf(c);
    // The tag the MASK TEXTURE currently holds for this slot (independent of the
    // stamp): the recon counter tracks tagged SLOTS, because that is what the
    // shader samples — a ring overwrite by a new column only takes effect here
    // (callers mark on every append; see the class docblock).
    const physical = this.tags[slot] as RegionKind;
    if (this.stamps[slot] === c && physical === kind) return false;
    if (physical !== kind) this.reconCount += kind === REGION_RECON ? 1 : -1;
    this.stamps[slot] = c;
    this.tags[slot] = kind;
    this.revisionN++;
    return true;
  }

  /**
   * Tag an inclusive absolute column range. Bounded to `2 × capacity` columns
   * per call (a longer span is a caller bug — the ring can never hold more;
   * the guard keeps a runaway loop impossible). Returns the number of columns
   * whose tag changed.
   */
  markRange(from: number, to: number, kind: RegionKind): number {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
    const lo = Math.floor(Math.min(from, to));
    const hi = Math.floor(Math.max(from, to));
    const span = hi - lo + 1;
    if (span <= 0 || span > this.capacity * 2) return 0;
    let changed = 0;
    for (let c = lo; c <= hi; c++) {
      if (this.mark(c, kind)) changed++;
    }
    return changed;
  }

  /** The tag for an absolute column (stale slots resolve to `REGION_LIVE`). */
  kindAt(colSeq: number): RegionKind {
    if (!Number.isFinite(colSeq)) return REGION_LIVE;
    const slot = this.slotOf(Math.floor(colSeq));
    return this.stamps[slot] === Math.floor(colSeq)
      ? (this.tags[slot] as RegionKind)
      : REGION_LIVE;
  }

  /** Drop every tag (session reset / symbol switch). */
  clear(): void {
    this.stamps.fill(-1);
    this.tags.fill(REGION_LIVE);
    if (this.reconCount !== 0) this.reconCount = 0;
    this.revisionN++;
  }
}
