/**
 * Alerts popover (campaign 3, lane CD; campaign 4, lane C1) — the list surface
 * for the on-chart price alerts: every alert for the CURRENT symbol with its
 * state (armed / re-armed / firing-re-arm pending / fired at hh:mm:ss / muted),
 * a re-arm button for fired or muted alerts, a snooze button for armed ones, a
 * delete button, and a create form for typing an exact level. Presentational on
 * purpose: state lives in state/alertsStore.ts, mounting + data wiring in
 * ui/PriceAlerts.tsx (the only component INT mounts).
 *
 * Accessibility: the surface is a `role="dialog"` (so input/keys.ts classifies
 * its children as inside a dialog and background shortcuts yield) with a Tab
 * trap and Escape-to-close through the open-overlay registry.
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { PriceAlert } from '../state/alertsStore';
import { isTopOverlay, pushOverlay } from './overlayStack';

/** hh:mm:ss for a fired-at timestamp (local time — "when your screen showed"). */
function fmtClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
  } catch {
    return '—';
  }
}

/** Seconds left in a snooze, for the muted badge. */
function mutedFor(snoozedUntil: number | null, now: number): number | null {
  if (snoozedUntil === null || snoozedUntil <= now) return null;
  return Math.ceil((snoozedUntil - now) / 1000);
}

export interface AlertsPopoverProps {
  alerts: readonly PriceAlert[];
  /** Live market price — the reference the add-row hint compares against. */
  refPx: number | null;
  onClose: () => void;
  onCreate: (price: number) => void;
  onDelete: (id: string) => void;
  /** Mute an armed alert for the snooze window. */
  onSnooze: (id: string) => void;
  /** Clear the mute / fired latch (hysteresis band preserved). */
  onRearm: (id: string) => void;
  /** Delete every FIRED alert (they have already done their job). */
  onClearFired: () => void;
  /** Now, ms epoch — re-rendered by the parent at its poll cadence. */
  now: number;
}

export function AlertsPopover({
  alerts,
  refPx,
  onClose,
  onCreate,
  onDelete,
  onSnooze,
  onRearm,
  onClearFired,
  now,
}: AlertsPopoverProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);

  // The parent re-creates `onClose` every poll tick (~10 Hz), so the overlay
  // effect below must NOT depend on it — otherwise its cleanup refocuses the
  // opener and its body refocuses the close button 10×/s, stealing focus from
  // the add-alert input while the user types. Route the latest callback through
  // a ref and mount the effect once.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    // Join the open-overlay registry so a single Escape closes only the TOP
    // surface (the settings drawer defers to whoever pushed later).
    const off = pushOverlay('alerts');
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isTopOverlay('alerts')) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      off();
      opener?.focus?.(); // WCAG 2.4.3: focus returns to the bell chip
    };
    // Mount-only by design (see the ref comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Trap Tab / Shift+Tab inside the dialog while it is open (the disabled "add"
  // button is skipped so the cycle never dead-ends on an unfocusable stop).
  const onTrapKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const root = sectionRef.current;
    if (!root) return;
    const focusable = root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !root.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const firedCount = alerts.filter((a) => a.triggered).length;
  const decimals = refPx !== null && refPx < 1 ? 6 : 2;
  const fmtPx = (v: number): string =>
    v.toLocaleString('en-US', { maximumFractionDigits: 8 });

  const submit = (): void => {
    const v = Number(draft);
    if (!Number.isFinite(v)) return;
    onCreate(v);
    setDraft('');
    inputRef.current?.focus();
  };

  return (
    <section
      ref={sectionRef}
      className="alerts-pop"
      data-testid="alerts-popover"
      role="dialog"
      aria-modal="true"
      aria-label="price alerts"
      onKeyDown={onTrapKeyDown}
    >
      <header className="alerts-pop__head">
        <span className="alerts-pop__title">
          Price alerts
          <span className="alerts-chip__count"> · {alerts.length}</span>
        </span>
        {firedCount > 0 && (
          <button
            type="button"
            className="alert-row__btn"
            data-testid="alerts-clear-fired"
            onClick={onClearFired}
          >
            clear fired
          </button>
        )}
        <button
          ref={closeRef}
          type="button"
          className="alert-row__btn"
          data-testid="alerts-close"
          aria-label="close alerts"
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <div className="alerts-pop__body">
        {alerts.length === 0 ? (
          <div className="alerts-pop__empty" data-testid="alerts-empty">
            No alerts for this symbol. Press <b>A</b> at the crosshair, or type a level below.
          </div>
        ) : (
          alerts.map((a) => {
            const muted = mutedFor(a.snoozedUntil, now);
            // Five honest states (survey 3 #6): a fired alert now waits for the
            // hysteresis band; once price returns inside it the alert is
            // RE-ARMED (has fired before, currently armed); a manual re-arm
            // while price is still beyond shows the band it is waiting for.
            const state = a.triggered
              ? `fired ${a.triggeredAt !== null ? fmtClock(a.triggeredAt) : ''}`
              : muted !== null
                ? `muted ${muted}s`
                : a.rearmPx !== null
                  ? `re-arming @ ${fmtPx(a.rearmPx)}`
                  : a.triggeredAt !== null
                    ? a.above
                      ? 're-armed ↑'
                      : 're-armed ↓'
                    : a.above
                      ? 'armed ↑'
                      : 'armed ↓';
            const stateCls = a.triggered
              ? ' alert-row__state--fired'
              : muted !== null
                ? ' alert-row__state--muted'
                : '';
            const needsRearm = a.triggered || muted !== null;
            return (
              <div className="alert-row" key={a.id} data-testid="alert-row">
                <span className="alert-row__px">
                  {a.above ? '↑' : '↓'} {fmtPx(a.price)}
                </span>
                <span className={`alert-row__state${stateCls}`} data-testid="alert-state">
                  {state}
                </span>
                {needsRearm ? (
                  <button
                    type="button"
                    className="alert-row__btn"
                    data-testid={`alert-rearm-${a.id}`}
                    onClick={() => onRearm(a.id)}
                  >
                    re-arm
                  </button>
                ) : (
                  <button
                    type="button"
                    className="alert-row__btn"
                    data-testid={`alert-snooze-${a.id}`}
                    onClick={() => onSnooze(a.id)}
                  >
                    snooze
                  </button>
                )}
                <button
                  type="button"
                  className="alert-row__btn"
                  data-testid={`alert-delete-${a.id}`}
                  aria-label={`delete alert at ${fmtPx(a.price)}`}
                  onClick={() => onDelete(a.id)}
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="alerts-add">
        <input
          ref={inputRef}
          className="alerts-add__input"
          data-testid="alerts-add-input"
          type="number"
          step="any"
          min="0"
          placeholder={`level ${refPx !== null ? `(mid ${fmtPx(Number(refPx.toFixed(decimals)))})` : ''}`}
          aria-label="new alert price"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <button
          type="button"
          className="alerts-add__go"
          data-testid="alerts-add-go"
          disabled={!Number.isFinite(Number(draft)) || draft === ''}
          onClick={submit}
        >
          add
        </button>
      </div>
    </section>
  );
}
