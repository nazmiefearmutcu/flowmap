/**
 * Price↔row scale (§8.1) — the map between a grid row and a price.
 *
 * Until now this was a single LINEAR affine, `price = p0 + row·step`, inlined at
 * every consumer. That is fine for a narrow grid, but it makes range and
 * resolution the SAME knob: over a fixed row count, covering −99%/+1000% of a
 * $60k mid forces ~$322 per row, at which the live book collapses into a couple
 * of rows and the chart stops being a trading view.
 *
 * This module adds a second scale kind that breaks that tie:
 *
 *   rows [0, dnRows)                 lower LOG wing  — geometric, loPrice → coreLo
 *   rows [dnRows, dnRows+coreRows)   linear CORE     — coreP0 + (row−dnRows)·coreStep
 *   rows [dnRows+coreRows, rows)     upper LOG wing  — geometric, coreHi → hiPrice
 *
 * continuous at both joins. The point is that resolution is spent where it is
 * read: with rows=4096 and coreRows=2048 on BTC at $60k with a $0.50 tick, the
 * CORE is ±0.853% at $0.50/row — byte-for-byte the resolution AND coverage of
 * today's narrow grid — while the remaining 2048 rows reach −99%/+1000% at
 * ~0.34%/row. Nothing is lost near the money; the far field is gained.
 *
 * **The renderer does not care.** The WebGL fragment shader works purely in ROW
 * space (col/row → texel → LUT), so a non-uniform row height costs it nothing
 * and the O(1)-in-history no-re-raster invariant is untouched. Only the CPU-side
 * price↔row mapping changes.
 *
 * **Linear stays linear.** `kind: 'linear'` is the current arithmetic verbatim,
 * so the default band is bit-identical to before. Everything here is pure, so
 * both branches are unit-testable with no GL context and no feed.
 */

/** The linear affine — today's grid, unchanged. */
export interface LinearScale {
  kind: 'linear';
  /** Price at row 0. */
  p0: number;
  /** Price per row (`tick · tick_multiple`). */
  step: number;
  /** Grid height. */
  rows: number;
}

/** Log wing / linear core / log wing. */
export interface HybridScale {
  kind: 'hybrid';
  /** Grid height. */
  rows: number;
  /** Rows in the lower log wing: `[0, dnRows)`. May be 0 (no lower wing). */
  dnRows: number;
  /** Rows in the linear core: `[dnRows, dnRows + coreRows)`. Must be ≥ 1. */
  coreRows: number;
  /** Price at row `dnRows` — the bottom of the core. */
  coreP0: number;
  /** Price per row inside the core. */
  coreStep: number;
  /** Price at row 0 (the bottom of the lower wing). Must be > 0. */
  loPrice: number;
  /** Price at row `rows` (the top of the upper wing). */
  hiPrice: number;
}

export type PriceScale = LinearScale | HybridScale;

/** Top of the linear core (price at row `dnRows + coreRows`). */
export function coreHiPrice(s: HybridScale): number {
  return s.coreP0 + s.coreRows * s.coreStep;
}

/** Rows in the upper log wing. May be 0 (no upper wing). */
export function upperRows(s: HybridScale): number {
  return Math.max(0, s.rows - s.dnRows - s.coreRows);
}

/**
 * Whether a hybrid scale is well-formed. A malformed one (a non-positive
 * `loPrice`, an inverted wing, a zero core) would produce NaN or a
 * non-monotone map, which would silently scatter liquidity across the grid —
 * so callers degrade to the linear branch instead of trusting it.
 */
export function isUsableHybrid(s: HybridScale): boolean {
  const hi = coreHiPrice(s);
  return (
    Number.isFinite(s.loPrice) &&
    s.loPrice > 0 &&
    Number.isFinite(s.coreP0) &&
    Number.isFinite(s.coreStep) &&
    s.coreStep > 0 &&
    s.coreRows >= 1 &&
    s.dnRows >= 0 &&
    s.rows >= s.dnRows + s.coreRows &&
    s.coreP0 > s.loPrice &&
    (upperRows(s) === 0 || (Number.isFinite(s.hiPrice) && s.hiPrice > hi))
  );
}

/**
 * Price at a (fractional) row. Total and monotonically increasing across the
 * whole domain, including outside `[0, rows]` — the camera can overscroll a full
 * viewport past either edge, and the axis must keep labelling sanely there, so
 * both wings EXTRAPOLATE geometrically rather than clamping.
 */
export function rowToPrice(s: PriceScale, row: number): number {
  if (s.kind === 'linear') return s.p0 + row * s.step;
  if (!isUsableHybrid(s)) return Number.NaN;

  const coreLo = s.coreP0;
  const coreHi = coreHiPrice(s);
  const coreEnd = s.dnRows + s.coreRows;

  if (row >= s.dnRows && row <= coreEnd) {
    return coreLo + (row - s.dnRows) * s.coreStep;
  }
  if (row < s.dnRows) {
    // Lower wing (and below it): geometric from loPrice at row 0 to coreLo at
    // row dnRows. With no lower wing, extrapolate the core's own ratio instead
    // of dividing by zero.
    if (s.dnRows <= 0) return coreLo * Math.exp((row - s.dnRows) * (s.coreStep / coreLo));
    return coreLo * Math.exp(((row - s.dnRows) / s.dnRows) * Math.log(coreLo / s.loPrice));
  }
  const up = upperRows(s);
  if (up <= 0) return coreHi * Math.exp((row - coreEnd) * (s.coreStep / coreHi));
  return coreHi * Math.exp(((row - coreEnd) / up) * Math.log(s.hiPrice / coreHi));
}

/**
 * Row carrying a price — the exact inverse of {@link rowToPrice}. Returns NaN
 * for a non-positive price on a hybrid scale (log space has no zero), which
 * callers must treat as "off the grid" rather than coercing to row 0.
 */
export function priceToRow(s: PriceScale, price: number): number {
  if (s.kind === 'linear') return s.step === 0 ? Number.NaN : (price - s.p0) / s.step;
  if (!isUsableHybrid(s)) return Number.NaN;
  if (!(price > 0)) return Number.NaN;

  const coreLo = s.coreP0;
  const coreHi = coreHiPrice(s);
  const coreEnd = s.dnRows + s.coreRows;

  if (price >= coreLo && price <= coreHi) {
    return s.dnRows + (price - coreLo) / s.coreStep;
  }
  if (price < coreLo) {
    if (s.dnRows <= 0) return s.dnRows + (coreLo / s.coreStep) * Math.log(price / coreLo);
    return s.dnRows * (1 + Math.log(price / coreLo) / Math.log(coreLo / s.loPrice));
  }
  const up = upperRows(s);
  if (up <= 0) return coreEnd + (coreHi / s.coreStep) * Math.log(price / coreHi);
  return coreEnd + up * (Math.log(price / coreHi) / Math.log(s.hiPrice / coreHi));
}

/**
 * LOCAL price height of one row at `row` — what a "tick" is worth there.
 *
 * Constant on a linear scale; on a hybrid one it grows geometrically through the
 * wings. Every consumer that used to reach for `step` to decide tick decimals,
 * a DOM rung's price width, or a profile bin's price extent must use this
 * instead: under a hybrid scale those quantities are genuinely position
 * dependent, and using the core's step everywhere would mislabel the wings.
 */
export function stepAtRow(s: PriceScale, row: number): number {
  if (s.kind === 'linear') return s.step;
  if (!isUsableHybrid(s)) return Number.NaN;
  return rowToPrice(s, row + 0.5) - rowToPrice(s, row - 0.5);
}

/** Parameters for {@link makeHybrid}. */
export interface HybridSpec {
  /** Reference price the core is centred on. */
  mid: number;
  /** Grid height. */
  rows: number;
  /** Rows given to the linear core. */
  coreRows: number;
  /** Price per row inside the core (the instrument's native `tick·multiple`). */
  coreStep: number;
  /** Top of coverage as a multiple of mid (11 = +1000%). */
  upMult: number;
  /** Bottom of coverage as a fraction of mid (0.01 = −99%). Must be > 0. */
  dnFloor: number;
}

/**
 * Build a hybrid scale centred on `mid`.
 *
 * The core is placed symmetrically around `mid` at the instrument's native step,
 * and the leftover rows are split between the wings IN PROPORTION TO THEIR LOG
 * SPAN, so both wings end up with the same percentage height per row — a 1% move
 * looks the same above and below. Returns `null` when the request is degenerate
 * (non-finite mid, no rows left for the wings, a floor at or above the core),
 * so the caller can fall back to the linear grid rather than ship a broken map.
 */
export function makeHybrid(spec: HybridSpec): HybridScale | null {
  const { mid, rows, coreRows, coreStep, upMult, dnFloor } = spec;
  if (!Number.isFinite(mid) || mid <= 0) return null;
  if (!Number.isFinite(coreStep) || coreStep <= 0) return null;
  if (!(rows > coreRows) || coreRows < 1) return null;
  if (!(upMult > 1) || !(dnFloor > 0) || dnFloor >= 1) return null;

  const coreSpan = coreRows * coreStep;
  const coreP0 = mid - coreSpan / 2;
  const coreHi = coreP0 + coreSpan;
  const loPrice = mid * dnFloor;
  const hiPrice = mid * upMult;
  // The wings must actually be wings: the core has to sit strictly inside the
  // requested band, else the band is narrower than the core and hybrid is the
  // wrong tool (the caller should just use the linear grid).
  if (!(loPrice > 0) || loPrice >= coreP0 || hiPrice <= coreHi) return null;

  const logDn = Math.log(coreP0 / loPrice);
  const logUp = Math.log(hiPrice / coreHi);
  if (!(logDn > 0) || !(logUp > 0)) return null;

  const wing = rows - coreRows;
  let dnRows = Math.round((wing * logDn) / (logDn + logUp));
  dnRows = Math.min(wing - 1, Math.max(1, dnRows));

  const scale: HybridScale = {
    kind: 'hybrid',
    rows,
    dnRows,
    coreRows,
    coreP0,
    coreStep,
    loPrice,
    hiPrice,
  };
  return isUsableHybrid(scale) ? scale : null;
}

/**
 * Minimal structural view of the wire's epoch geometry — declared here rather
 * than imported so this module stays free of the proto layer and testable in
 * isolation.
 */
export interface EpochScaleFields {
  tick: number;
  tick_multiple: number;
  p0: number;
  rows: number;
  scale_kind?: number;
  dn_rows?: number;
  core_rows?: number;
  core_p0?: number;
  core_step?: number;
  lo_price?: number;
  hi_price?: number;
}

/** Wire discriminator for the hybrid scale (mirrors the server's SCALE_HYBRID). */
export const SCALE_KIND_HYBRID = 1;

/**
 * The scale an epoch denotes — the SINGLE place the compatibility rule lives.
 *
 * An epoch whose `scale_kind` is 0, absent, or a kind this build does not know
 * decodes to the legacy affine. That is what lets a newer server talk to an
 * older client without it silently mis-reading a piecewise grid as a uniform
 * one, and it is why a hybrid only ever ships under a band an old client would
 * never request. A hybrid frame that fails {@link isUsableHybrid} — a garbage
 * `loPrice`, an inverted wing — falls back the same way rather than producing a
 * non-monotone map that would scatter liquidity across the grid.
 */
export function scaleFromEpoch(ep: EpochScaleFields): PriceScale {
  const linear: LinearScale = {
    kind: 'linear',
    p0: ep.p0,
    step: ep.tick * ep.tick_multiple,
    rows: ep.rows,
  };
  if (ep.scale_kind !== SCALE_KIND_HYBRID) return linear;
  const hybrid: HybridScale = {
    kind: 'hybrid',
    rows: ep.rows,
    dnRows: ep.dn_rows ?? 0,
    coreRows: ep.core_rows ?? 0,
    coreP0: ep.core_p0 ?? 0,
    coreStep: ep.core_step ?? 0,
    loPrice: ep.lo_price ?? 0,
    hiPrice: ep.hi_price ?? 0,
  };
  return isUsableHybrid(hybrid) ? hybrid : linear;
}
