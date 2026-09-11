/**
 * On-chart price alerts (campaign 3, lane CD) — the container over the chart.
 *
 * Renders, inside the chart viewport: one dashed horizontal marker line per
 * alert of the CURRENT symbol (labelled with its level, solid red + a pulse
 * once fired), a bell chip (bottom-right) that opens the AlertsPopover, and
 * the keyboard surface: `A` creates an alert at the crosshair price.
 *
 * Data flow stays off the React render path: an interval at the bookStore
 * flush cadence (~10 Hz) reads the latest market price (BBO mid, else the
 * last trade) and hands it to {@link evaluateAlerts}; alert list changes
 * arrive through `useSyncExternalStore` on the alerts store. Marker lines are
 * positioned through the renderer's `overlayRowCss` (price → row → canvas
 * CSS px), polled at the same cadence so they stay glued under pan/zoom.
 * Everything is client-local + localStorage-persisted per symbol; fires are
 * announced via the `window.__flowmapToast?.(msg)` hook when the shell
 * provides one (never imported — the hook is the contract).
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';

import type { Renderer } from '../gl/renderer';
import { priceToRow as scalePriceToRow, scaleFromEpoch } from '../gl/priceScale';
import {
  addAlert,
  alertsFor,
  evaluateAlerts,
  getAlertsSnapshot,
  removeAlert,
  snoozeAlert,
  subscribeAlerts,
} from '../state/alertsStore';
import { getSnapshot } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { classifyTarget, routeGlobalKey } from '../input/keys';
import { lastProbeSpot } from './lastProbe';
import { AlertsPopover } from './AlertsPopover';
import './features.css';

/** Marker-line / evaluation poll cadence (matches the bookStore flush ~10 Hz). */
const POLL_MS = 100;
/** How long a fired marker keeps pulsing. */
const PULSE_MS = 2000;

/** Latest usable market price off the shared book buffer: BBO mid, else last trade. */
export function marketPriceNow(): number | null {
  const { bbo, trades } = getSnapshot();
  if (bbo !== null && bbo.bidPx > 0 && bbo.askPx > 0) {
    const mid = (bbo.bidPx + bbo.askPx) / 2;
    if (Number.isFinite(mid)) return mid;
  }
  if (trades.length > 0) {
    const t = trades[0]; // newest-first
    if (Number.isFinite(t.price)) return t.price;
  }
  return null;
}

interface PriceAlertsProps {
  /** Renderer ref — marker lines position through `overlayRowCss`. */
  rendererRef: MutableRefObject<Renderer | null>;
}

export function PriceAlerts({ rendererRef }: PriceAlertsProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [pulsing, setPulsing] = useState<ReadonlySet<string>>(new Set());
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sub = useFlowMapStore((s) => s.subscription);
  const gridEpoch = useFlowMapStore((s) => s.gridEpoch);
  const epochs = useFlowMapStore((s) => s.epochs);
  const key = sub === null ? null : `${sub.market}:${sub.symbol}`;

  const alertsVersion = useSyncExternalStore(subscribeAlerts, getAlertsSnapshot);
  // Re-list only on store bumps or symbol switches (alertsFor lazily loads the
  // persisted list for `key` on first touch; the version gates re-renders).
  const alerts = key === null ? [] : alertsFor(key);
  void alertsVersion;

  const params = gridEpoch === null ? null : (epochs.get(gridEpoch) ?? null);

  // Evaluation + reposition tick. Never per WS message: the ~10 Hz poll bounds
  // the work and one evaluate call is O(active alerts).
  useEffect(() => {
    if (key === null) return;
    const id = window.setInterval(() => {
      const px = marketPriceNow();
      if (px !== null) {
        const fired = evaluateAlerts(key, px);
        if (fired.length > 0) {
          const ids = new Set(fired.map((e) => e.alertId));
          setPulsing(ids);
          if (pulseTimer.current !== null) clearTimeout(pulseTimer.current);
          pulseTimer.current = setTimeout(() => setPulsing(new Set()), PULSE_MS);
        }
      }
      setNow(Date.now()); // drives line repositioning + popover badges
    }, POLL_MS);
    return () => {
      window.clearInterval(id);
      if (pulseTimer.current !== null) clearTimeout(pulseTimer.current);
    };
  }, [key]);

  const createAt = useCallback(
    (price: number) => {
      if (key === null) return;
      addAlert(key, price, marketPriceNow() ?? undefined);
    },
    [key],
  );

  // `A` — alert at the crosshair price (the price the user is pointing at).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const action = routeGlobalKey(e.key, classifyTarget(e.target));
      if (action?.type !== 'create-alert') return;
      if (key === null) return;
      e.preventDefault();
      const spot = lastProbeSpot();
      if (spot === null || spot.price === null) return; // no crosshair price yet — honest no-op
      addAlert(key, spot.price, marketPriceNow() ?? undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key]);

  // Position each alert's line: price → row → canvas CSS px (view-transformed
  // fresh every poll, so pan/zoom/epoch re-anchor all stay glued).
  const scale = params ? scaleFromEpoch(params) : null;
  const renderer = rendererRef.current;
  const lines =
    scale === null || renderer === null
      ? []
      : alerts.flatMap((a) => {
          const row = scalePriceToRow(scale, a.price);
          if (!Number.isFinite(row)) return [];
          const y = renderer.overlayRowCss(row);
          if (!Number.isFinite(y)) return [];
          return [{ alert: a, y }];
        });

  if (key === null) return null;
  const refPx = marketPriceNow();

  return (
    <>
      <div className="alert-lines" data-testid="alert-lines" aria-hidden="true">
        {lines.map(({ alert, y }) => (
          <div
            key={alert.id}
            className={`alert-line${alert.triggered ? ' alert-line--triggered' : ''}${
              pulsing.has(alert.id) ? ' alert-line--pulse' : ''
            }`}
            data-testid={`alert-line-${alert.id}`}
            style={{ top: `${y}px` }}
          >
            <span className="alert-line__tag">
              {alert.above ? '↑' : '↓'} {alert.price}
            </span>
          </div>
        ))}
      </div>

      <button
        type="button"
        className={`alerts-chip${open ? ' is-open' : ''}`}
        data-testid="alerts-chip"
        aria-expanded={open}
        aria-label={`price alerts (${alerts.length})`}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">⚠</span>
        <span className="alerts-chip__count">{alerts.length}</span>
      </button>

      {open && (
        <AlertsPopover
          alerts={alerts}
          refPx={refPx}
          now={now}
          onClose={() => setOpen(false)}
          onCreate={createAt}
          onDelete={(id) => void removeAlert(id)}
          onSnooze={(id) => void snoozeAlert(id)}
          onClearFired={() => {
            for (const a of alerts) {
              if (a.triggered) removeAlert(a.id);
            }
          }}
        />
      )}
    </>
  );
}
