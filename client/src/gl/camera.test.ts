import { describe, expect, it } from 'vitest';

import {
  applyKill,
  Camera,
  clampCamera,
  fit,
  follow,
  KILL_BOTH,
  KILL_PRICE,
  KILL_TIME,
  limitsFor,
  MAX_ROW_SPAN,
  MIN_COL_SPAN,
  MIN_ROW_SPAN,
  pan,
  priceFrame,
  reset,
  rowCenterBounds,
  screenToGrid,
  toView,
  viewToGrid,
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
  return { colCenter: 1000, colSpan: 200, rowCenter: 256, rowSpan: 120, followTime: false, followPrice: 'off' };
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
    const v = toView({ colCenter: 100, colSpan: 40, rowCenter: 200, rowSpan: 80, followTime: false, followPrice: 'off' });
    expect(v).toEqual({ colOffset: 80, colScale: 40, rowOffset: 160, rowScale: 80 });
  });
});

describe('viewToGrid / screenToGrid — the crosshair inverse (T9)', () => {
  const view = toView({ colCenter: 1000, colSpan: 200, rowCenter: 256, rowSpan: 120, followTime: false, followPrice: 'off' });
  // colOffset=900, colScale=200, rowOffset=196, rowScale=120.

  it('is the exact algebraic inverse of the shader forward map', () => {
    // uv center (0.5,0.5) → the view centers.
    expect(viewToGrid(view, 0.5, 0.5)).toEqual({ colf: 1000, rowf: 256 });
    // uv (0,0) → left edge / bottom row.
    expect(viewToGrid(view, 0, 0)).toEqual({ colf: 900, rowf: 196 });
    // uv (1,1) → right edge / top row.
    expect(viewToGrid(view, 1, 1)).toEqual({ colf: 1100, rowf: 316 });
  });

  it('round-trips: forward (shader) then inverse recovers the uv', () => {
    for (const [uvX, uvY] of [
      [0.1, 0.2],
      [0.73, 0.42],
      [1, 0],
    ]) {
      const { colf, rowf } = viewToGrid(view, uvX, uvY);
      const backX = (colf - view.colOffset) / view.colScale;
      const backY = (rowf - view.rowOffset) / view.rowScale;
      expect(backX).toBeCloseTo(uvX, 12);
      expect(backY).toBeCloseTo(uvY, 12);
    }
  });

  it('screenToGrid flips DOM-y (top-down) to the shader bottom-up uv', () => {
    const cssW = 400;
    const cssH = 300;
    // Cursor at the TOP of the canvas (cssY=0) → uvY=1 → the top row.
    expect(screenToGrid(view, 0, 0, cssW, cssH).rowf).toBeCloseTo(316, 12);
    // Cursor at the BOTTOM (cssY=cssH) → uvY=0 → the bottom row.
    expect(screenToGrid(view, 0, cssH, cssW, cssH).rowf).toBeCloseTo(196, 12);
    // Horizontal center → colCenter.
    expect(screenToGrid(view, cssW / 2, cssH / 2, cssW, cssH).colf).toBeCloseTo(1000, 12);
  });

  it('guards a zero-sized canvas (no divide-by-zero)', () => {
    const p = screenToGrid(view, 10, 10, 0, 0);
    expect(Number.isFinite(p.colf)).toBe(true);
    expect(Number.isFinite(p.rowf)).toBe(true);
  });
});

describe('pan', () => {
  it('shifts both centers by the delta and disables both follows', () => {
    const s: CameraState = { ...baseState(), followTime: true, followPrice: 'fit' };
    const p = pan(s, LIMITS, 30, -10);
    expect(p.colCenter).toBe(1030);
    expect(p.rowCenter).toBe(246);
    expect(p.colSpan).toBe(200); // zoom unchanged
    expect(p.rowSpan).toBe(120);
    expect(p.followTime).toBe(false);
    expect(p.followPrice).toBe('off');
  });

  it('an axis-scoped pan releases only that axis', () => {
    const s: CameraState = { ...baseState(), followTime: true, followPrice: 'track' };
    const t = pan(s, LIMITS, 30, 0, KILL_TIME);
    expect(t.followTime).toBe(false);
    expect(t.followPrice).toBe('track'); // price keeps tracking
    const r = pan(s, LIMITS, 0, 10, KILL_PRICE);
    expect(r.followTime).toBe(true); // right edge still pinned
    expect(r.followPrice).toBe('off');
  });

  it('leaves the input state untouched (pure)', () => {
    const s = baseState();
    pan(s, LIMITS, 100, 100);
    expect(s.colCenter).toBe(1000);
    expect(s.rowCenter).toBe(256);
  });

  it('allows a FULL viewport of overscroll past each edge of the price grid', () => {
    // "Look infinitely far up/down": the grid can be pushed entirely off screen
    // in either direction, where the shader paints background.
    const span = baseState().rowSpan; // 120
    expect(pan(baseState(), LIMITS, 0, +100_000).rowCenter).toBe(ROWS + span);
    expect(pan(baseState(), LIMITS, 0, -100_000).rowCenter).toBe(-span);
  });

  it('overscroll is span-relative, so it feels the same at every price zoom', () => {
    const zoomedIn: CameraState = { ...baseState(), rowSpan: 10 };
    const zoomedOut: CameraState = { ...baseState(), rowSpan: 400 };
    expect(pan(zoomedIn, LIMITS, 0, -100_000).rowCenter).toBe(-10);
    expect(pan(zoomedOut, LIMITS, 0, -100_000).rowCenter).toBe(-400);
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
    expect(z.followTime).toBe(false);
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

  it('releases TIME follow only — the price axis keeps auto-scaling', () => {
    const s: CameraState = { ...baseState(), followTime: true, followPrice: 'fit' };
    const z = zoomTime(s, LIMITS, 0.5, s.colCenter);
    expect(z.followTime).toBe(false);
    // 'fit' is promoted to 'track': the fitted span is kept and still tracks.
    expect(z.followPrice).toBe('track');
  });

  it('cannot zoom past 1 column (min span clamp)', () => {
    const s = { ...baseState(), colSpan: 2 };
    const z = zoomTime(s, LIMITS, 0.001, s.colCenter);
    expect(z.colSpan).toBe(MIN_COL_SPAN);
  });

  it('lets the user zoom time out far past the ring, up to the zoom cap', () => {
    // Zoom-out is decoupled from the framing/ring cap: a 100x from CAP/2 lands
    // well past CAP (no artificial wall at the resident-column count).
    const past = zoomTime({ ...baseState(), colSpan: CAP / 2 }, LIMITS, 100, 1000);
    expect(past.colSpan).toBe((CAP / 2) * 100);
    expect(past.colSpan).toBeGreaterThan(LIMITS.maxColSpan);
    // ...but there is still a hard ceiling (maxColSpanZoom) for numeric safety.
    const capped = zoomTime({ ...baseState(), colSpan: CAP / 2 }, LIMITS, 1e9, 1000);
    expect(capped.colSpan).toBe(LIMITS.maxColSpanZoom);
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
  });

  it('keeps TIME follow and ADOPTS the span the user just chose', () => {
    const s: CameraState = { ...baseState(), followTime: true, followPrice: 'fit' };
    const z = zoomPrice(s, LIMITS, 0.5, s.rowCenter);
    expect(z.followTime).toBe(true); // right edge still pinned to now
    expect(z.followPrice).toBe('track'); // user owns the span now
  });

  it('never re-enables a price follow the user switched off', () => {
    const s: CameraState = { ...baseState(), followPrice: 'off' };
    expect(zoomPrice(s, LIMITS, 0.5, s.rowCenter).followPrice).toBe('off');
  });

  it('cannot zoom price past 1 row', () => {
    const s = { ...baseState(), rowSpan: 2 };
    expect(zoomPrice(s, LIMITS, 0.001, s.rowCenter).rowSpan).toBe(MIN_ROW_SPAN);
  });

  it('lets the user zoom price out far past the grid height, up to the zoom cap', () => {
    // The price twin of the time-axis decoupling: zoom-out is not capped by the
    // framing/grid height (README: "price and time both zoom out far past the
    // grid"). A 1e6x from near-grid height lands past ROWS, not on it...
    const past = zoomPrice({ ...baseState(), rowSpan: 400 }, LIMITS, 1e6, 256);
    expect(past.rowSpan).toBeGreaterThan(ROWS);
    expect(past.rowSpan).toBe(LIMITS.maxRowSpanZoom);
    // ...but there is still a hard ceiling (maxRowSpanZoom) for numeric safety.
    const capped = zoomPrice({ ...baseState(), rowSpan: 400 }, LIMITS, 1e9, 256);
    expect(capped.rowSpan).toBe(MAX_ROW_SPAN);
  });

  it('an in-between span past the grid height is legal and untouched', () => {
    const s = { ...baseState(), rowSpan: 400 };
    const out = zoomPrice(s, LIMITS, 2, s.rowCenter);
    expect(out.rowSpan).toBe(800); // > ROWS, < MAX_ROW_SPAN — no wall, no jump
  });
});

describe('maxRowSpanZoom — the user price zoom-out cap', () => {
  it('limitsFor decouples it from the grid height (like maxColSpanZoom)', () => {
    expect(LIMITS.maxRowSpanZoom).toBe(MAX_ROW_SPAN); // ROWS(512) < cap
    // A grid that somehow outgrew the cap still gets its full height.
    expect(limitsFor(MAX_ROW_SPAN * 2, CAP).maxRowSpanZoom).toBe(MAX_ROW_SPAN * 2);
  });

  it('clampCamera allows any span in [MIN_ROW_SPAN, maxRowSpanZoom]', () => {
    expect(clampCamera({ ...baseState(), rowSpan: 500_000 }, LIMITS).rowSpan).toBe(500_000);
    expect(clampCamera({ ...baseState(), rowSpan: 1e12 }, LIMITS).rowSpan).toBe(MAX_ROW_SPAN);
  });

  it('rowCenterBounds stays span-relative at the max user zoom-out', () => {
    const b = rowCenterBounds(MAX_ROW_SPAN, LIMITS);
    expect(b).toEqual({ lo: -MAX_ROW_SPAN, hi: ROWS + MAX_ROW_SPAN });
    // A full overscroll at the widest span keeps the view finite and precise.
    const p = pan({ ...baseState(), rowSpan: MAX_ROW_SPAN }, LIMITS, 0, -1e12);
    expect(p.rowCenter).toBe(-MAX_ROW_SPAN);
  });
});

describe('framing stays locked to the grid height (fit/reset/setPriceFrame)', () => {
  it('fit frames the whole grid, never past it', () => {
    expect(fit(LIMITS, range(200, 699), ROWS).rowSpan).toBe(ROWS);
  });

  it('reset frames the whole grid, never past it', () => {
    expect(reset(LIMITS, range(500, 999), ROWS).rowSpan).toBe(ROWS);
    expect(reset(LIMITS).rowSpan).toBe(ROWS);
  });

  it('setPriceFrame (the renderer auto-fit path) clamps to the grid', () => {
    const cam = new Camera(LIMITS);
    cam.setPriceFrame(0, 1_000_000);
    expect(cam.toView().rowScale).toBe(ROWS);
  });
});

describe('fit', () => {
  it('frames all resident columns and the whole price grid, follow off', () => {
    const f = fit(LIMITS, range(200, 699), ROWS);
    expect(f.colSpan).toBe(500);
    expect(f.colCenter).toBe((200 + 699 + 1) / 2); // 450
    expect(f.rowSpan).toBe(ROWS);
    expect(f.rowCenter).toBe(ROWS / 2);
    expect(f.followTime).toBe(false);
    expect(f.followPrice).toBe('off');
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

describe('reset — session-boot framing (NOT the go-live action)', () => {
  it('pins the right edge to the newest column and turns follow ON', () => {
    const r = reset(LIMITS, range(500, 999), ROWS);
    expect(r.followTime).toBe(true);
    expect(r.followPrice).toBe('fit');
    const v = toView(r);
    // Right edge sits just past the newest column.
    expect(v.colOffset + v.colScale).toBe(1000);
    expect(r.rowCenter).toBe(ROWS / 2);
  });

  it('works with no resident range (fresh session)', () => {
    const r = reset(LIMITS);
    expect(r.followTime).toBe(true);
    expect(r.followPrice).toBe('fit');
    expect(r.colSpan).toBe(CAP);
    expect(r.rowSpan).toBe(ROWS);
  });
});

describe('follow — snap right edge', () => {
  it('moves the right edge to newest+1 keeping the current span', () => {
    const s = { ...baseState(), colSpan: 300 };
    const f = follow(s, range(0, 4999));
    expect(f.followTime).toBe(true);
    expect(f.colSpan).toBe(300); // span preserved
    const v = toView(f);
    expect(v.colOffset + v.colScale).toBe(5000);
    // Price axis is untouched by a time-follow snap.
    expect(f.rowCenter).toBe(s.rowCenter);
    expect(f.rowSpan).toBe(s.rowSpan);
  });
});

describe('go-live via follow — re-arms TIME only, preserves the price axis', () => {
  it('keeps the user price zoom AND follow mode when re-arming live', () => {
    // A scrolled-back user with a custom price zoom ('track'): R / GO LIVE
    // snaps the right edge to newest+1 but must not touch rowSpan or the mode.
    const s: CameraState = {
      colCenter: 500,
      colSpan: 300,
      rowCenter: 100,
      rowSpan: 25,
      followTime: false,
      followPrice: 'track',
    };
    const out = follow(s, range(0, 4999));
    expect(out.followTime).toBe(true);
    expect(out.colSpan).toBe(300); // time span preserved too
    const v = toView(out);
    expect(v.colOffset + v.colScale).toBe(5000); // right edge = newest+1
    expect(out.rowSpan).toBe(25); // the user's price zoom survives
    expect(out.rowCenter).toBe(100);
    expect(out.followPrice).toBe('track');
  });

  it('preserves an OFF price axis (the user locked it)', () => {
    const s: CameraState = { ...baseState(), followTime: false, followPrice: 'off' };
    const out = follow(s, range(0, 4999));
    expect(out.followTime).toBe(true);
    expect(out.followPrice).toBe('off');
    expect(out.rowSpan).toBe(s.rowSpan);
  });

  it('keeps a FIT price axis fitted — the renderer auto-fit owns it from here', () => {
    const s: CameraState = { ...baseState(), rowSpan: 300, followTime: false, followPrice: 'fit' };
    const out = follow(s, range(0, 4999));
    expect(out.followTime).toBe(true);
    expect(out.followPrice).toBe('fit'); // unchanged; updateView applies the fit frame
    expect(out.rowSpan).toBe(300); // follow() never re-frames the book manually
  });

  it('setFollowTime(true) re-arms follow without touching price state', () => {
    // A scrolled-back user with a custom price zoom: both follows off.
    const cam = new Camera(LIMITS, {
      colCenter: 500,
      colSpan: 300,
      rowCenter: 100,
      rowSpan: 25,
      followTime: false,
      followPrice: 'off',
    });
    cam.setPriceFollow('track');
    cam.setFollowTime(true);
    expect(cam.followTime).toBe(true);
    expect(cam.followPrice).toBe('track');
    expect(cam.state.rowSpan).toBe(25); // the user's span is intact
  });
});

describe('clampCamera', () => {
  it('clamps every axis independently', () => {
    const c = clampCamera(
      {
        colCenter: -50,
        colSpan: 0.1,
        rowCenter: 1e12,
        rowSpan: 1e12,
        followTime: false,
        followPrice: 'off',
      },
      LIMITS,
    );
    expect(c.colCenter).toBe(-50); // time center free
    expect(c.colSpan).toBe(MIN_COL_SPAN);
    expect(c.rowSpan).toBe(MAX_ROW_SPAN); // span tops out at the USER zoom cap
    // rowCenter is bounded by the POST-clamp span, not the 1e12 it came in with.
    expect(c.rowCenter).toBe(ROWS + MAX_ROW_SPAN);
  });

  it('clamps rowSpan BEFORE deriving the rowCenter band (order matters)', () => {
    // If the band were derived from the pre-clamp span (1e12), rowCenter (1e9)
    // would pass unclamped; it must use the clamped span (MAX_ROW_SPAN) →
    // ROWS + MAX_ROW_SPAN.
    const c = clampCamera(
      {
        colCenter: 0,
        colSpan: 100,
        rowCenter: 1e9,
        rowSpan: 1e12,
        followTime: false,
        followPrice: 'off',
      },
      LIMITS,
    );
    expect(c.rowSpan).toBe(MAX_ROW_SPAN);
    expect(c.rowCenter).toBe(rowCenterBounds(MAX_ROW_SPAN, LIMITS).hi);
  });
});

describe('Camera (imperative wrapper)', () => {
  it('starts following and converts to view uniforms', () => {
    const cam = new Camera(LIMITS);
    expect(cam.followTime).toBe(true);
    expect(cam.followPrice).toBe('fit');
    const v = cam.toView();
    expect(v.colScale).toBe(CAP);
    expect(v.rowScale).toBe(ROWS);
  });

  it('a pan gesture clears follow; go-live restores it', () => {
    const cam = new Camera(LIMITS);
    cam.pan(10, 10);
    expect(cam.followTime).toBe(false);
    expect(cam.followPrice).toBe('off');
    cam.reset(range(0, 999), ROWS);
    expect(cam.followTime).toBe(true);
    expect(cam.followPrice).toBe('fit');
  });

  it('setFollowTime(false) promotes a fitted price axis to tracking', () => {
    const cam = new Camera(LIMITS);
    cam.setFollowTime(false);
    expect(cam.followTime).toBe(false);
    expect(cam.followPrice).toBe('track'); // fitted span kept, still tracking
  });

  it('setRowCenter recentres price without disturbing the span or the follows', () => {
    const cam = new Camera(LIMITS);
    cam.setPriceFollow('track');
    const before = cam.toView().rowScale;
    cam.setRowCenter(120);
    expect(cam.toView().rowScale).toBe(before);
    expect(cam.state.rowCenter).toBe(120);
    expect(cam.followTime).toBe(true);
    expect(cam.followPrice).toBe('track');
  });

  it('setFollowFrame reproduces the renderer edge-form framing', () => {
    const cam = new Camera(LIMITS);
    cam.setFollowFrame(100, 200, 40, 80);
    const v = cam.toView();
    expect(v).toEqual({ colOffset: 100, colScale: 200, rowOffset: 40, rowScale: 80 });
    expect(cam.followTime).toBe(true);
  });

  it('re-clamps state when limits shrink', () => {
    const cam = new Camera(LIMITS);
    cam.setFollowFrame(0, 100, 0, 500); // rowSpan 500 within 512
    cam.setLimits(limitsFor(256, CAP)); // grid shrinks to 256 rows
    // A 500-row span is a legal USER zoom-out on the shrunk grid (past the
    // grid the shader paints background), so it survives; only the centre
    // re-bounds to the new span-relative band.
    expect(cam.toView().rowScale).toBe(500);
    expect(cam.state.rowCenter).toBe(250); // band for span 500 is [-500, 756]
    // What the shrink still forces back: a span past the USER cap.
    cam.state = { ...cam.state, rowSpan: 2_000_000 };
    cam.setLimits(limitsFor(256, CAP));
    expect(cam.toView().rowScale).toBe(cam.limits.maxRowSpanZoom);
  });
});


describe('applyKill — the follow release policy', () => {
  const s: CameraState = { ...baseState(), followTime: true, followPrice: 'fit' };

  it('promotes fit -> track when TIME is released (scroll back, keep the span)', () => {
    const out = applyKill(s, KILL_TIME);
    expect(out.followTime).toBe(false);
    expect(out.followPrice).toBe('track');
  });

  it('switches price OFF when PRICE is released, whatever it was', () => {
    expect(applyKill(s, KILL_PRICE).followPrice).toBe('off');
    expect(applyKill({ ...s, followPrice: 'track' }, KILL_PRICE).followPrice).toBe('off');
    expect(applyKill(s, KILL_PRICE).followTime).toBe(true);
  });

  it('a both-axis kill switches price off rather than promoting it', () => {
    const out = applyKill(s, KILL_BOTH);
    expect(out.followTime).toBe(false);
    expect(out.followPrice).toBe('off');
  });

  it('never promotes track or off on a time kill', () => {
    expect(applyKill({ ...s, followPrice: 'off' }, KILL_TIME).followPrice).toBe('off');
    expect(applyKill({ ...s, followPrice: 'track' }, KILL_TIME).followPrice).toBe('track');
  });
});

describe('priceFrame — the pure auto-fit framing rule', () => {
  it('pads proportionally and clamps to the grid', () => {
    const f = priceFrame(100, 200, ROWS, 0.08, 3);
    expect(f.rowBottom).toBe(92); // 100 - round(100*0.08)
    expect(f.rowSpan).toBe(117); // (200+8+1) - 92
  });

  it('honours the minimum pad for a razor-thin book', () => {
    const f = priceFrame(300, 300, ROWS, 0.08, 3);
    expect(f.rowBottom).toBe(297);
    expect(f.rowSpan).toBe(7); // 304 - 297
  });

  it('never runs off either end of the grid', () => {
    expect(priceFrame(0, 5, ROWS, 0.08, 3).rowBottom).toBe(0);
    const top = priceFrame(ROWS - 2, ROWS - 1, ROWS, 0.08, 3);
    expect(top.rowBottom + top.rowSpan).toBe(ROWS);
  });
});
