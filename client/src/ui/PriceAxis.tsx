/**
 * Price axis (§9: price axis right), M2 T10 + the §9 axis-scale control surface.
 *
 * A thin right-hand gutter whose `<canvas>` the {@link Renderer} draws price
 * ticks into every dirty frame (see gl/overlays/axes.ts `drawPriceAxis`). The
 * gutter shares the heatmap viewport's HEIGHT, so a price row maps to the same y
 * in both — the labels stay pinned to the heatmap under pan/zoom. React only owns
 * the chrome + the canvas element; the pixels are painted imperatively by the
 * renderer (no per-frame React re-render, matching the store's high-freq policy).
 *
 * The gutter is also a CONTROL surface, the way it is in TradingView and
 * Bookmap: wheel scales price at the cursor row, a vertical drag scales price
 * about the viewport centre (it does NOT pan — an axis drag stretches the axis),
 * and a double-click restores auto-fit. Those listeners are attached by the
 * renderer in `attachOverlaySurfaces`, so this component stays declarative.
 *
 * The chip on top reports which mode the price axis is in and toggles auto-scale
 * off/on. It is a SIBLING of the canvas, not an overlay on it, so a click lands
 * on the button and never reaches the gesture listeners underneath.
 *
 * Chip truth (survey S4 D2/D4, campaign 2026-09-11):
 *   - The label must not claim `TRACK` while tracking cannot act. `track` is
 *     gated by `stepPriceFollow` on the newest column being inside the view, so
 *     when `renderer.liveEdgeVisible === false` the chip reads `TRK·WAIT`
 *     (armed, waiting for the edge) instead of a state that never moves.
 *   - The toggle is routed through the App's `onSetPriceFollow` when provided,
 *     so the persisted `followPrice` setting (and therefore the settings drawer
 *     toggle + the next boot) can never disagree with the camera. Standalone
 *     (no callback) it falls back to driving the renderer directly.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { PriceFollow } from '../gl/camera';
import type { Renderer } from '../gl/renderer';

/** Poll interval (ms) for the chip's state. Short: the chip must not visibly lag
 *  the gesture that changed it (a wheel over the gutter changes it instantly). */
const POLL_MS = 100;

/** Minimum gap between two gutter rebinds (ms). A rebind re-runs the App's
 *  attach path (fresh TextLayer wrapper + gesture handlers) and re-dirties the
 *  frame, so a persistent box mismatch must not thrash it every poll tick. */
const HEAL_COOLDOWN_MS = 1000;

/** Chip text per mode. Decorative — the accessible name is static (see below). */
const CHIP_TEXT: Record<PriceFollow, string> = {
  fit: 'FIT',
  track: 'TRACK',
  off: 'LOCK',
};

/**
 * CP1 seam (B2 lane): `liveEdgeVisible` is optional until the renderer lane
 * lands it. A missing getter reads as "unknown" — the chip keeps the plain mode
 * label rather than inventing a paused state it cannot verify.
 */
type RendererCp1 = Renderer & { readonly liveEdgeVisible?: boolean };

/**
 * QA9-1 heal surface. `overlays` is TS-private on the Renderer, so this is a
 * STANDALONE structural view (casting) rather than an intersection — a
 * `Renderer & { overlays }` intersection collapses to `never` (private member
 * in one constituent, public in the other). `syncGutters` is the manager's
 * public re-match primitive; it stays optional so the heal degrades to a
 * rebind + redirty on a build without it.
 */
type AxisHealView = {
  attachOverlaySurfaces: (price: HTMLCanvasElement | null, time: HTMLCanvasElement | null) => void;
  overlays?: {
    readonly timeAxis?: { readonly canvas: HTMLCanvasElement } | null;
    syncGutters?: (dpr: number) => boolean;
  } | null;
};

interface PriceAxisProps {
  canvasRef: RefObject<HTMLCanvasElement>;
  rendererRef: RefObject<Renderer | null>;
  /** D4: persist + apply a chip-driven mode change through the App (settings
   *  patch semantics). Absent = drive the renderer directly (standalone/tests). */
  onSetPriceFollow?: (mode: PriceFollow) => void;
}

export function PriceAxis({ canvasRef, rendererRef, onSetPriceFollow }: PriceAxisProps): JSX.Element {
  const [mode, setMode] = useState<PriceFollow>('fit');
  const [edgeVisible, setEdgeVisible] = useState(true);
  const healedAtRef = useRef(0);

  /**
   * QA9-1: keep the LIVE canvas bound to the renderer and its backing store
   * matched to the on-screen box — WITHOUT waiting for a window resize.
   *
   * Two failure shapes this closes: (a) a fresh boot whose first frames landed
   * before layout froze the bitmap at the browser default 300×150, leaving the
   * gutter with no tick labels and no last-price pill until something forced a
   * frame; (b) a hot remount replaced the canvas ELEMENT while the App's
   * mount-only `attachOverlaySurfaces` still holds the old (detached) node, so
   * the on-screen canvas never receives another sync. A rebind points the
   * manager at the live element again and re-dirties the renderer; the
   * manager's `syncGutters` re-matches the bitmap immediately, so the next ink
   * lands on the right grid even before the next data-driven frame.
   */
  const healAxis = useCallback((): void => {
    const r = rendererRef.current as unknown as AxisHealView | null;
    const c = canvasRef.current;
    if (r === null || c === null || typeof r.attachOverlaySurfaces !== 'function') return;
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    if (cw <= 0 || ch <= 0) return; // pre-layout / hidden: nothing to match yet
    const dpr = window.devicePixelRatio || 1;
    const wantW = Math.max(1, Math.round(cw * dpr));
    const wantH = Math.max(1, Math.round(ch * dpr));
    if (c.width === wantW && c.height === wantH) return; // already in sync
    const now = Date.now();
    if (now - healedAtRef.current < HEAL_COOLDOWN_MS) return;
    healedAtRef.current = now;
    // Rebind (same element → fresh wrapper; replaced element → live again) and
    // redirty through the public attach API, then re-size the 2D backing store
    // immediately (requestAnimationFrame may be starved under CPU load; the
    // bitmap fix must not wait for it).
    const timeCanvas = r.overlays?.timeAxis?.canvas ?? null;
    r.attachOverlaySurfaces(c, timeCanvas);
    r.overlays?.syncGutters?.(dpr);
  }, [canvasRef, rendererRef]);

  // Callback ref: React hands us the element on mount AND on any replacement,
  // and the App-owned RefObject keeps its previous meaning for every other
  // consumer (mount attach, e2e hooks). A replacement heals immediately when
  // the renderer already exists (the detached-node case).
  const bindCanvas = useCallback(
    (el: HTMLCanvasElement | null): void => {
      (canvasRef as { current: HTMLCanvasElement | null }).current = el;
      if (el !== null && rendererRef.current !== null) healAxis();
    },
    [canvasRef, rendererRef, healAxis],
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      const r = rendererRef.current as RendererCp1 | null;
      if (!r) return;
      setMode((m) => (m === r.priceFollow ? m : r.priceFollow));
      const edge = r.liveEdgeVisible !== false;
      setEdgeVisible((e) => (e === edge ? e : edge));
      healAxis();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [rendererRef, healAxis]);

  const onToggle = (): void => {
    const r = rendererRef.current;
    if (!r) return;
    // Enabling restores 'track' (keeps the user's zoom, recentres on drift), NOT
    // 'fit' (which re-frames to the book and discards the scale). Explicit auto-
    // fit stays on the axis double-click / Shift+P.
    const next: PriceFollow = r.priceFollow === 'off' ? 'track' : 'off';
    if (onSetPriceFollow) onSetPriceFollow(next);
    else r.setPriceFollow(next);
    setMode(next); // optimistic; the poll confirms
  };

  const on = mode !== 'off';
  const waiting = mode === 'track' && !edgeVisible;
  const label = waiting ? 'TRK·WAIT' : CHIP_TEXT[mode];
  return (
    <div className="price-axis">
      {/* aria-hidden lives on the CANVAS, not the wrapper: an interactive button
          must never sit inside an aria-hidden subtree. The callback ref keeps
          the App-owned RefObject in sync (see bindCanvas). */}
      <canvas ref={bindCanvas} className="axis-canvas" aria-hidden="true" />
      <button
        type="button"
        className={`axis-auto${on ? ' is-on' : ''}`}
        data-testid="price-auto"
        // STATIC accessible name + aria-pressed. A label that flips AUTO↔LOCK
        // alongside aria-pressed double-encodes the state and would be announced
        // as "LOCK, not pressed" — the exact opposite of the truth.
        aria-label="Price auto-scale"
        aria-pressed={on}
        data-edge={waiting ? 'hidden' : 'visible'}
        title={
          waiting
            ? 'price tracking is armed but paused — the live edge is off-screen. Press R / GO LIVE to return to it (your price zoom is kept).'
            : on
              ? 'price auto-scale ON — click to lock (P). Double-click the axis to re-fit.'
              : 'price auto-scale OFF — click to restore (P)'
        }
        onClick={onToggle}
      >
        {label}
      </button>
    </div>
  );
}
