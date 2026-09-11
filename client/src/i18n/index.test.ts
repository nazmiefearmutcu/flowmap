/**
 * i18n core tests (lane CE, C7): fallback chain (locale → English → key),
 * {var} interpolation, persistence, notification, labels.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { en } from './en';
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_STORAGE_KEY,
  getLocale,
  initLocale,
  isLocale,
  localeLabel,
  setLocale,
  subscribeLocale,
  t,
  tFor,
} from './index';
import { tr } from './tr';

afterEach(() => {
  setLocale('en');
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('tables', () => {
  it('EN is the complete source of truth; TR is a full shell translation', () => {
    expect(Object.keys(en).length).toBeGreaterThan(30);
    for (const key of Object.keys(en)) {
      expect(typeof en[key]).toBe('string');
      expect(en[key].length).toBeGreaterThan(0);
    }
    for (const key of Object.keys(tr)) {
      expect(en[key], `tr key ${key} exists in en`).toBeDefined();
    }
    // Every EN key has a TR entry except the documented brand exception.
    const trOnlyMissing = Object.keys(en).filter((k) => tr[k] === undefined);
    expect(trOnlyMissing).toEqual(['app.title']);
  });
});

describe('t / tFor', () => {
  it('resolves English by default', () => {
    expect(t('drawer.title')).toBe('Settings');
  });

  it('resolves the active locale', () => {
    setLocale('tr');
    expect(t('drawer.title')).toBe('Ayarlar');
    expect(t('topbar.searchPlaceholder')).toBe('Sembol ara');
  });

  it('falls back to the English string when a locale lacks the key', () => {
    expect(tFor('tr', 'app.title')).toBe(en['app.title']);
  });

  it('falls back to the key itself when no table knows it', () => {
    expect(tFor('en', 'totally.unknown.key')).toBe('totally.unknown.key');
    expect(tFor('tr', 'totally.unknown.key')).toBe('totally.unknown.key');
    expect(t('another.missing.key')).toBe('another.missing.key');
  });

  it('interpolates {vars} and leaves unknown placeholders untouched', () => {
    expect(tFor('en', 'onboarding.stepOf', { current: 2, total: 3 })).toBe('Step 2 of 3');
    expect(tFor('tr', 'banner.opensIn', { time: '01:02:03' })).toBe('01:02:03 sonra açılır');
    expect(tFor('en', 'onboarding.stepOf')).toBe('Step {current} of {total}');
    expect(tFor('en', 'onboarding.stepOf', { nope: 1 })).toBe('Step {current} of {total}');
  });
});

describe('locale state', () => {
  it('setLocale persists to flowmap.locale', () => {
    setLocale('tr');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('tr');
    expect(getLocale()).toBe('tr');
  });

  it('setLocale ignores unknown locales', () => {
    setLocale('fr' as 'en');
    expect(getLocale()).toBe('en');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
  });

  it('notifies subscribers on change only', () => {
    const spy = vi.fn();
    const off = subscribeLocale(spy);
    setLocale('tr');
    setLocale('tr');
    off();
    setLocale('en');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('initLocale restores the persisted locale and tolerates garbage/absence', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'tr');
    expect(initLocale()).toBe('tr');
    localStorage.setItem(LOCALE_STORAGE_KEY, 'klingon');
    expect(initLocale()).toBe('tr'); // stays on current; garbage not applied
    localStorage.removeItem(LOCALE_STORAGE_KEY);
    setLocale('en');
    expect(initLocale()).toBe('en');
  });

  it('survives blocked localStorage', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    setLocale('tr');
    expect(getLocale()).toBe('tr'); // session-local switch still worked
    spy.mockRestore();
  });
});

describe('locale metadata', () => {
  it('ships exactly en + tr with human labels', () => {
    expect(LOCALES).toEqual(['en', 'tr']);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(localeLabel('en')).toBe('English');
    expect(localeLabel('tr')).toBe('Türkçe');
    expect(isLocale('tr')).toBe(true);
    expect(isLocale('de')).toBe(false);
  });
});

describe('lane D shell keys (campaign 4)', () => {
  /**
   * Every key introduced by the i18n + themes + settings-drawer lane. Pinned
   * here so a component can never reference a string the tables do not own
   * (the tables' own completeness test separately guarantees EN→TR coverage).
   */
  const LANE_D_KEYS = [
    // TopBar visible text
    'topbar.png',
    'topbar.rail',
    'topbar.settingsLabel',
    'topbar.replayUnavailable',
    'topbar.replayUnavailableHint',
    // ReconnectBanner framing
    'banner.lostReconnecting',
    'banner.theFeed',
    'banner.attempt',
    'banner.retryNow',
    'banner.retryNowHint',
    // SettingsDrawer sections
    'drawer.sectionAppearance',
    'drawer.sectionDisplay',
    'drawer.sectionTrades',
    'drawer.sectionView',
    'drawer.sectionAlerts',
    'drawer.sectionKeyboard',
    // SettingsDrawer toggles / labels / hints
    'settings.colormapHint',
    'settings.contrastHint',
    'settings.toleranceHint',
    'settings.normalizationHint',
    'settings.rowsPerCell',
    'settings.rowsPerCellOne',
    'settings.bubble',
    'settings.allTrades',
    'settings.off',
    'settings.bigTradeLabel',
    'settings.bigTradeHint',
    'settings.depthChannel',
    'settings.channel.sum',
    'settings.channel.bid',
    'settings.channel.ask',
    'settings.channel.imbalance',
    'settings.channelHint.sum',
    'settings.channelHint.bid',
    'settings.channelHint.ask',
    'settings.channelHint.imbalance',
    'settings.hud',
    'settings.drawToolbar',
    'settings.indicatorPicker',
    'settings.showOnboarding',
    'settings.followLive',
    'settings.followPrice',
    'settings.rightRail',
    'settings.band.native',
    'settings.band.wide',
    'settings.band.full',
    'settings.band.deep',
    'settings.bandHint.native',
    'settings.bandHint.wide',
    'settings.bandHint.full',
    'settings.bandHint.deep',
    'settings.history.off',
    'settings.history.1h',
    'settings.history.4h',
    'settings.history.1d',
    'settings.history.max',
    'settings.historyHint',
    'settings.restoreDefaults',
    'settings.alertSound',
    'settings.alertSoundHint',
    // keysheet actions
    'keysheet.space',
    'keysheet.slash',
    'keysheet.export',
    'keysheet.measure',
    'keysheet.alert',
    'keysheet.hud',
    'keysheet.channel',
    'keysheet.theme',
    'keysheet.draw',
    'keysheet.indicator',
    'keysheet.delete',
    'keysheet.undo',
    'keysheet.help',
    'keysheet.pan',
    'keysheet.zoom',
    'keysheet.follow',
    'keysheet.priceTrack',
    'keysheet.liveEdge',
    'keysheet.escape',
    'keysheet.axis',
    // shortcuts overlay footer
    'shortcuts.footerToggle',
    'shortcuts.footerClose',
  ] as const;

  it('every lane-D key resolves in BOTH tables (never raw-key garbage)', () => {
    for (const key of LANE_D_KEYS) {
      expect(en[key], `en owns ${key}`).toBeDefined();
      expect(tr[key], `tr owns ${key}`).toBeDefined();
      expect(tFor('en', key)).not.toBe(key);
      expect(tFor('tr', key)).not.toBe(key);
    }
  });
});
