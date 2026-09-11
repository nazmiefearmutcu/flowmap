/**
 * CvdPane idle behaviour. The pane used to re-arm `requestAnimationFrame`
 * unconditionally — a 60 fps spin even with nothing to paint. Pinned here: a
 * CHANGED frame runs at full frame rate, while an idle pane backs off to a slow
 * poll (measured as rAF wakeup count under fake timers — the honest metric, since
 * the whole defect is wakeups, not paint calls).
 *
 * jsdom has no 2D canvas, so the context is a stub and the canvas is given a
 * fake client size; neither affects the scheduling under test.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Renderer } from '../gl/renderer';
import { OVERLAY } from '../gl/overlays/palette';
import { CvdPane, resolveCvdInk } from './CvdPane';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every 2D method the pane touches; property writes land on the object. */
function stubCtx(): CanvasRenderingContext2D {
  const grad = { addColorStop: vi.fn() };
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    setLineDash: vi.fn(),
    createLinearGradient: vi.fn(() => grad),
  } as unknown as CanvasRenderingContext2D;
}

const mounted: Array<{ container: HTMLElement; root: Root }> = [];
let fillRect: ReturnType<typeof vi.fn>;
let rafCount: number;

beforeEach(() => {
  vi.useFakeTimers();
  rafCount = 0;
  fillRect = vi.fn();
  const ctx = { ...stubCtx(), fillRect };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
  // jsdom lays nothing out: give the pane a fixed CSS box.
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 120 });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafCount += 1;
    return setTimeout(() => cb(0), 16) as unknown as number;
  });
  vi.stubGlobal('cancelAnimationFrame', (h: number) => clearTimeout(h));
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLCanvasElement.prototype as { clientWidth?: unknown }).clientWidth;
  delete (HTMLCanvasElement.prototype as { clientHeight?: unknown }).clientHeight;
  vi.useRealTimers();
});

function renderWith(rendererRef: { current: Renderer | null }): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<CvdPane rendererRef={rendererRef} />);
  });
  mounted.push({ container, root });
}

/** A fake renderer whose `newestSeq` grows on every read — a live feed. */
function liveRenderer(): Renderer {
  let seq = 0;
  return {
    timeline: () => ({ viewStartCol: 0, viewEndCol: 10, newestSeq: ++seq, timeBase: null }),
    cvdValueAt: () => 5,
    cvdSeries: () => [{ col: 1, cvd: 2 }],
  } as unknown as Renderer;
}

describe('CvdPane loop pacing', () => {
  it('an idle pane paints once and stops spinning rAF (slow poll, not 60 fps)', () => {
    renderWith({ current: null });
    vi.advanceTimersByTime(500); // half a second of a completely idle chart
    // One paint (the first frame), then the signature never changes.
    expect(fillRect).toHaveBeenCalledTimes(1);
    // The old unconditional loop woke rAF ~31 times in 500 ms; the backed-off
    // idle poll stays far below that.
    expect(rafCount).toBeLessThan(20);
    expect(rafCount).toBeGreaterThan(0);
  });

  it('a live signature resumes full-rate painting immediately', () => {
    const rendererRef: { current: Renderer | null } = { current: null };
    renderWith(rendererRef);
    vi.advanceTimersByTime(500); // idle warm-up
    const idleWakeups = rafCount;

    rendererRef.current = liveRenderer();
    const before = rafCount;
    vi.advanceTimersByTime(480); // a live, changing feed
    // The signature changes every frame → back at the 16 ms cadence (~30 wakes
    // in 480 ms; the idle poll would manage only one or two).
    expect(rafCount - before).toBeGreaterThanOrEqual(12);
    expect(rafCount).toBeGreaterThan(idleWakeups);
    // And it actually repainted the changing series.
    expect(fillRect.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('CvdPane ink tokens (R1-H3)', () => {
  it('dark ground keeps the shipped midnight/amber ink (byte-identical)', () => {
    const ink = resolveCvdInk(
      (name) =>
        ({
          '--chart-bg': '#05080e',
          '--chart-axis': '#a3b0c2',
          '--chart-grid': '#788496',
          '--chart-price': '#f5f8fc',
        })[name] ?? '',
    );
    expect(ink.ground).toBe('#05080e');
    expect(ink.axis).toBe('rgba(163, 176, 194, 0.75)');
    expect(ink.zero).toBe('rgba(120, 132, 150, 0.28)');
    expect(ink.series).toBe(OVERLAY.cvd.css);
    expect(ink.fillTop).toBe('rgba(232, 176, 74, 0.26)');
    expect(ink.fillBottom).toBe('rgba(232, 176, 74, 0.02)');
  });

  it('light ground follows --chart-price / -axis / -grid', () => {
    const ink = resolveCvdInk(
      (name) =>
        ({
          '--chart-bg': '#f3f1ea',
          '--chart-axis': '#3a414d',
          '--chart-grid': '#5a6472',
          '--chart-price': '#0a6158',
        })[name] ?? '',
    );
    expect(ink.axis).toBe('rgba(58, 65, 77, 0.75)');
    expect(ink.zero).toBe('rgba(90, 100, 114, 0.28)');
    expect(ink.series).toBe('rgba(10, 97, 88, 1)');
    expect(ink.fillTop).toBe('rgba(10, 97, 88, 0.26)');
    expect(ink.fillBottom).toBe('rgba(10, 97, 88, 0.02)');
  });

  it('unresolvable tokens fall back to the shipped literals', () => {
    const ink = resolveCvdInk(() => '');
    expect(ink.axis).toBe('rgba(163, 176, 194, 0.75)');
    expect(ink.zero).toBe('rgba(120, 132, 150, 0.28)');
    expect(ink.series).toBe(OVERLAY.cvd.css);
  });
});
