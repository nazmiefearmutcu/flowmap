import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MODE_L2, MODE_SYNTH_PROFILE, MsgType } from '../proto/types';
import { bookStore } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import {
  MeasureTool,
  fmtDeltaPct,
  fmtDeltaPrice,
  fmtDeltaTime,
  priceAtRow,
  sumDepthInBand,
} from './MeasureTool';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function render(node: JSX.Element): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  const handle = { container, root };
  mounted.push(handle);
  return handle;
}

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  bookStore.resetForTest();
  useFlowMapStore.setState({ gridEpoch: null, epochs: new Map(), capability: null });
});

function fireKey(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function firePointer(
  el: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
): void {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
  });
}

/** Drain the rAF the move handler defers its sample to. */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  });
}

/** A 10 px-per-unit linear chart map (container px = 10 × data units). */
const SCALE_MAP = {
  fromChart: (x: number, y: number) => ({ col: x / 10, row: y / 10 }),
  toChart: (col: number, row: number) => ({ x: col * 10, y: row * 10 }),
};

const LIN_EPOCH = {
  epoch: 0,
  tick: 0.5,
  tick_multiple: 1,
  dt_ns: 250_000_000,
  p0: 100,
  rows: 2048,
};

function publishEpoch(): void {
  useFlowMapStore.setState({ gridEpoch: 0, epochs: new Map([[0, LIN_EPOCH]]) });
}

function installBook(rows = 32, ask = true): void {
  const bid = new Float32Array(rows);
  const asks = ask === false ? null : new Float32Array(rows);
  for (let r = 0; r < rows; r += 1) {
    bid[r] = 10;
    if (asks) asks[r] = 20;
  }
  bookStore.ingestForTest({
    type: MsgType.DEPTH_COL,
    epoch: 0,
    col_seq: 0,
    t0_ns: 0n,
    mode: ask ? MODE_L2 : MODE_SYNTH_PROFILE,
    final: true,
    bid,
    ask: asks,
  });
  expect(bookStore.getSnapshot().book).not.toBeNull();
}

describe('MeasureTool pure helpers', () => {
  it('fmtDeltaTime renders human units across magnitudes', () => {
    expect(fmtDeltaTime(250_000_000n)).toBe('250ms');
    expect(fmtDeltaTime(1_250_000_000n)).toBe('1.3s');
    expect(fmtDeltaTime(61_000_000_000n)).toBe('1m 1s');
    expect(fmtDeltaTime(7_300_000_000_000n)).toBe('2h 1m');
    expect(fmtDeltaTime(90_000_000_000_000n)).toBe('1d 1h');
    expect(fmtDeltaTime(-5_000_000_000n)).toBe('5.0s'); // direction never matters
  });

  it('fmtDeltaPrice / fmtDeltaPct sign and format', () => {
    expect(fmtDeltaPrice(4, 1)).toBe('+4.0');
    expect(fmtDeltaPrice(-2.25, 2)).toBe('−2.25');
    expect(fmtDeltaPct(4, 100)).toBe('+4.00%');
    expect(fmtDeltaPct(-1, 200)).toBe('−0.50%');
    expect(fmtDeltaPct(1, 0)).toBe('—');
  });

  it('priceAtRow maps rows through the epoch scale with grid decimals', () => {
    expect(priceAtRow(10, LIN_EPOCH)).toEqual({ price: 105, decimals: 1 });
    expect(priceAtRow(18, LIN_EPOCH)).toEqual({ price: 109, decimals: 1 });
    expect(priceAtRow(10, null)).toBeNull();
  });

  it('sumDepthInBand sums the half-open row band of the current book', () => {
    expect(sumDepthInBand(null, 10, 18)).toBeNull(); // no book
    installBook();
    const b = bookStore.getSnapshot().book;
    // rows [10,18) → 8 rows × 10 bid / 20 ask
    expect(sumDepthInBand(b, 10, 18)).toEqual({ bid: 80, ask: 160 });
    // Order-independent, clamped to the array bounds.
    expect(sumDepthInBand(b, 18, 10)).toEqual({ bid: 80, ask: 160 });
    expect(sumDepthInBand(b, -5, 1e9)).toEqual({ bid: 320, ask: 640 });
  });

  it('sumDepthInBand reports ask=null for single-channel SYNTH books', () => {
    installBook(16, false);
    const b = bookStore.getSnapshot().book;
    expect(sumDepthInBand(b, 0, 16)).toEqual({ bid: 160, ask: null });
  });
});

describe('MeasureTool interaction (affine map)', () => {
  it('M arms, a drag draws a rect + readout, and the result persists after release', async () => {
    publishEpoch();
    installBook();
    const host = document.createElement('div');
    const { container } = render(
      <MeasureTool containerRef={{ current: host }} map={SCALE_MAP} />,
    );
    const overlay = container.querySelector('[data-testid="measure-overlay"]')!;
    expect(overlay.className).not.toContain('is-armed');

    fireKey('m');
    expect(overlay.className).toContain('is-armed');
    expect(container.querySelector('[data-testid="measure-mode"]')).not.toBeNull();

    // Drag from px (100,100) → (150,180): col 10→15, row 10→18.
    firePointer(overlay, 'pointerdown', 100, 100);
    firePointer(overlay, 'pointermove', 130, 140);
    await nextFrame();
    firePointer(overlay, 'pointermove', 150, 180);
    await nextFrame();

    const rectEl = container.querySelector('[data-testid="measure-rect"]') as HTMLElement;
    expect(rectEl).not.toBeNull();
    expect(rectEl.style.left).toBe('100px');
    expect(rectEl.style.top).toBe('100px');
    expect(rectEl.style.width).toBe('50px');
    expect(rectEl.style.height).toBe('80px');

    // Δprice = row 18 → 109 minus row 10 → 105 = +4.0; Δt = 5 cols × 250 ms.
    const readout = container.querySelector('[data-testid="measure-readout"]')!;
    expect(readout.querySelector('[data-testid="measure-dprice"]')!.textContent).toContain('+4.0');
    expect(readout.querySelector('[data-testid="measure-dprice"]')!.textContent).toContain('%');
    expect(readout.querySelector('[data-testid="measure-dtime"]')!.textContent).toBe('1.3s');
    // Depth from the settled book: rows [10,18) → 80 bid / 160 ask.
    expect(readout.querySelector('[data-testid="measure-ddepth"]')!.textContent).toContain('80');
    expect(readout.querySelector('[data-testid="measure-ddepth"]')!.textContent).toContain('160');

    firePointer(overlay, 'pointerup', 150, 180);
    expect(container.querySelector('[data-testid="measure-rect"]')).not.toBeNull(); // persists
  });

  it('works with the default identity map (no map prop at all)', async () => {
    publishEpoch();
    const host = document.createElement('div');
    const { container } = render(<MeasureTool containerRef={{ current: host }} />);
    fireKey('m');
    const overlay = container.querySelector('[data-testid="measure-overlay"]')!;
    firePointer(overlay, 'pointerdown', 10, 20);
    firePointer(overlay, 'pointermove', 30, 50);
    await nextFrame();
    const rectEl = container.querySelector('[data-testid="measure-rect"]') as HTMLElement;
    expect(rectEl.style.left).toBe('10px');
    expect(rectEl.style.top).toBe('20px');
    expect(rectEl.style.width).toBe('20px');
    expect(rectEl.style.height).toBe('30px');
  });

  it('a second click starts a NEW measurement (result replaced, not accumulated)', async () => {
    publishEpoch();
    const host = document.createElement('div');
    const { container } = render(<MeasureTool containerRef={{ current: host }} map={SCALE_MAP} />);
    fireKey('m');
    const overlay = container.querySelector('[data-testid="measure-overlay"]')!;
    firePointer(overlay, 'pointerdown', 10, 10);
    firePointer(overlay, 'pointermove', 50, 50);
    await nextFrame();
    firePointer(overlay, 'pointerup', 50, 50);
    firePointer(overlay, 'pointerdown', 200, 200);
    firePointer(overlay, 'pointerup', 200, 200);
    const rectEl = container.querySelector('[data-testid="measure-rect"]') as HTMLElement;
    expect(rectEl.style.left).toBe('200px');
    expect(rectEl.style.width).toBe('0px'); // a click, not a drag — degenerate rect kept
  });

  it('Esc exits the tool and clears the result; M while typing is ignored', async () => {
    publishEpoch();
    const host = document.createElement('div');
    const { container } = render(<MeasureTool containerRef={{ current: host }} map={SCALE_MAP} />);
    const overlay = container.querySelector('[data-testid="measure-overlay"]')!;

    // Guard: while typing into an input, M must not arm (the letter is text).
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    });
    expect(overlay.className).not.toContain('is-armed');
    input.remove();

    fireKey('m');
    expect(overlay.className).toContain('is-armed');
    firePointer(overlay, 'pointerdown', 10, 10);
    firePointer(overlay, 'pointermove', 60, 60);
    await nextFrame();
    expect(container.querySelector('[data-testid="measure-rect"]')).not.toBeNull();

    fireKey('Escape');
    expect(overlay.className).not.toContain('is-armed');
    expect(container.querySelector('[data-testid="measure-rect"]')).toBeNull();
    expect(container.querySelector('[data-testid="measure-readout"]')).toBeNull();
  });

  it('never maps the pointer while disarmed (canvas gestures keep the pointer)', () => {
    publishEpoch();
    const host = document.createElement('div');
    const fromChart = vi.fn(SCALE_MAP.fromChart);
    const { container } = render(
      <MeasureTool containerRef={{ current: host }} map={{ fromChart, toChart: SCALE_MAP.toChart }} />,
    );
    const overlay = container.querySelector('[data-testid="measure-overlay"]')!;
    firePointer(overlay, 'pointerdown', 10, 10);
    firePointer(overlay, 'pointermove', 50, 50);
    firePointer(overlay, 'pointerup', 50, 50);
    expect(fromChart).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="measure-rect"]')).toBeNull();
  });

  it('shows an honest — when the epoch geometry or the book is missing', async () => {
    const host = document.createElement('div');
    const { container } = render(<MeasureTool containerRef={{ current: host }} map={SCALE_MAP} />);
    fireKey('m');
    const overlay = container.querySelector('[data-testid="measure-overlay"]')!;
    firePointer(overlay, 'pointerdown', 0, 0);
    firePointer(overlay, 'pointermove', 100, 100);
    await nextFrame();
    const readout = container.querySelector('[data-testid="measure-readout"]')!;
    expect(readout.querySelector('[data-testid="measure-dprice"]')!.textContent).toBe('—');
    expect(readout.querySelector('[data-testid="measure-dtime"]')!.textContent).toBe('—');
    expect(readout.querySelector('[data-testid="measure-ddepth"]')!.textContent).toBe('—');
  });
});
