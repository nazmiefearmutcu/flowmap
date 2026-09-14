import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { decodeFrame } from '../proto/decode';
import { MsgType, type Msg } from '../proto/types';
import { Connection, type ConnectionOptions, type SocketLike } from './connection';

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

/** A cold-JSON Hello for a chosen session + epoch (mirrors server cold_hello). */
function buildHello(sessionId: string, epoch: number): Uint8Array {
  return coldFrame(MsgType.HELLO, {
    protocol_version: 1,
    session_id: sessionId,
    grid_epoch: epoch,
    epoch_params: { epoch, tick: 0.01, tick_multiple: 5, dt_ns: 250_000_000, p0: 100.0, rows: 2048 },
    capability: {},
    norm_seed: 1,
  });
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
  /** Simulate the socket dropping (server-side close, not a client close()).
   *  `code` mirrors the browser CloseEvent.code (e.g. 1003 = unsupported). */
  drop(code?: number): void {
    this.closed = true;
    this.onclose?.({ code });
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
  /** Build a Connection wired to this harness. Jitter defaults to 1 — the
   *  deterministic full-jitter draw (exact exponential ceiling) the existing
   *  clock assertions rely on; pass `{ jitter }` in `extra` for other draws. */
  makeConn: (extra?: Partial<ConnectionOptions>) => Connection;
}

function harness(): Harness {
  const sockets: FakeWebSocket[] = [];
  const clock = new FakeClock();
  const factory = (url: string): SocketLike => {
    const s = new FakeWebSocket(url);
    sockets.push(s);
    return s;
  };
  const makeConn = (extra: Partial<ConnectionOptions> = {}): Connection =>
    new Connection({
      url: URL,
      wsFactory: factory,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      jitter: () => 1,
      ...extra,
    });
  return { sockets, clock, factory, makeConn };
}

// Fake endpoint handed to the injected FakeWebSocket, which ignores it (no real
// socket is ever opened). wss avoids the cleartext-WebSocket lint on a URL that
// never carries traffic.
const URL = 'wss://test.invalid/ws';

// --- tests --------------------------------------------------------------------

describe('Connection — subscription lifecycle', () => {
  it('sends Subscribe on open with the requested market/symbol/mode', () => {
    const { sockets, makeConn } = harness();
    const conn = makeConn();

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
    const { sockets, makeConn } = harness();
    const conn = makeConn();

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

  // --- P6: the optional replay window (start_t/end_t) ---------------------------

  it('carries a replay window on the wire and re-sends it across a reconnect', () => {
    const { sockets, clock, makeConn } = harness();
    const conn = makeConn();
    const start = T0;
    const end = T0 + 3_600_000_000_000n;

    conn.subscribe('crypto', 'BTCUSDT', 'replay', 'native', { startNs: start, endNs: end });
    sockets[0].open();
    const first = decodeFrame(sockets[0].sent[0]);
    assertType(first[0], MsgType.SUBSCRIBE);
    expect(first[0].start_t).toBe(start);
    expect(first[0].end_t).toBe(end);

    // The desired subscription (window included) survives the reconnect.
    sockets[0].drop();
    clock.advance(500);
    sockets[1].open();
    const again = decodeFrame(sockets[1].sent[0]);
    assertType(again[0], MsgType.SUBSCRIBE);
    expect(again[0].start_t).toBe(start);
    expect(again[0].end_t).toBe(end);
  });

  it('changing ONLY the window re-subscribes and rewinds the session cursors', () => {
    const { sockets, makeConn } = harness();
    const conn = makeConn();

    conn.subscribe('crypto', 'BTCUSDT', 'replay', 'native', { startNs: T0 });
    sockets[0].open();
    sockets[0].deliver(buildEpochStart(0));
    expect(conn.epochs.size).toBe(1);

    // A different slice is a different server session (epoch 0, col_seq 0), so
    // it must take the detach + cursor-rewind path a symbol switch takes.
    conn.subscribe('crypto', 'BTCUSDT', 'replay', 'native', { startNs: T0, endNs: T0 + 1000n });
    const frames = sockets[0].sent.map((b) => decodeFrame(b)[0]);
    expect(frames.map((f) => f.type)).toEqual([
      MsgType.SUBSCRIBE,
      MsgType.UNSUBSCRIBE,
      MsgType.SUBSCRIBE,
    ]);
    expect(conn.epochs.size).toBe(0);
    const last = frames[2];
    assertType(last, MsgType.SUBSCRIBE);
    expect(last.end_t).toBe(T0 + 1000n);
  });

  it('an unbounded subscribe emits the exact legacy Subscribe bytes (no end_t key)', () => {
    const { sockets, makeConn } = harness();
    const conn = makeConn();
    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();

    const sent = sockets[0].sent[0];
    const plen = new DataView(sent.buffer, sent.byteOffset, sent.byteLength).getUint32(4, true);
    const payload = new TextDecoder().decode(sent.subarray(8, 8 + plen));
    expect(payload).not.toContain('end_t');
    expect(payload).toBe(
      '{"market":"crypto","symbol":"BTCUSDT","mode":"live","source":null,"start_t":null,"band":"native"}',
    );
  });

  it('rewinds the per-session cursors when the stream changes', () => {
    const { sockets, makeConn } = harness();
    const onStream = vi.fn();
    const conn = makeConn({ onStream });

    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();
    sockets[0].deliver(buildEpochStart(0));
    sockets[0].deliver(buildDepthCol(0, 900, true)); // deep into the old session
    expect(onStream).toHaveBeenCalledTimes(1);

    // Swapping symbols detaches the server session; the replacement's grid
    // restarts at epoch 0 with low col_seqs and its attach snapshot arrives
    // final=true. Without a rewind the whole snapshot/backfill would be dropped
    // as "already finalized" and only the forming right edge would render.
    conn.subscribe('equity', 'AAPL', 'live');
    expect(conn.epochs.size).toBe(0); // the old grid geometry is gone too
    sockets[0].deliver(buildDepthCol(0, 1, true));
    sockets[0].deliver(buildDepthCol(0, 2, true));
    expect(onStream).toHaveBeenCalledTimes(3);
  });

  it('keeps the dedup cursor across a reconnect of the SAME stream', () => {
    const { sockets, clock, makeConn } = harness();
    const onStream = vi.fn();
    const conn = makeConn({ onStream });

    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();
    sockets[0].deliver(buildDepthCol(3, 42, true));
    expect(onStream).toHaveBeenCalledTimes(1);

    sockets[0].drop(); // server-side close
    clock.advance(500);
    sockets[1].open();

    // Same stream, same server session: the reconnect snapshot re-sends what we
    // already finalized, which is exactly what the cursor exists to swallow.
    sockets[1].deliver(buildDepthCol(3, 42, true));
    expect(onStream).toHaveBeenCalledTimes(1);
  });

  it('resets the dedup cursor + epoch map when a reconnect lands on a NEW session_id', () => {
    const { sockets, clock, makeConn } = harness();
    const onStream = vi.fn();
    const conn = makeConn({ onStream });

    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();
    sockets[0].deliver(buildHello('session-A', 0));
    sockets[0].deliver(buildEpochStart(7)); // a second, older epoch of session A
    sockets[0].deliver(buildDepthCol(0, 900, true)); // deep into session A
    expect(onStream).toHaveBeenCalledTimes(1);
    expect(conn.session).toBe('session-A');

    // Sidecar crash + respawn: same port, same subscription re-sent on open,
    // but a brand-new server session whose col_seq restarts at 0. The old
    // cursor must die with session A, or every finalized column of the
    // replacement is swallowed as a "reconnect re-send" and the heatmap stays
    // dead until col_seq crawls past 900 (survey-4 H-1).
    sockets[0].drop();
    clock.advance(500);
    sockets[1].open();
    sockets[1].deliver(buildHello('session-B', 0));
    expect(conn.session).toBe('session-B');
    expect(conn.epochs.has(7)).toBe(false); // old grid geometry gone
    expect(conn.epochs.get(0)).toMatchObject({ rows: 2048 }); // re-seeded by Hello B

    sockets[1].deliver(buildDepthCol(0, 5, true));
    expect(onStream).toHaveBeenCalledTimes(2);
    expect(onStream.mock.calls[1][0]).toMatchObject({ type: MsgType.DEPTH_COL, col_seq: 5 });
    // The new session's cursor re-arms from scratch: a seq-5 re-send is a dup.
    sockets[1].deliver(buildDepthCol(0, 5, true));
    expect(onStream).toHaveBeenCalledTimes(2);
  });

  it('fails in-flight history waiters when the server session changes', async () => {
    const { sockets, makeConn } = harness();
    const conn = makeConn();

    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();
    sockets[0].deliver(buildHello('session-A', 0));
    const pending = conn.requestHistory(1n, 10);
    const sent = decodeFrame(sockets[0].lastSent);
    assertType(sent[0], MsgType.HISTORY_REQ);
    const reqId = sent[0].req_id;
    const assertion = expect(pending).rejects.toThrow(/session changed/);

    // A Hello for a DIFFERENT session arrives while the OLD session's page is
    // still in flight: its columns belong to the old grid and must never
    // resolve into the new session's ring.
    sockets[0].deliver(buildHello('session-B', 0));
    await assertion;
    // A late response for the abandoned req_id is now unmatched — dropped.
    expect(() => sockets[0].deliver(buildHistoryResp(reqId))).not.toThrow();
  });

  it('keeps the dedup cursor across a reconnect when the session_id is UNCHANGED', () => {
    const { sockets, clock, makeConn } = harness();
    const onStream = vi.fn();
    const conn = makeConn({ onStream });

    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();
    sockets[0].deliver(buildHello('session-A', 3));
    sockets[0].deliver(buildDepthCol(3, 900, true));
    expect(onStream).toHaveBeenCalledTimes(1);

    sockets[0].drop();
    clock.advance(500);
    sockets[1].open();
    sockets[1].deliver(buildHello('session-A', 3)); // parked-session re-attach
    sockets[1].deliver(buildDepthCol(3, 900, true)); // snapshot re-send → deduped
    expect(onStream).toHaveBeenCalledTimes(1);
    sockets[1].deliver(buildDepthCol(3, 901, true)); // fresh data still flows
    expect(onStream).toHaveBeenCalledTimes(2);
  });

  it('rejects an in-flight history request when the stream changes', async () => {
    const { sockets, makeConn } = harness();
    const conn = makeConn();

    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();

    // A page of the OLD symbol's history is still in flight when the user
    // switches: its columns must never resolve into the new symbol's ring.
    const pending = conn.requestHistory(1n, 10);
    const sent = decodeFrame(sockets[0].lastSent);
    assertType(sent[0], MsgType.HISTORY_REQ);
    const reqId = sent[0].req_id;
    const assertion = expect(pending).rejects.toThrow(/subscription changed/);
    conn.subscribe('equity', 'AAPL', 'live');
    await assertion;

    // A late response for the abandoned req_id is now unmatched — dropped.
    expect(() => sockets[0].deliver(buildHistoryResp(reqId))).not.toThrow();
  });
});

describe('Connection — message routing', () => {
  it('routes Hello to onHello, seeds session/epoch state, and goes live', () => {
    const { sockets, makeConn } = harness();
    const onHello = vi.fn();
    const conn = makeConn({ onHello });

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
    const { sockets, makeConn } = harness();
    const onEpochStart = vi.fn();
    const conn = makeConn({ onEpochStart });

    conn.connect();
    sockets[0].open();
    sockets[0].deliver(buildEpochStart(7));

    expect(onEpochStart).toHaveBeenCalledOnce();
    expect(conn.epochs.get(7)).toMatchObject({ epoch: 7, tick_multiple: 5, rows: 2048 });
  });

  it('auto-replies to Ping with Pong echoing server_send_ns', () => {
    const { sockets, makeConn } = harness();
    const conn = makeConn();

    conn.connect();
    sockets[0].open();
    sockets[0].deliver(goldenU8('hot_ping')); // server_send_ns = T0 + 4000

    const pong = decodeFrame(sockets[0].lastSent);
    expect(pong).toHaveLength(1);
    assertType(pong[0], MsgType.PONG);
    expect(pong[0].echo_ns).toBe(T0 + 4_000n);
  });

  it('forwards columns to the stream consumer and dedups by (epoch, col_seq)', () => {
    const { sockets, makeConn } = harness();
    const onStream = vi.fn();
    const conn = makeConn({ onStream });

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
    const { sockets, makeConn } = harness();
    const onStream = vi.fn();
    const conn = makeConn({ onStream });
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
    const { sockets, makeConn } = harness();
    const onStream = vi.fn();
    const conn = makeConn({ onStream });
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
    const { sockets, clock, makeConn } = harness();
    const conn = makeConn();

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
    const { sockets, clock, makeConn } = harness();
    const conn = makeConn();

    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();
    conn.close();

    expect(conn.status).toBe('closed');
    expect(sockets[0].closed).toBe(true);
    clock.advance(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('an explicit connect() during the backoff window cancels the pending reconnect (no double socket)', () => {
    const { sockets, clock, makeConn } = harness();
    const conn = makeConn();

    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();
    sockets[0].drop(); // arms the reconnect backoff timer
    expect(sockets).toHaveLength(1);

    // A subscribe with no socket connects NOW — it must cancel the armed
    // reconnect, or the timer opens a second socket and both stream.
    conn.subscribe('crypto', 'ETHUSDT', 'live');
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    const resub2 = decodeFrame(sockets[1].sent[0]);
    assertType(resub2[0], MsgType.SUBSCRIBE);
    expect(resub2[0].symbol).toBe('ETHUSDT');

    clock.advance(60_000); // the armed backoff must NOT open a third socket
    expect(sockets).toHaveLength(2);
  });
});

describe('Connection — backoff with full jitter', () => {
  it('draws the delay from [0, ceiling): jitter 0 reconnects immediately', () => {
    const { sockets, clock, makeConn } = harness();
    const conn = makeConn({ jitter: () => 0 });
    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();
    sockets[0].drop();
    expect(sockets).toHaveLength(1);
    clock.advance(0); // delay 0 → the timer is due right away
    expect(sockets).toHaveLength(2);
  });

  it('jitter 1 keeps the deterministic exponential ceiling: 500 → 1000 → 2000', () => {
    const { sockets, clock, makeConn } = harness();
    const conn = makeConn(); // default harness jitter = 1 (exact ceiling)
    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();

    sockets[0].drop();
    clock.advance(499);
    expect(sockets).toHaveLength(1);
    clock.advance(1); // 500
    expect(sockets).toHaveLength(2);

    sockets[1].drop();
    clock.advance(999);
    expect(sockets).toHaveLength(2);
    clock.advance(1); // 1000
    expect(sockets).toHaveLength(3);

    sockets[2].drop();
    clock.advance(1999);
    expect(sockets).toHaveLength(3);
    clock.advance(1); // 2000
    expect(sockets).toHaveLength(4);
  });

  it('caps the ceiling at backoffCapMs (default 15s) instead of growing forever', () => {
    const { sockets, clock, makeConn } = harness();
    const conn = makeConn();
    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();
    // Burn through attempts without ever completing a handshake, so the attempt
    // counter keeps climbing: 500·2^n passes the 15000 cap at attempt 5. Each
    // advance(60_000) fires whatever delay is armed and opens the next socket.
    for (let i = 0; i < 6; i += 1) {
      sockets[i].drop();
      clock.advance(60_000);
    }
    expect(sockets).toHaveLength(7);

    sockets[6].open(); // no Hello delivered — the counter is NOT reset
    sockets[6].drop(); // attempt 6: ceiling still capped at 15_000
    clock.advance(14_999);
    expect(sockets).toHaveLength(7);
    clock.advance(1);
    expect(sockets).toHaveLength(8);
  });

  it('resets to the base delay once a Hello handshake lands', () => {
    const { sockets, clock, makeConn } = harness();
    const conn = makeConn();
    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();
    sockets[0].drop(); // attempt 0 → 500
    clock.advance(500);
    expect(sockets).toHaveLength(2);
    sockets[1].drop(); // attempt 1 → 1000
    clock.advance(1000);
    expect(sockets).toHaveLength(3);

    // Socket 2 completes the HANDSHAKE (Hello) — a completed session attach,
    // not merely an open — so the attempt counter rewinds to the base delay.
    sockets[2].open();
    sockets[2].deliver(goldenU8('cold_hello'));
    sockets[2].drop();
    clock.advance(499);
    expect(sockets).toHaveLength(3); // 2000 would not have fired yet
    clock.advance(1); // 500
    expect(sockets).toHaveLength(4);
  });

  it('records whether the last close was clean (1000/1001) or abnormal', () => {
    const { sockets, clock, makeConn } = harness();
    const conn = makeConn();
    conn.subscribe('crypto', 'BTCUSDT', 'live');
    expect(conn.closeInfo).toBeNull();

    sockets[0].open();
    sockets[0].drop(1001); // server going away — a CLEAN close frame
    expect(conn.closeInfo).toEqual({ code: 1001, wasClean: true });
    // …and a clean server close still reconnects (the sidecar is exactly the
    // endpoint worth waiting for) — the flag is diagnostic, not a suppressor.
    expect(conn.status).toBe('reconnecting');

    clock.advance(500);
    sockets[1].open();
    sockets[1].drop(); // no close frame — abnormal transport death
    expect(conn.closeInfo).toEqual({ code: null, wasClean: false });
  });

  it('fails in-flight history requests on an unexpected close (no 10 s timeout coast)', async () => {
    const { sockets, clock, makeConn } = harness();
    const conn = makeConn({ historyTimeoutMs: 5_000 });
    conn.subscribe('crypto', 'BTCUSDT', 'live');
    sockets[0].open();

    const pending = conn.requestHistory(1n, 10);
    const assertion = expect(pending).rejects.toThrow(/connection lost/);
    sockets[0].drop();
    await assertion;

    // The reconnect machinery is unaffected by the waiter teardown.
    clock.advance(500);
    expect(sockets).toHaveLength(2);
  });
});

describe('Connection — history correlation', () => {
  it('resolves requestHistory on the HistoryResponse with the matching req_id', async () => {
    const { sockets, makeConn } = harness();
    const conn = makeConn({ historyTimeoutMs: 5_000 });

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
    const { sockets, clock, makeConn } = harness();
    const conn = makeConn({ historyTimeoutMs: 5_000 });

    conn.connect();
    sockets[0].open();

    const promise = conn.requestHistory(1n, 10);
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    clock.advance(5_000);
    await assertion;
  });

  it('ignores a HistoryResponse whose req_id has no waiter', async () => {
    const { sockets, makeConn } = harness();
    const conn = makeConn();

    conn.connect();
    sockets[0].open();
    // No throw / no crash for an unmatched response.
    expect(() => sockets[0].deliver(buildHistoryResp(999))).not.toThrow();
  });
});

describe('Connection — robustness', () => {
  it('drops a malformed frame without closing or killing the connection', () => {
    const { sockets, makeConn } = harness();
    const onStream = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const conn = makeConn({ onStream });

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

describe('Connection — replay refusal (close 1003)', () => {
  function setupReplay(onReplayRefused: () => void): { conn: Connection; sock: FakeWebSocket } {
    let sock: FakeWebSocket | undefined;
    const conn = new Connection({
      url: 'wss://test.invalid/ws',
      wsFactory: (url) => {
        sock = new FakeWebSocket(url);
        return sock;
      },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      onReplayRefused,
    });
    conn.subscribe('crypto', 'BTCUSDT', 'replay');
    const s = sock as FakeWebSocket;
    s.open();
    return { conn, sock: s };
  }

  it('fires onReplayRefused when the server closes 1003 on an active replay subscribe', () => {
    let refused = 0;
    const { conn, sock } = setupReplay(() => {
      refused += 1;
    });
    sock.drop(1003);
    expect(refused).toBe(1);
    // The refusal STILL schedules a reconnect — the store is expected to have
    // re-subscribed live; the transport just must not silently swallow it.
    expect(conn.status).toBe('reconnecting');
  });

  it('does NOT fire for other close codes or non-replay subscriptions', () => {
    let refused = 0;
    const { sock } = setupReplay(() => {
      refused += 1;
    });
    sock.drop(1000); // normal closure
    expect(refused).toBe(0);

    let refusedLive = 0;
    const conn2 = new Connection({
      url: 'wss://test.invalid/ws',
      wsFactory: () => new FakeWebSocket('wss://test.invalid/ws'),
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      onReplayRefused: () => {
        refusedLive += 1;
      },
    });
    conn2.subscribe('crypto', 'BTCUSDT', 'live');
    const s2 = (conn2 as unknown as { socket: FakeWebSocket }).socket;
    s2.open();
    s2.drop(1003);
    expect(refusedLive).toBe(0);
  });

  it('does not fire when the client closed intentionally', () => {
    let refused = 0;
    const { conn, sock } = setupReplay(() => {
      refused += 1;
    });
    conn.close();
    expect(refused).toBe(0);
    // The intentional close() already ran onclose once (code-less) — the
    // guard must also hold if the driver replays a coded close afterwards.
    sock.drop(1003);
    expect(refused).toBe(0);
  });
});

// --- no-feed refusal contract (server ws.py `_refuse`: Status THEN close) -----

describe('Connection — no-feed refusal (Status closed + 1003)', () => {
  interface NoFeedHarness {
    conn: Connection;
    sock: FakeWebSocket;
    events: { noFeed: number; refused: number; closeInfo: { code: number | null; wasClean: boolean }[]; attempts: number[] };
  }

  /** Wire a replay connection, open it, and deliver the pre-close Status. */
  function setup(feedState: 'closed' | 'degraded'): NoFeedHarness {
    const events = { noFeed: 0, refused: 0, closeInfo: [] as { code: number | null; wasClean: boolean }[], attempts: [] as number[] };
    let sock: FakeWebSocket | undefined;
    const conn = new Connection({
      url: 'wss://test.invalid/ws',
      wsFactory: (url) => {
        sock = new FakeWebSocket(url);
        return sock;
      },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      onNoFeed: () => {
        events.noFeed += 1;
      },
      onReplayRefused: () => {
        events.refused += 1;
      },
      onCloseInfo: (info) => events.closeInfo.push(info),
      onReconnectScheduled: (attempt) => events.attempts.push(attempt),
    });
    conn.subscribe('crypto', 'BTCUSDT', 'replay');
    const s = sock as FakeWebSocket;
    s.open();
    // The contract: the Status rides the SAME socket immediately before the close.
    s.deliver(
      coldFrame(MsgType.STATUS, {
        feed_state: feedState,
        capability: {},
        latency_ms: 0.0,
        clock_skew_ms: 0.0,
        next_open_ts: null,
      }),
    );
    return { conn, sock: s, events };
  }

  it('Status(closed) + 1003 is TERMINAL: fires onNoFeed, never schedules a reconnect', () => {
    const { conn, sock, events } = setup('closed');
    sock.drop(1003);
    expect(events.noFeed).toBe(1);
    expect(events.refused).toBe(0);
    // Terminal truth: the status reads 'closed' (not 'reconnecting') and no
    // reconnect tick was scheduled — nothing will ever chase this refusal.
    expect(conn.status).toBe('closed');
    expect(events.attempts).toEqual([]);
  });

  it('Status(degraded) + 1003 keeps the recoverable replay-unavailable path', () => {
    const { conn, sock, events } = setup('degraded');
    sock.drop(1003);
    expect(events.noFeed).toBe(0);
    expect(events.refused).toBe(1);
    expect(conn.status).toBe('reconnecting');
    expect(events.attempts.length).toBe(1);
  });

  it('a 1003 with NO pre-close Status behaves exactly as before (backwards compatible)', () => {
    const events = { noFeed: 0, refused: 0, closeInfo: [] as unknown[], attempts: [] as number[] };
    let sock: FakeWebSocket | undefined;
    const conn = new Connection({
      url: 'wss://test.invalid/ws',
      wsFactory: (url) => {
        sock = new FakeWebSocket(url);
        return sock;
      },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      onNoFeed: () => {
        events.noFeed += 1;
      },
    });
    conn.subscribe('crypto', 'BTCUSDT', 'replay');
    (sock as FakeWebSocket).open();
    (sock as FakeWebSocket).drop(1003);
    expect(events.noFeed).toBe(0);
    expect(conn.status).toBe('reconnecting');
  });
});

function sockets_reconnect_scheduled(events: { attempts: number[] }): boolean {
  return events.attempts.length > 0;
}
void sockets_reconnect_scheduled;

// --- session-cap refusal contract (close 1013 while a replay was desired) -----
//
// QA11 H1 (F12 lane): a REPLAY subscribe refused at the session cap closes with
// 1013 — NOT 1003. The two refusals mean different things and the transport must
// not conflate them: 1003 = "no recording for this session" (the store's honest
// live fallback), 1013 = "server at capacity, try again later" (retry with
// backoff; the subscription stays replay). What Timeline keys its honest
// `REPLAY REFUSED` pill off is `closeInfo.code === 1013` + a replay
// subscription, so this pins that the close info carries 1013, that NO
// onReplayRefused fires (a live fallback here would be an unrelated stream),
// and that a backoff tick IS scheduled.

describe('Connection — session-cap refusal (close 1013 on a replay subscribe)', () => {
  it('carries 1013 in closeInfo, keeps retrying, and does NOT fire the no-recording fallback', () => {
    const events = {
      refused: 0,
      closeInfo: [] as { code: number | null; wasClean: boolean }[],
      attempts: [] as number[],
    };
    let sock: FakeWebSocket | undefined;
    const conn = new Connection({
      url: 'wss://test.invalid/ws',
      wsFactory: (url) => {
        sock = new FakeWebSocket(url);
        return sock;
      },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      onReplayRefused: () => {
        events.refused += 1;
      },
      onCloseInfo: (info) => events.closeInfo.push(info),
      onReconnectScheduled: (attempt) => events.attempts.push(attempt),
    });
    conn.subscribe('crypto', 'BTCUSDT', 'replay');
    const s = sock as FakeWebSocket;
    s.open();
    // The server's refusal contract: Status(degraded) immediately before close.
    s.deliver(
      coldFrame(MsgType.STATUS, {
        feed_state: 'degraded',
        capability: {},
        latency_ms: 0.0,
        clock_skew_ms: 0.0,
        next_open_ts: null,
      }),
    );
    s.drop(1013);
    expect(events.refused).toBe(0); // capacity is NOT the no-recording refusal
    expect(events.closeInfo.at(-1)).toEqual({ code: 1013, wasClean: false });
    expect(events.attempts.length).toBe(1); // try-again-later: the backoff runs
    expect(conn.status).toBe('reconnecting');
  });
});

// --- close info / attempt counter / retry-now (reconnect banner surface) ------

describe('Connection — closeInfo, attempts, reconnectNow', () => {
  function setup(extra: Partial<ConnectionOptions> = {}) {
    const h = harness();
    const events = { closeInfo: [] as { code: number | null; wasClean: boolean }[], attempts: [] as number[] };
    const conn = h.makeConn({
      onCloseInfo: (info) => events.closeInfo.push(info),
      onReconnectScheduled: (attempt) => events.attempts.push(attempt),
      ...extra,
    });
    conn.subscribe('crypto', 'BTCUSDT');
    return { h, conn, sock: h.sockets[0], events };
  }

  it('reports the close info + 1-based attempt to the banner handlers', () => {
    const { h, conn, sock: first, events } = setup();
    first.open();
    first.drop(1001);
    expect(events.closeInfo).toEqual([{ code: 1001, wasClean: true }]);
    expect(events.attempts).toEqual([1]);
    expect(conn.attempts).toBe(1);
    expect(conn.closeInfo).toEqual({ code: 1001, wasClean: true });

    // Consecutive reconnects keep the status at 'reconnecting', so the dedicated
    // handler (not onConnStatus) is what keeps the attempt counter truthful.
    h.clock.advance(500); // jitter=1 → the first backoff tick fires (base 500ms)
    const sock = h.sockets[1];
    sock.open();
    sock.drop(); // abnormal, code-less
    expect(events.closeInfo[1]).toEqual({ code: null, wasClean: false });
    expect(events.attempts).toEqual([1, 2]);
    expect(conn.attempts).toBe(2);
  });

  it('reconnectNow() opens exactly one replacement socket and cancels the armed tick', () => {
    const { h, conn, sock } = setup();
    sock.open();
    sock.drop(1001);
    expect(h.sockets).toHaveLength(1);
    conn.reconnectNow();
    // Exactly one new socket — and the armed backoff timer was cleared, so the
    // clock can never open a SECOND one behind it.
    expect(h.sockets).toHaveLength(2);
    h.clock.advance(60_000);
    expect(h.sockets).toHaveLength(2);
    // While a socket exists, retry is a no-op (never two live sockets).
    conn.reconnectNow();
    expect(h.sockets).toHaveLength(2);
    // The replacement re-sends the same subscribe on open.
    h.sockets[1].open();
    expect(decodeFrame(h.sockets[1].sent[0])[0].type).toBe(MsgType.SUBSCRIBE);
  });

  it('resets the attempt counter once a Hello handshake lands', () => {
    const { h, conn, sock } = setup();
    sock.open();
    sock.drop();
    expect(conn.attempts).toBe(1);
    h.clock.advance(60_000); // the reconnect tick fires and opens the replacement
    const replacement = h.sockets[1];
    replacement.open();
    replacement.deliver(goldenU8('cold_hello'));
    // A completed handshake is a completed session attach: the counter zeroes.
    expect(conn.attempts).toBe(0);
    expect(conn.status).toBe('live');
  });
});

// --- depth seam honesty (QA3 C-1) --------------------------------------------
// A session reattach can append a reconstructed block from another grid onto
// the old session's live columns with a seq→time break. The transport must
// surface the boundary as a `gap` Marker instead of letting the ring hold two
// unmarked timelines.

describe('Connection — depth seam markers (QA3 C-1)', () => {
  const DT = 250_000_000n; // 250 ms, matches buildHello's epoch_params

  /** A depth column with an explicit t0 (buildDepthCol derives t0 from seq). */
  function buildDepthColAt(epoch: number, colSeq: number, t0: bigint, final = true): Uint8Array {
    const payload = new Uint8Array(32);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, epoch, true);
    dv.setUint32(4, colSeq, true);
    dv.setBigInt64(8, t0, true);
    dv.setUint8(16, 0); // mode L2
    dv.setUint8(17, final ? 1 : 0);
    dv.setUint16(18, 0, true); // pad
    dv.setUint32(20, 1, true); // n_rows
    dv.setFloat32(24, 5.0, true);
    dv.setFloat32(28, 4.0, true);
    return frameBytes(MsgType.DEPTH_COL, payload, 0);
  }

  function liveT0(seq: number): bigint {
    return BigInt(seq) * DT;
  }

  it('emits one gap Marker at a backward reattach seam, then stops (no spam)', () => {
    const h = harness();
    const onStream = vi.fn();
    const conn = h.makeConn({ onStream });
    conn.subscribe('crypto', 'ETHUSDT', 'live');
    h.sockets[0].open();
    // Attach handshake carries the epoch dt the tracker measures against.
    h.sockets[0].deliver(buildHello('session-A', 0));
    h.sockets[0].deliver(buildDepthColAt(0, 100, liveT0(100)));
    h.sockets[0].deliver(buildDepthColAt(0, 101, liveT0(101)));
    expect(onStream).toHaveBeenCalledTimes(2); // clean run: columns only

    // Reconstructed block head: wall-time runs BACKWARD ~30 min.
    const head = liveT0(101) - 1_806_500_000_000n;
    h.sockets[0].deliver(buildDepthColAt(0, 102, head));
    expect(onStream).toHaveBeenCalledTimes(4); // column + synthetic marker
    const forwardedCol = onStream.mock.calls[2][0];
    const marker = onStream.mock.calls[3][0];
    expect(forwardedCol.type).toBe(MsgType.DEPTH_COL);
    expect(forwardedCol.col_seq).toBe(102);
    expect(marker).toMatchObject({ type: MsgType.MARKER, kind: 'gap', ts_ns: head });

    // The block marches at 3.75 s/col against a 250 ms dt: every step is a
    // warp, but only the head is news — the tracker must not flood markers.
    let t0 = head;
    for (let seq = 103; seq < 140; seq++) {
      t0 += 3_750_000_000n;
      h.sockets[0].deliver(buildDepthColAt(0, seq, t0));
    }
    expect(onStream).toHaveBeenCalledTimes(4 + (140 - 103)); // columns only

    // Trailing backward seam (block ends ahead, live resumes earlier): fires.
    const resume = t0 - 9_000_000_000n;
    h.sockets[0].deliver(buildDepthColAt(0, 140, resume));
    const trailing = onStream.mock.calls[onStream.mock.calls.length - 1][0];
    expect(trailing).toMatchObject({ type: MsgType.MARKER, kind: 'gap', ts_ns: resume });
  });

  it('does NOT mark a warp across an epoch change (a re-anchor is legitimate)', () => {
    const h = harness();
    const onStream = vi.fn();
    const conn = h.makeConn({ onStream });
    conn.subscribe('crypto', 'BTCUSDT', 'live');
    h.sockets[0].open();
    h.sockets[0].deliver(buildHello('session-A', 0));
    h.sockets[0].deliver(buildDepthColAt(0, 10, liveT0(10)));
    // A new epoch (new price frame) whose t0 steps by a large but plausible
    // amount: no marker — the epoch change is announced, not data corruption.
    h.sockets[0].deliver(coldFrame(MsgType.EPOCH_START, {
      epoch: 1,
      epoch_params: { epoch: 1, tick: 0.01, tick_multiple: 5, dt_ns: Number(DT), p0: 100.0, rows: 2048 },
    }));
    h.sockets[0].deliver(buildDepthColAt(1, 11, liveT0(11) + 60_000_000_000n));
    expect(onStream).toHaveBeenCalledTimes(2); // both columns, no marker
  });

  it('never marks replay streams (a SEEK is a user-steered time jump)', () => {
    const h = harness();
    const onStream = vi.fn();
    const conn = h.makeConn({ onStream });
    conn.subscribe('crypto', 'BTCUSDT', 'replay');
    h.sockets[0].open();
    h.sockets[0].deliver(buildHello('session-A', 0));
    h.sockets[0].deliver(buildDepthColAt(0, 10, liveT0(10)));
    h.sockets[0].deliver(buildDepthColAt(0, 11, liveT0(11) - 600_000_000_000n)); // seek back
    expect(onStream).toHaveBeenCalledTimes(2); // columns only
  });

  it('a session replacement clears the seam cursor (the new grid starts clean)', () => {
    const h = harness();
    const onStream = vi.fn();
    const conn = h.makeConn({ onStream });
    conn.subscribe('crypto', 'BTCUSDT', 'live');
    h.sockets[0].open();
    h.sockets[0].deliver(buildHello('session-A', 0));
    h.sockets[0].deliver(buildDepthColAt(0, 50, liveT0(50)));
    h.sockets[0].deliver(buildDepthColAt(0, 51, liveT0(51)));
    expect(onStream).toHaveBeenCalledTimes(2);
    // The sidecar respawned: a new session id, col_seq restarting low with an
    // unrelated t0 base. Without the reset this FIRST column would measure
    // against the old cursor and fabricate a seam marker.
    h.sockets[0].deliver(buildHello('session-B', 0));
    h.sockets[0].deliver(buildDepthColAt(0, 1, 7_000_000_000n));
    h.sockets[0].deliver(buildDepthColAt(0, 2, 7_250_000_000n));
    expect(onStream).toHaveBeenCalledTimes(4);
  });

  it('a subscription switch clears the seam cursor too (no cross-session compare)', () => {
    const h = harness();
    const onStream = vi.fn();
    const conn = h.makeConn({ onStream });
    conn.subscribe('crypto', 'BTCUSDT', 'live');
    h.sockets[0].open();
    h.sockets[0].deliver(buildHello('session-A', 0));
    h.sockets[0].deliver(buildDepthColAt(0, 50, liveT0(50)));
    conn.subscribe('sim', 'SIM-DEMO', 'live');
    h.sockets[0].deliver(buildHello('session-B', 0));
    // New stream's first column with a wildly different t0 base: first sample,
    // nothing to compare against — no marker.
    h.sockets[0].deliver(buildDepthColAt(0, 1, 3_000_000_000n));
    h.sockets[0].deliver(buildDepthColAt(0, 2, 3_250_000_000n));
    expect(onStream).toHaveBeenCalledTimes(3); // col + col + col, no marker
  });

  it('clean cadence with a seq gap (server-owned gap) emits no marker', () => {
    const h = harness();
    const onStream = vi.fn();
    const conn = h.makeConn({ onStream });
    conn.subscribe('sim', 'SIM-DEMO', 'live');
    h.sockets[0].open();
    h.sockets[0].deliver(buildHello('session-A', 0));
    h.sockets[0].deliver(buildDepthColAt(0, 10, liveT0(10)));
    // seq jumps 20 columns; t0 advances exactly 20 × dt — consistent, and the
    // server emits its own gap marker for this case.
    h.sockets[0].deliver(buildDepthColAt(0, 30, liveT0(30)));
    expect(onStream).toHaveBeenCalledTimes(2);
  });
});
