import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PerfHud } from './PerfHud';

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
});

function fireKey(key: string, target: EventTarget | null = window, init: KeyboardEventInit = {}): void {
  act(() => {
    target!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

describe('PerfHud', () => {
  it('renders nothing while hidden and toggles via the H key', () => {
    const onToggle = vi.fn();
    const { container } = render(
      <PerfHud rendererRef={{ current: null }} visible={false} onToggle={onToggle} />,
    );
    expect(container.querySelector('[data-testid="perf-hud"]')).toBeNull();
    fireKey('h');
    expect(onToggle).toHaveBeenCalledOnce();
    fireKey('H');
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('never toggles while typing or with modifiers', () => {
    const onToggle = vi.fn();
    render(<PerfHud rendererRef={{ current: null }} visible={false} onToggle={onToggle} />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireKey('h', input); // typing context
    fireKey('h', window, { ctrlKey: true }); // Ctrl+H stays with the browser
    expect(onToggle).not.toHaveBeenCalled();
    input.remove();
  });

  it('shows — for every field when the renderer has no stats() (pre-C3 build)', () => {
    const { container } = render(
      <PerfHud rendererRef={{ current: null }} visible onToggle={() => {}} />,
    );
    expect(container.querySelector('[data-testid="perf-hud"]')).not.toBeNull();
    for (const f of ['fps', 'frame', 'uploads', 'draws', 'cache']) {
      expect(container.querySelector(`[data-testid="perfhud-${f}"]`)!.textContent).toBe('—');
    }
  });

  it('renders live stats (C3 shape) and reformats cacheBytes as MB', async () => {
    const stats = { fps: 59.94, frameMs: 0.31, uploads: 4, draws: 12, cacheBytes: 140_509_184 };
    const renderer = { current: { stats: () => stats } as unknown as never };
    const { container } = render(<PerfHud rendererRef={renderer} visible onToggle={() => {}} />);
    // The first tick is synchronous on mount.
    expect(container.querySelector('[data-testid="perfhud-fps"]')!.textContent).toBe('59.9');
    expect(container.querySelector('[data-testid="perfhud-frame"]')!.textContent).toBe('0.3ms');
    expect(container.querySelector('[data-testid="perfhud-uploads"]')!.textContent).toBe('4');
    expect(container.querySelector('[data-testid="perfhud-draws"]')!.textContent).toBe('12');
    expect(container.querySelector('[data-testid="perfhud-cache"]')!.textContent).toBe('134MB');
  });

  it('polls at 2 Hz: a stats update shows up within one poll window', async () => {
    vi.useFakeTimers();
    let stats = { fps: 10, frameMs: 1, uploads: 0, draws: 0, cacheBytes: 0 };
    const renderer = { current: { stats: () => stats } as unknown as never };
    const { container } = render(<PerfHud rendererRef={renderer} visible onToggle={() => {}} />);
    expect(container.querySelector('[data-testid="perfhud-fps"]')!.textContent).toBe('10.0');

    stats = { fps: 60, frameMs: 0.2, uploads: 1, draws: 2, cacheBytes: 0 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(550);
    });
    expect(container.querySelector('[data-testid="perfhud-fps"]')!.textContent).toBe('60.0');
    vi.useRealTimers();
  });

  it('survives a stats() implementation that throws', () => {
    const renderer = {
      current: {
        stats: () => {
          throw new Error('boom');
        },
      } as unknown as never,
    };
    const { container } = render(<PerfHud rendererRef={renderer} visible onToggle={() => {}} />);
    expect(container.querySelector('[data-testid="perfhud-fps"]')!.textContent).toBe('—');
  });
});
