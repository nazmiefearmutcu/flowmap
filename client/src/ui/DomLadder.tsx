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
): { bestBidRow: number; bestAskRow: number; midRow: number | null } {
  const step = params.tick * params.tick_multiple;
  const rows = params.rows;
  const bbo = snap.bbo;
  if (bbo && shape !== 'profile') {
    const bestBidRow = clampRow(Math.round((bbo.bidPx - params.p0) / step), rows);
    const bestAskRow = clampRow(Math.round((bbo.askPx - params.p0) / step), rows);
    const midRow = ((bbo.bidPx + bbo.askPx) / 2 - params.p0) / step;
    return { bestBidRow, bestAskRow, midRow };
  }
  const book = snap.book;
  if (book === null) return { bestBidRow: -1, bestAskRow: -1, midRow: null };

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
    return { bestBidRow: -1, bestAskRow: -1, midRow: pocRow >= 0 ? pocRow : null };
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
  if (bestBidRow < 0 && bestAskRow < 0) return { bestBidRow: -1, bestAskRow: -1, midRow: null };
  if (bestBidRow < 0) bestBidRow = bestAskRow - 1;
  if (bestAskRow < 0) bestAskRow = bestBidRow + 1;
  if (bestAskRow <= bestBidRow) bestAskRow = bestBidRow + 1;
  return { bestBidRow, bestAskRow, midRow: (bestBidRow + bestAskRow) / 2 };
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
  if (!book || !params) return { rows: [], priceDecimals: 2, midRow: null };

  const step = params.tick * params.tick_multiple;
  const nrows = params.rows;
  const decimals = priceDecimals(step);
  const { bestBidRow, bestAskRow, midRow } = deriveQuotes(snap, params, shape);

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
      profileSz = inRange ? book.bid[r] : 0;
    } else if (shape === 'l1') {
      if (snap.bbo && r === bestBidRow) bidSz = snap.bbo.bidSz;
      if (snap.bbo && r === bestAskRow) askSz = snap.bbo.askSz;
    } else {
      // book: real per-row density (L2, keyed L1 band, or two-sided synthetic).
      bidSz = inRange ? book.bid[r] : 0;
      askSz = inRange && book.ask ? book.ask[r] : 0;
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
  for (const row of out) {
    row.bidPct = Math.round((row.bidSz / maxSz) * 100);
    row.askPct = Math.round((row.askSz / maxSz) * 100);
    row.profilePct = Math.round((row.profileSz / maxSz) * 100);
  }
  return { rows: out, priceDecimals: decimals, midRow };
}

/** Compact size formatting (matches the crosshair readout). */
export function fmtSz(v: number): string {
  // Never render the raw JS "Infinity"/"NaN" strings: a non-finite density is
  // over-range/unusable (e.g. an upstream f16-overflowed SYNTH volume bucket) —
  // show an honest over-range glyph, not a fabricated number.
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '';
  if (v <= 0) return '';
  if (v >= 1000) return v.toFixed(0);
  if (v >= 100) return v.toFixed(1);
  return v.toFixed(2);
}

export function DomLadder(): JSX.Element {
  const capability = useFlowMapStore((s) => s.capability);
  const epochs = useFlowMapStore((s) => s.epochs);
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
  const center = locked ? frozenCenterRef.current : null;
  const model = buildLadder(snap, params, shape, visRows, center);

  // Track the live mid so locking freezes at the current center.
  useEffect(() => {
    if (!locked && model.midRow !== null) frozenCenterRef.current = model.midRow;
  });

  const badge = tier ?? 'N/A';

  return (
    <section className="panel dom-ladder" data-testid="dom-ladder">
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
          className={`panel__badge panel__badge--${badge.toLowerCase()}`}
          data-testid="ladder-badge"
        >
          {badge}
        </span>
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
            <div className="panel__empty">waiting for book…</div>
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
