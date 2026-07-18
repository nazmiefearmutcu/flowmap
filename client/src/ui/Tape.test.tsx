import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SIDE_BUY, SIDE_SELL, SIDE_UNKNOWN, type EpochParams } from '../proto/types';
import { ingestForTest, resetForTest, type TapeTrade } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import {
  Tape,
  fmtTapeTime,
  largeThreshold,
  sideClass,
  tapeBadge,
} from './Tape';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PARAMS: EpochParams = {
  epoch: 1,
  tick: 0.5,
  tick_multiple: 1,
  dt_ns: 1_000_000,
  p0: 50,
  rows: 200,
};

function tapeTrade(size: number): TapeTrade {
  return { tsNs: 0n, price: 100, size, side: SIDE_BUY, venue: 'sim' };
}

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

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  resetForTest();
  useFlowMapStore.setState({ capability: null, epochs: new Map(), gridEpoch: null });
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  resetForTest();
});

describe('tapeBadge', () => {
  it('states the honest tape tier', () => {
    expect(tapeBadge({ tape: 'tick' })).toBe('TAPE TICK');
    expect(tapeBadge({ tape: 'poll' })).toBe('TAPE POLL');
    expect(tapeBadge({ tape: '10s' })).toBe('TAPE 10S');
    expect(tapeBadge(null)).toBe('TAPE');
  });
});

describe('sideClass', () => {
  it('maps aggressor side to a color class', () => {
    expect(sideClass(SIDE_BUY)).toBe('buy');
    expect(sideClass(SIDE_SELL)).toBe('sell');
    expect(sideClass(SIDE_UNKNOWN)).toBe('unknown');
  });
});

describe('largeThreshold', () => {
  it('is Infinity until there are enough samples', () => {
    expect(largeThreshold([tapeTrade(5)])).toBe(Number.POSITIVE_INFINITY);
  });

  it('is the p90 of the visible sizes once warmed up', () => {
    const trades = Array.from({ length: 12 }, (_, i) => tapeTrade(i + 1)); // sizes 1..12
    expect(largeThreshold(trades)).toBe(11); // idx floor(12*0.9)=10 → sizes[10]=11
  });
});

describe('fmtTapeTime', () => {
  it('formats ns as UTC HH:MM:SS.mmm', () => {
    // 1h 2m 3.004s in ns.
    const ns = BigInt((1 * 3600 + 2 * 60 + 3) * 1_000_000_000 + 4_000_000);
    expect(fmtTapeTime(ns)).toBe('01:02:03.004');
  });
});

describe('Tape render', () => {
  function seedStore(): void {
    useFlowMapStore.setState({
      capability: { depth: 'L2', tape: 'tick' },
      epochs: new Map([[1, PARAMS]]),
      gridEpoch: 1,
    });
  }

  it('lists trades newest-first, colored by side, with the TAPE TICK badge', () => {
    seedStore();
    ingestForTest({ type: 5, ts_ns: 1n, price: 100.0, size: 2, side: SIDE_BUY, side_src: 0, venue: 'sim' } as never);
    ingestForTest({ type: 5, ts_ns: 2n, price: 99.5, size: 3, side: SIDE_SELL, side_src: 0, venue: 'sim' } as never);
    ingestForTest({ type: 5, ts_ns: 3n, price: 100.5, size: 1, side: SIDE_UNKNOWN, side_src: 0, venue: 'sim' } as never);

    const { container } = render(<Tape />);
    expect(container.querySelector('[data-testid="tape-badge"]')?.textContent).toBe('TAPE TICK');

    const rows = Array.from(container.querySelectorAll('[data-testid="tape-row"]'));
    expect(rows).toHaveLength(3);
    // Newest first: the last-ingested (unknown, px 100.5) leads.
    expect(rows[0].getAttribute('data-side')).toBe('unknown');
    expect(rows[1].getAttribute('data-side')).toBe('sell');
    expect(rows[2].getAttribute('data-side')).toBe('buy');
    expect(rows[1].className).toContain('tape__row--sell');
    // Price precision from the epoch step (0.5 → 1 decimal).
    expect(rows[0].querySelector('.tape__px')?.textContent).toBe('100.5');
  });

  it('emphasizes large trades above the rolling threshold', () => {
    seedStore();
    for (let i = 1; i <= 12; i += 1) {
      ingestForTest({ type: 5, ts_ns: BigInt(i), price: 100, size: i, side: SIDE_BUY, side_src: 0, venue: 'sim' } as never);
    }
    ingestForTest({ type: 5, ts_ns: 99n, price: 100, size: 100, side: SIDE_BUY, side_src: 0, venue: 'sim' } as never);

    const { container } = render(<Tape />);
    const big = container.querySelector('[data-size="100.0000"]');
    const small = container.querySelector('[data-size="1.0000"]');
    expect(big?.getAttribute('data-large')).toBe('1');
    expect(big?.className).toContain('is-large');
    expect(small?.getAttribute('data-large')).toBe('0');
  });

  it('collapses the body via the header chevron', () => {
    seedStore();
    ingestForTest({ type: 5, ts_ns: 1n, price: 100, size: 2, side: SIDE_BUY, side_src: 0, venue: 'sim' } as never);
    const { container } = render(<Tape />);
    expect(container.querySelector('[data-testid="tape-body"]')).not.toBeNull();
    click(container.querySelector('[data-testid="tape-collapse"]')!);
    expect(container.querySelector('[data-testid="tape-body"]')).toBeNull();
  });
});
