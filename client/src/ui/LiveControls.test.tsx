/**
 * LiveControls chip tests (campaign 2026-09-11). There were NO tests for these
 * chips before (survey S4 §4 gap 1). Matrix covered here:
 *   - hidden while following + price tracking is on;
 *   - GO LIVE appears when time-follow is off, click routes to onGoLive;
 *   - TRACK PRICE appears when the price axis is locked, click routes to
 *     onTrackPrice; its tooltip tells the truth about the off-edge composite;
 *   - REPLAY mode renders nothing (no fake affordances — S4 D4).
 *
 * The component polls the renderer at 4 Hz; fake timers drive the poll.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Renderer } from '../gl/renderer';
import type { StreamMode } from '../proto/types';
import { LiveControls } from './LiveControls';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeRenderer {
  following: boolean;
  priceFollow: 'fit' | 'track' | 'off';
  liveEdgeVisible: boolean;
  timeline: () => null;
}

function fakeRenderer(init: Partial<FakeRenderer> = {}): FakeRenderer {
  return {
    following: true,
    priceFollow: 'track',
    liveEdgeVisible: true,
    timeline: () => null,
    ...init,
  };
}

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function render(
  node: JSX.Element,
): { container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  mounted.push({ container, root });
  return { container };
}

function poll(): void {
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

describe('LiveControls', () => {
  it('renders nothing while following with price tracking on', () => {
    const r = fakeRenderer();
    const { container } = render(
      <LiveControls
        rendererRef={{ current: r as unknown as Renderer }}
        onGoLive={vi.fn()}
        onTrackPrice={vi.fn()}
      />,
    );
    poll();
    expect(container.querySelector('[data-testid="live-controls"]')).toBeNull();
  });

  it('shows GO LIVE when time-follow is off and routes the click to onGoLive', () => {
    const r = fakeRenderer({ following: false });
    const onGoLive = vi.fn();
    const { container } = render(
      <LiveControls
        rendererRef={{ current: r as unknown as Renderer }}
        onGoLive={onGoLive}
        onTrackPrice={vi.fn()}
      />,
    );
    poll();
    const chip = container.querySelector('[data-testid="chip-go-live"]');
    expect(chip).not.toBeNull();
    expect(container.querySelector('[data-testid="chip-track-price"]')).toBeNull();
    click(chip!);
    expect(onGoLive).toHaveBeenCalledOnce();
  });

  it('shows TRACK PRICE when the price axis is locked; click routes to onTrackPrice', () => {
    const r = fakeRenderer({ priceFollow: 'off' });
    const onTrackPrice = vi.fn();
    const { container } = render(
      <LiveControls
        rendererRef={{ current: r as unknown as Renderer }}
        onGoLive={vi.fn()}
        onTrackPrice={onTrackPrice}
      />,
    );
    poll();
    const chip = container.querySelector('[data-testid="chip-track-price"]');
    expect(chip).not.toBeNull();
    // Edge visible: the plain tooltip (a recentre only).
    expect(chip!.getAttribute('title')).toBe('Resume price tracking (keeps your zoom)');
    click(chip!);
    expect(onTrackPrice).toHaveBeenCalledOnce();
  });

  it('tooltip tells the truth when the live edge is off-screen (the composite also returns live)', () => {
    const r = fakeRenderer({ priceFollow: 'off', liveEdgeVisible: false });
    const { container } = render(
      <LiveControls
        rendererRef={{ current: r as unknown as Renderer }}
        onGoLive={vi.fn()}
        onTrackPrice={vi.fn()}
      />,
    );
    poll();
    const chip = container.querySelector('[data-testid="chip-track-price"]');
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute('title')).toContain('return to the live edge');
  });

  it('renders NOTHING in replay mode — no GO LIVE / TRACK PRICE fake affordances (S4 D4)', () => {
    const r = fakeRenderer({ following: false, priceFollow: 'off' });
    const { container } = render(
      <LiveControls
        rendererRef={{ current: r as unknown as Renderer }}
        onGoLive={vi.fn()}
        onTrackPrice={vi.fn()}
        mode={'replay' as StreamMode}
      />,
    );
    poll();
    expect(container.querySelector('[data-testid="live-controls"]')).toBeNull();
    expect(container.querySelector('[data-testid="chip-go-live"]')).toBeNull();
    expect(container.querySelector('[data-testid="chip-track-price"]')).toBeNull();
  });
});
