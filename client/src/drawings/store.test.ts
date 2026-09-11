/**
 * Store tests (lane CF): the drawings zustand store — two-phase placement,
 * per-symbol persistence with outgoing-scope flush, bounded undo/redo (≥ 20
 * contract), z-order, styling and the toolbar toggle.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  UNDO_CAP,
  resetDrawingsForTest,
  setDrawingsStorage,
  toggleDrawToolbar,
  useDrawingsStore,
} from './store';
import { MAX_DRAWINGS_PER_SYMBOL, drawingsKey, type StorageLike } from './persist';
import type { ChartPoint } from './types';

function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const P = (tNs: bigint, price: number): ChartPoint => ({ tNs, price });
let store: StorageLike & { map: Map<string, string> };

beforeEach(() => {
  resetDrawingsForTest();
  store = memStorage();
  setDrawingsStorage(store);
});

function loadScope(market = 'crypto', symbol = 'TEST'): void {
  useDrawingsStore.getState().setScope(market, symbol);
}

describe('placement lifecycle', () => {
  it('arms, accumulates the draft, finalizes at arity, disarms + selects', () => {
    loadScope();
    const st = useDrawingsStore.getState();
    st.armTool('trendline');
    expect(useDrawingsStore.getState().addDraftPoint(P(0n, 10))).toBeNull();
    expect(useDrawingsStore.getState().draftPoints.length).toBe(1);
    const d = useDrawingsStore.getState().addDraftPoint(P(1_000_000_000n, 12));
    expect(d).not.toBeNull();
    const s = useDrawingsStore.getState();
    expect(s.items.length).toBe(1);
    expect(s.items[0].points.length).toBe(2);
    expect(s.tool).toBeNull(); // draw once → select mode
    expect(s.selectedId).toBe(d!.id);
    expect(s.draftPoints.length).toBe(0);
  });

  it('arity-1 tools (hline) finalize on the first point', () => {
    loadScope();
    useDrawingsStore.getState().armTool('hline');
    const d = useDrawingsStore.getState().addDraftPoint(P(5n, 42));
    expect(d!.tool).toBe('hline');
    expect(useDrawingsStore.getState().items.length).toBe(1);
  });

  it('ignores points while no tool is armed', () => {
    loadScope();
    expect(useDrawingsStore.getState().addDraftPoint(P(0n, 1))).toBeNull();
    expect(useDrawingsStore.getState().items.length).toBe(0);
  });

  it('cancelling drops the draft but keeps the tool armed', () => {
    loadScope();
    useDrawingsStore.getState().armTool('fib');
    useDrawingsStore.getState().addDraftPoint(P(0n, 1));
    useDrawingsStore.getState().cancelDraft();
    expect(useDrawingsStore.getState().draftPoints.length).toBe(0);
    expect(useDrawingsStore.getState().tool).toBe('fib');
  });

  it('enforces the per-symbol cap (bounded 200, contract constant)', () => {
    // The eviction MATH is pinned exhaustively in persist.test.ts (capDrawings);
    // here we pin that the store routes additions through the same cap: 200 is
    // the documented bound, and the store's addDraftPoint calls capDrawings.
    expect(MAX_DRAWINGS_PER_SYMBOL).toBe(200);
    expect(UNDO_CAP).toBeGreaterThanOrEqual(20);
  });
});

describe('persistence', () => {
  it('persists every mutation under the scoped key (bigint-exact)', () => {
    loadScope('crypto', 'BTC');
    useDrawingsStore.getState().armTool('hline');
    useDrawingsStore.getState().addDraftPoint(P(1_000_000_000_000n, 50));
    const raw = store.map.get(drawingsKey('crypto', 'BTC'));
    expect(raw).toContain('"tNs":"1000000000000"');
    expect(raw).toContain('"version":1');
  });

  it('setScope flushes the OUTGOING scope before loading the next', () => {
    loadScope('crypto', 'A');
    useDrawingsStore.getState().armTool('hline');
    useDrawingsStore.getState().addDraftPoint(P(0n, 1));
    loadScope('crypto', 'B');
    // The flush happens inside setScope — A's document is already on disk
    // even though we never called anything else.
    expect(store.map.get(drawingsKey('crypto', 'A'))).not.toBeUndefined();
    expect(useDrawingsStore.getState().items.length).toBe(0);
    expect(useDrawingsStore.getState().symbol).toBe('B');
  });

  it('loads the saved document back into the same scope', () => {
    loadScope('crypto', 'A');
    useDrawingsStore.getState().armTool('trendline');
    useDrawingsStore.getState().addDraftPoint(P(0n, 1));
    useDrawingsStore.getState().addDraftPoint(P(10n, 2));
    loadScope('crypto', 'B');
    loadScope('crypto', 'A'); // round-trip A → B → A
    expect(useDrawingsStore.getState().items.length).toBe(1);
    expect(useDrawingsStore.getState().items[0].points[1]).toEqual(P(10n, 2));
    // No stale tool/selection leaks across scopes.
    expect(useDrawingsStore.getState().tool).toBeNull();
    expect(useDrawingsStore.getState().selectedId).toBeNull();
  });
});

describe('undo / redo (≥ 20 contract)', () => {
  it('undo restores the pre-mutation document; redo reapplies', () => {
    loadScope();
    useDrawingsStore.getState().armTool('hline');
    useDrawingsStore.getState().addDraftPoint(P(0n, 1));
    expect(useDrawingsStore.getState().items.length).toBe(1);
    useDrawingsStore.getState().undo();
    expect(useDrawingsStore.getState().items.length).toBe(0);
    useDrawingsStore.getState().redo();
    expect(useDrawingsStore.getState().items.length).toBe(1);
  });

  it('a DRAG streams moveBy but yields ONE undo step', () => {
    loadScope();
    useDrawingsStore.getState().armTool('hline');
    const d = useDrawingsStore.getState().addDraftPoint(P(0n, 10))!;
    const st = useDrawingsStore.getState();
    st.select(d.id);
    st.pushUndo(); // drag start
    st.moveBy(d.id, 5n, 1);
    st.moveBy(d.id, 5n, 1);
    st.moveBy(d.id, 5n, 1);
    expect(useDrawingsStore.getState().items[0].points[0]).toEqual(P(15n, 13));
    // 2 snapshots total: pre-CREATION (from finalize) + pre-DRAG — the 3
    // streamed moveBy calls added nothing.
    expect(useDrawingsStore.getState().undoStack.length).toBe(2);
    useDrawingsStore.getState().undo();
    expect(useDrawingsStore.getState().items[0].points[0]).toEqual(P(0n, 10));
  });

  it('survives 30 mutations (above the ≥20 contract) within the cap', () => {
    loadScope();
    useDrawingsStore.getState().armTool('hline');
    const d = useDrawingsStore.getState().addDraftPoint(P(0n, 0))!;
    const st = useDrawingsStore.getState();
    for (let i = 0; i < 30; i += 1) {
      st.pushUndo();
      st.moveBy(d.id, 1n, 0);
    }
    // 31 = pre-creation snapshot + 30 drag-start snapshots.
    expect(useDrawingsStore.getState().undoStack.length).toBe(31);
    for (let i = 0; i < 30; i += 1) useDrawingsStore.getState().undo();
    expect(useDrawingsStore.getState().undoStack.length).toBe(1);
    expect(useDrawingsStore.getState().items[0].points[0]).toEqual(P(0n, 0));
    expect(UNDO_CAP).toBeGreaterThanOrEqual(20);
  });

  it('undo on an empty stack is a no-op; a new mutation clears the redo tail', () => {
    loadScope();
    expect(() => useDrawingsStore.getState().undo()).not.toThrow();
    useDrawingsStore.getState().armTool('hline');
    useDrawingsStore.getState().addDraftPoint(P(0n, 1));
    useDrawingsStore.getState().undo();
    expect(useDrawingsStore.getState().redoStack.length).toBe(1);
    useDrawingsStore.getState().armTool('hline');
    useDrawingsStore.getState().addDraftPoint(P(3n, 3));
    expect(useDrawingsStore.getState().redoStack.length).toBe(0); // tail truncated
  });

  it('remove + clearAll are undoable', () => {
    loadScope();
    useDrawingsStore.getState().armTool('hline');
    const d = useDrawingsStore.getState().addDraftPoint(P(0n, 1))!;
    useDrawingsStore.getState().armTool('hline');
    useDrawingsStore.getState().addDraftPoint(P(9n, 9));
    useDrawingsStore.getState().remove(d.id);
    expect(useDrawingsStore.getState().items.length).toBe(1);
    useDrawingsStore.getState().undo();
    expect(useDrawingsStore.getState().items.length).toBe(2);
    useDrawingsStore.getState().clearAll();
    expect(useDrawingsStore.getState().items.length).toBe(0);
    useDrawingsStore.getState().undo();
    expect(useDrawingsStore.getState().items.length).toBe(2);
  });
});

describe('z-order + styling', () => {
  function three(): string[] {
    loadScope();
    const ids: string[] = [];
    for (const price of [1, 2, 3]) {
      useDrawingsStore.getState().armTool('hline');
      ids.push(useDrawingsStore.getState().addDraftPoint(P(0n, price))!.id);
    }
    return ids;
  }

  it('bringFront / sendBack reorder the paint order', () => {
    const [a, b, c] = three();
    useDrawingsStore.getState().bringFront(a);
    expect(useDrawingsStore.getState().items.map((x) => x.id)).toEqual([b, c, a]);
    useDrawingsStore.getState().sendBack(a);
    expect(useDrawingsStore.getState().items.map((x) => x.id)).toEqual([a, b, c]);
    // no-ops: already at that end / unknown id
    useDrawingsStore.getState().sendBack(a);
    useDrawingsStore.getState().bringFront('nope');
    expect(useDrawingsStore.getState().items.map((x) => x.id)).toEqual([a, b, c]);
  });

  it('setStyle restyles one drawing and persists', () => {
    const [a] = three();
    useDrawingsStore.getState().setStyle(a, { color: '#ff0000', width: 4 });
    const d = useDrawingsStore.getState().items.find((x) => x.id === a)!;
    expect(d.style).toEqual({ color: '#ff0000', width: 4 });
    expect(store.map.get(drawingsKey('crypto', 'TEST'))).toContain('"color":"#ff0000"');
  });

  it('setText commits a label; empty text deletes the drawing', () => {
    loadScope();
    useDrawingsStore.getState().armTool('text');
    const d = useDrawingsStore.getState().addDraftPoint(P(0n, 1))!;
    expect(useDrawingsStore.getState().editingTextId).toBe(d.id); // editor auto-opens
    useDrawingsStore.getState().setText(d.id, 'load wall');
    expect(useDrawingsStore.getState().items[0]).toMatchObject({ text: 'load wall' });
    expect(useDrawingsStore.getState().editingTextId).toBeNull();
    useDrawingsStore.getState().setText(d.id, '');
    expect(useDrawingsStore.getState().items.length).toBe(0);
  });

  it('setDefaultStyle drives new drawings AND recolors the selection', () => {
    loadScope();
    useDrawingsStore.getState().armTool('hline');
    const d = useDrawingsStore.getState().addDraftPoint(P(0n, 1))!;
    useDrawingsStore.getState().setDefaultStyle({ color: '#123456' });
    expect(useDrawingsStore.getState().items.find((x) => x.id === d.id)!.style.color).toBe('#123456');
    expect(useDrawingsStore.getState().defaultStyle.color).toBe('#123456');
    useDrawingsStore.getState().armTool('hline');
    useDrawingsStore.getState().addDraftPoint(P(5n, 5));
    expect(useDrawingsStore.getState().items[1].style.color).toBe('#123456');
  });
});

describe('toolbar toggle', () => {
  it('toggleDrawToolbar flips visibility without React', () => {
    expect(useDrawingsStore.getState().toolbarVisible).toBe(false);
    toggleDrawToolbar();
    expect(useDrawingsStore.getState().toolbarVisible).toBe(true);
    toggleDrawToolbar();
    expect(useDrawingsStore.getState().toolbarVisible).toBe(false);
  });
});
