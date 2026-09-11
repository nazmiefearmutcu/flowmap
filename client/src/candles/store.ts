/**
 * Candle store (campaign 3, lane CG) — module-scoped bridge between the live
 * trade stream and the candle synth, following the bookStore pattern exactly:
 * high-frequency stream data lives OUTSIDE React; panels ask for a memoized
 * snapshot and get throttled (~10 Hz) change notifications.
 *
 * Responsibilities:
 *  - Subscribe ONCE to `useFlowMapStore.onStream` and feed every TRADE into
 *    {@link createCandleSynth} (live AND replayed trades both ride this stream;
 *    the synth's dedup/idempotency covers reconnect overlaps).
 *  - Track the column⇄time affine (`TimeMap`, the gl/overlays/coords.ts
 *    contract) from DEPTH_COL anchors so a candle's bucket start can be placed
 *    in chart column space: `col = anchorSeq + (t0 − anchorT0)/dtNs`.
 *  - Reset on a real session switch (market:symbol:band, and again when the
 *    new session's Hello lands — the same two resets App.tsx applies to the
 *    renderer + book buffer, so stale-symbol candles never linger).
 *  - Own the selectable timeframe (1m default, 5m, 15m), persisted in
 *    localStorage under `flowmap.candles.tf`.
 *
 * History seeding: checked — the store's `requestHistory` exposes only
 * `big_trades` (a size-filtered SUBSET — biased OHLC) and `bar_cols` (depth-grid
 * column aggregates, not trades). Synthesizing "past candles" from either would
 * fabricate price structure the tape never printed, so the store starts LIVE
 * and the synth fills as the session flows (honesty §7).
 */

import type { StreamMsg } from '../net/connection';
import { MsgType, type DepthColumn, type Trade } from '../proto/types';
import { useFlowMapStore } from '../state/store';
import { createCandleSynth, type Candle, type CandleSynth, type SynthStats } from './synth';

/** Column⇄time affine for the current epoch (mirrors gl/overlays/coords.TimeMap). */
export interface CandleTimeMap {
  anchorSeq: number;
  anchorT0Ns: bigint;
  dtNs: number;
}

export interface CandleTimeframe {
  label: string;
  ns: number;
}

/** Selectable candle timeframes (task spec: 1m default; 5m, 15m). */
export const CANDLE_TIMEFRAMES: readonly CandleTimeframe[] = [
  { label: '1m', ns: 60_000_000_000 },
  { label: '5m', ns: 300_000_000_000 },
  { label: '15m', ns: 900_000_000_000 },
];

export const TF_STORAGE_KEY = 'flowmap.candles.tf';
const DEFAULT_TF_NS = CANDLE_TIMEFRAMES[0].ns;

export interface CandleSnapshot {
  version: number;
  /** Oldest-first resident candles. */
  candles: Candle[];
  timeframeNs: number;
  timeframes: readonly CandleTimeframe[];
  /** Column affine for placing candle times on the chart grid; null until a column lands. */
  timeMap: CandleTimeMap | null;
  stats: SynthStats;
}

// --- module-scoped state (never in React state) ---------------------------------

let synth: CandleSynth = createCandleSynth(loadStoredTfNs());
let timeMap: CandleTimeMap | null = null;
let anchorEpoch: number | null = null;
let anchorSeq = -1;
let version = 0;
let cached: CandleSnapshot | null = null;

const listeners = new Set<(s: CandleSnapshot) => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let streamUnsub: (() => void) | null = null;
let storeUnsub: (() => void) | null = null;
let lastSessionKey: string | null = null;
let lastSessionId: string | null = null;

function loadStoredTfNs(): number {
  try {
    const raw = window.localStorage.getItem(TF_STORAGE_KEY);
    if (raw === null) return DEFAULT_TF_NS;
    const ns = Number(raw);
    return CANDLE_TIMEFRAMES.some((tf) => tf.ns === ns) ? ns : DEFAULT_TF_NS;
  } catch {
    return DEFAULT_TF_NS;
  }
}

function persistTf(ns: number): void {
  try {
    window.localStorage.setItem(TF_STORAGE_KEY, String(ns));
  } catch {
    /* private mode / quota — the choice stays session-local */
  }
}

/** Coerce a canonical ns field to bigint (cold-JSON small ints decode as number). */
function toBigNs(x: bigint | number): bigint {
  if (typeof x === 'bigint') return x;
  if (!Number.isFinite(x)) return 0n;
  return BigInt(Math.round(x));
}

function bump(): void {
  version += 1;
  cached = null;
  if (listeners.size === 0 || flushTimer !== null) return;
  flushTimer = setTimeout(flush, 100);
}

function flush(): void {
  flushTimer = null;
  const snap = getSnapshot();
  for (const cb of listeners) cb(snap);
}

function resetForNewSession(): void {
  synth.reset();
  timeMap = null;
  anchorEpoch = null;
  anchorSeq = -1;
  bump();
}

/** The single raw-stream handler (also the test-injection seam). */
function handle(msg: StreamMsg): void {
  switch (msg.type) {
    case MsgType.TRADE: {
      const tr = msg as Trade;
      // Non-finite quarantine happens inside the synth (counted, never merged).
      // A dup/late/quarantined trade mutates no candle, so the store version
      // only moves when the synth's does — idle charts never repaint.
      const before = synth.version();
      synth.push(toBigNs(tr.ts_ns), tr.price, tr.size);
      if (synth.version() !== before) bump();
      return;
    }
    case MsgType.DEPTH_COL: {
      const c = msg as DepthColumn;
      // Epoch-major anchor, same rule as the book buffer: a straggler column
      // from an OLD epoch must not re-anchor the new grid's time affine.
      if (anchorEpoch !== null && c.epoch < anchorEpoch) return;
      if (c.epoch === anchorEpoch && c.col_seq <= anchorSeq) return;
      const dt = useFlowMapStore.getState().epochs.get(c.epoch)?.dt_ns;
      if (dt === undefined || !(dt > 0)) return; // geometry not (yet) known
      anchorEpoch = c.epoch;
      anchorSeq = c.col_seq;
      timeMap = { anchorSeq: c.col_seq, anchorT0Ns: toBigNs(c.t0_ns), dtNs: dt };
      bump();
      return;
    }
    default:
      return; // BBO / BarColumn / Marker are not candle inputs
  }
}

/** Watch session identity (subscription key + Hello session) like App.tsx does. */
function watchSession(): void {
  const check = (): void => {
    const s = useFlowMapStore.getState();
    const sub = s.subscription;
    const key = sub ? `${sub.market}:${sub.symbol}:${sub.band}` : null;
    if (key !== lastSessionKey) {
      const had = lastSessionKey !== null;
      lastSessionKey = key;
      lastSessionId = s.sessionId;
      if (had) resetForNewSession(); // the FIRST subscription starts empty anyway
      return;
    }
    // Frames for the old symbol are still in flight after the ask-time reset;
    // the new session's Hello IS the moment the stream provably swapped.
    if (s.sessionId !== null && s.sessionId !== lastSessionId) {
      lastSessionId = s.sessionId;
      resetForNewSession();
    }
  };
  storeUnsub = useFlowMapStore.subscribe(check);
  lastSessionKey = (() => {
    const sub = useFlowMapStore.getState().subscription;
    return sub ? `${sub.market}:${sub.symbol}:${sub.band}` : null;
  })();
  lastSessionId = useFlowMapStore.getState().sessionId;
}

function ensureStarted(): void {
  if (streamUnsub !== null) return;
  streamUnsub = useFlowMapStore.getState().onStream(handle);
  watchSession();
}

// --- public surface -------------------------------------------------------------

/** Current memoized snapshot (rebuilt only after a mutation, never per read). */
export function getSnapshot(): CandleSnapshot {
  if (cached === null) {
    cached = {
      version,
      candles: synth.candles(),
      timeframeNs: synth.timeframeNs,
      timeframes: CANDLE_TIMEFRAMES,
      timeMap,
      stats: synth.stats(),
    };
  }
  return cached;
}

/**
 * Register a change listener (notified at ≤10 Hz). Lazily opens the stream +
 * session subscriptions on first subscriber. Returns an unsubscribe fn.
 */
export function subscribe(cb: (s: CandleSnapshot) => void): () => void {
  ensureStarted();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };
}

/** Select the candle timeframe (persists; resets the ring — buckets are incompatible). */
export function setTimeframe(ns: number): void {
  const known = CANDLE_TIMEFRAMES.find((tf) => tf.ns === ns);
  if (!known) return; // junk never corrupts the persisted choice
  const before = synth.timeframeNs;
  synth.setTimeframe(ns);
  if (synth.timeframeNs !== before) persistTf(ns);
  bump();
}

/** Test seam: inject a raw stream message (bypasses the socket). */
export function ingestForTest(msg: StreamMsg): void {
  handle(msg);
}

/** Test seam: force a synchronous listener notification. */
export function flushForTest(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flush();
}

/** Reset all state incl. subscriptions. Mirrors a fresh module load: the timeframe re-reads storage (tests manage localStorage). */
export function resetForTest(): void {
  synth = createCandleSynth(loadStoredTfNs());
  timeMap = null;
  anchorEpoch = null;
  anchorSeq = -1;
  version = 0;
  cached = null;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  listeners.clear();
  if (streamUnsub !== null) {
    streamUnsub();
    streamUnsub = null;
  }
  if (storeUnsub !== null) {
    storeUnsub();
    storeUnsub = null;
  }
  lastSessionKey = null;
  lastSessionId = null;
}
