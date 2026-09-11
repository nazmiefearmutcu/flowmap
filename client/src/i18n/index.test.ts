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
