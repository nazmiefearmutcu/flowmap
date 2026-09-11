/**
 * Overlay geometry tests (survey S2 D3/D4 + CP2 consumers).
 *
 * Pins two classes of fixes:
 *   - the half-cell convention: the line family (price line, VWAP, BBO, axis
 *     pill) draws on the row-CELL CENTRE (+0.5) so it matches the density cell
 *     the heatmap paints and the bubbles/markers that already used it (S2 D3);
 *   - the piecewise time map (`coords.ts` TimeMap.slots): the time axis,
 *     bubbles and markers consume it, so a reconstructed (60 s-spaced) history
 *     block maps real times instead of the affine's 240×-compressed ones.
 *
 * Uses the REAL GridMap/axes math with stub 2D/GL sinks (no canvas).
 */

import { describe, expect, it } from 'vitest';

import { Bbo } from './bbo';
import { Bubbles } from './bubbles';
import { GridMap, type TimeMap } from './coords';
import { drawPriceAxis, timeAxisModel } from './axes';
import { Markers } from './markers';
import { PriceLine } from './priceLine';
import { Vwap } from './vwap';
import type { OverlayFrame } from './frame';
import type { TextLayer, Pt } from '../textLayer';
import type { BarColumn, Marker, Trade } from '../../proto/types';

const VIEW = { colOffset: 0, colScale: 10, rowOffset: 0, rowScale: 100 };
const DIMS = { drawW: 800, drawH: 400, cssW: 800, cssH: 400 };
const PRICE = { p0: 0, step: 0.5 };
const TIME: TimeMap = { anchorSeq: 5, anchorT0Ns: 5n * 250_000_000n, dtNs: 250_000_000 };

/** A real GridMap: price == 2·row, so a chosen close lands on a known row. */
function gm(): GridMap {
  return new GridMap(VIEW, DIMS, TIME, PRICE);
}

function bar(col: number, close: number): BarColumn {
  return { col_seq: col, c: close } as unknown as BarColumn;
}

function trade(ts: bigint, price: number): Trade {
  return { ts_ns: ts, price, size: 1, side: 1 } as unknown as Trade;
}

describe('half-cell convention — price line (S2 D3)', () => {
  it('draws the trace and the dashed level on the row-cell centre', () => {
    const g = gm();
    const pl = new PriceLine();
    pl.add(bar(4, 5)); // price 5 → row 10; centre 10.5
    pl.add(bar(5, 5));
    const polylines: Pt[][] = [];
    const dashes: number[][] = [];
    const text = {
      fillUnder: () => {},
      polyline: (pts: Pt[]) => {
        polylines.push(pts);
      },
      dashedLine: (x0: number, y0: number, x1: number, y1: number) => {
        dashes.push([x0, y0, x1, y1]);
      },
    };
    pl.draw({ gm: g, text, resident: null } as unknown as OverlayFrame);

    const pts = polylines[polylines.length - 1];
    expect(pts).toHaveLength(2);
    expect(pts[1].x).toBeCloseTo(g.cssX(5.5));
    expect(pts[1].y).toBeCloseTo(g.cssY(g.priceToRow(5) + 0.5));
    expect(pts[1].y).toBeCloseTo(358);
    // The old boundary convention would have landed on 360 — not close.
    expect(g.cssY(g.priceToRow(5))).toBeCloseTo(360);
    // Dashed last-price level at the same centre row (two vertices → this is
    // the level line, not the single-vertex stub dash).
    expect(dashes[0]).toEqual([0, 358, 800, 358]);
  });
});

describe('half-cell convention — VWAP / BBO / pill (S2 D3)', () => {
  it('places the VWAP polyline on the row-cell centre', () => {
    const g = gm();
    const v = new Vwap();
    v.add({ col_seq: 4, vwap_num_cum: 4, vwap_den_cum: 1 } as unknown as BarColumn);
    v.add({ col_seq: 5, vwap_num_cum: 5, vwap_den_cum: 1 } as unknown as BarColumn);
    const lines: number[][] = [];
    const solid = {
      begin: () => {},
      addThickLine: (x0: number, y0: number, x1: number, y1: number) => {
        lines.push([x0, y0, x1, y1]);
      },
      flush: () => {},
    };
    v.draw({ gm: g, solid, resident: null } as unknown as OverlayFrame);

    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toBeCloseTo(g.clipY(g.priceToRow(4) + 0.5));
    expect(lines[0][3]).toBeCloseTo(g.clipY(g.priceToRow(5) + 0.5));
  });

  it('places the BBO lines and badges on the row-cell centre', () => {
    const g = gm();
    const bbo = new Bbo();
    bbo.set({ bidPx: 5, bidSz: 2, askPx: 7, askSz: 3, source: 'bbo' });
    const lines: number[][] = [];
    const badges: number[][] = [];
    const solid = {
      begin: () => {},
      addThickLine: (x0: number, y0: number, x1: number, y1: number) => {
        lines.push([x0, y0, x1, y1]);
      },
      flush: () => {},
    };
    const text = {
      badge: (x: number, y: number) => {
        badges.push([x, y]);
      },
    };
    bbo.draw({ gm: g, solid, text } as unknown as OverlayFrame);

    // ask drawn first, then bid.
    expect(lines[0][1]).toBeCloseTo(g.clipY(g.priceToRow(7) + 0.5));
    expect(lines[1][1]).toBeCloseTo(g.clipY(g.priceToRow(5) + 0.5));
    expect(badges[0][1]).toBeCloseTo(g.cssY(g.priceToRow(7) + 0.5));
    expect(badges[1][1]).toBeCloseTo(g.cssY(g.priceToRow(5) + 0.5));
  });

  it('pins the axis pill to the last-close row-cell centre', () => {
    const g = new GridMap({ ...VIEW, rowScale: 80 }, { ...DIMS }, TIME, PRICE);
    const pills: number[][] = [];
    const layer = {
      width: 60,
      height: 400,
      clear: () => {},
      line: () => {},
      text: () => {},
      badge: (x: number, y: number) => {
        pills.push([x, y]);
      },
    } as unknown as TextLayer;
    drawPriceAxis(layer, g, { col: 5, price: 15 }); // price 15 → row 30
    expect(pills).toHaveLength(1);
    expect(pills[0][1]).toBeCloseTo(g.cssY(30.5));
    expect(pills[0][1]).not.toBeCloseTo(g.cssY(30), 1); // boundary would be 250
    expect(pills[0][1]).toBeCloseTo(247.5);
  });
});

describe('piecewise time map consumers (CP2, S2 D1)', () => {
  /** Cols 0..4 arrive 60 s apart (reconstructed 1 m candles), live dt = 250 ms. */
  const SLOTS: TimeMap = {
    anchorSeq: 4,
    anchorT0Ns: 240_000_000_000n,
    dtNs: 250_000_000,
    slots: { startSeq: 0, t0: Float64Array.from([0, 60e9, 120e9, 180e9, 240e9]) },
  };

  function slotsGm(): GridMap {
    return new GridMap({ ...VIEW, colScale: 4 }, DIMS, SLOTS, PRICE);
  }

  it('time axis labels real reconstructed-candle times at the right columns', () => {
    const model = timeAxisModel(slotsGm(), 800);
    expect(model.map((m) => m.label)).toEqual([
      '00:00:00',
      '00:01:00',
      '00:02:00',
      '00:03:00',
      '00:04:00',
    ]);
    expect(model.map((m) => m.pos)).toEqual([0, 200, 400, 600, 800]);
  });

  it('bubbles land on their candle column (affine would skip them)', () => {
    const g = slotsGm();
    const xs: number[] = [];
    const points = {
      begin: () => {},
      add: (x: number) => {
        xs.push(x);
      },
      flush: () => {},
    };
    const b = new Bubbles();
    b.add(trade(30_000_000_000n, 5)); // col 0.5 → centre 1.0
    b.add(trade(120_000_000_000n, 5)); // col 2 → centre 2.5
    b.draw({ gm: g, points, resident: null } as unknown as OverlayFrame);

    // Newest first: 120e9 @ 2.5, then 30e9 @ 1.0. Under the affine the older
    // trade maps thousands of columns left and the scan would break after one.
    expect(xs).toHaveLength(2);
    expect(xs[0]).toBeCloseTo(g.clipX(2.5));
    expect(xs[1]).toBeCloseTo(g.clipX(1.0));
  });

  it('markers land on their candle column', () => {
    const g = slotsGm();
    const quads: number[] = [];
    const solid = {
      begin: () => {},
      addThickLine: () => {},
      addTri: () => {},
      addQuad: (x: number) => {
        quads.push(x);
      },
      flush: () => {},
    };
    const mk = new Markers();
    mk.add({ ts_ns: 60_000_000_000n, price: 5, kind: 'large_lot' } as unknown as Marker);
    mk.draw({
      gm: g,
      solid,
      text: { text: () => {} },
      resident: null,
    } as unknown as OverlayFrame);

    expect(quads).toHaveLength(1);
    expect(quads[0]).toBeCloseTo(g.clipX(1.5)); // ts 60s → col 1, +0.5 centre
  });
});
