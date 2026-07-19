import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it } from 'vitest';

import { useFlowMapStore } from '../state/store';
import { ClosedBanner, formatCountdown } from './ClosedBanner';

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
  mounted.push({ container, root });
  return { container, root };
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  act(() => {
    useFlowMapStore.setState({ feedState: null, nextOpenTs: null });
  });
});

describe('formatCountdown (§7.1 closed-market countdown)', () => {
  it('formats sub-day spans as HH:MM:SS with zero padding', () => {
    expect(formatCountdown(0)).toBe('00:00:00');
    expect(formatCountdown(1_000)).toBe('00:00:01');
    expect(formatCountdown(65_000)).toBe('00:01:05');
    expect(formatCountdown((2 * 3600 + 3 * 60 + 4) * 1000)).toBe('02:03:04');
    expect(formatCountdown((23 * 3600 + 59 * 60 + 59) * 1000)).toBe('23:59:59');
  });

  it('prefixes whole days for a weekend-length gap', () => {
    // 2 days + 17:30:05 — a Friday-night-to-Monday-open span.
    const ms = (2 * 86_400 + 17 * 3600 + 30 * 60 + 5) * 1000;
    expect(formatCountdown(ms)).toBe('2d 17:30:05');
    expect(formatCountdown(86_400 * 1000)).toBe('1d 00:00:00');
  });

  it('floors sub-second remainders (no rounding up)', () => {
    expect(formatCountdown(1_999)).toBe('00:00:01');
    expect(formatCountdown(999)).toBe('00:00:00');
  });

  it('reads 00:00:00 for non-positive or non-finite spans', () => {
    expect(formatCountdown(-5_000)).toBe('00:00:00');
    expect(formatCountdown(Number.NaN)).toBe('00:00:00');
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe('00:00:00');
  });
});

describe('ClosedBanner accessibility (single announcement of closed state)', () => {
  it('renders nothing on the open / crypto path', () => {
    act(() => {
      useFlowMapStore.setState({ feedState: 'live', nextOpenTs: null });
    });
    const { container } = render(<ClosedBanner />);
    expect(container.querySelector('[data-testid="closed-banner"]')).toBeNull();
  });

  it('gives the status region a stable aria-label so it announces once', () => {
    act(() => {
      // Two days out — a weekend gap; countdown span is present.
      const openMs = Date.now() + 2 * 86_400 * 1000;
      useFlowMapStore.setState({
        feedState: 'closed',
        nextOpenTs: BigInt(openMs) * 1_000_000n,
      });
    });
    const { container } = render(<ClosedBanner />);

    const banner = container.querySelector('[data-testid="closed-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('role')).toBe('status');
    // Stable label => the closed state announces once, not per-tick text.
    expect(banner?.getAttribute('aria-label')).toBe('Market closed');
  });

  it('silences the 1 Hz countdown from screen-reader re-announcement', () => {
    act(() => {
      const openMs = Date.now() + 2 * 86_400 * 1000;
      useFlowMapStore.setState({
        feedState: 'closed',
        nextOpenTs: BigInt(openMs) * 1_000_000n,
      });
    });
    const { container } = render(<ClosedBanner />);

    const countdown = container.querySelector('[data-testid="closed-countdown"]');
    expect(countdown).not.toBeNull();
    // aria-live='off' stops the per-second re-announcement of the ticking value.
    expect(countdown?.getAttribute('aria-live')).toBe('off');
  });
});
