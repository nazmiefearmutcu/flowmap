/**
 * Alert monitor (campaign-4 contract P4, lane C1) — the walk-away guarantee.
 *
 * Before this hook, only the ACTIVE symbol's alerts were evaluated (ui/PriceAlerts
 * reads the shared book at ~10 Hz). An alert set on BTC was dead the moment the
 * user switched to ETH. This hook closes that hole: it collects every symbol that
 * has alerts, polls their live quotes through {@link subscribeQuotes}
 * (`/api/quote`, 10 s, visibility-gated), and feeds fresh prices to
 * {@link evaluateAlerts} — while leaving the ACTIVE symbol to PriceAlerts, which
 * evaluates it at the book cadence from the same store (double evaluation would
 * race two writers on one latch).
 *
 * Honesty gates: a quote with `stale === true` (market closed / last-good) or
 * `reachable === false` (provider down) is SKIPPED — an alert must fire on a
 * real trade, not on an interim display mark. The REST quote is LIVE data even
 * while the chart subscription is in replay mode, so the monitor is not gated on
 * the subscription mode (PriceAlerts carries the replay guard for the book path;
 * see P7).
 *
 * Mount once (INT does, next to the other app-level hooks).
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  allAlertKeys,
  alertsFor,
  evaluateAlerts,
  getAlertsSnapshot,
  subscribeAlerts,
} from './alertsStore';
import { subscribeQuotes } from './quoteFeed';
import { useFlowMapStore } from './store';
import { playAlertSound } from '../ui/alertSound';
import { loadSettings } from '../ui/settings';

/** The active subscription's `market:symbol` key, or null before the first Hello. */
function activeKeyNow(sub: { market: string; symbol: string } | null): string | null {
  return sub === null ? null : `${sub.market}:${sub.symbol}`;
}

/** The persisted `alertSound` flag (absent/blocked storage → ON, the default). */
function soundEnabled(): boolean {
  try {
    return loadSettings(typeof window !== 'undefined' ? window.localStorage : null).alertSound;
  } catch {
    return true;
  }
}

/** Every key with at least one alert except `activeKey`, sorted (stable join). */
export function monitoredKeys(activeKey: string | null): string[] {
  return allAlertKeys()
    .filter((key) => key !== activeKey && alertsFor(key).length > 0)
    .sort();
}

export function useAlertMonitor(): void {
  const activeKey = useFlowMapStore((s) => activeKeyNow(s.subscription));
  // Any store mutation (add / fire / re-arm / delete) re-derives the watched
  // set; the JOINED fingerprint keeps the subscription stable when a mutation
  // does not change the key set (a fire must not churn the poller).
  const alertsSnapshot = useSyncExternalStore(subscribeAlerts, getAlertsSnapshot);
  const fingerprint = useMemo(() => {
    void alertsSnapshot; // identity changes on every bump — the re-derive trigger
    return monitoredKeys(activeKey).join('\n');
  }, [activeKey, alertsSnapshot]);

  useEffect(() => {
    if (fingerprint === '') return undefined;
    const keys = fingerprint.split('\n');
    return subscribeQuotes(keys, (key, quote) => {
      if (quote.stale === true || quote.reachable === false) return; // never fire on a non-live mark
      const px = quote.price;
      if (typeof px !== 'number' || !Number.isFinite(px)) return;
      const fired = evaluateAlerts(key, px);
      // R2-M1: a monitor fire is exactly the walk-away case the chime exists
      // for — the active symbol's chime lives in PriceAlerts; this covers the
      // rest. One chime per fired batch, gated by the persisted setting.
      if (fired.length > 0 && soundEnabled()) playAlertSound();
    });
  }, [fingerprint]);
}
