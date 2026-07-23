/**
 * FlowMap session store (zustand).
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
  /** Server price-grid coverage preset ('native' | 'wide' | 'full'). */
  band: string;
}

export interface FlowMapState {
  // --- low-frequency session/connection metadata (React-rendered) ---
  status: ConnStatus;
  feedState: FeedState | null;
  /** Next RTH open (UTC ns) from a `Status{feed_state='closed'}`; else null. Drives the closed banner countdown. */
  nextOpenTs: bigint | null;
  capability: Record<string, unknown> | null;
  sessionId: string | null;
  protocolVersion: number | null;
  gridEpoch: number | null;
  normSeed: number | null;
  latencyMs: number | null;
  clockSkewMs: number | null;
  epochs: Map<number, EpochParams>;
  subscription: Subscription | null;
  /** Replay transport (low-frequency UI state; ignored in live mode). */
  speed: number;
  paused: boolean;

  // --- actions ---
  connectAndSubscribe: (
    market: string,
    symbol: string,
    mode?: StreamMode,
    band?: string,
  ) => void;
  requestHistory: (before_t: bigint, n: number) => Promise<HistoryResponse>;
  /** Replay transport controls — send the matching control message + track UI state. */
  setSpeed: (x: number) => void;
  pause: () => void;
  resume: () => void;
  seek: (t: bigint) => void;
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
  nextOpenTs: null,
  capability: null,
  sessionId: null,
  protocolVersion: null,
  gridEpoch: null,
  normSeed: null,
  latencyMs: null,
  clockSkewMs: null,
  epochs: new Map(),
  subscription: null,
  speed: 1,
  paused: false,

  connectAndSubscribe(market, symbol, mode = 'live', band = 'native') {
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
          // Advance the grid epoch to the newest re-anchored frame so the price
          // axis + overlays follow it (e.g. an equity grid re-anchoring from its
          // nominal $100 p0 to the symbol's real price mid-stream). Only ever
          // advance: history responses batch EpochStarts for OLDER epochs (§6.3)
          // and must not regress the live price frame.
          const cur = get().gridEpoch;
          const gridEpoch = cur === null ? ev.epoch : Math.max(cur, ev.epoch);
          set({ epochs, gridEpoch });
        },
        onStatus: (status) => {
          set({
            feedState: status.feed_state,
            // Only a closed Status carries a next open; a live/degraded Status
            // clears any stale countdown target.
            nextOpenTs: status.next_open_ts ?? null,
            capability: status.capability,
            latencyMs: status.latency_ms,
            clockSkewMs: status.clock_skew_ms,
          });
        },
        onConnStatus: (status) => set({ status }),
      });
    }
    // A fresh subscription resets the transport (a new replay clock starts at 1×,
    // playing; live mode ignores these but they must not carry over stale state).
    set({ subscription: { market, symbol, mode, band }, speed: 1, paused: false });
    conn.subscribe(market, symbol, mode, band);
  },

  requestHistory(before_t, n) {
    if (conn === null) {
      return Promise.reject(new Error('flowmap: not connected'));
    }
    return conn.requestHistory(before_t, n);
  },

  setSpeed(x) {
    conn?.setSpeed(x);
    set({ speed: x });
  },

  pause() {
    conn?.pause();
    set({ paused: true });
  },

  resume() {
    conn?.resume();
    set({ paused: false });
  },

  seek(t) {
    conn?.seek(t);
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
