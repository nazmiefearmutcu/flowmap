/**
 * FlowMap book/tape buffer (M2 T11) — the module-scoped high-frequency store
 * for the DOM ladder + time & sales panels.
 *
 * The panels update at high frequency (book ~4-20/s, trades ~5-120/s). Pushing
 * every DepthColumn / BBO / Trade through React state would storm re-renders, so
 * — exactly like the renderer's column stream (see state/store.ts) — this buffer
 * lives OUTSIDE React: it subscribes to the store's `onStream` fan-out ONCE, keeps
 * the current book (newest DepthColumn's density arrays + geometry), the current
 * BBO, and a bounded ring of the most recent trades, and exposes:
 *
 *   - {@link getSnapshot}: a cheap, lazily-rebuilt immutable snapshot (rebuilt only
 *     when the buffer actually changed — never per read);
 *   - {@link subscribe}: a listener the panels register; notifications are THROTTLED
 *     to ~10 Hz (coalescing a burst of columns/trades into one panel update) and
 *     are only scheduled while at least one panel is subscribed. No timer spins
 *     when nothing is listening or nothing is flowing.
 *
 * Nothing here touches zustand/React state, so the GL loop and the low-frequency
 * session store are untouched. Epoch geometry (row→price) and the capability
 * descriptor stay in the zustand store; the panels read those with normal
 * selectors and combine them with this buffer's book/bbo/trades.
 */

import type { StreamMsg } from '../net/connection';
import { MsgType, type BBO, type DepthColumn, type Trade } from '../proto/types';
import { useFlowMapStore } from './store';

/** Max trades retained for the tape (spec §9: "last ~200"); ring is a touch larger. */
export const TRADE_RING = 256;
/** Panel notify cadence — coalesce the high-freq stream to ~10 Hz. */
export const THROTTLE_MS = 100;

/** Current book: the newest DepthColumn's density arrays + identity. */
export interface BookBuffer {
  epoch: number;
  /** MODE_L2 | MODE_L1_BAND | MODE_SYNTH_PROFILE (proto/types). */
  mode: number;
  colSeq: number;
  t0Ns: bigint;
  /** Per-row resting-size density (index r ↔ price p0 + r·step of the epoch). */
  bid: Float32Array;
  /** null iff mode === MODE_SYNTH_PROFILE (single-channel volume-at-price). */
  ask: Float32Array | null;
}

export interface BboBuffer {
  tsNs: bigint;
  bidPx: number;
  bidSz: number;
  askPx: number;
  askSz: number;
}

export interface TapeTrade {
  tsNs: bigint;
  price: number;
  size: number;
  /** SIDE_BUY | SIDE_SELL | SIDE_UNKNOWN (proto/types). */
  side: number;
  venue: string;
}

/** Immutable per-flush view the panels render off. `trades` is NEWEST-FIRST. */
export interface BookSnapshot {
  version: number;
  book: BookBuffer | null;
  bbo: BboBuffer | null;
  trades: readonly TapeTrade[];
}

const EMPTY_TRADES: readonly TapeTrade[] = Object.freeze([]);

// --- module-scoped buffer (never in React state) --------------------------------

let book: BookBuffer | null = null;
let bbo: BboBuffer | null = null;
/** Newest-LAST ring (push / shift-oldest); snapshot exposes it newest-first. */
let trades: TapeTrade[] = [];
let version = 0;

let cachedSnapshot: BookSnapshot | null = null;

const listeners = new Set<(s: BookSnapshot) => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Unsubscribe handle for the single store.onStream subscription (lazy). */
let streamUnsub: (() => void) | null = null;

/** Coerce a canonical ns field to bigint (cold-JSON small ints decode as number). */
function toBigNs(x: bigint | number): bigint {
  return typeof x === 'bigint' ? x : BigInt(Math.round(x));
}

/** Mark the buffer dirty and schedule one throttled listener notification. */
function bump(): void {
  version += 1;
  cachedSnapshot = null;
  if (listeners.size === 0 || flushTimer !== null) return;
  flushTimer = setTimeout(flush, THROTTLE_MS);
}

function flush(): void {
  flushTimer = null;
  const snap = getSnapshot();
  for (const cb of listeners) cb(snap);
}

/** The single handler wired to the raw stream (and the test-injection seam). */
function handle(msg: StreamMsg): void {
  switch (msg.type) {
    case MsgType.DEPTH_COL: {
      const c = msg as DepthColumn;
      // The live-edge column is the in-progress PARTIAL (final=false): it starts
      // EMPTY and fills over its interval, so it is NOT the current book. The
      // settled book is the newest FINALIZED column (server/core/session.py emits
      // both). Ignore partials for the ladder — the heatmap/crosshair use them, the
      // DOM ladder wants the last settled snapshot.
      if (!c.final) return;
      // Newest finalized column wins; ignore a late/out-of-order column.
      if (book !== null && c.epoch === book.epoch && c.col_seq < book.colSeq) return;
      book = {
        epoch: c.epoch,
        mode: c.mode,
        colSeq: c.col_seq,
        t0Ns: toBigNs(c.t0_ns),
        bid: c.bid,
        ask: c.ask,
      };
      bump();
      return;
    }
    case MsgType.BBO: {
      const b = msg as BBO;
      bbo = {
        tsNs: toBigNs(b.ts_ns),
        bidPx: b.bid_px,
        bidSz: b.bid_sz,
        askPx: b.ask_px,
        askSz: b.ask_sz,
      };
      bump();
      return;
    }
    case MsgType.TRADE: {
      const t = msg as Trade;
      trades.push({
        tsNs: toBigNs(t.ts_ns),
        price: t.price,
        size: t.size,
        side: t.side,
        venue: t.venue,
      });
      if (trades.length > TRADE_RING) trades.shift();
      bump();
      return;
    }
    default:
      // BarColumn / Marker are not part of the ladder or tape.
      return;
  }
}

function ensureStreamSubscription(): void {
  if (streamUnsub !== null) return;
  streamUnsub = useFlowMapStore.getState().onStream(handle);
}

// --- public surface -------------------------------------------------------------

/**
 * Current immutable snapshot. Cheap: the object is memoized and only rebuilt after
 * a mutation (so many reads between updates share one allocation). `trades` is
 * reversed to newest-first here, off the high-frequency path.
 */
export function getSnapshot(): BookSnapshot {
  if (cachedSnapshot === null) {
    cachedSnapshot = {
      version,
      book,
      bbo,
      trades: trades.length === 0 ? EMPTY_TRADES : trades.slice().reverse(),
    };
  }
  return cachedSnapshot;
}

/**
 * Register a panel listener (notified at ~10 Hz max). Lazily opens the single
 * store.onStream subscription on first subscriber. Returns an unsubscribe fn that
 * stops the throttle timer once the last panel leaves.
 */
export function subscribe(cb: (s: BookSnapshot) => void): () => void {
  ensureStreamSubscription();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };
}

/**
 * Clear the current book / BBO / tape for a NEW subscription (symbol switch),
 * WITHOUT tearing down the stream subscription or panel listeners (unlike
 * {@link resetForTest}). Otherwise the DOM ladder keeps the OLD symbol's settled
 * book until the new session's first FINALIZED column arrives (a full interval
 * later, since partials are ignored), and the tape ring keeps showing the old
 * symbol's trades until {@link TRADE_RING} new ones push them out. Bumps the
 * version + schedules a throttled flush so subscribed panels repaint empty.
 * Called from App.tsx alongside the renderer reset on an actual symbol/market
 * switch (see Renderer.resetForSession).
 */
export function resetForSession(): void {
  book = null;
  bbo = null;
  trades = [];
  bump();
}

// --- test seams (not for production use) ----------------------------------------

/** Inject a stream message directly (bypasses the socket). Unit/e2e only. */
export function ingestForTest(msg: StreamMsg): void {
  handle(msg);
}

/** Force an immediate synchronous listener notification. Unit/e2e only. */
export function flushForTest(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flush();
}

/** Reset all buffer + subscription state. Unit tests only. */
export function resetForTest(): void {
  book = null;
  bbo = null;
  trades = [];
  version = 0;
  cachedSnapshot = null;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  listeners.clear();
  if (streamUnsub !== null) {
    streamUnsub();
    streamUnsub = null;
  }
}

/** Namespace handle (exposed on window.__flowmapLive for the panels e2e). */
export const bookStore = {
  getSnapshot,
  subscribe,
  resetForSession,
  ingestForTest,
  flushForTest,
  resetForTest,
  TRADE_RING,
  THROTTLE_MS,
};
