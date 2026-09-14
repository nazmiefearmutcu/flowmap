/**
 * PriceAxis chip tests (campaign 2026-09-11, D2/D4):
 *   - the label must reflect the renderer's mode as polled;
 *   - while tracking cannot act (`liveEdgeVisible === false` on a 'track' mode)
 *     the chip must NOT read TRACK — it reads TRK·WAIT and explains why;
 *   - the toggle is routed through the App callback (persistence) when given,
 *     and falls back to the renderer directly otherwise;
 *   - aria-pressed keeps encoding auto-scale ON/OFF.
 *
 * jsdom has no canvas backing for the gutter — the canvas is inert here; the
 * component only ever writes a ref to it.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PriceFollow } from '../gl/camera';
import type { Renderer } from '../gl/renderer';
import { PriceAxis } from './PriceAxis';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeRenderer {
  priceFollow: PriceFollow;
  liveEdgeVisible: boolean;
  setPriceFollow: ReturnType<typeof vi.fn>;
}

function fakeRenderer(priceFollow: PriceFollow, edgeVisible = true): FakeRenderer {
  const r: FakeRenderer = {
    priceFollow,
    liveEdgeVisible: edgeVisible,
    setPriceFollow: vi.fn((m: PriceFollow) => {
      r.priceFollow = m;
    }),
  };
  return r;
}

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function render(node: JSX.Element): { container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  mounted.push({ container, root });
  return { container };
}

function chip(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('[data-testid="price-auto"]') as HTMLButtonElement;
}

function poll(): void {
  act(() => {
    vi.advanceTimersByTime(150);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

describe('PriceAxis chip', () => {
  it('polls the renderer mode and shows FIT / TRACK / LOCK truthfully', () => {
    const r = fakeRenderer('fit');
    const { container } = render(
      <PriceAxis canvasRef={{ current: null }} rendererRef={{ current: r as unknown as Renderer }} />,
    );
    poll();
    expect(chip(container).textContent).toBe('FIT');
    expect(chip(container).getAttribute('aria-pressed')).toBe('true');

    r.priceFollow = 'track';
    poll();
    expect(chip(container).textContent).toBe('TRACK');

    r.priceFollow = 'off';
    poll();
    expect(chip(container).textContent).toBe('LOCK');
    expect(chip(container).getAttribute('aria-pressed')).toBe('false');
  });

  it('does not read TRACK while tracking cannot act (edge off-screen): TRK·WAIT + honest title', () => {
    const r = fakeRenderer('track', false);
    const { container } = render(
      <PriceAxis canvasRef={{ current: null }} rendererRef={{ current: r as unknown as Renderer }} />,
    );
    poll();
    const c = chip(container);
    expect(c.textContent).not.toBe('TRACK');
    expect(c.textContent).toBe('TRK·WAIT');
    expect(c.getAttribute('data-edge')).toBe('hidden');
    expect(c.title).toContain('live edge is off-screen');
    // Auto-scale is still ARMED — only the "can act right now" truth changed.
    expect(c.getAttribute('aria-pressed')).toBe('true');

    r.liveEdgeVisible = true;
    poll();
    expect(chip(container).textContent).toBe('TRACK');
    expect(chip(container).getAttribute('data-edge')).toBe('visible');
  });

  it('routes the toggle through onSetPriceFollow and never writes the renderer directly', () => {
    const r = fakeRenderer('fit');
    const onSet = vi.fn();
    const { container } = render(
      <PriceAxis
        canvasRef={{ current: null }}
        rendererRef={{ current: r as unknown as Renderer }}
        onSetPriceFollow={onSet}
      />,
    );
    poll();
    act(() => {
      chip(container).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSet).toHaveBeenCalledWith('off');
    expect(r.setPriceFollow).not.toHaveBeenCalled();
    // Optimistic label until the authoritative poll lands.
    expect(chip(container).textContent).toBe('LOCK');

    onSet.mockClear();
    act(() => {
      chip(container).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // r.priceFollow is still 'fit' (the callback owns the renderer write), so
    // the next click arms 'off' again — the component never invents a mode.
    expect(onSet).toHaveBeenCalledWith('off');
  });

  it('falls back to the renderer when no App callback is provided (standalone)', () => {
    const r = fakeRenderer('off');
    const { container } = render(
      <PriceAxis canvasRef={{ current: null }} rendererRef={{ current: r as unknown as Renderer }} />,
    );
    poll();
    expect(chip(container).textContent).toBe('LOCK');
    act(() => {
      chip(container).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(r.setPriceFollow).toHaveBeenCalledWith('track');
    expect(chip(container).textContent).toBe('TRACK');
  });

  // --- QA9-1: born-blank gutter self-heal (no window resize) -----------------

  interface HealRenderer extends FakeRenderer {
    attachOverlaySurfaces: ReturnType<typeof vi.fn>;
    overlays: {
      timeAxis: { canvas: HTMLCanvasElement };
      syncGutters: ReturnType<typeof vi.fn>;
    };
  }

  function healRenderer(): HealRenderer {
    return {
      ...fakeRenderer('fit'),
      attachOverlaySurfaces: vi.fn(),
      overlays: { timeAxis: { canvas: document.createElement('canvas') }, syncGutters: vi.fn() },
    };
  }

  function layoutBox(c: HTMLCanvasElement, w: number, h: number): void {
    Object.defineProperty(c, 'clientWidth', { value: w, configurable: true });
    Object.defineProperty(c, 'clientHeight', { value: h, configurable: true });
  }

  it('self-heals a born-blank gutter: rebinds the live canvas + re-syncs the bitmap', () => {
    const r = healRenderer();
    const { container } = render(
      <PriceAxis canvasRef={{ current: null }} rendererRef={{ current: r as unknown as Renderer }} />,
    );
    const canvas = container.querySelector('.axis-canvas') as HTMLCanvasElement;
    // The defect state: browser-default bitmap (300×150) on a laid-out box.
    canvas.width = 300;
    canvas.height = 150;
    layoutBox(canvas, 61, 231);

    poll();

    expect(r.attachOverlaySurfaces).toHaveBeenCalledWith(canvas, r.overlays.timeAxis.canvas);
    expect(r.overlays.syncGutters).toHaveBeenCalledWith(1);
  });

  it('does not rebind while the gutter bitmap already matches its box', () => {
    const r = healRenderer();
    const { container } = render(
      <PriceAxis canvasRef={{ current: null }} rendererRef={{ current: r as unknown as Renderer }} />,
    );
    const canvas = container.querySelector('.axis-canvas') as HTMLCanvasElement;
    canvas.width = 61;
    canvas.height = 231;
    layoutBox(canvas, 61, 231);

    poll();

    expect(r.attachOverlaySurfaces).not.toHaveBeenCalled();
    expect(r.overlays.syncGutters).not.toHaveBeenCalled();
  });
});
