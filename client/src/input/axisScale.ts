/**
 * Axis-scale input math (§9) — wheel/drag deltas → camera zoom factors.
 *
 * Pure and DOM-free (the `input/keys.ts` precedent), so the feel of every
 * gesture is pinned by unit tests rather than by trying it in a browser:
 * `gestures.ts` reads events and calls the controller, this module owns the
 * numbers in between, and `camera.ts` owns the transform. Nothing here touches
 * GL or React.
 *
 * The scale law is exponential in the pixel delta — `factor = exp(px · rate)` —
 * which is what makes zooming feel linear: every notch multiplies the span by
 * the same ratio regardless of how far you have already zoomed, and scrolling
 * back the same distance lands exactly where you started (exp(-x)·exp(x) = 1).
 */

/** exp() rate per pixel of wheel/drag delta. ~1.19× span per 120px notch. */
export const SCALE_RATE = 0.0015;

/** `deltaMode: 1` (lines) → px. One line ≈ 16px. */
export const LINE_TO_PX = 16;

/**
 * `deltaMode: 2` (pages) → px. Rare (some Firefox configurations), and
 * previously unhandled: a page-mode wheel event delivered `deltaY = ±1`, so a
 * full-page scroll gesture nudged the zoom by 0.15% and the axis felt dead.
 */
export const PAGE_TO_PX = 400;

/**
 * Cumulative drag distance (CSS px, from pointerdown) before an axis drag counts
 * as a scale gesture. Guards the click/double-click path: without it a 1px
 * tremor during a click applies a visually null 1.0015× scale that still counts
 * as a user takeover and flips the axis out of auto-scale.
 */
export const DRAG_DEADZONE_PX = 3;

/** Normalise a wheel event's deltaY to pixels regardless of deltaMode. */
export function wheelDeltaPx(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * LINE_TO_PX;
  if (deltaMode === 2) return deltaY * PAGE_TO_PX;
  return deltaY;
}

/**
 * Wheel → span factor. Scroll UP (deltaY < 0) zooms IN, i.e. returns a factor
 * below 1 that SHRINKS the span; scroll down zooms out. Matches the chart
 * canvas's existing feel exactly (same rate, same sign).
 */
export function zoomFactorFromWheel(deltaY: number, deltaMode: number): number {
  return Math.exp(wheelDeltaPx(deltaY, deltaMode) * SCALE_RATE);
}

/**
 * Axis DRAG → span factor (TradingView / Bookmap axis-scale semantics: dragging
 * on the axis stretches or compresses it, it does not pan). Dragging DOWN on the
 * price gutter (`dy > 0`) compresses the price axis — more price on screen, so a
 * factor above 1 — matching the direction the wheel gives for the same visual
 * result. Returns exactly 1 (a no-op) inside the deadzone.
 */
export function scaleFactorFromDrag(dyCss: number): number {
  if (Math.abs(dyCss) < DRAG_DEADZONE_PX) return 1;
  return Math.exp(dyCss * SCALE_RATE);
}

/**
 * Position along an element's box as a fraction in [0,1] — the anchor form the
 * CameraController takes. A gutter has its own pixel box, so converting its
 * local pixel with the GL canvas's dimensions would be an invisible coupling;
 * a fraction is the real semantic intent and is correct for both surfaces
 * (the gutters share the canvas's height/width by CSS-grid construction).
 * Clamped, so a pointer captured outside the element still anchors sanely.
 */
export function fractionAlong(pos: number, size: number): number {
  if (!(size > 0)) return 0.5;
  const f = pos / size;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}
