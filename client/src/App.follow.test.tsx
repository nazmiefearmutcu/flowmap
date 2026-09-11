/**
 * App follow/persistence integration (campaign 2026-09-11, D1/D4 + CP1).
 *
 * jsdom has no WebGL2, so the real App test mounts the honest gl-fallback with
 * NO renderer. These tests need the renderer surface (follow state + the CP1
 * methods), so the `./gl/renderer` module is replaced with a controllable fake
 * whose state this file drives:
 *
 *   - chip LOCK persists `followPrice=false` (D4: the drawer + reload must agree
 *     with the camera);
 *   - the TRACK PRICE composite re-pins TIME when the live edge is off-screen
 *     (D1) and persists BOTH follow policies;
 *   - a renderer-originated lock (canvas P / price pan) is reconciled into
 *     settings by the ≤4 Hz poll;
 *   - a `sessionId` change calls `resetOverlaysForNewSession()` (CP1/D5);
 *   - the global F / P / R keys route through the same App writers.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { setFlowMapTransport, useFlowMapStore } from './state/store';
import type { SocketLike } from './net/connection';
import { resetDrawingsForTest } from './drawings/store';
import { resetIndicatorStoreForTest } from './indicators/store';
import { markOnboarded, ONBOARDING_KEY } from './ui/OnboardingCard';
import { resetToasts } from './ui/Toaster';
import { SETTINGS_KEY } from './ui/settings';

const H = vi.hoisted(() => ({
  state: {
    following: true,
    priceFollow: 'fit' as 'fit' | 'track' | 'off',
    liveEdgeVisible: true,
    toggleFollowCalls: 0,
    goLiveCalls: 0,
    setPriceFollowCalls: 0,
    resetForSessionCalls: 0,
    resetOverlaysCalls: 0,
  },
}));

vi.mock('./gl/renderer', () => {
  class Renderer {
    constructor() {
      // Unknown members become inert no-ops so the full App tree (crosshair,
      // CvdPane, PriceAlerts …) can mount without a GL context. Follow state and
      // the CP1 methods are explicitly controllable.
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver) as unknown;
          if (typeof prop === 'string') return () => undefined;
          return undefined;
        },
      });
    }
    get following(): boolean {
      return H.state.following;
    }
    get priceFollow(): 'fit' | 'track' | 'off' {
      return H.state.priceFollow;
    }
    get liveEdgeVisible(): boolean {
      return H.state.liveEdgeVisible;
    }
    setPriceFollow(mode: 'fit' | 'track' | 'off'): void {
      H.state.priceFollow = mode;
      H.state.setPriceFollowCalls += 1;
    }
    toggleFollow(): void {
      H.state.following = !H.state.following;
      H.state.toggleFollowCalls += 1;
    }
    goLive(): void {
      H.state.following = true;
      H.state.goLiveCalls += 1;
    }
    resetForSession(): void {
      H.state.resetForSessionCalls += 1;
    }
    resetOverlaysForNewSession(): void {
      H.state.resetOverlaysCalls += 1;
    }
    timeline(): null {
      return null;
    }
    /** chartMap (MeasureTool/DrawingLayer) reads these every rAF tick. */
    probeAt(): { colSeq: number; row: number } | null {
      return null;
    }
    cellToCanvasCss(col: number, row: number): { x: number; y: number } {
      return { x: col, y: row };
    }
    overlayRowCss(row: number): number {
      return row;
    }
    cvdSeries(): { col: number; cvd: number }[] {
      return [];
    }
    cvdValueAt(): number {
      return Number.NaN;
    }
    dispose(): void {
      /* no-op */
    }
  }
  return { Renderer };
});

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
}

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function installFakeTransport(): void {
  setFlowMapTransport({
    url: 'wss://test.invalid/ws',
    wsFactory: (url: string): SocketLike => new FakeWebSocket(url),
  });
}

function mountApp(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<App />);
  });
  mounted.push({ container, root });
  return container;
}

/** Advance the component polls (PriceAxis 100ms / LiveControls 250ms / reconcile 250ms). */
function settle(): void {
  act(() => {
    vi.advanceTimersByTime(400);
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function fireKey(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

function saved(): { followPrice: boolean; follow: boolean } {
  return JSON.parse(window.localStorage.getItem(SETTINGS_KEY)!) as {
    followPrice: boolean;
    follow: boolean;
  };
}

function resetFake(): void {
  H.state.following = true;
  H.state.priceFollow = 'fit';
  H.state.liveEdgeVisible = true;
  H.state.toggleFollowCalls = 0;
  H.state.goLiveCalls = 0;
  H.state.setPriceFollowCalls = 0;
  H.state.resetForSessionCalls = 0;
  H.state.resetOverlaysCalls = 0;
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  resetFake();
  installFakeTransport();
  markOnboarded();
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  useFlowMapStore.setState({ sessionId: null, subscription: null });
  useFlowMapStore.getState().disconnect();
  setFlowMapTransport({});
  resetDrawingsForTest();
  resetIndicatorStoreForTest();
  resetToasts();
  window.localStorage.removeItem(ONBOARDING_KEY);
  vi.useRealTimers();
});

describe('App follow wiring (D1/D4/CP1)', () => {
  it('chip LOCK writes through to persisted settings (drawer + reload agree)', () => {
    const container = mountApp();
    settle();
    expect(H.state.priceFollow).toBe('fit');
    const chip = container.querySelector('[data-testid="price-auto"]');
    expect(chip).not.toBeNull();
    click(chip!);
    expect(H.state.priceFollow).toBe('off');
    expect(saved().followPrice).toBe(false);
  });

  it('TRACK PRICE with the live edge off-screen also re-pins TIME (composite) and persists both', () => {
    const container = mountApp();
    settle(); // boot applies the persisted policy (fit)
    H.state.priceFollow = 'off'; // a lock that happened live (canvas P / chip)
    H.state.liveEdgeVisible = false;
    settle(); // polls see the lock; the reconciler persists it
    const chip = container.querySelector('[data-testid="chip-track-price"]');
    expect(chip).not.toBeNull();
    click(chip!);
    expect(H.state.priceFollow).toBe('track');
    expect(H.state.goLiveCalls).toBe(1); // the dead-control fix (S1 D1)
    expect(saved().followPrice).toBe(true);
    expect(saved().follow).toBe(true);
  });

  it('TRACK PRICE with the live edge visible does NOT re-pin time (zoom-only composite)', () => {
    const container = mountApp();
    settle();
    H.state.priceFollow = 'off';
    H.state.liveEdgeVisible = true;
    settle();
    click(container.querySelector('[data-testid="chip-track-price"]')!);
    expect(H.state.priceFollow).toBe('track');
    expect(H.state.goLiveCalls).toBe(0);
    expect(saved().followPrice).toBe(true);
  });

  it('reconciles a renderer-originated lock (canvas P / price pan) into settings', () => {
    mountApp();
    settle();
    expect(saved().followPrice).toBe(true);
    H.state.priceFollow = 'off'; // the gesture path, no App callback involved
    settle();
    expect(saved().followPrice).toBe(false);
    H.state.priceFollow = 'track';
    settle();
    expect(saved().followPrice).toBe(true);
  });

  it('calls resetOverlaysForNewSession on every sessionId change (CP1/D5)', () => {
    mountApp();
    act(() => {
      useFlowMapStore.setState({ sessionId: 'session-1' });
    });
    expect(H.state.resetOverlaysCalls).toBe(1);
    act(() => {
      useFlowMapStore.setState({ sessionId: 'session-2' });
    });
    expect(H.state.resetOverlaysCalls).toBe(2);
  });

  it('routes the global F / P / R keys through the same persist writers', () => {
    mountApp();
    settle();
    // F toggles time follow and persists the policy.
    fireKey('f');
    expect(H.state.following).toBe(false);
    expect(saved().follow).toBe(false);
    fireKey('f');
    expect(H.state.following).toBe(true);
    expect(saved().follow).toBe(true);
    // P toggles the price axis and persists followPrice.
    fireKey('p');
    expect(H.state.priceFollow).toBe('off');
    expect(saved().followPrice).toBe(false);
    fireKey('P', { shiftKey: true });
    expect(H.state.priceFollow).toBe('fit'); // Shift+P = auto-fit
    expect(saved().followPrice).toBe(true);
    // R re-arms TIME and PRESERVES a deliberate price LOCK (R2-M1): the lock
    // set below is not overwritten by GO LIVE.
    H.state.priceFollow = 'off';
    H.state.following = false;
    fireKey('r');
    expect(H.state.goLiveCalls).toBe(1);
    expect(H.state.following).toBe(true);
    expect(saved().follow).toBe(true);
    expect(saved().followPrice).toBe(false); // the lock survives GO LIVE
  });
});
