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

import { KEYSHEET } from './keysheet';

interface ShortcutsOverlayProps {
  onClose: () => void;
}

export function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes. Window-level so it works wherever focus sits inside the
  // overlay; stopPropagation keeps the drawer's own Escape handler out of the way.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
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
