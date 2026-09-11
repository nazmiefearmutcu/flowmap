/**
 * DrawingLayer tests (lane CF): placement via synthetic pointer events over a
 * FIXED chart map (grid col/row ⇄ px), select-mode drag interception on the
 * container, scoped keyboard (Esc / Delete / Ctrl+Z), and the inline text
 * editor. jsdom has no canvas — the 2D context is a recording stub and the
 * rAF paint loop is driven by timers.
 */

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDrawingsForTest, setDrawingsStorage, useDrawingsStore } from '../drawings/store';
import { useFlowMapStore } from '../state/store';
import type { EpochParams } from '../proto/types';
import { DrawingLayer } from './DrawingLayer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- fixed geometry ----------------------------------------------------------------

/** Epoch: linear price scale p0=0 step=1 (row == price), dt 1 s per column. */
const PARAMS: EpochParams = { epoch: 1, tick: 1, tick_multiple: 1, dt_ns: 1_000_000_000, p0: 0, rows: 1000 };
/** Column⇄time anchor: col 10 carries t0 = 100 s. */
const TIME_BASE = { anchorSeq: 10, anchorT0Ns: 100_000_000_000n, dtNs: 1_000_000_000 };
/** 10 px per column, 10 px per price unit: x = col·10, y = 200 − row·10. */
const MAP = {
  fromChart: (x: number, y: number) => ({ col: x / 10, row: (200 - y) / 10 }),
  toChart: (col: number, row: number) => ({ x: col * 10, y: 200 - row * 10 }),
};

/** px (100..∞) → data time: 10 px per second, x=100 ↔ t=100 s. */
const tAt = (x: number): bigint => 100_000_000_000n + BigInt(Math.round((x - 100) / 10) * 1_000_000_000);
/** px y → price: y=200 ↔ 0, 10 px per unit. */
const priceAt = (y: number): number => (200 - y) / 10;

// --- harness -----------------------------------------------------------------------

const mounted: Array<{ container: HTMLElement; root: Root }> = [];
let storageMap: Map<string, string>;
let host: HTMLElement;
let wrapper: HTMLElement;

function stubCtx(): CanvasRenderingContext2D {
  return {
    canvas: { width: 1, height: 1 },
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
    setLineDash: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

/** The test app: a position:relative stage host owning the layer. */
function HostLayer(): JSX.Element {
  const ref = useRef<HTMLElement | null>(null);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el !== null) host = el;
      }}
      style={{ position: 'relative' }}
    >
      <DrawingLayer
        containerRef={ref}
        chartMap={MAP}
        symbol="TEST"
        market="crypto"
        getTimeBase={() => TIME_BASE}
      />
    </div>
  );
}

async function renderLayer(): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<HostLayer />);
  });
  mounted.push({ container, root });
  wrapper = container.querySelector('[data-testid="drawing-layer"]') as HTMLElement;
  expect(wrapper).not.toBeNull();
}

/** Drain the rAF stub so the paint loop builds the projection. */
async function frame(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

function fire(
  el: Element | Window,
  type: string,
  x: number,
  y: number,
  init: MouseEventInit = {},
): void {
  act(() => {
    const ev = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, ...init });
    (el as Element).dispatchEvent(ev);
  });
}

function fireKey(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

beforeEach(() => {
  resetDrawingsForTest();
  storageMap = new Map<string, string>();
  setDrawingsStorage({
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k)! : null),
    setItem: (k, v) => void storageMap.set(k, v),
    removeItem: (k) => void storageMap.delete(k),
  });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number =>
    setTimeout(() => cb(0), 16) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (h: number) => clearTimeout(h));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(stubCtx());
  useFlowMapStore.setState({ gridEpoch: 1, epochs: new Map([[1, PARAMS]]) });
});

afterEach(async () => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    await act(async () => root.unmount());
    container.remove();
  }
  resetDrawingsForTest();
  useFlowMapStore.setState({ gridEpoch: null, epochs: new Map() });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('scope + armed placement', () => {
  it('loads the per-symbol scope on mount', async () => {
    await renderLayer();
    await frame();
    expect(useDrawingsStore.getState().symbol).toBe('TEST');
    expect(useDrawingsStore.getState().market).toBe('crypto');
  });

  it('arms the overlay (pointer-events class) and draws on DRAG', async () => {
    await renderLayer();
    await frame();
    act(() => useDrawingsStore.getState().armTool('trendline'));
    expect(wrapper.className).toContain('is-armed');

    fire(wrapper, 'pointerdown', 100, 100); // (t=100s, price 10)
    fire(wrapper, 'pointermove', 140, 60); // (t=104s, price 14)
    fire(wrapper, 'pointerup', 140, 60);
    const s = useDrawingsStore.getState();
    expect(s.items.length).toBe(1);
    expect(s.items[0].tool).toBe('trendline');
    expect(s.items[0].points[0]).toEqual({ tNs: 100_000_000_000n, price: 10 });
    expect(s.items[0].points[1]).toEqual({ tNs: 104_000_000_000n, price: 14 });
    expect(s.tool).toBeNull(); // draw once → back to select
    expect(s.selectedId).toBe(s.items[0].id);
    // persisted bigint-exact
    const raw = [...storageMap.values()][0];
    expect(raw).toContain('"tNs":"100000000000"');
    expect(raw).toContain('"tNs":"104000000000"');
  });

  it('click-click mode: a click without movement parks the draft; Esc cancels it', async () => {
    await renderLayer();
    await frame();
    act(() => useDrawingsStore.getState().armTool('fib'));
    fire(wrapper, 'pointerdown', 100, 100);
    fire(wrapper, 'pointerup', 100, 100);
    expect(useDrawingsStore.getState().draftPoints.length).toBe(1);
    expect(useDrawingsStore.getState().items.length).toBe(0);
    fireKey('Escape'); // draft gone, tool still armed
    expect(useDrawingsStore.getState().draftPoints.length).toBe(0);
    expect(useDrawingsStore.getState().tool).toBe('fib');
    fireKey('Escape'); // second Esc disarms
    expect(useDrawingsStore.getState().tool).toBeNull();
  });

  it('arity-1 hline finalizes on the first click', async () => {
    await renderLayer();
    await frame();
    act(() => useDrawingsStore.getState().armTool('hline'));
    fire(wrapper, 'pointerdown', 120, 80);
    fire(wrapper, 'pointerup', 120, 80);
    const s = useDrawingsStore.getState();
    expect(s.items.length).toBe(1);
    expect(s.items[0].tool).toBe('hline');
    expect(s.items[0].points[0].price).toBe(priceAt(80));
  });
});

describe('select mode: hit + drag on the CONTAINER (layer stays pointer-transparent)', () => {
  /** Draw one trendline (100,100)px → (140,60)px and leave select mode. */
  async function seedTrendline(): Promise<string> {
    await renderLayer();
    await frame();
    const st = useDrawingsStore.getState();
    st.armTool('trendline');
    st.addDraftPoint({ tNs: tAt(100), price: priceAt(100) });
    const d = st.addDraftPoint({ tNs: tAt(140), price: priceAt(60) })!;
    await frame();
    return d.id;
  }

  it('a hit pointerdown selects + a drag translates; empty clicks pass through', async () => {
    const id = await seedTrendline();

    // empty click: NOT selected (the chart keeps its gesture)
    fire(host, 'pointerdown', 300, 10);
    fire(window, 'pointerup', 300, 10);
    expect(useDrawingsStore.getState().selectedId).toBeNull();

    // body hit at the segment midpoint → selected + dragged
    fire(host, 'pointerdown', 120, 80);
    expect(useDrawingsStore.getState().selectedId).toBe(id);
    fire(window, 'pointermove', 160, 100); // Δ = +4 s, −2 price
    fire(window, 'pointerup', 160, 100);
    const pts = useDrawingsStore.getState().items[0].points;
    expect(pts[0]).toEqual({ tNs: 104_000_000_000n, price: 8 });
    expect(pts[1]).toEqual({ tNs: 108_000_000_000n, price: 12 });
  });

  it('handle drag moves ONE anchor (resize)', async () => {
    await seedTrendline();
    const id = useDrawingsStore.getState().selectedId!;
    fire(host, 'pointerdown', 140, 60); // exact anchor 1
    fire(window, 'pointermove', 140, 100); // drag the price down
    fire(window, 'pointerup', 140, 100);
    const pts = useDrawingsStore.getState().items.find((x) => x.id === id)!.points;
    expect(pts[1]).toEqual({ tNs: 104_000_000_000n, price: 10 });
    expect(pts[0]).toEqual({ tNs: 100_000_000_000n, price: 10 }); // anchor 0 untouched
  });

  it('Delete removes the selected drawing; Ctrl+Z / Ctrl+Shift+Z undo and redo it', async () => {
    await seedTrendline();
    expect(useDrawingsStore.getState().items.length).toBe(1);
    // The undo/redo keys are scoped to "layer focused OR a drawing selected".
    // Delete clears the selection, so focus the layer (as a keyboard user
    // would be) before exercising the chord.
    act(() => {
      wrapper.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(wrapper.className).toContain('has-focus');
    fireKey('Delete');
    expect(useDrawingsStore.getState().items.length).toBe(0);
    fireKey('z', { ctrlKey: true });
    expect(useDrawingsStore.getState().items.length).toBe(1);
    fireKey('z', { ctrlKey: true, shiftKey: true });
    expect(useDrawingsStore.getState().items.length).toBe(0);
  });

  it('Ctrl+Z is NOT hijacked when nothing is selected or focused', async () => {
    await renderLayer();
    await frame();
    const st = useDrawingsStore.getState();
    st.armTool('hline');
    st.addDraftPoint({ tNs: tAt(100), price: 10 });
    st.select(null);
    st.undo(); // drain the stack ourselves; the layer is NOT engaged
    const before = useDrawingsStore.getState().items.length;
    fireKey('z', { ctrlKey: true });
    expect(useDrawingsStore.getState().items.length).toBe(before);
  });
});

describe('text labels', () => {
  it('placing text opens the inline editor; Enter commits the label', async () => {
    await renderLayer();
    await frame();
    act(() => useDrawingsStore.getState().armTool('text'));
    fire(wrapper, 'pointerdown', 120, 80);
    fire(wrapper, 'pointerup', 120, 80);
    const input = wrapper.querySelector('[data-testid="drawing-text-input"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'load wall');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const s = useDrawingsStore.getState();
    expect(s.items[0]).toMatchObject({ tool: 'text', text: 'load wall' });
    expect(s.editingTextId).toBeNull();
    expect(wrapper.querySelector('[data-testid="drawing-text-input"]')).toBeNull();
  });

  it('committing an EMPTY label deletes the drawing', async () => {
    await renderLayer();
    await frame();
    act(() => useDrawingsStore.getState().armTool('text'));
    fire(wrapper, 'pointerdown', 120, 80);
    fire(wrapper, 'pointerup', 120, 80);
    const input = wrapper.querySelector('[data-testid="drawing-text-input"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(useDrawingsStore.getState().items.length).toBe(0);
  });
});

describe('repaint on camera move (R2 regression)', () => {
  it('repaints when the chartMap output changes (zoom/pan) with NO store mutation', async () => {
    // A zoom/pan changes neither the time base, nor the epoch params, nor the
    // size/DPR — the paint-loop signature must therefore probe the LIVE camera
    // (two mapped corners), or drawings freeze at their pre-gesture pixels.
    let zoom = 1;
    const zoomMap = {
      fromChart: (x: number, y: number) => ({ col: x / (10 * zoom), row: (200 - y) / (10 * zoom) }),
      toChart: (col: number, row: number) => ({ x: col * 10 * zoom, y: 200 - row * 10 * zoom }),
    };
    function ZoomHost(): JSX.Element {
      const ref = useRef<HTMLElement | null>(null);
      return (
        <div
          ref={(el) => {
            ref.current = el;
            if (el !== null) host = el;
          }}
          style={{ position: 'relative' }}
        >
          <DrawingLayer
            containerRef={ref}
            chartMap={zoomMap}
            symbol="ZOOM"
            market="crypto"
            getTimeBase={() => TIME_BASE}
          />
        </div>
      );
    }

    const myCtx = stubCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(myCtx);
    const paints = (): number => (myCtx as unknown as { clearRect: ReturnType<typeof vi.fn> }).clearRect.mock.calls.length;

    const container = document.createElement('div');
    document.body.appendChild(container);
    let root!: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(<ZoomHost />);
    });
    mounted.push({ container, root });
    wrapper = container.querySelector('[data-testid="drawing-layer"]') as HTMLElement;
    await frame();
    act(() => useDrawingsStore.getState().armTool('hline'));
    fire(wrapper, 'pointerdown', 120, 80); // price (200-80)/10 = 12
    fire(wrapper, 'pointerup', 120, 80);
    await frame(); // paint #1 (the new drawing + draft clearing)
    const afterDraw = paints();
    expect(afterDraw).toBeGreaterThan(0);
    expect(useDrawingsStore.getState().items.length).toBe(1);

    // "Zoom": the map now projects differently. No store mutation happens.
    zoom = 2;
    await frame();
    await frame(); // scheduleNext may bounce through a timeout tick
    await frame();
    expect(paints()).toBeGreaterThan(afterDraw); // repaint happened
    zoom = 1;
  });
});
