/**
 * The `?` shortcuts overlay (A5) — a small centred modal listing every real
 * binding, from the same {@link KEYSHEET} the settings drawer renders. Toggled
 * by the App-level `?` handler (see ui/keysheet.ts `isHelpToggle`), it is a
 * proper dialog: `role="dialog"` + `aria-modal`, focus moves to the close
 * button on open and returns to the opener on close, Tab is trapped inside,
 * and Escape (or clicking the backdrop) dismisses it.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { isTopOverlay, pushOverlay } from './overlayStack';
import { KEYSHEET, isHelpToggle } from './keysheet';
import { classifyTarget } from '../input/keys';

interface ShortcutsOverlayProps {
  onClose: () => void;
}

export function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // The overlay joins the open-overlay registry while mounted: window-level
  // Escape handlers elsewhere (settings drawer) defer to whichever surface is
  // topmost, so one Escape closes only this overlay — never both at once.
  useEffect(() => pushOverlay('shortcuts'), []);

  // Escape closes, and `?` toggles (the footer says so) — window-level so both
  // work wherever focus sits inside the overlay. Being registry-topmost is what
  // lets this handler act without also firing the drawer's Escape handler.
  // `?` shares the App-level predicate (isHelpToggle): a '?' typed into an
  // editable is a character, not a toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!isTopOverlay('shortcuts')) return;
      const ctx = classifyTarget(e.target);
      if (e.key === 'Escape' || isHelpToggle(e.key, ctx)) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Modal focus management, same contract as SettingsDrawer: capture the opener,
  // move focus inside on open, restore it on close (WCAG 2.4.3).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // Trap Tab / Shift+Tab within the overlay while it is open.
  const onTrapKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="keyshelp__backdrop"
      data-testid="shortcuts-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="keyshelp"
        role="dialog"
        aria-modal="true"
        aria-label="keyboard shortcuts"
        data-testid="shortcuts-overlay"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onTrapKeyDown}
      >
        <header className="keyshelp__head">
          <span className="keyshelp__title">Keyboard shortcuts</span>
          <button
            ref={closeRef}
            type="button"
            className="keyshelp__close"
            onClick={onClose}
            data-testid="shortcuts-close"
            aria-label="close shortcuts"
          >
            ✕
          </button>
        </header>
        <div className="keysheet keyshelp__sheet" data-testid="shortcuts-list">
          {KEYSHEET.map((entry) => (
            <div key={entry.keys} className="keysheet__row">
              <kbd className="keysheet__keys">{entry.keys}</kbd>
              <span className="keysheet__action">{entry.action}</span>
            </div>
          ))}
        </div>
        <div className="keyshelp__foot">
          <span>
            <kbd>?</kbd> toggle · <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
