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
  resetForSession,
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

describe('bookStore resetForSession (symbol switch)', () => {
  it('clears book, BBO and tape so the new symbol does not show stale data', () => {
    ingestForTest(depthCol(1, 10, [1, 2, 3], [0, 0, 4]));
    ingestForTest(bbo(99.5, 12, 100.5, 7));
    ingestForTest(trade(1, 100, 1, SIDE_BUY));
    ingestForTest(trade(2, 101, 1, SIDE_SELL));
    const before = getSnapshot();
    expect(before.book).not.toBeNull();
    expect(before.bbo).not.toBeNull();
    expect(before.trades.length).toBe(2);

    resetForSession();

    const after = getSnapshot();
    expect(after.book).toBeNull();
    expect(after.bbo).toBeNull();
    expect(after.trades.length).toBe(0);
    // The version advances (cache invalidated) so subscribed panels repaint.
    expect(after.version).toBeGreaterThan(before.version);
  });

  it('keeps panel subscriptions alive and notifies them of the cleared state', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    const unsub = subscribe(cb);
    ingestForTest(depthCol(1, 5, [7, 8], [0, 9]));
    vi.advanceTimersByTime(THROTTLE_MS);
    expect(cb).toHaveBeenCalledTimes(1);

    resetForSession();
    vi.advanceTimersByTime(THROTTLE_MS);
    // The same listener is still registered and sees the empty book.
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0].book).toBeNull();

    // Still live: the new session's first column flows to the same listener.
    ingestForTest(depthCol(2, 0, [1, 1], [0, 2]));
    vi.advanceTimersByTime(THROTTLE_MS);
    expect(cb).toHaveBeenCalledTimes(3);
    expect(cb.mock.calls[2][0].book?.epoch).toBe(2);

    unsub();
  });
});

describe('bookStore NaN quarantine + epoch consistency', () => {
  it('rejects a late column from an OLDER epoch — stale levels never clobber the new grid', () => {
    ingestForTest(depthCol(2, 5, [1, 2], [3, 4]));
    // A straggler from the OLD epoch with a huge col_seq must not win: epoch
    // order dominates col_seq order (a re-anchor/seek bumps the epoch).
    ingestForTest(depthCol(1, 9999, [9, 9], [9, 9]));
    const book = getSnapshot().book;
    expect(book?.epoch).toBe(2);
    expect(book?.colSeq).toBe(5);
    expect(Array.from(book?.bid ?? [])).toEqual([1, 2]);
  });

  it('overwrites idempotently on the same (epoch, col_seq) re-delivery', () => {
    ingestForTest(depthCol(1, 10, [1, 1], [2, 2]));
    ingestForTest(depthCol(1, 10, [7, 7], [8, 8]));
    const book = getSnapshot().book;
    expect(book?.colSeq).toBe(10);
    expect(Array.from(book?.bid ?? [])).toEqual([7, 7]);
  });

  it('quarantines non-finite densities to zero instead of poisoning the ladder', () => {
    ingestForTest(depthCol(1, 10, [1, NaN, Infinity], [-Infinity, 0, 4]));
    const book = getSnapshot().book;
    // Corrupt entries become "no resting size" (the protocol's qty-to-zero);
    // the healthy rows survive.
    expect(Array.from(book?.bid ?? [])).toEqual([1, 0, 0]);
    expect(Array.from(book?.ask ?? [])).toEqual([0, 0, 4]);
  });

  it('drops a corrupt BBO (non-finite price/size) and keeps the last good quote', () => {
    ingestForTest(bbo(99.5, 12, 100.5, 7));
    ingestForTest(bbo(NaN, 1, 101, 1)); // corrupt bid_px — update rejected whole
    expect(getSnapshot().bbo).toMatchObject({
      bidPx: 99.5,
      bidSz: 12,
      askPx: 100.5,
      askSz: 7,
    });
  });

  it('drops trades with non-finite price/size and never throws on a NaN ns field', () => {
    ingestForTest(trade(1, NaN, 1, SIDE_SELL)); // NaN price
    ingestForTest(trade(2, Infinity, 1, SIDE_BUY)); // Inf price
    ingestForTest(trade(3, 101, NaN, SIDE_SELL)); // NaN size
    expect(getSnapshot().trades).toHaveLength(0);

    // A NaN reaching the bigint coercion (BigInt(NaN) throws) must be
    // quarantined at the boundary, not tear down the fan-out. The trade record
    // itself survives (price/size — its essence — are valid); the corrupt FIELD
    // is clamped to 0n, mirroring the depth-array zeroing policy.
    const corruptNs: Trade = {
      type: MsgType.TRADE,
      ts_ns: NaN as unknown as bigint,
      price: 100,
      size: 1,
      side: SIDE_BUY,
      side_src: 0,
      venue: 'sim',
    };
    expect(() => ingestForTest(corruptNs)).not.toThrow();
    expect(getSnapshot().trades).toHaveLength(1);
    expect(getSnapshot().trades[0].tsNs).toBe(0n);

    ingestForTest(trade(4, 102, 1, SIDE_BUY));
    expect(getSnapshot().trades).toHaveLength(2);
    expect(getSnapshot().trades[0].tsNs).toBe(4n);
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
