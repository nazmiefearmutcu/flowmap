import { describe, expect, it } from 'vitest';

import { Markers } from './markers';
import type { OverlayFrame } from './frame';
import type { Marker } from '../../proto/types';

/**
 * Minimal frame stub for driving `Markers.draw`. The GridMap methods used are
 * stubbed with simple, deterministic transforms so we can assert where glyphs
 * and labels land. `cssY(0)` maps to the bottom of the canvas (grid row 0),
 * which is what makes off-canvas label placement observable.
 */
const CSS_H = 600;
const CSS_W = 800;

function makeFrame() {
  const textCalls: Array<{ x: number; y: number; label: string }> = [];
  const gm = {
    hasEvents: true,
    dims: { cssW: CSS_W, cssH: CSS_H },
    pxToClipW: (px: number) => px / CSS_W,
    pxToClipH: (px: number) => px / CSS_H,
    // Keep every marker on-screen for the test.
    tsToCol: (_ts: bigint) => 10,
    clipX: (_col: number) => 0,
    clipY: (row: number) => (row === 0 ? -1 : 0),
    cssX: (_col: number) => 100,
    // Bottom-of-canvas for row 0, so an off-canvas label is easy to detect.
    cssY: (row: number) => CSS_H - row,
    priceToRow: (_p: number) => 5,
  };
  const frame = {
    gm,
    solid: { begin() {}, addThickLine() {}, addTri() {}, addQuad() {}, flush() {} },
    points: {},
    text: {
      text(x: number, y: number, label: string) {
        textCalls.push({ x, y, label });
      },
    },
    resident: null,
    capability: null,
    columnArrays: () => null,
  } as unknown as OverlayFrame;
  return { frame, textCalls };
}

function marker(kind: Marker['kind'], price: number | null): Marker {
  return { ts_ns: 1000, price, kind } as unknown as Marker;
}

describe('Markers label placement', () => {
  it('places null-price marker labels near the top, not off-canvas', () => {
    const m = new Markers();
    m.add(marker('large_lot', null));
    const { frame, textCalls } = makeFrame();
    m.draw(frame);

    expect(textCalls).toHaveLength(1);
    // The label must sit near the top (matching the glyph at clip y 0.94), not
    // at cssY(0) === CSS_H (the bottom / off-canvas).
    expect(textCalls[0].y).toBeLessThan(CSS_H * 0.1);
    expect(textCalls[0].y).toBeGreaterThanOrEqual(0);
  });

  it('places priced marker labels at the price row', () => {
    const m = new Markers();
    m.add(marker('large_lot', 123.5));
    const { frame, textCalls } = makeFrame();
    m.draw(frame);

    expect(textCalls).toHaveLength(1);
    // cssY(priceToRow(p)+0.5) === cssY(5.5) === CSS_H - 5.5, plus the +3 nudge.
    expect(textCalls[0].y).toBeCloseTo(CSS_H - 5.5 + 3);
  });

  it('matches the vertical-marker label top offset for null-price markers', () => {
    const priced = new Markers();
    const vertical = new Markers();
    vertical.add(marker('gap', null));
    priced.add(marker('info', null));

    const a = makeFrame();
    const b = makeFrame();
    vertical.draw(a.frame);
    priced.draw(b.frame);

    // Vertical markers use a fixed cssY of 12; null-price glyph labels match it.
    expect(a.textCalls[0].y).toBe(12);
    expect(b.textCalls[0].y).toBe(12);
  });
});
