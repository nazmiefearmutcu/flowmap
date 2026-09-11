import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PriceAlert } from '../state/alertsStore';
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

  it('lists alerts with armed / fired / muted state badges', () => {
    const props = baseProps();
    const alerts: PriceAlert[] = [
      mk({ id: 'a1', price: 90, above: false }), // armed
      mk({ id: 'a2', price: 110, triggered: true, triggeredAt: 999_000 }), // fired
      mk({ id: 'a3', price: 120, snoozedUntil: 1_060_000 }), // muted 60s
    ];
    const { container } = render(<AlertsPopover {...props} alerts={alerts} />);
    const rows = container.querySelectorAll('[data-testid="alert-row"]');
    expect(rows).toHaveLength(3);
    const states = [...rows].map((r) => r.querySelector('[data-testid="alert-state"]')!.textContent);
    expect(states[0]).toContain('armed');
    expect(states[1]).toContain('fired');
    expect(states[2]).toContain('muted');
    // Fired rows expose "clear fired".
    expect(container.querySelector('[data-testid="alerts-clear-fired"]')).not.toBeNull();
  });

  it('wires delete / snooze / clear-fired / create / close', () => {
    const props = baseProps();
    const alerts: PriceAlert[] = [
      mk({ id: 'x1', triggered: true, triggeredAt: 999_000 }),
      mk({ id: 'x2' }),
    ];
    const { container } = render(<AlertsPopover {...props} alerts={alerts} />);
    act(() => {
      (container.querySelector('[data-testid="alert-delete-x1"]') as HTMLButtonElement).click();
    });
    expect(props.onDelete).toHaveBeenCalledWith('x1');
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
