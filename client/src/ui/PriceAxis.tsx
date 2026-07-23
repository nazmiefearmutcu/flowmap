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

interface PriceAxisProps {
  canvasRef: RefObject<HTMLCanvasElement>;
  rendererRef: RefObject<Renderer | null>;
}

export function PriceAxis({ canvasRef, rendererRef }: PriceAxisProps): JSX.Element {
  const [mode, setMode] = useState<PriceFollow>('fit');

  useEffect(() => {
    const id = window.setInterval(() => {
      const r = rendererRef.current;
      if (!r) return;
      setMode((m) => (m === r.priceFollow ? m : r.priceFollow));
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [rendererRef]);

  const onToggle = (): void => {
    const r = rendererRef.current;
    if (!r) return;
    const next: PriceFollow = r.priceFollow === 'off' ? 'fit' : 'off';
    r.setPriceFollow(next);
    setMode(next); // optimistic; the poll confirms
  };

  const on = mode !== 'off';
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
        title={
          on
            ? 'price auto-scale ON — click to lock (P). Double-click the axis to re-fit.'
            : 'price auto-scale OFF — click to restore (P)'
        }
        onClick={onToggle}
      >
        {CHIP_TEXT[mode]}
      </button>
    </div>
  );
}
