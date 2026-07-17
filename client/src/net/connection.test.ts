import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { decodeFrame } from '../proto/decode';
import { MsgType, type Msg } from '../proto/types';
import { Connection, type SocketLike } from './connection';

// The fixed ns timestamp baked into the server's golden fixture
// (2025-07-17T00:00:00Z); the hot_ping golden carries server_send_ns = T0 + 4000.
const T0 = 1_752_710_400_000_000_000n;

// Golden .bin vectors are the server's committed wire bytes, synced into
// client/tests/golden/. We reuse them (rather than re-encode) wherever the shape
// matches so these tests exercise the exact bytes the server emits.
const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'golden');

function goldenU8(name: string): Uint8Array {
  const b = readFileSync(join(GOLDEN_DIR, `${name}.bin`));
  return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/** Narrow a Msg to a specific variant so field access type-checks. */
function assertType<T extends MsgType>(
  msg: Msg,
  type: T,
): asserts msg is Extract<Msg, { type: T }> {
  if (msg.type !== type) {
    throw new Error(`expected ${MsgType[type]}, got ${MsgType[msg.type]}`);
  }
}

// --- minimal test-only frame builders -----------------------------------------
// encode.ts only exports the production client→server surface (control messages +
// Pong). To synthesize server→client frames the FakeWebSocket delivers, we build
// them here, mirroring encode.ts's envelope framing (`<BBHI>` + 4-byte pad).

const PROTO_VER = 1;
const FLAG_JSON = 0x0001;

function frameBytes(msgType: number, payload: Uint8Array, flags = 0): Uint8Array {
  const padded = (payload.length + 3) & ~3;
  const out = new Uint8Array(8 + padded);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, msgType);
  dv.setUint8(1, PROTO_VER);
  dv.setUint16(2, flags, true);
  dv.setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

function coldFrame(msgType: number, value: unknown): Uint8Array {
  return frameBytes(msgType, new TextEncoder().encode(JSON.stringify(value)), FLAG_JSON);
}

function buildEpochStart(epoch: number): Uint8Array {
  return coldFrame(MsgType.EPOCH_START, {
    epoch,
    epoch_params: { epoch, tick: 0.01, tick_multiple: 5, dt_ns: 250_000_000, p0: 100.0, rows: 2048 },
  });
}

/** A HistoryResponse header with all four nested groups empty (24-byte payload). */
function buildHistoryResp(reqId: number, epoch = 3): Uint8Array {
  const payload = new Uint8Array(24); // <IIqHHHH>
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, reqId, true);
  dv.setUint32(4, epoch, true);
  dv.setBigInt64(8, 0n, true); // oldest_available_t_ns
  // nDepth / nBar / nMarker / nTrade all zero (buffer already zeroed).
  return frameBytes(MsgType.HISTORY_RESP, payload, 0);
}

/** A minimal L2 DEPTH_COL (n_rows=1) with a chosen epoch/col_seq/final flag. */
function buildDepthCol(epoch: number, colSeq: number, final: boolean): Uint8Array {
  const payload = new Uint8Array(24 + 4 + 4); // header + bid f32 + ask f32
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, epoch, true);
  dv.setUint32(4, colSeq, true);
  dv.setBigInt64(8, BigInt(colSeq) * 250_000_000n, true);
  dv.setUint8(16, 0); // mode L2
  dv.setUint8(17, final ? 1 : 0);
  dv.setUint16(18, 0, true); // pad
  dv.setUint32(20, 1, true); // n_rows
  dv.setFloat32(24, 5.0, true); // bid[0]
  dv.setFloat32(28, 4.0, true); // ask[0]
  return frameBytes(MsgType.DEPTH_COL, payload, 0);
}

/** A BAR_COL for a chosen epoch/col_seq (no `final` flag exists on bars). */
function buildBarCol(epoch: number, colSeq: number): Uint8Array {
  const payload = new Uint8Array(16 + 32 + 40); // <IIq> + <dddd> + <ddddd>
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, epoch, true);
  dv.setUint32(4, colSeq, true);
  dv.setBigInt64(8, BigInt(colSeq) * 250_000_000n, true);
  // OHLC + cumulative fields left zero — the test only checks routing.
  return frameBytes(MsgType.BAR_COL, payload, 0);
}

// --- fakes --------------------------------------------------------------------

/** Captures sent frames; lets a test drive open/close/message lifecycle. */
class FakeWebSocket implements SocketLike {
  binaryType = 'blob';
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: ArrayBufferLike | ArrayBufferView | string): void {
    if (typeof data === 'string') {
      this.sent.push(new TextEncoder().encode(data));
    } else if (ArrayBuffer.isView(data)) {
      this.sent.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    } else {
      this.sent.push(new Uint8Array(data.slice(0)));
    }
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  // test drivers
  open(): void {
    this.onopen?.();
  }
  /** Simulate the socket dropping (server-side close, not a client close()). */
  drop(): void {
    this.closed = true;
    this.onclose?.();
  }
  deliver(bytes: Uint8Array): void {
    // Copy into a realm-local ArrayBuffer, as a real socket would hand the
    // connection. Golden bytes come from Node's readFileSync, whose ArrayBuffer
    // is a different realm than jsdom's global — without the copy the
    // connection's `data instanceof ArrayBuffer` check would fail.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.onmessage?.({ data: copy.buffer });
  }
  get lastSent(): Uint8Array {
    return this.sent[this.sent.length - 1];
  }
}

/** Deterministic injectable timer harness. */
class FakeClock {
  now = 0;
  private seq = 1;
  private timers: { id: number; at: number; fn: () => void }[] = [];

  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.seq++;
    this.timers.push({ id, at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== handle);
  };
  advance(ms: number): void {
    this.now += ms;
    const due = this.timers.filter((t) => t.at <= this.now).sort((a, b) => a.at - b.at);
    this.timers = this.timers.filter((t) => t.at > this.now);
    for (const t of due) t.fn();
  }
}

interface Harness {
  sockets: FakeWebSocket[];
  clock: FakeClock;
  factory: (url: string) => SocketLike;
}

function harness(): Harness {
  const sockets: FakeWebSocket[] = [];
  const clock = new FakeClock();
  const factory = (url: string): SocketLike => {
    const s = new FakeWebSocket(url);
    sockets.push(s);
    return s;
  };
  return { sockets, clock, factory };
}

// Fake endpoint handed to the injected FakeWebSocket, which ignores it (no real
// socket is ever opened). wss avoids the cleartext-WebSocket lint on a URL that
// never carries traffic.
const URL = 'wss://test.invalid/ws';

// --- tests --------------------------------------------------------------------

describe('Connection — subscription lifecycle', () => {
  it('sends Subscribe on open with the requested market/symbol/mode', () => {
    const { sockets, clock, factory } = harness();
    const conn = new Connection({
      url: URL,
      wsFactory: factory,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    conn.subscribe('crypto', 'BTCUSDT', 'live');
    expect(sockets).toHaveLength(1);
    // Nothing sent until the socket is open.
    expect(sockets[0].sent).toHaveLength(0);

    sockets[0].open();
    const frame = decodeFrame(sockets[0].sent[0]);
    expect(frame).toHaveLength(1);
    assertType(frame[0], MsgType.SUBSCRIBE);
    expect(frame[0].market).toBe('crypto');
    expect(frame[0].symbol).toBe('BTCUSDT');
    expect(frame[0].mode).toBe('live');
  });

  it('replacing a subscription sends Unsubscribe then Subscribe on the open socket', () => {
    const { sockets, clock, factory } = harness();
    const conn = new Connection({
      url: URL,
      wsFactory: factory,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open(); // Subscribe #1
    conn.subscribe('equity', 'AAPL', 'live'); // replace

    const frames = sockets[0].sent.map((b) => decodeFrame(b)[0]);
    expect(frames.map((f) => f.type)).toEqual([
      MsgType.SUBSCRIBE,
      MsgType.UNSUBSCRIBE,
      MsgType.SUBSCRIBE,
    ]);
    assertType(frames[2], MsgType.SUBSCRIBE);
    expect(frames[2].symbol).toBe('AAPL');
  });
});

describe('Connection — message routing', () => {
  it('routes Hello to onHello, seeds session/epoch state, and goes live', () => {
    const { sockets, clock, factory } = harness();
    const onHello = vi.fn();
    const conn = new Connection({
      url: URL,
      wsFactory: factory,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onHello,
    });

    conn.connect();
    sockets[0].open();
    sockets[0].deliver(goldenU8('cold_hello'));

    expect(onHello).toHaveBeenCalledOnce();
    const hello = onHello.mock.calls[0][0];
    expect(hello.session_id).toBe('golden-session-0001');
    expect(hello.protocol_version).toBe(1);
    expect(conn.status).toBe('live');
    // Hello's epoch_params seed the epoch map.
    expect(conn.epochs.get(3)).toMatchObject({ epoch: 3, rows: 2048 });
  });

  it('builds the epoch map from EpochStart', () => {
    const { sockets, clock, factory } = harness();
    const onEpochStart = vi.fn();
    const conn = new Connection({
      url: URL,
      wsFactory: factory,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onEpochStart,
    });

    conn.connect();
    sockets[0].open();
    sockets[0].deliver(buildEpochStart(7));

    expect(onEpochStart).toHaveBeenCalledOnce();
    expect(conn.epochs.get(7)).toMatchObject({ epoch: 7, tick_multiple: 5, rows: 2048 });
  });

  it('auto-replies to Ping with Pong echoing server_send_ns', () => {
    const { sockets, clock, factory } = harness();
    const conn = new Connection({
      url: URL,
      wsFactory: factory,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    conn.connect();
    sockets[0].open();
    sockets[0].deliver(goldenU8('hot_ping')); // server_send_ns = T0 + 4000

    const pong = decodeFrame(sockets[0].lastSent);
    expect(pong).toHaveLength(1);
    assertType(pong[0], MsgType.PONG);
    expect(pong[0].echo_ns).toBe(T0 + 4_000n);
  });

  it('forwards columns to the stream consumer and dedups by (epoch, col_seq)', () => {
    const { sockets, clock, factory } = harness();
    const onStream = vi.fn();
    const conn = new Connection({
      url: URL,
      wsFactory: factory,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onStream,
    });

    conn.connect();
    sockets[0].open();
    const col = goldenU8('hot_depth_col_l2'); // epoch 3, col_seq 41
    sockets[0].deliver(col);
    sockets[0].deliver(col); // re-delivery of the same (epoch, col_seq)

    expect(onStream).toHaveBeenCalledOnce();
    const forwarded = onStream.mock.calls[0][0];
    expect(forwarded.type).toBe(MsgType.DEPTH_COL);
    expect(forwarded.col_seq).toBe(41);
  });

  it('forwards every forming (final=false) depth re-send, then the finalizing one', () => {
    const { sockets, clock, factory } = harness();
    const onStream = vi.fn();
    const conn = new Connection({
      url: URL, wsFactory: factory,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, onStream,
    });
    conn.connect();
    sockets[0].open();

    // The live right edge: the same col_seq re-sent as a forming column several
    // times (20 Hz), then finalized. All must reach the renderer, else the edge
    // freezes / the final data is lost.
    sockets[0].deliver(buildDepthCol(3, 42, false));
    sockets[0].deliver(buildDepthCol(3, 42, false));
    sockets[0].deliver(buildDepthCol(3, 42, false));
    sockets[0].deliver(buildDepthCol(3, 42, true)); // finalize
    expect(onStream).toHaveBeenCalledTimes(4);

    // After finalizing col_seq 42, a reconnect snapshot re-sending it (final) is
    // the only real duplicate — dropped.
    sockets[0].deliver(buildDepthCol(3, 42, true));
    expect(onStream).toHaveBeenCalledTimes(4);
  });

  it('never drops BarColumn even when it shares a just-finalized depth col_seq', () => {
    const { sockets, clock, factory } = harness();
    const onStream = vi.fn();
    const conn = new Connection({
      url: URL, wsFactory: factory,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, onStream,
    });
    conn.connect();
    sockets[0].open();

    // Server sends depth(final) then bar for the same col_seq; the bar must not
    // be swallowed by the depth's dedup cursor (they are separate channels).
    sockets[0].deliver(buildDepthCol(5, 10, true));
    sockets[0].deliver(buildBarCol(5, 10));
    expect(onStream).toHaveBeenCalledTimes(2);
    expect(onStream.mock.calls[1][0].type).toBe(MsgType.BAR_COL);
  });
});

describe('Connection — reconnect', () => {
  it('re-opens after an unexpected close and re-sends Subscribe past the backoff', () => {
    const { sockets, clock, factory } = harness();
    const conn = new Connection({
      url: URL,
      wsFactory: factory,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();
    expect(decodeFrame(sockets[0].sent[0])[0].type).toBe(MsgType.SUBSCRIBE);

    sockets[0].drop(); // server-side close
    expect(conn.status).toBe('reconnecting');
    expect(sockets).toHaveLength(1); // no reconnect before the backoff elapses

    clock.advance(500); // base backoff
    expect(sockets).toHaveLength(2);

    sockets[1].open();
    const resub = decodeFrame(sockets[1].sent[0]);
    assertType(resub[0], MsgType.SUBSCRIBE);
    expect(resub[0].symbol).toBe('BTCUSDT');
  });

  it('does not reconnect after an intentional close()', () => {
    const { sockets, clock, factory } = harness();
    const conn = new Connection({
      url: URL,
      wsFactory: factory,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();
    conn.close();

    expect(conn.status).toBe('closed');
    expect(sockets[0].closed).toBe(true);
    clock.advance(60_000);
    expect(sockets).toHaveLength(1);
  });
});

describe('Connection — history correlation', () => {
  it('resolves requestHistory on the HistoryResponse with the matching req_id', async () => {
    const { sockets, clock, factory } = harness();
    const conn = new Connection({
      url: URL,
      wsFactory: factory,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      historyTimeoutMs: 5_000,
    });

    conn.connect();
    sockets[0].open();

    const before = T0 - 60_000_000_000n;
    const promise = conn.requestHistory(before, 50);

    const sent = decodeFrame(sockets[0].lastSent);
    assertType(sent[0], MsgType.HISTORY_REQ);
    expect(sent[0].before_t).toBe(before);
    expect(sent[0].n_cols).toBe(50);
    const reqId = sent[0].req_id;

    sockets[0].deliver(buildHistoryResp(reqId));
    await expect(promise).resolves.toMatchObject({ req_id: reqId, depth_cols: [] });
  });

  it('rejects requestHistory on timeout', async () => {
    const { sockets, clock, factory } = harness();
    const conn = new Connection({
      url: URL,
      wsFactory: factory,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      historyTimeoutMs: 5_000,
    });

    conn.connect();
    sockets[0].open();

    const promise = conn.requestHistory(1n, 10);
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    clock.advance(5_000);
    await assertion;
  });

  it('ignores a HistoryResponse whose req_id has no waiter', async () => {
    const { sockets, clock, factory } = harness();
    const conn = new Connection({
      url: URL,
      wsFactory: factory,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    conn.connect();
    sockets[0].open();
    // No throw / no crash for an unmatched response.
    expect(() => sockets[0].deliver(buildHistoryResp(999))).not.toThrow();
  });
});

describe('Connection — robustness', () => {
  it('drops a malformed frame without closing or killing the connection', () => {
    const { sockets, clock, factory } = harness();
    const onStream = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const conn = new Connection({
      url: URL,
      wsFactory: factory,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onStream,
    });

    conn.connect();
    sockets[0].open();

    // Garbage: a 3-byte buffer decodeFrame rejects as a truncated envelope.
    sockets[0].deliver(new Uint8Array([0xff, 0x01, 0x02]));

    expect(sockets[0].closed).toBe(false);
    expect(conn.status).not.toBe('closed');
    expect(onStream).not.toHaveBeenCalled();

    // The connection is still alive: a subsequent valid Ping still gets a Pong.
    sockets[0].deliver(goldenU8('hot_ping'));
    const pong = decodeFrame(sockets[0].lastSent);
    assertType(pong[0], MsgType.PONG);

    warn.mockRestore();
  });
});
