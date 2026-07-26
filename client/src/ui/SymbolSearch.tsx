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
 * Symmetry / honesty (§7, §14): capability chips are shown verbatim off the
 * feed's descriptor, so an equity symbol that cannot reach L2 depth or a true CVD
 * reads `SYNTH` / `SIDE NA` rather than pretending parity with crypto. A symbol
 * whose quote provider is unreachable shows an explicit "data unavailable" state.
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
import { capabilityChipClass, capabilityChips, fuzzyRank, marketGroup, type SymbolEntry } from './symbols';
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

const GROUP_LABEL: Record<string, string> = { crypto: 'Crypto', equity: 'Equity', sim: 'Sim' };
const QUOTE_DEBOUNCE_MS = 160;

/** A single search result: a directory entry, optionally enriched with a quote. */
interface Row {
  entry: SymbolEntry;
  quote?: Quote;
}

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
    const inputRef = useRef<HTMLInputElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const doOpen = useCallback(() => {
      setOpen(true);
      setQuery('');
      setActive(0);
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

    // The visible rows: movers on an empty query, fuzzy universe hits otherwise.
    const rows = useMemo<Row[]>(() => {
      if (query.trim() === '') {
        return movers.map((m) => ({ entry: { market: m.market, symbol: m.symbol, capability: {} }, quote: m }));
      }
      const byKey = new Map(movers.map((m) => [`${m.market}:${m.symbol}`, m] as const));
      return fuzzyRank(universe, query, 60).map((entry) => ({
        entry,
        quote: byKey.get(`${entry.market}:${entry.symbol}`),
      }));
    }, [query, movers, universe]);

    const active = rows.length ? Math.min(activeState, rows.length - 1) : 0;
    const activeRow = rows[active];

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

    const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
      const last = rows.length - 1;
      // Base navigation on the CLAMPED `active`, not a stale raw index.
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (rows.length) setActive(active >= last ? 0 : active + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (rows.length) setActive(active <= 0 ? last : active - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        commit(rows[active]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };

    // Reset the highlight to the top whenever the query changes. Shrinking result
    // sets are handled by the render-time clamp on `active`, not a post-commit
    // effect, so no out-of-bounds frame can commit.
    useEffect(() => setActive(0), [query]);
    // Keep the highlighted row scrolled into view.
    useEffect(() => {
      if (!open) return;
      listRef.current?.querySelector(`#sympal-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
    }, [active, open]);

    const previewDir = preview ? sparkDirection(preview.spark) : 0;

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
                    placeholder="Search all markets — symbol or venue…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded
                    aria-controls="sympal-listbox"
                    aria-activedescendant={rows.length ? `sympal-opt-${active}` : undefined}
                    aria-label="symbol search"
                  />
                  <button type="button" className="sympal__esc" onClick={close} aria-label="close search">
                    esc
                  </button>
                </div>

                <div className="sympal__body">
                  <div className="sympal__list" ref={listRef} id="sympal-listbox" role="listbox" aria-label="symbols">
                    {query.trim() === '' && rows.length > 0 && (
                      <div className="sympal__section">Top movers today</div>
                    )}
                    {rows.length === 0 ? (
                      <div className="sympal__empty">
                        {universe.length === 0
                          ? 'loading…'
                          : query.trim() === ''
                            ? 'Top movers unavailable — type to search all crypto + equity symbols.'
                            : `no symbols match “${query}”`}
                      </div>
                    ) : (
                      rows.map((row, idx) => {
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
                              <span className="sympal__caps">
                                {capabilityChips(row.entry.capability).map((c) => (
                                  <span key={c} className={capabilityChipClass(c)}>
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
                      })
                    )}
                  </div>

                  <aside className="sympal__preview" aria-label="preview">
                    {activeRow ? (
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
                            <span key={c} className={capabilityChipClass(c)}>
                              {c}
                            </span>
                          ))}
                        </div>
                        {preview?.stale && <div className="sympal__pv-stale">stale — market closed or last known</div>}
                      </>
                    ) : (
                      <div className="sympal__pv-note">type to search all crypto + equity symbols</div>
                    )}
                  </aside>
                </div>

                <div className="sympal__foot">
                  <span><kbd>↑↓</kbd> navigate</span>
                  <span><kbd>↵</kbd> select</span>
                  <span><kbd>esc</kbd> close</span>
                </div>
              </div>
            </div>,
            document.body,
          )}
      </>
    );
  },
);
