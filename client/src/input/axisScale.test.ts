import { describe, expect, it } from 'vitest';

import {
  DRAG_DEADZONE_PX,
  fractionAlong,
  LINE_TO_PX,
  PAGE_TO_PX,
  SCALE_RATE,
  scaleFactorFromDrag,
  wheelDeltaPx,
  zoomFactorFromWheel,
} from './axisScale';

describe('wheelDeltaPx — deltaMode normalisation', () => {
  it('passes pixel mode straight through', () => {
    expect(wheelDeltaPx(-120, 0)).toBe(-120);
  });

  it('scales line mode by LINE_TO_PX', () => {
    expect(wheelDeltaPx(-3, 1)).toBe(-3 * LINE_TO_PX);
  });

  it('scales page mode by PAGE_TO_PX (previously unhandled → a dead axis)', () => {
    // deltaMode 2 delivers deltaY = ±1; treating it as 1px made a whole-page
    // scroll gesture move the span by 0.15%.
    expect(wheelDeltaPx(1, 2)).toBe(PAGE_TO_PX);
  });
});

describe('zoomFactorFromWheel', () => {
  it('scroll UP zooms IN (span shrinks)', () => {
    expect(zoomFactorFromWheel(-120, 0)).toBeLessThan(1);
  });

  it('scroll DOWN zooms OUT (span grows)', () => {
    expect(zoomFactorFromWheel(120, 0)).toBeGreaterThan(1);
  });

  it('is exponential, so a notch is the same ratio at every zoom level', () => {
    expect(zoomFactorFromWheel(120, 0)).toBeCloseTo(Math.exp(120 * SCALE_RATE), 12);
    // ~1.19x per 120px notch — the documented feel.
    expect(zoomFactorFromWheel(120, 0)).toBeCloseTo(1.197, 3);
  });

  it('round-trips exactly: scrolling back lands where you started', () => {
    expect(zoomFactorFromWheel(120, 0) * zoomFactorFromWheel(-120, 0)).toBeCloseTo(1, 12);
  });

  it('a zero delta is a no-op', () => {
    expect(zoomFactorFromWheel(0, 0)).toBe(1);
  });
});

describe('scaleFactorFromDrag — axis drag-to-scale', () => {
  it('returns exactly 1 inside the deadzone (a click never scales)', () => {
    expect(scaleFactorFromDrag(0)).toBe(1);
    expect(scaleFactorFromDrag(DRAG_DEADZONE_PX - 0.01)).toBe(1);
    expect(scaleFactorFromDrag(-(DRAG_DEADZONE_PX - 0.01))).toBe(1);
  });

  it('dragging DOWN compresses the price axis (more price on screen)', () => {
    expect(scaleFactorFromDrag(40)).toBeGreaterThan(1);
  });

  it('dragging UP expands the price axis', () => {
    expect(scaleFactorFromDrag(-40)).toBeLessThan(1);
  });

  it('matches the wheel law, so both gestures feel identical', () => {
    expect(scaleFactorFromDrag(40)).toBeCloseTo(zoomFactorFromWheel(40, 0), 12);
  });
});

describe('fractionAlong', () => {
  it('maps a position to [0,1] along the box', () => {
    expect(fractionAlong(0, 400)).toBe(0);
    expect(fractionAlong(200, 400)).toBe(0.5);
    expect(fractionAlong(400, 400)).toBe(1);
  });

  it('clamps a pointer captured outside the element', () => {
    expect(fractionAlong(-50, 400)).toBe(0);
    expect(fractionAlong(900, 400)).toBe(1);
  });

  it('falls back to the centre on a zero-sized box (no divide-by-zero)', () => {
    expect(fractionAlong(10, 0)).toBe(0.5);
  });
});
