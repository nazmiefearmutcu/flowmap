/**
 * FlowMap v2 session store (zustand).
 *
 * Holds ONLY low-frequency connection/session metadata — connection status,
 * capability, session id, epoch geometry, the current subscription. This is the
 * state React components render off.
 *
 * The high-frequency stream (DepthColumn / BarColumn / Trade / BBO / Marker) is
 * deliberately kept OUT of React state: pushing every column through zustand
 * would fire a `set()` per frame and storm re-renders. Instead the store owns the
 * Connection and fans the stream to a plain listener Set; the renderer subscribes
 * via `onStream(handler)` and reads those messages directly (e.g. into a WebGL
 * buffer), never through React.
 *
 * The Connection instance and the listener Set live in module scope, not in the
 * store's state, so touching them never triggers a store update.
 */

import { create } from 'zustand';

import {
  Connection,
  type ConnStatus,
  type ConnectionOptions,
  type StreamMsg,
} from '../net/connection';
import type { EpochParams, FeedState, HistoryResponse, StreamMode } from '../proto/types';

export interface Subscription {
  market: string;
  symbol: string;
  mode: StreamMode;
}

export interface FlowMapState {
  // --- low-frequency session/connection metadata (React-rendered) ---
  status: ConnStatus;
  feedState: FeedState | null;
  capability: Record<string, unknown> | null;
  sessionId: string | null;
  protocolVersion: number | null;
  gridEpoch: number | null;
  normSeed: number | null;
  latencyMs: number | null;
  clockSkewMs: number | null;
  epochs: Map<number, EpochParams>;
  subscription: Subscription | null;

  // --- actions ---
  connectAndSubscribe: (market: string, symbol: string, mode?: StreamMode) => void;
  requestHistory: (before_t: bigint, n: number) => Promise<HistoryResponse>;
  disconnect: () => void;
  /** Subscribe to the raw high-frequency stream; returns an unsubscribe fn. */
  onStream: (handler: (msg: StreamMsg) => void) => () => void;
}

// --- module-scoped transport (never in React state) ----------------------------

let conn: Connection | null = null;
const streamListeners = new Set<(msg: StreamMsg) => void>();

/**
 * Transport overrides (WebSocket factory / timers / url) merged into the
 * Connection when it is created. Production leaves these empty (real WebSocket +
 * real timers); tests inject a FakeWebSocket factory and a deterministic clock.
 * The store's own state-wiring callbacks always take precedence.
 */
let transportOverrides: Partial<ConnectionOptions> = {};

/** Configure the Connection transport before connecting (primarily for tests). */
export function setFlowMapTransport(overrides: Partial<ConnectionOptions>): void {
  transportOverrides = overrides;
}

function fanoutStream(msg: StreamMsg): void {
  for (const listener of streamListeners) {
    listener(msg);
  }
}

export const useFlowMapStore = create<FlowMapState>((set, get) => ({
  status: 'idle',
  feedState: null,
  capability: null,
  sessionId: null,
  protocolVersion: null,
  gridEpoch: null,
  normSeed: null,
  latencyMs: null,
  clockSkewMs: null,
  epochs: new Map(),
  subscription: null,

  connectAndSubscribe(market, symbol, mode = 'live') {
    if (conn === null) {
      conn = new Connection({
        ...transportOverrides,
        // High-frequency stream: straight to the listener Set, never `set()`.
        onStream: fanoutStream,
        onHello: (hello) => {
          const epochs = new Map(get().epochs);
          epochs.set(hello.epoch_params.epoch, hello.epoch_params);
          set({
            sessionId: hello.session_id,
            protocolVersion: hello.protocol_version,
            capability: hello.capability,
            normSeed: hello.norm_seed,
            gridEpoch: hello.grid_epoch,
            epochs,
          });
        },
        onEpochStart: (ev) => {
          const epochs = new Map(get().epochs);
          epochs.set(ev.epoch, ev.epoch_params);
          set({ epochs });
        },
        onStatus: (status) => {
          set({
            feedState: status.feed_state,
            capability: status.capability,
            latencyMs: status.latency_ms,
            clockSkewMs: status.clock_skew_ms,
          });
        },
        onConnStatus: (status) => set({ status }),
      });
    }
    set({ subscription: { market, symbol, mode } });
    conn.subscribe(market, symbol, mode);
  },

  requestHistory(before_t, n) {
    if (conn === null) {
      return Promise.reject(new Error('flowmap: not connected'));
    }
    return conn.requestHistory(before_t, n);
  },

  disconnect() {
    conn?.close();
    conn = null;
    set({ status: 'closed', subscription: null });
  },

  onStream(handler) {
    streamListeners.add(handler);
    return () => {
      streamListeners.delete(handler);
    };
  },
}));

/** Test seam: current Connection instance (or null). Not for production use. */
export function __getConnection(): Connection | null {
  return conn;
}
