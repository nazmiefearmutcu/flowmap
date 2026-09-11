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

import { useEffect, useState, type RefObject } from 'react';

import type { PriceFollow } from '../gl/camera';
import type { Renderer } from '../gl/renderer';

/** Poll interval (ms) for the chip's state. Short: the chip must not visibly lag
 *  the gesture that changed it (a wheel over the gutter changes it instantly). */
const POLL_MS = 100;

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

  useEffect(() => {
    const id = window.setInterval(() => {
      const r = rendererRef.current as RendererCp1 | null;
      if (!r) return;
      setMode((m) => (m === r.priceFollow ? m : r.priceFollow));
      const edge = r.liveEdgeVisible !== false;
      setEdgeVisible((e) => (e === edge ? e : edge));
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [rendererRef]);

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
          must never sit inside an aria-hidden subtree. */}
      <canvas ref={canvasRef} className="axis-canvas" aria-hidden="true" />
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
