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

  // --- W2 SEAMS: forward col_seq skips must not blank the whole chart -----------

  it('repairs a small forward skip by zeroing the band and keeping validFrom', () => {
    const { r, store } = makeRenderer();
    for (let s = 10; s <= 14; s++) store.emit(makeCol(s, true));
    expect(r.validFromSeq).toBe(10);
    const uploadsBefore = gl.callsOf('texSubImage3D').length;

    // A server tx_lag drop burst: cols 15..17 are gone; 18 arrives.
    store.emit(makeCol(18, true));

    expect(r.residentRange()).toEqual({ oldest: 10, newest: 18, count: 9 });
    expect(r.validFromSeq).toBe(10); // NOT 18 — the old behavior blacked out [10..17]
    const zeroUploads = gl.callsOf('texSubImage3D').slice(uploadsBefore, uploadsBefore + 3);
    expect(zeroUploads.length).toBe(3); // one zero texel column per skipped seq
    for (const call of zeroUploads) {
      const data = call.args[10] as Float32Array;
      expect(Array.from(data).every((v) => v === 0)).toBe(true);
    }
  });

  it('keeps the conservative gate for a skip larger than the repair cap', () => {
    const { r, store } = makeRenderer(); // capacity 512
    for (let s = 0; s <= 4; s++) store.emit(makeCol(s, true));
    store.emit(makeCol(1000, true)); // band 995 > GAP_ZERO_MAX_COLS
    expect(r.validFromSeq).toBe(1000);
  });

  // --- F24: a repaired skip band is refetched from the session grid ring ------

  /** Await the loader's async band refetch (requestHistory → splice loop). */
  const flushMicrotasks = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  it('refetches a repaired skip band from history and splices the REAL columns', async () => {
    const { r, store } = makeRenderer();
    for (let s = 10; s <= 14; s++) store.emit(makeCol(s, true));

    const calls: Array<{ before_t: bigint; n: number }> = [];
    store.state.requestHistory = (before_t: bigint, n: number) => {
      calls.push({ before_t, n });
      // The server evicted only OUR queue; it still holds the band — plus older
      // columns, exactly like its exclusive `history(before_t)` page.
      const depth_cols = [13, 14, 15, 16, 17].map((s) => makeCol(s, true));
      return Promise.resolve({
        type: MsgType.HISTORY_RESP,
        req_id: 1,
        epoch: 0,
        oldest_available_t_ns: 0n,
        depth_cols,
        bar_cols: [],
        markers: [],
        big_trades: [],
      });
    };

    // A server tx_lag drop burst: cols 15..17 are gone; 18 arrives.
    store.emit(makeCol(18, true));
    expect(r.validFromSeq).toBe(10); // the synchronous repair contract first

    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    expect(calls[0].before_t).toBe(BigInt(18) * BigInt(DT_NS)); // anchored at the post-band column
    // The zeroes were replaced by the real columns: they are cached/resident now.
    for (const s of [15, 16, 17]) expect(r.columnCacheForTest.has(s)).toBe(true);
    expect(r.validFromSeq).toBe(10); // in-place splices never move validity
  });

  it('a failed band refetch leaves the honest zeroes in place (no throw)', async () => {
    const { r, store } = makeRenderer();
    for (let s = 10; s <= 14; s++) store.emit(makeCol(s, true));
    store.state.requestHistory = () => Promise.reject(new Error('history request timed out'));

    expect(() => store.emit(makeCol(18, true))).not.toThrow();
    await flushMicrotasks();
    expect(r.validFromSeq).toBe(10);
    expect(r.columnCacheForTest.has(15)).toBe(false); // zeroes still the fallback
  });

  it('an empty band page (server no longer holds it) keeps the zeroes', async () => {
    const { r, store } = makeRenderer();
    for (let s = 10; s <= 14; s++) store.emit(makeCol(s, true));
    store.state.requestHistory = () =>
      Promise.resolve({
        type: MsgType.HISTORY_RESP,
        req_id: 1,
        epoch: 0,
        oldest_available_t_ns: 0n,
        depth_cols: [],
        bar_cols: [],
        markers: [],
        big_trades: [],
      });

    store.emit(makeCol(18, true));
    await flushMicrotasks();
    expect(r.validFromSeq).toBe(10);
    expect(r.columnCacheForTest.has(15)).toBe(false);
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
    // F10 (2026-09-14) moved ROW_MIP_EDGE 2.5 → 1.5 for the sampler coverage
    // fix; at this view (rowScale 512 over the harness buffer) the natural
    // selection is now the ROW-MIP path itself: level 0, blk 4, rowFade > 0.
    expect(lastUniform('u_level')).toBe(0);
    expect(lastUniform('u_blk')).toBe(4);
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

  // --- chart bug-fix campaign (2026-09-11): B2 renderer + follow ---------------

  interface PrivRenderer {
    trackedRowN: number | null;
    trackedEpoch: number | null;
    priceEpoch: number | null;
    forcedRemapFrom: unknown;
    lastPriceMapCache: unknown;
    overlayPriceMap(): unknown;
    camera: { remapPrice(rowCenter: number, rowSpan: number): void };
  }

  function priv(r: Renderer): PrivRenderer {
    return r as unknown as PrivRenderer;
  }

  function overlaysOf(r: Renderer): { reset: () => void; clearInk?: () => void } {
    return (r as unknown as { overlays: { reset: () => void } }).overlays;
  }

  function makeColAt(
    seq: number,
    epoch: number,
    bidRow: number,
    askRow: number,
    rows: number,
    t0?: bigint,
  ): DepthColumn {
    const bid = new Float32Array(rows);
    bid[bidRow] = 5;
    const ask = new Float32Array(rows);
    ask[askRow] = 7;
    return {
      type: MsgType.DEPTH_COL,
      epoch,
      col_seq: seq,
      t0_ns: t0 ?? BigInt(seq) * BigInt(DT_NS),
      mode: MODE_L2,
      final: true,
      bid,
      ask,
    };
  }

  it('B2-CP1: liveEdgeVisible follows the newest column, not the follow mode', () => {
    const { r, store } = makeRenderer();
    expect(r.liveEdgeVisible).toBe(false); // no column yet
    store.emit(makeCol(0, true));
    expect(r.liveEdgeVisible).toBe(true);
    r.panColumnsForTest(-100000); // scrolled back: edge off-screen, TRACK cannot act
    expect(r.following).toBe(false);
    expect(r.liveEdgeVisible).toBe(false);
    r.goLive();
    expect(r.liveEdgeVisible).toBe(true);
  });

  it('B2-CP1: resetOverlaysForNewSession rewinds cursors + clears ink but KEEPS the ring', () => {
    const { r, store } = makeRenderer();
    for (let s = 0; s < 5; s++) store.emit(makeCol(s, true));
    const overlays = overlaysOf(r);
    const resetSpy = vi.spyOn(overlays, 'reset');
    const inkSpy = vi.fn();
    overlays.clearInk = inkSpy;
    const range = r.residentRange();
    expect(range).not.toBeNull();

    r.resetOverlaysForNewSession();

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(inkSpy).toHaveBeenCalledTimes(1);
    expect(r.newestColSeq).toBe(-1);
    expect(priv(r).trackedRowN).toBeNull();
    // Cursor-only: the resident ring (scrolled-back history) survives.
    expect(r.residentRange()).toEqual(range);
    expect(r.isResidentFullRes(0)).toBe(true);
  });

  it('B2-H1/C3: resetForSession clears overlay ink + data even while the GL context is lost', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    const overlays = overlaysOf(r);
    const resetSpy = vi.spyOn(overlays, 'reset');
    const inkSpy = vi.fn();
    overlays.clearInk = inkSpy;

    gl.contextLost = true;
    r.resetForSession();

    expect(inkSpy).toHaveBeenCalledTimes(1); // BEFORE the glLost early return
    expect(resetSpy).toHaveBeenCalledTimes(1); // CPU teardown is unconditional now
    expect(r.newestColSeq).toBe(-1); // cursors rewound even while lost
  });

  it('B2-H2: recreateRingForRows clears the stale GL image when it rebuilds the ring', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    const clears = gl.callsOf('clear').length;
    (r as unknown as { recreateRingForRows(rows: number): void }).recreateRingForRows(64);
    expect(gl.callsOf('clear').length).toBeGreaterThan(clears);
  });

  it('B2-C2: drawOverlays clears leftover 2D ink when every overlay is off', () => {
    const { r, store } = makeRenderer();
    store.emit(makeCol(0, true));
    const overlays = overlaysOf(r);
    const inkSpy = vi.fn();
    overlays.clearInk = inkSpy;
    r.setOverlayVisibility({
      bubbles: false,
      bbo: false,
      vwap: false,
      profile: false,
      markers: false,
      axes: false,
      price: false,
      volume: false, // F26 lane's strip: an explicit off, or anyVisible stays true
    });
    (r as unknown as { drawOverlays(): void }).drawOverlays();
    expect(inkSpy).toHaveBeenCalledTimes(1);
  });

  it('B2-C2: drawOverlays clears ink when neither the price nor the time map exists', () => {
    const { r, store } = makeRenderer();
    const overlays = overlaysOf(r);
    const inkSpy = vi.fn();
    overlays.clearInk = inkSpy;
    (store.state as unknown as { gridEpoch: number | null }).gridEpoch = null; // no price affine
    (r as unknown as { drawOverlays(): void }).drawOverlays();
    expect(inkSpy).toHaveBeenCalledTimes(1);
  });

  it('B2-D3: tracked row is epoch-scoped — no wing corruption across an epoch change', () => {
    const { r, store } = makeRenderer();
    setEpochRows(store, 64);
    store.emit(makeColAt(0, 0, 3, 4, 64)); // epoch-0 book, inside quote rows 3/4
    expect(priv(r).trackedRowN).toBe(4);
    expect(priv(r).trackedEpoch).toBe(0);

    // The new epoch's first column arrives BEFORE its params are in the store:
    // remapPriceEpoch refuses to advance, and the tracked row must NOT be
    // recorded from a book whose affine is still unknown (the D3 incident).
    store.emit(makeColAt(1, 1, 30, 31, 64));
    expect(priv(r).priceEpoch).toBe(0); // no params → epoch not advanced
    expect(priv(r).trackedRowN).toBe(4); // still the old epoch's row
    expect(priv(r).trackedEpoch).toBe(0);

    // Params land. The stale row read through the new affine (p0 = −924) would
    // land at row 2052 of a 64-row grid — the exact wing-park. The fix drops
    // the invalid remap; this same column re-derives from the new book.
    (store.state as unknown as { epochs: Map<number, Record<string, unknown>> }).epochs.set(1, {
      epoch: 1,
      tick: 0.5,
      tick_multiple: 1,
      dt_ns: DT_NS,
      p0: -924,
      rows: 64,
    });
    store.emit(makeColAt(2, 1, 40, 40, 64)); // same-row two-sided → 40.5
    expect(priv(r).priceEpoch).toBe(1);
    expect(priv(r).trackedRowN).toBe(40.5);
    expect(priv(r).trackedEpoch).toBe(1);
  });

  it('B2-D3: a remap with an unknown/mismatched trackedEpoch drops the row', () => {
    const { r, store } = makeRenderer();
    setEpochRows(store, 64);
    store.emit(makeColAt(0, 0, 3, 4, 64));
    expect(priv(r).trackedRowN).toBe(4);
    priv(r).trackedEpoch = null; // legacy state with no epoch provenance
    (store.state as unknown as { epochs: Map<number, Record<string, unknown>> }).epochs.set(1, {
      epoch: 1,
      tick: 0.5,
      tick_multiple: 1,
      dt_ns: DT_NS,
      p0: 100,
      rows: 64,
    });
    (r as unknown as { remapPriceEpoch(epoch: number): void }).remapPriceEpoch(1);
    expect(priv(r).trackedRowN).toBeNull();
    expect(priv(r).trackedEpoch).toBeNull();
  });

  it('B2-D3: a remap that would clamp an interior row into a wing drops it instead', () => {
    const { r, store } = makeRenderer();
    setEpochRows(store, 64);
    store.emit(makeColAt(0, 0, 3, 4, 64));
    (store.state as unknown as { epochs: Map<number, Record<string, unknown>> }).epochs.set(1, {
      epoch: 1,
      tick: 0.5,
      tick_multiple: 1,
      dt_ns: DT_NS,
      p0: -924,
      rows: 64,
    });
    (r as unknown as { remapPriceEpoch(epoch: number): void }).remapPriceEpoch(1);
    // The old code clamped row 2052 → 64 (an off-grid wing); the fix drops it.
    expect(priv(r).trackedRowN).toBeNull();
  });

  it('B2-D5: a col_seq regression rewinds the overlay cursors (same-subscription restart)', () => {
    const { r, store } = makeRenderer(512); // ring capacity 512
    for (let s = 0; s < 600; s++) store.emit(makeCol(s, true));
    expect(r.newestColSeq).toBe(599);
    const overlays = overlaysOf(r);
    const resetSpy = vi.spyOn(overlays, 'reset');
    const inkSpy = vi.fn();
    overlays.clearInk = inkSpy;

    store.emit(makeCol(0, true)); // restarted col_seq: 0 + 512 < 599
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(inkSpy).toHaveBeenCalledTimes(1);
    expect(r.newestColSeq).toBe(0); // accepted as the new newest
  });

  it('B2-D5: a store sessionId change rewinds once, on the first column of the new session', () => {
    const { r, store } = makeRenderer();
    for (let s = 0; s < 5; s++) store.emit(makeCol(s, true));
    const overlays = overlaysOf(r);
    const resetSpy = vi.spyOn(overlays, 'reset');
    (store.state as unknown as { sessionId: string }).sessionId = 'sess-2';
    store.emit(makeCol(6, true));
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(r.newestColSeq).toBe(6);
    store.emit(makeCol(7, true));
    expect(resetSpy).toHaveBeenCalledTimes(1); // stable session → no further resets
  });

  it('B2-CP2: the piecewise t0 table reports real candle times for reconstructed history', () => {
    const { r, store } = makeRenderer();
    const candleNs = 60_000_000_000n;
    for (let s = 0; s < 4; s++) {
      store.emit(makeColAt(s, 0, 3, 4, ROWS, BigInt(s) * candleNs));
    }
    // The epoch says 25 ms/col; the table says 60 s/col (the S2/D1 time warp).
    expect(r.colToTsForTest(1)).toBe(candleNs);
    expect(r.colToTsForTest(3)).toBe(3n * candleNs);
    expect(r.colForTsForTest(2n * candleNs)).toBeCloseTo(2, 6);
    expect(r.colForTsForTest((3n * candleNs) / 2n)).toBeCloseTo(1.5, 6);
    const tm = (
      r as unknown as {
        overlayTimeMap(): { slots?: { startSeq: number; t0: Float64Array } } | null;
      }
    ).overlayTimeMap();
    expect(tm?.slots).toBeDefined();
    expect(tm!.slots!.startSeq).toBe(0);
    expect(tm!.slots!.t0[3]).toBe(180_000_000_000);
  });

  it('B2-CP2: the piecewise table is retired when the resident run wraps the ring', () => {
    const { r, store } = makeRenderer(512);
    for (let s = 0; s < 520; s++) store.emit(makeCol(s, true));
    expect((r as unknown as { overlaySlotsFor(): unknown }).overlaySlotsFor()).toBeNull();
    // …and the affine fallback still answers (honest, if time-warped).
    expect(r.colToTsForTest(r.newestColSeq)).not.toBeNull();
  });

  it('R1-M1: a warm attach (first column mid-sequence) still serves the piecewise table', () => {
    const { r, store } = makeRenderer(1024);
    const candleNs = 60_000_000_000n;
    // The client attaches to an already-running grid: the first accepted column
    // is 502, so nothing ever writes slot 0.
    for (let s = 502; s < 566; s++) {
      store.emit(makeColAt(s, 0, 3, 4, ROWS, BigInt(s) * candleNs));
    }
    expect(r.colToTsForTest(510)).toBe(510n * candleNs);
    const tm = (
      priv(r) as unknown as {
        overlayTimeMap(): { slots?: { startSeq: number; t0: Float64Array } } | null;
      }
    ).overlayTimeMap();
    expect(tm?.slots, 'warm attach must serve the slot table').toBeDefined();
    expect(tm!.slots!.startSeq).toBe(502);
  });

  it('R1-M2: same-numbered session replacement forces a price-preserving remap', () => {
    const { r, store } = makeRenderer();
    for (let s = 0; s < 4; s++) store.emit(makeCol(s, true));
    priv(r).overlayPriceMap(); // populate lastPriceMapCache (as a draw would)
    expect(priv(r).lastPriceMapCache).not.toBeNull();

    const cam = priv(r).camera;
    const spy = vi.spyOn(cam, 'remapPrice');
    // New server session: SAME epoch number (0), DIFFERENT params under it.
    (store.state as unknown as { epochs: Map<number, Record<string, unknown>> }).epochs.set(0, {
      epoch: 0,
      tick: 0.5,
      tick_multiple: 1,
      dt_ns: DT_NS,
      p0: 300,
      rows: ROWS,
    });
    (store.state as unknown as { sessionId: string }).sessionId = 'sess-2';
    r.resetOverlaysForNewSession('sess-2');
    store.emit(makeCol(0, true));

    expect(spy, 'the replacement must remap, not silently reinterpret').toHaveBeenCalledTimes(1);
    expect(priv(r).forcedRemapFrom).toBeNull();
    spy.mockRestore();
  });
});
