/**
 * ChartLegend tests (CP4): the swatch row renders all four price-family keys
 * with the SAME colors the chart paints (palette.ts is the single source of
 * truth), and the legend is non-interactive chrome.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it } from 'vitest';

import { OVERLAY, applyOverlayPalette } from '../gl/overlays/palette';
import { ChartLegend } from './ChartLegend';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

function render(): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(<ChartLegend />);
  });
  return container;
}

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe('ChartLegend', () => {
  it('renders the four price-family keys in English', () => {
    const el = render().querySelector('[data-testid="chart-legend"]') as HTMLElement;
    expect(el).not.toBeNull();
    const labels = [...el.querySelectorAll('.chart-legend__label')].map((n) => n.textContent);
    expect(labels).toEqual(['Last price', 'VWAP', 'BBO', 'Trades']);
    expect(el.getAttribute('aria-label')).toContain('last price');
  });

  it('paints the swatches from the chart palette (cannot drift from the lines)', () => {
    const el = render().querySelector('[data-testid="chart-legend"]') as HTMLElement;
    const lineSwatches = [...el.querySelectorAll('[data-swatch="line"]')] as HTMLElement[];
    const pairSwatches = [...el.querySelectorAll('[data-swatch="pair"] .chart-legend__line')] as HTMLElement[];
    const dotSwatches = [...el.querySelectorAll('[data-swatch="dots"] .chart-legend__dot')] as HTMLElement[];

    expect(lineSwatches).toHaveLength(2); // last price + vwap
    expect(lineSwatches[0].getAttribute('style')).toContain('245'); // OVERLAY.price
    expect(lineSwatches[1].getAttribute('style')).toContain('196'); // OVERLAY.vwap
    expect(pairSwatches).toHaveLength(2);
    expect(pairSwatches[0].getAttribute('style')).toContain('31'); // OVERLAY.bid teal
    expect(pairSwatches[1].getAttribute('style')).toContain('224'); // OVERLAY.ask red
    expect(dotSwatches).toHaveLength(2);
    expect(dotSwatches[0].getAttribute('style')).toContain('31'); // buy
    expect(dotSwatches[1].getAttribute('style')).toContain('224'); // sell
    // Sanity: the assertions above track the LIVE palette values, not literals.
    expect(OVERLAY.bid.css).toContain('31');
    expect(OVERLAY.ask.css).toContain('224');
  });

  it('is non-interactive chrome (role=img, no buttons/links)', () => {
    const el = render().querySelector('[data-testid="chart-legend"]') as HTMLElement;
    expect(el.getAttribute('role')).toBe('img');
    expect(el.querySelector('button, a, [tabindex]')).toBeNull();
  });

  it('re-reads the palette after a theme switch (R2-M3: no module-load drift)', () => {
    const el = render();
    const bidBefore = el
      .querySelector('[data-swatch="pair"] .chart-legend__line')!
      .getAttribute('style');
    // Simulate the theme bridge's in-place palette rewrite, then re-render.
    applyOverlayPalette({
      bg: '#000000',
      grid: '#111111',
      text: '#ffffff',
      bid: '#123456',
      ask: '#654321',
      accent: '#abcdef',
    });
    try {
      act(() => root!.render(<ChartLegend />));
      const bidAfter = el
        .querySelector('[data-swatch="pair"] .chart-legend__line')!
        .getAttribute('style');
      expect(bidAfter).not.toBe(bidBefore);
      expect(bidAfter).toContain('18'); // 0x12 = 18
    } finally {
      applyOverlayPalette(null); // restore the midnight literals byte-for-byte
    }
  });
});
