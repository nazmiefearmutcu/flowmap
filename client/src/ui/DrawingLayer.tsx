/**
 * DrawingLayer (campaign 3, lane CF) — a 2D-canvas overlay that carries the
 * chart's pro-drawing annotations above the GL heatmap (ported from the old
 * branch's ui/DrawingCanvas + input/toolKeys, re-grounded on the current
 * renderer mapping contracts).
 *
 * MAPPING — the SAME contract as lane CD's MeasureTool: the integration lane
 * passes `chartMap={rendererChartMap(rendererRef)}` (ChartMapPair:
 * container px ⇄ fractional grid col/row). This component converts between
 * that GRID space and true DATA space (time-ns, price) using
 *   - `getTimeBase`  → the renderer's column⇄time anchor
 *     (`rendererRef.current?.timeline()?.timeBase ?? null`), and
 *   - the epoch's price scale straight from `state/store`
 *     (gl/priceScale accessors — hybrid-scale safe),
 * so anchors are stored as {tNs, price} and survive pan / zoom / replay seek
 * / reload (see drawings/types.ts for why). With BOTH mappings absent the
 * layer degenerates to the identity map and still works standalone in tests.
 *
 * POINTER POLICY — the layer is `pointer-events: none` unless a tool is
 * ARMED; while armed it takes the pointer for placement (drag = draw, or
 * click-click). In select mode the layer itself stays transparent to the
 * pointer (chart gestures own the canvas); DrawingLayer listens on the
 * CONTAINER instead and only intercepts a pointerdown that actually HITS a
 * drawing (hit-test first, then stopPropagation) — so panning never fights
 * the annotations, and dragging a drawing (body = move, handle = resize)
 * works without arming anything.
 *
 * KEYBOARD (scoped — documented for INT; nothing is hijacked globally):
 *   - Esc                 cancel draft → disarm tool → deselect (guarded
 *                         against editable targets + open dialogs, like
 *                         MeasureTool; never fires while the text editor is
 *                         open — the input owns Escape);
 *   - Delete / Backspace  remove the SELECTED drawing (only while the layer
 *                         has focus or a drawing is selected);
 *   - Ctrl/Cmd+Z          undo; Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y redo (same
 *                         scope guard).
 * INT may register `D` (toolbar toggle) in input/keys.ts via
 * `toggleDrawToolbar()` from drawings/store — DrawToolbar already self-
 * listens, so do NOT bind it in both places.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { classifyTarget } from '../input/keys';
import { priceToRow, rowToPrice, scaleFromEpoch } from '../gl/priceScale';
import type { EpochParams } from '../proto/types';
import { useFlowMapStore } from '../state/store';
import {
  hitTestDrawings,
  paintDraft,
  paintLayer,
  type DrawProjection,
} from '../drawings/painter';
import { toggleDrawToolbar, useDrawingsStore } from '../drawings/store';
import type { ChartPoint, DrawingTool } from '../drawings/types';
import type { ChartMapPair } from './MeasureTool';
import '../drawings/drawings.css';

/** Column⇄time anchor — the exact shape of Renderer.timeline().timeBase. */
export interface TimeBaseLike {
  anchorSeq: number;
  anchorT0Ns: bigint;
  dtNs: number;
}

const IDENTITY: Required<ChartMapPair> = {
  fromChart: (x, y) => ({ col: x, row: y }),
  toChart: (col, row) => ({ x: col, y: row }),
};

/** Toolbar chip text per armed tool. */
const TOOL_LABEL: Record<DrawingTool, string> = {
  trendline: 'TRENDLINE',
  hline: 'H-LINE',
  hray: 'H-RAY',
  rect: 'RECTANGLE',
  fib: 'FIB',
  text: 'TEXT',
};

/**
 * Build the data-space ⇄ CSS-px projection from the chart mapping pair, the
 * time anchor and the epoch scale. The x/y projections use the axis-decoupled
 * convention of `cellToCanvasCss` (x depends only on col, y only on row), so
 * the inverse probes evaluate `fromChart` at the vertical/horizontal CENTRE —
 * a renderer's `probeAt` may legitimately return null off the resident grid,
 * which callers treat as "cannot place here".
 */
export function makeProjection(
  map: ChartMapPair,
  timeBase: TimeBaseLike | null,
  params: EpochParams | null,
  cssW: number,
  cssH: number,
): DrawProjection | null {
  if (timeBase === null || params === null || !(timeBase.dtNs > 0)) return null;
  const scale = scaleFromEpoch(params);
  const { anchorSeq, anchorT0Ns, dtNs } = timeBase;
  const midX = cssW / 2;
  const midY = cssH / 2;
  const colOf = (tNs: bigint): number =>
    anchorSeq + Number(tNs - anchorT0Ns) / dtNs;
  const toChart = map.toChart ?? IDENTITY.toChart;
  const fromChart = map.fromChart ?? IDENTITY.fromChart;
  return {
    xAt: (tNs) => toChart(colOf(tNs), 0).x,
    yAt: (price) => toChart(0, priceToRow(scale, price)).y,
    tNsAt: (x) => {
      const p = fromChart(x, midY);
      if (p === null || !Number.isFinite(p.col)) return null;
      return anchorT0Ns + BigInt(Math.round((p.col - anchorSeq) * dtNs));
    },
    priceAt: (y) => {
      const p = fromChart(midX, y);
      if (p === null || !Number.isFinite(p.row)) return null;
      return rowToPrice(scale, p.row);
    },
  };
}

interface DrawingLayerProps {
  /** The chart container (position:relative) this overlay is anchored to. */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Container px ⇄ grid space — the SAME contract as MeasureTool. INT passes
   * `rendererChartMap(rendererRef)`; default is the identity map (standalone
   * tests / stories).
   */
  chartMap?: ChartMapPair;
  /** Persistence scope: drawings are stored per market:symbol. */
  symbol: string;
  /** Market half of the scope; defaults to the store subscription's market. */
  market?: string;
  /**
   * The renderer's column⇄time anchor, re-read every frame. INT passes
   * `() => rendererRef.current?.timeline()?.timeBase ?? null`.
   */
  getTimeBase?: () => TimeBaseLike | null;
}

/** Internal drag bookkeeping for select-mode moves (body or handle). */
interface SelectDrag {
  id: string;
  kind: 'body' | 'handle';
  handle: number;
  /** Last pointer position in data space (streamed deltas). */
  last: ChartPoint;
}

export function DrawingLayer({
  containerRef,
  chartMap,
  symbol,
  market,
  getTimeBase,
}: DrawingLayerProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef({ containerRef, chartMap, getTimeBase });
  propsRef.current = { containerRef, chartMap, getTimeBase };

  // --- reactive slices (low-frequency: tool, editor, mode chip) ---------------
  const tool = useDrawingsStore((s) => s.tool);
  const draftLen = useDrawingsStore((s) => s.draftPoints.length);
  const editingTextId = useDrawingsStore((s) => s.editingTextId);
  const [focused, setFocused] = useState(false);

  // --- per-frame view state (refs: the rAF loop owns them) --------------------
  const projRef = useRef<DrawProjection | null>(null);
  const sigRef = useRef('');
  const dirtyRef = useRef(true);
  const rafRef = useRef(0);
  /** Draft ghost cursor (data space) while a two-point tool is dragging. */
  const cursorRef = useRef<ChartPoint | null>(null);
  /** Placement-drag state for the armed two-point tools. */
  const placingRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
  /** Select-mode drag (body translate / anchor resize). */
  const selectDragRef = useRef<SelectDrag | null>(null);
  const cleanupWindowDragRef = useRef<(() => void) | null>(null);

  // Scope: follow the passed symbol (INT passes the active chart's symbol).
  const sub = useFlowMapStore((s) => s.subscription);
  const scopeMarket = market ?? sub?.market ?? 'na';
  useEffect(() => {
    useDrawingsStore.getState().setScope(scopeMarket, symbol);
  }, [scopeMarket, symbol]);

  // Any store mutation repaints the next frame.
  useEffect(() => {
    const unsub = useDrawingsStore.subscribe(() => {
      dirtyRef.current = true;
    });
    return unsub;
  }, []);

  /** CSS-px position of a pointer event relative to the chart container. */
  const localXY = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const host = propsRef.current.containerRef.current;
    if (host === null) return null;
    const r = host.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }, []);

  /** Pointer position in data space, or null when the view cannot place it. */
  const dataAt = useCallback(
    (clientX: number, clientY: number): ChartPoint | null => {
      const local = localXY(clientX, clientY);
      const proj = projRef.current;
      if (local === null || proj === null) return null;
      const tNs = proj.tNsAt(local.x);
      const price = proj.priceAt(local.y);
      if (tNs === null || price === null || !Number.isFinite(price)) return null;
      return { tNs, price };
    },
    [localXY],
  );

  // --- the paint loop ---------------------------------------------------------
  useEffect(() => {
    const tick = (): void => {
      rafRef.current = requestAnimationFrame(tick);
      const canvas = canvasRef.current;
      const wrapper = wrapperRef.current;
      if (canvas === null || wrapper === null) return;

      // Frame inputs: time anchor + epoch params + size + DPR.
      const st = useFlowMapStore.getState();
      const params =
        st.gridEpoch === null ? null : (st.epochs.get(st.gridEpoch) ?? null);
      const timeBase = propsRef.current.getTimeBase?.() ?? null;
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const cssW = Math.max(1, wrapper.clientWidth);
      const cssH = Math.max(1, wrapper.clientHeight);
      // Camera probe (two mapped corners), the same trick IndicatorOverlayCanvas
      // uses: the projection closures read the LIVE renderer, but without this
      // probe a zoom/pan changes NO other signature term — the layer would keep
      // painting drawings at their pre-gesture pixels until some store mutation
      // happened to set the dirty flag (R2: drawings must move with zoom).
      const probeTo = propsRef.current.chartMap?.toChart ?? IDENTITY.toChart;
      const p0 = probeTo(0, 0);
      const p1 = probeTo(1000, 1000);
      const sig = `${timeBase?.anchorSeq}|${timeBase?.anchorT0Ns}|${timeBase?.dtNs}|${params?.epoch}|${cssW}x${cssH}|${dpr}|${p0.x},${p0.y},${p1.x},${p1.y}`;

      if (sig !== sigRef.current) {
        sigRef.current = sig;
        projRef.current = makeProjection(
          propsRef.current.chartMap ?? IDENTITY,
          timeBase,
          params,
          cssW,
          cssH,
        );
        dirtyRef.current = true;
        const dw = Math.max(1, Math.round(cssW * dpr));
        const dh = Math.max(1, Math.round(cssH * dpr));
        if (canvas.width !== dw || canvas.height !== dh) {
          canvas.width = dw;
          canvas.height = dh;
        }
      }
      if (!dirtyRef.current) return;
      dirtyRef.current = false;

      const proj = projRef.current;
      const ctx = canvas.getContext('2d');
      if (proj === null || ctx === null) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const ds = useDrawingsStore.getState();
      paintLayer(ctx, ds.items, proj, {
        width: cssW,
        height: cssH,
        selectedId: ds.selectedId,
      });
      if (ds.tool !== null && ds.draftPoints.length > 0) {
        paintDraft(ctx, ds.tool, ds.draftPoints, cursorRef.current, proj, {
          width: cssW,
          height: cssH,
          selectedColor: ds.defaultStyle.color,
          draftWidth: ds.defaultStyle.width,
        });
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
      cleanupWindowDragRef.current?.();
    };
  }, []);

  // --- armed placement (overlay pointer events) -------------------------------

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const ds = useDrawingsStore.getState();
    if (ds.tool === null || e.button !== 0) return;
    const p = dataAt(e.clientX, e.clientY);
    if (p === null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const draftLenNow = ds.draftPoints.length;
    const created = ds.addDraftPoint(p);
    if (created !== null) {
      cursorRef.current = null; // finalized (arity-1 tool or completing click)
      return;
    }
    if (draftLenNow === 0) {
      // First anchor of a two-point tool: track the press for drag-vs-click.
      const local = localXY(e.clientX, e.clientY);
      if (local !== null) {
        placingRef.current = { startX: local.x, startY: local.y, moved: false };
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (useDrawingsStore.getState().tool === null) return;
    const p = dataAt(e.clientX, e.clientY);
    if (p === null) return;
    cursorRef.current = p;
    const placing = placingRef.current;
    if (placing !== null) {
      const local = localXY(e.clientX, e.clientY);
      if (local !== null) {
        const dx = local.x - placing.startX;
        const dy = local.y - placing.startY;
        if (dx * dx + dy * dy > 16) placing.moved = true; // > 4 px = a drag
      }
    }
    dirtyRef.current = true;
  };

  const finishPlacement = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const placing = placingRef.current;
    placingRef.current = null;
    if (placing === null) return;
    if (!placing.moved) return; // click-click mode: keep the draft for click 2
    const p = cursorRef.current;
    if (p !== null) useDrawingsStore.getState().addDraftPoint(p);
    cursorRef.current = null;
  };

  // --- select mode: intercept only real drawing hits on the container ---------

  useEffect(() => {
    const host = propsRef.current.containerRef.current;
    if (host === null) return undefined;

    const endDrag = (): void => {
      selectDragRef.current = null;
      if (cleanupWindowDragRef.current) {
        cleanupWindowDragRef.current();
        cleanupWindowDragRef.current = null;
      }
    };

    const onData = (clientX: number, clientY: number): ChartPoint | null => {
      const local = localXY(clientX, clientY);
      const proj = projRef.current;
      if (local === null || proj === null) return null;
      const tNs = proj.tNsAt(local.x);
      const price = proj.priceAt(local.y);
      if (tNs === null || price === null || !Number.isFinite(price)) return null;
      return { tNs, price };
    };

    const onDown = (e: PointerEvent): void => {
      const ds = useDrawingsStore.getState();
      if (ds.tool !== null || e.button !== 0) return; // armed overlay owns input
      const local = localXY(e.clientX, e.clientY);
      const proj = projRef.current;
      if (local === null || proj === null) return;
      const hit = hitTestDrawings(ds.items, local.x, local.y, proj);
      if (hit === null) {
        if (ds.selectedId !== null) ds.select(null); // empty click deselects
        return; // let the canvas gestures have it
      }
      e.preventDefault();
      e.stopPropagation();
      ds.select(hit.id);
      const p = onData(e.clientX, e.clientY);
      if (p === null) return;
      ds.pushUndo(); // one undo step per gesture
      selectDragRef.current = { id: hit.id, kind: hit.kind, handle: hit.handle, last: p };
      const onUp = (): void => {
        endDrag();
      };
      const onMove = (ev: PointerEvent): void => {
        const drag = selectDragRef.current;
        const st = useDrawingsStore.getState();
        if (drag === null) return;
        const cur = onData(ev.clientX, ev.clientY);
        if (cur === null) return;
        if (drag.kind === 'handle') {
          st.moveAnchor(drag.id, drag.handle, cur);
        } else {
          const dtNs = cur.tNs - drag.last.tNs;
          const dPrice = cur.price - drag.last.price;
          if (dtNs !== 0n || dPrice !== 0) st.moveBy(drag.id, dtNs, dPrice);
        }
        drag.last = cur;
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      cleanupWindowDragRef.current = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
    };

    // Hover affordance: cursor over a drawing, else hands the chart back.
    const onHover = (e: PointerEvent): void => {
      if (selectDragRef.current !== null) return;
      const ds = useDrawingsStore.getState();
      if (ds.tool !== null || ds.items.length === 0) {
        host.style.cursor = '';
        return;
      }
      const local = localXY(e.clientX, e.clientY);
      const proj = projRef.current;
      if (local === null || proj === null) return;
      host.style.cursor = hitTestDrawings(ds.items, local.x, local.y, proj) !== null ? 'pointer' : '';
    };

    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointermove', onHover);
    return () => {
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onHover);
      endDrag();
    };
  }, [localXY]);

  // --- keyboard (scoped; see module doc for the exact bindings) ---------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = classifyTarget(e.target);
      if (target.editable || target.dialog) return;
      const ds = useDrawingsStore.getState();
      const engaged =
        focused ||
        ds.selectedId !== null ||
        (ds.tool !== null && ds.draftPoints.length > 0);
      if (e.key === 'Escape') {
        if (ds.editingTextId !== null) return; // the text input owns Escape
        if (ds.draftPoints.length > 0) {
          e.preventDefault();
          ds.cancelDraft();
          cursorRef.current = null;
          return;
        }
        if (ds.tool !== null) {
          e.preventDefault();
          ds.armTool(null);
          return;
        }
        if (ds.selectedId !== null && focused) {
          e.preventDefault();
          ds.select(null);
        }
        return;
      }
      if (!engaged) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && ds.selectedId !== null) {
        e.preventDefault();
        ds.remove(ds.selectedId);
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        ds.undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        ds.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused]);

  // Double-click opens the text editor for an existing text label.
  const onDoubleClick = (): void => {
    // The preceding pointerdown already selected the drawing under the cursor.
    const ds = useDrawingsStore.getState();
    const d = ds.items.find((x) => x.id === ds.selectedId);
    if (d !== undefined && d.tool === 'text') ds.editText(d.id);
  };

  // --- inline text editor ------------------------------------------------------

  const editing = useMemo(() => {
    if (editingTextId === null) return null;
    const d = useDrawingsStore.getState().items.find((x) => x.id === editingTextId);
    if (d === undefined || d.tool !== 'text') return null;
    return d;
  }, [editingTextId]);
  const editingProj = editing !== null ? projRef.current : null;

  const armed = tool !== null;
  const cls = `draw-layer${armed ? ' is-armed' : ''}${focused ? ' has-focus' : ''}`;

  return (
    <div
      ref={wrapperRef}
      className={cls}
      data-testid="drawing-layer"
      tabIndex={0}
      role="application"
      aria-label="Chart drawings"
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPlacement}
      onPointerCancel={finishPlacement}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={canvasRef} className="draw-layer__canvas" />
      {editing !== null && editingProj !== null && (
        <input
          className="draw-layer__text-input"
          data-testid="drawing-text-input"
          defaultValue={editing.text}
          maxLength={64}
          autoFocus
          style={{
            left: `${editingProj.xAt(editing.points[0].tNs) + 2}px`,
            top: `${editingProj.yAt(editing.points[0].price) - 11}px`,
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              useDrawingsStore.getState().setText(editing.id, e.currentTarget.value);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              const v = e.currentTarget.value;
              // Empty label = not a drawing; non-empty = keep, just close.
              if (v === '') useDrawingsStore.getState().setText(editing.id, '');
              else useDrawingsStore.getState().editText(null);
            }
          }}
          onBlur={(e) => {
            const st = useDrawingsStore.getState();
            if (st.editingTextId === editing.id) {
              st.setText(editing.id, e.currentTarget.value);
            }
          }}
        />
      )}
      {armed && (
        <div className="draw-layer__mode" data-testid="drawing-mode">
          {TOOL_LABEL[tool]} — drag or click to place · Esc cancels
          {draftLen > 0 ? ' · click 2 finishes' : ''}
        </div>
      )}
    </div>
  );
}

/** Toolbar-visible convenience re-export so INT needs only this module's import list. */
export { toggleDrawToolbar };
