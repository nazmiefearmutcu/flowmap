import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addAlert,
  alertsFor,
  clearPersistedForTest,
  removeAlert,
  resetAlertsForTest,
  setAlertsStorage,
  type StorageLike,
} from './alertsStore';
import { resetQuoteFeedForTest, type Quote } from './quoteFeed';
import { useFlowMapStore } from './store';
import { useAlertMonitor } from './alertMonitor';

vi.mock('../ui/alertSound', () => ({ playAlertSound: vi.fn() }));

import { playAlertSound } from '../ui/alertSound';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function Monitor(): null {
  useAlertMonitor();
  return null;
}

function render(): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<Monitor />);
  });
  mounted.push({ container, root });
}

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function quote(body: Partial<Quote> & { symbol: string }): Quote {
  return {
    market: 'sim',
    price: 100,
    changePct: 0,
    spark: [],
    stale: false,
    reachable: true,
    ...body,
  };
}

function urls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  vi.mocked(playAlertSound).mockClear();
  resetAlertsForTest();
  setAlertsStorage(memStorage());
  clearPersistedForTest();
  resetQuoteFeedForTest();
  useFlowMapStore.setState({
    subscription: { market: 'sim', symbol: 'SIM-DEMO', mode: 'live', band: 'native' },
  });
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetQuoteFeedForTest();
  resetAlertsForTest();
  setAlertsStorage(null);
  clearPersistedForTest();
  useFlowMapStore.setState({ subscription: null });
});

describe('useAlertMonitor', () => {
  it('evaluates a NON-active symbol from its live quote; never polls the active one', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('symbol=OTHER')) {
        return { ok: true, json: async () => quote({ symbol: 'OTHER', price: 250 }) };
      }
      return { ok: true, json: async () => quote({ symbol: 'SIM-DEMO', price: 1 }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    addAlert('sim:OTHER', 200, 100); // above → the 250 quote crosses it
    addAlert('sim:SIM-DEMO', 999, 1); // ACTIVE symbol alert — PriceAlerts owns it
    render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(alertsFor('sim:OTHER')[0].triggered).toBe(true);
    const seen = urls(fetchMock);
    expect(seen.some((u) => u.includes('symbol=OTHER'))).toBe(true);
    expect(seen.some((u) => u.includes('symbol=SIM-DEMO'))).toBe(false);
  });

  it('skips stale and unreachable quotes — never fires on a non-live mark', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('symbol=STALE')) {
        return { ok: true, json: async () => quote({ symbol: 'STALE', price: 250, stale: true }) };
      }
      if (u.includes('symbol=DOWN')) {
        return { ok: true, json: async () => quote({ symbol: 'DOWN', price: 250, reachable: false }) };
      }
      return { ok: true, json: async () => quote({ symbol: 'FRESH', price: 250 }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    addAlert('sim:STALE', 200, 100);
    addAlert('sim:DOWN', 200, 100);
    addAlert('sim:FRESH', 200, 100);
    render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(alertsFor('sim:STALE')[0].triggered).toBe(false);
    expect(alertsFor('sim:DOWN')[0].triggered).toBe(false);
    expect(alertsFor('sim:FRESH')[0].triggered).toBe(true);
  });

  it('unsubscribes (stops polling) when the alerts are removed', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => quote({ symbol: 'OTHER', price: 250 }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const alert = addAlert('sim:OTHER', 200, 100)!;
    render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(alertsFor('sim:OTHER')[0].triggered).toBe(true);
    const callsAfterFire = fetchMock.mock.calls.length;
    expect(callsAfterFire).toBeGreaterThan(0);

    act(() => {
      removeAlert(alert.id);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterFire); // the poller is gone
  });

  it('follows the active-key switch: the new active key is dropped from polling', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('symbol=OTHER')) {
        return { ok: true, json: async () => quote({ symbol: 'OTHER', price: 150 }) };
      }
      return { ok: true, json: async () => quote({ symbol: 'AAPL', price: 150 }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    addAlert('sim:OTHER', 200, 100);
    addAlert('equity:AAPL', 200, 100);
    render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(urls(fetchMock).some((u) => u.includes('symbol=OTHER'))).toBe(true);
    expect(urls(fetchMock).some((u) => u.includes('symbol=AAPL'))).toBe(true);

    // Switch the active subscription to AAPL → the monitor must stop polling it.
    act(() => {
      useFlowMapStore.setState({
        subscription: { market: 'equity', symbol: 'AAPL', mode: 'live', band: 'native' },
      });
    });
    const before = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const fresh = urls(fetchMock).slice(before);
    expect(fresh.some((u) => u.includes('symbol=AAPL'))).toBe(false);
    expect(fresh.some((u) => u.includes('symbol=OTHER'))).toBe(true); // still watched
  });

  it('chimes once per fired batch on the monitor path (R2-M1)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => quote({ symbol: 'OTHER', price: 250 }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    addAlert('sim:OTHER', 200, 100); // above → the 250 quote crosses it
    render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(alertsFor('sim:OTHER')[0].triggered).toBe(true);
    expect(vi.mocked(playAlertSound)).toHaveBeenCalledTimes(1);
  });

  it('stays silent on the monitor path when alertSound is disabled (R2-M1)', async () => {
    window.localStorage.setItem(
      'flowmap.settings.v1',
      JSON.stringify({ alertSound: false }),
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => quote({ symbol: 'OTHER', price: 250 }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    addAlert('sim:OTHER', 200, 100);
    render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(alertsFor('sim:OTHER')[0].triggered).toBe(true);
    expect(vi.mocked(playAlertSound)).not.toHaveBeenCalled();
  });
});
