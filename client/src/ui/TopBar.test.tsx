import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useFlowMapStore } from '../state/store';
import type { SymbolSearchHandle } from './SymbolSearch';
import { TopBar, chipClass } from './TopBar';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- chipClass: fidelity routing (§7 honesty), not just channel -------------
describe('chipClass', () => {
  it('keeps real depth tiers on the plain depth accent', () => {
    expect(chipClass('L2')).toBe('cap cap--depth');
    expect(chipClass('L1')).toBe('cap cap--depth');
  });

  it('routes fabricated depth (SYNTH / SYNTH_PROFILE) to the amber ramp', () => {
    expect(chipClass('SYNTH')).toBe('cap cap--synth');
    expect(chipClass('SYNTH_PROFILE')).toBe('cap cap--synth');
  });

  it('flags low-fidelity tape POLL with a caution modifier but keeps TICK real', () => {
    expect(chipClass('TAPE TICK')).toBe('cap cap--tape');
    expect(chipClass('TAPE POLL')).toBe('cap cap--tape cap--caution');
  });

  it('flags inferred / absent side with caution but keeps EXCHANGE real', () => {
    expect(chipClass('SIDE EXCHANGE')).toBe('cap');
    expect(chipClass('SIDE INFERRED')).toBe('cap cap--caution');
    expect(chipClass('SIDE NA')).toBe('cap cap--caution');
  });
});

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
