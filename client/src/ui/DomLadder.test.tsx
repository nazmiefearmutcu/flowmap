import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MODE_L1_BAND, MODE_L2, MODE_SYNTH_PROFILE, type EpochParams } from '../proto/types';
import {
  ingestForTest,
  resetForTest,
  type BookSnapshot,
} from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { DomLadder, buildLadder, depthTier, ladderShape, fmtSz, priceDecimals } from './DomLadder';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PARAMS: EpochParams = {
  epoch: 1,
  tick: 0.5,
  tick_multiple: 1,
  dt_ns: 1_000_000,
  p0: 50,
  rows: 200,
};

/** A book with best bid at row 100 (px 100.0) and best ask at row 101 (px 100.5). */
function makeBook(): { bid: Float32Array; ask: Float32Array } {
  const bid = new Float32Array(PARAMS.rows);
  const ask = new Float32Array(PARAMS.rows);
  bid[98] = 3;
  bid[99] = 5;
  bid[100] = 8; // best bid
  ask[101] = 7; // best ask
  ask[102] = 4;
  ask[103] = 2;
  return { bid, ask };
}

function snapWithBook(): BookSnapshot {
  const { bid, ask } = makeBook();
  return {
    version: 1,
    book: { epoch: 1, mode: MODE_L2, colSeq: 1, t0Ns: 0n, bid, ask },
    bbo: null,
    trades: [],
  };
}

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function render(node: JSX.Element): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  const handle = { container, root };
  mounted.push(handle);
  return handle;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  resetForTest();
  useFlowMapStore.setState({ capability: null, epochs: new Map(), gridEpoch: null });
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  resetForTest();
});

describe('depthTier', () => {
  it('maps the capability depth tier honestly', () => {
    expect(depthTier({ depth: 'L2' }, null)).toBe('L2');
    expect(depthTier({ depth: 'L1_BAND' }, null)).toBe('L1');
    expect(depthTier({ depth: 'SYNTH' }, null)).toBe('SYNTH');
    expect(depthTier({ depth: 'SYNTH_PROFILE' }, null)).toBe('SYNTH');
  });

  it('falls back to the book mode when capability is absent', () => {
    expect(depthTier(null, MODE_L2)).toBe('L2');
    expect(depthTier(null, MODE_SYNTH_PROFILE)).toBe('SYNTH');
    expect(depthTier(null, null)).toBeNull();
  });
});

describe('ladderShape', () => {
  it('decouples layout shape from the honesty badge', () => {
    // Legacy one-sided density → centered profile, regardless of tier.
    expect(ladderShape('SYNTH', MODE_SYNTH_PROFILE)).toBe('profile');
    // Two-sided synthetic depth renders like a real book (badge stays SYNTH).
    expect(ladderShape('SYNTH', MODE_L1_BAND)).toBe('book');
    // Real two-sided books render as books.
    expect(ladderShape('L2', MODE_L2)).toBe('book');
    expect(ladderShape('L1', MODE_L1_BAND)).toBe('book');
    // An L1 tier with only a BBO (no book yet) → the one-level L1 layout.
    expect(ladderShape('L1', null)).toBe('l1');
  });
});

describe('fmtSz', () => {
  it('formats finite sizes compactly and blanks non-positive', () => {
    expect(fmtSz(0)).toBe('');
    expect(fmtSz(2.5)).toBe('2.50');
    expect(fmtSz(150)).toBe('150.0');
  });

  it('compacts large sizes with K/M/B suffixes (trimming a trailing .0)', () => {
    expect(fmtSz(1500)).toBe('1.5K');
    expect(fmtSz(2000)).toBe('2K');
    expect(fmtSz(3.4e6)).toBe('3.4M');
    expect(fmtSz(5e6)).toBe('5M');
    expect(fmtSz(1.2e9)).toBe('1.2B');
  });

  it('renders an over-range glyph for a non-finite density (never "Infinity"/"NaN")', () => {
    // Upstream f16-overflowed SYNTH volume buckets arrive as +inf; the ladder
    // must show an honest over-range marker, not the raw JS string.
    expect(fmtSz(Number.POSITIVE_INFINITY)).toBe('∞');
    expect(fmtSz(Number.NaN)).toBe('');
  });
});

describe('priceDecimals', () => {
  it('derives decimals from the price step', () => {
    expect(priceDecimals(0.5)).toBe(1);
    expect(priceDecimals(0.01)).toBe(2);
    expect(priceDecimals(1)).toBe(0);
    expect(priceDecimals(0.0001)).toBe(4);
  });
});

describe('buildLadder', () => {
  it('centers on the derived mid and flags best bid/ask (L2, no BBO)', () => {
    const model = buildLadder(snapWithBook(), PARAMS, 'book', 5, null);
    expect(model.priceDecimals).toBe(1);
    expect(model.midRow).toBeCloseTo(100.5);

    const byRow = new Map(model.rows.map((r) => [r.row, r]));
    const bid = byRow.get(100)!;
    expect(bid.bidSz).toBe(8);
    expect(bid.isBestBid).toBe(true);
    expect(bid.bidPct).toBe(100); // largest visible size → full bar
    expect(bid.price).toBeCloseTo(100.0);

    const ask = byRow.get(101)!;
    expect(ask.askSz).toBe(7);
    expect(ask.isBestAsk).toBe(true);
    expect(ask.askPct).toBeCloseTo(87.5); // 7/8, fractional (no rounding)

    // Rows are ordered highest price first.
    expect(model.rows[0].row).toBeGreaterThan(model.rows[model.rows.length - 1].row);
  });

  it('prefers the BBO for best bid/ask when present', () => {
    const snap = snapWithBook();
    snap.bbo = { tsNs: 1n, bidPx: 100.0, bidSz: 12, askPx: 100.5, askSz: 9 };
    const model = buildLadder(snap, PARAMS, 'book', 7, null);
    const byRow = new Map(model.rows.map((r) => [r.row, r]));
    expect(byRow.get(100)?.isBestBid).toBe(true);
    expect(byRow.get(101)?.isBestAsk).toBe(true);
  });

  it('honors a locked center override instead of following the mid', () => {
    const model = buildLadder(snapWithBook(), PARAMS, 'book', 5, 40);
    // Window centered on row 40 → rows 38..42, none near the live mid (100).
    expect(model.rows.map((r) => r.row)).toEqual([42, 41, 40, 39, 38]);
  });

  it('returns an empty model with no book', () => {
    const empty: BookSnapshot = { version: 0, book: null, bbo: null, trades: [] };
    const model = buildLadder(empty, PARAMS, 'book', 5, null);
    expect(model.rows).toEqual([]);
    expect(model.spread).toBeNull();
  });

  it('exposes an honest two-sided spread in price units', () => {
    // Best bid row 100 (px 100.0), best ask row 101 (px 100.5) → 0.5 spread.
    const model = buildLadder(snapWithBook(), PARAMS, 'book', 5, null);
    expect(model.spread).toBeCloseTo(0.5);
  });

  it('blanks the spread when only one side genuinely exists', () => {
    // A bid-only book: the ask side is synthesized for centering, but the spread
    // must stay null so nothing is fabricated.
    const bid = new Float32Array(PARAMS.rows);
    const ask = new Float32Array(PARAMS.rows);
    bid[100] = 8;
    const snap: BookSnapshot = {
      version: 1,
      book: { epoch: 1, mode: MODE_L2, colSeq: 1, t0Ns: 0n, bid, ask },
      bbo: null,
      trades: [],
    };
    expect(buildLadder(snap, PARAMS, 'book', 5, null).spread).toBeNull();
  });

  it('takes the spread from the BBO prices when present', () => {
    const snap = snapWithBook();
    snap.bbo = { tsNs: 1n, bidPx: 100.0, bidSz: 12, askPx: 100.5, askSz: 9 };
    expect(buildLadder(snap, PARAMS, 'book', 7, null).spread).toBeCloseTo(0.5);
  });

  it('floors nonzero bar widths to 2% so a sub-1% level stays visible', () => {
    // One dominant level dwarfs a tiny one; the tiny nonzero size must still
    // render a >=2% bar (never a 0-width bar under a printed number).
    const bid = new Float32Array(PARAMS.rows);
    const ask = new Float32Array(PARAMS.rows);
    bid[100] = 1000; // dominates maxSz
    bid[99] = 1; // 0.1% → would round to 0 without a floor
    const snap: BookSnapshot = {
      version: 1,
      book: { epoch: 1, mode: MODE_L2, colSeq: 1, t0Ns: 0n, bid, ask },
      bbo: null,
      trades: [],
    };
    const model = buildLadder(snap, PARAMS, 'book', 7, null);
    const tiny = model.rows.find((r) => r.row === 99)!;
    expect(tiny.bidSz).toBe(1);
    expect(tiny.bidPct).toBe(2);
  });

  it('renders an L1 BBO window before the first book column arrives', () => {
    // book === null but a live BBO exists → the `l1` shape must still build.
    const snap: BookSnapshot = {
      version: 1,
      book: null,
      bbo: { tsNs: 1n, bidPx: 100.0, bidSz: 4, askPx: 100.5, askSz: 6 },
      trades: [],
    };
    const model = buildLadder(snap, PARAMS, 'l1', 5, null);
    expect(model.rows.length).toBeGreaterThan(0);
    const byRow = new Map(model.rows.map((r) => [r.row, r]));
    expect(byRow.get(100)?.bidSz).toBe(4);
    expect(byRow.get(101)?.askSz).toBe(6);
    expect(model.spread).toBeCloseTo(0.5);
  });
});

describe('DomLadder render', () => {
  it('renders price rungs with bid/ask sizes, the L2 badge, and best-row highlight', () => {
    useFlowMapStore.setState({
      capability: { depth: 'L2', tape: 'tick' },
      epochs: new Map([[1, PARAMS]]),
      gridEpoch: 1,
    });
    const { bid, ask } = makeBook();
    // Ingest the real DepthColumn (bypasses the socket).
    ingestForTest({
      type: 3,
      epoch: 1,
      col_seq: 1,
      t0_ns: 1_000_000n,
      mode: MODE_L2,
      final: true,
      bid,
      ask,
    } as never);

    const { container } = render(<DomLadder />);

    expect(container.querySelector('[data-testid="ladder-badge"]')?.textContent).toBe('L2');

    const bidRow = container.querySelector('[data-row="100"]');
    expect(bidRow?.getAttribute('data-bid')).toBe('8.0000');
    expect(bidRow?.className).toContain('is-bestbid');

    const askRow = container.querySelector('[data-row="101"]');
    expect(askRow?.getAttribute('data-ask')).toBe('7.0000');
    expect(askRow?.className).toContain('is-bestask');

    // The price cell shows the epoch-derived precision.
    expect(bidRow?.querySelector('.ladder__px')?.textContent).toBe('100.0');
  });

  it('renders two-sided bid/ask rungs for synthetic depth while badging SYNTH', () => {
    // The new keyless equity depth: a two-sided synthetic book (mode L1_BAND)
    // with capability depth SYNTH. Honest provenance badge (SYNTH), real book
    // layout (bid AND ask rungs) — not the old bid-only centered profile.
    useFlowMapStore.setState({
      capability: { depth: 'SYNTH', tape: 'poll' },
      epochs: new Map([[1, PARAMS]]),
      gridEpoch: 1,
    });
    const { bid, ask } = makeBook();
    ingestForTest({
      type: 3,
      epoch: 1,
      col_seq: 1,
      t0_ns: 1_000_000n,
      mode: MODE_L1_BAND,
      final: true,
      bid,
      ask,
    } as never);

    const { container } = render(<DomLadder />);

    // Honest badge: synthetic provenance.
    expect(container.querySelector('[data-testid="ladder-badge"]')?.textContent).toBe('SYNTH');
    // Real two-sided layout: both a populated bid rung and ask rung.
    const bidRow = container.querySelector('[data-row="100"]');
    expect(bidRow?.getAttribute('data-bid')).toBe('8.0000');
    const askRow = container.querySelector('[data-row="101"]');
    expect(askRow?.getAttribute('data-ask')).toBe('7.0000');
    // The two-sided book uses bid/ask cells, not the single-channel profile bar.
    expect(container.querySelector('.ladder__bar--profile')).toBeNull();
    expect(container.querySelector('.ladder__bar--ask')).not.toBeNull();
  });

  it('uses a class-safe N/A badge token (never the slashed "n/a")', () => {
    // No capability and no book → tier null → badge label "N/A" but a CSS-safe
    // "na" class token, so the red no-data affordance actually hooks.
    useFlowMapStore.setState({ capability: null, epochs: new Map(), gridEpoch: null });
    const { container } = render(<DomLadder />);
    const badge = container.querySelector('[data-testid="ladder-badge"]')!;
    expect(badge.textContent).toBe('N/A');
    expect(badge.className).toContain('panel__badge--na');
    expect(badge.className).not.toContain('n/a');
  });

  it('shows an honest numeric spread in the header for a two-sided book', () => {
    useFlowMapStore.setState({
      capability: { depth: 'L2', tape: 'tick' },
      epochs: new Map([[1, PARAMS]]),
      gridEpoch: 1,
    });
    const { bid, ask } = makeBook();
    ingestForTest({
      type: 3,
      epoch: 1,
      col_seq: 1,
      t0_ns: 1_000_000n,
      mode: MODE_L2,
      final: true,
      bid,
      ask,
    } as never);

    const { container } = render(<DomLadder />);
    const spread = container.querySelector('[data-testid="ladder-spread"]');
    expect(spread).not.toBeNull();
    expect(spread?.textContent).toContain('0.5');
  });

  it('reflects the connection state in the empty-body copy', () => {
    useFlowMapStore.setState({
      capability: null,
      epochs: new Map(),
      gridEpoch: null,
      status: 'connecting',
      feedState: null,
    });
    const { container } = render(<DomLadder />);
    expect(container.querySelector('.panel__empty')?.textContent).toBe('connecting…');

    act(() => {
      useFlowMapStore.setState({ feedState: 'closed' });
    });
    expect(container.querySelector('.panel__empty')?.textContent).toBe('market closed');
  });

  it('collapses the body via the header chevron', () => {
    useFlowMapStore.setState({
      capability: { depth: 'L2', tape: 'tick' },
      epochs: new Map([[1, PARAMS]]),
      gridEpoch: 1,
    });
    const { bid, ask } = makeBook();
    ingestForTest({
      type: 3,
      epoch: 1,
      col_seq: 1,
      t0_ns: 1_000_000n,
      mode: MODE_L2,
      final: true,
      bid,
      ask,
    } as never);

    const { container } = render(<DomLadder />);
    expect(container.querySelector('[data-testid="ladder-body"]')).not.toBeNull();

    click(container.querySelector('[data-testid="ladder-collapse"]')!);
    expect(container.querySelector('[data-testid="ladder-body"]')).toBeNull();
  });
});
