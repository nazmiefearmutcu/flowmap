import { useEffect, useRef } from 'react';

import { Renderer } from './gl/renderer';
import { useFlowMapStore } from './state/store';

/**
 * M2 T5 shell: a minimal trading-terminal top bar over the full-viewport GL
 * canvas, plus the live wiring. On mount the {@link Renderer} takes the canvas,
 * subscribes to the store's column stream and auto-follows the right edge, while
 * the store opens the WebSocket to the sim feed. The full UI shell (symbol
 * search, timeline, panels) is T12 — here the bar only surfaces the connection
 * status and the feed capability so the live state is legible.
 */

const SIM_MARKET = 'sim';
const SIM_SYMBOL = 'SIM-DEMO';

const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  connecting: 'connecting',
  live: 'live',
  reconnecting: 'reconnecting',
  closed: 'closed',
};

/** Compact capability chips from the feed's capability descriptor. */
function capabilityBadges(capability: Record<string, unknown> | null): string[] {
  if (!capability) return [];
  const badges: string[] = [];
  const depth = capability.depth;
  if (typeof depth === 'string') badges.push(depth.toUpperCase());
  const tape = capability.tape;
  if (typeof tape === 'string') badges.push(`TAPE ${tape.toUpperCase()}`);
  const side = capability.trade_side;
  if (typeof side === 'string') badges.push(`SIDE ${side.toUpperCase()}`);
  return badges;
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const status = useFlowMapStore((s) => s.status);
  const feedState = useFlowMapStore((s) => s.feedState);
  const capability = useFlowMapStore((s) => s.capability);
  const subscription = useFlowMapStore((s) => s.subscription);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Dev-only heatmap e2e hook (T4): `?test=heatmap` installs the synthetic
    // window.__flowmapTest driver and owns the canvas itself — no live wiring.
    if (new URLSearchParams(window.location.search).get('test') === 'heatmap') {
      let disposed = false;
      void import('./gl/testHook').then((m) => {
        if (!disposed) m.installHeatmapTestHook(canvas);
      });
      return () => {
        disposed = true;
      };
    }

    // Perf harness mode (T6 §10 gates): the renderer is preloaded with synthetic
    // history via __flowmapLive.renderer.preloadSynthetic — do NOT open the live
    // feed, which would fight the preloaded ring. Otherwise wire the sim feed.
    const perfMode = new URLSearchParams(window.location.search).get('perf') === '1';

    const renderer = new Renderer(canvas, useFlowMapStore);
    if (!perfMode) {
      useFlowMapStore.getState().connectAndSubscribe(SIM_MARKET, SIM_SYMBOL);
    }

    // Read-only diagnostics handle for the live-sim / perf e2e (dev/preview only).
    if (import.meta.env.DEV || perfMode) {
      (window as unknown as { __flowmapLive: unknown }).__flowmapLive = {
        renderer,
        store: useFlowMapStore,
      };
    }

    return () => {
      renderer.dispose();
      useFlowMapStore.getState().disconnect();
      if (import.meta.env.DEV) {
        delete (window as unknown as { __flowmapLive?: unknown }).__flowmapLive;
      }
    };
  }, []);

  const statusText = STATUS_LABEL[status] ?? status;
  const badges = capabilityBadges(capability);
  const symbolText = subscription ? `${subscription.market}:${subscription.symbol}` : SIM_SYMBOL;

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar__brand">FlowMap v2</span>
        <span className="topbar__symbol-tag">{symbolText}</span>
        <span className={`topbar__status topbar__status--${status}`}>
          <span className="topbar__dot" aria-hidden="true" />
          {statusText}
          {feedState && feedState !== 'live' ? ` · ${feedState}` : ''}
        </span>
        <span className="topbar__badges">
          {badges.map((b) => (
            <span key={b} className="topbar__badge">
              {b}
            </span>
          ))}
        </span>
      </header>
      <canvas id="gl" ref={canvasRef} className="gl-canvas" />
    </div>
  );
}
