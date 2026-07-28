import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SocketLike } from '../net/connection';
import type { StreamMsg } from '../net/connection';
import { decodeFrame } from '../proto/decode';
import { MsgType, type Msg } from '../proto/types';
import { sessionResetKey, setFlowMapTransport, useFlowMapStore } from './store';

/** Decode a single-message control frame the FakeWebSocket captured. */
function sentMsg(bytes: Uint8Array): Msg {
  return decodeFrame(bytes)[0];
}

// Cold-JSON envelope (mirrors proto/wire + encode.ts `coldFrame`): 8-byte
// header (<BBHI> msg_type, ver, flags=FLAG_JSON, payload_len) + UTF-8 JSON,
// bigints as bare integer literals, padded to a 4-byte boundary. Lets the store
// test deliver server→client cold messages (Status / EpochStart) the client has
// no encoder for, exercising the store's onStatus / onEpochStart wiring.
const FLAG_JSON = 0x0001;
const PROTO_VER = 1;
function coldFrameBytes(msgType: number, value: unknown): Uint8Array {
  const json = JSON.stringify(value, (_k, v) =>
    typeof v === 'bigint' ? (JSON as { rawJSON(s: string): unknown }).rawJSON(v.toString()) : v,
  );
  const payload = new TextEncoder().encode(json);
  const padded = (payload.length + 3) & ~3;
  const out = new Uint8Array(8 + padded);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, msgType);
  dv.setUint8(1, PROTO_VER);
  dv.setUint16(2, FLAG_JSON, true);
  dv.setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'golden');

function goldenU8(name: string): Uint8Array {
  const b = readFileSync(join(GOLDEN_DIR, `${name}.bin`));
  return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

class FakeWebSocket implements SocketLike {
  binaryType = 'blob';
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  constructor(readonly url: string) {}
  send(data: ArrayBufferLike | ArrayBufferView | string): void {
    if (typeof data !== 'string' && ArrayBuffer.isView(data)) {
      this.sent.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    }
  }
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

let sockets: FakeWebSocket[] = [];

function installFakeTransport(): void {
  sockets = [];
  setFlowMapTransport({
    url: 'wss://test.invalid/ws',
    wsFactory: (url) => {
      const s = new FakeWebSocket(url);
      sockets.push(s);
      return s;
    },
  });
}

afterEach(() => {
  useFlowMapStore.getState().disconnect();
  setFlowMapTransport({});
});

describe('FlowMap store', () => {
  it('connectAndSubscribe wires connection status + Hello metadata into state', () => {
    installFakeTransport();
    const store = useFlowMapStore;

    store.getState().connectAndSubscribe('crypto', 'BTCUSDT');
    expect(store.getState().subscription).toEqual({
      market: 'crypto',
      symbol: 'BTCUSDT',
      mode: 'live',
      band: 'native',
    });
    expect(store.getState().status).toBe('connecting');

    sockets[0].open();
    sockets[0].deliver(goldenU8('cold_hello'));

    const s = store.getState();
    expect(s.status).toBe('live');
    expect(s.sessionId).toBe('golden-session-0001');
    expect(s.protocolVersion).toBe(1);
    expect(s.capability).toEqual({ depth: 'L2', trades: 'full', bbo: 'native' });
    expect(s.epochs.get(3)).toMatchObject({ epoch: 3, rows: 2048 });
  });

  it('routes the hot stream to onStream listeners WITHOUT touching React state', () => {
    installFakeTransport();
    const store = useFlowMapStore;

    const received: StreamMsg[] = [];
    const unsub = store.getState().onStream((msg) => received.push(msg));

    // A store subscriber that would flag any state change during the stream.
    const stateChanges = vi.fn();
    const unsubStore = store.subscribe(stateChanges);

    store.getState().connectAndSubscribe('crypto', 'BTCUSDT');
    sockets[0].open();
    stateChanges.mockClear(); // ignore connect/subscribe transitions

    sockets[0].deliver(goldenU8('hot_depth_col_l2'));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe(MsgType.DEPTH_COL);
    // The high-frequency column must NOT have produced a store update.
    expect(stateChanges).not.toHaveBeenCalled();

    unsub();
    unsubStore();
  });

  it('surfaces a closed Status (feed_state + next_open_ts) for the banner', () => {
    installFakeTransport();
    const store = useFlowMapStore;

    store.getState().connectAndSubscribe('equity', 'AAPL');
    sockets[0].open();
    sockets[0].deliver(goldenU8('cold_hello'));
    expect(store.getState().feedState).toBeNull();
    expect(store.getState().nextOpenTs).toBeNull();

    // Terminal closed Status (spec §7.1): equity RTH window shut on a weekend.
    const nextOpen = 1_752_710_400_000_000_000n;
    sockets[0].deliver(
      coldFrameBytes(MsgType.STATUS, {
        feed_state: 'closed',
        capability: { depth: 'SYNTH_PROFILE', tape: 'poll', vwap: 'approx' },
        latency_ms: 0.0,
        clock_skew_ms: 0.0,
        next_open_ts: nextOpen,
      }),
    );

    const s = store.getState();
    expect(s.feedState).toBe('closed');
    expect(s.nextOpenTs).toBe(nextOpen); // exact bigint, no ns rounding
    expect(s.capability).toMatchObject({ depth: 'SYNTH_PROFILE', tape: 'poll' });

    // A later live Status clears the stale countdown target.
    sockets[0].deliver(
      coldFrameBytes(MsgType.STATUS, {
        feed_state: 'live',
        capability: { depth: 'SYNTH_PROFILE', tape: 'poll', vwap: 'approx' },
        latency_ms: 1.0,
        clock_skew_ms: 0.0,
        next_open_ts: null,
      }),
    );
    expect(store.getState().feedState).toBe('live');
    expect(store.getState().nextOpenTs).toBeNull();
  });

  it('drops the previous session’s state when subscribing to a different stream', () => {
    installFakeTransport();
    const store = useFlowMapStore;

    store.getState().connectAndSubscribe('equity', 'AAPL');
    sockets[0].open();
    sockets[0].deliver(goldenU8('cold_hello'));
    sockets[0].deliver(
      coldFrameBytes(MsgType.STATUS, {
        feed_state: 'closed',
        capability: { depth: 'SYNTH_PROFILE', tape: 'poll', vwap: 'approx' },
        latency_ms: 0.0,
        clock_skew_ms: 0.0,
        next_open_ts: 1_752_710_400_000_000_000n,
      }),
    );
    expect(store.getState().feedState).toBe('closed');
    expect(store.getState().epochs.size).toBeGreaterThan(0);

    // Switch to a 24/7 crypto symbol. The new session is healthy, so it starts
    // in `live` and — Status being broadcast only on a TRANSITION — sends no
    // Status at all: nothing would ever clear the stale 'closed' and the banner
    // would sit over the crypto chart forever.
    store.getState().connectAndSubscribe('crypto', 'BTCUSDT');
    expect(store.getState().feedState).toBeNull();
    expect(store.getState().nextOpenTs).toBeNull();
    // The equity grid's epoch params must not stay resolvable either: the new
    // session's grid restarts at epoch 0 and would otherwise decode against the
    // old symbol's price frame.
    expect(store.getState().epochs.size).toBe(0);
    expect(store.getState().gridEpoch).toBeNull();

    // The new session's Hello re-seeds the session facts; no banner reappears.
    sockets[0].deliver(goldenU8('cold_hello'));
    expect(store.getState().feedState).toBeNull();
    expect(store.getState().gridEpoch).toBe(3);
    expect(store.getState().capability).not.toBeNull();
  });

  it('keeps session state when re-subscribing to the SAME stream', () => {
    installFakeTransport();
    const store = useFlowMapStore;

    store.getState().connectAndSubscribe('crypto', 'BTCUSDT');
    sockets[0].open();
    sockets[0].deliver(goldenU8('cold_hello'));
    const sentBefore = sockets[0].sent.length;

    // The Connection recognises the identical stream and sends nothing, so the
    // server never re-attaches and never re-asserts Hello. Wiping the session
    // facts here would blank the capability chips / price axis permanently.
    store.getState().connectAndSubscribe('crypto', 'BTCUSDT');
    expect(sockets[0].sent).toHaveLength(sentBefore);
    expect(store.getState().capability).not.toBeNull();
    expect(store.getState().epochs.get(3)).toMatchObject({ epoch: 3 });
    expect(store.getState().gridEpoch).toBe(3);
  });

  it('advances gridEpoch on a re-anchor EpochStart but never regresses it', () => {
    installFakeTransport();
    const store = useFlowMapStore;

    store.getState().connectAndSubscribe('equity', 'AAPL');
    sockets[0].open();
    sockets[0].deliver(goldenU8('cold_hello')); // grid_epoch 3
    expect(store.getState().gridEpoch).toBe(3);

    // Mid-stream re-anchor (equity grid jumps from nominal $100 p0 to the real
    // price): a fresh, higher epoch must become the current grid frame.
    const params4 = { epoch: 4, tick: 0.01, tick_multiple: 1, dt_ns: 10_000_000_000, p0: 159.52, rows: 4096 };
    sockets[0].deliver(coldFrameBytes(MsgType.EPOCH_START, { epoch: 4, epoch_params: params4 }));
    expect(store.getState().gridEpoch).toBe(4);
    expect(store.getState().epochs.get(4)).toMatchObject({ epoch: 4, p0: 159.52 });

    // A history response batches EpochStarts for OLDER epochs — these must NOT
    // pull the live price frame backward.
    const params2 = { epoch: 2, tick: 0.01, tick_multiple: 1, dt_ns: 10_000_000_000, p0: 79.52, rows: 4096 };
    sockets[0].deliver(coldFrameBytes(MsgType.EPOCH_START, { epoch: 2, epoch_params: params2 }));
    expect(store.getState().gridEpoch).toBe(4); // held at the newest
    expect(store.getState().epochs.get(2)).toMatchObject({ epoch: 2 }); // still recorded
  });
});

describe('FlowMap store — replay transport', () => {
  it('subscribes in replay mode and sends the right control messages', () => {
    installFakeTransport();
    const store = useFlowMapStore;

    store.getState().connectAndSubscribe('binance-spot', 'BTCUSDT', 'replay');
    expect(store.getState().subscription).toEqual({
      market: 'binance-spot',
      symbol: 'BTCUSDT',
      mode: 'replay',
      band: 'native',
    });
    sockets[0].open();

    // The subscribe carries mode=replay.
    const first = sentMsg(sockets[0].sent[0]);
    expect(first.type).toBe(MsgType.SUBSCRIBE);
    expect((first as Extract<Msg, { type: MsgType.SUBSCRIBE }>).mode).toBe('replay');

    store.getState().setSpeed(5);
    store.getState().pause();
    store.getState().resume();
    store.getState().seek(1234n);

    const types = sockets[0].sent.map((b) => sentMsg(b).type);
    expect(types).toEqual([
      MsgType.SUBSCRIBE,
      MsgType.SET_SPEED,
      MsgType.PAUSE,
      MsgType.RESUME,
      MsgType.SEEK,
    ]);

    const setSpeed = sentMsg(sockets[0].sent[1]);
    expect((setSpeed as Extract<Msg, { type: MsgType.SET_SPEED }>).x).toBe(5);
    const seek = sentMsg(sockets[0].sent[4]);
    expect((seek as Extract<Msg, { type: MsgType.SEEK }>).t).toBe(1234n);

    // Low-frequency UI state tracked the transport.
    expect(store.getState().speed).toBe(5);
    expect(store.getState().paused).toBe(false); // pause() then resume()
  });

  it('clears EVERY Hello-asserted field on a fresh subscription — normSeed included', () => {
    installFakeTransport();
    const store = useFlowMapStore;

    store.getState().connectAndSubscribe('crypto', 'BTCUSDT');
    sockets[0].open();
    sockets[0].deliver(goldenU8('cold_hello'));
    expect(store.getState().normSeed).toBe(42.5);
    expect(store.getState().sessionId).toBe('golden-session-0001');

    store.getState().connectAndSubscribe('equity', 'AAPL');

    const s = store.getState();
    expect(s.sessionId).toBeNull();
    expect(s.capability).toBeNull();
    expect(s.gridEpoch).toBeNull();
    expect(s.epochs.size).toBe(0);
    // normSeed is asserted by that SAME Hello and was missed. It matters more
    // than the rest: gl/renderer.ts latches it once behind a one-shot flag, so a
    // survivor makes the new session normalise its whole life against the
    // previous symbol's density scale (a $60k book's p99 vs a $180 stock's).
    expect(s.normSeed).toBeNull();
  });

  it('resets speed/paused on a fresh subscription', () => {
    installFakeTransport();
    const store = useFlowMapStore;

    store.getState().connectAndSubscribe('sim', 'SIM-DEMO', 'replay');
    sockets[0].open();
    store.getState().setSpeed(50);
    store.getState().pause();
    expect(store.getState().speed).toBe(50);
    expect(store.getState().paused).toBe(true);

    store.getState().connectAndSubscribe('sim', 'SIM-DEMO', 'live');
    expect(store.getState().speed).toBe(1);
    expect(store.getState().paused).toBe(false);
  });
});

// The key App.tsx uses to decide whether a subscription change must tear the GL
// ring down and clear the shared book buffer. It is NOT the whole subscription:
// a mode toggle re-subscribes the same grid and must keep scrolled-back history.
describe('sessionResetKey', () => {
  const sub = { market: 'crypto', symbol: 'BTCUSDT', mode: 'live' as const, band: 'native' };

  it('is null with no subscription', () => {
    expect(sessionResetKey(null)).toBeNull();
  });

  it('changes on a market or symbol switch', () => {
    expect(sessionResetKey({ ...sub, symbol: 'ETHUSDT' })).not.toBe(sessionResetKey(sub));
    expect(sessionResetKey({ ...sub, market: 'equity' })).not.toBe(sessionResetKey(sub));
  });

  it('changes on a BAND switch — a new server grid, with its own row count', () => {
    // `band` is part of the subscription identity in both store.ts and
    // net/connection.ts, so changing it really does start a new server session;
    // `deep` is a 4096-row grid against the default 2048. Leaving it out of the
    // key meant the renderer kept a ring sized for the OLD grid.
    expect(sessionResetKey({ ...sub, band: 'deep' })).not.toBe(sessionResetKey(sub));
    expect(sessionResetKey({ ...sub, band: 'wide' })).not.toBe(sessionResetKey(sub));
  });

  it('does NOT change on a mode toggle — same grid, keep the scroll-back', () => {
    expect(sessionResetKey({ ...sub, mode: 'replay' })).toBe(sessionResetKey(sub));
  });

  it('is stable for an identical subscription', () => {
    expect(sessionResetKey({ ...sub })).toBe(sessionResetKey(sub));
  });
});
