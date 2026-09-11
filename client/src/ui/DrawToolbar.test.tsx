/**
 * DrawToolbar tests (lane CF): visibility toggle (`D` + the exported
 * toggleDrawToolbar), tool arming, swatch/width styling, undo/redo
 * enablement and the confirm-guarded clear-all.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDrawingsForTest, setDrawingsStorage, toggleDrawToolbar, useDrawingsStore } from '../drawings/store';
import type { StorageLike } from '../drawings/persist';
import { DrawToolbar } from './DrawToolbar';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];
let storage: StorageLike;

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function render(node: JSX.Element): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  mounted.push({ container, root });
  return container;
}

function btn(root: HTMLElement, label: string): HTMLButtonElement {
  const el = root.querySelector(`[aria-label="${label}"]`);
  expect(el, `button ${label}`).not.toBeNull();
  return el as HTMLButtonElement;
}

function fireKey(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

beforeEach(() => {
  resetDrawingsForTest();
  storage = memStorage();
  setDrawingsStorage(storage);
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

describe('visibility', () => {
  it('mounts hidden; D toggles; the exported fn toggles too', () => {
    const root = render(<DrawToolbar />);
    expect(root.querySelector('[data-testid="draw-toolbar"]')).toBeNull();
    fireKey('d');
    expect(root.querySelector('[data-testid="draw-toolbar"]')).not.toBeNull();
    fireKey('d');
    expect(root.querySelector('[data-testid="draw-toolbar"]')).toBeNull();
    act(() => toggleDrawToolbar());
    expect(root.querySelector('[data-testid="draw-toolbar"]')).not.toBeNull();
  });

  it('never hijacks modified D or typing targets', () => {
    render(<DrawToolbar />);
    fireKey('d', { ctrlKey: true });
    expect(useDrawingsStore.getState().toolbarVisible).toBe(false);
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    expect(useDrawingsStore.getState().toolbarVisible).toBe(false); // editable target passes
    input.remove();
    fireKey('d');
    expect(useDrawingsStore.getState().toolbarVisible).toBe(true);
  });
});

describe('tools + style', () => {
  it('arms a tool on click (aria-pressed follows), select disarms', () => {
    const root = render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    const trend = btn(root, 'Trend line');
    expect(trend.getAttribute('aria-pressed')).toBe('false');
    act(() => trend.click());
    expect(useDrawingsStore.getState().tool).toBe('trendline');
    expect(trend.getAttribute('aria-pressed')).toBe('true');
    act(() => btn(root, 'Select / move drawings').click());
    expect(useDrawingsStore.getState().tool).toBeNull();
  });

  it('swatches set the default style; width cycles', () => {
    const root = render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    act(() => btn(root, 'Drawing color #e8635f').click());
    expect(useDrawingsStore.getState().defaultStyle.color).toBe('#e8635f');
    expect(useDrawingsStore.getState().defaultStyle.width).toBe(2);
    act(() => btn(root, 'Stroke width').click()); // 2 → 4
    expect(useDrawingsStore.getState().defaultStyle.width).toBe(4);
    act(() => btn(root, 'Stroke width').click()); // 4 → 1
    expect(useDrawingsStore.getState().defaultStyle.width).toBe(1);
  });

  it('a swatch recolors the SELECTED drawing immediately', () => {
    render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    const st = useDrawingsStore.getState();
    st.setScope('crypto', 'TEST');
    st.armTool('hline');
    const d = st.addDraftPoint({ tNs: 0n, price: 5 })!;
    useDrawingsStore.getState().setDefaultStyle({ color: '#123123' });
    expect(useDrawingsStore.getState().items.find((x) => x.id === d.id)!.style.color).toBe('#123123');
  });
});

describe('undo / redo / clear-all', () => {
  function seedTwo(): void {
    act(() => {
      const st = useDrawingsStore.getState();
      st.setScope('crypto', 'TEST');
      for (const price of [1, 2]) {
        st.armTool('hline');
        st.addDraftPoint({ tNs: 0n, price });
      }
    });
  }

  it('undo/redo buttons mirror the stacks', () => {
    const root = render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    const undo = btn(root, 'Undo drawing change');
    const redo = btn(root, 'Redo drawing change');
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(true);
    seedTwo();
    act(() => undo.click());
    expect(useDrawingsStore.getState().items.length).toBe(1);
    expect(redo.disabled).toBe(false);
    act(() => redo.click());
    expect(useDrawingsStore.getState().items.length).toBe(2);
  });

  it('clear-all asks confirm and wipes (undoable)', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const root = render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    seedTwo();
    const clear = btn(root, 'Clear all drawings');
    expect(clear.disabled).toBe(false);
    act(() => clear.click());
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('2 drawings'));
    expect(useDrawingsStore.getState().items.length).toBe(0);
    act(() => btn(root, 'Undo drawing change').click());
    expect(useDrawingsStore.getState().items.length).toBe(2);
  });

  it('declining confirm keeps everything', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const root = render(<DrawToolbar />);
    act(() => toggleDrawToolbar());
    seedTwo();
    act(() => btn(root, 'Clear all drawings').click());
    expect(useDrawingsStore.getState().items.length).toBe(2);
  });
});
