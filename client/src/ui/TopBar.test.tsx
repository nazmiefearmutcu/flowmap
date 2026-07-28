import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useFlowMapStore } from '../state/store';
import type { SymbolSearchHandle } from './SymbolSearch';
import { TopBar } from './TopBar';
import { capabilityChipClass } from './symbols';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- component rendering ----------------------------------------------------
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

function noop() {
  /* no-op */
}

function topbar(streamClock: string | null = null): JSX.Element {
  return (
    <TopBar
      ref={{ current: null } as unknown as React.Ref<SymbolSearchHandle>}
      onSelectSymbol={noop}
      onSetMode={noop}
      railVisible={false}
      onToggleRail={noop}
      onOpenSettings={noop}
      streamClock={streamClock}
    />
  );
}

beforeEach(() => {
  useFlowMapStore.setState({ capability: null, subscription: undefined, feedState: undefined });
});

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('TopBar capability badges', () => {
  it('renders a neutral placeholder (not NO CAPS) while capability is null (pre-Hello)', () => {
    const { container } = render(topbar());
    const caps = container.querySelector('[data-testid="capability-badges"]')!;
    expect(caps.textContent).not.toContain('NO CAPS');
    expect(caps.querySelector('.cap--pending')).not.toBeNull();
  });

  it('renders NO CAPS only for a received-but-empty descriptor', () => {
    act(() => useFlowMapStore.setState({ capability: {} }));
    const { container } = render(topbar());
    const caps = container.querySelector('[data-testid="capability-badges"]')!;
    expect(caps.textContent).toContain('NO CAPS');
    expect(caps.querySelector('.cap--pending')).toBeNull();
  });

  it('routes a SYNTH depth descriptor to the amber chip', () => {
    act(() =>
      useFlowMapStore.setState({ capability: { depth: 'synth', tape: 'poll', trade_side: 'na' } }),
    );
    const { container } = render(topbar());
    const caps = container.querySelector('[data-testid="capability-badges"]')!;
    expect(caps.querySelector('.cap--synth')).not.toBeNull();
    expect(caps.querySelector('.cap--caution')).not.toBeNull();
  });

  it('badges a ccxt venue’s snapshot depth distinctly and explains it on hover', () => {
    act(() => useFlowMapStore.setState({ capability: { depth: 'L2-snapshot', tape: 'tick' } }));
    const { container } = render(topbar());
    const depth = container.querySelector('[data-testid="capability-badges"] .cap--depth')!;
    expect(depth.textContent).toBe('L2-SNAPSHOT');
    // Same accent as a real depth tier, plus the caution step-down.
    expect(depth.classList.contains('cap--caution')).toBe(true);
    expect(depth.getAttribute('title')).toContain('re-read');
  });

  it('gives ABSENT depth (finnhub `N/A`) its own tier, not the real-depth accent', () => {
    act(() =>
      useFlowMapStore.setState({ capability: { depth: 'N/A', tape: 'tick', trade_side: 'inferred' } }),
    );
    const { container } = render(topbar());
    const caps = container.querySelector('[data-testid="capability-badges"]')!;
    const depth = [...caps.querySelectorAll('.cap')].find((el) => el.textContent === 'N/A')!;
    expect(depth).toBeDefined();
    expect(depth.classList.contains('cap--depth')).toBe(false);
    expect(depth.classList.contains('cap--na')).toBe(true);
    expect(depth.getAttribute('title')).toContain('no depth');
  });

  // The top bar and the symbol palette must make the SAME fidelity claim for the
  // same string — one exported classifier, two surfaces (§7). Rendering (not just
  // calling the helper) is what pins it: a re-introduced local copy fails here.
  it.each([
    ['L2', 'tick', 'exchange'],
    ['L2-snapshot', 'tick', 'exchange'],
    ['L1', 'tick', 'inferred'],
    ['SYNTH', 'poll', 'na'],
    ['SYNTH_PROFILE', 'poll', 'na'],
    ['N/A', 'tick', 'inferred'],
  ])('renders %s through the shared capabilityChipClass', (depth, tape, side) => {
    act(() => useFlowMapStore.setState({ capability: { depth, tape, trade_side: side } }));
    const { container } = render(topbar());
    const caps = container.querySelector('[data-testid="capability-badges"]')!;
    for (const el of caps.querySelectorAll('.cap')) {
      expect(el.className).toBe(capabilityChipClass(el.textContent ?? ''));
    }
  });
});

describe('TopBar venue chip (~106 venues — the asset class is no longer an address)', () => {
  it('names the crypto venue actually subscribed, not just "Crypto"', () => {
    act(() =>
      useFlowMapStore.setState({ subscription: { market: 'binance-usdm', symbol: 'BTCUSDT', mode: 'live', band: 'native' } }),
    );
    const { container } = render(topbar());
    const venue = container.querySelector('[data-testid="venue"]')!;
    expect(venue.textContent).toContain('binance-usdm');
    expect(venue.textContent).toContain('BTCUSDT');
    // Still colour-coded by asset class.
    expect(venue.classList.contains('venue--crypto')).toBe(true);
    expect(venue.getAttribute('title')).toContain('crypto');
  });

  it('keeps the group word for equity and sim, where the group IS the venue', () => {
    act(() => useFlowMapStore.setState({ subscription: { market: 'equity', symbol: 'AAPL', mode: 'live', band: 'native' } }));
    const { container } = render(topbar());
    const venue = container.querySelector('[data-testid="venue"]')!;
    expect(venue.textContent).toContain('Equity');
    expect(venue.classList.contains('venue--equity')).toBe(true);
  });

  it('defaults to the sim venue with no subscription', () => {
    const { container } = render(topbar());
    const venue = container.querySelector('[data-testid="venue"]')!;
    expect(venue.textContent).toContain('Sim');
    expect(venue.textContent).toContain('SIM-DEMO');
  });
});

describe('TopBar clock + status a11y', () => {
  it('labels the wall zone and marks the stream row UTC', () => {
    const { container } = render(topbar('12:00:00'));
    const clock = container.querySelector('[data-testid="clock"]')!;
    expect(clock.querySelector('.clock__zone')).not.toBeNull();
    expect(clock.querySelector('.clock__stream')!.textContent).toContain('UTC');
    expect(clock.getAttribute('aria-label')).toContain('UTC');
  });

  it('renders the stream placeholder as UTC when there is no stream clock', () => {
    const { container } = render(topbar(null));
    const stream = container.querySelector('.clock__stream')!;
    expect(stream.textContent).toContain('UTC');
  });

  it('announces connection status to assistive tech', () => {
    act(() => useFlowMapStore.setState({ feedState: 'degraded' }));
    const { container } = render(topbar());
    const status = container.querySelector('[data-testid="conn-status"]')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-label')).toContain('degraded');
  });
});

describe('TopBar settings button a11y', () => {
  it('marks the settings button as opening a dialog and uses a monochrome glyph', () => {
    const { container } = render(topbar());
    const btn = container.querySelector('[data-testid="settings-open"]')!;
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog');
    // The color-emoji gear (bare U+2699) is gone; the text-presentation form carries U+FE0E.
    expect(btn.textContent).not.toContain('⚙️');
    expect(btn.textContent).toContain('︎');
  });
});
