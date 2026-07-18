/**
 * Price axis (§9: price axis right), M2 T10.
 *
 * A thin right-hand gutter whose `<canvas>` the {@link Renderer} draws price
 * ticks into every dirty frame (see gl/overlays/axes.ts `drawPriceAxis`). The
 * gutter shares the heatmap viewport's HEIGHT, so a price row maps to the same y
 * in both — the labels stay pinned to the heatmap under pan/zoom. React only owns
 * the chrome + the canvas element; the pixels are painted imperatively by the
 * renderer (no per-frame React re-render, matching the store's high-freq policy).
 */

import type { RefObject } from 'react';

interface PriceAxisProps {
  canvasRef: RefObject<HTMLCanvasElement>;
}

export function PriceAxis({ canvasRef }: PriceAxisProps): JSX.Element {
  return (
    <div className="price-axis" aria-hidden="true">
      <canvas ref={canvasRef} className="axis-canvas" />
    </div>
  );
}
