/**
 * Time axis (§9: time axis bottom), M2 T10.
 *
 * A thin bottom gutter whose `<canvas>` the {@link Renderer} draws wall-clock time
 * ticks into every dirty frame (see gl/overlays/axes.ts `drawTimeAxis`), derived
 * from each column's `t0_ns`. The gutter shares the heatmap viewport's WIDTH, so a
 * column maps to the same x in both — the labels stay pinned under pan/zoom. React
 * owns only the chrome + the canvas element; the renderer paints the pixels.
 */

import type { RefObject } from 'react';

interface TimeAxisProps {
  canvasRef: RefObject<HTMLCanvasElement>;
}

export function TimeAxis({ canvasRef }: TimeAxisProps): JSX.Element {
  return (
    <div className="time-axis" aria-hidden="true">
      <canvas ref={canvasRef} className="axis-canvas" />
    </div>
  );
}
