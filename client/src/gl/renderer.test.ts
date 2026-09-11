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

  // --- C2: depth channel modes ---------------------------------------------------

  /** The u_channel value of every heatmap draw since `before`. */
  function channelValues(before: number): number[] {
    return gl
      .callsOf('uniform1i')
      .slice(before)
      .filter((c) => (c.args[0] as { uniform?: string } | null)?.uniform === 'u_channel')
      .map((c) => c.args[1] as number);
  }

  it('C2: the default channel is sum (u_channel 0) on every draw', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    const before = gl.callsOf('uniform1i').length;
    store.emit(makeCol(1, true));
    pump(16);
    expect(r.getDepthChannel()).toBe('sum');
    expect(channelValues(before)).toEqual([0]);
  });

  it('C2: setDepthChannel cycles u_channel; invalid values fall back to sum', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    let before = gl.callsOf('uniform1i').length;

    r.setDepthChannel('bid');
    expect(r.getDepthChannel()).toBe('bid');
    pump(32);
    expect(channelValues(before)).toEqual([1]);

    before = gl.callsOf('uniform1i').length;
    r.setDepthChannel('ask');
    r.setDepthChannel('imbalance');
    pump(48);
    // One draw between captures renders the LATEST setter value.
    expect(channelValues(before)).toEqual([3]);

    // A settings-persisted garbage value never poisons the shader.
    before = gl.callsOf('uniform1i').length;
    r.setDepthChannel('nonsense' as never);
    expect(r.getDepthChannel()).toBe('sum');
    pump(64);
    expect(channelValues(before)).toEqual([0]);
  });

  it('C2 honesty: a SYNTH session forces u_channel 0 whatever the user picked', () => {
    const { r, store } = makeRenderer();
    store.state.capability = { depth: 'SYNTH' }; // §7 honesty tier
    store.emit(makeCol(0, true)); // MODE_L2 column, but capability says SYNTH
    r.setDepthChannel('imbalance');
    const before = gl.callsOf('uniform1i').length;
    store.emit(makeCol(1, true));
    pump(16);
    expect(r.getDepthChannel()).toBe('imbalance'); // the SETTING is remembered...
    expect(channelValues(before)).toEqual([0]); // ...but SYNTH renders sum
  });

  // --- C3: renderer.stats() ------------------------------------------------------

  it('C3: stats() EMA-converges fps, counts uploads/draws, and reports cache bytes', () => {
    const { r, store } = makeRenderer();
    const s0 = r.stats();
    expect(s0.fps).toBe(0); // no frame yet
    expect(s0.frameMs).toBe(0);
    expect(s0.uploads).toBe(0);
    expect(s0.draws).toBe(0);
    expect(s0.cacheBytes).toBeGreaterThan(0); // slot metadata (pool fills on put)

    const n = 12;
    for (let s = 0; s < n; s++) store.emit(makeCol(s, true));
    expect(r.stats().uploads).toBe(n);

    let ts = 1000;
    for (let f = 0; f < 60; f++) {
      pump(ts);
      ts += 16.667; // 60 fps rAF cadence
    }
    const s1 = r.stats();
    expect(s1.fps).toBeGreaterThan(55); // converged near 60
    expect(s1.fps).toBeLessThanOrEqual(60);
    expect(s1.frameMs).toBeGreaterThanOrEqual(0);
    expect(s1.draws).toBeGreaterThan(0);
    expect(s1.cacheBytes).toBeGreaterThan(0);
    const draws1 = s1.draws;

    // A hung tab (delta > 1 s) is skipped, not folded in as a fake 1 fps.
    pump(ts + 5000);
    expect(r.stats().fps).toBeGreaterThan(55);

    // Cumulative counters stay monotonic.
    expect(r.stats().draws).toBeGreaterThanOrEqual(draws1);
  });

  it('C3: cacheBytes grows only PAGE-WISE and is fixed once the touched pages stop growing', () => {
    // Paged pool (fix 2026-09-10 F1-1): pages of 256 slots allocate once on
    // first touch; re-puts / ring wraps inside resident pages never allocate.
    const { r, store } = makeRenderer(512);
    for (let s = 0; s < 100; s++) store.emit(makeCol(s, true)); // page 0 only
    const bytes = r.stats().cacheBytes;
    for (let s = 100; s < 250; s++) store.emit(makeCol(s, true)); // still page 0
    expect(r.stats().cacheBytes).toBe(bytes);
    for (let s = 250; s < 700; s++) store.emit(makeCol(s, true)); // touches page 1, then wraps
    expect(r.stats().cacheBytes).toBeGreaterThan(bytes); // one extra page max
    const capped = r.stats().cacheBytes;
    for (let s = 700; s < 1200; s++) store.emit(makeCol(s, true)); // wrap within 2 pages
    expect(r.stats().cacheBytes).toBe(capped);
  });

  // --- survey #6a: the normalization memo -----------------------------------------

  it('repeated dirty frames with an unchanged window do NOT re-merge tile histograms', () => {
    const { r, store } = makeRenderer();
    for (let s = 0; s < 4; s++) store.emit(makeCol(s, true));
    pump(100); // first draw: the merge actually runs once
    const norm = r.normalizerForTest;
    const mergesAfterFold = norm.mergeCount;
    expect(mergesAfterFold).toBeGreaterThan(0);

    // Redraw the same view several times: the memo must hold.
    for (let f = 0; f < 5; f++) pump(120 + f * 16);
    expect(norm.mergeCount).toBe(mergesAfterFold);

    // A NEW final column folds (tilesVersion bump) → the next frame re-merges.
    store.emit(makeCol(5, true));
    pump(220);
    expect(norm.mergeCount).toBeGreaterThan(mergesAfterFold);
  });

  // --- campaign 4: tick grouping, prune guard, restore, frame ms, view seam -----

  /** The value of the LAST uniform1i call for a named uniform (GL transcript). */
  function lastUniform(name: string): unknown {
    const calls = gl
      .callsOf('uniform1i')
      .filter((c) => (c.args[0] as { uniform?: string } | null)?.uniform === name);
    return calls.length > 0 ? calls[calls.length - 1].args[1] : undefined;
  }

  /** A 512-row epoch so the mip-capable (rows % 16 === 0) path is active. */
  function setEpochRows(store: FakeStore, rows: number): void {
    (store.state as unknown as { epochs: Map<number, Record<string, unknown>> }).epochs.set(0, {
      epoch: 0,
      tick: 0.5,
      tick_multiple: 1,
      dt_ns: DT_NS,
      p0: 100,
      rows,
    });
  }

  it('P1: tickGrouping floors the mip level; n=1 restores the natural selection', () => {
    gl = makeFakeGL({ colorBufferFloat: true }); // mips exist → levels 0/1/2
    const { r, store } = makeRenderer();
    setEpochRows(store, 512);
    store.emit(makeCol(0, true, 512));
    pump(16);
    // Default: the natural selection (rowsPerPixel ≈ 2.1 → level 0).
    expect(r.getTickGrouping()).toBe(1);
    expect(lastUniform('u_level')).toBe(0);
    expect(lastUniform('u_blk')).toBe(1);

    // n=4 → the 4-row block; n=16 → the 16-row block.
    r.setTickGrouping(4);
    store.emit(makeCol(1, true, 512));
    pump(32);
    expect(lastUniform('u_level')).toBe(1);
    expect(lastUniform('u_blk')).toBe(4);

    r.setTickGrouping(16);
    store.emit(makeCol(2, true, 512));
    pump(48);
    expect(lastUniform('u_level')).toBe(2);
    expect(lastUniform('u_blk')).toBe(16);
    expect(r.currentMipLevel).toBe(2);

    // The crosshair reports the TRUE displayed block (group-consistent).
    r.setViewForTest(0, 64, 0, 512);
    const px = r.cellToCanvasCss(10, 200);
    expect(r.probeAt(px.x, px.y)?.group).toBe(16);

    // Non-power-of-4 requests round UP to the next mip block (4^k only): 2 → 4.
    r.setTickGrouping(2);
    store.emit(makeCol(3, true, 512));
    pump(64);
    expect(lastUniform('u_level')).toBe(1);
    expect(lastUniform('u_blk')).toBe(4);

    // Clamp + n=1 identity: the coarsest representable block wins (R1-L2).
    r.setTickGrouping(999);
    expect(r.getTickGrouping()).toBe(16);
    r.setTickGrouping(1);
    store.emit(makeCol(4, true, 512));
    pump(80);
    expect(lastUniform('u_level')).toBe(0);
    expect(lastUniform('u_blk')).toBe(1);
  });

  it('P1: the tick-grouping floor does NOT suppress history backfill', () => {
    gl = makeFakeGL({ colorBufferFloat: true });
    const { r, store } = makeRenderer();
    setEpochRows(store, 512);
    for (let s = 0; s < 8; s++) store.emit(makeCol(s, true, 512));
    pump(16);
    // `history` is private; a spy on ensureVisible is the only way to observe
    // the O(1) backfill gate's level argument.
    const hist = (
      r as unknown as { history: { ensureVisible: (v: { level: number }) => void } }
    ).history;
    const ensure = vi.spyOn(hist, 'ensureVisible');

    r.setTickGrouping(16); // display level 2
    r.setViewForTest(0, 64, 0, 512); // natural level 0 (rowsPerPixel ≈ 2.1)
    pump(32);

    expect(ensure).toHaveBeenCalled();
    const lastCall = ensure.mock.calls[ensure.mock.calls.length - 1][0];
    // The gate tracks the NATURAL zoom level, not the forced display block: a
    // grouped view still needs resident columns for the crosshair/profile and
    // for its own mip generation.
    expect(lastCall.level).toBe(0);
    // …while the display (and probeAt) really are at the forced level.
    expect(r.currentMipLevel).toBe(2);
  });

  it('B-2: overlay prune is skipped until the window edge moves beyond the pad', () => {
    const { r, store } = makeRenderer();
    const overlays = (r as unknown as { overlays: { prune: (...a: number[]) => void } }).overlays;
    const spy = vi.spyOn(overlays, 'prune');

    store.emit(makeCol(0, true));
    expect(spy).toHaveBeenCalledTimes(1); // first window: one sweep

    // The forming edge re-sends the SAME column: the window is static → skip.
    for (let i = 0; i < 40; i++) store.emit(makeCol(0, false));
    expect(spy).toHaveBeenCalledTimes(1);

    // Slide the newest edge past the pad (64) → exactly one more sweep.
    for (let s = 1; s <= 65; s++) store.emit(makeCol(s, true));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][2]).toBe(64); // the pad is passed explicitly
  });

  it('B-4: context restore keeps the user follow intent instead of re-arming it', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    pump(16);

    r.setFollowTime(false);
    pump(32);
    expect(r.following).toBe(false);
    expect(r.priceFollow).toBe('track'); // time release promotes fit → track

    // The webglcontextrestored handler (private; e2e drives it via loseContextForTest).
    (r as unknown as { onContextRestored(): void }).onContextRestored();
    expect(r.contextRestoredCount).toBe(1);
    // Before the fix this was silently true again while the UI showed OFF.
    expect(r.following).toBe(false);
    expect(r.priceFollow).toBe('track');
  });

  it('B-5: stats().frameMs measures the FULL frame — the overlay pass included', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    const overlays = (r as unknown as { overlays: { draw: (ctx: unknown) => void } }).overlays;
    const drawSpy = vi.spyOn(overlays, 'draw');

    let reads = 0;
    let overlaysDrawnBySpanEnd = false;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
      reads += 1;
      if (reads === 1) return 1000; // t0
      // The span END read: the overlay pass must already have run for the HUD
      // sample to include it (reverting to the old order makes this false).
      overlaysDrawnBySpanEnd = drawSpy.mock.calls.length > 0;
      return 1007;
    });
    pump(16);
    nowSpy.mockRestore();

    expect(drawSpy).toHaveBeenCalled(); // overlays actually drew
    expect(overlaysDrawnBySpanEnd).toBe(true);
    expect(r.stats().frameMs).toBeCloseTo(7, 5); // the whole frame, not just the heatmap
  });

  it('stretch: onViewChanged fires on camera moves, isolates throws, unsubscribes', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));

    let fired = 0;
    const off = r.onViewChanged(() => {
      fired += 1;
    });
    r.panColumnsForTest(-5);
    expect(fired).toBe(1);
    r.setViewForTest(0, 32, 0, 32);
    expect(fired).toBe(2);

    off();
    r.panColumnsForTest(-5);
    expect(fired).toBe(2);

    // A throwing listener is warned once and never breaks the camera move.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const off2 = r.onViewChanged(() => {
      throw new Error('bad listener');
    });
    expect(() => r.panColumnsForTest(-5)).not.toThrow();
    r.panColumnsForTest(-5);
    expect(warn).toHaveBeenCalledTimes(1); // report-once guard
    off2();
    warn.mockRestore();
  });
});
