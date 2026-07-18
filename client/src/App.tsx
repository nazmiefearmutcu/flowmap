import { useEffect, useRef, useState } from 'react';

import { Renderer } from './gl/renderer';
import { DEFAULT_OVERLAY_VISIBILITY, type OverlayVisibility } from './gl/overlays/frame';
import { Crosshair } from './ui/Crosshair';
import { DomLadder } from './ui/DomLadder';
import { OverlayToggles } from './ui/OverlayToggles';
import { PriceAxis } from './ui/PriceAxis';
import { Tape } from './ui/Tape';
import { TimeAxis } from './ui/TimeAxis';
import { bookStore } from './state/bookStore';
import { useFlowMapStore } from './state/store';

/**
 * M2 shell: a minimal trading-terminal top bar over the full-viewport GL canvas
 * with the price axis (right) + time axis (bottom) gutters (§9), the overlay
 * toggles, and the live wiring. On mount the {@link Renderer} takes the canvas,
 * subscribes to the store's column stream and auto-follows the right edge; it also
 * draws the overlays (trade bubbles, BBO, VWAP, volume profile, markers) over the
 * heatmap and the axis ticks into the two gutter canvases. The full UI shell
 * (symbol search, timeline, DOM/tape panels) is T11/T12.
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
  const priceAxisRef = useRef<HTMLCanvasElement>(null);
  const timeAxisRef = useRef<HTMLCanvasElement>(null);
  // Held so the Crosshair overlay can call renderer.probeAt (null in the
  // ?test=heatmap hook mode, which owns the canvas itself).
  const rendererRef = useRef<Renderer | null>(null);
  const status = useFlowMapStore((s) => s.status);
  const feedState = useFlowMapStore((s) => s.feedState);
  const capability = useFlowMapStore((s) => s.capability);
  const subscription = useFlowMapStore((s) => s.subscription);
  const [overlays, setOverlays] = useState<OverlayVisibility>(DEFAULT_OVERLAY_VISIBILITY);
  const [railVisible, setRailVisible] = useState(true);

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

    const params = new URLSearchParams(window.location.search);
    // Perf harness mode (T6 §10 gates): the renderer is preloaded with synthetic
    // history via __flowmapLive.renderer.preloadSynthetic — do NOT open the live
    // feed, which would fight the preloaded ring. Otherwise wire the sim feed.
    const perfMode = params.get('perf') === '1';

    // Normalization e2e (T9): like perf — no live feed — the spec preloads two
    // fixed density regions + a known wall via preloadNormalizeScenario.
    const normalizeMode = params.get('normalize') === '1';

    // Overlays e2e (T10): no live feed — the spec preloads a depth scenario via
    // preloadOverlayScenario and injects Trade/BBO/BarColumn/Marker via ingestForTest.
    const overlaysMode = params.get('overlays') === '1';

    // Panels e2e (T11): no live feed — the spec injects known DepthColumn/BBO/Trade
    // straight into the bookStore (bypassing the socket) and asserts the ladder/tape
    // DOM, so a competing live sim stream must NOT also fill the buffer.
    const panelsMode = params.get('panels') === '1';

    // Scroll-back e2e (T8): a small full-res budget so the live sim overruns it
    // quickly and panning left exercises the HistoryRequest backfill path.
    const scrollbackMode = params.get('scrollback') === '1';
    const budgetParam = params.get('budget');
    const rendererOpts = scrollbackMode
      ? { capacityColsTarget: budgetParam ? Number.parseInt(budgetParam, 10) : 512 }
      : {};

    const renderer = new Renderer(canvas, useFlowMapStore, rendererOpts);
    rendererRef.current = renderer;
    renderer.attachOverlaySurfaces(priceAxisRef.current, timeAxisRef.current);
    renderer.setOverlayVisibility(DEFAULT_OVERLAY_VISIBILITY);
    if (!perfMode && !normalizeMode && !overlaysMode && !panelsMode) {
      useFlowMapStore.getState().connectAndSubscribe(SIM_MARKET, SIM_SYMBOL);
    }

    // Read-only diagnostics handle for the live-sim / perf / scroll-back / T9 / T10 / T11 e2e.
    if (
      import.meta.env.DEV ||
      perfMode ||
      scrollbackMode ||
      normalizeMode ||
      overlaysMode ||
      panelsMode
    ) {
      (window as unknown as { __flowmapLive: unknown }).__flowmapLive = {
        renderer,
        store: useFlowMapStore,
        bookStore,
      };
    }

    return () => {
      renderer.dispose();
      rendererRef.current = null;
      useFlowMapStore.getState().disconnect();
      if (import.meta.env.DEV) {
        delete (window as unknown as { __flowmapLive?: unknown }).__flowmapLive;
      }
    };
  }, []);

  const toggleOverlay = (key: keyof OverlayVisibility): void => {
    setOverlays((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      rendererRef.current?.setOverlayVisibility({ [key]: next[key] });
      return next;
    });
  };

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
        <OverlayToggles visibility={overlays} onToggle={toggleOverlay} />
        <span className="topbar__badges">
          {badges.map((b) => (
            <span key={b} className="topbar__badge">
              {b}
            </span>
          ))}
          <button
            type="button"
            className={`topbar__rail-toggle${railVisible ? ' is-on' : ''}`}
            aria-pressed={railVisible}
            onClick={() => setRailVisible((v) => !v)}
            data-testid="rail-toggle"
          >
            Rail
          </button>
        </span>
      </header>
      <div className="workspace">
        <div className="stage">
          <div className="stage__viewport">
            <canvas id="gl" ref={canvasRef} className="gl-canvas" />
            <Crosshair canvasRef={canvasRef} rendererRef={rendererRef} />
          </div>
          <PriceAxis canvasRef={priceAxisRef} />
          <TimeAxis canvasRef={timeAxisRef} />
          <div className="stage__corner" aria-hidden="true" />
        </div>
        {railVisible && (
          <aside className="right-rail" data-testid="right-rail">
            <DomLadder />
            <Tape />
          </aside>
        )}
      </div>
    </div>
  );
}
