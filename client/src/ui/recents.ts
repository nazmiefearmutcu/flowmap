/**
 * Recent symbols for the palette (A5). localStorage-backed, capped at 5, most
 * recent first. Pure functions over a `Storage | null` so jsdom tests can pass
 * an in-memory fake (and SSR / private-mode can pass null without throwing).
 *
 * Keys are stored as `market:symbol` strings — the same composite the palette
 * and the store use everywhere else — so a corrupted or foreign payload can only
 * ever degrade to "no recents", never to a malformed row.
 */

export const RECENTS_KEY = 'flowmap.recents';
export const RECENTS_MAX = 5;

/** One recent pick, split back into its wire halves. */
export interface RecentPick {
  market: string;
  symbol: string;
}

/** Load the recents list, most recent first. Never throws; never returns junk. */
export function loadRecents(storage: Storage | null): RecentPick[] {
  if (!storage) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(RECENTS_KEY);
  } catch {
    return []; // private-mode / disabled storage: recents are a nicety, not a need
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // corrupted payload — degrade to empty, never render junk
  }
  if (!Array.isArray(parsed)) return [];
  const out: RecentPick[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const i = item.indexOf(':');
    if (i <= 0 || i === item.length - 1) continue;
    const market = item.slice(0, i);
    const symbol = item.slice(i + 1);
    // First occurrence wins — it IS the most recent.
    if (!out.some((r) => r.market === market && r.symbol === symbol)) {
      out.push({ market, symbol });
    }
    if (out.length >= RECENTS_MAX) break;
  }
  return out;
}

/** Persist the recents list. Best-effort: a failed write is silently dropped. */
export function saveRecents(storage: Storage | null, recents: readonly RecentPick[]): void {
  if (!storage) return;
  try {
    storage.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, RECENTS_MAX).map((r) => `${r.market}:${r.symbol}`)));
  } catch {
    /* quota / disabled storage — recents are best-effort */
  }
}

/**
 * Record a pick: move it to the front (deduped against the existing list) and
 * cap at {@link RECENTS_MAX}. Returns the new list AND persists it.
 */
export function pushRecent(
  storage: Storage | null,
  market: string,
  symbol: string,
  prev?: readonly RecentPick[],
): RecentPick[] {
  const base = prev ?? loadRecents(storage);
  const next: RecentPick[] = [{ market, symbol }];
  for (const r of base) {
    if (r.market === market && r.symbol === symbol) continue;
    next.push(r);
    if (next.length >= RECENTS_MAX) break;
  }
  saveRecents(storage, next);
  return next;
}
