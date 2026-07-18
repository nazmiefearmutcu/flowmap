import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SocketLike } from '../net/connection';
import {
  MODE_L2,
  MsgType,
  SIDE_BUY,
  SIDE_SELL,
  SIDE_UNKNOWN,
  type BBO,
  type DepthColumn,
  type Trade,
} from '../proto/types';
import {
  TRADE_RING,
  THROTTLE_MS,
  getSnapshot,
  ingestForTest,
  resetForTest,
  subscribe,
} from './bookStore';
import { setFlowMapTransport, useFlowMapStore } from './store';

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'golden');

function goldenU8(name: string): Uint8Array {
  const b = readFileSync(join(GOLDEN_DIR, `${name}.bin`));
  return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

function depthCol(epoch: number, colSeq: number, bid: number[], ask: number[]): DepthColumn {
  return {
    type: MsgType.DEPTH_COL,
    epoch,
    col_seq: colSeq,
    t0_ns: BigInt(colSeq) * 1_000_000n,
    mode: MODE_L2,
    final: true,
    bid: new Float32Array(bid),
    ask: new Float32Array(ask),
  };
}

function trade(ts: number, price: number, size: number, side: number): Trade {
  return { type: MsgType.TRADE, ts_ns: BigInt(ts), price, size, side, side_src: 0, venue: 'sim' };
}

function bbo(bidPx: number, bidSz: number, askPx: number, askSz: number): BBO {
  return { type: MsgType.BBO, ts_ns: 1n, bid_px: bidPx, bid_sz: bidSz, ask_px: askPx, ask_sz: askSz };
}

class FakeWebSocket implements SocketLike {
  binaryType = 'blob';
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {
    this.onclose?.();
  }
  open(): void {
    this.onopen?.();
  }
  deliver(bytes: Uint8Array): void {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.onmessage?.({ data: copy.buffer });
  }
}

afterEach(() => {
  resetForTest();
  useFlowMapStore.getState().disconnect();
  setFlowMapTransport({});
  vi.useRealTimers();
});

describe('bookStore buffer', () => {
  it('keeps the NEWEST depth column as the current book', () => {
    ingestForTest(depthCol(1, 10, [1, 2, 3], [0, 0, 4]));
    ingestForTest(depthCol(1, 11, [5, 6, 7], [0, 0, 8]));
    const book = getSnapshot().book;
    expect(book?.colSeq).toBe(11);
    expect(Array.from(book?.bid ?? [])).toEqual([5, 6, 7]);
    expect(Array.from(book?.ask ?? [])).toEqual([0, 0, 8]);
    expect(book?.mode).toBe(MODE_L2);
  });

  it('ignores the in-progress PARTIAL column (final=false) as the current book', () => {
    ingestForTest(depthCol(1, 30, [1, 2, 3], [4, 5, 6])); // finalized settled book
    // The live-edge partial has a higher col_seq but is empty — must be skipped.
    const partial: DepthColumn = { ...depthCol(1, 31, [0, 0, 0], [0, 0, 0]), final: false };
    ingestForTest(partial);
    const book = getSnapshot().book;
    expect(book?.colSeq).toBe(30);
    expect(Array.from(book?.bid ?? [])).toEqual([1, 2, 3]);
  });

  it('ignores an out-of-order (older col_seq) column in the same epoch', () => {
    ingestForTest(depthCol(1, 20, [9, 9, 9], [1, 1, 1]));
    ingestForTest(depthCol(1, 15, [0, 0, 0], [0, 0, 0])); // stale — must be dropped
    expect(getSnapshot().book?.colSeq).toBe(20);
    expect(Array.from(getSnapshot().book?.bid ?? [])).toEqual([9, 9, 9]);
  });

  it('tracks the current BBO', () => {
    ingestForTest(bbo(99.5, 12, 100.5, 7));
    const b = getSnapshot().bbo;
    expect(b).toMatchObject({ bidPx: 99.5, bidSz: 12, askPx: 100.5, askSz: 7 });
  });

  it('bounds the trade ring and exposes trades NEWEST-first', () => {
    for (let i = 0; i < TRADE_RING + 50; i += 1) {
      ingestForTest(trade(i, 100 + i, 1, i % 2 === 0 ? SIDE_BUY : SIDE_SELL));
    }
    const trades = getSnapshot().trades;
    expect(trades.length).toBe(TRADE_RING);
    // Newest first: the last-ingested trade leads.
    const newest = TRADE_RING + 50 - 1;
    expect(trades[0].price).toBe(100 + newest);
    expect(trades[1].price).toBe(100 + newest - 1);
    // Oldest survivors dropped: the very first trades are gone.
    expect(trades[trades.length - 1].price).toBe(100 + 50);
  });

  it('carries SIDE_UNKNOWN through untouched', () => {
    ingestForTest(trade(1, 100, 3, SIDE_UNKNOWN));
    expect(getSnapshot().trades[0].side).toBe(SIDE_UNKNOWN);
  });

  it('returns a memoized snapshot until the buffer changes', () => {
    ingestForTest(trade(1, 100, 1, SIDE_BUY));
    const a = getSnapshot();
    expect(getSnapshot()).toBe(a); // same object, no rebuild
    ingestForTest(trade(2, 101, 1, SIDE_SELL));
    const b = getSnapshot();
    expect(b).not.toBe(a);
    expect(b.version).toBeGreaterThan(a.version);
  });
});

describe('bookStore throttling', () => {
  it('coalesces a burst into ONE ~10 Hz notification', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    const unsub = subscribe(cb);

    ingestForTest(trade(1, 100, 1, SIDE_BUY));
    ingestForTest(trade(2, 101, 1, SIDE_SELL));
    ingestForTest(trade(3, 102, 1, SIDE_BUY));
    expect(cb).not.toHaveBeenCalled(); // throttled — nothing yet

    vi.advanceTimersByTime(THROTTLE_MS);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].trades.length).toBe(3); // latest state delivered

    // A second burst schedules exactly one more notification.
    ingestForTest(trade(4, 103, 1, SIDE_SELL));
    vi.advanceTimersByTime(THROTTLE_MS);
    expect(cb).toHaveBeenCalledTimes(2);

    unsub();
  });

  it('schedules no notification once the last subscriber leaves', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    subscribe(cb)(); // subscribe then immediately unsubscribe
    ingestForTest(trade(1, 100, 1, SIDE_BUY));
    vi.advanceTimersByTime(THROTTLE_MS * 3);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('bookStore stream wiring', () => {
  it('receives depth columns through the real store.onStream fan-out', () => {
    const sockets: FakeWebSocket[] = [];
    setFlowMapTransport({
      url: 'wss://test.invalid/ws',
      wsFactory: (url) => {
        const s = new FakeWebSocket(url);
        sockets.push(s);
        return s;
      },
    });
    // Registering a subscriber opens the single store.onStream subscription.
    subscribe(() => {});

    useFlowMapStore.getState().connectAndSubscribe('crypto', 'BTCUSDT');
    sockets[0].open();
    // A real DEPTH_COL frame through socket → connection → fan-out → bookStore.
    sockets[0].deliver(goldenU8('hot_depth_col_l2'));

    const book = getSnapshot().book;
    expect(book).not.toBeNull();
    expect(typeof book?.epoch).toBe('number');
    expect(book?.bid.length).toBeGreaterThan(0);
  });
});
