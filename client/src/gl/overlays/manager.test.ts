/**
 * OverlayManager tests (CP3 clear APIs + S2 D4 z-order + S1 D5 cursors).
 *
 * jsdom has no canvas: every `<canvas>` gets a per-canvas recording 2D context
 * (the mockGL pattern) and the GL side uses the shared fake from mockGL.ts —
 * which is all the manager's GL usage needs (shader link + buffer/VAO no-ops).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OverlayManager, type OverlayDrawContext } from './manager';
import { makeFakeGL } from '../mockGL';
import { PriceLine } from './priceLine';
import type { BarColumn, BBO, Marker, Trade } from '../../proto/types';

interface Rec2D {
  ctx: CanvasRenderingContext2D;
  clears: Array<[number, number, number, number]>;
}

/** Install a per-canvas recording 2D context; returns a lookup + restore. */
function install2D(): { rec: (c: HTMLCanvasElement) => Rec2D; restore: () => void } {
  const byCanvas = new WeakMap<HTMLCanvasElement, Rec2D>();
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    function mockGetContext(this: HTMLCanvasElement, kind: string) {
      if (kind !== '2d') return null;
      let found = byCanvas.get(this);
      if (!found) {
        const clears: Array<[number, number, number, number]> = [];
        const target: Record<string, unknown> = {
          measureText: () => ({ width: 42 }),
          createLinearGradient: () => ({ addColorStop: () => undefined }),
          clearRect: (x: number, y: number, w: number, h: number) => {
            clears.push([x, y, w, h]);
          },
        };
        const ctx = new Proxy(target, {
          get(t, prop) {
            return Reflect.has(t, prop) ? Reflect.get(t, prop) : () => undefined;
          },
          set(t, prop, value) {
            Reflect.set(t, prop, value);
            return true;
          },
        }) as unknown as CanvasRenderingContext2D;
        found = { ctx, clears };
        byCanvas.set(this, found);
      }
      return found.ctx as never;
    } as unknown as HTMLCanvasElement['getContext'],
  );
  return { rec: (c) => byCanvas.get(c)!, restore: () => spy.mockRestore() };
}

function bar(col: number, close: number): BarColumn {
  return {
    col_seq: col,
    c: close,
    vwap_num_cum: close,
    vwap_den_cum: 1,
    cvd_cum: 0,
  } as unknown as BarColumn;
}

function drawCtx(): OverlayDrawContext {
  return {
    view: { colOffset: 0, colScale: 8, rowOffset: 0, rowScale: 8 },
    dims: { drawW: 640, drawH: 480, cssW: 640, cssH: 480 },
    dpr: 1,
    resident: { oldest: 0, newest: 8 },
    capability: null,
    time: { anchorSeq: 8, anchorT0Ns: 2_000_000_000n, dtNs: 250_000_000 },
    price: { p0: 100, step: 0.5 },
    columnArrays: () => null,
    newestArrays: null,
  };
}

type Internals = {
  priceLine: PriceLine;
  text: { canvas: HTMLCanvasElement };
  cvd: { size: number };
};

describe('OverlayManager (fake GL + recording 2D)', () => {
  let harness: ReturnType<typeof install2D>;
  let manager: OverlayManager;
  let textCanvas: HTMLCanvasElement;
  let priceCanvas: HTMLCanvasElement;
  let timeCanvas: HTMLCanvasElement;

  function internals(): Internals {
    return manager as unknown as Internals;
  }

  beforeEach(() => {
    harness = install2D();
    manager = new OverlayManager(makeFakeGL(), document.createElement('canvas'));
    priceCanvas = document.createElement('canvas');
    timeCanvas = document.createElement('canvas');
    manager.attachAxes(priceCanvas, timeCanvas);
    textCanvas = internals().text.canvas;
  });

  afterEach(() => {
    harness.restore();
    vi.restoreAllMocks();
  });

  it('clearInk wipes the text layer and BOTH gutters synchronously (CP3)', () => {
    manager.clearInk();
    expect(harness.rec(textCanvas).clears).toHaveLength(1);
    expect(harness.rec(priceCanvas).clears).toHaveLength(1);
    expect(harness.rec(timeCanvas).clears).toHaveLength(1);
  });

  it('draw() clears text + gutters with axes OFF (S3 C-4 ghost labels/pill)', () => {
    const ctx = drawCtx();
    manager.setVisibility({
      bubbles: false,
      bbo: false,
      vwap: false,
      profile: false,
      markers: false,
      axes: false,
      price: false,
      cvd: false,
    });
    manager.draw(ctx); // prime sizes
    const t = harness.rec(textCanvas);
    const p = harness.rec(priceCanvas);
    const g = harness.rec(timeCanvas);
    t.clears.length = 0;
    p.clears.length = 0;
    g.clears.length = 0;

    manager.draw(ctx);
    expect(t.clears).toHaveLength(1);
    expect(p.clears).toHaveLength(1);
    expect(g.clears).toHaveLength(1);
  });

  it('draw() clears both gutters when axes are ON as well', () => {
    const ctx = drawCtx();
    manager.setVisibility({ axes: false });
    manager.draw(ctx);
    const p = harness.rec(priceCanvas);
    const g = harness.rec(timeCanvas);
    p.clears.length = 0;
    g.clears.length = 0;

    manager.setVisibility({ axes: true });
    manager.draw(ctx);
    expect(p.clears).toHaveLength(1);
    expect(g.clears).toHaveLength(1);
  });

  it('draws BBO before the price line so the price core keeps z-order (S2 D4)', () => {
    const order: string[] = [];
    const holder = manager as unknown as Record<string, { draw: (f: unknown) => void }>;
    for (const name of ['profile', 'vwap', 'priceLine', 'bbo', 'bubbles', 'markers']) {
      holder[name].draw = () => {
        order.push(name);
      };
    }
    manager.setVisibility({
      profile: true,
      vwap: true,
      bbo: true,
      price: true,
      bubbles: true,
      markers: true,
      axes: false,
    });
    manager.draw(drawCtx());
    expect(order).toEqual(['profile', 'vwap', 'bbo', 'priceLine', 'bubbles', 'markers']);
  });

  it('reset() re-inits the price-line high-water (restarted col_seq=0 must not freeze)', () => {
    const pl = internals().priceLine;
    pl.add(bar(500, 100));
    expect(pl.last()).toEqual({ col: 500, price: 100 });
    manager.reset();
    expect(pl.last()).toBeNull();
    pl.add(bar(0, 7)); // a replaced session restarts col_seq at 0
    expect(pl.last()).toEqual({ col: 0, price: 7 });
  });

  it('resetCursor() clears the high-water + channel BBO but keeps per-column data', () => {
    const pl = internals().priceLine;
    pl.add(bar(500, 100));
    manager.onBbo({ bid_px: 1, bid_sz: 1, ask_px: 2, ask_sz: 1 } as unknown as BBO);
    expect(manager.debug().hasChannelBbo).toBe(true);

    manager.resetCursor();
    expect(pl.last()).toBeNull();
    expect(pl.size).toBe(1); // documented: data is kept
    expect(manager.debug().hasChannelBbo).toBe(false);
  });

  it('reset() drops every overlay data ring too', () => {
    manager.onTrade({ ts_ns: 1n, price: 100, size: 1, side: 1 } as unknown as Trade);
    manager.onMarker({ ts_ns: 1n, price: 100, kind: 'large_lot' } as unknown as Marker);
    manager.onBar(bar(1, 5));
    expect(manager.debug().bubbles).toBe(1);
    expect(manager.debug().markers).toBe(1);
    expect(manager.debug().vwap).toBe(1);
    expect(internals().cvd.size).toBe(1);

    manager.reset();
    expect(manager.debug().bubbles).toBe(0);
    expect(manager.debug().markers).toBe(0);
    expect(manager.debug().vwap).toBe(0);
    expect(internals().cvd.size).toBe(0);
  });

  it('badges a reconstructed-history VWAP (S2 D1 honesty), not when vwap is approx', () => {
    const badges: string[] = [];
    const text = internals().text as unknown as {
      badge: (x: number, y: number, s: string) => void;
    };
    text.badge = (_x, _y, s) => {
      badges.push(s);
    };

    const reconciled = drawCtx();
    reconciled.capability = { history: 'reconstructed' };
    manager.draw(reconciled);
    expect(badges).toContain('VWAP ≈ reconstructed');

    badges.length = 0;
    const keyless = drawCtx();
    keyless.capability = { vwap: 'approx', history: 'reconstructed' };
    manager.draw(keyless);
    expect(badges).toContain('VWAP approx');
    expect(badges).not.toContain('VWAP ≈ reconstructed');
  });

  // --- QA9-1: born-blank gutters must re-match without a window resize -------

  /** Give a jsdom canvas a real layout box (clientWidth/Height are 0 there). */
  function box(el: HTMLCanvasElement, w: number, h: number): void {
    Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
  }

  it('syncGutters matches both gutters to their OWN live box (born-blank heal)', () => {
    // Fresh App canvases start at the browser default 300×150 with zero ink.
    expect([priceCanvas.width, priceCanvas.height]).toEqual([300, 150]);
    box(priceCanvas, 61, 231);
    box(timeCanvas, 352, 22);

    expect(manager.syncGutters(1)).toBe(true);
    expect([priceCanvas.width, priceCanvas.height]).toEqual([61, 231]);
    expect([timeCanvas.width, timeCanvas.height]).toEqual([352, 22]);

    // Idempotent: a converged pair reports no change (no heal-loop upstream).
    expect(manager.syncGutters(1)).toBe(false);
  });

  it('draw() sizes the gutters from their own live box, not a stale dims snapshot', () => {
    box(priceCanvas, 61, 231);
    box(timeCanvas, 352, 22);
    const ctx = drawCtx();
    ctx.dims = { drawW: 640, drawH: 480, cssW: 999, cssH: 999 }; // deliberately stale
    manager.draw(ctx);
    expect([priceCanvas.width, priceCanvas.height]).toEqual([61, 231]);
    expect([timeCanvas.width, timeCanvas.height]).toEqual([352, 22]);
  });

  it('syncGutters leaves a zero-box (pre-layout/hidden) gutter untouched', () => {
    // jsdom default: no layout box. Sizing to 1×1 would blank a gutter that is
    // merely not laid out yet — the manager must skip instead.
    expect(manager.syncGutters(1)).toBe(false);
    expect([priceCanvas.width, priceCanvas.height]).toEqual([300, 150]);
    expect([timeCanvas.width, timeCanvas.height]).toEqual([300, 150]);
  });
});
