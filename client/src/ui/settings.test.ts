import { describe, expect, it } from 'vitest';

import { DEFAULT_PERCENTILE } from '../gl/normalize';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  historyDepthCols,
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
  it('pins the default normalization percentile to the normalizer default (p97)', () => {
    // p99 was the first-run "empty heatmap" culprit (heavy tail → the median
    // cell sits below the default black point). The persisted default must stay
    // in lockstep with the normalizer's DEFAULT_PERCENTILE.
    expect(DEFAULT_PERCENTILE).toBe(97);
    expect(DEFAULT_SETTINGS.normPercentile).toBe(DEFAULT_PERCENTILE);
  });

  it('merges a partial object over defaults', () => {
    const n = normalizeSettings({ settingsVersion: 2, colormap: 'classic', overlays: { profile: true } });
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

  it('coerces the big-trade USD threshold (default off; 0..1e9; junk → default)', () => {
    expect(DEFAULT_SETTINGS.bigTradeUsd).toBe(0);
    expect(normalizeSettings({}).bigTradeUsd).toBe(0); // pre-upgrade payload adopts the default
    expect(normalizeSettings({ bigTradeUsd: 25_000 }).bigTradeUsd).toBe(25_000);
    expect(normalizeSettings({ bigTradeUsd: -1 }).bigTradeUsd).toBe(0);
    expect(normalizeSettings({ bigTradeUsd: 5e9 }).bigTradeUsd).toBe(1e9);
    expect(normalizeSettings({ bigTradeUsd: 'lots' }).bigTradeUsd).toBe(0);
    expect(normalizeSettings({ bigTradeUsd: Number.NaN }).bigTradeUsd).toBe(0);
  });

  it('ignores an invalid colormap and non-boolean toggles', () => {
    const n = normalizeSettings({ settingsVersion: 2, colormap: 'rainbow', follow: 'yes', railVisible: 0 });
    expect(n.colormap).toBe(DEFAULT_SETTINGS.colormap);
    expect(n.follow).toBe(DEFAULT_SETTINGS.follow);
    expect(n.railVisible).toBe(DEFAULT_SETTINGS.railVisible);
  });

  it('one-time migration: an unversioned blob is forced onto the theme colormap', () => {
    // Pre-chart-harmony payloads never saw a theme-aware chart, so their stored
    // family choice (even a valid one) is overridden ONCE — a valid explicit
    // choice made afterwards carries settingsVersion 2 and persists (below).
    const n = normalizeSettings({ colormap: 'inferno' });
    expect(n.colormap).toBe('theme');
    expect(n.settingsVersion).toBe(2);
  });

  it('a version-2 blob honors an explicit legacy family choice', () => {
    expect(normalizeSettings({ settingsVersion: 2, colormap: 'inferno' }).colormap).toBe('inferno');
    expect(normalizeSettings({ settingsVersion: 2, colormap: 'flow' }).colormap).toBe('flow');
    expect(normalizeSettings({ settingsVersion: 2, colormap: 'classic' }).colormap).toBe('classic');
    expect(normalizeSettings({ settingsVersion: 2, colormap: 'theme' }).colormap).toBe('theme');
  });

  it('a version-2 blob with a junk colormap falls back to the default', () => {
    expect(normalizeSettings({ settingsVersion: 2, colormap: 'rainbow' }).colormap).toBe(
      DEFAULT_SETTINGS.colormap,
    );
    expect(DEFAULT_SETTINGS.colormap).toBe('theme');
  });

  it('migrates the legacy thermal/alt values to the theme default ON PURPOSE', () => {
    // 'thermal' / 'alt' were persisted on every mount but never applied to the
    // renderer, so a stored value carries no user intent. The v1→v2 migration
    // also overrides them, so returning users land on the theme-following chart.
    expect(normalizeSettings({ colormap: 'thermal' }).colormap).toBe('theme');
    expect(normalizeSettings({ colormap: 'alt' }).colormap).toBe('theme');
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
    for (const b of ['native', 'wide', 'full', 'deep'] as const) {
      expect(normalizeSettings({ priceBand: b }).priceBand).toBe(b);
    }
    expect(normalizeSettings({ priceBand: 'galaxy' }).priceBand).toBe(DEFAULT_SETTINGS.priceBand);
  });

  it('coerces the history-depth field', () => {
    for (const d of ['off', '1h', '4h', '1d', 'max'] as const) {
      expect(normalizeSettings({ historyDepth: d }).historyDepth).toBe(d);
    }
    expect(normalizeSettings({ historyDepth: 'forever' }).historyDepth).toBe(DEFAULT_SETTINGS.historyDepth);
    expect(normalizeSettings({}).historyDepth).toBe(DEFAULT_SETTINGS.historyDepth);
  });

  it('coerces the depth-channel field (C2: sum default, junk → default)', () => {
    expect(DEFAULT_SETTINGS.depthChannel).toBe('sum'); // the bit-identical default
    expect(normalizeSettings({}).depthChannel).toBe('sum'); // pre-C2 payload adopts it
    for (const c of ['sum', 'bid', 'ask', 'imbalance'] as const) {
      expect(normalizeSettings({ depthChannel: c }).depthChannel).toBe(c);
    }
    expect(normalizeSettings({ depthChannel: 'theta' }).depthChannel).toBe('sum');
  });

  it('coerces the hud-visible field (H chip, default off)', () => {
    expect(DEFAULT_SETTINGS.hudVisible).toBe(false);
    expect(normalizeSettings({}).hudVisible).toBe(false);
    expect(normalizeSettings({ hudVisible: true }).hudVisible).toBe(true);
    expect(normalizeSettings({ hudVisible: 'yes' }).hudVisible).toBe(false);
  });

  it('maps history depth to a column target from the epoch cadence', () => {
    expect(historyDepthCols('off', 250e6)).toBe(0);
    expect(historyDepthCols('max', 250e6)).toBeGreaterThan(100000);
    // 1h at 250ms/col = 3600s / 0.25s = 14400 columns
    expect(historyDepthCols('1h', 250e6)).toBe(14400);
    // longer window ⇒ more columns; coarser dt ⇒ fewer
    expect(historyDepthCols('1d', 250e6)).toBeGreaterThan(historyDepthCols('4h', 250e6));
    expect(historyDepthCols('1h', 1e9)).toBeLessThan(historyDepthCols('1h', 250e6));
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
    // Legacy overlay keys are preserved verbatim; overlay keys added in this
    // release (price, cvd) adopt their defaults — the generic key-iteration in
    // normalizeSettings is exactly what makes new overlays migration-free.
    expect(n.overlays).toEqual({
      ...legacy.overlays,
      price: DEFAULT_SETTINGS.overlays.price,
      cvd: DEFAULT_SETTINGS.overlays.cvd,
    });
    // New fields adopt defaults (colormap deliberately does NOT keep 'thermal':
    // the v1→v2 chart-harmony migration forces 'theme').
    expect(n.tolerance).toBe(DEFAULT_SETTINGS.tolerance);
    expect(n.followPrice).toBe(DEFAULT_SETTINGS.followPrice);
    expect(n.priceBand).toBe(DEFAULT_SETTINGS.priceBand);
    expect(n.colormap).toBe(DEFAULT_SETTINGS.colormap);
    expect(n.settingsVersion).toBe(2);
  });
});
