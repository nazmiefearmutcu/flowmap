import { useEffect, useRef } from 'react';

/**
 * M2 shell skeleton. A placeholder top bar over a full-viewport GL canvas.
 * The WebGL2 renderer, protocol, and UI panels arrive in later tasks — this
 * task only stands up the terminal-looking shell so the layout is in place.
 */
export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Keep the canvas backing store matched to its CSS size (device pixels).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Dev-only heatmap e2e hook: `?test=heatmap` installs window.__flowmapTest
    // (T4 verification) and owns the canvas size itself, so skip DPR resize.
    // Guarded by the query param so production is untouched.
    if (new URLSearchParams(window.location.search).get('test') === 'heatmap') {
      let disposed = false;
      void import('./gl/testHook').then((m) => {
        if (!disposed) m.installHeatmapTestHook(canvas);
      });
      return () => {
        disposed = true;
      };
    }

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { clientWidth, clientHeight } = canvas;
      canvas.width = Math.max(1, Math.round(clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(clientHeight * dpr));
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar__brand">FlowMap v2</span>
        <input
          className="topbar__symbol"
          type="text"
          placeholder="Symbol"
          aria-label="Symbol"
          disabled
        />
      </header>
      <canvas id="gl" ref={canvasRef} className="gl-canvas" />
    </div>
  );
}
