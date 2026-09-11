import { afterEach, describe, expect, it } from 'vitest';

import { applyOverlayPalette, OVERLAY, parseCssColor } from './palette';

/** Deep snapshot of the shipped (midnight) palette literals. */
function snapshot(): typeof OVERLAY {
  return JSON.parse(JSON.stringify(OVERLAY));
}

afterEach(() => {
  applyOverlayPalette(null);
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

  // DARK-ISLAND RULE (fix 2026-09-10 F1-2): the GL canvas is ramp-dark in every
  // theme, so the chart's ink/grid/pill must NEVER follow a light theme — only
  // the semantic bid/ask pair does. Paper and swiss are the light themes that
  // used to ink the dark canvas near-black.
  it.each([
    ['paper', { bg: '#f3f1ea', grid: '#d6d0c0', text: '#24272d', bid: '#0e7c72', ask: '#b3383d', accent: '#0a6158' }],
    ['swiss', { bg: '#ffffff', grid: '#2b2b2b', text: '#000000', bid: '#00695f', ask: '#a52a1d', accent: '#004d45' }],
  ] as const)('applying %s keeps text/grid/pill at the midnight literals while bid/ask change', (_id, palette) => {
    const before = snapshot();
    applyOverlayPalette(palette);
    // Ink, grid and the pill/badge plates stay midnight…
    expect(OVERLAY.price.css).toBe(before.price.css);
    expect(OVERLAY.priceGlow.css).toBe(before.priceGlow.css);
    expect(OVERLAY.priceLevel.css).toBe(before.priceLevel.css);
    expect(OVERLAY.pricePill.css).toBe(before.pricePill.css);
    expect(OVERLAY.pricePillText.css).toBe(before.pricePillText.css);
    expect(OVERLAY.axis.css).toBe(before.axis.css);
    expect(OVERLAY.grid.css).toBe(before.grid.css);
    expect(OVERLAY.badgeBg).toBe(before.badgeBg);
    // …while the semantic channels follow the theme (changed vs midnight).
    expect(OVERLAY.bid.css).not.toBe(before.bid.css);
    expect(OVERLAY.ask.css).not.toBe(before.ask.css);
    expect(OVERLAY.buy.css).not.toBe(before.buy.css);
    expect(OVERLAY.sell.css).not.toBe(before.sell.css);
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
