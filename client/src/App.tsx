import { useCallback, useEffect, useRef, useState } from 'react';

import { Renderer } from './gl/renderer';
import { attachGlobalKeys } from './input/keys';
import { decodeFrame } from './proto/decode';
import type { StreamMode } from './proto/types';
import { Crosshair } from './ui/Crosshair';
import { DomLadder } from './ui/DomLadder';
import { PriceAxis } from './ui/PriceAxis';
import { SettingsDrawer } from './ui/SettingsDrawer';
import { Tape } from './ui/Tape';
import { TimeAxis } from './ui/TimeAxis';
import { Timeline } from './ui/Timeline';
import { TopBar } from './ui/TopBar';
import type { SymbolSearchHandle } from './ui/SymbolSearch';
import {
  loadSettings,
  saveSettings,
  type FlowMapSettings,
} from './ui/settings';
import { bookStore } from './state/bookStore';
import { setFlowMapTransport, useFlowMapStore } from './state/store';
import type { SocketLike } from './net/connection';

/**
 * M2 shell (§9, T12). The workspace: the top bar (symbol search / venue /
 * capability badges / live-replay toggle / clock), the heatmap stage (dominant GL
 * canvas + price/time axis gutters + overlays) with the collapsible right rail
 * (DOM ladder + tape), the bottom timeline (session minimap + replay transport),
 * and the settings drawer. Persisted settings drive the live-honourable knobs
 * (overlays / bubble threshold / follow / rail); global keys add Space + `/`.
 *
 * High-frequency data stays out of React: the Renderer owns the canvas and reads
 * the store's raw stream directly; this component only holds low-frequency UI
 * state and polls the renderer's timeline geometry at ≤5 Hz.
 */

const SIM_MARKET = 'sim';
const SIM_SYMBOL = 'SIM-DEMO';

/** Format an absolute (session-relative for sim) ns timestamp as HH:MM:SS. */
function fmtStreamClock(ns: bigint): string | null {
  const ms = Number(ns / 1_000_000n);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString().slice(11, 19);
  } catch {
    return null;
  }
}

/**
 * Dev/e2e control tap (`?spy=1`): wrap the WebSocket so every outbound control
 * frame is decoded (bigints → strings) into `window.__flowmapControls`, letting a
 * spec assert the exact Subscribe / Pause / Resume / SetSpeed / Seek messages the
 * transport sends. Never installed in production (the query param gates it).
 */
function installControlSpy(): void {
  const sent: unknown[] = [];
  (window as unknown as { __flowmapControls: unknown[] }).__flowmapControls = sent;
  const replacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
  setFlowMapTransport({
    wsFactory: (url: string): SocketLike => {
      const ws = new WebSocket(url);
      const origSend = ws.send.bind(ws);
      ws.send = ((data: ArrayBufferLike | ArrayBufferView | string): void => {
        try {
          let u8: Uint8Array | null = null;
          if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
          else if (ArrayBuffer.isView(data)) {
            u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          }
          if (u8 && u8.length) {
            for (const m of decodeFrame(u8)) sent.push(JSON.parse(JSON.stringify(m, replacer)));
          }
        } catch {
          /* never let the tap break the socket */
        }
        origSend(data as never);
      }) as typeof ws.send;
      return ws as unknown as SocketLike;
    },
  });
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const priceAxisRef = useRef<HTMLCanvasElement>(null);
  const timeAxisRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const searchRef = useRef<SymbolSearchHandle>(null);

  const [settings, setSettings] = useState<FlowMapSettings>(() =>
    loadSettings(typeof window !== 'undefined' ? window.localStorage : null),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [streamClock, setStreamClock] = useState<string | null>(null);

  // Keep the latest settings reachable from the mount-only renderer effect.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const prevSettingsRef = useRef(settings);

  // --- renderer lifecycle (mount once) -----------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Dev-only heatmap e2e hook (T4): `?test=heatmap` owns the canvas itself.
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
    const perfMode = params.get('perf') === '1';
    const normalizeMode = params.get('normalize') === '1';
    const overlaysMode = params.get('overlays') === '1';
    const panelsMode = params.get('panels') === '1';
    const scrollbackMode = params.get('scrollback') === '1';
    const spyMode = params.get('spy') === '1';
    const budgetParam = params.get('budget');
    const rendererOpts = scrollbackMode
      ? { capacityColsTarget: budgetParam ? Number.parseInt(budgetParam, 10) : 512 }
      : {};

    // Install the control tap BEFORE the store opens its socket.
    if (spyMode) installControlSpy();

    const renderer = new Renderer(canvas, useFlowMapStore, rendererOpts);
    rendererRef.current = renderer;
    renderer.attachOverlaySurfaces(priceAxisRef.current, timeAxisRef.current);
    // Apply persisted, live-honourable settings at boot.
    renderer.setOverlayVisibility(settingsRef.current.overlays);
    renderer.setBubbleMinSize(settingsRef.current.bubbleMinSize);

    if (!perfMode && !normalizeMode && !overlaysMode && !panelsMode) {
      useFlowMapStore.getState().connectAndSubscribe(SIM_MARKET, SIM_SYMBOL);
    }

    if (
      import.meta.env.DEV ||
      perfMode ||
      scrollbackMode ||
      normalizeMode ||
      overlaysMode ||
      panelsMode ||
      spyMode
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

  // --- persist + apply settings on change --------------------------------------
  useEffect(() => {
    saveSettings(settings, typeof window !== 'undefined' ? window.localStorage : null);
    const r = rendererRef.current;
    if (r) {
      r.setOverlayVisibility(settings.overlays); // idempotent
      r.setBubbleMinSize(settings.bubbleMinSize); // idempotent
      // Follow is edge-triggered so it never fights a manual F / Space toggle.
      if (settings.follow !== prevSettingsRef.current.follow) {
        if (settings.follow && !r.following) r.goLive();
        else if (!settings.follow && r.following) r.toggleFollow();
      }
    }
    prevSettingsRef.current = settings;
  }, [settings]);

  // --- stream clock (≤1 Hz) -----------------------------------------------------
  useEffect(() => {
    const tick = (): void => {
      const tl = rendererRef.current?.timeline();
      if (!tl || !tl.timeBase) {
        setStreamClock((c) => (c === null ? c : null));
        return;
      }
      const { anchorSeq, anchorT0Ns, dtNs } = tl.timeBase;
      const ns = anchorT0Ns + BigInt(Math.round((tl.newestSeq - anchorSeq) * dtNs));
      const next = fmtStreamClock(ns);
      setStreamClock((c) => (c === next ? c : next));
    };
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  // --- global keyboard (Space / `/`) -------------------------------------------
  useEffect(() => {
    return attachGlobalKeys({
      onSpace: () => {
        const s = useFlowMapStore.getState();
        if (s.subscription?.mode === 'replay') {
          if (s.paused) s.resume();
          else s.pause();
        } else {
          rendererRef.current?.toggleFollow();
        }
      },
      onFocusSearch: () => searchRef.current?.focus(),
    });
  }, []);

  // --- settings patch (merge → state → effect persists + applies) --------------
  const applyPatch = useCallback((patch: Partial<FlowMapSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  // --- symbol / mode actions ---------------------------------------------------
  const onSelectSymbol = useCallback((market: string, symbol: string) => {
    const mode = useFlowMapStore.getState().subscription?.mode ?? 'live';
    useFlowMapStore.getState().connectAndSubscribe(market, symbol, mode);
  }, []);

  const onSetMode = useCallback((mode: StreamMode) => {
    const sub = useFlowMapStore.getState().subscription;
    const market = sub?.market ?? SIM_MARKET;
    const symbol = sub?.symbol ?? SIM_SYMBOL;
    useFlowMapStore.getState().connectAndSubscribe(market, symbol, mode);
  }, []);

  const toggleRail = useCallback(
    () => setSettings((prev) => ({ ...prev, railVisible: !prev.railVisible })),
    [],
  );

  return (
    <div className="app">
      <TopBar
        ref={searchRef}
        onSelectSymbol={onSelectSymbol}
        onSetMode={onSetMode}
        railVisible={settings.railVisible}
        onToggleRail={toggleRail}
        onOpenSettings={() => setSettingsOpen(true)}
        streamClock={streamClock}
      />

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
        {settings.railVisible && (
          <aside className="right-rail" data-testid="right-rail">
            <DomLadder />
            <Tape />
          </aside>
        )}
      </div>

      <Timeline rendererRef={rendererRef} />

      {settingsOpen && (
        <SettingsDrawer
          settings={settings}
          onChange={applyPatch}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
