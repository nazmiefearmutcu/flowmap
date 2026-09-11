/**
 * ReconnectBanner (A5) — truthful reconnect state. It renders ONLY while the
 * store's connection status is literally `reconnecting`, and it names the
 * market:symbol it is trying to reach. Live / connecting / idle render nothing —
 * a banner that guessed would be exactly the dishonesty this app refuses.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '../i18n';
import { useFlowMapStore } from '../state/store';
import { ReconnectBanner, closeReasonText } from './ReconnectBanner';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  setLocale('en');
  useFlowMapStore.setState({ status: 'idle', lastClose: null, reconnectAttempts: 0 });
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

describe('closeReasonText', () => {
  it('spells the codes the server actually sends, honestly', () => {
    expect(closeReasonText(null)).toBe('connection dropped');
    expect(closeReasonText({ code: 1001, wasClean: true })).toBe('server shut down');
    expect(closeReasonText({ code: 1000, wasClean: true })).toBe('server closed the session');
    expect(closeReasonText({ code: 1013, wasClean: true })).toBe('server overloaded');
    expect(closeReasonText({ code: null, wasClean: false })).toBe('connection dropped');
    expect(closeReasonText({ code: 1006, wasClean: false })).toBe('connection dropped');
    expect(closeReasonText({ code: 4321, wasClean: true })).toBe('server closed (code 4321)');
  });
});

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

  it('shows the close reason and the attempt count (calm, one line)', () => {
    useFlowMapStore.setState({
      status: 'reconnecting',
      lastClose: { code: 1001, wasClean: true },
      reconnectAttempts: 3,
    });
    render();
    const el = document.body.querySelector('[data-testid="reconnect-banner"]');
    expect(el!.textContent).toContain('server shut down');
    expect(el!.textContent).toContain('attempt 3');
  });

  it('retry-now fires exactly one retry (the store action)', () => {
    const retryNow = vi.fn();
    useFlowMapStore.setState({ status: 'reconnecting', retryNow });
    render();
    const btn = document.body.querySelector('[data-testid="reconnect-retry"]');
    expect(btn).not.toBeNull();
    act(() => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(retryNow).toHaveBeenCalledTimes(1);
  });

  it('translates the framing strings in TR while the reason keeps its own translation', () => {
    setLocale('tr');
    useFlowMapStore.setState({
      status: 'reconnecting',
      lastClose: { code: 1001, wasClean: true },
      reconnectAttempts: 3,
      subscription: {
        market: 'kraken',
        symbol: 'XBT/USD',
        mode: 'live',
      } as unknown as ReturnType<typeof useFlowMapStore.getState>['subscription'],
    });
    render();
    const el = document.body.querySelector('[data-testid="reconnect-banner"]')!;
    expect(el.textContent).toContain('bağlantı koptu');
    expect(el.textContent).toContain('kraken:XBT/USD');
    expect(el.textContent).toContain('için yeniden bağlanılıyor');
    expect(el.textContent).toContain('sunucu kapatıldı');
    expect(el.textContent).toContain('deneme 3');
    const btn = el.querySelector('[data-testid="reconnect-retry"]')!;
    expect(btn.textContent).toBe('Yeniden dene');
    expect(btn.getAttribute('title')).toBe('beklemeden hemen yeniden bağlan');
  });

  it('names the fallback target through the EN table (byte-identical fallback)', () => {
    useFlowMapStore.setState({
      status: 'reconnecting',
      subscription: undefined,
      reconnectAttempts: 0,
    });
    render();
    const el = document.body.querySelector('[data-testid="reconnect-banner"]')!;
    expect(el.textContent).toContain('reconnecting to the feed');
  });
});
