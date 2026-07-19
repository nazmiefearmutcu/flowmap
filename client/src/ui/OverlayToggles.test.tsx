import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_OVERLAY_VISIBILITY } from '../gl/overlays/frame';
import { OverlayToggles } from './OverlayToggles';

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

describe('OverlayToggles', () => {
  it('renders a chip per overlay with is-on reflecting visibility', () => {
    const { container } = render(
      <OverlayToggles visibility={DEFAULT_OVERLAY_VISIBILITY} onToggle={() => {}} />,
    );
    const buttons = container.querySelectorAll('button.overlay-toggle');
    expect(buttons.length).toBe(6);
    for (const btn of buttons) {
      expect(btn.getAttribute('aria-pressed')).toBe(String(DEFAULT_OVERLAY_VISIBILITY[
        (btn.textContent === 'BBO'
          ? 'bbo'
          : btn.textContent === 'VWAP'
            ? 'vwap'
            : btn.textContent!.toLowerCase()) as keyof typeof DEFAULT_OVERLAY_VISIBILITY
      ]));
    }
  });

  it('gives every chip a descriptive title and aria-label that expands the abbreviation', () => {
    const { container } = render(
      <OverlayToggles visibility={DEFAULT_OVERLAY_VISIBILITY} onToggle={() => {}} />,
    );
    const byLabel = new Map<string, string>();
    for (const btn of container.querySelectorAll('button.overlay-toggle')) {
      const label = btn.textContent!;
      const title = btn.getAttribute('title');
      const aria = btn.getAttribute('aria-label');
      // title and aria-label are present and identical
      expect(title).toBeTruthy();
      expect(aria).toBe(title);
      byLabel.set(label, title!);
    }
    // bare abbreviations are expanded in the tooltip
    expect(byLabel.get('BBO')).toContain('best bid/offer');
    expect(byLabel.get('VWAP')).toContain('volume-weighted average price');
    expect(byLabel.get('Profile')).toContain('volume profile');
    expect(byLabel.get('Markers')).toBeTruthy();
    expect(byLabel.get('Axes')).toBeTruthy();
    expect(byLabel.get('Bubbles')).toBeTruthy();
  });

  it('invokes onToggle with the overlay key on click', () => {
    const onToggle = vi.fn();
    const { container } = render(
      <OverlayToggles visibility={DEFAULT_OVERLAY_VISIBILITY} onToggle={onToggle} />,
    );
    const bbo = Array.from(container.querySelectorAll('button.overlay-toggle')).find(
      (b) => b.textContent === 'BBO',
    )!;
    act(() => {
      bbo.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onToggle).toHaveBeenCalledWith('bbo');
  });
});
