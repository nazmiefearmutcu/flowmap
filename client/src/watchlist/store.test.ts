import { beforeEach, describe, expect, it } from 'vitest';

import {
  WATCHLIST_CAP,
  WATCHLIST_KEY,
  addToWatchlist,
  getWatchlist,
  isWatchlisted,
  loadWatchlist,
  normalizeWatchlist,
  removeFromWatchlist,
  resetWatchlistForTest,
  saveWatchlist,
  setWatchlistStorage,
  subscribeWatchlist,
  toggleWatchlist,
  type StorageLike,
} from './store';

/** In-memory Storage double (mirrors alertsStore.test.ts). */
function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

let store: ReturnType<typeof memStorage>;

beforeEach(() => {
  resetWatchlistForTest();
  store = memStorage();
  setWatchlistStorage(store);
});

describe('normalizeWatchlist', () => {
  it('keeps valid keys in order and drops junk (total coercion)', () => {
    expect(
      normalizeWatchlist([
        'sim:A',
        ':broken',
        'broken',
        'sim:',
        '',
        42,
        null,
        { key: 'sim:B' },
        'crypto:BTCUSDT',
      ]),
    ).toEqual(['sim:A', 'crypto:BTCUSDT']);
  });

  it('dedupes exact strings, first occurrence wins', () => {
    expect(normalizeWatchlist(['sim:A', 'sim:B', 'sim:A', 'sim:B'])).toEqual(['sim:A', 'sim:B']);
  });

  it('caps at WATCHLIST_CAP', () => {
    const many = Array.from({ length: WATCHLIST_CAP + 5 }, (_, i) => `sim:S${i}`);
    const out = normalizeWatchlist(many);
    expect(out).toHaveLength(WATCHLIST_CAP);
    expect(out[WATCHLIST_CAP - 1]).toBe(`sim:S${WATCHLIST_CAP - 1}`);
  });

  it('returns [] for every non-array payload', () => {
    expect(normalizeWatchlist(null)).toEqual([]);
    expect(normalizeWatchlist(undefined)).toEqual([]);
    expect(normalizeWatchlist('sim:A')).toEqual([]);
    expect(normalizeWatchlist({ keys: ['sim:A'] })).toEqual([]);
  });
});

describe('loadWatchlist', () => {
  it('round-trips a saved list through the exact contract key', () => {
    saveWatchlist(store, ['sim:A', 'crypto:BTCUSDT']);
    expect(store.map.has(WATCHLIST_KEY)).toBe(true);
    expect(loadWatchlist(store)).toEqual(['sim:A', 'crypto:BTCUSDT']);
  });

  it('degrades to [] on corrupt JSON, foreign shapes and missing storage', () => {
    store.map.set(WATCHLIST_KEY, '{not json');
    expect(loadWatchlist(store)).toEqual([]);
    store.map.set(WATCHLIST_KEY, JSON.stringify({ v: 1, keys: ['sim:A'] }));
    expect(loadWatchlist(store)).toEqual([]);
    expect(loadWatchlist(null)).toEqual([]);
    expect(loadWatchlist(undefined)).toEqual([]);
  });

  it('degrades to [] when the storage getter itself throws', () => {
    const hostile: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => undefined,
    };
    expect(loadWatchlist(hostile)).toEqual([]);
  });

  it('swallows persistence failures on save (best-effort)', () => {
    const hostile: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => saveWatchlist(hostile, ['sim:A'])).not.toThrow();
  });
});

describe('store mutations', () => {
  it('appends in order and dedupes', () => {
    expect(addToWatchlist('sim:A')).toBe(true);
    expect(addToWatchlist('sim:B')).toBe(true);
    expect(addToWatchlist('sim:A')).toBe(false); // already present — no churn
    expect(getWatchlist()).toEqual(['sim:A', 'sim:B']);
    expect(isWatchlisted('sim:A')).toBe(true);
    expect(isWatchlisted('sim:C')).toBe(false);
  });

  it('refuses invalid keys and keys beyond the cap', () => {
    expect(addToWatchlist('nocolon')).toBe(false);
    expect(getWatchlist()).toEqual([]);
    for (let i = 0; i < WATCHLIST_CAP; i += 1) {
      expect(addToWatchlist(`sim:S${i}`)).toBe(true);
    }
    expect(addToWatchlist('sim:OVERFLOW')).toBe(false);
    expect(getWatchlist()).toHaveLength(WATCHLIST_CAP);
    expect(isWatchlisted('sim:OVERFLOW')).toBe(false);
  });

  it('removes without reordering the survivors', () => {
    addToWatchlist('sim:A');
    addToWatchlist('sim:B');
    addToWatchlist('sim:C');
    expect(removeFromWatchlist('sim:B')).toBe(true);
    expect(removeFromWatchlist('sim:B')).toBe(false);
    expect(getWatchlist()).toEqual(['sim:A', 'sim:C']);
  });

  it('toggle returns the NEW membership state', () => {
    expect(toggleWatchlist('sim:A')).toBe(true);
    expect(getWatchlist()).toEqual(['sim:A']);
    expect(toggleWatchlist('sim:A')).toBe(false);
    expect(getWatchlist()).toEqual([]);
  });

  it('notifies subscribers on every real mutation only', () => {
    let calls = 0;
    const unsub = subscribeWatchlist(() => {
      calls += 1;
    });
    addToWatchlist('sim:A'); // notify
    addToWatchlist('sim:A'); // dedupe — no notify
    addToWatchlist('nocolon'); // invalid — no notify
    removeFromWatchlist('sim:MISSING'); // absent — no notify
    removeFromWatchlist('sim:A'); // notify
    expect(calls).toBe(2);
    unsub();
    addToWatchlist('sim:B');
    expect(calls).toBe(2); // unsubscribed
  });

  it('persists every mutation to the exact key and survives a reload', () => {
    addToWatchlist('sim:A');
    addToWatchlist('crypto:BTCUSDT');
    removeFromWatchlist('sim:A');
    // Simulated reload: drop in-memory state, re-point at the same storage.
    resetWatchlistForTest();
    setWatchlistStorage(store);
    expect(getWatchlist()).toEqual(['crypto:BTCUSDT']);
    expect(JSON.parse(store.map.get(WATCHLIST_KEY) ?? 'null')).toEqual(['crypto:BTCUSDT']);
  });

  it('keeps working in-memory when storage is denied', () => {
    setWatchlistStorage(null);
    expect(addToWatchlist('sim:A')).toBe(true);
    expect(getWatchlist()).toEqual(['sim:A']);
  });
});
