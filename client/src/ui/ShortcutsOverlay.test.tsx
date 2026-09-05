/**
 * ShortcutsOverlay (A5) — the `?` dialog. Pinned: it is a proper dialog
 * (role/aria-modal), Escape closes it, Tab is trapped inside, and the shared
 * `isHelpToggle` routing never fires while typing or inside another dialog.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isHelpToggle, KEYSHEET } from './keysheet';
import { ShortcutsOverlay } from './ShortcutsOverlay';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
});

function render(): { container: HTMLElement; onClose: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const onClose = vi.fn();
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<ShortcutsOverlay onClose={onClose} />);
  });
  mounted.push({ container, root });
  return { container, onClose };
}

function overlay(): HTMLElement | null {
  return document.body.querySelector('[data-testid="shortcuts-overlay"]');
}

describe('isHelpToggle — the `?` routing decision', () => {
  it('fires on `?` from a plain target', () => {
    expect(isHelpToggle('?', { editable: false, dialog: false })).toBe(true);
  });

  it('never fires while typing or while a dialog owns the keyboard', () => {
    expect(isHelpToggle('?', { editable: true, dialog: false })).toBe(false);
    expect(isHelpToggle('?', { editable: false, dialog: true })).toBe(false);
    // And plain `/` (no shift) is the palette shortcut, not the help toggle.
    expect(isHelpToggle('/', { editable: false, dialog: false })).toBe(false);
  });
});

describe('ShortcutsOverlay', () => {
  it('renders a modal dialog listing the shared keysheet', () => {
    render();
    const el = overlay();
    expect(el).not.toBeNull();
    expect(el!.getAttribute('role')).toBe('dialog');
    expect(el!.getAttribute('aria-modal')).toBe('true');
    const rows = document.body.querySelectorAll('[data-testid="shortcuts-list"] .keysheet__row');
    expect(rows.length).toBe(KEYSHEET.length);
    // The sheet is the SHARED source of truth: it names the `?` toggle itself.
    expect(el!.textContent).toContain('toggle this shortcuts overlay');
  });

  it('moves focus to its close button and Escape closes', () => {
    const { onClose } = render();
    expect(document.activeElement).toBe(
      document.body.querySelector('[data-testid="shortcuts-close"]'),
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab inside the dialog', () => {
    render();
    const closeBtn = document.body.querySelector(
      '[data-testid="shortcuts-close"]',
    ) as HTMLButtonElement;
    // Tab from the LAST focusable wraps to the FIRST.
    act(() => {
      const rows = [...document.body.querySelectorAll<HTMLElement>('.keyshelp button, .keyshelp [href]')];
      rows[rows.length - 1].focus();
      closeBtn.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
    });
    const firstInPanel = document.body.querySelector<HTMLElement>('.keyshelp button');
    expect(document.activeElement).toBe(firstInPanel);
  });
});
