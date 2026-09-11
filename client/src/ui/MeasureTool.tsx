/**
 * Measure tool (campaign 3, lane CD) — a keyboard-first chart ruler.
 *
 * `M` arms the tool; a click-drag on the chart draws a rectangle and a compact
 * readout: Δprice (absolute + %), Δtime (human units) and, when derivable from
 * the store, the resting depth inside the row band (bid / ask sums from the
 * current settled book — labelled `vol` on SYNTH feeds, §7 honesty). Esc exits
 * (cancelling an in-progress drag); a finished measurement persists on the
 * chart until the next click starts a new one.
 *
 * It is a PURE DOM overlay (the Crosshair pattern): an absolutely-positioned
 * layer over the GL canvas that is `pointer-events: none` while disarmed — so
 * pan/zoom gestures on the canvas are untouched — and takes the pointer only
 * while armed. Coordinates flow through an injectable {@link ChartMapPair}
 * (`fromChart` / `toChart`): the integration lane passes one built on the
 * renderer (see {@link rendererChartMap}); the DEFAULT is the identity map so
 * the component renders standalone in tests and stories.
 *
 * All data math reads the stores directly: Δtime = Δcol × epoch `dt_ns` (exact
 * within an epoch — no renderer probe needed), prices from the epoch scale,
 * depth from the shared book buffer. Works identically in replay: the view
 * transform already IS the replay camera.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';

import type { Renderer } from '../gl/renderer';
import {
  rowToPrice as scaleRowToPrice,
  scaleFromEpoch,
  stepAtRow as scaleStepAtRow,
} from '../gl/priceScale';
import type { EpochParams } from '../proto/types';
import { BookBuffer, getSnapshot } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { routeGlobalKey, classifyTarget } from '../input/keys';
import { depthTier } from './DomLadder';
import './features.css';

// --- chart mapping contract (INT supplies; identity by default) ------------------

/**
 * Chart-container CSS px ⇄ chart data space. `col` is the fractional absolute
 * column (column c spans [c, c+1)); `row` is the fractional grid row with row 0
 * at the BOTTOM of the price grid (renderer conventions).
 */
export interface ChartMapPair {
  /** Container px → data space; null when the point cannot be placed (no data yet). */
  fromChart?: (x: number, y: number) => { col: number; row: number } | null;
  /** Data space → container px (places the overlay rectangle / readout). */
  toChart?: (col: number, row: number) => { x: number; y: number };
}

const IDENTITY: Required<ChartMapPair> = {
  fromChart: (x, y) => ({ col: x, row: y }),
  toChart: (col, row) => ({ x: col, y: row }),
};

/**
 * The production mapping pair, built on the renderer: `probeAt` reads the exact
 * CPU column cache (cell resolution — the same precision the crosshair shows),
 * `cellToCanvasCss` forward-maps grid cells to canvas CSS px. Null-safe before
 * the first column.
 */
export function rendererChartMap(rendererRef: MutableRefObject<Renderer | null>): ChartMapPair {
  return {
    fromChart: (x, y) => {
      const r = rendererRef.current;
      if (!r) return null;
      const p = r.probeAt(x, y);
      return p === null ? null : { col: p.colSeq, row: p.row };
    },
    toChart: (col, row) => {
      const r = rendererRef.current;
      if (!r) return { x: 0, y: 0 };
      return r.cellToCanvasCss(col, row);
    },
  };
}

// --- pure math helpers (unit-tested) ---------------------------------------------

/** Price at a grid row through the epoch scale, + the decimals to print it with. */
export function priceAtRow(
  row: number,
  params: EpochParams | null,
): { price: number; decimals: number } | null {
  if (params === null || !Number.isFinite(row)) return null;
  const scale = scaleFromEpoch(params);
  const price = scaleRowToPrice(scale, row);
  if (!Number.isFinite(price)) return null;
  const local = scaleStepAtRow(scale, row);
  const decimals = local > 0 ? Math.min(8, Math.max(0, Math.ceil(-Math.log10(local)))) : 2;
  return { price, decimals };
}

/** Human Δtime for a non-negative nanosecond span. */
export function fmtDeltaTime(ns: bigint): string {
  if (ns < 0n) ns = -ns;
  const ms = Number(ns / 1_000_000n);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1) return `${ns}ns`;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const totalMin = Math.floor(ms / 60_000);
  const totalHr = Math.floor(ms / 3_600_000);
  if (totalHr < 1) return `${totalMin}m ${Math.round((ms % 60_000) / 1_000)}s`;
  if (totalHr < 24) return `${totalHr}h ${totalMin % 60}m`;
  const days = Math.floor(ms / 86_400_000);
  return `${days}d ${totalHr % 24}h`;
}

/** Signed Δprice formatted against the grid's decimals. */
export function fmtDeltaPrice(delta: number, decimals: number): string {
  if (!Number.isFinite(delta)) return '—';
  const abs = Math.abs(delta).toFixed(decimals);
  return `${delta >= 0 ? '+' : '−'}${abs}`;
}

/** Δ as a percent of the start price, one decimal, signed. */
export function fmtDeltaPct(delta: number, base: number): string {
  if (!Number.isFinite(delta) || !Number.isFinite(base) || base === 0) return '—';
  const pct = (delta / base) * 100;
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%`;
}

/** Summed resting depth inside a half-open row band of the current book. */
export function sumDepthInBand(
  book: BookBuffer | null,
  rowLo: number,
  rowHi: number,
): { bid: number; ask: number | null } | null {
  if (book === null) return null;
  const lo = Math.max(0, Math.floor(Math.min(rowLo, rowHi)));
  const hi = Math.min(book.bid.length, Math.ceil(Math.max(rowLo, rowHi)));
  if (hi <= lo) return null;
  let bid = 0;
  let ask = book.ask === null ? null : 0;
  for (let r = lo; r < hi; r += 1) {
    bid += book.bid[r];
    if (ask !== null && book.ask !== null) ask += book.ask[r];
  }
  if (ask !== null && !Number.isFinite(ask)) ask = null;
  return { bid, ask };
}

// --- the component ----------------------------------------------------------------

interface DragState {
  /** Anchor point in data space (set on pointerdown). */
  anchor: { col: number; row: number };
  /** Live end point (follows the pointer until release). */
  end: { col: number; row: number };
  /** Anchor + end in container px, frozen at drag start/end for placement. */
  px: { anchor: { x: number; y: number }; end: { x: number; y: number } };
  dragging: boolean;
}

interface MeasureToolProps {
  /** The chart container (position:relative) this overlay is anchored to. */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Container px ⇄ data space mapping. Defaults to the IDENTITY map; the
   * integration lane passes `rendererChartMap(rendererRef)` in the real app.
   */
  map?: ChartMapPair;
}

/** A settled or in-progress measurement in container px. */
type Rect = DragState['px'];

export function MeasureTool({ containerRef, map }: MeasureToolProps): JSX.Element {
  const [armed, setArmed] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const [readout, setReadout] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef(0);
  const armedRef = useRef(armed);
  armedRef.current = armed;

  // `M` arms/disarms; Esc cancels (drag → reset to anchor; idle → exit+clear).
  // Guards mirror the app router: never while typing or when a dialog is open.
  useEffect(() => {
    const clearAll = (): void => {
      dragRef.current = null;
      setRect(null);
      setReadout(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const action = routeGlobalKey(e.key, classifyTarget(e.target));
      if (action?.type === 'toggle-measure') {
        e.preventDefault();
        const next = !armedRef.current;
        armedRef.current = next;
        setArmed(next);
        if (!next) clearAll();
        return;
      }
      if (e.key !== 'Escape') return;
      if (classifyTarget(e.target).editable) return;
      const t = e.target as HTMLElement | null;
      if (typeof t?.closest === 'function' && t.closest('[role="dialog"]') !== null) {
        return; // a modal owns Escape (the drawer/shortcuts close themselves)
      }
      if (dragRef.current?.dragging || armedRef.current) {
        // Esc exits the tool outright: an in-progress drag is discarded and a
        // settled rectangle is cleared.
        armedRef.current = false;
        setArmed(false);
        clearAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pointAt = useCallback(
    (clientX: number, clientY: number): { col: number; row: number; px: { x: number; y: number } } | null => {
      const host = containerRef.current;
      if (host === null) return null;
      const r = host.getBoundingClientRect();
      const x = clientX - r.left;
      const y = clientY - r.top;
      const p = (map ?? IDENTITY).fromChart?.(x, y) ?? IDENTITY.fromChart(x, y);
      if (p === null || !Number.isFinite(p.col) || !Number.isFinite(p.row)) return null;
      const px = (map ?? IDENTITY).toChart?.(p.col, p.row) ?? IDENTITY.toChart(p.col, p.row);
      return { col: p.col, row: p.row, px };
    },
    [containerRef, map],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!armed || e.button !== 0) return;
    const p = pointAt(e.clientX, e.clientY);
    if (p === null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const st: DragState = {
      anchor: { col: p.col, row: p.row },
      end: { col: p.col, row: p.row },
      px: { anchor: p.px, end: p.px },
      dragging: true,
    };
    dragRef.current = st;
    setRect(st.px);
    setReadout(st);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const st = dragRef.current;
    if (!st?.dragging) return;
    if (rafRef.current) return; // coalesce to ≤ one sample per frame
    const { clientX, clientY } = e;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const cur = dragRef.current;
      if (!cur?.dragging) return;
      const p = pointAt(clientX, clientY);
      if (p === null) return;
      cur.end = { col: p.col, row: p.row };
      cur.px.end = p.px;
      setRect({ ...cur.px });
      setReadout({ ...cur });
    });
  };

  const finishDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const st = dragRef.current;
    if (!st?.dragging) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    st.dragging = false;
    setReadout({ ...st });
    // The rectangle stays on the chart until the next click (or Esc).
  };

  // Geometry for the readout (epoch scale, dt, book depth) — all from the stores.
  const gridEpoch = useFlowMapStore((s) => s.gridEpoch);
  const epochs = useFlowMapStore((s) => s.epochs);
  const capability = useFlowMapStore((s) => s.capability);
  const params = gridEpoch === null ? null : (epochs.get(gridEpoch) ?? null);
  const dtNs = params?.dt_ns ?? null;

  const st = readout;
  const dCol = st ? st.end.col - st.anchor.col : 0;
  const startPx = priceAtRow(st?.anchor.row ?? Number.NaN, params);
  const endPx = priceAtRow(st?.end.row ?? Number.NaN, params);
  const dPrice = startPx && endPx ? endPx.price - startPx.price : null;
  const dtTime = dtNs !== null && st ? BigInt(Math.round(dCol * dtNs)) : null;
  const book = st ? getSnapshot().book : null;
  const depth =
    st && book !== null
      ? sumDepthInBand(book, Math.min(st.anchor.row, st.end.row), Math.max(st.anchor.row, st.end.row))
      : null;
  const tier = depth ? depthTier(capability, book?.mode ?? null) : null;
  const isSynth = tier === 'SYNTH';

  return (
    <div
      className={`measure${armed ? ' is-armed' : ''}`}
      data-testid="measure-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      {st && rect && (
        <>
          <div
            className="measure__rect"
            data-testid="measure-rect"
            style={{
              left: `${Math.min(rect.anchor.x, rect.end.x)}px`,
              top: `${Math.min(rect.anchor.y, rect.end.y)}px`,
              width: `${Math.abs(rect.end.x - rect.anchor.x)}px`,
              height: `${Math.abs(rect.end.y - rect.anchor.y)}px`,
            }}
          />
          <div className="measure__box" data-testid="measure-readout" style={boxStyle(containerRef, rect)}>
            <div className="measure__row">
              <span className="measure__k">Δpx</span>
              <span className="measure__v" data-testid="measure-dprice">
                {dPrice === null || !startPx || !endPx
                  ? '—'
                  : `${fmtDeltaPrice(dPrice, endPx.decimals)} (${fmtDeltaPct(dPrice, startPx.price)})`}
              </span>
            </div>
            <div className="measure__row">
              <span className="measure__k">Δt</span>
              <span className="measure__v" data-testid="measure-dtime">
                {dtTime === null ? '—' : fmtDeltaTime(dtTime)}
              </span>
            </div>
            <div className="measure__row">
              <span className="measure__k">{isSynth ? 'vol' : 'depth'}</span>
              <span className="measure__v" data-testid="measure-ddepth">
                {depth === null ? (
                  '—'
                ) : isSynth ? (
                  fmtSize(depth.bid)
                ) : (
                  <>
                    <span className="measure__bid">{fmtSize(depth.bid)}</span>
                    {' · '}
                    <span className="measure__ask">
                      {depth.ask === null ? '—' : fmtSize(depth.ask)}
                    </span>
                  </>
                )}
              </span>
            </div>
            {startPx && endPx && (
              <div className="measure__row measure__row--dim" data-testid="measure-endpoints">
                <span className="measure__k">px</span>
                <span className="measure__v">
                  {startPx.price.toFixed(startPx.decimals)} → {endPx.price.toFixed(endPx.decimals)}
                </span>
              </div>
            )}
          </div>
        </>
      )}
      {armed && (
        <div className="measure__mode" data-testid="measure-mode">
          MEASURE — drag on the chart · Esc exits
        </div>
      )}
    </div>
  );
}

/** Place the readout box beside the rectangle, flipping away from the near edges. */
function boxStyle(
  containerRef: RefObject<HTMLElement | null>,
  rect: Rect,
): React.CSSProperties {
  const w = containerRef.current?.clientWidth ?? 0;
  const h = containerRef.current?.clientHeight ?? 0;
  const right = Math.max(rect.anchor.x, rect.end.x);
  const bottom = Math.max(rect.anchor.y, rect.end.y);
  const flipX = right > w - 170;
  const flipY = bottom > h - 96;
  return flipX || flipY
    ? {
        right: flipX ? `${w - Math.min(rect.anchor.x, rect.end.x) + 10}px` : undefined,
        bottom: flipY ? `${h - Math.min(rect.anchor.y, rect.end.y) + 10}px` : undefined,
      }
    : { left: `${right + 10}px`, top: `${bottom + 10}px` };
}

/** Compact size format — mirrors Crosshair.fmtSize (K/M compaction, ∞ guard). */
function fmtSize(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(v >= 100_000 ? 0 : 1)}K`;
  if (v >= 1_000) return Math.round(v).toLocaleString('en-US');
  if (v >= 100) return v.toFixed(1);
  return v.toFixed(2);
}
