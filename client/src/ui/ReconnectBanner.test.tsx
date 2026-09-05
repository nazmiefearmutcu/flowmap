/**
 * ReconnectBanner (A5) — truthful reconnect state. It renders ONLY while the
 * store's connection status is literally `reconnecting`, and it names the
 * market:symbol it is trying to reach. Live / connecting / idle render nothing —
 * a banner that guessed would be exactly the dishonesty this app refuses.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it } from 'vitest';

import { useFlowMapStore } from '../state/store';
import { ReconnectBanner } from './ReconnectBanner';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  useFlowMapStore.setState({ status: 'idle' });
});

function render(): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<ReconnectBanner />);
  });
  mounted.push({ container, root });
}

describe('ReconnectBanner', () => {
  it('renders nothing while live — only the reconnecting state earns a banner', () => {
    useFlowMapStore.setState({ status: 'live' });
    render();
    expect(document.body.querySelector('[data-testid="reconnect-banner"]')).toBeNull();
  });

  it('names the target and is announced politely while reconnecting', () => {
    useFlowMapStore.setState({
      status: 'reconnecting',
      subscription: {
        market: 'kraken',
        symbol: 'XBT/USD',
        mode: 'live',
      } as unknown as ReturnType<typeof useFlowMapStore.getState>['subscription'],
    });
    render();
    const el = document.body.querySelector('[data-testid="reconnect-banner"]');
    expect(el).not.toBeNull();
    expect(el!.getAttribute('role')).toBe('status');
    expect(el!.getAttribute('aria-live')).toBe('polite');
    expect(el!.textContent).toContain('kraken:XBT/USD');
    expect(el!.textContent).toContain('reconnecting');
  });
});
