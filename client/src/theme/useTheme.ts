/**
 * Theme application + persistence (lane CE) — the ONE theme store (fix
 * 2026-09-10 F1-4: single source of truth; there is no second hook state).
 *
 * - Module state `current` resolves LAZILY: stored value (localStorage
 *   `flowmap.theme`) → first-run `prefers-color-scheme` (light → `paper`) →
 *   `midnight`. Every reader ({@link getTheme}, {@link cycleTheme},
 *   {@link useTheme}) goes through the same resolved value, so the store can
 *   never disagree with itself — even when a consumer touches the theme before
 *   `initTheme()` ran (tests, reordered boot): there is no "default until
 *   init" phase anymore.
 * - `setTheme(id)` is the single WRITER: it stamps
 *   `document.documentElement.dataset.theme` (themes.css keys off
 *   `:root[data-theme='<id>']`), persists to localStorage, and notifies
 *   subscribers.
 * - `initTheme()` is the one-time boot call for main.tsx: it resolves the
 *   store, stamps the DOM, and — first run only — PERSISTS the
 *   prefers-color-scheme seed, so the OS changing its mind later never
 *   silently flips the app.
 * - `cycleTheme()` advances through {@link THEME_IDS} reading the store; the
 *   `T` shortcut is wired by {@link attachThemeKey} (INT mounts it in
 *   App.tsx — see MOUNT-SNIPPET-CE).
 * - `useTheme()` subscribes via `useSyncExternalStore` and returns the LIVE
 *   value (initial = the resolved current, never a blind default), zero deps.
 */

import { useSyncExternalStore } from 'react';

import { classifyTarget } from '../input/keys';
import {
  DEFAULT_THEME_ID,
  isThemeId,
  nextTheme,
  resolveCanvasPalette,
  type CanvasPalette,
  type ThemeId,
} from './registry';

export const THEME_STORAGE_KEY = 'flowmap.theme';

/** The resolved store value; `null` only before the first read (lazy init). */
let current: ThemeId | null = null;
let initialized = false;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

function persist(id: ThemeId): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    /* quota / private mode — theme stays session-local */
  }
}

function loadStored(): ThemeId | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** First-run seed from the OS preference: light → paper, else/default → midnight. */
function prefersSeed(): ThemeId {
  try {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'paper';
    }
  } catch {
    /* matchMedia unavailable — default dark */
  }
  return DEFAULT_THEME_ID;
}

/**
 * Resolve the store ONCE (stored → prefers → default) and return the live
 * value. Reads are side-effect-free (useSyncExternalStore requires a pure
 * getSnapshot): DOM stamping/persistence happens in setTheme/initTheme only.
 */
function ensureCurrent(): ThemeId {
  if (current === null) current = loadStored() ?? prefersSeed();
  return current;
}

/** Apply + persist. Unknown ids fall back to the default. THE single writer. */
export function setTheme(id: ThemeId): void {
  const next = isThemeId(id) ? id : DEFAULT_THEME_ID;
  const prev = ensureCurrent();
  if (next === prev && document.documentElement.dataset.theme === next) {
    persist(next);
    return;
  }
  current = next;
  document.documentElement.dataset.theme = next;
  persist(next);
  notify();
}

/** Advance to the next theme in registry order (wraps). Returns the new id. */
export function cycleTheme(): ThemeId {
  const next = nextTheme(ensureCurrent());
  setTheme(next);
  return next;
}

/** Current theme id — resolved stored → prefers → default, even pre-init. */
export function getTheme(): ThemeId {
  return ensureCurrent();
}

/**
 * One-time boot: resolve the store, stamp the DOM, and — when nothing was
 * stored (first run) — persist the `prefers-color-scheme` seed so the OS
 * setting is honored only on first run. Safe to call repeatedly; later calls
 * are no-ops unless you pass `{ force: true }` (tests), which re-resolves.
 */
export function initTheme(opts: { force?: boolean } = {}): ThemeId {
  if (initialized && !opts.force) return ensureCurrent();
  initialized = true;
  if (opts.force) current = null; // re-resolve from storage / OS preference
  const value = ensureCurrent();
  if (!loadStored()) persist(value); // first run: freeze the prefers seed
  document.documentElement.dataset.theme = value;
  notify();
  return value;
}

/** Subscribe to theme changes; returns an unsubscriber. */
export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * TEST SEAM: drop the resolved store back to "unresolved" so a test can prove
 * the lazy stored → prefers → default resolution from scratch. Does NOT touch
 * localStorage or the DOM attribute (clear those yourself to simulate a truly
 * fresh environment).
 */
export function resetThemeStoreForTest(): void {
  current = null;
  initialized = false;
}

/**
 * Canvas palette for overlay layers, read from the LIVE computed CSS
 * variables of `documentElement` — canvas always matches the applied theme
 * with zero hardcoded literals. Fields missing from the computed style fall
 * back to the registry literals (jsdom / pre-stylesheet boot).
 */
export function getCanvasPalette(id: ThemeId = ensureCurrent()): CanvasPalette {
  const el = document.documentElement;
  let style: CSSStyleDeclaration | null = null;
  try {
    style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null;
  } catch {
    style = null;
  }
  return resolveCanvasPalette(id, (name) => (style ? style.getPropertyValue(name) : ''));
}

/**
 * `T` → cycle theme. Skips text-entry surfaces and open dialogs (same
 * classification as the app's other global keys, via input/keys). Bare `t`
 * only — chords stay with the browser. Returns a disposer.
 */
export function attachThemeKey(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== 't' && e.key !== 'T') return;
    const ctx = classifyTarget(e.target);
    if (ctx.editable || ctx.dialog) return;
    e.preventDefault();
    cycleTheme();
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}

export interface UseThemeResult {
  theme: ThemeId;
  setTheme: typeof setTheme;
  cycleTheme: typeof cycleTheme;
}

/** React binding: re-renders on theme change. */
export function useTheme(): UseThemeResult {
  const theme = useSyncExternalStore(subscribeTheme, getTheme);
  return { theme, setTheme, cycleTheme };
}
