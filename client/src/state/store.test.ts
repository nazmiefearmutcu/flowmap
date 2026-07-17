import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SocketLike } from '../net/connection';
import type { StreamMsg } from '../net/connection';
import { MsgType } from '../proto/types';
import { setFlowMapTransport, useFlowMapStore } from './store';

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
