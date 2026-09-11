import { afterEach, describe, expect, it } from 'vitest';

import { applyChartInk, applyOverlayPalette, OVERLAY, parseCssColor } from './palette';

/** Deep snapshot of the shipped (midnight) palette literals. */
function snapshot(): typeof OVERLAY {
  return JSON.parse(JSON.stringify(OVERLAY));
}

afterEach(() => {
  applyOverlayPalette(null);
  applyChartInk(null);
});

describe('overlay palette theme bridge', () => {
  it('restore (null) returns every entry to the exact shipped literals', () => {
    const before = snapshot();
    applyOverlayPalette({
      bg: '#f3f1ea',
      grid: '#d6d0c0',
      text: '#24272d',
      bid: '#0e7c72',
      ask: '#b3383d',
      accent: '#0a6158',
    });
    expect(snapshot()).not.toEqual(before); // the bridge actually rewrote values
    applyOverlayPalette(null);
    expect(snapshot()).toEqual(before);
  });

  it('midnight is pixel-identical: applying then restoring is a byte-level no-op', () => {
    // App never calls the bridge for the default theme, but even if it did with
    // midnight's registry literals, null-restore must land back on the literals.
    const before = snapshot();
    applyOverlayPalette({ bg: '#050709', grid: '#1a2030', text: '#e6edf3', bid: '#1fb6a6', ask: '#d3524f', accent: '#33d6c4' });
    applyOverlayPalette(null);
    expect(snapshot()).toEqual(before);
  });

  it('themes the semantic bid/ask pair and keeps categorical accents', () => {
    const vwapBefore = OVERLAY.vwap.css;
    applyOverlayPalette({
      bg: '#ffffff',
      grid: '#2b2b2b',
      text: '#000000',
      bid: '#00695f',
      ask: '#a52a1d',
      accent: '#004d45',
    });
    expect(OVERLAY.bid.css).toBe('rgba(0, 105, 95, 1)');
    expect(OVERLAY.buy.css).toBe('rgba(0, 105, 95, 1)');
    expect(OVERLAY.ask.css).toBe('rgba(165, 42, 29, 1)');
    expect(OVERLAY.sell.gl).toEqual([165 / 255, 42 / 255, 29 / 255, 0.95]);
    // Categorical accents are deliberately untouched.
    expect(OVERLAY.vwap.css).toBe(vwapBefore);
  });

  // CHART-INK BRIDGE (visual campaign 2026-09-11, L4): `applyOverlayPalette`
  // still only consumes bid/ask; the chart-ground ink (axis/grid/price family/
  // pill text/badge plate) is owned by `applyChartInk`, which is null-restorable
  // byte-for-byte like the semantic bridge.
  it('applyChartInk themes axis/grid/the price family/pill text/badge plate', () => {
    applyChartInk({
      ink: '#24272d',
      inkDim: '#57606c',
      grid: '#d6d0c0',
      axis: '#3a3f47',
      price: '#0e7c72',
      bg: '#f3f1ea',
      chipBg: '#fbfaf6',
    });
    expect(OVERLAY.axis.css).toBe('rgba(58, 63, 71, 1)');
    expect(OVERLAY.grid.css).toBe('rgba(214, 208, 192, 0.14)');
    expect(OVERLAY.price.css).toBe('rgba(14, 124, 114, 1)');
    expect(OVERLAY.priceGlow.css).toBe('rgba(14, 124, 114, 0.22)');
    expect(OVERLAY.priceLevel.css).toBe('rgba(14, 124, 114, 0.38)');
    expect(OVERLAY.pricePill.css).toBe('rgba(14, 124, 114, 0.95)');
    expect(OVERLAY.priceFillTop.css).toBe('rgba(14, 124, 114, 0.07)');
    expect(OVERLAY.priceFillBottom.css).toBe('rgba(14, 124, 114, 0)');
    expect(OVERLAY.pricePillText.css).toBe('rgba(243, 241, 234, 1)');
    expect(OVERLAY.badgeBg).toBe('rgba(251, 250, 246, 0.82)');
    // The GL twin follows the same ink, alphas preserved per entry.
    expect(OVERLAY.price.gl).toEqual([14 / 255, 124 / 255, 114 / 255, 0.98]);
    expect(OVERLAY.priceGlow.gl[3]).toBe(0.22);
    expect(OVERLAY.priceFillBottom.gl[3]).toBe(0);
  });

  it('applyChartInk maps grid alpha from gridAlpha when provided (L-4)', () => {
    applyChartInk({
      ink: '#24272d',
      inkDim: '#57606c',
      grid: '#5a6472',
      gridAlpha: 0.35,
      axis: '#3a3f47',
      price: '#0e7c72',
      bg: '#f3f1ea',
      chipBg: '#fbfaf6',
    });
    expect(OVERLAY.grid.css).toBe('rgba(90, 100, 114, 0.35)');
    expect(OVERLAY.grid.gl).toEqual([90 / 255, 100 / 255, 114 / 255, 0.35]);
    // Every other entry keeps its shipped alpha.
    expect(OVERLAY.axis.css).toBe('rgba(58, 63, 71, 1)');
    expect(OVERLAY.priceGlow.css).toBe('rgba(14, 124, 114, 0.22)');
  });

  it('omitting gridAlpha keeps the shipped 0.14 grid alpha (byte-identity)', () => {
    applyChartInk({
      ink: '#24272d',
      inkDim: '#57606c',
      grid: '#5a6472',
      axis: '#3a3f47',
      price: '#0e7c72',
      bg: '#f3f1ea',
      chipBg: '#fbfaf6',
    });
    expect(OVERLAY.grid.css).toBe('rgba(90, 100, 114, 0.14)');
    expect(OVERLAY.grid.gl[3]).toBe(0.14);
  });

  it('accepts (and ignores) the CSS-only sell/warn chart tokens (M-3)', () => {
    const sellBefore = OVERLAY.sell.css;
    const bidBefore = OVERLAY.bid.css;
    applyChartInk({
      ink: '#24272d',
      inkDim: '#57606c',
      grid: '#5a6472',
      gridAlpha: 0.35,
      axis: '#3a3f47',
      price: '#0e7c72',
      bg: '#f3f1ea',
      chipBg: '#fbfaf6',
      sell: '#99272c',
      warn: '#8a6410',
    });
    // No OVERLAY entry exists for these — the semantic sell channel is untouched.
    expect(OVERLAY.sell.css).toBe(sellBefore);
    expect(OVERLAY.bid.css).toBe(bidBefore);
  });

  it('applyChartInk(null) restores the exact shipped midnight literals', () => {
    const before = snapshot();
    applyChartInk({
      ink: '#24272d',
      inkDim: '#57606c',
      grid: '#d6d0c0',
      axis: '#3a3f47',
      price: '#0e7c72',
      bg: '#f3f1ea',
      chipBg: '#fbfaf6',
    });
    expect(snapshot()).not.toEqual(before); // it actually rewrote values
    applyChartInk(null);
    expect(snapshot()).toEqual(before);
    expect(OVERLAY.axis.css).toBe('rgba(163, 176, 194, 1)');
    expect(OVERLAY.grid.css).toBe('rgba(120, 132, 150, 0.14)');
    expect(OVERLAY.price.css).toBe('rgba(245, 248, 252, 1)');
    expect(OVERLAY.priceGlow.css).toBe('rgba(245, 248, 252, 0.22)');
    expect(OVERLAY.priceLevel.css).toBe('rgba(245, 248, 252, 0.38)');
    expect(OVERLAY.pricePill.css).toBe('rgba(245, 248, 252, 0.95)');
    expect(OVERLAY.priceFillTop.css).toBe('rgba(210, 225, 245, 0.07)');
    expect(OVERLAY.priceFillBottom.css).toBe('rgba(210, 225, 245, 0)');
    expect(OVERLAY.pricePillText.css).toBe('rgba(10, 14, 20, 1)');
    expect(OVERLAY.badgeBg).toBe('rgba(5, 8, 12, 0.82)');
  });

  it('applyChartInk skips unparseable fields (previous value stays)', () => {
    const priceBefore = OVERLAY.price.css;
    const gridBefore = OVERLAY.grid.css;
    const badgeBefore = OVERLAY.badgeBg;
    applyChartInk({
      ink: '#24272d',
      inkDim: '#57606c',
      grid: '#d6d0c0',
      axis: '#3a3f47',
      price: 'not-a-color',
      bg: '#f3f1ea',
      chipBg: 'also-junk',
    });
    expect(OVERLAY.price.css).toBe(priceBefore);
    expect(OVERLAY.grid.css).toBe('rgba(214, 208, 192, 0.14)'); // valid field still lands
    expect(OVERLAY.grid.css).not.toBe(gridBefore);
    expect(OVERLAY.badgeBg).toBe(badgeBefore);
  });

  it('applyChartInk does not touch bid/ask/buy/sell/categoricals', () => {
    applyOverlayPalette({
      bg: '#ffffff',
      grid: '#2b2b2b',
      text: '#000000',
      bid: '#00695f',
      ask: '#a52a1d',
      accent: '#004d45',
    });
    const untouched = {
      buy: OVERLAY.buy.css,
      sell: OVERLAY.sell.css,
      bid: OVERLAY.bid.css,
      ask: OVERLAY.ask.css,
      unknown: OVERLAY.unknown.css,
      vwap: OVERLAY.vwap.css,
      cvd: OVERLAY.cvd.css,
      profile: OVERLAY.profile.css,
      poc: OVERLAY.poc.css,
      liquidation: OVERLAY.liquidation.css,
      event: OVERLAY.event.css,
      gap: OVERLAY.gap.css,
    };
    applyChartInk({
      ink: '#24272d',
      inkDim: '#57606c',
      grid: '#d6d0c0',
      axis: '#3a3f47',
      price: '#0e7c72',
      bg: '#f3f1ea',
      chipBg: '#fbfaf6',
    });
    expect({
      buy: OVERLAY.buy.css,
      sell: OVERLAY.sell.css,
      bid: OVERLAY.bid.css,
      ask: OVERLAY.ask.css,
      unknown: OVERLAY.unknown.css,
      vwap: OVERLAY.vwap.css,
      cvd: OVERLAY.cvd.css,
      profile: OVERLAY.profile.css,
      poc: OVERLAY.poc.css,
      liquidation: OVERLAY.liquidation.css,
      event: OVERLAY.event.css,
      gap: OVERLAY.gap.css,
    }).toEqual(untouched);
    // The semantic bridge values survive a chart-ink write.
    expect(OVERLAY.bid.css).toBe('rgba(0, 105, 95, 1)');
    expect(OVERLAY.ask.css).toBe('rgba(165, 42, 29, 1)');
  });

  it('computed rgb()/rgba() strings parse; unknown strings are skipped safely', () => {
    expect(parseCssColor('rgb(31, 182, 166)')).toEqual([31, 182, 166, 1]);
    expect(parseCssColor('rgba(31, 182, 166, 0.5)')).toEqual([31, 182, 166, 0.5]);
    expect(parseCssColor('#1fb6a6')).toEqual([31, 182, 166, 1]);
    expect(parseCssColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseCssColor('not-a-color')).toBeNull();
    // A palette with an unparseable bid leaves the previous value in place.
    const before = OVERLAY.bid.css;
    applyOverlayPalette({ bg: '#000000', grid: '#000000', text: '#000000', bid: 'junk', ask: '#a52a1d', accent: '#000000' });
    expect(OVERLAY.bid.css).toBe(before);
    expect(OVERLAY.ask.css).toBe('rgba(165, 42, 29, 1)');
  });
});
