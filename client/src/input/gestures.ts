/**
 * Input gestures (§8.3 / §9, M2 T6) — wheel/drag/keyboard → camera control.
 *
 * This module is deliberately dumb: it translates DOM events into semantic
 * camera intents and calls a {@link CameraController}. It owns NO transform math
 * and NO GL — the controller (the renderer) converts fractions ↔ columns/rows
 * using the live view and mutates the camera, then marks itself dirty. One
 * gesture → one camera mutation → one redraw. Nothing re-rasterizes (the §8.3
 * invariant). The pixel→factor arithmetic lives in `input/axisScale.ts`.
 *
 * Chart canvas ({@link attachGestures}):
 *   - wheel, no modifier      → TIME zoom at the cursor column.
 *   - wheel + Shift (or Ctrl) → PRICE zoom at the cursor row.
 *       Zoom factor = exp(deltaY · SCALE_RATE): scroll up (deltaY<0) zooms IN
 *       (span shrinks), scroll down zooms OUT. deltaMode line/page is normalised
 *       to pixels. preventDefault stops the page scrolling / pinch-zooming.
 *   - pointerdown + drag      → PAN both axes (natural drag: content follows the
 *       cursor). Pointer capture keeps the drag alive outside the canvas.
 *   - keyboard (canvas focused):
 *       ArrowLeft/Right  pan time,  ArrowUp/Down  pan price (fraction of span),
 *       + / =  zoom time in,  - / _  zoom time out (about the center),
 *       F  toggle TIME follow,  P  toggle PRICE follow,  R  reset + go live.
 *
 * Price gutter ({@link attachAxisGestures}) — TradingView / Bookmap semantics:
 *   - wheel      → PRICE zoom at the cursor row.
 *   - vertical drag → PRICE SCALE about the viewport centre. An axis drag
 *       stretches the axis; it does NOT pan it. (Routing it through a pan would
 *       give the gutter's wheel and drag opposite follow semantics.)
 *   - double-click → restore price auto-fit.
 *
 * **Per-axis follow release.** A drag reports the PEAK displacement it has
 * travelled on each axis since pointerdown; the controller turns that into a
 * per-axis release (see gl/follow.ts `panFollowKill`), so a deliberately
 * horizontal drag keeps price tracking. Sub-threshold movement is BUFFERED
 * rather than applied: below the threshold the deltas accumulate and are applied
 * in one shot on the move that crosses it. Applying them immediately would
 * mutate colCenter while the follow frame is still authoritative, and the next
 * column would snap it back — a visible stutter at the start of every drag.
 */

import { PAN_KILL_MIN_PX } from '../gl/follow';
import type { PriceFollow } from '../gl/camera';
import {
  DRAG_DEADZONE_PX,
  fractionAlong,
  scaleFactorFromDrag,
  zoomFactorFromWheel,
} from './axisScale';

/** Peak absolute displacement of a drag, per axis, since pointerdown. */
export interface DragTotals {
  peakDx: number;
  peakDy: number;
}

/** The imperative surface gestures drive. The renderer implements it. */
export interface CameraController {
  /**
   * Pan by a CSS-pixel delta on the canvas (renderer converts to cols/rows).
   * `drag` carries the peak per-axis displacement so the renderer can decide
   * which axes this gesture takes over.
   */
  panByPixels(dxCss: number, dyCss: number, drag: DragTotals): void;
  /** Time zoom by `factor`, anchored at a [0,1] fraction across the viewport. */
  zoomTimeAtFraction(factor: number, fracX: number): void;
  /** Price zoom by `factor`, anchored at a [0,1] fraction DOWN the viewport. */
  zoomPriceAtFraction(factor: number, fracFromTop: number): void;
  /** Price scale by `factor` about the viewport centre (axis drag). */
  scalePriceCentered(factor: number): void;
  /** Keyboard time pan: `dir` = -1 (earlier) / +1 (later), magnitude from span. */
  panTimeSteps(dir: number): void;
  /** Keyboard price pan: `dir` = -1 (down) / +1 (up), magnitude from span. */
  panPriceSteps(dir: number): void;
  /** Keyboard time zoom about the viewport center. */
  zoomTimeCentered(factor: number): void;
  /** `F` — toggle auto-follow of the live right edge (TIME). */
  toggleFollow(): void;
  /** `P` — toggle price auto-follow ('off' ↔ 'track'). */
  togglePriceFollow(): void;
  /** Set the price follow mode explicitly (gutter double-click, axis chip). */
  setPriceFollow(mode: PriceFollow): void;
  /** Set time follow explicitly (the transport pill, the settings switch). */
  setFollowTime(on: boolean): void;
  /** `R` / Go-Live — reset the view and re-enable both follows. */
  goLive(): void;
}

/** Keyboard +/- time zoom factors (in = shrink span, out = grow span). */
const KEY_ZOOM_IN = 0.8;
const KEY_ZOOM_OUT = 1.25;

/** CSS-pixel cursor position relative to the element's content box. */
function localPoint(el: HTMLElement, e: { clientX: number; clientY: number }): {
  x: number;
  y: number;
} {
  const r = el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/**
 * Attach the gesture listeners to `canvas`, driving `ctrl`. Returns a disposer
 * that removes every listener (the renderer calls it on dispose).
 */
export function attachGestures(canvas: HTMLCanvasElement, ctrl: CameraController): () => void {
  // The canvas must be focusable to receive keyboard events without stealing
  // focus from form controls elsewhere on the page.
  if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');

  const onWheel = (e: WheelEvent): void => {
    // Always own the wheel over the heatmap: no page scroll, no ctrl-pinch zoom.
    e.preventDefault();
    const factor = zoomFactorFromWheel(e.deltaY, e.deltaMode);
    const { x, y } = localPoint(canvas, e);
    if (e.shiftKey || e.ctrlKey) {
      ctrl.zoomPriceAtFraction(factor, fractionAlong(y, canvas.clientHeight));
    } else {
      ctrl.zoomTimeAtFraction(factor, fractionAlong(x, canvas.clientWidth));
    }
  };

  // --- drag to pan (pointer events, with capture) ---
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let originX = 0;
  let originY = 0;
  let peakDx = 0;
  let peakDy = 0;
  // Deltas withheld while under the per-axis release threshold (see file docs).
  let heldDx = 0;
  let heldDy = 0;
  let pointerId = -1;

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return; // primary button only
    dragging = true;
    pointerId = e.pointerId;
    lastX = originX = e.clientX;
    lastY = originY = e.clientY;
    peakDx = peakDy = 0;
    heldDx = heldDy = 0;
    canvas.setPointerCapture?.(pointerId);
    canvas.focus?.();
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (dx === 0 && dy === 0) return;

    const prevPeakDx = peakDx;
    const prevPeakDy = peakDy;
    peakDx = Math.max(peakDx, Math.abs(e.clientX - originX));
    peakDy = Math.max(peakDy, Math.abs(e.clientY - originY));

    // Buffer motion on an axis until it crosses the release threshold, then
    // release the whole accumulated delta on the crossing move.
    const timeArmed = peakDx >= PAN_KILL_MIN_PX;
    const priceArmed = peakDy >= PAN_KILL_MIN_PX;
    let emitDx = dx;
    let emitDy = dy;
    if (!timeArmed) {
      heldDx += dx;
      emitDx = 0;
    } else if (prevPeakDx < PAN_KILL_MIN_PX) {
      emitDx = dx + heldDx;
      heldDx = 0;
    }
    if (!priceArmed) {
      heldDy += dy;
      emitDy = 0;
    } else if (prevPeakDy < PAN_KILL_MIN_PX) {
      emitDy = dy + heldDy;
      heldDy = 0;
    }
    if (emitDx !== 0 || emitDy !== 0) {
      ctrl.panByPixels(emitDx, emitDy, { peakDx, peakDy });
    }
  };

  const endDrag = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    dragging = false;
    canvas.releasePointerCapture?.(pointerId);
    pointerId = -1;
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowLeft':
        ctrl.panTimeSteps(-1);
        break;
      case 'ArrowRight':
        ctrl.panTimeSteps(+1);
        break;
      case 'ArrowUp':
        ctrl.panPriceSteps(+1);
        break;
      case 'ArrowDown':
        ctrl.panPriceSteps(-1);
        break;
      case '+':
      case '=':
        ctrl.zoomTimeCentered(KEY_ZOOM_IN);
        break;
      case '-':
      case '_':
        ctrl.zoomTimeCentered(KEY_ZOOM_OUT);
        break;
      case 'f':
      case 'F':
        ctrl.toggleFollow();
        break;
      case 'p':
        ctrl.togglePriceFollow();
        break;
      case 'P':
        // Shift+P — restore price AUTO-FIT (same as a gutter double-click).
        ctrl.setPriceFollow('fit');
        break;
      case 'r':
      case 'R':
        ctrl.goLive();
        break;
      default:
        return; // leave other keys alone
    }
    e.preventDefault();
  };

  // passive:false so preventDefault on wheel actually suppresses page scroll.
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('keydown', onKeyDown);

  return () => {
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', endDrag);
    canvas.removeEventListener('pointercancel', endDrag);
    canvas.removeEventListener('keydown', onKeyDown);
  };
}

/**
 * Attach PRICE-AXIS gutter gestures — the TradingView interaction the chart
 * canvas cannot provide (there, an unmodified wheel is time zoom).
 *
 * Note the deliberate absence of `preventDefault` in `pointerdown`: cancelling
 * pointerdown suppresses the compatibility mouse events, and `dblclick` is not
 * spec-exempted from that, so it would put the primary way back to auto-fit on
 * unspecified browser behaviour. `touch-action: none` in the gutter's CSS is the
 * only default worth suppressing here.
 */
export function attachAxisGestures(
  el: HTMLElement,
  ctrl: CameraController,
): () => void {
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const { y } = localPoint(el, e);
    ctrl.zoomPriceAtFraction(
      zoomFactorFromWheel(e.deltaY, e.deltaMode),
      fractionAlong(y, el.clientHeight),
    );
  };

  let dragging = false;
  let lastY = 0;
  let originY = 0;
  let pointerId = -1;

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    dragging = true;
    pointerId = e.pointerId;
    lastY = originY = e.clientY;
    el.setPointerCapture?.(pointerId);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging || e.pointerId !== pointerId) return;
    // Deadzone is measured on the CUMULATIVE travel from pointerdown, so a
    // click with 1px of tremor never scales (and never claims the axis).
    if (Math.abs(e.clientY - originY) < DRAG_DEADZONE_PX) return;
    const dy = e.clientY - lastY;
    lastY = e.clientY;
    if (dy === 0) return;
    ctrl.scalePriceCentered(scaleFactorFromDrag(dy));
  };

  const endDrag = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    dragging = false;
    el.releasePointerCapture?.(pointerId);
    pointerId = -1;
  };

  const onDoubleClick = (e: MouseEvent): void => {
    e.preventDefault();
    ctrl.setPriceFollow('fit');
  };

  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('dblclick', onDoubleClick);

  return () => {
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', endDrag);
    el.removeEventListener('pointercancel', endDrag);
    el.removeEventListener('dblclick', onDoubleClick);
  };
}
