/**
 * App-shell integration smoke (campaign 3 INT lane): the FULL app mounts with
 * every lane layer in the chart stack, and each feature key shows/hides its
 * panel. jsdom has no WebGL2, so the renderer honestly degrades to the
 * gl-fallback path — which is exactly the "mounts and stays alive" surface this
 * test wants to pin (the GL pixels themselves are CB's golden tests).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { bookStore } from './state/bookStore';
import { setFlowMapTransport, useFlowMapStore } from './state/store';
import type { SocketLike } from './net/connection';
import { resetDrawingsForTest } from './drawings/store';
import { resetIndicatorStoreForTest } from './indicators/store';
import { setLocale } from './i18n';
import { getTheme, resetThemeStoreForTest, setTheme, THEME_IDS } from './theme';
import { markOnboarded, ONBOARDING_KEY } from './ui/OnboardingCard';
import { resetToasts } from './ui/Toaster';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket implements SocketLike {
  binaryType = 'blob';
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {
    this.onclose?.();
  }
  /** Server-side drop with the CloseEvent code (e.g. the 1003 replay refusal). */
  drop(code?: number): void {
    this.onclose?.({ code });
  }
  open(): void {
    this.onopen?.();
  }
}

let sockets: FakeWebSocket[] = [];

function installFakeTransport(): void {
  sockets = [];
  setFlowMapTransport({
    url: 'wss://test.invalid/ws',
    wsFactory: (url: string): SocketLike => {
      const s = new FakeWebSocket(url);
      sockets.push(s);
      return s;
    },
  });
}

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function mountApp(): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<App />);
  });
  mounted.push({ container, root });
  return { container, root };
}

function fireKey(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
    window.localStorage.clear();
  installFakeTransport();
  markOnboarded(); // suppress the first-run wizard (its own test below)
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  useFlowMapStore.getState().disconnect();
  setFlowMapTransport({});
  resetDrawingsForTest();
  resetIndicatorStoreForTest();
  resetToasts();
  window.localStorage.removeItem(ONBOARDING_KEY);
  setTheme('midnight');
  setLocale('en');
  document.documentElement.dataset.theme = 'midnight';
});

describe('App integration smoke', () => {
  it('mounts the full chart overlay stack (GL → indicators → drawings → alerts) with no throw', () => {
    const { container } = mountApp();
    // Shell chrome
    expect(container.querySelector('[data-testid="mode-toggle"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="settings-open"]')).not.toBeNull();
    // jsdom has no WebGL2: the honest fallback shows, the app stays alive.
    expect(container.querySelector('[data-testid="gl-fallback"]')).not.toBeNull();
    // Chart overlay stack (bottom → top lane mounts, all inside the viewport)
    expect(container.querySelector('[data-testid="indi-overlay"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="drawing-layer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="alerts-chip"]')).not.toBeNull();
    // Drawer still lists the depth-channel control (lane CD) + Appearance (INT)
    click(container.querySelector('[data-testid="settings-open"]')!);
    expect(container.querySelector('[data-testid="setting-depthChannel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="setting-theme"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="setting-locale"]')).not.toBeNull();
  });

  it('H shows/hides the perf HUD chip', () => {
    const { container } = mountApp();
    expect(container.querySelector('[data-testid="perf-hud"]')).toBeNull();
    fireKey('h');
    expect(container.querySelector('[data-testid="perf-hud"]')).not.toBeNull();
    fireKey('h');
    expect(container.querySelector('[data-testid="perf-hud"]')).toBeNull();
  });

  it('M arms/disarms the measure tool', () => {
    const { container } = mountApp();
    expect(container.querySelector('[data-testid="measure-mode"]')).toBeNull();
    fireKey('m');
    expect(container.querySelector('[data-testid="measure-mode"]')).not.toBeNull();
    fireKey('m');
    expect(container.querySelector('[data-testid="measure-mode"]')).toBeNull();
  });

  it('D shows/hides the draw toolbar', () => {
    const { container } = mountApp();
    expect(container.querySelector('[data-testid="draw-toolbar"]')).toBeNull();
    fireKey('d');
    expect(container.querySelector('[data-testid="draw-toolbar"]')).not.toBeNull();
    fireKey('d');
    expect(container.querySelector('[data-testid="draw-toolbar"]')).toBeNull();
  });

  it('I shows/hides the indicator picker', () => {
    const { container } = mountApp();
    expect(container.querySelector('[data-testid="indi-picker"]')).toBeNull();
    fireKey('i');
    expect(container.querySelector('[data-testid="indi-picker"]')).not.toBeNull();
    fireKey('i');
    expect(container.querySelector('[data-testid="indi-picker"]')).toBeNull();
  });

  it('? shows the shortcuts overlay and Escape closes it', () => {
    mountApp();
    // The shortcuts overlay portal-renders to document.body, not the app root.
    expect(document.querySelector('[data-testid="shortcuts-overlay"]')).toBeNull();
    fireKey('?');
    expect(document.querySelector('[data-testid="shortcuts-overlay"]')).not.toBeNull();
    fireKey('Escape');
    expect(document.querySelector('[data-testid="shortcuts-overlay"]')).toBeNull();
  });

  it('C cycles the depth channel setting (visible in the drawer)', () => {
    const { container } = mountApp();
    fireKey('c'); // sum → bid
    click(container.querySelector('[data-testid="settings-open"]')!);
    expect(
      container.querySelector('[data-testid="depthChannel-bid"]')!.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('T cycles the theme and the app keeps rendering', () => {
    const { container } = mountApp();
    expect(document.documentElement.dataset.theme).toBe('midnight');
    fireKey('t');
    expect(document.documentElement.dataset.theme).toBe('paper');
    expect(container.querySelector('[data-testid="mode-toggle"]')).not.toBeNull();
    // campaign-4: the registry grew — walk the FULL cycle back home. One press
    // was already consumed above, so length-1 more wraps around.
    for (let i = 0; i < THEME_IDS.length - 1; i++) fireKey('t');
    expect(document.documentElement.dataset.theme).toBe('midnight');
  });

  // fix 2026-09-10 F1-4: ONE theme store. First run with prefers-color-scheme:
  // light must paint the paper chrome AND keep it — the store (which App's
  // effect mirrors onto <html data-theme>) and cycleTheme read the same value,
  // so there is no midnight flip and no cycle desync.
  it('first run under prefers-light mounts as paper and never flips to midnight', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    window.localStorage.clear();
    resetThemeStoreForTest(); // simulate a truly fresh boot (nothing resolved)
    const { container } = mountApp();
    // dataset follows the store from the very first mount (no flip afterwards)
    expect(document.documentElement.dataset.theme).toBe('paper');
    // an interaction storm must NOT flip the chrome to midnight
    fireKey('h');
    click(container.querySelector('[data-testid="mode-toggle"]')!);
    expect(document.documentElement.dataset.theme).toBe('paper');
    expect(getTheme()).toBe('paper');
    // and the cycle continues FROM paper (paper → swiss), not from midnight
    fireKey('t');
    expect(document.documentElement.dataset.theme).toBe('swiss');
    expect(getTheme()).toBe('swiss');
    setTheme('midnight'); // restore for afterEach cleanliness
  });

  it('the alert→toast bridge is bound by the mounted Toaster', () => {
    const { container } = mountApp();
    expect(container.querySelector('[data-testid="toasts"]')).toBeNull();
    act(() => {
      (window as unknown as { __flowmapToast?: (msg: string) => void }).__flowmapToast?.(
        'Alert · crossed above 60,000',
      );
    });
    expect(container.querySelector('[data-testid="toasts"]')).not.toBeNull();
  });

  it('first run auto-opens the onboarding wizard; Skip persists the flag', () => {
    window.localStorage.removeItem(ONBOARDING_KEY); // un-mark: simulate a true first run
    const { container } = mountApp();
    expect(container.querySelector('[data-testid="onboarding-dialog"]')).not.toBeNull();
    const skip = container.querySelector('[data-testid="onboarding-skip"]');
    if (skip) click(skip);
    expect(window.localStorage.getItem('flowmap.onboarded')).toBe('1');
  });
});

describe('App — refused-replay fallback + explicit session identity (QA7 H1/H2)', () => {
  it('re-runs the symbol-switch reset when a refused replay falls back to LIVE (QA7 H1)', () => {
    mountApp(); // jsdom: gl-fallback path, but the reset effect is the same
    const spy = vi.spyOn(bookStore, 'resetForSession');
    // Subscribe replay on the shared connection, then let the server refuse it
    // with the unsupported close (1003) exactly as ws.py does.
    act(() => {
      useFlowMapStore.getState().connectAndSubscribe('crypto', 'BTCUSDT', 'replay');
    });
    const sock = sockets[sockets.length - 1];
    act(() => sock.open());
    // The market switch above legitimately reset; the FALLBACK is what we pin:
    // it re-subscribes the SAME instrument, so only the store's sessionRevision
    // can tell the App a new server session began under the unchanged key.
    spy.mockClear();
    act(() => sock.drop(1003));
    expect(useFlowMapStore.getState().subscription?.mode).toBe('live');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('mode toggle keeps the CURRENT band — it must not drag the drawer band (QA7 H1)', () => {
    const { container } = mountApp();
    // A session on 'native' while the persisted drawer default is 'deep' (the
    // QA7 harness shape). The replay button renders only when the server says
    // replay exists.
    act(() => {
      useFlowMapStore.setState({
        capability: { replay: true },
        subscription: { market: 'crypto', symbol: 'BTCUSDT', mode: 'live', band: 'native' },
      });
    });
    click(container.querySelector('[data-testid="mode-replay"]')!);
    // The mode changed; the GRID did not. Dragging settings.priceBand ('deep')
    // along re-subscribed a different grid — the pancaked-scale repro.
    expect(useFlowMapStore.getState().subscription).toEqual({
      market: 'crypto',
      symbol: 'BTCUSDT',
      mode: 'replay',
      band: 'native',
    });
  });

  it('mode toggle with no subscription is a no-op — never substitutes the demo stream (QA7 H2)', () => {
    const { container } = mountApp();
    act(() => {
      useFlowMapStore.getState().disconnect();
    });
    expect(useFlowMapStore.getState().subscription).toBeNull();
    const socketsBefore = sockets.length;

    click(container.querySelector('[data-testid="mode-live"]')!);

    // Explicit-only identity: with nothing subscribed there is no stream to
    // switch modes on; the old `?? SIM_MARKET` fallback silently made the user's
    // live symbol sim:SIM-DEMO.
    expect(useFlowMapStore.getState().subscription).toBeNull();
    expect(sockets.length).toBe(socketsBefore);
  });
});
