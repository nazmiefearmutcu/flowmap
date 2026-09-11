/**
 * Active-indicator store (campaign 3, lane CG) — which indicators are on the
 * chart, with which params and colors, per symbol.
 *
 * Small zustand slice (the app's own store is session state; this is a lane
 * feature, kept self-contained). Persistence is per-symbol localStorage under
 * `flowmap.indicators.<symbol>`; the active list is BOUNDED at
 * {@link MAX_ACTIVE_INDICATORS} — adding past the bound evicts the OLDEST
 * active entry (a hard UI cap, not silent corruption).
 *
 * Junk defense: a corrupted/foreign localStorage payload can only ever load as
 * valid entries — unknown defIds are dropped, params are clamped through the
 * registry schema, colors must be strings (else they fall back to the theme
 * var). The picker's open state lives here too so `toggleIndicatorPicker()`
 * (exported for INT's key bindings) works from anywhere.
 */

import { create } from 'zustand';

import { clampParam, defById, defaultParams, INDICATOR_DEFS, type IndicatorDef } from './registry';

/** Hard cap on simultaneously active indicators. */
export const MAX_ACTIVE_INDICATORS = 8;

/** One active indicator instance. */
export interface ActiveIndicator {
  /** Unique instance id (stable across param edits; not persisted across reloads semantics — regenerated on load). */
  uid: string;
  /** Registry id. */
  defId: string;
  /** Param values (always schema-valid — clamped on every write). */
  params: Record<string, number>;
  /** Per-output color override; absent/null = the output's theme colorVar. */
  colors: Record<string, string | null>;
}

interface IndicatorState {
  active: ActiveIndicator[];
  pickerOpen: boolean;
  /** Symbol the active list currently belongs to (null = none loaded yet). */
  symbol: string | null;
  add: (defId: string) => ActiveIndicator | null;
  remove: (uid: string) => void;
  setParam: (uid: string, key: string, value: number) => void;
  setColor: (uid: string, outputKey: string, color: string | null) => void;
  clearAll: () => void;
  togglePicker: () => void;
  setPickerOpen: (open: boolean) => void;
  /** Re-point the store at `symbol` (loads its persisted list on change). */
  syncSymbol: (symbol: string | null) => void;
}

// --- persistence helpers --------------------------------------------------------

function storageKey(symbol: string): string {
  return `flowmap.indicators.${symbol}`;
}

interface PersistedEntry {
  defId?: unknown;
  params?: unknown;
  colors?: unknown;
}

/** Sanitize one persisted entry; null = drop it. */
function reviveEntry(raw: PersistedEntry): ActiveIndicator | null {
  const def = typeof raw.defId === 'string' ? defById(raw.defId) : null;
  if (def === null) return null;
  const params = defaultParams(def);
  if (raw.params !== null && typeof raw.params === 'object') {
    for (const field of def.params) {
      if (field.key in (raw.params as Record<string, unknown>)) {
        params[field.key] = clampParam(field, (raw.params as Record<string, unknown>)[field.key]);
      }
    }
  }
  const colors: Record<string, string | null> = {};
  if (raw.colors !== null && typeof raw.colors === 'object') {
    for (const out of def.outputs) {
      const v = (raw.colors as Record<string, unknown>)[out.key];
      colors[out.key] = typeof v === 'string' && v.length > 0 ? v : null;
    }
  }
  return { uid: makeUid(def), defId: def.id, params, colors };
}

let uidCounter = 0;

function makeUid(def: IndicatorDef): string {
  uidCounter += 1;
  return `${def.id}#${uidCounter}`;
}

function loadFromStorage(symbol: string): ActiveIndicator[] {
  try {
    const raw = window.localStorage.getItem(storageKey(symbol));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ActiveIndicator[] = [];
    for (const entry of parsed.slice(0, MAX_ACTIVE_INDICATORS)) {
      const revived =
        entry !== null && typeof entry === 'object' ? reviveEntry(entry as PersistedEntry) : null;
      if (revived !== null) out.push(revived);
    }
    return out;
  } catch {
    return []; // corrupt JSON is simply "no indicators", never a broken session
  }
}

function saveToStorage(symbol: string | null, active: ActiveIndicator[]): void {
  if (symbol === null) return;
  try {
    window.localStorage.setItem(
      storageKey(symbol),
      JSON.stringify(
        active.map((a) => ({ defId: a.defId, params: a.params, colors: a.colors })),
      ),
    );
  } catch {
    /* private mode / quota — the choice stays session-local */
  }
}

// --- the store ------------------------------------------------------------------

export const useIndicatorStore = create<IndicatorState>((set, get) => {
  /** Persist the CURRENT list under the CURRENT symbol (call after every mutation). */
  const persist = (active: ActiveIndicator[]): void => {
    saveToStorage(get().symbol, active);
  };
  return {
    active: [],
    pickerOpen: false,
    symbol: null,

    add(defId) {
      const def = defById(defId);
      if (def === null) return null;
      const entry: ActiveIndicator = { uid: makeUid(def), defId: def.id, params: defaultParams(def), colors: {} };
      let active: ActiveIndicator[];
      if (get().active.length >= MAX_ACTIVE_INDICATORS) {
        // Bound: evict the oldest entry to make room (documented, not hidden).
        active = [...get().active.slice(1), entry];
      } else {
        active = [...get().active, entry];
      }
      set({ active });
      persist(active);
      return entry;
    },

    remove(uid) {
      const active = get().active.filter((a) => a.uid !== uid);
      if (active.length === get().active.length) return;
      set({ active });
      persist(active);
    },

    setParam(uid, key, value) {
      const current = get().active;
      const idx = current.findIndex((a) => a.uid === uid);
      if (idx < 0) return;
      const def = defById(current[idx].defId);
      if (def === null) return;
      const field = def.params.find((p) => p.key === key);
      if (field === undefined) return;
      const params = { ...current[idx].params, [key]: clampParam(field, value) };
      const active = current.map((a, i) => (i === idx ? { ...a, params } : a));
      set({ active });
      persist(active);
    },

    setColor(uid, outputKey, color) {
      const current = get().active;
      const idx = current.findIndex((a) => a.uid === uid);
      if (idx < 0) return;
      const def = defById(current[idx].defId);
      if (def === null || !def.outputs.some((o) => o.key === outputKey)) return;
      const colors = { ...current[idx].colors, [outputKey]: color === null ? null : String(color) };
      const active = current.map((a, i) => (i === idx ? { ...a, colors } : a));
      set({ active });
      persist(active);
    },

    clearAll() {
      set({ active: [] });
      persist([]);
    },

    togglePicker() {
      set({ pickerOpen: !get().pickerOpen });
    },

    setPickerOpen(open) {
      set({ pickerOpen: open === true });
    },

    syncSymbol(symbol) {
      if (symbol === get().symbol) return;
      set({ symbol, active: symbol === null ? [] : loadFromStorage(symbol) });
    },
  };
});

/** Module-level toggle — INT binds this (e.g. the `I` key) without React context. */
export function toggleIndicatorPicker(): void {
  useIndicatorStore.getState().togglePicker();
}

/** All registry ids in display order (picker convenience). */
export const INDICATOR_IDS: readonly string[] = INDICATOR_DEFS.map((d) => d.id);

/** Test seam: reset the store (localStorage cleanup is the test's job). */
export function resetIndicatorStoreForTest(): void {
  uidCounter = 0;
  useIndicatorStore.setState({ active: [], pickerOpen: false, symbol: null });
}
