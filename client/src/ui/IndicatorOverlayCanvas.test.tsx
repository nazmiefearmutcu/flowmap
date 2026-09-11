/**
 * IndicatorOverlayCanvas tests: jsdom has no 2D canvas, so the context is a
 * stub (CvdPane.test.tsx pattern) and the canvas gets a fixed CSS box. The
 * assertions target the DRAW PIPELINE decisions through the stub's call log —
 * mapping math, sub-pane strip geometry, ring feeding, and repaint gating —
 * using a chartMap pair that projects deterministically. No timing pins: the
 * loop's own idle backoff is exercised with fake timers.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChartMapPair } from './MeasureTool';
import { IndicatorOverlayCanvas } from './IndicatorOverlayCanvas';
import { resetIndicatorStoreForTest, useIndicatorStore } from '../indicators/store';
import { ingestForTest as ingestCandleMsg, getSnapshot as getCandleSnapshot, resetForTest as resetCandles } from '../candles/store';
import { MsgType, type DepthColumn, type Trade } from '../proto/types';
import { useFlowMapStore } from '../state/store';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface CtxSpy extends CanvasRenderingContext2D {
  __calls: {
    lineTo: number;
    moveTo: number;
    stroke: number;
    fillRect: number;
    fillText: number;
  };
}

function stubCtx(): CtxSpy {
  const calls = { lineTo: 0, moveTo: 0, stroke: 0, fillRect: 0, fillText: 0 };
  return {
    __calls: calls,
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(() => {
      calls.fillRect += 1;
    }),
    fillText: vi.fn(() => {
      calls.fillText += 1;
    }),
    beginPath: vi.fn(),
    moveTo: vi.fn(() => {
      calls.moveTo += 1;
    }),
    lineTo: vi.fn(() => {
      calls.lineTo += 1;
    }),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(() => {
      calls.stroke += 1;
    }),
    arc: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    clip: vi.fn(),
    rect: vi.fn(),
    setLineDash: vi.fn(),
    measureText: vi.fn(() => ({ width: 30 }) as TextMetrics),
  } as unknown as CtxSpy;
}

/** Deterministic chartMap: x = col·10, y = 100 − row·2 (contract-shaped). */
const MAP: ChartMapPair = {
  fromChart: (x, y) => ({ col: x / 10, row: (100 - y) / 2 }),
  toChart: (col, row) => ({ x: col * 10, y: 100 - row * 2 }),
};

const mounted: Array<{ container: HTMLElement; root: Root }> = [];
let ctx: CtxSpy;

function render(node: JSX.Element): { container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  mounted.push({ container, root });
  return { container };
}

function connectSession(): void {
  useFlowMapStore.setState({
    subscription: { market: 'sim', symbol: 'SIM-DEMO', mode: 'live', band: 'native' },
    gridEpoch: 3,
    epochs: new Map([
      [3, { epoch: 3, tick: 1, tick_multiple: 1, dt_ns: 250_000_000, p0: 100, rows: 2048 }],
    ]),
  });
}

function depthCol(): DepthColumn {
  return {
    type: MsgType.DEPTH_COL,
    epoch: 3,
    col_seq: 0,
    t0_ns: 0n,
    mode: 0,
    final: true,
    bid: new Float32Array(4),
    ask: new Float32Array(4),
  };
}

function trade(min: number, sec: number, price: number): Trade {
  return {
    type: MsgType.TRADE,
    ts_ns: BigInt(min) * 60_000_000_000n + BigInt(sec) * 1_000_000_000n,
    price,
    size: 1,
    side: 0,
    side_src: 0,
    venue: 'x',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  ctx = stubCtx();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 300 });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number =>
    setTimeout(() => cb(0), 16) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (h: number) => clearTimeout(h));
  window.localStorage.clear();
  connectSession();
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  resetIndicatorStoreForTest();
  resetCandles();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLCanvasElement.prototype as { clientWidth?: unknown }).clientWidth;
  delete (HTMLCanvasElement.prototype as { clientHeight?: unknown }).clientHeight;
  vi.useRealTimers();
});

describe('IndicatorOverlayCanvas — mount/visibility', () => {
  it('mounts a positioned host + canvas and hides it with no active indicators', () => {
    const { container } = render(<IndicatorOverlayCanvas chartMap={MAP} />);
    const host = container.querySelector('[data-testid="indi-overlay"]') as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('canvas')).not.toBeNull();
  });

  it('survives getContext() returning null (mounts inert)', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValueOnce(null);
    const { container } = render(<IndicatorOverlayCanvas chartMap={MAP} />);
    expect(container.querySelector('[data-testid="indi-overlay"]')).not.toBeNull();
  });

  it('mounting the canvas wires the candles stream: store.onStream is subscribed and trades reach the synth', () => {
    // Regression (R2): the canvas polls candles `getSnapshot()` and never
    // called `subscribe`, so the lazily-wired stream feed never started and
    // every indicator drew nothing in the app. Mounting must register the
    // store's stream handler, and that handler must feed the synth.
    const onStreamSpy = vi.spyOn(useFlowMapStore.getState(), 'onStream');
    render(<IndicatorOverlayCanvas chartMap={MAP} />);
    expect(onStreamSpy).toHaveBeenCalledTimes(1);
    const handle = onStreamSpy.mock.calls[0][0];
    act(() => handle(trade(0, 30, 101)));
    expect(getCandleSnapshot().candles.length).toBeGreaterThan(0);
  });
});

describe('IndicatorOverlayCanvas — draw pipeline', () => {
  it('paints overlay series from streamed candles through the chartMap', () => {
    ingestCandleMsg(depthCol());
    ingestCandleMsg(trade(0, 0, 100));
    ingestCandleMsg(trade(0, 30, 102));
    ingestCandleMsg(trade(1, 10, 101)); // second candle
    const { container } = render(<IndicatorOverlayCanvas chartMap={MAP} />);
    const host = container.querySelector('[data-testid="indi-overlay"]') as HTMLElement;
    expect(host.getAttribute('aria-hidden')).toBe('true');

    act(() => {
      useIndicatorStore.getState().add('vwap'); // defined from the FIRST candle — no warm-up
    });
    expect(host.getAttribute('aria-hidden')).toBe('false');

    act(() => {
      vi.advanceTimersByTime(600);
    });
    // Something painted: the loop stroked polyline paths (closed candle +
    // peeked forming candle through the deterministic map) and filled nothing
    // (no sub-pane indicator).
    expect(ctx.__calls.stroke).toBeGreaterThanOrEqual(1);
    expect(ctx.__calls.lineTo + ctx.__calls.moveTo).toBeGreaterThanOrEqual(2);
    expect(ctx.__calls.fillRect).toBe(0);
  });

  it('draws the sub-pane strip with labels for sub-pane indicators', () => {
    ingestCandleMsg(depthCol());
    // One print per MINUTE: 39 closed candles + the forming one, enough for
    // RSI(14) to leave its warm-up and give the lane a value range.
    for (let i = 0; i < 40; i += 1) ingestCandleMsg(trade(i, 0, 100 + (i % 5)));
    render(<IndicatorOverlayCanvas chartMap={MAP} />);
    act(() => {
      useIndicatorStore.getState().add('rsi');
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    // The strip: a translucent background fill, separator strokes, and text
    // (scale labels + lane title + latest value).
    expect(ctx.__calls.fillRect).toBeGreaterThanOrEqual(1);
    expect(ctx.__calls.fillText).toBeGreaterThanOrEqual(3);
    expect(ctx.__calls.stroke).toBeGreaterThanOrEqual(1);
  });

  it('gates repainting on the signature: an idle chart stops calling the 2D context', () => {
    ingestCandleMsg(depthCol());
    ingestCandleMsg(trade(0, 0, 100));
    render(<IndicatorOverlayCanvas chartMap={MAP} />);
    act(() => {
      useIndicatorStore.getState().add('vwap');
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const strokesAfterPaint = ctx.__calls.stroke;
    expect(strokesAfterPaint).toBeGreaterThanOrEqual(1);
    act(() => {
      vi.advanceTimersByTime(600); // idle: no candles, no camera change
    });
    expect(ctx.__calls.stroke).toBe(strokesAfterPaint); // no repaint storm
  });

  it('repaints when the camera moves (chartMap output changes)', () => {
    ingestCandleMsg(depthCol());
    ingestCandleMsg(trade(0, 0, 100));
    let shift = 0;
    const movingMap: ChartMapPair = {
      fromChart: MAP.fromChart,
      toChart: (col, row) => ({ x: col * 10 + shift, y: 100 - row * 2 }),
    };
    render(<IndicatorOverlayCanvas chartMap={movingMap} />);
    act(() => {
      useIndicatorStore.getState().add('vwap');
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const after1 = ctx.__calls.stroke;
    act(() => {
      shift = 55; // pan the chart
      vi.advanceTimersByTime(600);
    });
    expect(ctx.__calls.stroke).toBeGreaterThan(after1);
  });
});
