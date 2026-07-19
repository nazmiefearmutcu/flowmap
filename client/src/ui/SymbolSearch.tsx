/**
 * Dual-market symbol search (§9 top bar, T12).
 *
 * Debounced query against `GET /api/symbols?q=` (the M1 REST directory: sim +
 * crypto shortlist + equity shortlist), a keyboard-navigable dropdown grouped
 * crypto / equity / sim with each row's honest capability chips. Selecting a row
 * reports `(market, symbol)` up to the App, which re-subscribes the session in the
 * current live/replay mode — the heatmap then switches symbols.
 *
 * Exposes an imperative `focus()` (via ref) so the `/` global shortcut can jump
 * here. High-frequency data never touches this component — it only ever holds the
 * (low-frequency) directory list and its own input state.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { apiBase } from '../net/serverBase';
import {
  capabilityChipClass,
  capabilityChips,
  filterSymbols,
  flattenGroups,
  groupSymbols,
  type SymbolEntry,
} from './symbols';

/** Debounce for the /api/symbols query (ms). */
const QUERY_DEBOUNCE_MS = 200;

export interface SymbolSearchHandle {
  focus: () => void;
}

interface SymbolSearchProps {
  /** The currently subscribed `market:symbol` (shown as the resting field value). */
  current: string;
  onSelect: (market: string, symbol: string) => void;
}

export const SymbolSearch = forwardRef<SymbolSearchHandle, SymbolSearchProps>(
  function SymbolSearch({ current, onSelect }, ref) {
    const [query, setQuery] = useState('');
    const [entries, setEntries] = useState<SymbolEntry[]>([]);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(ref, () => ({
      focus: () => {
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      },
    }));

    // Debounced directory fetch. AbortController cancels the in-flight request so
    // a fast typist never races a stale response into the list.
    useEffect(() => {
      if (!open) return;
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => {
        fetch(`${apiBase()}/api/symbols?q=${encodeURIComponent(query.trim())}`, { signal: ctrl.signal })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`symbols ${r.status}`))))
          .then((body: { symbols?: SymbolEntry[] }) => setEntries(body.symbols ?? []))
          .catch((err) => {
            if (err?.name !== 'AbortError') console.warn('[flowmap] symbol query failed', err);
          });
      }, QUERY_DEBOUNCE_MS);
      return () => {
        ctrl.abort();
        window.clearTimeout(timer);
      };
    }, [query, open]);

    // Close on outside click.
    useEffect(() => {
      if (!open) return;
      const onDown = (e: MouseEvent): void => {
        if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
      };
      window.addEventListener('mousedown', onDown);
      return () => window.removeEventListener('mousedown', onDown);
    }, [open]);

    const groups = groupSymbols(filterSymbols(entries, query));
    const flat = flattenGroups(groups);

    const commit = useCallback(
      (entry: SymbolEntry | undefined) => {
        if (!entry) return;
        onSelect(entry.market, entry.symbol);
        setQuery('');
        setOpen(false);
        inputRef.current?.blur();
      },
      [onSelect],
    );

    const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
      const last = flat.length - 1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
        if (flat.length > 0) setActive((i) => (i >= last ? 0 : i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen(true);
        if (flat.length > 0) setActive((i) => (i <= 0 ? last : i - 1));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActive(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        if (flat.length > 0) setActive(last);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        commit(flat[active]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // First press closes/clears while keeping focus; blur only once the menu
        // is already closed and the query is empty.
        if (open || query !== '') {
          setOpen(false);
          setQuery('');
        } else {
          inputRef.current?.blur();
        }
      }
    };

    // Keep the active index inside the (re-filtered) list.
    useEffect(() => {
      setActive((i) => (i >= flat.length ? Math.max(0, flat.length - 1) : i));
    }, [flat.length]);

    // Reset to the top match whenever the query changes, so Enter commits the
    // first result (the hover path still clamps via the effect above).
    useEffect(() => {
      setActive(0);
    }, [query]);

    // Scroll the keyboard-highlighted option into view so arrowing past the fold
    // never hides the highlight (and never commits an off-screen row).
    useEffect(() => {
      if (!open) return;
      const el = rootRef.current?.querySelector(`#symopt-${active}`);
      el?.scrollIntoView({ block: 'nearest' });
    }, [active, open]);

    let flatIndex = -1; // running index across groups → maps rows to `active`

    return (
      <div className="symsearch" ref={rootRef}>
        <div className="symsearch__field">
          <span className="symsearch__icon" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={inputRef}
            className="symsearch__input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            data-testid="symbol-search-input"
            placeholder={current}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            aria-label="symbol search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls="symsearch-listbox"
            aria-activedescendant={open && flat.length > 0 ? `symopt-${active}` : undefined}
          />
          {query !== '' ? (
            <button
              type="button"
              className="symsearch__kbd symsearch__clear"
              aria-label="clear symbol search"
              data-testid="symbol-search-clear"
              onMouseDown={(e) => {
                // mousedown + preventDefault so the input keeps focus.
                e.preventDefault();
                setQuery('');
                inputRef.current?.focus();
              }}
            >
              ×
            </button>
          ) : (
            <span className="symsearch__kbd" aria-hidden="true">
              /
            </span>
          )}
        </div>

        {open && (
          <div
            className="symsearch__pop"
            data-testid="symbol-search-pop"
            id="symsearch-listbox"
            role="listbox"
            aria-label="symbol results"
          >
            {flat.length === 0 ? (
              <div className="symsearch__empty">no symbols match “{query}”</div>
            ) : (
              groups.map((g) => (
                <div className="symgroup" key={g.key}>
                  <div className="symgroup__label">{g.label}</div>
                  {g.entries.map((entry) => {
                    flatIndex += 1;
                    const idx = flatIndex;
                    return (
                      <div
                        key={`${entry.market}:${entry.symbol}`}
                        id={`symopt-${idx}`}
                        className={`symrow${idx === active ? ' is-active' : ''}`}
                        role="option"
                        aria-selected={idx === active}
                        data-testid="symbol-row"
                        data-market={entry.market}
                        data-symbol={entry.symbol}
                        onMouseEnter={() => setActive(idx)}
                        onMouseDown={(e) => {
                          // mousedown (not click) so the outside-click closer + input
                          // blur don't race the selection away.
                          e.preventDefault();
                          commit(entry);
                        }}
                      >
                        <span className="symrow__sym">{entry.symbol}</span>
                        <span className="symrow__caps">
                          {capabilityChips(entry.capability).map((c) => (
                            <span key={c} className={capabilityChipClass(c)}>
                              {c}
                            </span>
                          ))}
                        </span>
                        {entry.note && <span className="symrow__note">{entry.note}</span>}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    );
  },
);
