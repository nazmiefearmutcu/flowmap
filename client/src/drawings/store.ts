/**
 * Drawings store (campaign 3, lane CF) — the zustand home for pro-charting
 * annotations over the heatmap (ported from the old branch's drawings/store.ts
 * + toolStore.ts, re-anchored to data space and extended with undo/redo,
 * per-drawing styling and the toolbar toggle).
 *
 * One document per market:symbol, mirroring persist.ts's namespaced keys so
 * switching instruments never bleeds one chart's trendlines onto another. The
 * lifecycle is a tiny two-phase pointer model (the DrawingLayer drives it):
 *
 *   - {@link DrawingsState.armTool} arms a tool (or returns to select mode
 *     with `null`);
 *   - {@link DrawingsState.addDraftPoint} accumulates anchors in `draftPoints`
 *     until the tool's arity (`POINTS_PER_TOOL`) is reached, at which point the
 *     draft is finalized into a full {@link Drawing} — the only shape that may
 *     enter `items` and therefore the only shape ever persisted (isComplete's
 *     boundary, enforced here by construction). Finalizing selects the new
 *     drawing and disarms the tool (TradingView's default: draw once, review).
 *   - every mutation of the loaded scope's `items` re-saves through
 *     saveDrawings using the Storage handed to {@link setDrawingsStorage}, so a
 *     crash or reload loses at most the half-drawn draft — never finished work.
 *
 * HISTORY: `pushUndo` snapshots `items` before a mutation; single-step actions
 * (remove / clear / restyle / finalize / z-order / text) push automatically,
 * while a pointer DRAG pushes exactly once at drag start and then streams
 * {@link DrawingsState.moveBy} / {@link DrawingsState.moveAnchor} (one undo
 * step per gesture, not per pointermove). The stack is bounded at
 * {@link UNDO_CAP} snapshots (contract: ≥ 20).
 */

import { create } from 'zustand';

import { createDrawing, movePoint as modelMovePoint, restyleDrawing, translateDrawing } from './model';
import { capDrawings, loadDrawings, saveDrawings, type StorageLike } from './persist';
import { DEFAULT_STYLE, POINTS_PER_TOOL, type ChartPoint, type Drawing, type DrawingTool, type DrawStyle } from './types';

/** Undo-stack depth (contract: ≥ 20; generous because snapshots are cheap). */
export const UNDO_CAP = 64;

/** The slice of state components subscribe to. */
export interface DrawingsState {
  /** Currently loaded scope — null until the first setScope. */
  market: string | null;
  symbol: string | null;
  /** Armed tool, or null for plain select mode. */
  tool: DrawingTool | null;
  selectedId: string | null;
  /** Anchors placed so far for the armed tool; empty when idle/finished. */
  draftPoints: ChartPoint[];
  /** The loaded scope's finished drawings (each satisfying isComplete). */
  items: Drawing[];
  /** Style applied to NEW drawings (and to the selected one when patched). */
  defaultStyle: DrawStyle;
  /** While set, that text drawing's inline editor is open in the layer. */
  editingTextId: string | null;
  /** Toolbar visibility (`D` toggles; module fn {@link toggleDrawToolbar}). */
  toolbarVisible: boolean;
  /** Bounded undo/redo histories of `items` snapshots (newest LAST). */
  undoStack: Drawing[][];
  redoStack: Drawing[][];

  /** Switch documents: flush the outgoing scope, then load the incoming one. */
  setScope(market: string, symbol: string): void;
  /** Arm a tool or cancel back to select mode; any half-placed draft is dropped. */
  armTool(t: DrawingTool | null): void;
  /**
   * Place the next anchor for the armed tool. Before arity is reached this
   * extends the draft and returns null; on the final anchor it finalizes,
   * appends to `items` (capped), pushes undo, persists, selects the drawing,
   * disarms the tool and returns it. Ignored (returns null) while no tool is
   * armed.
   */
  addDraftPoint(p: ChartPoint): Drawing | null;
  /** Drop the half-placed draft but stay armed for a fresh attempt. */
  cancelDraft(): void;
  select(id: string | null): void;
  /** Open the inline text editor for a text drawing (null closes it). */
  editText(id: string | null): void;
  /** Commit a label onto a text drawing; empty text deletes the drawing. */
  setText(id: string, text: string): void;
  /**
   * Snapshot `items` onto the undo stack (drag start / any wholesale change).
   * Single-step actions below call this internally; drags call it ONCE.
   */
  pushUndo(): void;
  /** Translate a drawing by a data-space delta (drag stream — no undo push). */
  moveBy(id: string, dtNs: bigint, dPrice: number): void;
  /** Move one anchor of a drawing (handle drag stream — no undo push). */
  moveAnchor(id: string, index: number, p: ChartPoint): void;
  /** Delete a drawing (undoable). */
  remove(id: string): void;
  /** Wipe the current scope's drawings and persist the empty document. */
  clearAll(): void;
  /** Move a drawing to the TOP of the paint order (end of items). */
  bringFront(id: string): void;
  /** Move a drawing to the BOTTOM of the paint order (start of items). */
  sendBack(id: string): void;
  /** Restyle a drawing (color / width patch). */
  setStyle(id: string, patch: Partial<DrawStyle>): void;
  /** Set the style future drawings get (and restyle the selection, if any). */
  setDefaultStyle(patch: Partial<DrawStyle>): void;
  undo(): void;
  redo(): void;
  toggleToolbar(): void;
}

/**
 * Last Storage handed to setDrawingsStorage — module-scoped because
 * persistence wiring is environment plumbing, not something components render.
 * `undefined` means "not resolved yet"; null disables persistence
 * (session-local drawings).
 */
let savedStorage: StorageLike | null | undefined;

/** Test seam / SSR seam: inject a storage double (or null to disable). */
export function setDrawingsStorage(s: StorageLike | null): void {
  savedStorage = s;
}

/** The default storage (browser localStorage), resolved lazily + guarded. */
function defaultStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* localStorage denied (privacy mode) — drawings simply stay session-local */
  }
  return null;
}

function getStorage(): StorageLike | null {
  if (savedStorage === undefined) savedStorage = defaultStorage();
  return savedStorage;
}

let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `drw-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Best-effort save of the CURRENT scope. No-op before a scope is loaded. */
function persistCurrentScope(get: () => DrawingsState): void {
  const s = get();
  if (s.market === null || s.symbol === null) return;
  saveDrawings(getStorage(), s.market, s.symbol, s.items);
}

/** Push `items` onto the undo history, truncating any redo tail. */
function snapshotForUndo(state: DrawingsState): Partial<DrawingsState> {
  const undoStack = state.undoStack.slice(-UNDO_CAP + 1);
  undoStack.push(state.items);
  return { undoStack, redoStack: [] };
}

export const useDrawingsStore = create<DrawingsState>((set, get) => ({
  market: null,
  symbol: null,
  tool: null,
  selectedId: null,
  draftPoints: [],
  items: [],
  defaultStyle: { ...DEFAULT_STYLE },
  editingTextId: null,
  toolbarVisible: false,
  undoStack: [],
  redoStack: [],

  setScope(market, symbol) {
    // Flush the OUTGOING scope under ITS key before overwriting state — a fast
    // A→B→A round-trip must not lose A's last edit.
    persistCurrentScope(get);
    set({
      market,
      symbol,
      items: loadDrawings(getStorage(), market, symbol),
      // Tool / draft / selection / editor belong to the old chart; none may
      // leak across. History is scoped per document too.
      tool: null,
      selectedId: null,
      draftPoints: [],
      editingTextId: null,
      undoStack: [],
      redoStack: [],
    });
  },

  armTool(t) {
    set({ tool: t, draftPoints: [], editingTextId: null });
  },

  addDraftPoint(p) {
    const { tool, draftPoints, items, defaultStyle } = get();
    if (tool === null) return null; // select mode swallows stray clicks
    const next = [...draftPoints, p];
    if (next.length < POINTS_PER_TOOL[tool]) {
      set({ draftPoints: next });
      return null;
    }
    const drawing = createDrawing(tool, next, defaultStyle, nextId(), Date.now());
    if (drawing === null) {
      set({ draftPoints: [] });
      return null;
    }
    set({
      ...snapshotForUndo(get()),
      items: capDrawings([...items, drawing]),
      draftPoints: [],
      // TradingView default: draw once, land back in select mode with the new
      // drawing selected (so Delete / immediate restyle work without a click).
      tool: null,
      selectedId: drawing.id,
      editingTextId: tool === 'text' ? drawing.id : null,
    });
    persistCurrentScope(get);
    return drawing;
  },

  cancelDraft() {
    set({ draftPoints: [] });
  },

  select(id) {
    set({ selectedId: id });
  },

  editText(id) {
    set({ editingTextId: id });
  },

  setText(id, text) {
    const d = get().items.find((x) => x.id === id);
    if (!d || d.tool !== 'text') {
      set({ editingTextId: null });
      return;
    }
    const trimmed = text.slice(0, 64);
    if (trimmed === '') {
      // An empty label is not a drawing — placing text then Esc deletes it.
      set({
        ...snapshotForUndo(get()),
        items: get().items.filter((x) => x.id !== id),
        selectedId: get().selectedId === id ? null : get().selectedId,
        editingTextId: null,
      });
      persistCurrentScope(get);
      return;
    }
    set({
      ...snapshotForUndo(get()),
      items: get().items.map((x) => (x.id === id ? { ...d, text: trimmed } : x)),
      editingTextId: null,
    });
    persistCurrentScope(get);
  },

  pushUndo() {
    set(snapshotForUndo(get()));
  },

  moveBy(id, dtNs, dPrice) {
    const d = get().items.find((x) => x.id === id);
    if (!d) return;
    set({ items: get().items.map((x) => (x.id === id ? translateDrawing(d, dtNs, dPrice) : x)) });
    persistCurrentScope(get);
  },

  moveAnchor(id, index, p) {
    const d = get().items.find((x) => x.id === id);
    if (!d) return;
    set({ items: get().items.map((x) => (x.id === id ? modelMovePoint(d, index, p) : x)) });
    persistCurrentScope(get);
  },

  remove(id) {
    const s = get();
    if (!s.items.some((x) => x.id === id)) return;
    set({
      ...snapshotForUndo(s),
      items: s.items.filter((x) => x.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
      editingTextId: s.editingTextId === id ? null : s.editingTextId,
    });
    persistCurrentScope(get);
  },

  clearAll() {
    const s = get();
    if (s.items.length === 0) return;
    set({
      ...snapshotForUndo(s),
      items: [],
      selectedId: null,
      draftPoints: [],
      editingTextId: null,
    });
    persistCurrentScope(get);
  },

  bringFront(id) {
    const items = get().items;
    const i = items.findIndex((x) => x.id === id);
    if (i < 0 || i === items.length - 1) return; // unknown / already top
    set({ ...snapshotForUndo(get()), items: [...items.filter((x) => x.id !== id), items[i]] });
    persistCurrentScope(get);
  },

  sendBack(id) {
    const items = get().items;
    const i = items.findIndex((x) => x.id === id);
    if (i <= 0) return; // unknown / already bottom
    set({ ...snapshotForUndo(get()), items: [items[i], ...items.filter((x) => x.id !== id)] });
    persistCurrentScope(get);
  },

  setStyle(id, patch) {
    const s = get();
    const d = s.items.find((x) => x.id === id);
    if (!d) return;
    const next = restyleDrawing(d, patch);
    if (next === d) return;
    set({ ...snapshotForUndo(s), items: s.items.map((x) => (x.id === id ? next : x)) });
    persistCurrentScope(get);
  },

  setDefaultStyle(patch) {
    const s = get();
    const defaultStyle: DrawStyle = {
      color: patch.color ?? s.defaultStyle.color,
      width: patch.width !== undefined
        ? Math.min(6, Math.max(1, Math.round(patch.width)))
        : s.defaultStyle.width,
    };
    // A selected drawing follows the swatch immediately — the user points at a
    // color with something selected, they mean to recolor it.
    const sel = s.selectedId;
    let changedSel = false;
    const items =
      sel !== null
        ? s.items.map((x) => {
            if (x.id !== sel) return x;
            const next = restyleDrawing(x, patch);
            if (next !== x) changedSel = true;
            return next;
          })
        : s.items;
    if (changedSel) {
      set({ defaultStyle, items, ...snapshotForUndo(s) });
      persistCurrentScope(get);
    } else {
      set({ defaultStyle, items });
    }
  },

  undo() {
    const { undoStack, redoStack, items } = get();
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    set({
      items: prev,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, items].slice(-UNDO_CAP),
      selectedId: null,
      editingTextId: null,
      draftPoints: [],
    });
    persistCurrentScope(get);
  },

  redo() {
    const { undoStack, redoStack, items } = get();
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    set({
      items: next,
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, items].slice(-UNDO_CAP),
      selectedId: null,
      editingTextId: null,
      draftPoints: [],
    });
    persistCurrentScope(get);
  },

  toggleToolbar() {
    set({ toolbarVisible: !get().toolbarVisible });
  },
}));

/**
 * Toggle the drawing toolbar's visibility. Module-level so the `D` key binding
 * (DrawToolbar's self-listener, or INT's keys.ts if it takes over the key)
 * needs no React and no hook — the same seam MeasureTool's arming uses.
 */
export function toggleDrawToolbar(): void {
  useDrawingsStore.getState().toggleToolbar();
}

/**
 * Reset all store + remembered-storage state. Unit tests only — production
 * scope switches go through setScope, which preserves cross-scope documents.
 */
export function resetDrawingsForTest(): void {
  savedStorage = undefined;
  useDrawingsStore.setState({
    market: null,
    symbol: null,
    tool: null,
    selectedId: null,
    draftPoints: [],
    items: [],
    defaultStyle: { ...DEFAULT_STYLE },
    editingTextId: null,
    toolbarVisible: false,
    undoStack: [],
    redoStack: [],
  });
}
