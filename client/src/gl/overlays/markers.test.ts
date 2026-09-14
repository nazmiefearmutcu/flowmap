import { describe, expect, it } from 'vitest';

import { Markers } from './markers';
import type { OverlayFrame } from './frame';
import type { Marker } from '../../proto/types';

/**
 * Minimal frame stub for driving `Markers.draw`. The GridMap methods used are
 * stubbed with simple, deterministic transforms so we can assert where glyphs
 * and labels land. Marker `ts_ns` doubles as the label x anchor: `tsToCol`
 * returns it and `cssX` is the identity, so a marker's chip starts at
 * `ts + glyphPx + 2` for priced kinds and `ts + 3` for vertical kinds.
 * `cssY(0)` maps to the bottom of the canvas (grid row 0), which is what makes
 * off-canvas label placement observable.
 */
const CSS_H = 600;
const CSS_W = 800;

function makeFrame() {
  const textCalls: Array<{ x: number; y: number; label: string }> = [];
  const hatchXs: number[] = [];
  const gm = {
    hasEvents: true,
    dims: { cssW: CSS_W, cssH: CSS_H },
    pxToClipW: (px: number) => px / CSS_W,
    pxToClipH: (px: number) => px / CSS_H,
    // Keep every marker on-screen and let ts BE the anchor x.
    tsToCol: (ts: bigint) => Number(ts),
    clipX: (_col: number) => 0,
    clipY: (row: number) => (row === 0 ? -1 : 0),
    cssX: (col: number) => col,
    // Bottom-of-canvas for row 0, so an off-canvas label is easy to detect.
    cssY: (row: number) => CSS_H - row,
    priceToRow: (_p: number) => 5,
  };
  const frame = {
    gm,
    solid: {
      begin() {},
      addThickLine(x: number) {
        hatchXs.push(x);
      },
      addTri() {},
      addQuad() {},
      flush() {},
    },
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
  return { frame, textCalls, hatchXs };
}

function marker(kind: Marker['kind'], price: number | null, ts = 1000): Marker {
  return { ts_ns: ts, price, kind, text: '' } as unknown as Marker;
}

function seamMarker(ts = 1000): Marker {
  return { ts_ns: ts, price: null, kind: 'gap', text: 'history seam (cadence break)' } as unknown as Marker;
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

describe('Markers declutter policy (QA14 gapstack)', () => {
  it('collapses a near-identical kind run into one counted badge, keeping every hatch', () => {
    const m = new Markers();
    // Six gaps ~9 px apart (the real BTC pile-up geometry): one chip, six hatches.
    for (const ts of [100, 109, 118, 127, 136, 145]) m.add(marker('gap', null, ts));
    const { frame, textCalls, hatchXs } = makeFrame();
    m.draw(frame);

    expect(hatchXs).toHaveLength(6); // honour: every gap still draws its hatch
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0].label).toBe('GAP ×6');
  });

  it('does not merge kinds that are far apart', () => {
    const m = new Markers();
    m.add(marker('gap', null, 100));
    m.add(marker('gap', null, 300));
    const { frame, textCalls } = makeFrame();
    m.draw(frame);

    expect(textCalls.map((t) => t.label)).toEqual(['GAP', 'GAP']);
    expect(textCalls[0].y).toBe(12);
    expect(textCalls[1].y).toBe(12);
  });

  it('labels seam markers SEAM and collapses them separately from plain gaps', () => {
    const m = new Markers();
    m.add(seamMarker(100));
    m.add(seamMarker(106));
    m.add(marker('gap', null, 103));
    const { frame, textCalls } = makeFrame();
    m.draw(frame);

    const labels = textCalls.map((t) => t.label).sort();
    expect(labels).toEqual(['GAP', 'SEAM ×2']);
  });

  it('offsets overlapping labels away from each other vertically', () => {
    const m = new Markers();
    m.add(marker('large_lot', null, 100)); // rank 2, top lane at y 12
    m.add(marker('gap', null, 100)); // rank 0, same top lane
    const { frame, textCalls } = makeFrame();
    m.draw(frame);

    const gap = textCalls.find((t) => t.label === 'GAP');
    const lot = textCalls.find((t) => t.label === 'LOT');
    expect(gap).toBeTruthy();
    expect(lot).toBeTruthy();
    expect(gap!.y).toBe(12);
    expect(lot!.y).toBe(24); // pushed one pitch down — no overprint
  });

  it('caps labels by priority gap > seam > marker (lowest dropped, glyphs intact)', () => {
    const m = new Markers({ maxLabels: 2 });
    m.add(marker('info', null, 100)); // rank 2
    m.add(marker('gap', null, 100)); // rank 0
    m.add(seamMarker(104)); // rank 1
    const { frame, textCalls, hatchXs } = makeFrame();
    m.draw(frame);

    expect(textCalls.map((t) => t.label)).toEqual(['GAP', 'SEAM']);
    // The dropped INFO chip must not cost its glyph, and both verticals keep hatches.
    expect(hatchXs).toHaveLength(2);
  });

  it('merges chained near markers even when the first-to-last span exceeds the radius', () => {
    const m = new Markers();
    // 12 gaps at 10 px steps → 110 px total span; single-linkage still → one badge.
    for (let i = 0; i < 12; i++) m.add(marker('gap', null, 100 + i * 10));
    const { frame, textCalls } = makeFrame();
    m.draw(frame);
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0].label).toBe('GAP ×12');
  });
});
