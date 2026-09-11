import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetQuoteFeedForTest,
  subscribeQuotes,
  type Quote,
  type VisibilitySource,
} from './quoteFeed';

function quote(partial: Partial<Quote> = {}): Quote {
  return {
    market: 'sim',
    symbol: 'A',
    price: 100,
    changePct: 1.5,
    spark: [1, 2, 3],
    stale: false,
    reachable: true,
    ...partial,
  };
}

/** Visibility double: mutable hidden flag + manual change fan-out. */
function fakeVisibility(initialHidden = false): VisibilitySource & { setHidden: (v: boolean) => void } {
  let hidden = initialHidden;
  const cbs = new Set<() => void>();
  return {
    isHidden: () => hidden,
    onChange: (cb) => {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    setHidden: (v) => {
      hidden = v;
      for (const cb of cbs) cb();
    },
  };
}

function okResponse(body: Quote): { ok: true; json: () => Promise<Quote> } {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetQuoteFeedForTest();
});

afterEach(() => {
  resetQuoteFeedForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('subscribeQuotes', () => {
  it('dedupes duplicate keys and polls market:symbol from /api/quote', async () => {
    const fetchMock = vi.fn(async (_url: string) => okResponse(quote()));
    vi.stubGlobal('fetch', fetchMock);
    const cb = vi.fn();
    const off = subscribeQuotes(['sim:A', 'sim:A'], cb, {
      visibility: fakeVisibility(),
      intervalMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/quote?market=sim&symbol=A');
    expect(cb).toHaveBeenCalledWith('sim:A', expect.objectContaining({ price: 100 }));
    off();
  });

  it('skips malformed keys instead of inventing a request', async () => {
    const fetchMock = vi.fn(async () => okResponse(quote()));
    vi.stubGlobal('fetch', fetchMock);
    const off = subscribeQuotes(['no-colon', ':empty', 'sim:'], vi.fn(), {
      visibility: fakeVisibility(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    off();
  });

  it('keeps a single in-flight fetch per key (a slow provider never stacks)', async () => {
    const resolvers: Array<(r: unknown) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise((res) => {
          resolvers.push(res);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const off = subscribeQuotes(['sim:A'], vi.fn(), {
      visibility: fakeVisibility(),
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(3_500); // initial fetch + three skipped ticks
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolvers[0](okResponse(quote()));
    await vi.advanceTimersByTimeAsync(1_000); // request settled → next cycle fetches
    expect(fetchMock).toHaveBeenCalledTimes(2);
    off();
  });

  it('pauses polling while hidden and refreshes immediately on show', async () => {
    const vis = fakeVisibility();
    const fetchMock = vi.fn(async () => okResponse(quote()));
    vi.stubGlobal('fetch', fetchMock);
    const off = subscribeQuotes(['sim:A'], vi.fn(), { visibility: vis, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // immediate refresh on subscribe

    vis.setHidden(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // paused — nothing on the wire

    vis.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2); // immediate refresh on visible
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(3); // cadence resumed
    off();
  });

  it('starts paused when subscribed hidden; the first show polls', async () => {
    const vis = fakeVisibility(true);
    const fetchMock = vi.fn(async () => okResponse(quote()));
    vi.stubGlobal('fetch', fetchMock);
    const off = subscribeQuotes(['sim:A'], vi.fn(), { visibility: vis, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).not.toHaveBeenCalled();
    vis.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    off();
  });

  it('hands the server payload through verbatim — never fabricates fields', async () => {
    const payload = quote({
      market: 'binance',
      symbol: 'BTCUSDT',
      price: null,
      changePct: null,
      spark: [],
      stale: true,
      reachable: false,
    });
    const fetchMock = vi.fn(async () => okResponse(payload));
    vi.stubGlobal('fetch', fetchMock);
    const cb = vi.fn();
    const off = subscribeQuotes(['binance:BTCUSDT'], cb, { visibility: fakeVisibility() });
    await vi.advanceTimersByTimeAsync(0);
    expect(cb).toHaveBeenCalledWith('binance:BTCUSDT', payload);
    expect(cb.mock.calls[0][1]).toBe(payload); // same object — no rewrap/redefault
    off();
  });

  it('stays silent on a failed request and retries on the next cycle', async () => {
    let mode: 'down' | 'up' = 'down';
    const fetchMock = vi.fn(async () => {
      if (mode === 'down') throw new Error('network down');
      return okResponse(quote());
    });
    vi.stubGlobal('fetch', fetchMock);
    const cb = vi.fn();
    const off = subscribeQuotes(['sim:A'], cb, { visibility: fakeVisibility(), intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(cb).not.toHaveBeenCalled(); // no fabricated quote on failure

    mode = 'up';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
  });

  it('stays silent on a non-OK HTTP response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const cb = vi.fn();
    const off = subscribeQuotes(['sim:A'], cb, { visibility: fakeVisibility() });
    await vi.advanceTimersByTimeAsync(0);
    expect(cb).not.toHaveBeenCalled();
    off();
  });

  it('aborts the in-flight request when the last subscriber unsubscribes', async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init!.signal as AbortSignal);
      return new Promise(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const off = subscribeQuotes(['sim:A'], vi.fn(), { visibility: fakeVisibility() });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(false);
    off();
    expect(signals[0].aborted).toBe(true);
  });

  it('fans one response out to every subscriber of the key (shared in-flight)', async () => {
    const fetchMock = vi.fn(async () => okResponse(quote()));
    vi.stubGlobal('fetch', fetchMock);
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeQuotes(['sim:A'], a, { visibility: fakeVisibility(), intervalMs: 60_000 });
    const offB = subscribeQuotes(['sim:A'], b, { visibility: fakeVisibility(), intervalMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // B's immediate poll saw A's in-flight request
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });

  it('does not deliver to a hidden subscriber (paused means paused)', async () => {
    const fetchMock = vi.fn(async () => okResponse(quote()));
    vi.stubGlobal('fetch', fetchMock);
    const a = vi.fn();
    const b = vi.fn();
    const visB = fakeVisibility(true); // B starts hidden
    const offA = subscribeQuotes(['sim:A'], a, { visibility: fakeVisibility(), intervalMs: 1_000 });
    const offB = subscribeQuotes(['sim:A'], b, { visibility: visB, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(a).toHaveBeenCalledTimes(1); // visible → immediate poll + delivery
    expect(b).not.toHaveBeenCalled(); // hidden → no immediate poll, no fan-out
    await vi.advanceTimersByTimeAsync(3_000);
    expect(a).toHaveBeenCalledTimes(4);
    expect(b).not.toHaveBeenCalled();
    offA();
    offB();
  });
});
