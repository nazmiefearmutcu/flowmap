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
  /** Server price-grid coverage preset ('native' | 'wide' | 'full' | 'deep'). */
  band: string;
}

/**
 * The identity of the GRID a subscription renders — the key App.tsx watches to
 * decide when the GL ring and the shared book buffer must be torn down.
 *
 * Deliberately NOT the whole subscription. `mode` is excluded: a live⇄replay
 * toggle re-subscribes the same instrument on the same grid, and resetting there
 * would throw away the user's scrolled-back history for nothing.
 *
 * `band` IS included, and that is the fix: it is part of the subscription
 * identity in `connectAndSubscribe` below and in net/connection.ts, so changing
 * it genuinely starts a new server session — one whose grid may be a different
 * HEIGHT (`deep` is 4096 rows against the default 2048). Keying only on
 * market:symbol left the renderer holding a ring sized for the old grid, which
 * is exactly the geometry mismatch gl/sessionGate.ts then has to survive.
 */
export function sessionResetKey(sub: Subscription | null): string | null {
  return sub === null ? null : `${sub.market}:${sub.symbol}:${sub.band}`;
}

export interface FlowMapState {
  // --- low-frequency session/connection metadata (React-rendered) ---
  status: ConnStatus;
  feedState: FeedState | null;
  /** Next RTH open (UTC ns) from a `Status{feed_state='closed'}`; else null. Drives the closed banner countdown. */
  nextOpenTs: bigint | null;
  capability: Record<string, unknown> | null;
  sessionId: string | null;
  /**
   * Wire protocol version from Hello. Deliberately NOT cleared on a
   * re-subscribe, unlike the rest of the Hello-asserted fields: it describes the
   * SERVER (one build, one version, identical across every session on the same
   * socket), not the session, and nothing in the client reads it — no component,
   * no renderer path, only the store test. Clearing it would add a state
   * transition with no observer.
   */
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
    // A DIFFERENT stream is a different server session, so nothing the previous
    // one asserted may survive into it. Critical for the Status-derived fields:
    // a healthy session starts in `live` and the server broadcasts Status only on
    // a TRANSITION, so a fresh crypto session sends none at all and a stale
    // `closed` would keep the market-closed banner up forever. The epoch geometry
    // goes with it (the new grid restarts at epoch 0 — the old params must not
    // stay resolvable), as does the transport (a new replay clock starts at 1×,
    // playing; live mode ignores these but they must not carry over either).
    // Gated on the identity actually changing: an idempotent re-subscribe never
    // reaches the server, so nothing would ever re-assert what we cleared.
    const prev = get().subscription;
    if (
      prev === null ||
      prev.market !== market ||
      prev.symbol !== symbol ||
      prev.mode !== mode ||
      prev.band !== band
    ) {
      set({
        subscription: { market, symbol, mode, band },
        speed: 1,
        paused: false,
        feedState: null,
        nextOpenTs: null,
        latencyMs: null,
        clockSkewMs: null,
        // Re-asserted by the new session's Hello on attach.
        sessionId: null,
        capability: null,
        epochs: new Map(),
        gridEpoch: null,
        // normSeed belongs to this list for the same reason and matters more
        // than most of it: gl/renderer.ts latches the seed ONCE behind a
        // one-shot flag, so a survivor is not a stale frame — the new session
        // normalises its entire life against the previous symbol's density
        // scale (a $60k book's p99 against a $180 stock's).
        normSeed: null,
      });
    }
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
