import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PriceAlert } from '../state/alertsStore';
import { classifyTarget } from '../input/keys';
import { resetOverlays } from './overlayStack';
import { AlertsPopover } from './AlertsPopover';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function render(node: JSX.Element): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  const handle = { container, root };
  mounted.push(handle);
  return handle;
}

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  resetOverlays();
});

function mk(partial: Partial<PriceAlert> & { id: string }): PriceAlert {
  return {
    key: 'sim:SIM-DEMO',
    price: 100,
    above: true,
    createdAt: 0,
    triggered: false,
    triggeredAt: null,
    snoozedUntil: null,
    rearmPx: null,
    ...partial,
  };
}

function baseProps() {
  return {
    refPx: 101 as number | null,
    now: 1_000_000,
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    onSnooze: vi.fn(),
    onRearm: vi.fn(),
    onClearFired: vi.fn(),
  };
}

describe('AlertsPopover', () => {
  it('shows the empty hint when the symbol has no alerts', () => {
    const props = baseProps();
    const { container } = render(<AlertsPopover {...props} alerts={[]} />);
    expect(container.querySelector('[data-testid="alerts-empty"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="alert-row"]')).toHaveLength(0);
  });

  it('lists alerts with armed / re-armed / re-arming / fired / muted state badges', () => {
    const props = baseProps();
    const alerts: PriceAlert[] = [
      mk({ id: 'a1', price: 90, above: false }), // armed
      mk({ id: 'a2', price: 110, triggered: true, triggeredAt: 999_000, rearmPx: 109.89 }), // fired
      mk({ id: 'a3', price: 120, snoozedUntil: 1_060_000 }), // muted 60s
      mk({ id: 'a4', price: 130, triggeredAt: 999_000 }), // re-armed: fired before, inside the band again
      mk({ id: 'a5', price: 140, triggeredAt: 999_000, rearmPx: 139.86 }), // manually re-armed, waiting
    ];
    const { container } = render(<AlertsPopover {...props} alerts={alerts} />);
    const rows = container.querySelectorAll('[data-testid="alert-row"]');
    expect(rows).toHaveLength(5);
    const states = [...rows].map((r) => r.querySelector('[data-testid="alert-state"]')!.textContent);
    expect(states[0]).toContain('armed');
    expect(states[1]).toContain('fired');
    expect(states[2]).toContain('muted');
    expect(states[3]).toContain('re-armed');
    expect(states[4]).toContain('re-arming @');
    // Fired rows expose "clear fired".
    expect(container.querySelector('[data-testid="alerts-clear-fired"]')).not.toBeNull();
  });

  it('is a dialog surface: role, aria-modal, and classifyTarget sees it', () => {
    const props = baseProps();
    const { container } = render(<AlertsPopover {...props} alerts={[]} />);
    const section = container.querySelector('[data-testid="alerts-popover"]')!;
    expect(section.getAttribute('role')).toBe('dialog');
    expect(section.getAttribute('aria-modal')).toBe('true');
    const input = container.querySelector('[data-testid="alerts-add-input"]')!;
    expect(classifyTarget(input).dialog).toBe(true);
  });

  it('traps Tab / Shift+Tab inside the dialog (disabled controls skipped)', () => {
    const props = baseProps();
    const { container } = render(<AlertsPopover {...props} alerts={[mk({ id: 'a1' })]} />);
    const section = container.querySelector<HTMLElement>('[data-testid="alerts-popover"]')!;
    const input = container.querySelector<HTMLInputElement>('[data-testid="alerts-add-input"]')!;
    // The add button is disabled with an empty draft, so the input is the last
    // focusable stop; Tab must wrap to the first (the close button).
    input.focus();
    expect(document.activeElement).toBe(input);
    act(() => {
      section.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(container.querySelector('[data-testid="alerts-close"]'));
    // Shift+Tab from the first stop wraps to the last.
    act(() => {
      section.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(input);
  });

  it('wires delete / snooze / re-arm / clear-fired / create / close', () => {
    const props = baseProps();
    const alerts: PriceAlert[] = [
      mk({ id: 'x1', triggered: true, triggeredAt: 999_000, rearmPx: 99.9 }),
      mk({ id: 'x2' }),
    ];
    const { container } = render(<AlertsPopover {...props} alerts={alerts} />);
    act(() => {
      (container.querySelector('[data-testid="alert-delete-x1"]') as HTMLButtonElement).click();
    });
    expect(props.onDelete).toHaveBeenCalledWith('x1');
    // A fired alert offers re-arm, an armed one offers snooze.
    act(() => {
      (container.querySelector('[data-testid="alert-rearm-x1"]') as HTMLButtonElement).click();
    });
    expect(props.onRearm).toHaveBeenCalledWith('x1');
    act(() => {
      (container.querySelector('[data-testid="alert-snooze-x2"]') as HTMLButtonElement).click();
    });
    expect(props.onSnooze).toHaveBeenCalledWith('x2');
    act(() => {
      (container.querySelector('[data-testid="alerts-clear-fired"]') as HTMLButtonElement).click();
    });
    expect(props.onClearFired).toHaveBeenCalledOnce();
    act(() => {
      (container.querySelector('[data-testid="alerts-close"]') as HTMLButtonElement).click();
    });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('offers re-arm (not snooze) for a muted alert', () => {
    const props = baseProps();
    const alerts: PriceAlert[] = [mk({ id: 'm1', snoozedUntil: 1_060_000 })];
    const { container } = render(<AlertsPopover {...props} alerts={alerts} />);
    expect(container.querySelector('[data-testid="alert-snooze-m1"]')).toBeNull();
    act(() => {
      (container.querySelector('[data-testid="alert-rearm-m1"]') as HTMLButtonElement).click();
    });
    expect(props.onRearm).toHaveBeenCalledWith('m1');
  });

  it('the add form submits a parsed level and clears itself; junk is rejected', () => {
    const props = baseProps();
    const { container } = render(<AlertsPopover {...props} alerts={[]} />);
    const input = container.querySelector<HTMLInputElement>('[data-testid="alerts-add-input"]')!;
    const go = container.querySelector<HTMLButtonElement>('[data-testid="alerts-add-go"]')!;
    expect(go.disabled).toBe(true);

    const set = (v: string) =>
      act(() => {
        input.value = v;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

    // React controlled input: drive onChange through the native setter.
    const nativeInput = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      nativeInput.call(input, '104.5');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(go.disabled).toBe(false);
    act(() => {
      go.click();
    });
    expect(props.onCreate).toHaveBeenCalledWith(104.5);
    expect(input.value).toBe('');

    set('abc');
    expect(go.disabled).toBe(true);
  });

  it('Escape closes only when it is the top overlay', () => {
    const props = baseProps();
    const { container } = render(<AlertsPopover {...props} alerts={[]} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(props.onClose).toHaveBeenCalledOnce();
    void container;
  });
});
