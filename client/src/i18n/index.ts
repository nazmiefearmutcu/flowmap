/**
 * FlowMap shell i18n (lane CE, contract C7).
 *
 * Tiny dependency-free lookup: `t('key', vars)` resolves the active locale's
 * table, falls back to the ENGLISH string (a missing TR entry must never
 * render raw key garbage), and falls back to the key itself only when the
 * key is unknown to every table. `{name}` placeholders interpolate from
 * `vars`; unknown placeholders pass through untouched.
 *
 * Locale is persisted in localStorage `flowmap.locale` ('en' | 'tr').
 * `useT()` (useT.ts) is the React binding that re-renders on change.
 *
 * Scope: SHELL strings only — TopBar, SettingsDrawer, banners, shortcuts
 * overlay, onboarding, toaster. Feature panes stay English (C7).
 * Components are migrated onto `t()` incrementally — see MIGRATION.md.
 */

import { en } from './en';
import { tr } from './tr';

export type Locale = 'en' | 'tr';

export const LOCALES: readonly Locale[] = ['en', 'tr'];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'flowmap.locale';

/** Locale name as it should appear in a picker row. */
export function localeLabel(l: Locale): string {
  return l === 'tr' ? 'Türkçe' : 'English';
}

export function isLocale(value: string | null | undefined): value is Locale {
  return value === 'en' || value === 'tr';
}

const TABLES: Record<Locale, Record<string, string>> = { en, tr };

let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

/** Look a key up for a specific locale with EN fallback, then key. */
export function tFor(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const raw = TABLES[locale][key] ?? TABLES.en[key];
  const text = raw ?? key;
  if (vars === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/** Translate into the CURRENT locale (re-read after every setLocale). */
export function t(key: string, vars?: Record<string, string | number>): string {
  return tFor(current, key, vars);
}

export function getLocale(): Locale {
  return current;
}

/** Switch locale, persist, and notify subscribers. */
export function setLocale(locale: Locale): void {
  const next = isLocale(locale) ? locale : DEFAULT_LOCALE;
  if (next !== current) {
    current = next;
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      /* quota / private mode — locale stays session-local */
    }
    notify();
  }
}

/**
 * Boot call: restore the persisted locale. Safe to call repeatedly.
 * (No navigator sniffing — the app defaults to English until the user
 * picks a language; INT may add a picker wired to setLocale.)
 */
export function initLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) {
      current = stored;
      notify();
    }
  } catch {
    /* storage unavailable — keep default */
  }
  return current;
}

/** Subscribe to locale changes; returns an unsubscriber. */
export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
