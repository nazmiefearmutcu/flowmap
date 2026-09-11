/**
 * Painter tests (lane CF): the pure Canvas2D painter + hit-testing against a
 * FIXED linear projection (10 px per second of data time; y = 100 − 10·price)
 * — render calls asserted via a recording 2D-context stub, hit-tests golden.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  HANDLE_SIZE,
  HIT_TOLERANCE_PX,
  distanceToSegment,
  fmtLevelPct,
  fmtPriceTag,
  hitTestDrawings,
  hitTestDrawing,
  paintDrawing,
  paintDraft,
  paintLayer,
  type DrawProjection,
} from './painter';
import { DEFAULT_STYLE } from './types';
import type { ChartPoint, Drawing } from './types';

/** 10 px per second of time; price 10 at y=0 down to price 0 at y=100. */
const PROJ: DrawProjection = {
  xAt: (tNs) => Number(tNs) / 1e9 * 10,
  yAt: (price) => 100 - price * 10,
  tNsAt: (x) => BigInt(Math.round((x / 10) * 1e9)),
  priceAt: (y) => (100 - y) / 10,
};

const P = (t: bigint, price: number): ChartPoint => ({ tNs: t, price });
const STYLE = { ...DEFAULT_STYLE };

function trend(): Drawing {
  return { id: 't1', tool: 'trendline', createdAt: 0, points: [P(0n, 10), P(10_000_000_000n, 0)], style: { ...STYLE } };
}

/** Recording 2D-context stub (jsdom has no canvas). */
function stubCtx() {
  const ctx = {
    canvas: { width: 800, height: 300 },
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
    setLineDash: vi.fn(),
    setTransform: vi.fn(),
  };
  return ctx as unknown as CanvasRenderingContext2D & Record<string, ReturnType<typeof vi.fn>>;
}

describe('helpers', () => {
  it('distanceToSegment is exact for on/off-segment points', () => {
    expect(distanceToSegment(5, 5, 0, 0, 10, 10)).toBeCloseTo(0, 10);
    expect(distanceToSegment(5, 5, 0, 0, 10, 0)).toBe(5);
    expect(distanceToSegment(-3, 0, 0, 0, 10, 0)).toBe(3); // clamped to endpoint
    expect(distanceToSegment(15, 4, 0, 0, 10, 0)).toBeCloseTo(Math.hypot(5, 4), 10); // clamped to endpoint
    expect(distanceToSegment(0, 0, 3, 3, 3, 3)).toBeCloseTo(Math.hypot(3, 3), 10); // degenerate
  });

  it('label formatters', () => {
    expect(fmtLevelPct(0.236)).toBe('23.6%');
    expect(fmtLevelPct(1)).toBe('100%');
    expect(fmtPriceTag(25000)).toBe('25000');
    expect(fmtPriceTag(101.5)).toBe('101.5');
    expect(fmtPriceTag(0.001234)).toBe('0.00123');
  });
});

describe('paintDrawing', () => {
  it('paints a trendline as one save/stroke/restore cycle with projected ends', () => {
    const ctx = stubCtx();
    paintDrawing(ctx, trend(), PROJ, { width: 800, height: 300 });
    expect(ctx.save).toHaveBeenCalledTimes(1);
    expect(ctx.restore).toHaveBeenCalledTimes(1);
    expect(ctx.beginPath).toHaveBeenCalled();
    expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
    expect(ctx.lineTo).toHaveBeenCalledWith(100, 100);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
  });

  it('paints an hline full-width plus a right-edge price tag', () => {
    const ctx = stubCtx();
    const d: Drawing = { id: 'h', tool: 'hline', createdAt: 0, points: [P(0n, 5)], style: { ...STYLE } };
    paintDrawing(ctx, d, PROJ, { width: 800, height: 300 });
    expect(ctx.moveTo).toHaveBeenCalledWith(0, 50);
    expect(ctx.lineTo).toHaveBeenCalledWith(800, 50);
    expect(ctx.measureText).toHaveBeenCalledWith('5');
    expect(ctx.fillRect).toHaveBeenCalled(); // tag background
    expect(ctx.fillText).toHaveBeenCalledWith('5', expect.any(Number), 50);
  });

  it('paints an hray from its anchor rightward only', () => {
    const ctx = stubCtx();
    const d: Drawing = { id: 'r', tool: 'hray', createdAt: 0, points: [P(1_000_000_000n, 5)], style: { ...STYLE } };
    paintDrawing(ctx, d, PROJ, { width: 800, height: 300 });
    expect(ctx.moveTo).toHaveBeenCalledWith(10, 50);
    expect(ctx.lineTo).toHaveBeenCalledWith(800, 50);
  });

  it('paints a rect as wash + outline', () => {
    const ctx = stubCtx();
    const d: Drawing = { id: 'r', tool: 'rect', createdAt: 0, points: [P(0n, 10), P(5_000_000_000n, 5)], style: { ...STYLE } };
    paintDrawing(ctx, d, PROJ, { width: 800, height: 300 });
    // corners px (0,0)-(50,50): normalized to top-left + size
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 50, 50);
    expect(ctx.strokeRect).toHaveBeenCalledWith(0, 0, 50, 50);
  });

  it('paints the 7-level fib ladder with % labels', () => {
    const ctx = stubCtx();
    const d: Drawing = { id: 'f', tool: 'fib', createdAt: 0, points: [P(0n, 10), P(10_000_000_000n, 0)], style: { ...STYLE } };
    paintDrawing(ctx, d, PROJ, { width: 800, height: 300 });
    expect(ctx.stroke).toHaveBeenCalledTimes(7);
    // rails + intermediate targets land at the projected prices 0..10
    const moveToMock = ctx.moveTo as unknown as { mock: { calls: Array<number[]> } };
    const ys = moveToMock.mock.calls.map((c) => c[1]);
    expect(ys[0]).toBeCloseTo(100, 6); // 0%
    expect(ys[1]).toBeCloseTo(100 - 23.6, 6); // 23.6%
    expect(ys[3]).toBeCloseTo(50, 6); // 50%
    expect(ys[6]).toBeCloseTo(0, 6); // 100%
    expect(ctx.fillText).toHaveBeenCalledWith('61.8%', expect.any(Number), expect.any(Number));
    expect(ctx.fillText).toHaveBeenCalledWith('0%', expect.any(Number), expect.any(Number));
  });

  it('paints the text label at its anchor', () => {
    const ctx = stubCtx();
    const d: Drawing = { id: 'x', tool: 'text', createdAt: 0, points: [P(1_000_000_000n, 4)], style: { ...STYLE }, text: 'wall' };
    paintDrawing(ctx, d, PROJ, { width: 800, height: 300 });
    expect(ctx.fillText).toHaveBeenCalledWith('wall', 14, 60);
    // empty labels render nothing
    const ctx2 = stubCtx();
    paintDrawing(ctx2, { ...d, text: '' }, PROJ, { width: 800, height: 300 });
    expect(ctx2.fillText).not.toHaveBeenCalled();
  });

  it('selection adds one handle per anchor', () => {
    const ctx = stubCtx();
    paintDrawing(ctx, trend(), PROJ, { width: 800, height: 300, selectedId: 't1' });
    expect(ctx.fillRect).toHaveBeenCalledTimes(2); // 2 anchor squares
    const ctx2 = stubCtx();
    paintDrawing(ctx2, trend(), PROJ, { width: 800, height: 300, selectedId: null });
    expect(ctx2.fillRect).not.toHaveBeenCalled();
  });

  it('draft mode paints dashed', () => {
    const ctx = stubCtx();
    paintDrawing(ctx, trend(), PROJ, { width: 800, height: 300, draft: true });
    expect(ctx.setLineDash).toHaveBeenCalledWith([4, 4]);
  });
});

describe('paintDraft', () => {
  it('ghosts the second anchor while a two-point tool is one short', () => {
    const ctx = stubCtx();
    paintDraft(ctx, 'trendline', [P(0n, 10)], P(5_000_000_000n, 5), PROJ, { width: 800, height: 300 });
    expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
    expect(ctx.lineTo).toHaveBeenCalledWith(50, 50);
    expect(ctx.fillRect).toHaveBeenCalledTimes(1); // handle on the placed anchor only
  });

  it('single-anchor tools show the placed handle but never ghost', () => {
    const ctx = stubCtx();
    paintDraft(ctx, 'hline', [P(0n, 5)], P(5n, 5), PROJ, { width: 800, height: 300 });
    expect(ctx.stroke).not.toHaveBeenCalled();
    expect(ctx.fillRect).toHaveBeenCalledTimes(1);
  });

  it('a complete two-point draft (no cursor) shows both handles only', () => {
    const ctx = stubCtx();
    paintDraft(ctx, 'rect', [P(0n, 10), P(5_000_000_000n, 5)], null, PROJ, { width: 800, height: 300 });
    expect(ctx.strokeRect).not.toHaveBeenCalled(); // finalized drafts go through paintDrawing
    expect(ctx.fillRect).toHaveBeenCalledTimes(2); // 2 handles
  });
});

describe('paintLayer', () => {
  it('clears the full DEVICE buffer then paints items in order', () => {
    const ctx = stubCtx();
    const d1 = trend();
    const d2: Drawing = { id: 'h', tool: 'hline', createdAt: 1, points: [P(0n, 5)], style: { ...STYLE } };
    paintLayer(ctx, [d1, d2], PROJ, { width: 800, height: 300 });
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 800, 300);
    expect(ctx.save).toHaveBeenCalledTimes(3); // clear wrapper + 2 drawings
  });
});

describe('hit-testing (golden, fixed projection)', () => {
  const tol = HIT_TOLERANCE_PX;

  it('trendline: on-segment hits, off-segment misses, handles beat body', () => {
    const d = trend(); // (0,0) → (100,100) in px
    expect(hitTestDrawing(d, 50, 50, PROJ)).toMatchObject({ id: 't1', kind: 'body' });
    expect(hitTestDrawing(d, 50, 50 + tol + 4, PROJ)).toBeNull(); // ≈7.1 px off the line
    expect(hitTestDrawing(d, -20, -20, PROJ)).toBeNull(); // outside the finite segment
    // Handles use the wider knob tolerance and win over the body.
    expect(hitTestDrawing(d, 0, HANDLE_SIZE / 2 + 1, PROJ)).toMatchObject({ kind: 'handle', handle: 0 });
    expect(hitTestDrawing(d, 100, 100, PROJ)).toMatchObject({ kind: 'handle', handle: 1 });
  });

  it('hline: any x on the level, within tolerance', () => {
    const d: Drawing = { id: 'h', tool: 'hline', createdAt: 0, points: [P(0n, 5)], style: { ...STYLE } };
    expect(hitTestDrawing(d, 400, 50, PROJ)).toMatchObject({ kind: 'body' });
    expect(hitTestDrawing(d, 400, 50 + tol + 1, PROJ)).toBeNull();
  });

  it('hray: hits only at/RIGHT of its anchor time', () => {
    const d: Drawing = { id: 'r', tool: 'hray', createdAt: 0, points: [P(1_000_000_000n, 5)], style: { ...STYLE } };
    expect(hitTestDrawing(d, 10, 50, PROJ)).toMatchObject({ kind: 'handle', handle: 0 }); // ON the anchor knob
    expect(hitTestDrawing(d, 500, 50, PROJ)).toMatchObject({ kind: 'body' }); // rightward = body
    expect(hitTestDrawing(d, 0, 50, PROJ)).toBeNull(); // behind the anchor, outside the knob
  });

  it('rect: the whole wash is a body hit, outside misses', () => {
    const d: Drawing = { id: 'r', tool: 'rect', createdAt: 0, points: [P(0n, 10), P(5_000_000_000n, 5)], style: { ...STYLE } };
    expect(hitTestDrawing(d, 25, 25, PROJ)).toMatchObject({ kind: 'body' }); // inside
    expect(hitTestDrawing(d, 0, 0, PROJ)).toMatchObject({ kind: 'handle' }); // corner = handle
    expect(hitTestDrawing(d, 25, 60, PROJ)).toBeNull(); // 10 px below the box
  });

  it('fib: near ANY of the 7 level lines within the band', () => {
    const d: Drawing = { id: 'f', tool: 'fib', createdAt: 0, points: [P(0n, 10), P(10_000_000_000n, 0)], style: { ...STYLE } };
    expect(hitTestDrawing(d, 50, 100 - 2.36 * 10, PROJ)).toMatchObject({ kind: 'body' }); // 23.6% level
    expect(hitTestDrawing(d, 50, 100, PROJ)).toMatchObject({ kind: 'body' }); // 0% rail
    expect(hitTestDrawing(d, 50, 90, PROJ)).toBeNull(); // between levels
    expect(hitTestDrawing(d, 200, 100, PROJ)).toBeNull(); // right of the band
  });

  it('text: a generous box around the anchor', () => {
    const d: Drawing = { id: 'x', tool: 'text', createdAt: 0, points: [P(0n, 10)], style: { ...STYLE }, text: 'hi' };
    expect(hitTestDrawing(d, 8, 0, PROJ)).toMatchObject({ kind: 'handle' }); // the knob itself
    expect(hitTestDrawing(d, 15, -5, PROJ)).toMatchObject({ kind: 'body' }); // label box
    expect(hitTestDrawing(d, 60, 0, PROJ)).toBeNull();
  });

  it('hitTestDrawings: topmost (later) drawing wins', () => {
    const bottom: Drawing = { id: 'h1', tool: 'hline', createdAt: 0, points: [P(0n, 5)], style: { ...STYLE } };
    const top: Drawing = { id: 'h2', tool: 'hline', createdAt: 1, points: [P(0n, 5.0000001)], style: { ...STYLE } };
    expect(hitTestDrawings([bottom, top], 400, PROJ.yAt(5.0000001), PROJ)).toMatchObject({ id: 'h2' });
    expect(hitTestDrawings([], 400, 50, PROJ)).toBeNull();
  });
});
