/**
 * First-run onboarding (lane CE) — a 3-step welcome wizard (ported from the
 * old-branch ui/Onboarding, re-scoped to the contract's 3 steps and re-worded
 * through i18n):
 *   1. Connect a market (symbol search + Live/Replay).
 *   2. Mouse & keys basics (drag/wheel, arrows, +/-, F).
 *   3. Where every shortcut lives (`?`) — plus the `T` theme cycle.
 *
 * Persistence is deliberate, not incidental: ONLY `Skip` and the final
 * `Done` write `flowmap.onboarded=1` (dismissed forever). Escape and the
 * scrim merely CLOSE — a stray key never silently suppresses the tour, it
 * returns on the next launch (old-branch honesty culture).
 *
 * Modal contract mirrors ShortcutsOverlay: nothing renders while closed; an
 * Escape window listener exists only while open; focus moves to the panel on
 * open, is TRAPPED inside it while open (Tab wraps both directions, WCAG
 * 2.4.3), and the previously focused element is restored on close.
 *
 * Re-open any time (INT can wire it to a SettingsDrawer button later) via
 * the exported {@link openOnboarding}. All copy goes through i18n (C7).
 */

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';

import { useT } from '../i18n/useT';
import { isTopOverlay, pushOverlay } from './overlayStack';
import '../theme/shell.css';

/** localStorage flag marking the tour as dismissed ('1'). */
export const ONBOARDING_KEY = 'flowmap.onboarded';

/** True iff the tour was explicitly dismissed (Skip or Done). */
export function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === '1';
  } catch {
    return false; /* storage unavailable — treat as never seen */
  }
}

/** Persist the dismissal; best-effort, swallowing blocked-storage errors. */
export function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, '1');
  } catch {
    /* QuotaExceededError / private mode — the tour simply shows again */
  }
}

/* ------------------------------------------------- open state (module) */

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function setOpen(value: boolean): void {
  if (value !== open) {
    open = value;
    emit();
  }
}

export function isOnboardingOpen(): boolean {
  return open;
}

export function subscribeOnboarding(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Re-open the tour (e.g. a "Show tour" item in the settings drawer). */
export function openOnboarding(): void {
  setOpen(true);
}

/** Close without persisting (what Esc and the scrim do). */
export function closeOnboarding(): void {
  setOpen(false);
}

/* ------------------------------------------------------------- content */

export interface OnboardStep {
  titleKey: string;
  bodyKey: string;
}

/** The three steps, in reading order. Keys resolve through i18n (C7). */
export const ONBOARDING_STEPS: readonly OnboardStep[] = [
  { titleKey: 'onboarding.step.connect.title', bodyKey: 'onboarding.step.connect.body' },
  { titleKey: 'onboarding.step.mouse.title', bodyKey: 'onboarding.step.mouse.body' },
  { titleKey: 'onboarding.step.shortcuts.title', bodyKey: 'onboarding.step.shortcuts.body' },
];

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/* ----------------------------------------------------------- component */

export function OnboardingCard(): JSX.Element | null {
  const t = useT();
  const isOpen = useSyncExternalStore(subscribeOnboarding, isOnboardingOpen);
  const [step, setStep] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();

  // First run: show the tour automatically (nothing persisted yet).
  useEffect(() => {
    if (!hasSeenOnboarding()) openOnboarding();
  }, []);

  // Fresh steps every time the card opens (reopen must not resume step 2/3).
  useEffect(() => {
    if (isOpen) setStep(0);
  }, [isOpen]);

  // Modal focus management (WCAG 2.4.3): capture the opener, move focus to
  // the panel, restore it on close via cleanup.
  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => opener?.focus?.();
  }, [isOpen]);

  // Escape DEFERS the tour — it closes but never persists. The listener
  // exists only while the overlay is open, and the tour joins the open-overlay
  // registry while it does (ui/overlayStack): when a Settings drawer opened it
  // (or sits underneath), ONE keystroke closes only the topmost surface — the
  // drawer's own window listener defers to whoever pushed later (QA12 M-1).
  useEffect(() => {
    if (!isOpen) return;
    const off = pushOverlay('onboard');
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isTopOverlay('onboard')) {
        closeOnboarding();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      off();
    };
  }, [isOpen]);

  // Focus trap: Tab wraps inside the panel in both directions.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || !isOpen) return;
    const onTab = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener('keydown', onTab);
    return () => panel.removeEventListener('keydown', onTab);
  }, [isOpen]);

  if (!isOpen) return null;

  const total = ONBOARDING_STEPS.length;
  const onLast = step === total - 1;
  const stepKeys = ONBOARDING_STEPS[step];

  // Only these two paths persist — scrim and Escape deliberately do not.
  const handleSkip = (): void => {
    markOnboarded();
    closeOnboarding();
  };
  const handleNext = (): void => {
    if (onLast) {
      markOnboarded();
      closeOnboarding();
    } else {
      setStep(step + 1);
    }
  };

  return (
    <>
      <div className="onboard__scrim" onClick={closeOnboarding} data-testid="onboarding-scrim" />
      <div
        ref={panelRef}
        className="onboard"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        data-testid="onboarding-dialog"
      >
        <h2 className="onboard__title" id={headingId}>
          {t('onboarding.title')}
        </h2>
        <p className="onboard__step" data-testid="onboarding-step-of">
          {t('onboarding.stepOf', { current: step + 1, total })}
        </p>
        <h3 className="onboard__card-title">{t(stepKeys.titleKey)}</h3>
        <p className="onboard__body" data-testid="onboarding-body">
          {t(stepKeys.bodyKey)}
        </p>
        <div className="onboard__dots" aria-hidden="true">
          {ONBOARDING_STEPS.map((s, i) => (
            <span
              key={s.titleKey}
              className={i === step ? 'onboard__dot onboard__dot--on' : 'onboard__dot'}
            />
          ))}
        </div>
        <footer className="onboard__footer">
          <span className="onboard__hint">{t('onboarding.hint')}</span>
          <button
            type="button"
            className="onboard__btn"
            onClick={handleSkip}
            data-testid="onboarding-skip"
          >
            {t('onboarding.skip')}
          </button>
          <button
            type="button"
            className="onboard__btn onboard__btn--primary"
            onClick={handleNext}
            data-testid="onboarding-next"
          >
            {onLast ? t('onboarding.done') : t('onboarding.next')}
          </button>
        </footer>
      </div>
    </>
  );
}
