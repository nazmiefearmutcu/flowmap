/**
 * HeatLegend depth-channel tests (fix 2026-09-10 F1-5): the legend must mirror
 * the channel the chart renders — divergent row + ask/bid caps in `imbalance`
 * mode, the density ramp labelled "bid depth"/"ask depth" in the side channels,
 * and the unchanged more/less sum legend by default. SYNTH honesty outranks
 * every setting.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RAMP_CLASSIC, RAMP_FLOW, RAMP_IMBALANCE, RAMP_SYNTH, RAMP_THEME, RAMP_THEME_SYNTH, rampCssGradient, rampCssGradientReversed } from '../gl/lut';
import { useFlowMapStore } from '../state/store';
import { setTheme, THEMES } from '../theme';
import { HeatLegend, legendForChannel } from './HeatLegend';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function mountLegend(colormap: 'theme' | 'flow' | 'inferno' | 'classic', channel: 'sum' | 'bid' | 'ask' | 'imbalance'): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<HeatLegend colormap={colormap} channel={channel} />);
  });
  mounted.push({ container, root });
  return container;
}

beforeEach(() => {
  // Real L2 tier, so the honesty SYNTH branch is off unless a test opts in.
  useFlowMapStore.setState({ capability: { depth: 'L2', replay: false } });
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  setTheme('midnight');
});

describe('legendForChannel (pure selection)', () => {
  it('sum keeps the colormap density ramp with more/less caps', () => {
    const l = legendForChannel('sum', 'flow', false);
    expect(l.row).toBe(RAMP_FLOW);
    expect(l.gradient).toBe(rampCssGradient(RAMP_FLOW));
    expect(l.topCap).toBe('more');
    expect(l.bottomCap).toBe('less');
    expect(l.channelNote).toBeNull();
  });

  it('imbalance uses the DIVERGENT row, flipped (ask-heavy blue on top)', () => {
    const l = legendForChannel('imbalance', 'flow', false);
    expect(l.row).toBe(RAMP_IMBALANCE);
    expect(l.topCap).toBe('ask-heavy');
    expect(l.bottomCap).toBe('bid-heavy');
    // Top of the bar = the ramp's t=0 ice-blue ask stop (last in the `to top`
    // list); its t=1 amber bid stop sits at the bottom — matching the chart.
    expect(l.gradient).toBe(rampCssGradientReversed(RAMP_IMBALANCE));
    expect(l.gradient.endsWith('rgb(148, 202, 255) 0.0%')).toBe(true);
    expect(l.gradient.startsWith('rgb(255, 206, 110) 100.0%')).toBe(true);
  });

  it('bid/ask keep the density ramp but label the channel', () => {
    expect(legendForChannel('bid', 'classic', false).channelNote).toBe('bid depth');
    expect(legendForChannel('ask', 'classic', false).channelNote).toBe('ask depth');
    expect(legendForChannel('bid', 'classic', false).row).toBe(RAMP_CLASSIC);
    expect(legendForChannel('ask', 'classic', false).topCap).toBe('more');
  });

  it('SYNTH honesty outranks the channel setting', () => {
    const l = legendForChannel('imbalance', 'flow', true);
    expect(l.row).toBe(RAMP_SYNTH);
    expect(l.topCap).toBe('more');
    expect(l.rampName).toBe('synthetic amber colormap');
  });

  it('theme + SYNTH paints the theme synth row, legacy keeps amber (R1-M2)', () => {
    const synthStops = THEMES.paper.chart.synth;
    const l = legendForChannel('sum', 'theme', true, undefined, synthStops);
    expect(l.row).toBe(RAMP_THEME_SYNTH);
    expect(l.rampName).toBe('synthetic theme colormap');
    expect(l.gradient.startsWith(`rgb(${synthStops[0].rgb.join(', ')}) 0.0%`)).toBe(true);
    // Legacy families never take the theme branch, even with synth stops handed in.
    const legacy = legendForChannel('imbalance', 'flow', true, undefined, synthStops);
    expect(legacy.row).toBe(RAMP_SYNTH);
    expect(legacy.gradient).toBe(rampCssGradient(RAMP_SYNTH));
  });

  it('theme mode paints the active theme density ramp (F6)', () => {
    const stops = THEMES.paper.chart.density;
    const l = legendForChannel('sum', 'theme', false, stops);
    expect(l.row).toBe(RAMP_THEME);
    expect(l.rampName).toBe('theme colormap');
    expect(l.gradient.startsWith(`rgb(${stops[0].rgb.join(', ')}) 0.0%`)).toBe(true);
    // Legacy families never take the theme branch, even with stops handed in.
    expect(legendForChannel('sum', 'flow', false, stops).row).toBe(RAMP_FLOW);
  });
});

describe('HeatLegend (mounted)', () => {
  it('imbalance: caps + aria-label switch to the divergent ask/bid copy', () => {
    const el = mountLegend('flow', 'imbalance');
    const legend = el.querySelector('[data-testid="heat-legend"]')!;
    expect(legend.getAttribute('data-channel')).toBe('imbalance');
    expect(legend.getAttribute('aria-label')).toContain('divergent imbalance');
    expect(legend.getAttribute('aria-label')).toContain('imbalance channel');
    const caps = legend.querySelectorAll('.heat-legend__cap');
    expect(caps[0].textContent).toBe('ask-heavy');
    expect(caps[1].textContent).toBe('bid-heavy');
    expect(legend.querySelector('[data-testid="heat-legend-bar"]')!.getAttribute('data-ramp')).toBe(
      String(RAMP_IMBALANCE),
    );
  });

  it('bid/ask: ramps stays, "bid depth"/"ask depth" note + aria per mode', () => {
    for (const channel of ['bid', 'ask'] as const) {
      const el = mountLegend('flow', channel);
      const legend = el.querySelector('[data-testid="heat-legend"]')!;
      expect(legend.getAttribute('aria-label')).toContain(`${channel} channel`);
      expect(legend.querySelector('[data-testid="heat-legend-channel"]')!.textContent).toBe(
        `${channel} depth`,
      );
      expect(legend.querySelector('[data-testid="heat-legend-bar"]')!.getAttribute('data-ramp')).toBe(
        String(RAMP_FLOW),
      );
    }
  });

  it('sum: unchanged more/less legend and aria (no channel note)', () => {
    const el = mountLegend('flow', 'sum');
    const legend = el.querySelector('[data-testid="heat-legend"]')!;
    const caps = legend.querySelectorAll('.heat-legend__cap');
    expect(caps[0].textContent).toBe('more');
    expect(caps[1].textContent).toBe('less');
    expect(legend.querySelector('[data-testid="heat-legend-channel"]')).toBeNull();
    expect(legend.getAttribute('aria-label')).toContain('flow colormap');
    expect(legend.getAttribute('aria-label')).not.toContain('channel');
  });

  it('theme mode: the bar follows the active theme ramp and re-ramps on switch (F6)', () => {
    setTheme('midnight');
    const el = mountLegend('theme', 'sum');
    const legend = el.querySelector('[data-testid="heat-legend"]')!;
    const bar = legend.querySelector('[data-testid="heat-legend-bar"]')!;
    expect(legend.getAttribute('aria-label')).toContain('theme colormap');
    expect(bar.getAttribute('data-ramp')).toBe(String(RAMP_THEME));
    // Midnight's density ramp is byte-identical to the FLOW stops at the source.
    expect(bar.getAttribute('style')).toContain('rgb(5, 8, 14) 0.0%');

    act(() => setTheme('paper'));
    expect(bar.getAttribute('style')).toContain('rgb(243, 241, 234) 0.0%');
    expect(bar.getAttribute('style')).not.toContain('rgb(5, 8, 14) 0.0%');
  });

  it('theme + SYNTH: the bar follows the active theme synth ramp (R1-M2)', () => {
    useFlowMapStore.setState({ capability: { depth: 'SYNTH_PROFILE', replay: false } });
    setTheme('paper');
    const el = mountLegend('theme', 'sum');
    const bar = el.querySelector('[data-testid="heat-legend-bar"]')!;
    expect(bar.getAttribute('data-ramp')).toBe(String(RAMP_THEME_SYNTH));
    const synth0 = THEMES.paper.chart.synth[0].rgb.join(', ');
    expect(bar.getAttribute('style')).toContain(`rgb(${synth0}) 0.0%`);
    expect(bar.getAttribute('style')).not.toContain(rampCssGradient(RAMP_SYNTH).split(', ')[0]);
  });
});
