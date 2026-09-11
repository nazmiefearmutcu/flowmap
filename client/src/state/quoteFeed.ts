/**
 * Shared polling feed for display-only `/api/quote` snapshots (campaign-4
 * contract P2, lane C1; consumed by C2's watchlist and C1's alert monitor).
 *
 * The server exposes `GET /api/quote?market=..&symbol=..` returning
 * `{price, changePct, spark, stale, reachable}` behind a 15 s TTL cache with
 * per-key single-flight (api/market_cache.py). This module is the client half:
 *
 *   - `subscribeQuotes(keys, cb, opts?) => unsubscribe` with `market:symbol`
 *     keys (the same key format the alerts store persists).
 *   - 10 s default cadence, visibility-gated: while `document.hidden` or the
 *     page is otherwise hidden polling PAUSES, and on visible it resumes with an
 *     immediate refresh (never a stale slot until the next tick).
 *   - SINGLE in-flight fetch per key across all subscribers; one response fans
 *     out to every subscriber of that key, so two panels polling the same
 *     symbol cost one request per cycle.
 *   - Duplicate keys in one call collapse; malformed keys are skipped.
 *   - AbortController per fetch; unsubscribing the LAST subscriber for a key
 *     aborts its in-flight request.
 *   - Honest passthrough: the `Quote` handed to the callback is the server's
 *     response, unmodified. A failed/unreachable HTTP request produces NO
 *     callback (never a fabricated quote); the next cycle retries.
 *
 * React-free by design (the alertsStore/bookStore pattern) so it is unit
 * testable with fake timers and an injected visibility source.
 */

import { apiBase } from '../net/serverBase';

/** The `/api/quote` response subset consumers see (camelCase, server-verbatim). */
export interface Quote {
  market: string;
  symbol: string;
  price: number | null;
  changePct: number | null;
  spark: number[];
  /** Wall-clock UTC ns of the freshest datum (optional for hand-rolled doubles). */
  asOf?: number;
  /** True for market-closed / last-good-on-error data. */
  stale?: boolean;
  /** False when the provider could not be reached at all. */
  reachable?: boolean;
}

/** Injectable page-visibility source; the default reads `document`. */
export interface VisibilitySource {
  isHidden(): boolean;
  /** Register a change listener; returns the deregister fn. */
  onChange(cb: () => void): () => void;
}

export interface QuoteFeedOptions {
  /** Poll cadence in ms (default {@link DEFAULT_QUOTE_INTERVAL_MS}). */
  intervalMs?: number;
  /** Test seam: visibility source (default: `document.hidden`). */
  visibility?: VisibilitySource;
  /** Test seam: fetch implementation (default: the global `fetch`). */
  fetchImpl?: typeof fetch;
}

/** Default poll cadence — comfortably inside the server's 15 s quote TTL. */
export const DEFAULT_QUOTE_INTERVAL_MS = 10_000;

interface ParsedKey {
  market: string;
  symbol: string;
}

interface Group {
  keys: Map<string, ParsedKey>;
  cb: (key: string, quote: Quote) => void;
  intervalMs: number;
  vis: VisibilitySource;
  fetchImpl: typeof fetch;
  timer: ReturnType<typeof setInterval> | null;
  visOff: () => void;
}

const groups = new Set<Group>();
/** Per-key subscriber count (across groups), for abort-on-last-unsubscribe. */
const keyRefs = new Map<string, number>();
/** At most one in-flight request per key at any moment. */
const inflight = new Map<string, AbortController>();

function documentVisibility(): VisibilitySource {
  return {
    isHidden: () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden',
    onChange: (cb) => {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    },
  };
}

function boundFetch(): typeof fetch {
  return (input, init) => globalThis.fetch(input, init);
}

/** Parse a `market:symbol` key; null for malformed keys (skipped honestly). */
function parseKey(key: string): ParsedKey | null {
  const i = key.indexOf(':');
  if (i <= 0 || i >= key.length - 1) return null;
  return { market: key.slice(0, i), symbol: key.slice(i + 1) };
}

function stopTimer(g: Group): void {
  if (g.timer === null) return;
  clearInterval(g.timer);
  g.timer = null;
}

function startTimer(g: Group): void {
  if (g.timer !== null || g.vis.isHidden()) return;
  g.timer = setInterval(() => pollGroup(g), g.intervalMs);
}

/** One poll cycle for a group: start one request per key (single-flight). */
function pollGroup(g: Group): void {
  if (g.vis.isHidden()) return;
  for (const [key, parsed] of g.keys) {
    if (inflight.has(key)) continue; // a shared request is already on the wire
    const ctrl = new AbortController();
    inflight.set(key, ctrl);
    void fetchQuote(g, key, parsed, ctrl);
  }
}

async function fetchQuote(
  g: Group,
  key: string,
  parsed: ParsedKey,
  ctrl: AbortController,
): Promise<void> {
  try {
    const path = `/api/quote?market=${encodeURIComponent(parsed.market)}&symbol=${encodeURIComponent(parsed.symbol)}`;
    const r = await g.fetchImpl(`${apiBase()}${path}`, { signal: ctrl.signal });
    if (!r.ok) return; // failed request → honest silence; the next cycle retries
    const quote = (await r.json()) as Quote;
    if (ctrl.signal.aborted) return;
    // Fan the ONE response out to every subscriber of this key. Hidden groups
    // are paused and do not receive callbacks.
    for (const other of groups) {
      if (!other.keys.has(key) || other.vis.isHidden()) continue;
      try {
        other.cb(key, quote);
      } catch {
        /* one misbehaving consumer must not break the others */
      }
    }
  } catch {
    // AbortError or network failure — no callback; the next tick retries.
  } finally {
    if (inflight.get(key) === ctrl) inflight.delete(key);
  }
}

/**
 * Subscribe to live quotes for `keys` (`market:symbol` strings). `cb` is called
 * with the key and the server's verbatim quote, once per successful fetch —
 * immediately on subscribe while visible, then at the cadence. Returns the
 * unsubscribe fn (clears timers, deregisters visibility, aborts the key's
 * in-flight request when this was the last subscriber).
 */
export function subscribeQuotes(
  keys: readonly string[],
  cb: (key: string, quote: Quote) => void,
  opts: QuoteFeedOptions = {},
): () => void {
  const parsed = new Map<string, ParsedKey>();
  for (const key of keys) {
    if (parsed.has(key)) continue; // dedupe duplicate keys in one call
    const p = parseKey(key);
    if (p !== null) parsed.set(key, p);
  }
  const requested = opts.intervalMs;
  const intervalMs =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? requested
      : DEFAULT_QUOTE_INTERVAL_MS;
  const group: Group = {
    keys: parsed,
    cb,
    intervalMs,
    vis: opts.visibility ?? documentVisibility(),
    fetchImpl: opts.fetchImpl ?? boundFetch(),
    timer: null,
    visOff: () => {},
  };
  groups.add(group);
  for (const key of group.keys.keys()) keyRefs.set(key, (keyRefs.get(key) ?? 0) + 1);
  group.visOff = group.vis.onChange(() => {
    if (group.vis.isHidden()) {
      stopTimer(group);
    } else {
      startTimer(group);
      pollGroup(group); // immediate refresh on becoming visible
    }
  });
  // Immediate first refresh while visible (no 10 s blank row on mount).
  if (!group.vis.isHidden()) {
    startTimer(group);
    pollGroup(group);
  }

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    groups.delete(group);
    stopTimer(group);
    group.visOff();
    for (const key of group.keys.keys()) {
      const refs = (keyRefs.get(key) ?? 1) - 1;
      if (refs > 0) {
        keyRefs.set(key, refs);
        continue;
      }
      keyRefs.delete(key);
      inflight.get(key)?.abort();
      inflight.delete(key);
    }
  };
}

/** Test seam: unregister every group, timer, and in-flight request. */
export function resetQuoteFeedForTest(): void {
  for (const g of groups) {
    stopTimer(g);
    g.visOff();
  }
  groups.clear();
  keyRefs.clear();
  for (const ctrl of inflight.values()) ctrl.abort();
  inflight.clear();
}
