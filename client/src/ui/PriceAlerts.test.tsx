import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addAlert,
  alertsFor,
  clearPersistedForTest,
  resetAlertsForTest,
  setAlertsStorage,
  type StorageLike,
} from '../state/alertsStore';
import { bookStore } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { resetProbeSpotForTest, recordProbeSpot } from './lastProbe';
import { PriceAlerts, marketPriceNow } from './PriceAlerts';

vi.mock('./alertSound', () => ({
  playAlertSound: vi.fn(() => true),
  resetAlertSoundForTest: vi.fn(),
  BEEP_MIN_GAP_MS: 150,
}));

import { playAlertSound } from './alertSound';

const playMock = vi.mocked(playAlertSound);

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

/** Feed the shared book a settled L2 column + a BBO quote. */
function installBook(bidPx = 100, askPx = 102): void {
  const rows = 8;
  const bid = new Float32Array(rows);
  const ask = new Float32Array(rows);
  bookStore.ingestForTest({
    type: 0x03,
    epoch: 0,
    col_seq: 0,
    t0_ns: 0n,
    mode: 0,
    final: true,
    bid,
    ask,
  } as never);
  bookStore.ingestForTest({
    type: 0x06,
    ts_ns: 0n,
    bid_px: bidPx,
    bid_sz: 5,
    ask_px: askPx,
    ask_sz: 7,
  } as never);
}

/** In-memory Storage double. */
function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

beforeEach(() => {
  resetAlertsForTest();
  setAlertsStorage(memStorage());
  clearPersistedForTest();
  playMock.mockClear();
  useFlowMapStore.setState({
    subscription: { market: 'sim', symbol: 'SIM-DEMO', mode: 'live', band: 'native' },
    gridEpoch: 0,
    epochs: new Map([
      [
        0,
        { epoch: 0, tick: 0.5, tick_multiple: 1, dt_ns: 250_000_000, p0: 80, rows: 64 },
      ],
    ]),
  });
  installBook();
});

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  bookStore.resetForTest();
  resetAlertsForTest();
  setAlertsStorage(null);
  clearPersistedForTest();
  resetProbeSpotForTest();
  delete (window as { __flowmapToast?: unknown }).__flowmapToast;
  useFlowMapStore.setState({ subscription: null, gridEpoch: null, epochs: new Map() });
});

/** A fake renderer exposing only overlayRowCss (price row → css y). */
function fakeRenderer(rowToY: (row: number) => number) {
  return { current: { overlayRowCss: rowToY } as unknown as never };
}

function fireKey(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('marketPriceNow', () => {
  it('prefers the BBO mid and falls back to the last trade', () => {
    expect(marketPriceNow()).toBe(101); // (100 + 102) / 2
    // A zero BBO (dead feed) is unusable → the newest trade wins.
    bookStore.ingestForTest({ type: 0x05, ts_ns: 0n, price: 99.5, size: 1, side: 0, venue: 'x' } as never);
    expect(marketPriceNow()).toBe(101);
  });

  it('returns null with an empty book', () => {
    bookStore.resetForTest();
    expect(marketPriceNow()).toBeNull();
  });
});

describe('PriceAlerts', () => {
  it('renders marker lines for the current symbol at the price-mapped rows', () => {
    const a = addAlert('sim:SIM-DEMO', 90, 101)!; // below → row (90−80)/0.5 = 20 → y 200
    const b = addAlert('sim:SIM-DEMO', 110, 101)!; // above → row 60 → y 600
    const { container } = render(<PriceAlerts rendererRef={fakeRenderer((row) => row * 10)} />);
    const lines = container.querySelectorAll('.alert-line');
    expect(lines).toHaveLength(2);
    const byId = new Map<string, HTMLElement>();
    lines.forEach((el) => byId.set(el.getAttribute('data-testid')!, el as HTMLElement));
    expect(byId.get(`alert-line-${a.id}`)!.style.top).toBe('200px');
    expect(byId.get(`alert-line-${b.id}`)!.style.top).toBe('600px');
    expect(byId.get(`alert-line-${a.id}`)!.textContent).toContain('↓');
    expect(byId.get(`alert-line-${b.id}`)!.textContent).toContain('↑');
  });

  it('shows no lines when the renderer or epoch geometry is missing', () => {
    addAlert('sim:SIM-DEMO', 90, 101);
    const { container } = render(<PriceAlerts rendererRef={{ current: null }} />);
    expect(container.querySelectorAll('.alert-line')).toHaveLength(0);
  });

  it('renders nothing without a subscription (standalone mount)', () => {
    useFlowMapStore.setState({ subscription: null });
    addAlert('sim:SIM-DEMO', 90, 101);
    const { container } = render(<PriceAlerts rendererRef={fakeRenderer((r) => r * 10)} />);
    expect(container.querySelector('[data-testid="alerts-chip"]')).toBeNull();
  });

  it('fires a crossing alert: marker switches to triggered+pulse and the toast hook gets the message', async () => {
    vi.useFakeTimers();
    const toasts: string[] = [];
    (window as { __flowmapToast?: unknown }).__flowmapToast = (msg: string) => toasts.push(msg);
    addAlert('sim:SIM-DEMO', 105, 101)!; // above → mid 101, needs ≥ 105
    const { container } = render(<PriceAlerts rendererRef={fakeRenderer((row) => row * 10)} />);
    expect(container.querySelector('.alert-line--triggered')).toBeNull();

    // Cross: new mid 106 (bid 105 / ask 107).
    installBook(105, 107);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const fired = container.querySelector('.alert-line--triggered');
    expect(fired).not.toBeNull();
    expect(fired!.className).toContain('alert-line--pulse');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain('105');
    expect(toasts[0]).toContain('SIM-DEMO'); // P7: the toast names the symbol
    expect(playMock).toHaveBeenCalledTimes(1); // one chime per fired batch

    // Pulse is transient; the triggered state persists.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(container.querySelector('.alert-line--triggered')!.className).not.toContain(
      'alert-line--pulse',
    );
    expect(toasts).toHaveLength(1); // edge-triggered: no re-fire spam
  });

  it('`A` creates an alert at the recorded crosshair price', async () => {
    recordProbeSpot({ price: 97.5, priceDecimals: 2, x: 10, y: 20, at: Date.now() });
    const { container } = render(<PriceAlerts rendererRef={fakeRenderer((row) => row * 10)} />);
    fireKey('a');
    expect(alertsFor('sim:SIM-DEMO')).toHaveLength(1);
    expect(alertsFor('sim:SIM-DEMO')[0].price).toBe(97.5);
    expect(alertsFor('sim:SIM-DEMO')[0].above).toBe(false); // below the mid
    expect(container.querySelectorAll('.alert-line')).toHaveLength(1);
  });

  it('`A` with no crosshair probe (or an off-grid one) is an honest no-op', () => {
    render(<PriceAlerts rendererRef={fakeRenderer((row) => row * 10)} />);
    fireKey('a');
    expect(alertsFor('sim:SIM-DEMO')).toHaveLength(0);
    recordProbeSpot({ price: null, priceDecimals: 2, x: 0, y: 0, at: Date.now() });
    fireKey('a');
    expect(alertsFor('sim:SIM-DEMO')).toHaveLength(0);
  });

  it('`A` is ignored while typing in an input', () => {
    recordProbeSpot({ price: 97.5, priceDecimals: 2, x: 10, y: 20, at: Date.now() });
    render(<PriceAlerts rendererRef={fakeRenderer((row) => row * 10)} />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    });
    input.remove();
    expect(alertsFor('sim:SIM-DEMO')).toHaveLength(0);
  });

  it('the bell chip toggles the popover; delete removes the alert and its line', async () => {
    const a = addAlert('sim:SIM-DEMO', 90, 101)!;
    const { container } = render(<PriceAlerts rendererRef={fakeRenderer((row) => row * 10)} />);
    expect(container.querySelector('[data-testid="alerts-popover"]')).toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="alerts-chip"]')!.click();
    });
    expect(container.querySelector('[data-testid="alerts-popover"]')).not.toBeNull();

    act(() => {
      (container.querySelector(`[data-testid="alert-delete-${a.id}"]`) as HTMLButtonElement).click();
    });
    expect(alertsFor('sim:SIM-DEMO')).toHaveLength(0);
    expect(container.querySelectorAll('.alert-line')).toHaveLength(0);
  });

  it('switching the subscription key swaps the rendered alert set', () => {
    addAlert('sim:SIM-DEMO', 90, 101);
    const { container } = render(<PriceAlerts rendererRef={fakeRenderer((row) => row * 10)} />);
    expect(container.querySelectorAll('.alert-line')).toHaveLength(1);
    act(() => {
      useFlowMapStore.setState({
        subscription: { market: 'binance', symbol: 'BTCUSDT', mode: 'live', band: 'native' },
      });
    });
    expect(container.querySelectorAll('.alert-line')).toHaveLength(0); // other symbol has none
    act(() => {
      addAlert('binance:BTCUSDT', 60000, 59000);
    });
    expect(container.querySelectorAll('.alert-line')).toHaveLength(1);
  });

  it('chimes once per fired BATCH (several crossings in one tick = one beep)', async () => {
    vi.useFakeTimers();
    addAlert('sim:SIM-DEMO', 102, 101)!; // both cross on a 105/107 book
    addAlert('sim:SIM-DEMO', 103, 101)!;
    const { container } = render(
      <PriceAlerts rendererRef={fakeRenderer((row) => row * 10)} soundEnabled />,
    );
    installBook(105, 107);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(container.querySelectorAll('.alert-line--triggered')).toHaveLength(2);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('never chimes when the alertSound setting is off', async () => {
    vi.useFakeTimers();
    addAlert('sim:SIM-DEMO', 105, 101)!;
    const { container } = render(
      <PriceAlerts rendererRef={fakeRenderer((row) => row * 10)} soundEnabled={false} />,
    );
    installBook(105, 107);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(container.querySelector('.alert-line--triggered')).not.toBeNull();
    expect(playMock).not.toHaveBeenCalled();
  });

  it('P7: replay mode never evaluates (or latches) alerts on historical prices', async () => {
    vi.useFakeTimers();
    const toasts: string[] = [];
    (window as { __flowmapToast?: unknown }).__flowmapToast = (msg: string) => toasts.push(msg);
    addAlert('sim:SIM-DEMO', 105, 101)!; // above → a live book crossing would fire
    useFlowMapStore.setState({
      subscription: { market: 'sim', symbol: 'SIM-DEMO', mode: 'replay', band: 'native' },
    });
    const { container } = render(<PriceAlerts rendererRef={fakeRenderer((row) => row * 10)} />);
    installBook(105, 107);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(toasts).toHaveLength(0);
    expect(alertsFor('sim:SIM-DEMO')[0].triggered).toBe(false); // latch NOT burned by replay
    expect(playMock).not.toHaveBeenCalled();

    // Back to LIVE: the real crossing fires immediately.
    act(() => {
      useFlowMapStore.setState({
        subscription: { market: 'sim', symbol: 'SIM-DEMO', mode: 'live', band: 'native' },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(alertsFor('sim:SIM-DEMO')[0].triggered).toBe(true);
    expect(toasts).toHaveLength(1);
    expect(container.querySelector('.alert-line--triggered')).not.toBeNull();
  });
});
