import { describe, expect, it } from 'vitest';

import { HistoryLoader, type HistoryLoaderDeps } from './history';
import type { ResidentRange } from '../gl/tileRing';
import { MODE_L2, MsgType, type DepthColumn, type HistoryResponse, type Marker } from '../proto/types';

/**
 * The T8 backfill range-computation + debounce logic is pure — driven here by a
 * fake `requestHistory` and a mutable resident window. No GL, no transport.
 */

const ROWS = 4;
const DT = 1000; // ns per column in the fake

function makeCol(colSeq: number, t0: bigint): DepthColumn {
  return {
    type: MsgType.DEPTH_COL,
    epoch: 0,
    col_seq: colSeq,
    t0_ns: t0,
    mode: MODE_L2,
    final: true,
    bid: new Float32Array(ROWS),
    ask: new Float32Array(ROWS),
  };
}

interface Harness {
  loader: HistoryLoader;
  win: { oldest: number; newest: number };
  spliced: number[];
  requests: { before_t: bigint; n: number }[];
}

/**
 * @param oldestAvailable server's oldest retained t0 (columns below it 404).
 * @param serverFloorSeq   lowest col_seq the fake server still has.
 */
function harness(
  oldestAvailable: bigint,
  serverFloorSeq = 0,
  budget = 256,
): Harness {
  const win = { oldest: 100, newest: 199 };
  const spliced: number[] = [];
  const requests: { before_t: bigint; n: number }[] = [];

  const deps: HistoryLoaderDeps = {
    requestHistory: (before_t, n): Promise<HistoryResponse> => {
      requests.push({ before_t, n });
      // Return up to n columns with t0 < before_t, down to the server floor.
      const cols: DepthColumn[] = [];
      for (let s = win.oldest - n; s < win.oldest; s++) {
        if (s < serverFloorSeq) continue;
        const t0 = BigInt(s * DT);
        if (t0 < before_t) cols.push(makeCol(s, t0));
      }
      return Promise.resolve({
        type: MsgType.HISTORY_RESP,
        req_id: 1,
        epoch: 0,
        oldest_available_t_ns: oldestAvailable,
        depth_cols: cols,
        bar_cols: [],
        markers: [],
        big_trades: [],
      });
    },
    spliceColumn: (col) => {
      spliced.push(col.col_seq);
      if (col.col_seq < win.oldest) win.oldest = col.col_seq;
    },
    residentRange: (): ResidentRange | null => ({
      oldest: win.oldest,
      newest: win.newest,
      count: win.newest - win.oldest + 1,
    }),
    budgetCols: () => budget,
    dtNs: () => DT,
  };

  return { loader: new HistoryLoader(deps), win, spliced, requests };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('HistoryLoader (T8 backfill)', () => {
  it('fires a HistoryRequest when the view pans left past the resident window', async () => {
    const h = harness(/* oldestAvailable */ -1_000_000n); // server has lots older
    h.loader.noteColumn(100, BigInt(100 * DT)); // seed exact t0 of oldest resident

    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    expect(h.loader.inFlight).toBe(true);
    expect(h.loader.requestCount).toBe(1);
    // before_t is the tracked t0 of the oldest resident column (exclusive).
    expect(h.requests[0].before_t).toBe(BigInt(100 * DT));

    await flush();
    expect(h.spliced.length).toBeGreaterThan(0);
    // Splices land at their true absolute col_seq, ending just below oldest(100).
    expect(Math.max(...h.spliced)).toBe(99);
    expect(h.win.oldest).toBeLessThan(100);
    expect(h.loader.inFlight).toBe(false);
  });

  it('coalesces overlapping requests (only one in flight)', async () => {
    const h = harness(-1_000_000n);
    h.loader.noteColumn(100, BigInt(100 * DT));

    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 }); // same frame-ish
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    expect(h.loader.requestCount).toBe(1);
    await flush();
    expect(h.loader.requestCount).toBe(1);
  });

  it('does NOT backfill on deep zoom-out (mip level-2 engaged)', () => {
    const h = harness(-1_000_000n);
    h.loader.noteColumn(100, BigInt(100 * DT));
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 2 });
    expect(h.loader.requestCount).toBe(0);
    expect(h.loader.inFlight).toBe(false);
  });

  it('does NOT backfill when the time span exceeds the full-res budget', () => {
    const h = harness(-1_000_000n, 0, /* budget */ 256);
    h.loader.noteColumn(100, BigInt(100 * DT));
    h.loader.ensureVisible({ leftCol: 0, span: 500, level: 0 }); // span > budget
    expect(h.loader.requestCount).toBe(0);
  });

  it('does NOT fire while still comfortably inside the resident window', () => {
    const h = harness(-1_000_000n);
    h.loader.noteColumn(100, BigInt(100 * DT));
    // leftCol 90 is within the prefetch margin of oldest(100) → no fetch yet.
    h.loader.ensureVisible({ leftCol: 90, span: 40, level: 0 });
    expect(h.loader.requestCount).toBe(0);
  });

  it('latches start-of-history when the server has nothing older', async () => {
    // Server floor at col 0, oldest_available = t0 of col 0.
    const h = harness(/* oldestAvailable */ 0n, /* serverFloorSeq */ 0);
    h.loader.noteColumn(100, BigInt(100 * DT));

    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    // Reached col 0 (t0 0 ≤ oldest_available 0) → exhausted, no more spinning.
    expect(h.loader.startOfHistory).toBe(true);

    const before = h.loader.requestCount;
    h.loader.ensureVisible({ leftCol: -50, span: 80, level: 0 });
    expect(h.loader.requestCount).toBe(before); // latched: does not re-request
  });

  it('latches start-of-history when a response comes back empty', async () => {
    // Server floor ABOVE the requested range → empty depth_cols.
    const h = harness(5_000_000n, /* serverFloorSeq */ 100);
    h.loader.noteColumn(100, BigInt(100 * DT));
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    expect(h.spliced.length).toBe(0);
    expect(h.loader.startOfHistory).toBe(true);
  });

  it('latches at absolute col_seq 0 when panned past the start of the stream', () => {
    const h = harness(-1_000_000n);
    h.win.oldest = 0; // resident window already reaches the first column
    // Pan the left edge clearly past col 0 (beyond the prefetch margin).
    h.loader.ensureVisible({ leftCol: -100, span: 40, level: 0 });
    expect(h.loader.requestCount).toBe(0);
    expect(h.loader.startOfHistory).toBe(true);
  });

  it('does NOT latch start-of-history during normal live follow (oldest 0)', () => {
    const h = harness(-1_000_000n);
    h.win.oldest = 0;
    h.win.newest = 40;
    // Following the live edge: the left edge is near the newest, not the oldest.
    h.loader.ensureVisible({ leftCol: 5, span: 30, level: 0 });
    expect(h.loader.startOfHistory).toBe(false);
    expect(h.loader.requestCount).toBe(0);
  });

  it('prefetch loads history toward the target but stops short of the ring budget', async () => {
    // Server has effectively unlimited older data; ask for far more than the ring.
    const h = harness(/* oldestAvailable */ -1_000_000_000n, /* serverFloorSeq */ -1_000_000, /* budget */ 256);
    h.loader.noteColumn(100, BigInt(100 * DT));

    await h.loader.prefetch(1_000_000); // absurd target → must clamp to budget − headroom

    const count = h.win.newest - h.win.oldest + 1;
    // Never fills past the ring budget (the live-edge-eviction guard)…
    expect(count).toBeLessThanOrEqual(256);
    // …and it DID load a meaningful chunk (near budget − RESIDENT_HEADROOM_COLS=32).
    expect(count).toBeGreaterThanOrEqual(200);
    // Stopped in a couple of pages, not the 64-page runaway cap.
    expect(h.loader.requestCount).toBeLessThan(4);
  });

  it('prefetch is a no-op for a non-positive target', async () => {
    const h = harness(-1_000_000n);
    await h.loader.prefetch(0);
    expect(h.loader.requestCount).toBe(0);
  });

  it('derives before_t from oldest-known t0 minus k·dt when the exact t0 is absent', async () => {
    const h = harness(-1_000_000n);
    // Only a NEWER column's t0 is known; oldest resident (100) has no cached t0.
    h.loader.noteColumn(120, BigInt(120 * DT));
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    // before_t = t0(120) − (120−100)·dt = 100·dt.
    expect(h.requests[0].before_t).toBe(BigInt(100 * DT));
    await flush();
  });
});

describe('HistoryLoader — session reset + page hygiene', () => {
  it('reset() drops the SESSION-scoped state: a stale oldest-available bound must not kill the new session’s scroll-back', async () => {
    // Old session: the server floor IS the resident oldest → empty page →
    // start-of-history latched AND oldest_available = t0(100).
    const h = harness(BigInt(100 * DT), /* serverFloorSeq */ 100);
    h.loader.noteColumn(100, BigInt(100 * DT));
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    expect(h.loader.startOfHistory).toBe(true);
    expect(h.loader.requestCount).toBe(1);

    // A session switch hands the SAME loader a NEW session whose grid restarts
    // at col_seq 0 with its own server bound. reset() must clear the latch AND
    // the old session's oldest_available: without that, before_t (= t0(100))
    // ≤ the stale bound latches exhaustion and the new session never probes.
    h.loader.reset();
    expect(h.loader.startOfHistory).toBe(false);
    h.loader.noteColumn(100, BigInt(100 * DT)); // re-seeded by the next live write
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    expect(h.loader.requestCount).toBe(2);
    expect(h.loader.inFlight).toBe(true);
    await flush();
  });

  it('splices an out-of-order page ASCENDING (oldest first) regardless of arrival order', async () => {
    const spliced: number[] = [];
    const loader = new HistoryLoader({
      requestHistory: (): Promise<HistoryResponse> =>
        Promise.resolve({
          type: MsgType.HISTORY_RESP,
          req_id: 1,
          epoch: 0,
          oldest_available_t_ns: -1_000_000n,
          // A deviant server: the page arrives shuffled.
          depth_cols: [
            makeCol(98, BigInt(98 * DT)),
            makeCol(96, BigInt(96 * DT)),
            makeCol(99, BigInt(99 * DT)),
            makeCol(97, BigInt(97 * DT)),
          ],
          bar_cols: [],
          markers: [],
          big_trades: [],
        }),
      spliceColumn: (col) => spliced.push(col.col_seq),
      residentRange: () => ({ oldest: 100, newest: 199, count: 100 }),
      budgetCols: () => 256,
      dtNs: () => DT,
    });
    loader.noteColumn(100, BigInt(100 * DT));

    loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    expect(spliced).toEqual([96, 97, 98, 99]);
    expect(loader.startOfHistory).toBe(false); // floor far below — not exhausted
  });

  it('a transient failure does NOT latch exhaustion — the next pan retries and success clears the error', async () => {
    let fail = true;
    const spliced: number[] = [];
    const loader = new HistoryLoader({
      requestHistory: (before_t): Promise<HistoryResponse> => {
        if (fail) return Promise.reject(new Error('history request 7 timed out'));
        return Promise.resolve({
          type: MsgType.HISTORY_RESP,
          req_id: 7,
          epoch: 0,
          oldest_available_t_ns: -1_000_000n,
          depth_cols: [makeCol(Number(before_t) / DT - 1, before_t - BigInt(DT))],
          bar_cols: [],
          markers: [],
          big_trades: [],
        });
      },
      spliceColumn: (col) => spliced.push(col.col_seq),
      residentRange: () => ({ oldest: 100, newest: 199, count: 100 }),
      budgetCols: () => 256,
      dtNs: () => DT,
    });
    loader.noteColumn(100, BigInt(100 * DT));

    loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    expect(loader.error).toMatch(/timed out/);
    expect(loader.startOfHistory).toBe(false); // NOT latched on a transient error
    expect(loader.inFlight).toBe(false); // channel freed for a retry

    fail = false;
    loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    expect(loader.requestCount).toBe(2);
    expect(spliced).toEqual([99]);
    expect(loader.error).toBeNull(); // success clears the stale error
  });
});

// --- repaired-skip band refetch (F24) ------------------------------------------
// A server tx_lag drop evicts only THIS client's queue; the columns stay in the
// session grid ring and `history(before_t)` still serves them. The renderer's
// repair zeroes the skipped band; this refetch replaces the zeroes with the
// real columns when the server still holds them (bounded, single-flight, and a
// no-op fallback — the zeroes stay — on failure or an empty page).

describe('HistoryLoader — repaired-skip band refetch (F24)', () => {
  interface BandHarness {
    loader: HistoryLoader;
    spliced: number[];
    requests: { before_t: bigint; n: number }[];
    flushCount: () => number;
    release: () => void;
  }

  /** Fake server: a dense store of columns at t0 = seq·DT down to `floor`. */
  function bandHarness(floor: number, hold = false): BandHarness {
    let releaseFn: (() => void) | null = null;
    const gate = hold ? new Promise<void>((res) => { releaseFn = res; }) : null;
    const spliced: number[] = [];
    const requests: { before_t: bigint; n: number }[] = [];
    let flushes = 0;
    const loader = new HistoryLoader({
      requestHistory: (before_t, n): Promise<HistoryResponse> => {
        requests.push({ before_t, n });
        // The server's exclusive page: the n newest columns with t0 < before_t,
        // ascending (like the real grid ring).
        const cols: DepthColumn[] = [];
        for (let s = Number(before_t / BigInt(DT)) - 1; s >= floor && cols.length < n; s--) {
          cols.push(makeCol(s, BigInt(s * DT)));
        }
        cols.reverse();
        const resp: HistoryResponse = {
          type: MsgType.HISTORY_RESP,
          req_id: 1,
          epoch: 0,
          oldest_available_t_ns: BigInt(floor * DT),
          depth_cols: cols,
          bar_cols: [],
          markers: [],
          big_trades: [],
        };
        return gate ? gate.then(() => resp) : Promise.resolve(resp);
      },
      spliceColumn: (col) => spliced.push(col.col_seq),
      residentRange: () => ({ oldest: 200, newest: 299, count: 100 }),
      budgetCols: () => 512,
      dtNs: () => DT,
      onSpliced: () => {
        flushes++;
      },
    });
    return { loader, spliced, requests, flushCount: () => flushes, release: () => releaseFn?.() };
  }

  it('splices ONLY the missing band, ascending, anchored at the post-band column', async () => {
    const h = bandHarness(0);
    // Band 50..53 was dropped; col 54 arrived live with t0 = 54·DT.
    h.loader.refetchBand(50, 53, BigInt(54 * DT));
    await flush();

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].before_t).toBe(BigInt(54 * DT));
    // Older page members (below 50) are NOT re-spliced here, and the order is
    // ascending (each lands adjacent to the window).
    expect(h.spliced).toEqual([50, 51, 52, 53]);
  });

  it('is single-flight and processes a band arriving mid-refetch (one pending slot)', async () => {
    const h = bandHarness(0, true);
    h.loader.refetchBand(50, 53, BigInt(54 * DT)); // holds on the gate
    h.loader.refetchBand(55, 57, BigInt(58 * DT)); // arrives while in flight → pending
    expect(h.requests).toHaveLength(1);

    h.release();
    await flush();
    await flush();
    expect(h.requests).toHaveLength(2); // the pending band ran right after
    // Each band was covered exactly (they are disjoint here: col 54 is the
    // anchor of the first band, already resident — never part of any drop).
    expect(new Set(h.spliced)).toEqual(new Set([50, 51, 52, 53, 55, 56, 57]));
    expect(h.flushCount()).toBe(2); // one mip flush per completed page walk
  });

  it('walks multiple pages for a band wider than one page (≤3 pages)', async () => {
    const h = bandHarness(0);
    // A 300-column band (1..300): page 1 returns 256 cols (45..300), page 2 the
    // rest (1..44).
    h.loader.refetchBand(1, 300, BigInt(301 * DT));
    await flush();
    await flush();
    await flush();
    expect(h.requests.length).toBeLessThanOrEqual(3);
    expect(h.spliced.length).toBe(300);
    expect([...h.spliced].sort((a, b) => a - b)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
  });

  it('an empty page (server no longer holds the band) keeps the zeroes and stops', async () => {
    const h = bandHarness(100); // server floor ABOVE the band
    h.loader.refetchBand(50, 53, BigInt(54 * DT));
    await flush();
    expect(h.spliced).toEqual([]);
  });

  it('a transient failure leaves the zeroes, never throws, and a later band still refetches', async () => {
    let fail = true;
    const spliced: number[] = [];
    const loader = new HistoryLoader({
      requestHistory: (before_t): Promise<HistoryResponse> => {
        if (fail) return Promise.reject(new Error('history request timed out'));
        const cols: DepthColumn[] = [];
        for (let s = Number(before_t / BigInt(DT)) - 1; s >= 0 && cols.length < 8; s--) cols.push(makeCol(s, BigInt(s * DT)));
        cols.reverse();
        return Promise.resolve({
          type: MsgType.HISTORY_RESP,
          req_id: 2,
          epoch: 0,
          oldest_available_t_ns: 0n,
          depth_cols: cols,
          bar_cols: [],
          markers: [],
          big_trades: [],
        });
      },
      spliceColumn: (col) => spliced.push(col.col_seq),
      residentRange: () => ({ oldest: 200, newest: 299, count: 100 }),
      budgetCols: () => 512,
      dtNs: () => DT,
    });

    loader.refetchBand(50, 53, BigInt(54 * DT));
    await flush();
    expect(spliced).toEqual([]);
    expect(loader.error).toMatch(/timed out/);

    fail = false;
    loader.refetchBand(60, 62, BigInt(63 * DT));
    await flush();
    expect(spliced).toEqual([60, 61, 62]);
  });
});

// --- page seam honesty + stale anchor prune (QA3 C-1) -------------------------
// A history page can belong to a DIFFERENT grid than the resident window (a
// reconstructed page, a session replacement under the same subscription). The
// loader must (a) surface the seq→time break as a gap Marker on the response
// the renderer forwards, and (b) re-seed its (col_seq→t0) anchors when the map
// is re-anchored, so the OLD grid's exhaustion latch can't kill scroll-back.

describe('HistoryLoader — page seam honesty (QA3 C-1)', () => {
  const ANCHOR = 1000;

  interface PageHarness {
    loader: HistoryLoader;
    win: { oldest: number; newest: number };
    spliced: number[];
    requests: { before_t: bigint; n: number }[];
    resp: () => HistoryResponse | null;
  }

  function pageHarness(opts: {
    cols: () => DepthColumn[];
    markers?: HistoryResponse['markers'];
    oldest?: number;
    dt?: number;
  }): PageHarness {
    const win = { oldest: opts.oldest ?? ANCHOR, newest: (opts.oldest ?? ANCHOR) + 99 };
    const spliced: number[] = [];
    const requests: { before_t: bigint; n: number }[] = [];
    let lastResp: HistoryResponse | null = null;
    const loader = new HistoryLoader({
      requestHistory: (before_t, n): Promise<HistoryResponse> => {
        requests.push({ before_t, n });
        return Promise.resolve({
          type: MsgType.HISTORY_RESP,
          req_id: 1,
          epoch: 0,
          oldest_available_t_ns: -1_000_000n,
          depth_cols: opts.cols(),
          bar_cols: [],
          markers: opts.markers ? [...opts.markers] : [],
          big_trades: [],
        });
      },
      spliceColumn: (col) => {
        spliced.push(col.col_seq);
        if (col.col_seq < win.oldest) win.oldest = col.col_seq;
      },
      residentRange: () => ({ oldest: win.oldest, newest: win.newest, count: win.newest - win.oldest + 1 }),
      budgetCols: () => 256,
      dtNs: () => opts.dt ?? DT,
      onSpliced: (resp) => {
        lastResp = resp;
      },
    });
    loader.noteColumn(win.oldest, BigInt(win.oldest * DT));
    return { loader, win, spliced, requests, resp: () => lastResp };
  }

  it('adds ONE gap Marker when a page runs time BACKWARD, and still splices', async () => {
    const seamTs = BigInt(996 * DT) - 2_000_000_000n; // 2 s backward at col 996
    const cols = () => {
      const out: DepthColumn[] = [];
      for (let s = 990; s <= 999; s++) {
        out.push(makeCol(s, s === 996 ? seamTs : BigInt(s * DT)));
      }
      return out;
    };
    const h = pageHarness({ cols });

    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();

    expect(h.spliced).toEqual([990, 991, 992, 993, 994, 995, 996, 997, 998, 999]);
    const resp = h.resp();
    expect(resp).not.toBeNull();
    const synthetic = resp!.markers.filter((m) => m.text.startsWith('history page seam'));
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]).toMatchObject({ type: MsgType.MARKER, kind: 'gap', ts_ns: seamTs });
  });

  it('a clean page (anchor-consistent cadence) gets NO synthetic marker', async () => {
    const cols = () => {
      const out: DepthColumn[] = [];
      for (let s = 990; s <= 999; s++) out.push(makeCol(s, BigInt(s * DT)));
      return out;
    };
    const h = pageHarness({ cols });
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    expect(h.resp()!.markers).toHaveLength(0);
  });

  it('does not duplicate a server gap marker that already sits on the seam', async () => {
    const seamTs = BigInt(996 * DT) - 2_000_000_000n;
    const cols = () => {
      const out: DepthColumn[] = [];
      for (let s = 990; s <= 999; s++) {
        out.push(makeCol(s, s === 996 ? seamTs : BigInt(s * DT)));
      }
      return out;
    };
    const serverMarker: Marker = {
      type: MsgType.MARKER,
      ts_ns: seamTs + 500n,
      kind: 'gap',
      text: 'backfill: reconstructed history ends, live resumes',
      price: null,
      size: null,
    };
    const h = pageHarness({ cols, markers: [serverMarker] });
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    const resp = h.resp()!;
    expect(resp.markers).toHaveLength(1); // the server's own marker only
    expect(resp.markers[0].text).toContain('backfill');
  });

  it('marks a page↔anchor grid mismatch at the resumption side', async () => {
    // The page is internally clean but its t0s are on the OLD grid's scale:
    // 999 columns × DT above where the resident window's t0 base sits.
    const cols = () => {
      const out: DepthColumn[] = [];
      for (let s = 990; s <= 999; s++) out.push(makeCol(s, BigInt(s * DT) + 3_600_000_000_000n));
      return out;
    };
    const h = pageHarness({ cols });
    h.loader.ensureVisible({ leftCol: 0, span: 80, level: 0 });
    await flush();
    const resp = h.resp()!;
    const synthetic = resp.markers.filter((m) => m.text.includes('page grid mismatch'));
    expect(synthetic).toHaveLength(1);
    // Resumption side = the resident anchor's t0.
    expect(synthetic[0].ts_ns).toBe(BigInt(ANCHOR * DT));
  });

  it('prunes a stale exhaustion latch when the seq→time map is re-anchored', async () => {
    // Empty page → start-of-history latched on the OLD grid.
    const h = pageHarness({ cols: () => [], oldest: 260 });
    h.loader.ensureVisible({ leftCol: 0, span: 50, level: 0 });
    await flush();
    expect(h.loader.startOfHistory).toBe(true);
    expect(h.loader.requestCount).toBe(1);

    // Same-subscription session replacement: col_seq 260 now carries a NEW t0.
    h.loader.noteColumn(260, 26_000_000_000n);
    expect(h.loader.startOfHistory).toBe(false); // stale latch pruned

    h.loader.ensureVisible({ leftCol: 0, span: 50, level: 0 });
    await flush();
    expect(h.loader.requestCount).toBe(2); // scroll-back works on the new grid
    expect(h.requests[1].before_t).toBe(26_000_000_000n); // new anchor, not the old
  });
});
