/**
 * Axis draw-glue tests (W5 AXES, swarm2).
 *
 * Pins the surgical Bookmap-class tunings plus the pre-existing contracts the
 * tunings must not disturb:
 *   - label fit at LARGE prices (review R2-M2): the global decimal reduction
 *     keeps every label inside the frozen 62 px gutter, and the width-free path
 *     stays byte-identical (`toFixed(step decimals)`);
 *   - tick marks: 6 px majors at AXIS_TICK_ALPHA for BOTH axes (subtle guides,
 *     dimmer than the labels they serve);
 *   - time-axis typography: AXIS_TIME_LABEL_SIZE / AXIS_LABEL_WEIGHT, ms-precision
 *     strings, first/last labels clamped inward so they can never be half-clipped;
 *   - gridline-coverage contract: the string-free position helpers return EXACTLY
 *     the labeled ticks (no minor tick may draw a line the axis does not label).
 */

import { describe, expect, it } from 'vitest';

import {
  AXIS_LABEL_SIZE,
  AXIS_LABEL_WEIGHT,
  AXIS_TICK_ALPHA,
  AXIS_TICK_LEN,
  AXIS_TIME_LABEL_SIZE,
  drawPriceAxis,
  drawTimeAxis,
  priceAxisModel,
  priceTickPositions,
  timeAxisModel,
  timeTickPositions,
} from './axes';
import { GridMap, type PriceMap, type TimeMap } from './coords';
import type { TextLayer } from '../textLayer';

const DIMS = { drawW: 800, drawH: 400, cssW: 800, cssH: 400 };
/** Session-relative affine: col 5 == 1.25 s, 250 ms per column. */
const TIME: TimeMap = { anchorSeq: 5, anchorT0Ns: 1_250_000_000n, dtNs: 250_000_000 };
const VIEW = { colOffset: 0, colScale: 10, rowOffset: 0, rowScale: 100 };

function gm(price: PriceMap, rowScale = VIEW.rowScale): GridMap {
  return new GridMap({ ...VIEW, rowScale }, DIMS, TIME, price);
}

interface LineCall {
  x0: number; y0: number; x1: number; y1: number; color: string; width: number; alpha: number;
}
interface TextCall { x: number; y: number; str: string; opts: Record<string, unknown> }

/** A TextLayer stub that records calls instead of painting (no canvas). */
function stubLayer(width: number, height: number): { layer: TextLayer; lines: LineCall[]; texts: TextCall[] } {
  const lines: LineCall[] = [];
  const texts: TextCall[] = [];
  const layer = {
    width,
    height,
    clear: () => {},
    line: (x0: number, y0: number, x1: number, y1: number, color: string, w = 1, a = 1) => {
      lines.push({ x0, y0, x1, y1, color, width: w, alpha: a });
    },
    text: (x: number, y: number, str: string, opts: Record<string, unknown>) => {
      texts.push({ x, y, str, opts });
    },
    badge: () => {},
  } as unknown as TextLayer;
  return { layer, lines, texts };
}

describe('priceAxisModel — label fit at large prices (R2-M2)', () => {
  it('reduces decimals GLOBALLY so a big-price ladder stays inside the gutter', () => {
    // Deep zoom on a large price: tick step 0.01 → "12345.01" (8 chars) would
    // overflow the 7-char budget; the fit drops to 1 decimal for the WHOLE ladder.
    const g = gm({ p0: 12345, step: 0.01 }, 8);
    const labels = priceAxisModel(g, DIMS.cssH, 48);
    expect(labels.length).toBeGreaterThan(2);
    for (const l of labels) expect(l.label.length).toBeLessThanOrEqual(7);
    // One scale, never mixed readouts.
    const decimals = new Set(labels.map((l) => l.label.split('.')[1]?.length ?? 0));
    expect(decimals.size).toBe(1);
  });

  it('keeps the width-free path byte-identical (historical toFixed)', () => {
    const g = gm({ p0: 12345, step: 0.01 }, 8);
    const labels = priceAxisModel(g, DIMS.cssH);
    expect(labels.length).toBeGreaterThan(2);
    expect(labels[0].label).toBe('12345.00');
    for (const l of labels) expect(l.label).toMatch(/^12345\.\d{2}$/);
  });

  it('fits 7-char integer prices (1.2M-scale asset) exactly in the budget', () => {
    const g = gm({ p0: 1_234_500, step: 1 }, 700);
    const labels = priceAxisModel(g, DIMS.cssH, 48);
    expect(labels.length).toBeGreaterThan(4);
    for (const l of labels) {
      expect(l.label.length).toBeLessThanOrEqual(7);
      // 7 chars × 11 px × 0.6 em advance = 46.2 px ≤ the 48 px label box.
      expect(l.label.length * AXIS_LABEL_SIZE * 0.6).toBeLessThanOrEqual(48);
    }
  });
});

describe('drawPriceAxis — tick marks and label styling', () => {
  it('draws 6 px majors at AXIS_TICK_ALPHA and 11 px/500 labels right-aligned at cssW-6', () => {
    const g = gm({ p0: 0, step: 0.5 });
    const { layer, lines, texts } = stubLayer(62, DIMS.cssH);
    drawPriceAxis(layer, g, null);

    expect(lines.length).toBeGreaterThan(3);
    expect(lines.length).toBe(texts.length); // exactly one labeled tick per line
    for (const ln of lines) {
      expect(ln.x0).toBe(0);
      expect(ln.y0).toBe(ln.y1);
      expect(ln.x1).toBe(AXIS_TICK_LEN);
      expect(ln.width).toBe(1);
      expect(ln.alpha).toBe(AXIS_TICK_ALPHA);
    }
    for (const t of texts) {
      expect(t.x).toBe(62 - 6);
      expect(t.opts.align).toBe('right');
      expect(t.opts.baseline).toBe('middle');
      expect(t.opts.size).toBe(AXIS_LABEL_SIZE);
      expect(t.opts.weight).toBe(AXIS_LABEL_WEIGHT);
    }
  });
});

describe('drawTimeAxis — typography, ticks, edge clamping', () => {
  it('draws 6 px majors at AXIS_TICK_ALPHA and clamps the first/last label inward', () => {
    const g = gm({ p0: 0, step: 0.5 });
    const model = timeAxisModel(g, 800);
    expect(model.length).toBeGreaterThan(2);
    const { layer, lines, texts } = stubLayer(800, 22);
    drawTimeAxis(layer, g);

    expect(lines.length).toBe(model.length);
    for (const ln of lines) {
      expect(ln.x0).toBe(ln.x1);
      expect(ln.y0).toBe(0);
      expect(ln.y1).toBe(AXIS_TICK_LEN);
      expect(ln.alpha).toBe(AXIS_TICK_ALPHA);
    }
    expect(texts.length).toBe(model.length);
    for (const t of texts) {
      expect(t.opts.size).toBe(AXIS_TIME_LABEL_SIZE);
      expect(t.opts.weight).toBe(AXIS_LABEL_WEIGHT);
      expect(t.y).toBe(15);
    }
    // First label anchors left at x=2; the last anchors right inside the gutter.
    expect(texts[0].opts.align).toBe('left');
    expect(texts[0].x).toBe(2);
    expect(texts[texts.length - 1].opts.align).toBe('right');
    expect(texts[texts.length - 1].x).toBe(800 - 2);
    // ...while the tick marks themselves stay on the true tick positions.
    expect(lines[lines.length - 1].x0).toBe(model[model.length - 1].pos);
  });
});

describe('gridline coverage contract — positions == labeled ticks', () => {
  it('priceTickPositions is exactly the labeled price ladder', () => {
    const g = gm({ p0: 77000, step: 1 }, 800);
    const model = priceAxisModel(g, DIMS.cssH);
    expect(model.length).toBeGreaterThan(4);
    expect(priceTickPositions(g, DIMS.cssH)).toEqual(model.map((l) => l.pos));
  });

  it('timeTickPositions is exactly the labeled time ladder', () => {
    const g = gm({ p0: 0, step: 0.5 });
    const model = timeAxisModel(g, 800);
    expect(model.length).toBeGreaterThan(2);
    expect(timeTickPositions(g, 800)).toEqual(model.map((l) => l.pos));
  });
});
