import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Renderer } from './renderer';
import { makeFake2D, makeFakeGL, type FakeGL } from './mockGL';
import { clearColorForRamp } from './lut';
import { MsgType, MODE_L2, type DepthColumn } from '../proto/types';
import type { StreamMsg } from '../net/connection';

/**
 * Renderer unit tests over a RECORDING fake GL (see mockGL.ts). Pixels are the
 * browser e2e's job (testHook.ts); these pin the CPU behavior around the GL
 * calls: which columns fold into the normalizer, whether one GL error kills the
 * rAF loop, what the clear color is, and the snapshot() contract.
 */

const ROWS = 8;
const DT_NS = 25_000_000;

function makeCol(seq: number, final: boolean, rows = ROWS): DepthColumn {
  const bid = new Float32Array(rows);
  bid[3] = 5;
  const ask = new Float32Array(rows);
  ask[4] = 7;
  return {
    type: MsgType.DEPTH_COL,
    epoch: 0,
    col_seq: seq,
    t0_ns: BigInt(seq) * BigInt(DT_NS),
    mode: MODE_L2,
    final,
    bid,
    ask,
  };
}

interface FakeStore {
  state: Record<string, unknown> & {
    onStream: (cb: (m: StreamMsg) => void) => () => void;
  };
  emit: (m: StreamMsg) => void;
  getState: () => unknown;
}

function makeStore(): FakeStore {
  const listeners: Array<(m: StreamMsg) => void> = [];
  const state = {
    sessionId: 'sess-1',
    gridEpoch: 0,
    normSeed: 0,
    capability: { depth: 'L2' },
    epochs: new Map([
      [0, { epoch: 0, tick: 0.5, tick_multiple: 1, dt_ns: DT_NS, p0: 100, rows: ROWS }],
    ]),
    onStream: (cb: (m: StreamMsg) => void): (() => void) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    requestHistory: () => new Promise(() => undefined), // never resolves; not used here
  };
  return {
    state,
    emit: (m) => {
      for (const l of [...listeners]) l(m);
    },
    getState: () => state,
  };
}

describe('Renderer (fake GL harness)', () => {
  let gl: FakeGL;
  let rafQueue: Array<(ts: number) => void>;
  let asyncThrows: Array<() => void>;
  let restoreGetContext: () => void;

  function makeRenderer(capacityColsTarget = 512): { r: Renderer; canvas: HTMLCanvasElement; store: FakeStore } {
    const store = makeStore();
    const canvas = document.createElement('canvas');
    const r = new Renderer(canvas, {
      getState: () => store.state as never,
    }, { capacityColsTarget });
    return { r, canvas, store };
  }

  /** Run one rAF tick (the finally in frame() re-queues the next callback). */
  function pump(ts: number): void {
    const cb = rafQueue.shift();
    expect(cb, 'render loop scheduled a callback').toBeDefined();
    cb!(ts);
  }

  beforeEach(() => {
    gl = makeFakeGL();
    const fake2d = makeFake2D();
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function mockGetContext(this: HTMLCanvasElement, kind: string) {
        if (kind === '2d') return fake2d;
        if (kind === 'webgl2') return gl;
        return null;
      } as unknown as HTMLCanvasElement['getContext'],
    );
    restoreGetContext = () => spy.mockRestore();
    rafQueue = [];
    asyncThrows = [];
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: (ts: number) => void) => {
        rafQueue.push(cb);
        return rafQueue.length;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal(
      'setTimeout',
      vi.fn((cb: () => void) => {
        asyncThrows.push(cb);
        return 0;
      }),
    );
  });

  afterEach(() => {
    restoreGetContext();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // --- B-1: the normalizer folds FINAL columns exactly once --------------------

  it('folds only final columns, and a re-sent column id never double-counts', () => {
    const { r, store } = makeRenderer();

    // A forming edge column is re-sent every flush — none of those may fold.
    store.emit(makeCol(5, false));
    store.emit(makeCol(5, false));
    expect(r.normalizerForTest.totalSamples).toBe(0);

    // The final send folds exactly once (bid[3]=5 + ask[4]=7 → 2 samples).
    store.emit(makeCol(5, true));
    expect(r.normalizerForTest.totalSamples).toBe(2);

    // History pages overlap by design: the same final column re-arriving must
    // not fold again.
    store.emit(makeCol(5, true));
    expect(r.normalizerForTest.totalSamples).toBe(2);

    // A genuinely new final column folds.
    store.emit(makeCol(6, true));
    expect(r.normalizerForTest.totalSamples).toBe(4);
  });

  // --- B-6: the clear color IS the ramp's LUT entry 0 ---------------------------

  it('clears with the active ramp background (single source of truth, no reset flash)', () => {
    makeRenderer();
    const bg = clearColorForRamp();
    const clears = gl.callsOf('clearColor');
    expect(clears.length).toBeGreaterThan(0);
    for (const c of clears) {
      expect(c.args[0]).toBe(bg[0]);
      expect(c.args[1]).toBe(bg[1]);
      expect(c.args[2]).toBe(bg[2]);
      expect(c.args[3]).toBe(1);
    }
  });

  // --- B-3: one GL error must not kill the render loop --------------------------

  it('reschedules the rAF loop after a throwing draw and surfaces the error once', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));

    pump(16); // clean frame: draws, no error surfaced
    expect(asyncThrows.length).toBe(0);

    // Failing frame: the draw throws, the loop must still reschedule...
    gl.failDraw = true;
    store.emit(makeCol(1, true)); // re-dirty so the draw path runs again
    pump(32);
    expect(rafQueue.length).toBe(1); // finally() re-armed the loop
    // ...and the failure is surfaced exactly once (async re-throw).
    expect(asyncThrows.length).toBe(1);
    expect(() => asyncThrows[0]()).toThrow('simulated GL draw failure');

    // A persistently broken draw is NOT re-reported every frame.
    store.emit(makeCol(2, true));
    pump(48);
    expect(rafQueue.length).toBe(1);
    expect(asyncThrows.length).toBe(1);

    // A clean frame re-arms the guard: a NEW failure episode is reported.
    gl.failDraw = false;
    pump(64);
    gl.failDraw = true;
    store.emit(makeCol(3, true));
    pump(80);
    expect(asyncThrows.length).toBe(2);
    expect(r.drawCount).toBeGreaterThan(0);
  });

  it('keeps the store fanout alive when a DEPTH_COL ingest throws', () => {
    const { r, store } = makeRenderer();
    // After construction (initGL warns about the missing float ext), the spy
    // counts ONLY ingest warnings.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const bad = makeCol(0, true);
    Object.defineProperty(bad, 'bid', {
      get() {
        throw new Error('malformed column');
      },
    });
    expect(() => store.emit(bad)).not.toThrow();
    expect(() => store.emit(bad)).not.toThrow();
    // Warned once (suppressed after the first), never propagated to the fanout.
    expect(warn).toHaveBeenCalledTimes(1);

    // The stream still works: a good column flows through the whole path.
    store.emit(makeCol(0, true));
    expect(r.normalizerForTest.totalSamples).toBe(2);
    warn.mockRestore();
  });

  // --- B-7(d): the CPU column cache covers the ring (profile window honesty) ----

  it('keeps every resident column cached so the profile window matches residency', () => {
    const { r, store } = makeRenderer(4096); // ring 4096 > the old 2048 cache default
    const n = 2100;
    for (let s = 0; s < n; s++) store.emit(makeCol(s, true));

    const range = r.residentRange();
    expect(range).not.toBeNull();
    expect(r.residentBudgetCols).toBe(4096);
    // The old 2048-entry cache would have evicted [0..51] — the profile (and
    // the crosshair) would then silently under-report resident history.
    for (let c = range!.oldest; c <= range!.newest; c++) {
      expect(r.columnCacheForTest.has(c), `column ${c} cached`).toBe(true);
    }
  });

  // --- B-9: snapshot() -----------------------------------------------------------

  it('snapshot() forces a synchronous frame then returns the PNG data URL', () => {
    const { r, canvas, store } = makeRenderer();
    store.emit(makeCol(0, true));

    const toDataURL = vi.fn(() => 'data:image/png;base64,TEST');
    canvas.toDataURL = toDataURL as unknown as typeof canvas.toDataURL;
    const drawsBefore = gl.callsOf('drawArrays').length;

    const url = r.snapshot();
    expect(url).toBe('data:image/png;base64,TEST');
    expect(toDataURL).toHaveBeenCalledWith('image/png');
    // "Force one synchronous full frame": heatmap + overlays actually drew.
    expect(gl.callsOf('drawArrays').length).toBeGreaterThan(drawsBefore);
  });

  it('snapshot() returns null on a lost context without touching GL', () => {
    const { r, canvas } = makeRenderer();
    const toDataURL = vi.fn(() => 'data:image/png;base64,TEST');
    canvas.toDataURL = toDataURL as unknown as typeof canvas.toDataURL;
    const drawsBefore = gl.callsOf('drawArrays').length;

    gl.contextLost = true;
    expect(r.snapshot()).toBeNull();
    expect(gl.callsOf('drawArrays').length).toBe(drawsBefore);
    expect(toDataURL).not.toHaveBeenCalled();
  });
});
