import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  normalizeSettings,
  saveSettings,
  type StorageLike,
} from './settings';

/** In-memory Storage double. */
function memStorage(seed?: Record<string, string>): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe('loadSettings', () => {
  it('returns defaults for null storage or an empty key', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults (never throws) on corrupt JSON', () => {
    const s = memStorage({ [SETTINGS_KEY]: '{not json' });
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
  });

  it('deep-copies overlays so the default object is never mutated', () => {
    const a = loadSettings(null);
    a.overlays.bubbles = false;
    expect(loadSettings(null).overlays.bubbles).toBe(true);
    expect(DEFAULT_SETTINGS.overlays.bubbles).toBe(true);
  });
});

describe('saveSettings → loadSettings round-trip', () => {
  it('persists and reloads the exact settings', () => {
    const s = memStorage();
    const custom = {
      ...DEFAULT_SETTINGS,
      colormap: 'alt' as const,
      normPercentile: 97.5,
      tickGrouping: 4,
      bubbleMinSize: 25,
      follow: false,
      railVisible: false,
      overlays: { ...DEFAULT_SETTINGS.overlays, profile: true, vwap: false },
    };
    saveSettings(custom, s);
    expect(loadSettings(s)).toEqual(custom);
  });

  it('no-op on null storage', () => {
    expect(() => saveSettings(DEFAULT_SETTINGS, null)).not.toThrow();
  });
});

describe('normalizeSettings', () => {
  it('merges a partial object over defaults', () => {
    const n = normalizeSettings({ colormap: 'alt', overlays: { profile: true } });
    expect(n.colormap).toBe('alt');
    expect(n.overlays.profile).toBe(true);
    expect(n.overlays.bubbles).toBe(true); // untouched default
    expect(n.normPercentile).toBe(DEFAULT_SETTINGS.normPercentile);
  });

  it('clamps out-of-range numbers and rounds tick grouping', () => {
    expect(normalizeSettings({ normPercentile: 999 }).normPercentile).toBe(100);
    expect(normalizeSettings({ normPercentile: 10 }).normPercentile).toBe(50);
    expect(normalizeSettings({ tickGrouping: 3.7 }).tickGrouping).toBe(4);
    expect(normalizeSettings({ tickGrouping: 0 }).tickGrouping).toBe(1);
    expect(normalizeSettings({ bubbleMinSize: -5 }).bubbleMinSize).toBe(0);
  });

  it('ignores an invalid colormap and non-boolean toggles', () => {
    const n = normalizeSettings({ colormap: 'rainbow', follow: 'yes', railVisible: 0 });
    expect(n.colormap).toBe('thermal');
    expect(n.follow).toBe(DEFAULT_SETTINGS.follow);
    expect(n.railVisible).toBe(DEFAULT_SETTINGS.railVisible);
  });
});
