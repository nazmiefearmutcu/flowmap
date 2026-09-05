/**
 * Recent symbols (A5) — pure localStorage-backed recents for the palette.
 * The contract worth pinning: MRU order, dedupe, the 5 cap, and the honesty
 * failure mode — a corrupted or foreign payload degrades to "no recents",
 * never to junk rows.
 */

import { describe, expect, it } from 'vitest';

import { loadRecents, pushRecent, RECENTS_MAX, saveRecents, type RecentPick } from './recents';

/** In-memory Storage stand-in (jsdom's localStorage is real but shared). */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getLength: () => map.size,
    length: map.size,
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as unknown as Storage;
}

describe('recents', () => {
  it('loads persisted picks in MRU-first order and splits market:symbol', () => {
    const store = fakeStorage({
      'flowmap.recents': JSON.stringify(['binance-spot:BTCUSDT', 'kraken:XBT/USD']),
    });
    expect(loadRecents(store)).toEqual<RecentPick[]>([
      { market: 'binance-spot', symbol: 'BTCUSDT' },
      { market: 'kraken', symbol: 'XBT/USD' },
    ]);
  });

  it('pushRecent moves a repeat pick to the front, dedupes, and caps at 5', () => {
    const store = fakeStorage();
    let list = pushRecent(store, 'sim', 'A');
    list = pushRecent(store, 'sim', 'B', list);
    list = pushRecent(store, 'sim', 'C', list);
    list = pushRecent(store, 'sim', 'D', list);
    list = pushRecent(store, 'sim', 'E', list);
    // Re-picking the OLDEST entry must promote it, not duplicate it.
    list = pushRecent(store, 'sim', 'A', list);
    expect(list.map((r) => r.symbol)).toEqual(['A', 'E', 'D', 'C', 'B']);
    expect(list.length).toBe(RECENTS_MAX);
    // And the pick more than one cap later pushes the tail off entirely.
    list = pushRecent(store, 'sim', 'F', list);
    expect(list.map((r) => r.symbol)).toEqual(['F', 'A', 'E', 'D', 'C']);
    expect(JSON.parse(store.getItem('flowmap.recents')!)).toHaveLength(5);
  });

  it('degrades corrupted / non-array / malformed payloads to NO recents', () => {
    expect(loadRecents(fakeStorage({ 'flowmap.recents': '{not json' })).length).toBe(0);
    expect(loadRecents(fakeStorage({ 'flowmap.recents': '{"a":1}' })).length).toBe(0);
    expect(loadRecents(fakeStorage({ 'flowmap.recents': JSON.stringify([42, null]) })).length).toBe(0);
    // `symbol` with no market half (leading ':') is not a pick.
    expect(loadRecents(fakeStorage({ 'flowmap.recents': JSON.stringify([':BTCUSDT']) })).length).toBe(0);
    expect(loadRecents(null)).toEqual([]);
  });

  it('saveRecents persists the same MRU shape loadRecents reads back', () => {
    const store = fakeStorage();
    saveRecents(store, [
      { market: 'equity', symbol: 'AAPL' },
      { market: 'sim', symbol: 'SIM-DEMO' },
    ]);
    expect(loadRecents(store)).toEqual<RecentPick[]>([
      { market: 'equity', symbol: 'AAPL' },
      { market: 'sim', symbol: 'SIM-DEMO' },
    ]);
  });
});
