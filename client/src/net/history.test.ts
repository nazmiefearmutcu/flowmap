import { describe, expect, it } from 'vitest';

import { HistoryLoader, type HistoryLoaderDeps } from './history';
import type { ResidentRange } from '../gl/tileRing';
import { MODE_L2, MsgType, type DepthColumn, type HistoryResponse } from '../proto/types';

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
