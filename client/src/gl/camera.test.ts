import { describe, expect, it } from 'vitest';

import {
  Camera,
  clampCamera,
  fit,
  follow,
  limitsFor,
  MIN_COL_SPAN,
  MIN_ROW_SPAN,
  pan,
  reset,
  toView,
  zoomPrice,
  zoomTime,
  type CameraLimits,
  type CameraState,
} from './camera';
import type { ResidentRange } from './tileRing';

// A representative geometry: 512-row price grid, ring holds 4096 columns.
const ROWS = 512;
const CAP = 4096;
const LIMITS: CameraLimits = limitsFor(ROWS, CAP);

function range(oldest: number, newest: number): ResidentRange {
  return { oldest, newest, count: newest - oldest + 1 };
}

/** A mid-grid, mid-history state well away from every clamp. */
function baseState(): CameraState {
  return { colCenter: 1000, colSpan: 200, rowCenter: 256, rowSpan: 120, follow: false };
}

/** Absolute column under the cursor for a given fractional viewport position. */
function colAtFrac(s: CameraState, frac: number): number {
  const v = toView(s);
  return v.colOffset + v.colScale * frac;
}
function rowAtFrac(s: CameraState, frac: number): number {
  const v = toView(s);
  return v.rowOffset + v.rowScale * frac;
}

describe('camera view mapping', () => {
  it('maps center+span to the shader edge/scale uniforms', () => {
    const v = toView({ colCenter: 100, colSpan: 40, rowCenter: 200, rowSpan: 80, follow: false });
    expect(v).toEqual({ colOffset: 80, colScale: 40, rowOffset: 160, rowScale: 80 });
  });
});

describe('pan', () => {
  it('shifts both centers by the delta and disables follow', () => {
    const s = { ...baseState(), follow: true };
    const p = pan(s, LIMITS, 30, -10);
    expect(p.colCenter).toBe(1030);
    expect(p.rowCenter).toBe(246);
    expect(p.colSpan).toBe(200); // zoom unchanged
    expect(p.rowSpan).toBe(120);
    expect(p.follow).toBe(false);
  });

  it('leaves the input state untouched (pure)', () => {
    const s = baseState();
    pan(s, LIMITS, 100, 100);
    expect(s.colCenter).toBe(1000);
    expect(s.rowCenter).toBe(256);
  });

  it('clamps rowCenter to the price grid (no absurd vertical pan)', () => {
    expect(pan(baseState(), LIMITS, 0, +100_000).rowCenter).toBe(ROWS);
    expect(pan(baseState(), LIMITS, 0, -100_000).rowCenter).toBe(0);
  });

  it('does NOT clamp colCenter — history scrolls freely in both directions', () => {
    expect(pan(baseState(), LIMITS, -100_000, 0).colCenter).toBe(1000 - 100_000);
    expect(pan(baseState(), LIMITS, +100_000, 0).colCenter).toBe(1000 + 100_000);
  });
});

describe('zoomTime — cursor anchored', () => {
  it('keeps the column under the cursor fixed when zooming IN', () => {
    const s = baseState();
    const anchor = colAtFrac(s, 0.25); // a quarter across the viewport
    const z = zoomTime(s, LIMITS, 0.5, anchor);
    expect(z.colSpan).toBe(100);
    // The same fractional position still maps to the same absolute column.
    expect(colAtFrac(z, 0.25)).toBeCloseTo(anchor, 9);
    expect(z.follow).toBe(false);
  });

  it('keeps the column under the cursor fixed when zooming OUT', () => {
    const s = baseState();
    const anchor = colAtFrac(s, 0.8);
    const z = zoomTime(s, LIMITS, 2, anchor);
    expect(z.colSpan).toBe(400);
    expect(colAtFrac(z, 0.8)).toBeCloseTo(anchor, 9);
  });

  it('anchoring at the exact center leaves the center fixed', () => {
    const s = baseState();
    const z = zoomTime(s, LIMITS, 0.5, s.colCenter);
    expect(z.colCenter).toBeCloseTo(s.colCenter, 9);
  });

  it('cannot zoom past 1 column (min span clamp)', () => {
    const s = { ...baseState(), colSpan: 2 };
    const z = zoomTime(s, LIMITS, 0.001, s.colCenter);
    expect(z.colSpan).toBe(MIN_COL_SPAN);
  });

  it('cannot zoom out beyond the max span', () => {
    const s = { ...baseState(), colSpan: CAP / 2 };
    const z = zoomTime(s, LIMITS, 100, s.colCenter);
    expect(z.colSpan).toBe(CAP);
  });

  it('anchor stays exact even when the span clamps at the minimum', () => {
    const s = { ...baseState(), colSpan: 2 };
    const anchor = colAtFrac(s, 0.3);
    const z = zoomTime(s, LIMITS, 0.001, anchor);
    expect(z.colSpan).toBe(1);
    expect(colAtFrac(z, 0.3)).toBeCloseTo(anchor, 9);
  });
});

describe('zoomPrice — cursor anchored', () => {
  it('keeps the row under the cursor fixed when zooming in (mid-grid)', () => {
    const s = baseState();
    const anchor = rowAtFrac(s, 0.4);
    const z = zoomPrice(s, LIMITS, 0.5, anchor);
    expect(z.rowSpan).toBe(60);
    expect(rowAtFrac(z, 0.4)).toBeCloseTo(anchor, 9);
    expect(z.follow).toBe(false);
  });

  it('cannot zoom price past 1 row', () => {
    const s = { ...baseState(), rowSpan: 2 };
    expect(zoomPrice(s, LIMITS, 0.001, s.rowCenter).rowSpan).toBe(MIN_ROW_SPAN);
  });

  it('cannot zoom price out beyond the full grid height', () => {
    const s = { ...baseState(), rowSpan: 400 };
    expect(zoomPrice(s, LIMITS, 100, s.rowCenter).rowSpan).toBe(ROWS);
  });
});

describe('fit', () => {
  it('frames all resident columns and the whole price grid, follow off', () => {
    const f = fit(LIMITS, range(200, 699), ROWS);
    expect(f.colSpan).toBe(500);
    expect(f.colCenter).toBe((200 + 699 + 1) / 2); // 450
    expect(f.rowSpan).toBe(ROWS);
    expect(f.rowCenter).toBe(ROWS / 2);
    expect(f.follow).toBe(false);
    // The framed view spans exactly [oldest, newest+1) on the time axis.
    const v = toView(f);
    expect(v.colOffset).toBe(200);
    expect(v.colOffset + v.colScale).toBe(700);
  });

  it('clamps the fitted span to the max (huge resident range)', () => {
    const f = fit(LIMITS, range(0, 10_000), ROWS);
    expect(f.colSpan).toBe(CAP);
  });
});

describe('reset / go-live', () => {
  it('pins the right edge to the newest column and turns follow ON', () => {
    const r = reset(LIMITS, range(500, 999), ROWS);
    expect(r.follow).toBe(true);
    const v = toView(r);
    // Right edge sits just past the newest column.
    expect(v.colOffset + v.colScale).toBe(1000);
    expect(r.rowCenter).toBe(ROWS / 2);
  });

  it('works with no resident range (fresh session)', () => {
    const r = reset(LIMITS);
    expect(r.follow).toBe(true);
    expect(r.colSpan).toBe(CAP);
    expect(r.rowSpan).toBe(ROWS);
  });
});

describe('follow — snap right edge', () => {
  it('moves the right edge to newest+1 keeping the current span', () => {
    const s = { ...baseState(), colSpan: 300 };
    const f = follow(s, range(0, 4999));
    expect(f.follow).toBe(true);
    expect(f.colSpan).toBe(300); // span preserved
    const v = toView(f);
    expect(v.colOffset + v.colScale).toBe(5000);
    // Price axis is untouched by a time-follow snap.
    expect(f.rowCenter).toBe(s.rowCenter);
    expect(f.rowSpan).toBe(s.rowSpan);
  });
});

describe('clampCamera', () => {
  it('clamps every axis independently', () => {
    const c = clampCamera(
      { colCenter: -50, colSpan: 0.1, rowCenter: 9999, rowSpan: 99999, follow: false },
      LIMITS,
    );
    expect(c.colCenter).toBe(-50); // time center free
    expect(c.colSpan).toBe(MIN_COL_SPAN);
    expect(c.rowCenter).toBe(ROWS);
    expect(c.rowSpan).toBe(ROWS);
  });
});

describe('Camera (imperative wrapper)', () => {
  it('starts following and converts to view uniforms', () => {
    const cam = new Camera(LIMITS);
    expect(cam.follow).toBe(true);
    const v = cam.toView();
    expect(v.colScale).toBe(CAP);
    expect(v.rowScale).toBe(ROWS);
  });

  it('a pan gesture clears follow; go-live restores it', () => {
    const cam = new Camera(LIMITS);
    cam.pan(10, 10);
    expect(cam.follow).toBe(false);
    cam.reset(range(0, 999), ROWS);
    expect(cam.follow).toBe(true);
  });

  it('setFollowFrame reproduces the renderer edge-form framing', () => {
    const cam = new Camera(LIMITS);
    cam.setFollowFrame(100, 200, 40, 80);
    const v = cam.toView();
    expect(v).toEqual({ colOffset: 100, colScale: 200, rowOffset: 40, rowScale: 80 });
    expect(cam.follow).toBe(true);
  });

  it('re-clamps state when limits shrink', () => {
    const cam = new Camera(LIMITS);
    cam.setFollowFrame(0, 100, 0, 500); // rowSpan 500 within 512
    cam.setLimits(limitsFor(256, CAP)); // grid shrinks to 256 rows
    expect(cam.toView().rowScale).toBe(256);
  });
});
