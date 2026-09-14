/**
 * TextLayer size/clear tests. jsdom has no 2D canvas, so the context is the
 * mockGL fake with a recording `clearRect` — enough to pin that `clear()` wipes
 * the full CSS box and that `syncSize` sizes the DPR-scaled backing store.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TextLayer } from './textLayer';
import { makeFake2D } from './mockGL';

describe('TextLayer', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
    vi.restoreAllMocks();
  });

  /** A recording 2D stub installed on every canvas via the prototype spy. */
  function install(): {
    clears: Array<[number, number, number, number]>;
    moves: Array<[number, number]>;
    lines: Array<[number, number]>;
  } {
    const clears: Array<[number, number, number, number]> = [];
    const moves: Array<[number, number]> = [];
    const lines: Array<[number, number]> = [];
    const ctx = makeFake2D() as CanvasRenderingContext2D & {
      clearRect: (x: number, y: number, w: number, h: number) => void;
      moveTo: (x: number, y: number) => void;
      lineTo: (x: number, y: number) => void;
    };
    ctx.clearRect = (x, y, w, h) => clears.push([x, y, w, h]);
    ctx.moveTo = (x, y) => moves.push([x, y]);
    ctx.lineTo = (x, y) => lines.push([x, y]);
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    restore = () => spy.mockRestore();
    return { clears, moves, lines };
  }

  it('syncSize sizes the DPR-scaled backing store and clear() wipes the CSS box', () => {
    const { clears } = install();
    const canvas = document.createElement('canvas');
    const layer = new TextLayer(canvas);

    layer.syncSize(320, 200, 2);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(400);
    expect(layer.width).toBe(320);
    expect(layer.height).toBe(200);

    layer.clear();
    expect(clears).toEqual([[0, 0, 320, 200]]);

    // A resize is picked up by the next clear (the backing store was resized,
    // so the full new box must be wiped — a stale smaller rect would leave ink).
    layer.syncSize(100, 50, 1);
    expect(canvas.width).toBe(100);
    layer.clear();
    expect(clears[1]).toEqual([0, 0, 100, 50]);
  });

  it('snaps 1px hairlines to the device STROKE grid: pixel center at DPR1 (unchanged), device boundary at DPR2 (2 clean device px)', () => {
    const { moves, lines } = install();
    const canvas = document.createElement('canvas');
    const layer = new TextLayer(canvas);

    // DPR1: odd (1) device width -> center on a device pixel CENTER (10.5 dev).
    layer.syncSize(320, 200, 1);
    layer.line(0, 10.6, 100, 10.6, '#fff');
    expect(moves.at(-1)).toEqual([0, 10.5]);
    expect(lines.at(-1)).toEqual([100, 10.5]);
    // stroke edges at 10/11 device — 1 full device row.
    expect([(10.5 - 0.5) * 1, (10.5 + 0.5) * 1]).toEqual([10, 11]);

    // DPR2: even (2) device width -> center on a device pixel BOUNDARY.
    // Old pixel-center snapping landed at CSS 10.75 (device 21.5 -> 0.5/1/0.5
    // smear over 3 rows); boundary snapping must land at CSS 10.5 (device 21).
    layer.syncSize(320, 200, 2);
    layer.line(0, 10.6, 100, 10.6, '#fff');
    expect(moves.at(-1)).toEqual([0, 10.5]);
    expect(lines.at(-1)).toEqual([100, 10.5]);
    expect(10.5 * 2).toBe(21); // integer device coordinate = pixel BOUNDARY
    // Both stroke edges on device boundaries -> exactly 2 clean device px.
    expect([(10.5 - 0.5) * 2, (10.5 + 0.5) * 2]).toEqual([20, 22]);

    // Vertical hairline follows the same law (constant axis only).
    layer.line(40.4, 0, 40.4, 100, '#fff');
    expect(moves.at(-1)).toEqual([40.5, 0]);
    expect(lines.at(-1)).toEqual([40.5, 100]);
    expect(40.5 * 2).toBe(81); // boundary, not 81.5 center

    // A sloped stroke keeps raw coordinates (no snapping).
    layer.line(0, 1.1, 100, 2.2, '#fff');
    expect(moves.at(-1)).toEqual([0, 1.1]);
  });

  it('odd device widths (DPR3) stay pixel-centered; thick hairlines stay un-snapped', () => {
    const { moves } = install();
    const layer = new TextLayer(document.createElement('canvas'));

    // DPR3: 1 CSS px = 3 device px (odd) -> pixel center at 31.5 dev; edges 30/33.
    layer.syncSize(320, 200, 3);
    layer.line(0, 10.6, 100, 10.6, '#fff');
    expect(moves.at(-1)).toEqual([0, 10.5]);
    expect([(10.5 - 0.5) * 3, (10.5 + 0.5) * 3]).toEqual([30, 33]);

    // width > 1 bypasses snapping entirely (anti-aliased placement preserved).
    layer.syncSize(320, 200, 2);
    layer.line(0, 10.6, 100, 10.6, '#fff', 2);
    expect(moves.at(-1)).toEqual([0, 10.6]);
  });

  it('dashedLine snaps its constant axis through the same device stroke grid', () => {
    const { moves } = install();
    const layer = new TextLayer(document.createElement('canvas'));

    layer.syncSize(320, 200, 2);
    layer.dashedLine(0, 12.3, 50, 12.3, '#fff');
    expect(moves.at(-1)).toEqual([0, 12.5]); // device 25 = boundary
    expect(12.5 * 2).toBe(25);

    // DPR1 unchanged: device 12.5 = pixel center.
    layer.syncSize(320, 200, 1);
    layer.dashedLine(0, 12.3, 50, 12.3, '#fff');
    expect(moves.at(-1)).toEqual([0, 12.5]);
  });

  it('over() layers a click-through canvas over the host and dispose() removes it', () => {
    install();
    const host = document.createElement('canvas');
    const parent = document.createElement('div');
    parent.appendChild(host);

    const layer = TextLayer.over(host);
    expect(layer.canvas.parentElement).toBe(parent);
    expect(layer.canvas.style.pointerEvents).toBe('none');
    expect(layer.canvas.className).toBe('overlay-text');

    layer.dispose();
    expect(layer.canvas.parentElement).toBeNull();
  });
});
