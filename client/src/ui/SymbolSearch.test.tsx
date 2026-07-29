/**
 * Symbol palette — the venue scope (§9). The picker reaches ~106 venues, and the
 * two behaviours worth pinning are (a) opening it never waits on a venue, and
 * (b) enumerating one is explicit, slow, and honest about both.
 *
 * All fetches are stubbed; nothing here touches the network.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SymbolSearch, type SymbolSearchHandle } from './SymbolSearch';
import { resetVenueCatalog, type VenueInfo } from './symbols';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout, so the palette's keep-the-highlight-visible effect needs a stub.
Element.prototype.scrollIntoView = function scrollIntoView() {
  /* no-op */
};

const VENUES: VenueInfo[] = [
  { id: 'sim', assetClass: 'sim', depth: 'L2', native: true, segments: [] },
  // Native yet synthetic-depth: the badge follows the tier, not the flag.
  { id: 'equity', assetClass: 'equity', depth: 'SYNTH', native: true, segments: [] },
  { id: 'binance', assetClass: 'crypto', depth: 'L2', native: true, segments: ['spot', 'usdm', 'coinm'] },
  { id: 'kraken', assetClass: 'crypto', depth: 'L2-snapshot', native: false, segments: [] },
  { id: 'gateio', assetClass: 'crypto', depth: 'L2-snapshot', native: false, segments: [] },
  // Its listing 502s the first time, then recovers — a transient failure, which
  // is the ONLY interesting kind: a permanent one is indistinguishable from a
  // dead venue, a transient one must not be frozen into the session.
  { id: 'poloniex', assetClass: 'crypto', depth: 'L2-snapshot', native: false, segments: [] },
];

const BUNDLED = [
  { market: 'binance-spot', symbol: 'BTCUSDT', capability: { depth: 'L2', tape: 'tick' } },
  { market: 'equity', symbol: 'AAPL', capability: { depth: 'SYNTH', tape: 'poll' } },
];

// Kraken speaks its own spelling — the point of enumerating a venue live.
const KRAKEN = [
  { market: 'kraken', symbol: 'XBT/USD', capability: { depth: 'L2-snapshot', tape: 'tick' } },
  { market: 'kraken', symbol: 'ETH/USD', capability: { depth: 'L2-snapshot', tape: 'tick' } },
];

const POLONIEX = [{ market: 'poloniex', symbol: 'BTC_USDT', capability: { depth: 'L2-snapshot' } }];

/** Sentinel body: this request answers non-2xx (the transport-failure shape). */
const FAIL = Symbol('http-error');

let calls: string[] = [];
/** Resolver for the deferred kraken listing, so the loading state is observable. */
let releaseKraken: (() => void) | null = null;
/** How many more poloniex listings should 502 before the venue recovers. */
let poloniexFailures = 0;

function body(url: string): unknown | Promise<unknown> {
  if (url.includes('/api/venues')) return { venues: VENUES };
  if (url.includes('/api/movers')) return { movers: [] };
  if (url.includes('/api/quote')) return { market: 'x', symbol: 'y', price: 1, changePct: 0, spark: [] };
  if (url.includes('market=all')) return { symbols: BUNDLED };
  if (url.includes('market=kraken')) {
    return new Promise((resolve) => {
      releaseKraken = () => resolve({ symbols: KRAKEN });
    });
  }
  // An unreachable venue degrades to an empty body server-side, never an error.
  if (url.includes('market=gateio')) return { symbols: [] };
  if (url.includes('market=poloniex')) {
    if (poloniexFailures > 0) {
      poloniexFailures -= 1;
      return FAIL;
    }
    return { symbols: POLONIEX };
  }
  if (url.includes('market=binance-usdm')) {
    return { symbols: [{ market: 'binance-usdm', symbol: 'BTCUSDT', capability: { depth: 'L2' } }] };
  }
  return { symbols: [] };
}

beforeEach(() => {
  calls = [];
  releaseKraken = null;
  poloniexFailures = 0;
  resetVenueCatalog();
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return Promise.resolve(body(url)).then((payload) =>
      payload === FAIL
        ? ({ ok: false, status: 502, json: async () => ({}) } as unknown as Response)
        : ({ ok: true, json: async () => payload } as unknown as Response),
    );
  }) as unknown as typeof fetch;
});

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function render(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <SymbolSearch
        ref={{ current: null } as unknown as React.Ref<SymbolSearchHandle>}
        current="sim:SIM-DEMO"
        onSelect={() => {
          /* no-op */
        }}
      />,
    );
  });
  mounted.push({ container, root });
  return container;
}

/** Let queued promises + the palette's zero-delay effects settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function click(el: Element | null | undefined): void {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Rows commit on mousedown (so the input never loses focus first). */
function press(el: Element | null | undefined): void {
  act(() => {
    el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
}

function palette(): HTMLElement {
  return document.body.querySelector('.sympal') as HTMLElement;
}

function rowMarkets(selector: string): string[] {
  return [...document.body.querySelectorAll(selector)].map((el) => el.getAttribute('data-market') ?? '');
}

async function open(): Promise<HTMLElement> {
  const container = render();
  click(container.querySelector('[data-testid="symbol-search-trigger"]'));
  await settle();
  return container;
}

async function openVenueList(): Promise<HTMLElement> {
  const container = await open();
  click(palette().querySelector('[data-testid="venue-picker-toggle"]'));
  await settle();
  return container;
}

describe('SymbolSearch venue scope — the fast path stays fast', () => {
  it('opens on the bundled market=all universe without enumerating any venue', async () => {
    await open();
    expect(calls.some((u) => u.includes('/api/universe?market=all&limit=1000'))).toBe(true);
    // The only universe call is the bundled one — no venue round trip on open.
    expect(calls.filter((u) => u.includes('/api/universe')).length).toBe(1);
    expect(palette().querySelector('[data-testid="venue-loading"]')).toBeNull();
    expect(palette().querySelector('[data-testid="venue-scope"]')!.textContent).toBe('All markets');
  });

  it('reads the venue catalog once, in the background', async () => {
    await open();
    expect(calls.filter((u) => u.includes('/api/venues')).length).toBe(1);
  });
});

describe('SymbolSearch venue list', () => {
  it('expands segmented venues into market strings and leads with the bundled scope', async () => {
    await openVenueList();
    expect(rowMarkets('[data-testid="venue-row"]')).toEqual([
      'all',
      'sim',
      'equity',
      'binance-spot',
      'binance-usdm',
      'binance-coinm',
      'kraken',
      'gateio',
      'poloniex',
    ]);
  });

  it('badges a ccxt venue L2-SNAPSHOT and a native venue L2, distinctly', async () => {
    await openVenueList();
    const rows = new Map(
      [...document.body.querySelectorAll('[data-testid="venue-row"]')].map((el) => [
        el.getAttribute('data-market'),
        el,
      ]),
    );
    const kraken = rows.get('kraken')!.querySelector('.cap')!;
    const binance = rows.get('binance-usdm')!.querySelector('.cap')!;
    const equity = rows.get('equity')!.querySelector('.cap')!;
    expect(kraken.textContent).toBe('L2-SNAPSHOT');
    expect(binance.textContent).toBe('L2');
    expect(kraken.classList.contains('cap--caution')).toBe(true);
    expect(binance.classList.contains('cap--caution')).toBe(false);
    // Three tiers, three looks: real L2, polled snapshot, fabricated depth.
    expect(equity.textContent).toBe('SYNTH');
    expect(equity.classList.contains('cap--synth')).toBe(true);
  });
});

describe('SymbolSearch venue enumeration — the opt-in slow path', () => {
  it('shows a named loading state while a venue lists, then its own spelling', async () => {
    await openVenueList();
    press(document.body.querySelector('[data-testid="venue-row"][data-market="kraken"]'));
    await settle();

    // The first listing of a venue can take seconds: say so rather than showing
    // an empty list that reads as "this venue has no symbols".
    const loading = palette().querySelector('[data-testid="venue-loading"]')!;
    expect(loading).not.toBeNull();
    expect(loading.textContent).toContain('kraken');
    expect(loading.getAttribute('role')).toBe('status');
    expect(document.body.querySelectorAll('[data-testid="symbol-row"]').length).toBe(0);

    act(() => releaseKraken?.());
    await settle();

    expect(palette().querySelector('[data-testid="venue-loading"]')).toBeNull();
    expect(
      [...document.body.querySelectorAll('[data-testid="symbol-row"]')].map((el) =>
        el.getAttribute('data-symbol'),
      ),
    ).toEqual(['XBT/USD', 'ETH/USD']);
    expect(palette().querySelector('[data-testid="venue-scope"]')!.textContent).toBe('kraken');
  });

  it('memoises a listed venue so re-picking it never re-lists', async () => {
    await openVenueList();
    press(document.body.querySelector('[data-testid="venue-row"][data-market="kraken"]'));
    await settle();
    act(() => releaseKraken?.());
    await settle();
    const listed = calls.filter((u) => u.includes('market=kraken')).length;
    expect(listed).toBe(1);

    // Switch away and back: the session cache answers, no second round trip.
    click(palette().querySelector('[data-testid="venue-picker-toggle"]'));
    await settle();
    press(document.body.querySelector('[data-testid="venue-row"][data-market="all"]'));
    await settle();
    click(palette().querySelector('[data-testid="venue-picker-toggle"]'));
    await settle();
    press(document.body.querySelector('[data-testid="venue-row"][data-market="kraken"]'));
    await settle();

    expect(calls.filter((u) => u.includes('market=kraken')).length).toBe(listed);
    expect(document.body.querySelectorAll('[data-testid="symbol-row"]').length).toBe(2);
  });

  it('says a venue listed nothing instead of looking like an empty search', async () => {
    await openVenueList();
    press(document.body.querySelector('[data-testid="venue-row"][data-market="gateio"]'));
    await settle();
    const empty = palette().querySelector('.sympal__empty')!;
    expect(empty.textContent).toContain('gateio');
    expect(empty.textContent).toContain('listed no symbols');
  });

  it('keeps the chosen venue scope across closing and reopening the palette', async () => {
    const container = await openVenueList();
    press(document.body.querySelector('[data-testid="venue-row"][data-market="binance-usdm"]'));
    await settle();
    expect(palette().querySelector('[data-testid="venue-scope"]')!.textContent).toBe('binance-usdm');

    click(palette().querySelector('.sympal__esc'));
    await settle();
    expect(palette()).toBeNull();

    click(container.querySelector('[data-testid="symbol-search-trigger"]'));
    await settle();
    expect(palette().querySelector('[data-testid="venue-scope"]')!.textContent).toBe('binance-usdm');
    // Reopening lands on the symbol list, not the venue list.
    expect(document.body.querySelectorAll('[data-testid="venue-row"]').length).toBe(0);
  });
});

// A listing that FAILED and a venue that genuinely listed nothing are different
// facts, and only one of them is worth caching. Memoising a transient 502 as `[]`
// turns one bad second into a venue that is dead for the whole session — and
// renders identically to a real empty venue, so nobody can tell.
describe('SymbolSearch venue enumeration — a failed listing', () => {
  /** Pick a venue from the (already open) venue list. */
  async function pick(market: string): Promise<void> {
    press(document.body.querySelector(`[data-testid="venue-row"][data-market="${market}"]`));
    await settle();
  }

  /** Reopen the venue list from the symbol list. */
  async function reopenVenueList(): Promise<void> {
    click(palette().querySelector('[data-testid="venue-picker-toggle"]'));
    await settle();
  }

  function listings(market: string): number {
    return calls.filter((u) => u.includes(`market=${market}`)).length;
  }

  it('reads as FAILED, not as an empty venue', async () => {
    poloniexFailures = 1;
    await openVenueList();
    await pick('poloniex');

    const failed = palette().querySelector('[data-testid="venue-failed"]');
    expect(failed).not.toBeNull();
    expect(failed!.textContent).toContain('poloniex');
    // The honest word: the request did not complete. NOT "listed no symbols",
    // which is the gateio (reachable-but-empty) sentence.
    expect(failed!.textContent).toMatch(/could not be read|failed/i);
    expect(failed!.textContent).not.toContain('listed no symbols');
    // Not stuck pretending to still be loading either.
    expect(palette().querySelector('[data-testid="venue-loading"]')).toBeNull();
  });

  it('says something different from a venue that really listed nothing', async () => {
    poloniexFailures = 1;
    await openVenueList();
    await pick('poloniex');
    const failedText = palette().querySelector('[data-testid="venue-failed"]')!.textContent;
    const failedNote = palette().querySelector('.sympal__scopenote')!.textContent;

    await reopenVenueList();
    await pick('gateio');
    const emptyText = palette().querySelector('.sympal__empty')!.textContent;
    const emptyNote = palette().querySelector('.sympal__scopenote')!.textContent;

    expect(emptyText).toContain('listed no symbols');
    expect(failedText).not.toBe(emptyText);
    expect(failedNote).not.toBe(emptyNote);
  });

  it('is NOT memoised — re-picking the venue retries and recovers', async () => {
    poloniexFailures = 1;
    await openVenueList();
    await pick('poloniex');
    expect(listings('poloniex')).toBe(1);
    expect(palette().querySelector('[data-testid="venue-failed"]')).not.toBeNull();

    // Same venue, second attempt: the session cache must not answer for it.
    await reopenVenueList();
    await pick('poloniex');
    expect(listings('poloniex')).toBe(2);
    expect(palette().querySelector('[data-testid="venue-failed"]')).toBeNull();
    expect(
      [...document.body.querySelectorAll('[data-testid="symbol-row"]')].map((el) =>
        el.getAttribute('data-symbol'),
      ),
    ).toEqual(['BTC_USDT']);
  });

  it('retries on the failure state’s own retry control', async () => {
    poloniexFailures = 1;
    await openVenueList();
    await pick('poloniex');
    click(palette().querySelector('[data-testid="venue-retry"]'));
    await settle();
    expect(listings('poloniex')).toBe(2);
    expect(document.body.querySelectorAll('[data-testid="symbol-row"]').length).toBe(1);
  });

  it('is NOT memoised — closing and reopening the palette retries', async () => {
    poloniexFailures = 1;
    const container = await openVenueList();
    await pick('poloniex');
    expect(listings('poloniex')).toBe(1);

    click(palette().querySelector('.sympal__esc'));
    await settle();
    click(container.querySelector('[data-testid="symbol-search-trigger"]'));
    await settle();

    expect(listings('poloniex')).toBe(2);
    expect(palette().querySelector('[data-testid="venue-failed"]')).toBeNull();
    expect(document.body.querySelectorAll('[data-testid="symbol-row"]').length).toBe(1);
  });

  it('still memoises a SUCCESSFUL empty listing (a real, reachable, empty venue)', async () => {
    await openVenueList();
    await pick('gateio');
    expect(listings('gateio')).toBe(1);
    await reopenVenueList();
    await pick('all');
    await reopenVenueList();
    await pick('gateio');
    // A 200 that says "no symbols" is an answer, not a failure — cache it.
    expect(listings('gateio')).toBe(1);
    expect(palette().querySelector('.sympal__empty')!.textContent).toContain('listed no symbols');
  });
});
