/**
 * Model tests (lane CF): pure data-space drawing operations — fib ladder,
 * arity-safe construction, immutable move/translate/restyle, bounds.
 */

import { describe, expect, it } from 'vitest';

import {
  FIB_LEVELS,
  createDrawing,
  drawingBounds,
  fibPriceAt,
  movePoint,
  restyleDrawing,
  timeSpan,
  translateDrawing,
  withPoints,
} from './model';
import { DEFAULT_STYLE, MAX_WIDTH, MIN_WIDTH, clampWidth } from './types';
import type { ChartPoint } from './types';

const p = (tNs: bigint, price: number): ChartPoint => ({ tNs, price });
const STYLE = { color: '#33d6c4', width: 2 };

describe('fib levels', () => {
  it('exposes the classic retracement ladder as fractions of the move', () => {
    expect([...FIB_LEVELS]).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
  });

  it('anchors 0 at the END anchor and 1 at the origin, linear between', () => {
    const a = p(0n, 100);
    const b = p(1_000_000_000n, 120);
    expect(fibPriceAt(0, a, b)).toBe(120);
    expect(fibPriceAt(1, a, b)).toBe(100);
    expect(fibPriceAt(0.5, a, b)).toBe(110);
    expect(fibPriceAt(0.236, a, b)).toBeCloseTo(115.28, 10);
  });

  it('timeSpan normalizes anchor order', () => {
    expect(timeSpan(p(5n, 0), p(3n, 0))).toEqual({ from: 3n, to: 5n });
  });
});

describe('createDrawing', () => {
  it('builds exact-arity members per tool', () => {
    const t = createDrawing('trendline', [p(0n, 1), p(1n, 2)], STYLE, 'id1', 1);
    expect(t).not.toBeNull();
    expect(t!.tool).toBe('trendline');
    expect(t!.points.length).toBe(2);

    const h = createDrawing('hline', [p(0n, 50)], STYLE, 'id2', 2);
    expect(h!.points.length).toBe(1);

    const x = createDrawing('text', [p(0n, 0)], STYLE, 'id3', 3);
    expect(x).toMatchObject({ tool: 'text', text: '' });
  });

  it('refuses an arity mismatch (draft boundary)', () => {
    expect(createDrawing('rect', [p(0n, 1)], STYLE, 'x', 0)).toBeNull();
    expect(createDrawing('hline', [p(0n, 1), p(1n, 2)], STYLE, 'x', 0)).toBeNull();
  });

  it('clamps the stroke width into range', () => {
    const d = createDrawing('trendline', [p(0n, 1), p(1n, 2)], { color: '#fff', width: 99 }, 'x', 0);
    expect(d!.style.width).toBe(MAX_WIDTH);
  });
});

describe('geometry edits', () => {
  it('movePoint moves one anchor and keeps identity', () => {
    const d = createDrawing('trendline', [p(0n, 1), p(1n, 2)], STYLE, 'id', 0)!;
    const moved = movePoint(d, 1, p(9n, 9));
    expect(moved.points[1]).toEqual(p(9n, 9));
    expect(moved.points[0]).toEqual(p(0n, 1));
    expect(moved.id).toBe('id');
    expect(d.points[1]).toEqual(p(1n, 2)); // original untouched
  });

  it('movePoint ignores out-of-range indices', () => {
    const d = createDrawing('hline', [p(0n, 1)], STYLE, 'id', 0)!;
    expect(movePoint(d, 1, p(9n, 9))).toBe(d);
    expect(movePoint(d, -1, p(9n, 9))).toBe(d);
  });

  it('translateDrawing shifts every anchor by (dt, dprice)', () => {
    const d = createDrawing('rect', [p(0n, 0), p(10n, 10)], STYLE, 'id', 0)!;
    const t = translateDrawing(d, 5n, -2);
    expect(t.points[0]).toEqual(p(5n, -2));
    expect(t.points[1]).toEqual(p(15n, 8));
  });

  it('translateDrawing short-circuits a zero delta', () => {
    const d = createDrawing('hline', [p(0n, 1)], STYLE, 'id', 0)!;
    expect(translateDrawing(d, 0n, 0)).toBe(d);
  });

  it('restyleDrawing patches color / width immutably + clamped', () => {
    const d = createDrawing('hline', [p(0n, 1)], STYLE, 'id', 0)!;
    const r = restyleDrawing(d, { color: '#fff', width: 0 });
    expect(r.style).toEqual({ color: '#fff', width: MIN_WIDTH });
    expect(r).not.toBe(d);
    expect(restyleDrawing(d, { width: d.style.width })).toBe(d); // no-op is identity
  });

  it('withPoints rebuilds against a fresh anchor list (payload preserved)', () => {
    const d = createDrawing('text', [p(0n, 1)], STYLE, 'id', 0)!;
    const w = withPoints(d, [p(7n, 7)]);
    expect(w.points[0]).toEqual(p(7n, 7));
  });
});

describe('bounds + width clamp', () => {
  it('bounding box spans all anchors', () => {
    const d = createDrawing('rect', [p(10n, 5), p(2n, 9)], STYLE, 'id', 0)!;
    expect(drawingBounds(d)).toEqual({ tMin: 2n, tMax: 10n, pMin: 5, pMax: 9 });
  });

  it('clampWidth rejects non-finite and out-of-range widths', () => {
    expect(clampWidth(0)).toBe(MIN_WIDTH);
    expect(clampWidth(3.7)).toBe(4);
    expect(clampWidth(Number.NaN)).toBe(DEFAULT_STYLE.width);
    expect(clampWidth(1e9)).toBe(MAX_WIDTH);
  });
});
