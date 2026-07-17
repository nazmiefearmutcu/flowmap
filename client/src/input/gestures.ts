/**
 * Input gestures (§8.3 / §9, M2 T6) — wheel/drag/keyboard → camera control.
 *
 * This module is deliberately dumb: it translates DOM events into semantic
 * camera intents and calls a {@link CameraController}. It owns NO transform math
 * and NO GL — the controller (the renderer) converts pixels ↔ columns/rows using
 * the live view and mutates the camera, then marks itself dirty. One gesture →
 * one camera mutation → one redraw. Nothing re-rasterizes (the §8.3 invariant).
 *
 * Mapping (documented, per the task):
 *   - wheel, no modifier      → TIME zoom at the cursor column.
 *   - wheel + Shift (or Ctrl) → PRICE zoom at the cursor row.
 *       Zoom factor = exp(deltaY · ZOOM_RATE): scroll up (deltaY<0) zooms IN
 *       (span shrinks), scroll down zooms OUT. deltaMode=line is normalised to
 *       pixels. preventDefault stops the page from scrolling / pinch-zooming.
 *   - pointerdown + drag      → PAN both axes (natural drag: content follows the
 *       cursor). Pointer capture keeps the drag alive outside the canvas.
 *   - keyboard (canvas focused):
 *       ArrowLeft/Right  pan time,  ArrowUp/Down  pan price (fraction of span),
 *       + / =  zoom time in,  - / _  zoom time out (about the center),
 *       F  toggle follow,  R  reset + go live.
 */

/** The imperative surface gestures drive. The renderer implements it. */
export interface CameraController {
  /** Pan by a CSS-pixel delta on the canvas (renderer converts to cols/rows). */
  panByPixels(dxCss: number, dyCss: number): void;
  /** Time zoom by `factor`, anchored at the cursor's CSS-x on the canvas. */
  zoomTimeAtPixel(factor: number, cursorXCss: number): void;
  /** Price zoom by `factor`, anchored at the cursor's CSS-y on the canvas. */
  zoomPriceAtPixel(factor: number, cursorYCss: number): void;
  /** Keyboard time pan: `dir` = -1 (earlier) / +1 (later), magnitude from span. */
  panTimeSteps(dir: number): void;
  /** Keyboard price pan: `dir` = -1 (down) / +1 (up), magnitude from span. */
  panPriceSteps(dir: number): void;
  /** Keyboard time zoom about the viewport center. */
  zoomTimeCentered(factor: number): void;
  /** `F` — toggle auto-follow of the live right edge. */
  toggleFollow(): void;
  /** `R` / Go-Live — reset the view and re-enable follow. */
  goLive(): void;
}

/** exp() rate per pixel of wheel delta. ~1.19× span per 120px notch. */
const ZOOM_RATE = 0.0015;
/** Line-mode wheel delta → px (one line ≈ 16px). */
const LINE_TO_PX = 16;
/** Keyboard +/- time zoom factors (in = shrink span, out = grow span). */
const KEY_ZOOM_IN = 0.8;
const KEY_ZOOM_OUT = 1.25;

/** Normalise a wheel event's deltaY to pixels regardless of deltaMode. */
function wheelPixels(e: WheelEvent): number {
  return e.deltaMode === 1 ? e.deltaY * LINE_TO_PX : e.deltaY;
}

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
    const factor = Math.exp(wheelPixels(e) * ZOOM_RATE);
    const { x, y } = localPoint(canvas, e);
    if (e.shiftKey || e.ctrlKey) {
      ctrl.zoomPriceAtPixel(factor, y);
    } else {
      ctrl.zoomTimeAtPixel(factor, x);
    }
  };

  // --- drag to pan (pointer events, with capture) ---
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let pointerId = -1;

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return; // primary button only
    dragging = true;
    pointerId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
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
    if (dx !== 0 || dy !== 0) ctrl.panByPixels(dx, dy);
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
