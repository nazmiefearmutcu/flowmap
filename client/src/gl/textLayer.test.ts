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
  function install(): Array<[number, number, number, number]> {
    const clears: Array<[number, number, number, number]> = [];
    const ctx = makeFake2D() as CanvasRenderingContext2D & {
      clearRect: (x: number, y: number, w: number, h: number) => void;
    };
    ctx.clearRect = (x, y, w, h) => clears.push([x, y, w, h]);
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    restore = () => spy.mockRestore();
    return clears;
  }

  it('syncSize sizes the DPR-scaled backing store and clear() wipes the CSS box', () => {
    const clears = install();
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
