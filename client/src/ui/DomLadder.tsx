/**
 * DOM ladder panel (§9 right rail, M2 T11).
 *
 * Price rungs centered on the mid, each rung showing bid size (left) and ask size
 * (right) with a horizontal size bar (teal bid / red ask) whose length ∝ size. The
 * data source is capability-driven and HONEST (§7) — the badge shows the real tier
 * and the panel never fabricates bid/ask it does not have:
 *
 * The badge (honesty tier) and the layout SHAPE are decoupled ({@link depthTier}
 * vs {@link ladderShape}): the badge names provenance, the shape follows the book
 * the feed sends.
 *
 *   - depth L2    → the real multi-level book: the newest DepthColumn's bid/ask
 *                   density arrays, rows→prices via the epoch geometry, the N rungs
 *                   around the mid. Best bid/ask rows highlighted. Badge `L2`.
 *   - depth L1    → keyed Alpaca top-of-book: a two-sided book (or the BBO as a
 *                   one-level ladder before the first book). Badge `L1`.
 *   - depth SYNTH → the two-sided synthetic volume-at-price depth (bid below / ask
 *                   above the reference price) renders as a real bid/ask book;
 *                   a legacy one-sided SYNTH_PROFILE mode still renders a centered
 *                   profile. Either way, badge `SYNTH` — honest provenance.
 *
 * For M2 (sim + crypto) it is always L2. The sim feed emits NO BBO, so the mid and
 * best bid/ask are DERIVED from the book's density arrays; when a BBO is present
 * (crypto) it is preferred. Auto-scroll keeps the mid centered; a lock toggle
 * freezes the center so the user can read a level while the market moves.
 *
 * High-frequency updates come off the module-scoped {@link bookStore} at ~10 Hz
 * (NOT per column), so the panel stays off the React high-frequency path and never
 * fights the GL loop. Epoch geometry + capability are low-frequency store state.
 */

import { useEffect, useRef, useState } from 'react';

import {
  MODE_L1_BAND,
  MODE_L2,
  MODE_SYNTH_PROFILE,
  type EpochParams,
} from '../proto/types';
import { subscribe, getSnapshot, type BookSnapshot } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';

/** Row height in CSS px — must match `.ladder__row` height in App.css. */
const ROW_H = 17;
const DEFAULT_LADDER_ROWS = 21;
/** Density below this is treated as an empty book level (f16 residue floor). */
const DENSITY_EPS = 1e-6;

export type DepthTier = 'L2' | 'L1' | 'SYNTH';

export interface LadderRowVM {
  row: number;
  price: number;
  bidSz: number;
  askSz: number;
  bidPct: number;
  askPct: number;
  profileSz: number;
  profilePct: number;
  isBestBid: boolean;
  isBestAsk: boolean;
}

export interface LadderModel {
  rows: LadderRowVM[];
  priceDecimals: number;
  /** Fractional mid row (live), or null when it cannot be derived. */
  midRow: number | null;
  /**
   * Best-ask − best-bid in price units, or null when only one side genuinely
   * exists (L1/one-sided) — never fabricated from a synthesized opposite side.
   */
  spread: number | null;
}

/** Map the capability depth tier (falling back to the book mode) to a badge tier. */
export function depthTier(
  capability: Record<string, unknown> | null,
  bookMode: number | null,
): DepthTier | null {
  const d = capability?.depth;
  if (typeof d === 'string') {
    if (d === 'L2') return 'L2';
    if (d === 'L1_BAND' || d === 'L1') return 'L1';
    if (d === 'SYNTH' || d === 'SYNTH_PROFILE') return 'SYNTH';
  }
  if (bookMode === MODE_L2) return 'L2';
  if (bookMode === MODE_L1_BAND) return 'L1';
  if (bookMode === MODE_SYNTH_PROFILE) return 'SYNTH';
  return null;
}

/**
 * How to LAY OUT the rungs — decoupled from the honesty {@link DepthTier} badge.
 * The badge names the data's provenance (`SYNTH` stays `SYNTH`); the shape is
 * driven by the book the feed actually sends:
 *   - `profile` — a one-sided density (legacy bid-only SYNTH_PROFILE mode):
 *     centered volume-at-price bars, no bid/ask split.
 *   - `l1`      — an L1 tier with a BBO: the two BBO rungs, others blank.
 *   - `book`    — any two-sided density (real L2, keyed L1 band, OR the new
 *     two-sided synthetic depth): per-row bid/ask from the density arrays.
 * So a two-sided synthetic book renders like a real book while still badged
 * `SYNTH` — honest provenance, honest shape, no fabricated levels.
 */
export type LadderShape = 'profile' | 'l1' | 'book';

export function ladderShape(tier: DepthTier | null, bookMode: number | null): LadderShape {
  if (bookMode === MODE_SYNTH_PROFILE) return 'profile';
  if (tier === 'L1' && bookMode === null) return 'l1';
  return 'book';
}

/** Decimal places implied by the price step (tick·multiple). */
export function priceDecimals(step: number): number {
  if (!(step > 0)) return 2;
  return Math.min(8, Math.max(0, Math.ceil(-Math.log10(step))));
}

function clampRow(r: number, rows: number): number {
  if (r < 0) return 0;
  if (r > rows - 1) return rows - 1;
  return r;
}

/**
 * Best bid/ask rows + fractional mid row. Prefers the BBO (crypto); else derives
 * from the book density arrays (the sim path): best bid = highest nonzero bid row,
 * best ask = lowest nonzero ask row. For a SYNTH profile (no ask) the center is the
 * point-of-control (max-density) row.
 */
function deriveQuotes(
  snap: BookSnapshot,
  params: EpochParams,
  shape: LadderShape,
): { bestBidRow: number; bestAskRow: number; midRow: number | null; spread: number | null } {
  const step = params.tick * params.tick_multiple;
  const rows = params.rows;
  const bbo = snap.bbo;
  if (bbo && shape !== 'profile') {
    const bestBidRow = clampRow(Math.round((bbo.bidPx - params.p0) / step), rows);
    const bestAskRow = clampRow(Math.round((bbo.askPx - params.p0) / step), rows);
    const midRow = ((bbo.bidPx + bbo.askPx) / 2 - params.p0) / step;
    // Both sides of a BBO are real — honest spread from the quoted prices.
    return { bestBidRow, bestAskRow, midRow, spread: bbo.askPx - bbo.bidPx };
  }
  const book = snap.book;
  if (book === null) return { bestBidRow: -1, bestAskRow: -1, midRow: null, spread: null };

  if (shape === 'profile') {
    // Point-of-control: the densest row of the volume-at-price profile.
    let pocRow = -1;
    let pocVal = DENSITY_EPS;
    for (let r = 0; r < book.bid.length; r += 1) {
      if (book.bid[r] > pocVal) {
        pocVal = book.bid[r];
        pocRow = r;
      }
    }
    return { bestBidRow: -1, bestAskRow: -1, midRow: pocRow >= 0 ? pocRow : null, spread: null };
  }

  let bestBidRow = -1;
  for (let r = book.bid.length - 1; r >= 0; r -= 1) {
    if (book.bid[r] > DENSITY_EPS) {
      bestBidRow = r;
      break;
    }
  }
  let bestAskRow = -1;
  const ask = book.ask;
  if (ask) {
    for (let r = 0; r < ask.length; r += 1) {
      if (ask[r] > DENSITY_EPS) {
        bestAskRow = r;
        break;
      }
    }
  }
  // Spread only when BOTH sides genuinely exist — never from a synthesized side.
  const spread = bestBidRow >= 0 && bestAskRow >= 0 ? (bestAskRow - bestBidRow) * step : null;
  if (bestBidRow < 0 && bestAskRow < 0) {
    return { bestBidRow: -1, bestAskRow: -1, midRow: null, spread: null };
  }
  if (bestBidRow < 0) bestBidRow = bestAskRow - 1;
  if (bestAskRow < 0) bestAskRow = bestBidRow + 1;
  if (bestAskRow <= bestBidRow) bestAskRow = bestBidRow + 1;
  return { bestBidRow, bestAskRow, midRow: (bestBidRow + bestAskRow) / 2, spread };
}

/**
 * Pure ladder model for a snapshot. `centerOverride` (the locked center) pins the
 * window; when null the window auto-centers on the live mid. Returns `visRows`
 * rungs top-to-bottom (highest price first).
 */
export function buildLadder(
  snap: BookSnapshot,
  params: EpochParams | undefined,
  shape: LadderShape,
  visRows: number,
  centerOverride: number | null,
): LadderModel {
  const book = snap.book;
  // A live L1 tier can show its BBO before the first book column arrives — the
  // `l1` shape renders straight from `snap.bbo`, so a null book is fine there.
  const hasL1Bbo = !book && shape === 'l1' && snap.bbo !== null;
  if ((!book && !hasL1Bbo) || !params) {
    return { rows: [], priceDecimals: 2, midRow: null, spread: null };
  }

  const step = params.tick * params.tick_multiple;
  const nrows = params.rows;
  const decimals = priceDecimals(step);
  const { bestBidRow, bestAskRow, midRow, spread } = deriveQuotes(snap, params, shape);

  const center = centerOverride ?? midRow ?? (nrows - 1) / 2;
  const centerInt = Math.round(center);
  const half = Math.floor(Math.max(1, visRows) / 2);

  const out: LadderRowVM[] = [];
  let maxSz = DENSITY_EPS;
  // First pass top→bottom, collecting sizes; scale bars in a second pass.
  for (let r = centerInt + half; r >= centerInt - half; r -= 1) {
    const inRange = r >= 0 && r < nrows;
    let bidSz = 0;
    let askSz = 0;
    let profileSz = 0;
    if (shape === 'profile') {
      profileSz = inRange && book ? book.bid[r] : 0;
    } else if (shape === 'l1') {
      if (snap.bbo && r === bestBidRow) bidSz = snap.bbo.bidSz;
      if (snap.bbo && r === bestAskRow) askSz = snap.bbo.askSz;
    } else {
      // book: real per-row density (L2, keyed L1 band, or two-sided synthetic).
      // `book` is only null for the `l1` shape above, so these branches are
      // unreachable then — the guard keeps the strict `tsc -b` build happy.
      bidSz = inRange && book ? book.bid[r] : 0;
      askSz = inRange && book && book.ask ? book.ask[r] : 0;
    }
    maxSz = Math.max(maxSz, bidSz, askSz, profileSz);
    out.push({
      row: r,
      price: params.p0 + r * step,
      bidSz,
      askSz,
      profileSz,
      bidPct: 0,
      askPct: 0,
      profilePct: 0,
      isBestBid: shape !== 'profile' && r === bestBidRow,
      isBestAsk: shape !== 'profile' && r === bestAskRow,
    });
  }
  // Fractional widths (no rounding) with a 2%-wide floor for any nonzero level,
  // so a sub-1% size never renders a visible number over a 0-width bar.
  for (const row of out) {
    row.bidPct = row.bidSz > 0 ? Math.max(2, (row.bidSz / maxSz) * 100) : 0;
    row.askPct = row.askSz > 0 ? Math.max(2, (row.askSz / maxSz) * 100) : 0;
    row.profilePct = row.profileSz > 0 ? Math.max(2, (row.profileSz / maxSz) * 100) : 0;
  }
  return { rows: out, priceDecimals: decimals, midRow, spread };
}

/** Compact size formatting (matches the crosshair readout). */
export function fmtSz(v: number): string {
  // Never render the raw JS "Infinity"/"NaN" strings: a non-finite density is
  // over-range/unusable (e.g. an upstream f16-overflowed SYNTH volume bucket) —
  // show an honest over-range glyph, not a fabricated number.
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '';
  if (v <= 0) return '';
  if (v >= 1e9) return compact(v, 1e9, 'B');
  if (v >= 1e6) return compact(v, 1e6, 'M');
  if (v >= 1e3) return compact(v, 1e3, 'K');
  if (v >= 100) return v.toFixed(1);
  return v.toFixed(2);
}

/** One-decimal SI-suffixed magnitude, trimming a trailing `.0` (2000→"2K"). */
function compact(v: number, div: number, suffix: string): string {
  const s = (v / div).toFixed(1);
  return (s.endsWith('.0') ? s.slice(0, -2) : s) + suffix;
}

export function DomLadder(): JSX.Element {
  const capability = useFlowMapStore((s) => s.capability);
  const epochs = useFlowMapStore((s) => s.epochs);
  const gridEpoch = useFlowMapStore((s) => s.gridEpoch);
  const symbol = useFlowMapStore((s) => s.subscription?.symbol ?? null);
  const status = useFlowMapStore((s) => s.status);
  const feedState = useFlowMapStore((s) => s.feedState);
  const [snap, setSnap] = useState<BookSnapshot>(() => getSnapshot());
  const [collapsed, setCollapsed] = useState(false);
  const [locked, setLocked] = useState(false);
  const [visRows, setVisRows] = useState(DEFAULT_LADDER_ROWS);
  const bodyRef = useRef<HTMLDivElement>(null);
  const frozenCenterRef = useRef<number | null>(null);

  useEffect(() => subscribe(setSnap), []);

  // Fit the number of rungs to the panel height (odd, so the mid sits centered).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const n = Math.floor(el.clientHeight / ROW_H);
      if (n >= 3) setVisRows(n % 2 === 0 ? n - 1 : n);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const params = snap.book ? epochs.get(snap.book.epoch) : undefined;
  const bookMode = snap.book ? snap.book.mode : null;
  const tier = depthTier(capability, bookMode);
  const shape = ladderShape(tier, bookMode);
  const step = params ? params.tick * params.tick_multiple : 0;
  // The lock pins a PRICE, not a row: re-anchor to a row against the CURRENT
  // epoch each render, so a mid-stream p0/step change keeps the same price
  // centered instead of drifting to a stale row index.
  const centerOverride =
    locked && frozenCenterRef.current !== null && params && step > 0
      ? (frozenCenterRef.current - params.p0) / step
      : null;
  const model = buildLadder(snap, params, shape, visRows, centerOverride);

  // Track the live mid AS A PRICE so locking freezes at the current center.
  useEffect(() => {
    if (!locked && model.midRow !== null && params) {
      frozenCenterRef.current = params.p0 + model.midRow * (params.tick * params.tick_multiple);
    }
  });

  // A grid re-anchor (new epoch geometry) or a symbol switch invalidates any
  // pinned price — drop the lock and return to follow-mid.
  useEffect(() => {
    setLocked(false);
    frozenCenterRef.current = null;
  }, [gridEpoch, symbol]);

  const badge = tier ?? 'N/A';
  // Class-safe token: `tier.toLowerCase()` yields 'l2'/'l1'/'synth' (and 'na'
  // for the no-data case) — never 'n/a', whose slash breaks the CSS selector.
  const badgeClass = tier ? tier.toLowerCase() : 'na';

  const spreadTicks =
    model.spread !== null && params && params.tick > 0
      ? Math.round(model.spread / params.tick)
      : null;
  const emptyMsg =
    feedState === 'closed'
      ? 'market closed'
      : status === 'reconnecting' || status === 'closed'
        ? 'disconnected'
        : status === 'connecting'
          ? 'connecting…'
          : 'waiting for book…';

  return (
    <section
      className={`panel dom-ladder${collapsed ? ' is-collapsed' : ''}${
        tier === 'SYNTH' ? ' dom-ladder--synth' : ''
      }`}
      data-testid="dom-ladder"
    >
      <header className="panel__header">
        <button
          type="button"
          className="panel__collapse"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
          data-testid="ladder-collapse"
        >
          <span className="panel__chevron">{collapsed ? '▸' : '▾'}</span>
          <span className="panel__title">DOM</span>
        </button>
        <span
          className={`panel__badge panel__badge--${badgeClass}`}
          data-testid="ladder-badge"
        >
          {badge}
        </span>
        {spreadTicks !== null && (
          <span className="panel__spread" data-testid="ladder-spread">
            spr {model.spread!.toFixed(model.priceDecimals)}
            {spreadTicks > 0 ? ` (${spreadTicks}t)` : ''}
          </span>
        )}
        <button
          type="button"
          className={`panel__lock${locked ? ' is-on' : ''}`}
          aria-pressed={locked}
          title={locked ? 'center locked — click to follow mid' : 'following mid — click to lock'}
          onClick={() => setLocked((v) => !v)}
          data-testid="ladder-lock"
        >
          {locked ? 'LOCKED' : 'FOLLOW'}
        </button>
      </header>
      {!collapsed && (
        <div className="ladder__body" ref={bodyRef} data-testid="ladder-body">
          {model.rows.length === 0 ? (
            <div className="panel__empty">{emptyMsg}</div>
          ) : (
            model.rows.map((r) => (
              <div
                key={r.row}
                className={`ladder__row${r.isBestBid ? ' is-bestbid' : ''}${
                  r.isBestAsk ? ' is-bestask' : ''
                }`}
                data-testid="ladder-row"
                data-row={r.row}
                data-price={r.price.toFixed(model.priceDecimals)}
                data-bid={r.bidSz.toFixed(4)}
                data-ask={r.askSz.toFixed(4)}
              >
                {shape === 'profile' ? (
                  <div className="ladder__profile">
                    <div className="ladder__bar ladder__bar--profile" style={{ width: `${r.profilePct}%` }} />
                    <span className="ladder__sz">{fmtSz(r.profileSz)}</span>
                  </div>
                ) : (
                  <>
                    <div className="ladder__cell ladder__cell--bid">
                      <div className="ladder__bar ladder__bar--bid" style={{ width: `${r.bidPct}%` }} />
                      <span className="ladder__sz">{fmtSz(r.bidSz)}</span>
                    </div>
                    <div className="ladder__px">{r.price.toFixed(model.priceDecimals)}</div>
                    <div className="ladder__cell ladder__cell--ask">
                      <div className="ladder__bar ladder__bar--ask" style={{ width: `${r.askPct}%` }} />
                      <span className="ladder__sz">{fmtSz(r.askSz)}</span>
                    </div>
                  </>
                )}
                {shape === 'profile' && <div className="ladder__px ladder__px--synth">{r.price.toFixed(model.priceDecimals)}</div>}
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
