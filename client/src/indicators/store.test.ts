import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_ACTIVE_INDICATORS,
  resetIndicatorStoreForTest,
  toggleIndicatorPicker,
  useIndicatorStore,
} from './store';

const KEY = (symbol: string): string => `flowmap.indicators.${symbol}`;

beforeEach(() => {
  window.localStorage.clear();
  resetIndicatorStoreForTest();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('indicator store — active list', () => {
  it('adds registry entries with default params and rejects unknown ids', () => {
    const added = useIndicatorStore.getState().add('ema');
    expect(added).not.toBeNull();
    expect(added!.params).toEqual({ period: 20 });
    expect(useIndicatorStore.getState().add('no-such-id')).toBeNull();
    expect(useIndicatorStore.getState().active.length).toBe(1);
  });

  it('removes by uid and clearAll empties the list', () => {
    const a = useIndicatorStore.getState().add('sma')!;
    useIndicatorStore.getState().add('rsi')!;
    useIndicatorStore.getState().remove(a.uid);
    expect(useIndicatorStore.getState().active.map((x) => x.defId)).toEqual(['rsi']);
    useIndicatorStore.getState().clearAll();
    expect(useIndicatorStore.getState().active).toEqual([]);
  });

  it('is bounded: adding past the cap evicts the oldest entry', () => {
    for (let i = 0; i < MAX_ACTIVE_INDICATORS + 1; i += 1) {
      useIndicatorStore.getState().add('sma');
    }
    const active = useIndicatorStore.getState().active;
    expect(active.length).toBe(MAX_ACTIVE_INDICATORS);
    // All entries are sma instances; the FIRST added was evicted (uid counter order).
    expect(active[0].uid).not.toBe(active[1].uid);
  });

  it('setParam clamps to the schema (int params snap)', () => {
    const a = useIndicatorStore.getState().add('sma')!;
    useIndicatorStore.getState().setParam(a.uid, 'period', 5000);
    expect(useIndicatorStore.getState().active[0].params.period).toBe(500);
    useIndicatorStore.getState().setParam(a.uid, 'period', 2.7);
    expect(useIndicatorStore.getState().active[0].params.period).toBe(3); // int kind rounds
    useIndicatorStore.getState().setParam(a.uid, 'bogus', 5); // ignored
    expect(useIndicatorStore.getState().active[0].params).toEqual({ period: 3 });
  });

  it('setColor stores overrides and null restores the theme default', () => {
    const a = useIndicatorStore.getState().add('macd')!;
    useIndicatorStore.getState().setColor(a.uid, 'macd', '#ff0000');
    useIndicatorStore.getState().setColor(a.uid, 'bogus', '#00ff00'); // ignored
    expect(useIndicatorStore.getState().active[0].colors).toEqual({ macd: '#ff0000' });
    useIndicatorStore.getState().setColor(a.uid, 'macd', null);
    expect(useIndicatorStore.getState().active[0].colors).toEqual({ macd: null });
  });
});

describe('indicator store — per-symbol persistence', () => {
  it('syncSymbol loads the persisted list for that symbol', () => {
    // Persist a list under BTC-USD by mutating while synced to it.
    useIndicatorStore.getState().syncSymbol('BTC-USD');
    useIndicatorStore.getState().add('vwap');
    const b = useIndicatorStore.getState().add('rsi')!;
    useIndicatorStore.getState().setParam(b.uid, 'period', 21);
    expect(JSON.parse(window.localStorage.getItem(KEY('BTC-USD'))!)).toHaveLength(2);

    // Switch away and back: the list follows the symbol.
    useIndicatorStore.getState().syncSymbol('ETH-USD');
    expect(useIndicatorStore.getState().active).toEqual([]);
    useIndicatorStore.getState().syncSymbol('BTC-USD');
    const active = useIndicatorStore.getState().active;
    expect(active.map((a) => a.defId)).toEqual(['vwap', 'rsi']);
    expect(active[1].params).toEqual({ period: 21 });
  });

  it('a corrupt payload loads as an empty list instead of breaking the session', () => {
    window.localStorage.setItem(KEY('X'), '{not json');
    useIndicatorStore.getState().syncSymbol('X');
    expect(useIndicatorStore.getState().active).toEqual([]);
    window.localStorage.setItem(KEY('Y'), '{"weird": true}');
    useIndicatorStore.getState().syncSymbol('Y');
    expect(useIndicatorStore.getState().active).toEqual([]);
  });

  it('unknown defIds in storage are dropped and params are clamped on load', () => {
    window.localStorage.setItem(
      KEY('Z'),
      JSON.stringify([
        { defId: 'ghost', params: {} },
        { defId: 'sma', params: { period: 99999 }, colors: { sma: '#123abc' } },
      ]),
    );
    useIndicatorStore.getState().syncSymbol('Z');
    const active = useIndicatorStore.getState().active;
    expect(active.length).toBe(1);
    expect(active[0].defId).toBe('sma');
    expect(active[0].params).toEqual({ period: 500 });
    expect(active[0].colors).toEqual({ sma: '#123abc' });
  });

  it('mutations persist under the CURRENT symbol only', () => {
    useIndicatorStore.getState().syncSymbol('A');
    useIndicatorStore.getState().add('ema');
    expect(window.localStorage.getItem(KEY('B'))).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(KEY('A'))!)).toHaveLength(1);
  });
});

describe('picker open state + module toggle', () => {
  it('toggleIndicatorPicker flips the flag from anywhere', () => {
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
    toggleIndicatorPicker();
    expect(useIndicatorStore.getState().pickerOpen).toBe(true);
    toggleIndicatorPicker();
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
    useIndicatorStore.getState().setPickerOpen(true);
    expect(useIndicatorStore.getState().pickerOpen).toBe(true);
    useIndicatorStore.getState().setPickerOpen(false);
    expect(useIndicatorStore.getState().pickerOpen).toBe(false);
  });
});
