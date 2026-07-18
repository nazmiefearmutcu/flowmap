import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SocketLike } from '../net/connection';
import type { StreamMsg } from '../net/connection';
import { decodeFrame } from '../proto/decode';
import { MsgType, type Msg } from '../proto/types';
import { setFlowMapTransport, useFlowMapStore } from './store';

/** Decode a single-message control frame the FakeWebSocket captured. */
function sentMsg(bytes: Uint8Array): Msg {
  return decodeFrame(bytes)[0];
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
    expect(store.getState().subscription).toEqual({ market: 'crypto', symbol: 'BTCUSDT', mode: 'live' });
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
