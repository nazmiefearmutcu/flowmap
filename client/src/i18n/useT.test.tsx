/**
 * useT hook tests (lane CE): the component re-renders on locale change and
 * renders the new locale's strings.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from './index';
import { useT } from './useT';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  setLocale('en');
});

function Probe(): JSX.Element {
  const t = useT();
  return (
    <span data-testid="probe">
      {t('drawer.title')}|{t('onboarding.stepOf', { current: 1, total: 3 })}
    </span>
  );
}

function render(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<Probe />);
  });
  mounted.push({ container, root });
  return container;
}

describe('useT', () => {
  it('translates in the active locale', () => {
    const container = render();
    expect(container.querySelector('[data-testid="probe"]')!.textContent).toBe(
      'Settings|Step 1 of 3',
    );
  });

  it('re-renders with new strings when the locale changes', () => {
    const container = render();
    act(() => setLocale('tr'));
    expect(container.querySelector('[data-testid="probe"]')!.textContent).toBe(
      'Ayarlar|Adım 1/3',
    );
    act(() => setLocale('en'));
    expect(container.querySelector('[data-testid="probe"]')!.textContent).toBe(
      'Settings|Step 1 of 3',
    );
  });
});
