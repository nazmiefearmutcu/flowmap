/**
 * IndicatorPicker interaction tests: render with raw react-dom (the app's
 * testing-library-free pattern), drive the store through the DOM, and pin the
 * `I`/Esc key behaviour with the same guards the app router uses.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IndicatorPicker, toggleIndicatorPicker } from './IndicatorPicker';
import { resetIndicatorStoreForTest, useIndicatorStore, MAX_ACTIVE_INDICATORS } from '../indicators/store';
import { setTimeframe, getSnapshot as getCandleSnapshot, resetForTest as resetCandles, CANDLE_TIMEFRAMES } from '../candles/store';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function renderPicker(): { container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<IndicatorPicker />);
  });
  mounted.push({ container, root });
  return { container };
}

function fireKey(key: string, target: EventTarget | null = window, init: KeyboardEventInit = {}): void {
  act(() => {
    target!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

function q(container: HTMLElement, sel: string): Element | null {
  return container.querySelector(sel);
}

beforeEach(() => {
  window.localStorage.clear();
  resetIndicatorStoreForTest();
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  resetIndicatorStoreForTest();
  resetCandles();
  window.localStorage.clear();
});

describe('IndicatorPicker — open/close', () => {
  it('renders nothing while closed; `I` opens, Esc and × close', () => {
    const { container } = renderPicker();
    expect(q(container, '[data-testid="indi-picker"]')).toBeNull();

    fireKey('i');
    expect(q(container, '[data-testid="indi-picker"]')).not.toBeNull();

    fireKey('Escape');
    expect(q(container, '[data-testid="indi-picker"]')).toBeNull();

    fireKey('i');
    act(() => {
      q(container, '[data-testid="indi-close"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(q(container, '[data-testid="indi-picker"]')).toBeNull();
  });

  it('toggleIndicatorPicker works with no React context (INT binding)', () => {
    renderPicker();
    act(() => toggleIndicatorPicker());
    expect(useIndicatorStore.getState().pickerOpen).toBe(true);
    act(() => toggleIndicatorPicker());
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
  });

  it('never fires while typing or with modifiers; a dialog-owned Esc is left alone', () => {
    renderPicker();
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireKey('i', input); // typing context
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
    fireKey('I', window, { ctrlKey: true }); // browser reserved
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
    fireKey('i');
    expect(useIndicatorStore.getState().pickerOpen).toBe(true);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    fireKey('Escape', dialog); // a modal owns Escape
    expect(useIndicatorStore.getState().pickerOpen).toBe(true);
    fireKey('Escape', window);
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
    input.remove();
    dialog.remove();
  });
});

describe('IndicatorPicker — registry add/remove', () => {
  it('adds registry entries, shows them active, and removes by instance', () => {
    const { container } = renderPicker();
    fireKey('i');
    act(() => {
      q(container, '[data-testid="indi-add-sma"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(q(container, '[data-testid="indi-active-sma"]')).not.toBeNull();
    expect(useIndicatorStore.getState().active.map((a) => a.defId)).toEqual(['sma']);
    const uid = useIndicatorStore.getState().active[0].uid;
    act(() => {
      q(container, `[data-testid="indi-remove-${uid}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(q(container, '[data-testid="indi-active-empty"]')).not.toBeNull();
  });

  it('disables Add at the cap and reflects the count', () => {
    const { container } = renderPicker();
    fireKey('i');
    act(() => {
      for (let i = 0; i < MAX_ACTIVE_INDICATORS; i += 1) useIndicatorStore.getState().add('ema');
    });
    const add = q(container, '[data-testid="indi-add-sma"]') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(container.textContent).toContain(`${MAX_ACTIVE_INDICATORS}/${MAX_ACTIVE_INDICATORS}`);
  });
});

/** Fire a React-tracked input change (native value setter defeats the value tracker). */
function fireInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('IndicatorPicker — params, colors, timeframe', () => {
  it('param edits clamp through the store schema', () => {
    const { container } = renderPicker();
    fireKey('i');
    act(() => useIndicatorStore.getState().add('sma'));
    const uid = useIndicatorStore.getState().active[0].uid;
    const input = q(container, `[data-testid="indi-param-${uid}-period"]`) as HTMLInputElement;
    fireInput(input, '99999');
    // The store clamped to the schema max (500) regardless of raw input.
    expect(useIndicatorStore.getState().active[0].params.period).toBe(500);
  });

  it('color pick stores an override; the reset chip restores the theme default', () => {
    const { container } = renderPicker();
    fireKey('i');
    act(() => useIndicatorStore.getState().add('vwap'));
    const uid = useIndicatorStore.getState().active[0].uid;
    const color = q(container, `[data-testid="indi-color-${uid}-vwap"]`) as HTMLInputElement;
    fireInput(color, '#112233');
    expect(useIndicatorStore.getState().active[0].colors.vwap).toBe('#112233');
    act(() => {
      q(container, `[data-testid="indi-color-reset-${uid}-vwap"]`)!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(useIndicatorStore.getState().active[0].colors.vwap).toBeNull();
  });

  it('the timeframe select re-points the candle store and persists', () => {
    const { container } = renderPicker();
    fireKey('i');
    const select = q(container, '[data-testid="indi-tf"]') as HTMLSelectElement;
    expect(String(getCandleSnapshot().timeframeNs)).toBe(select.value);
    act(() => {
      select.value = String(CANDLE_TIMEFRAMES[1].ns);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(getCandleSnapshot().timeframeNs).toBe(CANDLE_TIMEFRAMES[1].ns);
    expect(window.localStorage.getItem('flowmap.candles.tf')).toBe(String(CANDLE_TIMEFRAMES[1].ns));
    setTimeframe(CANDLE_TIMEFRAMES[0].ns); // cleanup for other suites
  });
});
