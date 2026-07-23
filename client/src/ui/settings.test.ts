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
      colormap: 'classic' as const,
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
    const n = normalizeSettings({ colormap: 'classic', overlays: { profile: true } });
    expect(n.colormap).toBe('classic');
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
    expect(n.colormap).toBe(DEFAULT_SETTINGS.colormap);
    expect(n.follow).toBe(DEFAULT_SETTINGS.follow);
    expect(n.railVisible).toBe(DEFAULT_SETTINGS.railVisible);
  });

  it('migrates the legacy colormap values to the new default ON PURPOSE', () => {
    // 'thermal' / 'alt' were persisted on every mount but never applied to the
    // renderer, so a stored value carries no user intent. Honouring it would mean
    // returning users silently never see the new default ramp.
    expect(normalizeSettings({ colormap: 'thermal' }).colormap).toBe(DEFAULT_SETTINGS.colormap);
    expect(normalizeSettings({ colormap: 'alt' }).colormap).toBe(DEFAULT_SETTINGS.colormap);
    expect(DEFAULT_SETTINGS.colormap).toBe('inferno');
  });

  it('coerces the new tolerance / followPrice / priceBand fields', () => {
    expect(normalizeSettings({ tolerance: 42.6 }).tolerance).toBe(43);
    expect(normalizeSettings({ tolerance: -10 }).tolerance).toBe(0);
    expect(normalizeSettings({ tolerance: 900 }).tolerance).toBe(100);
    expect(normalizeSettings({ tolerance: 'lots' }).tolerance).toBe(DEFAULT_SETTINGS.tolerance);
    expect(normalizeSettings({ followPrice: false }).followPrice).toBe(false);
    expect(normalizeSettings({ followPrice: 'yes' }).followPrice).toBe(
      DEFAULT_SETTINGS.followPrice,
    );
    for (const b of ['native', 'wide', 'full'] as const) {
      expect(normalizeSettings({ priceBand: b }).priceBand).toBe(b);
    }
    expect(normalizeSettings({ priceBand: 'galaxy' }).priceBand).toBe('native');
  });

  it('round-trips a pre-upgrade v1 payload without disturbing unrelated fields', () => {
    // Everything a user could have stored before this release, with none of the
    // new keys. Each new field must adopt its default; nothing else may move.
    const legacy = {
      contrast: 61,
      colormap: 'thermal',
      normPercentile: 97.5,
      tickGrouping: 4,
      bubbleMinSize: 25,
      follow: false,
      railVisible: false,
      overlays: { bubbles: false, bbo: true, vwap: false, profile: true, markers: true, axes: true },
    };
    const n = normalizeSettings(legacy);
    expect(n.contrast).toBe(61);
    expect(n.normPercentile).toBe(97.5);
    expect(n.tickGrouping).toBe(4);
    expect(n.bubbleMinSize).toBe(25);
    expect(n.follow).toBe(false);
    expect(n.railVisible).toBe(false);
    expect(n.overlays).toEqual(legacy.overlays);
    // New fields adopt defaults (colormap deliberately does NOT keep 'thermal').
    expect(n.tolerance).toBe(DEFAULT_SETTINGS.tolerance);
    expect(n.followPrice).toBe(DEFAULT_SETTINGS.followPrice);
    expect(n.priceBand).toBe(DEFAULT_SETTINGS.priceBand);
    expect(n.colormap).toBe(DEFAULT_SETTINGS.colormap);
  });
});
