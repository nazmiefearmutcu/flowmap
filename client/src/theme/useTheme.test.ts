/**
 * Theme application tests (lane CE): persistence, data-theme stamping,
 * first-run prefers-color-scheme, cycle, canvas palette, `T` key wiring.
 */

import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_THEME_ID, THEME_IDS, type ThemeId } from './registry';
import {
  THEME_STORAGE_KEY,
  attachThemeKey,
  cycleTheme,
  getCanvasPalette,
  getTheme,
  initTheme,
  resetThemeStoreForTest,
  setTheme,
  subscribeTheme,
  useTheme,
} from './useTheme';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete (window as { matchMedia?: unknown }).matchMedia;
  resetThemeStoreForTest();
  vi.restoreAllMocks();
});

describe('setTheme / getTheme', () => {
  it('stamps data-theme and persists', () => {
    setTheme('paper');
    expect(document.documentElement.dataset.theme).toBe('paper');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('paper');
    expect(getTheme()).toBe('paper');
  });

  it('falls back to the default for unknown ids', () => {
    setTheme('bogus' as ThemeId);
    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
  });

  it('notifies subscribers on change', () => {
    const seen: ThemeId[] = [];
    const off = subscribeTheme(() => seen.push(getTheme()));
    setTheme('swiss');
    off();
    setTheme('amber'); // unsubscribed — not recorded
    expect(seen).toEqual(['swiss']);
  });
});

describe('cycleTheme', () => {
  it('walks registry order and wraps', () => {
    setTheme(DEFAULT_THEME_ID);
    const walked: ThemeId[] = [];
    for (let i = 0; i < THEME_IDS.length; i++) walked.push(cycleTheme());
    expect(walked).toEqual([...THEME_IDS.slice(1), THEME_IDS[0]]);
  });
});

describe('initTheme', () => {
  it('stored preference wins', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'amber');
    initTheme({ force: true });
    expect(getTheme()).toBe('amber');
    expect(document.documentElement.dataset.theme).toBe('amber');
  });

  it('first run honors prefers-color-scheme: light AND persists the seed', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    const seeded = initTheme({ force: true });
    expect(seeded).toBe('paper');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('paper');
  });

  it('first run defaults to midnight when the OS prefers dark / matchMedia is missing', () => {
    const seeded = initTheme({ force: true });
    expect(seeded).toBe('midnight');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('midnight');
  });

  it('invalid stored values fall back to first-run seeding', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'hunter2');
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
    expect(initTheme({ force: true })).toBe('midnight');
  });
});

describe('getCanvasPalette', () => {
  it('reads live computed CSS variables with the documented field mapping', () => {
    const vars = new Map([
      ['--bg', '#010203'],
      ['--line', '#0a0b0c'],
      ['--text', '#dd0001'],
      ['--accent', '#00aa02'],
      ['--sell', '#cc0003'],
      ['--accent-bright', '#11bb04'],
    ]);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () =>
        ({
          getPropertyValue: (name: string) => vars.get(name) ?? '',
        }) as unknown as CSSStyleDeclaration,
    );
    expect(getCanvasPalette('midnight')).toEqual({
      bg: '#010203',
      grid: '#0a0b0c',
      text: '#dd0001',
      bid: '#00aa02',
      ask: '#cc0003',
      accent: '#11bb04',
    });
  });

  it('falls back to registry literals when computed styles are unavailable', () => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () => ({ getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration,
    );
    expect(getCanvasPalette('swiss')).toEqual({
      bg: '#ffffff',
      grid: '#2b2b2b',
      text: '#000000',
      bid: '#00695f',
      ask: '#a52a1d',
      accent: '#004d45',
    });
  });
});

describe('attachThemeKey (T)', () => {
  it('cycles the theme on bare T', () => {
    setTheme('midnight');
    const off = attachThemeKey(window);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }));
    expect(getTheme()).toBe('paper');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'T' }));
    expect(getTheme()).toBe('swiss');
    off();
  });

  it('ignores chords, text fields, and open dialogs', () => {
    setTheme('midnight');
    const off = attachThemeKey(window);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true }));
    expect(getTheme()).toBe('midnight');

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    expect(getTheme()).toBe('midnight');

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    expect(getTheme()).toBe('midnight');

    input.remove();
    dialog.remove();
    off();
  });

  it('disposer removes the binding', () => {
    setTheme('midnight');
    const off = attachThemeKey(window);
    off();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }));
    expect(getTheme()).toBe('midnight');
  });
});

describe('storage key contract', () => {
  it('exposes the documented single source of truth', () => {
    expect(THEME_STORAGE_KEY).toBe('flowmap.theme');
  });
});

describe('ONE theme store — lazy resolution, single writer (fix 2026-09-10 F1-4)', () => {
  /** Mounts a probe that records every useTheme() value it renders with. */
  function mountProbe(): { seen: ThemeId[]; unmount: () => void } {
    const seen: ThemeId[] = [];
    const probe = (props: { onValue: (t: ThemeId) => void }): null => {
      const { theme } = useTheme();
      props.onValue(theme);
      return null;
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root!: Root;
    act(() => {
      root = createRoot(container);
      root.render(createElement(probe, { onValue: (t: ThemeId) => seen.push(t) }));
    });
    return {
      seen,
      unmount: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  }

  function mockPrefersLight(light: boolean): void {
    window.matchMedia = vi.fn().mockReturnValue({ matches: light }) as unknown as typeof window.matchMedia;
  }

  it('prefers-light + NO storage resolves paper without any init call (lazy store)', () => {
    mockPrefersLight(true);
    localStorage.clear();
    resetThemeStoreForTest();
    expect(getTheme()).toBe('paper');
  });

  it('useTheme() initial value is the RESOLVED store (never a blind default) and tracks changes', () => {
    mockPrefersLight(true);
    localStorage.clear();
    resetThemeStoreForTest();
    const { seen, unmount } = mountProbe();
    expect(seen).toEqual(['paper']); // first render = live store value
    act(() => setTheme('sea'));
    expect(seen[seen.length - 1]).toBe('sea');
    unmount();
  });

  it('setTheme("sea") then cycleTheme() wraps to midnight (store read, not a stale default)', () => {
    mockPrefersLight(false);
    localStorage.clear();
    resetThemeStoreForTest();
    setTheme('sea');
    expect(cycleTheme()).toBe('midnight');
    expect(getTheme()).toBe('midnight');
    expect(document.documentElement.dataset.theme).toBe('midnight');
  });

  it('cycle continues from the resolved first-run seed: paper → swiss (the 3-press desync regression)', () => {
    mockPrefersLight(true);
    localStorage.clear();
    resetThemeStoreForTest();
    expect(cycleTheme()).toBe('swiss'); // paper + 1 press, NOT midnight + 1
    expect(document.documentElement.dataset.theme).toBe('swiss');
  });

  it('persisted value wins over prefers-color-scheme', () => {
    mockPrefersLight(true);
    localStorage.setItem(THEME_STORAGE_KEY, 'amber');
    resetThemeStoreForTest();
    expect(getTheme()).toBe('amber');
    expect(initTheme()).toBe('amber');
    expect(document.documentElement.dataset.theme).toBe('amber');
  });

  it('initTheme persists the first-run prefers seed exactly once (later OS changes never flip)', () => {
    mockPrefersLight(true);
    localStorage.clear();
    resetThemeStoreForTest();
    expect(initTheme()).toBe('paper');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('paper');
    // OS changes its mind afterwards: the store keeps the frozen seed.
    mockPrefersLight(false);
    resetThemeStoreForTest(); // even a fresh resolution reads the persisted seed
    expect(getTheme()).toBe('paper');
  });
});
