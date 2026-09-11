import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOG_CAP,
  MAX_ALERTS_PER_SYMBOL,
  SNOOZE_MS,
  STORAGE_PREFIX,
  addAlert,
  alertToastMessage,
  alertsFor,
  clearAlerts,
  clearPersistedForTest,
  evaluateAlerts,
  getAlertsSnapshot,
  removeAlert,
  resetAlertsForTest,
  setAlertsStorage,
  snoozeAlert,
  subscribeAlerts,
  type StorageLike,
} from './alertsStore';

/** In-memory Storage double with a keys() enumerator for cleanup. */
function memStorage(seed?: Record<string, string>): StorageLike & {
  map: Map<string, string>;
  keys: () => string[];
} {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    keys: () => [...map.keys()],
  };
}

const KEY = 'sim:SIM-DEMO';

beforeEach(() => {
  resetAlertsForTest();
  setAlertsStorage(memStorage());
  clearPersistedForTest();
});

afterEach(() => {
  resetAlertsForTest();
  setAlertsStorage(null);
  clearPersistedForTest();
  delete (window as { __flowmapToast?: unknown }).__flowmapToast;
});

describe('addAlert / alertsFor', () => {
  it('creates an alert with direction derived from the reference price', () => {
    const hi = addAlert(KEY, 60_000, 59_000);
    const lo = addAlert(KEY, 58_000, 59_000);
    expect(hi).not.toBeNull();
    expect(lo).not.toBeNull();
    expect(hi!.above).toBe(true);
    expect(lo!.above).toBe(false);
    expect(alertsFor(KEY)).toHaveLength(2);
  });

  it('defaults to above when no reference price is given', () => {
    expect(addAlert(KEY, 100)?.above).toBe(true);
  });

  it('rejects non-finite prices', () => {
    expect(addAlert(KEY, Number.NaN)).toBeNull();
    expect(addAlert(KEY, Number.POSITIVE_INFINITY)).toBeNull();
    expect(alertsFor(KEY)).toHaveLength(0);
  });

  it('bounds alerts per symbol at MAX_ALERTS_PER_SYMBOL by evicting the oldest', () => {
    for (let i = 0; i < MAX_ALERTS_PER_SYMBOL + 5; i += 1) {
      addAlert(KEY, 100 + i, 100, 1_000 + i);
    }
    const list = alertsFor(KEY);
    expect(list).toHaveLength(MAX_ALERTS_PER_SYMBOL);
    // The five OLDEST (100..104) were evicted; the newest survives.
    expect(list[0].price).toBe(105);
    expect(list[list.length - 1].price).toBe(100 + MAX_ALERTS_PER_SYMBOL + 4);
  });

  it('keeps per-symbol lists independent', () => {
    addAlert(KEY, 100);
    addAlert('sim:OTHER', 200);
    expect(alertsFor(KEY)).toHaveLength(1);
    expect(alertsFor('sim:OTHER')).toHaveLength(1);
  });
});

describe('persistence', () => {
  it('persists per symbol and reloads after a store reset', () => {
    const s = memStorage();
    setAlertsStorage(s);
    addAlert(KEY, 60_000, 59_000);
    expect(s.map.has(STORAGE_PREFIX + KEY)).toBe(true);

    resetAlertsForTest();
    expect(alertsFor(KEY)).toHaveLength(1);
    expect(alertsFor(KEY)[0].price).toBe(60_000);
    expect(alertsFor(KEY)[0].above).toBe(true);
  });

  it('survives a corrupt payload (defaults, never throws)', () => {
    const s = memStorage({ [STORAGE_PREFIX + KEY]: '{not json' });
    setAlertsStorage(s);
    expect(alertsFor(KEY)).toHaveLength(0);
  });

  it('works with storage disabled (session-local)', () => {
    setAlertsStorage(null);
    expect(addAlert(KEY, 100)).not.toBeNull();
    expect(alertsFor(KEY)).toHaveLength(1);
  });

  it('normalizes malformed stored entries instead of crashing', () => {
    const s = memStorage({
      [STORAGE_PREFIX + KEY]: JSON.stringify({
        v: 1,
        alerts: [{ price: 'abc' }, { price: 42, above: false, id: 'x1' }, null, { price: 7 }],
      }),
    });
    setAlertsStorage(s);
    const list = alertsFor(KEY);
    expect(list.map((a) => a.id)).toEqual(['x1', expect.any(String)]);
    expect(list[1].above).toBe(true); // default when absent
  });
});

describe('evaluateAlerts', () => {
  it('fires above and below crossings edge-triggered (no re-fire while beyond)', () => {
    addAlert(KEY, 60_000, 59_000); // above
    addAlert(KEY, 58_000, 59_000); // below
    expect(evaluateAlerts(KEY, 59_999)).toHaveLength(0);
    const fired = evaluateAlerts(KEY, 60_000.5);
    expect(fired).toHaveLength(1);
    expect(fired[0].price).toBe(60_000);
    expect(alertsFor(KEY)[0].triggered).toBe(true);
    // Still beyond the level → no re-fire, no store churn.
    expect(evaluateAlerts(KEY, 60_100)).toHaveLength(0);
    // Down through the below-level.
    const fired2 = evaluateAlerts(KEY, 57_000);
    expect(fired2).toHaveLength(1);
    expect(fired2[0].price).toBe(58_000);
  });

  it('no-ops on a non-finite price and on unknown symbols', () => {
    addAlert(KEY, 100);
    const v = getAlertsSnapshot().version; // addAlert bumped once
    expect(evaluateAlerts(KEY, Number.NaN)).toHaveLength(0);
    expect(evaluateAlerts('sim:NONE', 100)).toHaveLength(0);
    expect(getAlertsSnapshot().version).toBe(v); // zero churn on misses
  });

  it('persists the triggered latch so a reload does not re-fire', () => {
    // Regression (R2): the fired latch was never written back to storage, so
    // after a reload every still-beyond alert re-fired (toast + log + pulse).
    const s = memStorage();
    setAlertsStorage(s);
    addAlert(KEY, 60_000, 59_000);
    expect(evaluateAlerts(KEY, 60_100)).toHaveLength(1);
    const stored = JSON.parse(
      s.map.get(STORAGE_PREFIX + KEY) as string,
    ) as { alerts: Array<{ triggered: boolean }> };
    expect(stored.alerts[0].triggered).toBe(true);

    // Simulate the reload: fresh memory, same storage — no re-fire, no toast.
    resetAlertsForTest();
    const toastSpy = vi.fn();
    expect(evaluateAlerts(KEY, 60_200, 1_000, toastSpy)).toHaveLength(0);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('does not fire while snoozed, fires again after the window', () => {
    const a = addAlert(KEY, 60_000, 59_000)!;
    expect(evaluateAlerts(KEY, 60_100, 1_000)).toHaveLength(1);
    snoozeAlert(a.id, 2_000);
    expect(alertsFor(KEY)[0].triggered).toBe(false);
    expect(alertsFor(KEY)[0].snoozedUntil).toBe(2_000 + SNOOZE_MS);
    // Still muted inside the window.
    expect(evaluateAlerts(KEY, 60_200, 2_000 + 1_000)).toHaveLength(0);
    // Re-armed after it expires.
    expect(evaluateAlerts(KEY, 60_300, 2_000 + SNOOZE_MS + 1)).toHaveLength(1);
  });

  it('skips already-triggered alerts but re-fires others', () => {
    const a = addAlert(KEY, 60_000, 59_000)!;
    addAlert(KEY, 61_000, 59_000);
    evaluateAlerts(KEY, 60_050);
    expect(a.triggered).toBe(true);
    const fired = evaluateAlerts(KEY, 61_500);
    expect(fired.map((e) => e.price)).toEqual([61_000]);
  });

  it('notifies subscribers only when something fired', () => {
    const spy = vi.fn();
    subscribeAlerts(spy);
    addAlert(KEY, 100); // bump #1
    const bumpsAfterAdd = spy.mock.calls.length;
    evaluateAlerts(KEY, 50); // miss → silence
    expect(spy.mock.calls.length).toBe(bumpsAfterAdd);
    evaluateAlerts(KEY, 150); // hit → notify
    expect(spy.mock.calls.length).toBe(bumpsAfterAdd + 1);
  });

  it('caps the triggered log at LOG_CAP (oldest dropped, newest kept)', () => {
    for (let i = 0; i < LOG_CAP + 10; i += 1) {
      // Re-arm-able loop: add + fire + remove keeps the test cheap and honest.
      const a = addAlert(KEY, 100 + i, 50)!;
      evaluateAlerts(KEY, 1_000, 1_000 + i);
      removeAlert(a.id);
    }
    expect(getAlertsSnapshot().log).toHaveLength(LOG_CAP);
    const log = getAlertsSnapshot().log;
    expect(log[log.length - 1].price).toBe(100 + LOG_CAP + 9);
  });

  it('routes firing through window.__flowmapToast when present and survives a throwing hook', () => {
    const toasts: string[] = [];
    (window as { __flowmapToast?: unknown }).__flowmapToast = (msg: string) => {
      toasts.push(msg);
    };
    addAlert(KEY, 60_000, 59_000);
    evaluateAlerts(KEY, 60_001);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain('60,000');

    (window as { __flowmapToast?: unknown }).__flowmapToast = () => {
      throw new Error('hook exploded');
    };
    addAlert(KEY, 61_000, 60_000);
    expect(evaluateAlerts(KEY, 61_001)).toHaveLength(1); // fired anyway
  });
});

describe('remove / clear', () => {
  it('removes by id and reports misses', () => {
    const a = addAlert(KEY, 100)!;
    expect(removeAlert(a.id)).toBe(true);
    expect(removeAlert(a.id)).toBe(false);
    expect(alertsFor(KEY)).toHaveLength(0);
  });

  it('clearAlerts empties one symbol only', () => {
    addAlert(KEY, 100);
    addAlert('sim:OTHER', 200);
    clearAlerts(KEY);
    expect(alertsFor(KEY)).toHaveLength(0);
    expect(alertsFor('sim:OTHER')).toHaveLength(1);
  });
});

describe('alertToastMessage', () => {
  it('names the crossing direction and both prices', () => {
    const msg = alertToastMessage({
      id: 'x',
      key: KEY,
      alertId: 'a',
      price: 60_000,
      crossedAt: 60_012.5,
      at: 0,
    });
    expect(msg).toContain('above');
    expect(msg).toContain('60,000');
    expect(msg).toContain('60,012.5');
    expect(
      alertToastMessage({ id: 'x', key: KEY, alertId: 'a', price: 100, crossedAt: 90, at: 0 }),
    ).toContain('below');
  });
});
