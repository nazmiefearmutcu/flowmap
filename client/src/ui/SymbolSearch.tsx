/**
 * Dual-market symbol palette (§9 top bar) — a big, centre-screen search modal in
 * the shape traders expect from TradingView / an exchange search box.
 *
 * - A compact TRIGGER lives in the top bar (current symbol + a ⌘K hint). Clicking
 *   it — or the `/` and ⌘K / Ctrl-K global shortcuts (see input/keys.ts + App) —
 *   opens the modal, which is portalled to <body> and centred over a backdrop.
 * - On open (empty query) it shows THE DAY'S TOP MOVERS across crypto + equity,
 *   each with live price, % change and a mini sparkline (GET /api/movers).
 * - Typing fuzzy-ranks the FULL curated universe (GET /api/universe, fetched once
 *   and matched locally, so it is instant and not a per-keystroke server round
 *   trip) — the substring-only server filter is no longer the ranking.
 * - The active row drives a live preview panel (price / % change / sparkline /
 *   honest capability chips) via GET /api/quote.
 * - Clicking the backdrop, pressing Escape, or selecting a row closes it;
 *   selecting reports `(market, symbol)` up so the App re-subscribes.
 *
 * VENUE SCOPE. The engine reaches ~106 venues, far more than the bundled
 * directory browses, so the palette carries a scope. `all` (the default) is the
 * bundled cross-venue directory and stays the FAST PATH: opening the palette
 * never blocks on a venue. Choosing a venue from the venue list is the opt-in
 * that costs a round trip — `/api/universe?market=<venue>` enumerates it live,
 * in that venue's own symbol spelling, and the FIRST call for a venue can take
 * seconds, so it renders an explicit loading state and the ANSWER is cached per
 * venue for the session (the server caches it for 15 min besides). Only an
 * answer: a listing that FAILED is never cached, because caching one bad second
 * as `[]` would kill the venue for the rest of the session. The chosen scope
 * survives closing the palette; and the three outcomes read as three different
 * things — a venue that listed nothing says so, a listing that failed says THAT
 * and offers a retry, and neither looks like an empty search.
 *
 * Symmetry / honesty (§7, §14): capability chips are shown verbatim off the
 * feed's descriptor, so an equity symbol that cannot reach L2 depth or a true CVD
 * reads `SYNTH` / `SIDE NA` rather than pretending parity with crypto, and a
 * ccxt-served venue reads `L2-SNAPSHOT` rather than borrowing a native feed's
 * `L2`. A symbol whose quote provider is unreachable shows "data unavailable".
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { apiBase } from '../net/serverBase';
import {
  ALL_VENUES,
  capabilityChipClass,
  capabilityChipTitle,
  capabilityChips,
  fuzzyRank,
  marketGroup,
  rankVenueOptions,
  setVenueCatalog,
  venueOptions,
  type SymbolEntry,
  type VenueInfo,
  type VenueOption,
} from './symbols';
import { fmtPct, fmtPrice, sparkDirection, sparkPath } from './spark';

export interface SymbolSearchHandle {
  /** Open the palette (bound to the `/` and ⌘K/Ctrl-K global shortcuts). */
  open: () => void;
  /** Back-compat alias used by the older `/`-focus wiring. */
  focus: () => void;
}

interface SymbolSearchProps {
  /** The currently subscribed `market:symbol` (shown on the trigger). */
  current: string;
  onSelect: (market: string, symbol: string) => void;
}

interface Quote {
  market: string;
  symbol: string;
  price: number | null;
  changePct: number | null;
  spark: number[];
  stale?: boolean;
  reachable?: boolean;
}

interface Mover extends Quote {
  stale: boolean;
}

const GROUP_LABEL: Record<string, string> = {
  crypto: 'Crypto',
  equity: 'Equity',
  sim: 'Sim',
  all: 'All',
};
const QUOTE_DEBOUNCE_MS = 160;
/** Live venue enumeration is uncapped-ish; the server clamps `limit` at 1000. */
const VENUE_LIMIT = 1000;

/** A single search result: a directory entry, optionally enriched with a quote. */
interface Row {
  entry: SymbolEntry;
  quote?: Quote;
}

/**
 * Where the current scope's symbol list stands. `idle` = the bundled `all` scope.
 *
 * `empty` and `failed` are DIFFERENT facts and must never collapse into one:
 * `empty` is a 200 that listed no symbols (a reachable venue with nothing to
 * offer), `failed` is a request that never produced an answer at all.
 */
type ScopeState = 'idle' | 'loading' | 'ready' | 'empty' | 'failed';

async function getJson<T>(path: string, signal: AbortSignal): Promise<T | null> {
  try {
    const r = await fetch(`${apiBase()}${path}`, { signal });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch (err) {
    if ((err as { name?: string })?.name !== 'AbortError') {
      console.warn('[flowmap] palette fetch failed', path, err);
    }
    return null;
  }
}

export const SymbolSearch = forwardRef<SymbolSearchHandle, SymbolSearchProps>(
  function SymbolSearch({ current, onSelect }, ref) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    // Raw highlight index; the RENDER-time `active` below clamps it to the current
    // row count so a shrinking result set can never reference an out-of-bounds row
    // for a frame (a post-commit clamp effect would leave one bad frame committed).
    const [activeState, setActive] = useState(0);
    const [universe, setUniverse] = useState<SymbolEntry[]>([]);
    const [movers, setMovers] = useState<Mover[]>([]);
    const [preview, setPreview] = useState<Quote | null>(null);
    // Venue scope: `all` = the bundled directory (instant), else a market string
    // enumerated live. `venues === null` means /api/venues has not answered yet.
    const [venues, setVenues] = useState<VenueInfo[] | null>(null);
    const [scope, setScope] = useState<string>(ALL_VENUES);
    const [pickingVenue, setPickingVenue] = useState(false);
    const [scopeRows, setScopeRows] = useState<SymbolEntry[] | null>(null);
    const [scopeState, setScopeState] = useState<ScopeState>('idle');
    // Bumped on every venue pick (even a re-pick of the CURRENT scope) and by the
    // retry control, so a failed listing is re-issuable without first switching
    // away to another venue and back — `scope` alone would be a no-op dep there.
    const [scopeAttempt, setScopeAttempt] = useState(0);
    // Per-venue memo so re-picking a venue this session is instant, not another
    // multi-second listing. Held in a ref: it must survive closing the palette.
    // Holds ANSWERS ONLY — a failed listing is deliberately absent, so the next
    // attempt refetches instead of inheriting a fabricated empty list forever.
    const scopeCache = useRef(new Map<string, SymbolEntry[]>());
    const inputRef = useRef<HTMLInputElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const doOpen = useCallback(() => {
      setOpen(true);
      setQuery('');
      setActive(0);
      // The venue LIST closes, but the chosen SCOPE persists across opens — a
      // trader working one venue should not re-pick it every ⌘K.
      setPickingVenue(false);
    }, []);

    useImperativeHandle(ref, () => ({ open: doOpen, focus: doOpen }), [doOpen]);

    // Fetch the universe ONCE (guarded, self-limiting) — kept separate from the
    // movers effect so the universe response resolving doesn't re-trigger movers.
    useEffect(() => {
      if (!open || universe.length !== 0) return;
      const ctrl = new AbortController();
      void getJson<{ symbols: SymbolEntry[] }>('/api/universe?market=all&limit=1000', ctrl.signal).then(
        (b) => b && setUniverse(b.symbols ?? []),
      );
      return () => ctrl.abort();
    }, [open, universe.length]);

    // Fetch the venue catalog ONCE. /api/venues is pure server-side (module
    // constants, no network), so this never delays the rows above — and it makes
    // `marketGroup` answer from the server's assetClass instead of guessing.
    useEffect(() => {
      if (!open || venues !== null) return;
      const ctrl = new AbortController();
      void getJson<{ venues: VenueInfo[] }>('/api/venues', ctrl.signal).then((b) => {
        if (!b) return; // leave `venues` null so the next open retries
        const list = b.venues ?? [];
        setVenueCatalog(list);
        setVenues(list);
      });
      return () => ctrl.abort();
    }, [open, venues]);

    // Enumerate the chosen venue. This is the OPT-IN slow path: the first listing
    // of a venue is a live REST round trip (~1-7 s), so it renders a loading
    // state rather than an empty list, and the result is memoised per venue.
    useEffect(() => {
      if (!open || scope === ALL_VENUES) {
        setScopeRows(null);
        setScopeState('idle');
        return;
      }
      const cached = scopeCache.current.get(scope);
      if (cached) {
        setScopeRows(cached);
        setScopeState(cached.length > 0 ? 'ready' : 'empty');
        return;
      }
      setScopeRows(null);
      setScopeState('loading');
      const ctrl = new AbortController();
      void getJson<{ symbols: SymbolEntry[] }>(
        `/api/universe?market=${encodeURIComponent(scope)}&limit=${VENUE_LIMIT}`,
        ctrl.signal,
      ).then((b) => {
        if (ctrl.signal.aborted) return; // a newer scope superseded this listing
        if (!b) {
          // Non-2xx or a network error: we learned NOTHING about this venue.
          // Leave the cache untouched (mirroring the `/api/venues` effect above,
          // which leaves `venues` null so the next open retries) — memoising `[]`
          // here would freeze one transient 502 into a venue that is dead for the
          // whole session AND indistinguishable from a genuinely empty one.
          setScopeState('failed');
          return;
        }
        const list = b.symbols ?? [];
        scopeCache.current.set(scope, list);
        setScopeRows(list);
        // An unreachable venue degrades to an empty body server-side rather than
        // erroring, so "no rows" is the honest signal to surface, not a spinner.
        setScopeState(list.length > 0 ? 'ready' : 'empty');
      });
      return () => ctrl.abort();
    }, [open, scope, scopeAttempt]);

    // Fetch today's movers + focus the input exactly once per open.
    useEffect(() => {
      if (!open) return;
      const ctrl = new AbortController();
      void Promise.all([
        getJson<{ movers: Mover[] }>('/api/movers?market=crypto&limit=14', ctrl.signal),
        getJson<{ movers: Mover[] }>('/api/movers?market=equity&limit=14', ctrl.signal),
      ]).then(([c, e]) => {
        const merged = [...(c?.movers ?? []), ...(e?.movers ?? [])].sort(
          (a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0),
        );
        setMovers(merged);
      });
      const t = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => {
        ctrl.abort();
        window.clearTimeout(t);
      };
    }, [open]);

    // The visible rows. Scoped to a venue: that venue's own listing, browsable on
    // an empty query. Scoped to `all`: movers on an empty query, fuzzy universe
    // hits otherwise.
    const rows = useMemo<Row[]>(() => {
      const byKey = new Map(movers.map((m) => [`${m.market}:${m.symbol}`, m] as const));
      if (scope !== ALL_VENUES) {
        return fuzzyRank(scopeRows ?? [], query, 120).map((entry) => ({
          entry,
          quote: byKey.get(`${entry.market}:${entry.symbol}`),
        }));
      }
      if (query.trim() === '') {
        return movers.map((m) => ({ entry: { market: m.market, symbol: m.symbol, capability: {} }, quote: m }));
      }
      return fuzzyRank(universe, query, 60).map((entry) => ({
        entry,
        quote: byKey.get(`${entry.market}:${entry.symbol}`),
      }));
    }, [query, movers, universe, scope, scopeRows]);

    // The venue list reuses the SAME input as its filter, so the palette stays one
    // box with two modes rather than growing a second search field.
    const allVenues = useMemo(() => venueOptions(venues ?? []), [venues]);
    const venueRows = useMemo<VenueOption[]>(
      () => (pickingVenue ? rankVenueOptions(allVenues, query) : []),
      [pickingVenue, allVenues, query],
    );
    const scopeOption = useMemo(
      () => allVenues.find((v) => v.market === scope),
      [allVenues, scope],
    );

    const count = pickingVenue ? venueRows.length : rows.length;
    const active = count ? Math.min(activeState, count - 1) : 0;
    const activeRow = pickingVenue ? undefined : rows[active];
    const activeVenue = pickingVenue ? venueRows[active] : undefined;

    // Live preview for the active row: reuse its mover quote if we have one, else
    // fetch /api/quote (debounced) so scanning the list doesn't hammer the server.
    useEffect(() => {
      if (!open || !activeRow) {
        setPreview(null);
        return;
      }
      if (activeRow.quote) {
        setPreview(activeRow.quote);
        return;
      }
      const { market, symbol } = activeRow.entry;
      // Drop the previous row's quote immediately so a symbol NAME never renders
      // over another symbol's live-looking price/%/sparkline during the debounce.
      setPreview(null);
      const ctrl = new AbortController();
      const t = window.setTimeout(() => {
        void getJson<Quote>(
          `/api/quote?market=${encodeURIComponent(market)}&symbol=${encodeURIComponent(symbol)}`,
          ctrl.signal,
        ).then((q) => {
          if (ctrl.signal.aborted) return; // a newer row superseded this fetch
          // On an unreachable/failed provider, resolve to an explicit
          // reachable:false so the honest "data unavailable" state renders —
          // never leave a stale quote standing (§7).
          setPreview(q ?? { market, symbol, price: null, changePct: null, spark: [], reachable: false });
        });
      }, QUOTE_DEBOUNCE_MS);
      return () => {
        ctrl.abort();
        window.clearTimeout(t);
      };
    }, [open, activeRow]);

    const close = useCallback(() => {
      setOpen(false);
      triggerRef.current?.focus();
    }, []);

    const commit = useCallback(
      (row: Row | undefined) => {
        if (!row) return;
        onSelect(row.entry.market, row.entry.symbol);
        // Route through close() so selecting restores focus to the trigger too —
        // otherwise the portal unmounts the focused input and focus drops to
        // <body>, losing a keyboard/screen-reader user's place.
        close();
      },
      [onSelect, close],
    );

    /** Adopt a venue scope and drop back to the symbol list. */
    const chooseVenue = useCallback((market: string) => {
      setScope(market);
      // Count the pick itself, not just a CHANGE of scope: re-picking the venue
      // you are already scoped to is the natural "try that again" gesture after a
      // failed listing, and keying the effect on `scope` alone would ignore it.
      setScopeAttempt((n) => n + 1);
      setPickingVenue(false);
      setQuery('');
      setActive(0);
      inputRef.current?.focus();
    }, []);

    /** Re-issue the current venue's listing (the failure state's retry). */
    const retryScope = useCallback(() => {
      setScopeAttempt((n) => n + 1);
      inputRef.current?.focus();
    }, []);

    const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
      const last = count - 1;
      // Base navigation on the CLAMPED `active`, not a stale raw index.
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (count) setActive(active >= last ? 0 : active + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (count) setActive(active <= 0 ? last : active - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (pickingVenue) {
          if (activeVenue) chooseVenue(activeVenue.market);
        } else {
          commit(rows[active]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // Escape out of the venue list first — one keystroke should not throw
        // away the whole palette just because a sub-list is open.
        if (pickingVenue) {
          setPickingVenue(false);
          setQuery('');
        } else {
          close();
        }
      }
    };

    // Reset the highlight to the top whenever the query or the mode changes.
    // Shrinking result sets are handled by the render-time clamp on `active`, not
    // a post-commit effect, so no out-of-bounds frame can commit.
    useEffect(() => setActive(0), [query, pickingVenue]);
    // Keep the highlighted row scrolled into view.
    useEffect(() => {
      if (!open) return;
      listRef.current?.querySelector(`#sympal-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
    }, [active, open]);

    const previewDir = preview ? sparkDirection(preview.spark) : 0;
    const scopeLabel = scopeOption?.label ?? scope;
    const scopeDepth = scopeOption?.depth ? scopeOption.depth.toUpperCase() : '';
    const placeholder = pickingVenue
      ? 'Filter venues…'
      : scope === ALL_VENUES
        ? 'Search all markets — symbol or venue…'
        : `Search ${scope} — in its own symbol spelling`;

    /** The honest one-liner for the current scope, beside the venue button. */
    const scopeNote = pickingVenue
      ? venues === null
        ? 'reading venue list…'
        : `${venueRows.length} of ${allVenues.length} venues`
      : scope === ALL_VENUES
        ? 'bundled directory — instant, curated'
        : scopeState === 'loading'
          ? 'listing…'
          : scopeState === 'failed'
            ? 'listing failed'
            : scopeState === 'empty'
              ? 'no listing'
              : `${scopeRows?.length ?? 0} symbols`;

    return (
      <>
        <button
          type="button"
          ref={triggerRef}
          className="symsearch__trigger"
          data-testid="symbol-search-trigger"
          onClick={doOpen}
          aria-label="Search symbols"
          title="Search symbols ( / or ⌘K )"
        >
          <span className="symsearch__icon" aria-hidden="true">
            ⌕
          </span>
          <span className="symsearch__current">{current}</span>
          <span className="symsearch__kbd" aria-hidden="true">
            ⌘K
          </span>
        </button>

        {open &&
          createPortal(
            <div
              className="sympal__backdrop"
              data-testid="symbol-search-backdrop"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) close();
              }}
            >
              <div className="sympal" role="dialog" aria-modal="true" aria-label="Symbol search">
                <div className="sympal__head">
                  <span className="sympal__icon" aria-hidden="true">
                    ⌕
                  </span>
                  <input
                    ref={inputRef}
                    className="sympal__input"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    data-testid="symbol-search-input"
                    placeholder={placeholder}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded
                    aria-controls="sympal-listbox"
                    aria-activedescendant={count ? `sympal-opt-${active}` : undefined}
                    aria-label="symbol search"
                  />
                  <button type="button" className="sympal__esc" onClick={close} aria-label="close search">
                    esc
                  </button>
                </div>

                <div className="sympal__scope">
                  <button
                    type="button"
                    className={`sympal__venuebtn${pickingVenue ? ' is-on' : ''}`}
                    data-testid="venue-picker-toggle"
                    aria-expanded={pickingVenue}
                    onClick={() => {
                      setPickingVenue((v) => !v);
                      setQuery('');
                      inputRef.current?.focus();
                    }}
                  >
                    <span className="sympal__venuebtn-k">venue</span>
                    <span className="sympal__venuebtn-v" data-testid="venue-scope">
                      {scopeLabel}
                    </span>
                    <span className="sympal__venuebtn-c" aria-hidden="true">
                      ▾
                    </span>
                  </button>
                  {scopeDepth ? (
                    <span className={capabilityChipClass(scopeDepth)} title={capabilityChipTitle(scopeDepth)}>
                      {scopeDepth}
                    </span>
                  ) : null}
                  <span className="sympal__scopenote">{scopeNote}</span>
                </div>

                <div className="sympal__body">
                  <div
                    className="sympal__list"
                    ref={listRef}
                    id="sympal-listbox"
                    role="listbox"
                    aria-label={pickingVenue ? 'venues' : 'symbols'}
                  >
                    {pickingVenue ? (
                      <>
                        <div className="sympal__section">Venues · {allVenues.length - 1} reachable</div>
                        {venueRows.length === 0 ? (
                          <div className="sympal__empty">
                            {venues === null ? 'loading venues…' : `no venue matches “${query}”`}
                          </div>
                        ) : (
                          venueRows.map((v, idx) => (
                            <div
                              key={v.market}
                              id={`sympal-opt-${idx}`}
                              className={`sympal__vrow${idx === active ? ' is-active' : ''}`}
                              role="option"
                              aria-selected={idx === active}
                              data-testid="venue-row"
                              data-market={v.market}
                              onMouseEnter={() => setActive(idx)}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                chooseVenue(v.market);
                              }}
                            >
                              <span className={`sympal__grp sympal__grp--${v.group}`}>
                                {GROUP_LABEL[v.group] ?? v.group}
                              </span>
                              <span className="sympal__sym">{v.label}</span>
                              <span className="sympal__vmeta">
                                {v.depth ? (
                                  <span
                                    className={capabilityChipClass(v.depth.toUpperCase())}
                                    title={capabilityChipTitle(v.depth.toUpperCase())}
                                  >
                                    {v.depth.toUpperCase()}
                                  </span>
                                ) : null}
                              </span>
                            </div>
                          ))
                        )}
                      </>
                    ) : scopeState === 'loading' ? (
                      // The opt-in slow path: a venue's FIRST listing is a live REST
                      // round trip. Say which venue and that seconds are expected —
                      // an unexplained empty list would read as "no symbols".
                      <div className="sympal__loading" data-testid="venue-loading" role="status" aria-live="polite">
                        <span className="sympal__loadbar" aria-hidden="true" />
                        listing {scope} — a venue's first read can take a few seconds
                      </div>
                    ) : scopeState === 'failed' ? (
                      // A FAILED listing, which is not the same claim as "this
                      // venue has no symbols" — we never got an answer, so we
                      // assert nothing about the venue and cached nothing.
                      <div className="sympal__failed" data-testid="venue-failed" role="status" aria-live="polite">
                        <span className="sympal__failed-h">{scope} could not be read</span>
                        <span className="sympal__failed-s">
                          The listing request failed — this says nothing about whether {scope} has
                          symbols. Nothing was cached, so it is worth another try.
                        </span>
                        <button
                          type="button"
                          className="sympal__retry"
                          data-testid="venue-retry"
                          onClick={retryScope}
                        >
                          retry listing
                        </button>
                      </div>
                    ) : rows.length === 0 ? (
                      <div className="sympal__empty">
                        {scope !== ALL_VENUES
                          ? scopeState === 'empty'
                            ? `${scope} listed no symbols — the venue may be unreachable right now`
                            : `no ${scope} symbol matches “${query}”`
                          : universe.length === 0
                            ? 'loading…'
                            : query.trim() === ''
                              ? 'Top movers unavailable — type to search all crypto + equity symbols.'
                              : `no symbols match “${query}”`}
                      </div>
                    ) : (
                      <>
                        {query.trim() === '' && (
                          <div className="sympal__section">
                            {scope === ALL_VENUES ? 'Top movers today' : `${scope} · ${scopeRows?.length ?? 0} symbols`}
                          </div>
                        )}
                        {rows.map((row, idx) => {
                        const g = marketGroup(row.entry.market);
                        const chg = row.quote?.changePct ?? null;
                        const dir = sparkDirection(row.quote?.spark ?? []);
                        return (
                          <div
                            key={`${row.entry.market}:${row.entry.symbol}`}
                            id={`sympal-opt-${idx}`}
                            className={`sympal__row${idx === active ? ' is-active' : ''}`}
                            role="option"
                            aria-selected={idx === active}
                            data-testid="symbol-row"
                            data-market={row.entry.market}
                            data-symbol={row.entry.symbol}
                            onMouseEnter={() => setActive(idx)}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              commit(row);
                            }}
                          >
                            <span className={`sympal__grp sympal__grp--${g}`}>{GROUP_LABEL[g] ?? g}</span>
                            <span className="sympal__sym">{row.entry.symbol}</span>
                            {row.quote?.spark?.length ? (
                              <svg className="sympal__spark" viewBox="0 0 56 18" preserveAspectRatio="none" aria-hidden="true">
                                <path
                                  d={sparkPath(row.quote.spark, 56, 18)}
                                  className={dir >= 0 ? 'spark-up' : 'spark-down'}
                                  fill="none"
                                />
                              </svg>
                            ) : (
                              // The DEPTH chip only — it is the fidelity claim that
                              // decides whether a row is worth opening, and the
                              // 11-character `L2-SNAPSHOT` would wrap the full set to
                              // three lines per row. The complete honest set is in the
                              // preview panel, which follows the highlighted row.
                              <span className="sympal__caps">
                                {capabilityChips(row.entry.capability)
                                  .slice(0, 1)
                                  .map((c) => (
                                    <span key={c} className={capabilityChipClass(c)} title={capabilityChipTitle(c)}>
                                      {c}
                                    </span>
                                  ))}
                              </span>
                            )}
                            <span className="sympal__px">{fmtPrice(row.quote?.price)}</span>
                            <span
                              className={`sympal__chg${chg == null ? '' : chg >= 0 ? ' is-up' : ' is-down'}`}
                            >
                              {fmtPct(chg)}
                            </span>
                          </div>
                        );
                        })}
                      </>
                    )}
                  </div>

                  <aside className="sympal__preview" aria-label="preview">
                    {pickingVenue ? (
                      activeVenue ? (
                        <>
                          <div className="sympal__pv-sym">{activeVenue.label}</div>
                          <div className="sympal__pv-mkt">
                            {activeVenue.market === ALL_VENUES ? 'bundled directory' : activeVenue.group}
                          </div>
                          <div className="sympal__pv-note">
                            {activeVenue.market === ALL_VENUES
                              ? 'The curated cross-venue shortlist. Pure and instant — no venue round trip.'
                              : activeVenue.native
                                ? 'Native connector: true incremental book diffs, streamed.'
                                : 'Served through ccxt: the book is re-read whole each tick, so depth is a snapshot.'}
                          </div>
                          <div className="sympal__pv-caps">
                            {activeVenue.depth ? (
                              <span
                                className={capabilityChipClass(activeVenue.depth.toUpperCase())}
                                title={capabilityChipTitle(activeVenue.depth.toUpperCase())}
                              >
                                {activeVenue.depth.toUpperCase()}
                              </span>
                            ) : null}
                          </div>
                        </>
                      ) : (
                        <div className="sympal__pv-note">pick the venue to search</div>
                      )
                    ) : activeRow ? (
                      <>
                        <div className="sympal__pv-sym">{activeRow.entry.symbol}</div>
                        <div className="sympal__pv-mkt">{activeRow.entry.market}</div>
                        <div className={`sympal__pv-px ${previewDir >= 0 ? 'is-up' : 'is-down'}`}>
                          {fmtPrice(preview?.price)}
                        </div>
                        <div className={`sympal__pv-chg ${(preview?.changePct ?? 0) >= 0 ? 'is-up' : 'is-down'}`}>
                          {fmtPct(preview?.changePct)}
                        </div>
                        {preview?.spark?.length ? (
                          <svg className="sympal__pv-spark" viewBox="0 0 220 60" preserveAspectRatio="none" aria-hidden="true">
                            <path d={sparkPath(preview.spark, 220, 60, 3)} className={previewDir >= 0 ? 'spark-up' : 'spark-down'} fill="none" />
                          </svg>
                        ) : (
                          <div className="sympal__pv-note">
                            {preview?.reachable === false ? 'data unavailable' : 'no preview'}
                          </div>
                        )}
                        <div className="sympal__pv-caps">
                          {capabilityChips(activeRow.entry.capability).map((c) => (
                            <span key={c} className={capabilityChipClass(c)} title={capabilityChipTitle(c)}>
                              {c}
                            </span>
                          ))}
                        </div>
                        {preview?.stale && <div className="sympal__pv-stale">stale — market closed or last known</div>}
                      </>
                    ) : (
                      <div className="sympal__pv-note">
                        {scope === ALL_VENUES
                          ? 'type to search all crypto + equity symbols'
                          : `type to search ${scope}`}
                      </div>
                    )}
                  </aside>
                </div>

                <div className="sympal__foot">
                  <span><kbd>↑↓</kbd> navigate</span>
                  <span><kbd>↵</kbd> select</span>
                  <span><kbd>esc</kbd> {pickingVenue ? 'back' : 'close'}</span>
                </div>
              </div>
            </div>,
            document.body,
          )}
      </>
    );
  },
);
