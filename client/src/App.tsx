import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { floorForTolerance, gammaForContrast } from './gl/heatmap';
import { Renderer } from './gl/renderer';
import { applyOverlayPalette } from './gl/overlays/palette';
import { attachThemeKey, DEFAULT_THEME_ID, getCanvasPalette, useTheme } from './theme';
import { attachGlobalKeys, classifyTarget } from './input/keys';
import { decodeFrame } from './proto/decode';
import type { StreamMode } from './proto/types';
import { ClosedBanner } from './ui/ClosedBanner';
import { Crosshair } from './ui/Crosshair';
import { CvdPane } from './ui/CvdPane';
import { DepthChannelHotkey } from './ui/DepthChannelHotkey';
import { DrawingLayer } from './ui/DrawingLayer';
import { DomLadder } from './ui/DomLadder';
import { DrawToolbar } from './ui/DrawToolbar';
import { IndicatorOverlayCanvas } from './ui/IndicatorOverlayCanvas';
import { IndicatorPicker } from './ui/IndicatorPicker';
import { isHelpToggle } from './ui/keysheet';
import { LiveControls } from './ui/LiveControls';
import { HeatLegend } from './ui/HeatLegend';
import { MeasureTool, rendererChartMap } from './ui/MeasureTool';
import { OnboardingCard } from './ui/OnboardingCard';
import { PerfHud } from './ui/PerfHud';
import { PriceAlerts } from './ui/PriceAlerts';
import { PriceAxis } from './ui/PriceAxis';
import { ReconnectBanner } from './ui/ReconnectBanner';
import { SettingsDrawer } from './ui/SettingsDrawer';
import { ShortcutsOverlay } from './ui/ShortcutsOverlay';
import { Tape } from './ui/Tape';
import { TimeAxis } from './ui/TimeAxis';
import { Timeline } from './ui/Timeline';
import { Toaster } from './ui/Toaster';
import { TopBar } from './ui/TopBar';
import { Watchlist } from './ui/Watchlist';
import { runPngExport } from './ui/exportPng';
import type { SymbolSearchHandle } from './ui/SymbolSearch';
import {
  DEPTH_CHANNELS,
  historyDepthCols,
  loadSettings,
  saveSettings,
  type FlowMapSettings,
} from './ui/settings';
import { useAlertMonitor } from './state/alertMonitor';
import { bookStore } from './state/bookStore';
import { sessionResetKey, setFlowMapTransport, useFlowMapStore } from './state/store';
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
  // The chart container every data-space overlay (measure / drawings / indicator
  // canvas) anchors to — lane CD's mount contract.
  const stageViewportRef = useRef<HTMLDivElement>(null);

  const [settings, setSettings] = useState<FlowMapSettings>(() =>
    loadSettings(typeof window !== 'undefined' ? window.localStorage : null),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The `?` shortcuts overlay (ui/ShortcutsOverlay) — a small modal listing the
  // same keysheet the settings drawer renders.
  const [helpOpen, setHelpOpen] = useState(false);
  // Non-null while the "export refused" note shows in the TopBar (lost GL
  // context — never a fake success). Cleared by dismissal or a later success.
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [streamClock, setStreamClock] = useState<string | null>(null);
  // WebGL2 unavailable: the heatmap canvas cannot render, but the DOM panels
  // (ladder, tape, search) can — the app degrades instead of dying (F1).
  const [glError, setGlError] = useState<string | null>(null);

  // Theme (lane CE): drives the canvas overlay palette bridge below. App only
  // re-renders on an actual theme switch (useSyncExternalStore), which is
  // human-frequency.
  const { theme } = useTheme();

  // Campaign-4 P4: evaluates armed alerts for NON-active symbols by polling
  // `/api/quote` through the shared quoteFeed (visibility-gated, stale-skipping).
  useAlertMonitor();

  // ONE mapping pair for every data-space overlay (CD measure / CF drawings /
  // CG indicators). `rendererChartMap` closes over the renderer REF, so each
  // `fromChart`/`toChart` call reads the LIVE camera/cache at call time — the
  // pair itself never goes stale, and each mounted consumer re-probes on its
  // own cadence (pointer events, ~10 Hz poll, rAF signature) because the
  // renderer exposes no view-changed callback in this build.
  const chartMap = useMemo(() => rendererChartMap(rendererRef), []);

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

    // GL setup can legitimately fail (no WebGL2 in browser/context — VMs,
    // remote desktops, disabled GPU). Catch it: mark the fallback, still
    // CONNECT (DOM panels run fine without the canvas), and never spawn the
    // renderer. Letting the throw escape would unmount the whole React tree
    // into a silent black screen.
    let renderer: Renderer;
    try {
      renderer = new Renderer(canvas, useFlowMapStore, rendererOpts);
      renderer.attachOverlaySurfaces(priceAxisRef.current, timeAxisRef.current);
    } catch (err) {
      setGlError(err instanceof Error ? err.message : String(err));
      if (!perfMode && !normalizeMode && !overlaysMode && !panelsMode) {
        useFlowMapStore
          .getState()
          .connectAndSubscribe(SIM_MARKET, SIM_SYMBOL, 'live', settingsRef.current.priceBand);
      }
      return () => {
        useFlowMapStore.getState().disconnect();
      };
    }
    rendererRef.current = renderer;
    // Apply persisted, live-honourable settings at boot.
    renderer.setOverlayVisibility(settingsRef.current.overlays);
    renderer.setBubbleMinSize(settingsRef.current.bubbleMinSize);
    renderer.setContrast(gammaForContrast(settingsRef.current.contrast));
    renderer.setTolerance(floorForTolerance(settingsRef.current.tolerance));
    renderer.setColormap(settingsRef.current.colormap);
    renderer.setNormPercentile(settingsRef.current.normPercentile);
    // Follow policy is remembered by the renderer (`want*`) so the lazy ring
    // creation on the first column cannot discard it.
    renderer.setFollowTime(settingsRef.current.follow);
    // BOOT uses 'fit' on purpose: there is no user zoom to preserve yet, and
    // auto-fit is the only thing that frames the book instead of showing the whole
    // multi-thousand-row grid as a hairline. The "keeps your zoom" contract kicks
    // in AFTER the user has a scale — the settings toggle and the axis chip enable
    // 'track' (below / PriceAxis.tsx), and a price zoom promotes 'fit'→'track'.
    renderer.setPriceFollow(settingsRef.current.followPrice ? 'fit' : 'off');
    // Depth display channel (contract C2 — CB's setter, optional-chained so a
    // build without it keeps the default 'sum' rendering).
    renderer.setDepthChannel?.(settingsRef.current.depthChannel);
    // Tick grouping (campaign-4 P1 — optional-chained for the same reason).
    renderer.setTickGrouping?.(settingsRef.current.tickGrouping);

    if (!perfMode && !normalizeMode && !overlaysMode && !panelsMode) {
      useFlowMapStore
        .getState()
        .connectAndSubscribe(SIM_MARKET, SIM_SYMBOL, 'live', settingsRef.current.priceBand);
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
      r.setContrast(gammaForContrast(settings.contrast)); // idempotent
      r.setTolerance(floorForTolerance(settings.tolerance)); // idempotent
      r.setColormap(settings.colormap); // idempotent
      r.setNormPercentile(settings.normPercentile); // idempotent
      r.setDepthChannel?.(settings.depthChannel); // C2, idempotent
      r.setTickGrouping?.(settings.tickGrouping); // P1, idempotent
      // Both follows are edge-triggered so they never fight a manual gesture,
      // and each compares against the renderer's LIVE state (a gesture changes
      // the camera without writing settings, so comparing only against the
      // previous settings value would leave the switch showing a stale ON).
      if (settings.follow !== prevSettingsRef.current.follow && settings.follow !== r.following) {
        // setFollowTime, not goLive: re-pinning the right edge must not discard
        // the price zoom the user has chosen.
        r.setFollowTime(settings.follow);
      }
      // The band is a SERVER grid property, so changing it must re-subscribe.
      // Edge-triggered. The re-subscribe changes `sessionResetKey` (band is part
      // of it), and the effect below tears the ring down and refetches — which is
      // the point: `deep` is a 4096-row grid where the default is 2048, so a ring
      // kept from the old band would be the wrong height for every column that
      // follows.
      if (settings.priceBand !== prevSettingsRef.current.priceBand) {
        const sub = useFlowMapStore.getState().subscription;
        useFlowMapStore
          .getState()
          .connectAndSubscribe(
            sub?.market ?? SIM_MARKET,
            sub?.symbol ?? SIM_SYMBOL,
            sub?.mode ?? 'live',
            settings.priceBand,
          );
      }
      if (settings.followPrice !== prevSettingsRef.current.followPrice) {
        const wantOn = settings.followPrice;
        // 'track' keeps the user's zoom (recentre-on-drift); never 'fit', which
        // re-frames to the book extent and discards the chosen scale.
        if (wantOn && r.priceFollow === 'off') r.setPriceFollow('track');
        else if (!wantOn && r.priceFollow !== 'off') r.setPriceFollow('off');
      }
      // A mid-session history-depth change applies LIVE (every other drawer knob
      // does): pull the newly-chosen span now, bounded to the ring by the prefetch
      // guard. A decrease is a no-op — already-loaded history stays resident.
      if (settings.historyDepth !== prevSettingsRef.current.historyDepth && settings.historyDepth !== 'off') {
        const tl = r.timeline();
        if (tl?.timeBase) r.prefetchHistory(historyDepthCols(settings.historyDepth, tl.timeBase.dtNs));
      }
    }
    prevSettingsRef.current = settings;
  }, [settings]);

  // --- reset the heatmap on an actual grid switch ------------------------------
  // The DOM ladder + tape read the live book and switch on their own, but the GL
  // heatmap holds the old symbol's ring + a camera fit to the old price frame, so
  // on a real switch we tear the renderer's GL state back down to empty (the next
  // column of the new session rebuilds it, fit to the new price range) and clear
  // the shared book buffer (so the ladder/tape don't flash the old symbol). Keyed
  // on `sessionResetKey` (market:symbol:BAND) — NOT sessionId — so a bare
  // reconnect of the SAME grid (a mode toggle, a transport reconnect) keeps any
  // scrolled-back history, while a band change, which really does start a new
  // server session at a possibly different row count, does reset. The FIRST
  // subscription (the initial mount connect) is skipped: the renderer already
  // starts empty.
  const subscription = useFlowMapStore((s) => s.subscription);
  const subKey = sessionResetKey(subscription);
  const prevSubKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (subKey === null) return;
    const prev = prevSubKeyRef.current;
    prevSubKeyRef.current = subKey;
    // Skip the first subscription (nothing to reset) and any no-op re-run.
    if (prev === null || prev === subKey) return;
    rendererRef.current?.resetForSession();
    bookStore.resetForSession();
  }, [subKey]);

  // The reset above fires when we ASK for a new symbol; frames for the old one
  // are still in flight and land in the freshly-cleared buffers. On a liquid
  // name the new prints push them out within a second and nobody notices — on a
  // thin venue (most of the ~104 ccxt venues have quiet pairs) they simply stay,
  // and the tape shows another instrument's trades at another instrument's
  // prices indefinitely. `sessionId` changes only when the server's Hello lands
  // on attach, which IS the moment the stream provably swapped, so clear again
  // there. Cheap and self-healing: the attach snapshot re-sends the book and the
  // tape warm-up, so a reconnect refills what this drops.
  const sessionId = useFlowMapStore((s) => s.sessionId);
  useEffect(() => {
    if (sessionId === null) return;
    bookStore.resetForSession();
  }, [sessionId]);

  // --- first-launch history prefetch (once per session) ------------------------
  // When the chosen depth is not 'off', wait for the first column (so we know the
  // epoch's dt), translate the wall-clock depth to columns, and eagerly pull that
  // much history into the ring so scroll-back is instant. Runs once per session.
  useEffect(() => {
    // Skip inside the e2e test harnesses (?scrollback / ?perf / …): those drive
    // history + residency deterministically, and an eager auto-prefetch would
    // pollute their request-count / LRU assertions.
    const p = new URLSearchParams(window.location.search);
    if (['scrollback', 'perf', 'normalize', 'overlays', 'panels'].some((m) => p.get(m) === '1')) return;
    let done = false;
    const id = window.setInterval(() => {
      if (done) return;
      const tl = rendererRef.current?.timeline();
      if (!tl || !tl.timeBase) return; // wait for the first data
      // Read the depth LIVE (not captured at setup) so a choice made during the
      // boot window before the first column takes effect.
      const depth = settingsRef.current.historyDepth;
      if (depth !== 'off') rendererRef.current?.prefetchHistory(historyDepthCols(depth, tl.timeBase.dtNs));
      done = true;
      window.clearInterval(id);
    }, 400);
    return () => window.clearInterval(id);
  }, [subKey]);

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

  // --- global keyboard (Space / `/` / `E`) -------------------------------------
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
      onExportPng: exportPng,
    });
  }, []);

  // --- `?` toggles the shortcuts overlay ---------------------------------------
  // Handled OUTSIDE attachGlobalKeys (input/keys.ts is not aware of `?`), but
  // with the SAME focus-safety rules via the shared isHelpToggle: never fires
  // while typing (a typed `?` is a search character) and never while a dialog
  // owns the keyboard (the overlay closes itself with Escape).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!isHelpToggle(e.key, classifyTarget(e.target))) return;
      e.preventDefault();
      setHelpOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- theme (lane CE) -----------------------------------------------------------
  // `T` cycles themes (self-contained binder from the theme module; editable
  // and dialog guarded, so it yields to the drawer/search like the keys above).
  useEffect(() => attachThemeKey(), []);

  // Theme → canvas bridge: GL/2D overlay colors follow the shell theme. The
  // DEFAULT theme (`midnight`) IS the shipped literal palette, so the bridge is
  // never invoked for it (pixel-identity by construction); switching back to
  // midnight restores the originals via the null call.
  useEffect(() => {
    applyOverlayPalette(theme === DEFAULT_THEME_ID ? null : getCanvasPalette(theme));
  }, [theme]);

  // The theme STORE owns the value (useTheme resolves stored → prefers →
  // default); this effect keeps <html data-theme> in lockstep with it, so the
  // first paint and every later render agree even when the store was resolved
  // before any setTheme/initTheme ran (fix 2026-09-10 F1-4: no second source
  // of truth, no first-run flip). setTheme also writes the attribute — this
  // only heals the pre-init path and is otherwise a no-op.
  useEffect(() => {
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  // --- settings patch (merge → state → effect persists + applies) --------------
  const applyPatch = useCallback((patch: Partial<FlowMapSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  // --- symbol / mode actions ---------------------------------------------------
  const onSelectSymbol = useCallback((market: string, symbol: string) => {
    const mode = useFlowMapStore.getState().subscription?.mode ?? 'live';
    // The band MUST ride along: without it a symbol switch silently reverts the
    // server grid to `native` while the drawer keeps showing the chosen preset.
    useFlowMapStore
      .getState()
      .connectAndSubscribe(market, symbol, mode, settingsRef.current.priceBand);
  }, []);

  const onSetMode = useCallback((mode: StreamMode) => {
    const sub = useFlowMapStore.getState().subscription;
    const market = sub?.market ?? SIM_MARKET;
    const symbol = sub?.symbol ?? SIM_SYMBOL;
    useFlowMapStore
      .getState()
      .connectAndSubscribe(market, symbol, mode, settingsRef.current.priceBand);
  }, []);

  // GO LIVE routes through App (not straight to the renderer) so it also re-arms
  // the PERSISTED follow flags. Without that, a user who scrolled back would find
  // the drawer's follow switches still reading ON while the camera was frozen —
  // and the next drawer interaction would fight the camera.
  const onGoLive = useCallback(() => {
    rendererRef.current?.goLive();
    setSettings((prev) =>
      prev.follow && prev.followPrice ? prev : { ...prev, follow: true, followPrice: true },
    );
  }, []);

  // Re-enable price tracking WITHOUT re-fitting: 'track' keeps the user's zoom
  // and only recentres on drift (the non-destructive counterpart to GO LIVE).
  const onTrackPrice = useCallback(() => {
    rendererRef.current?.setPriceFollow('track');
    setSettings((prev) => (prev.followPrice ? prev : { ...prev, followPrice: true }));
  }, []);

  const toggleRail = useCallback(
    () => setSettings((prev) => ({ ...prev, railVisible: !prev.railVisible })),
    [],
  );

  // PNG export (top-bar button AND the bare `E` key route through this one
  // handler): snapshot the renderer synchronously, download on success, and on
  // a null snapshot (lost GL context) show the TopBar's dismissible note —
  // never a fake success. The subscription is read at call time so the filename
  // always names what is on screen right now.
  const exportPng = useCallback(() => {
    const sub = useFlowMapStore.getState().subscription;
    const filename = runPngExport(
      rendererRef.current?.snapshot() ?? null,
      sub?.market ?? SIM_MARKET,
      sub?.symbol ?? SIM_SYMBOL,
      new Date(),
    );
    setExportNotice(
      filename
        ? null
        : 'PNG export unavailable — the graphics context is lost. The chart will repaint when it recovers.',
    );
  }, []);

  const dismissExportNotice = useCallback(() => setExportNotice(null), []);

  // --- lane CD: perf-HUD + depth-channel key callbacks ---------------------------
  const toggleHud = useCallback(
    () => setSettings((p) => ({ ...p, hudVisible: !p.hudVisible })),
    [],
  );
  const cycleDepthChannel = useCallback(() => {
    setSettings((p) => ({
      ...p,
      depthChannel: DEPTH_CHANNELS[(DEPTH_CHANNELS.indexOf(p.depthChannel) + 1) % DEPTH_CHANNELS.length],
    }));
  }, []);

  // Active chart scope for the per-symbol overlays (drawings persistence +
  // toolbar label). The store's subscription is the source of truth.
  const activeSymbol = subscription?.symbol ?? SIM_SYMBOL;
  const activeMarket = subscription?.market ?? SIM_MARKET;

  return (
    <div className="app">
      <TopBar
        ref={searchRef}
        onSelectSymbol={onSelectSymbol}
        onSetMode={onSetMode}
        railVisible={settings.railVisible}
        onToggleRail={toggleRail}
        onOpenSettings={() => setSettingsOpen(true)}
        onExportPng={exportPng}
        exportNotice={exportNotice}
        onDismissExportNotice={dismissExportNotice}
        streamClock={streamClock}
      />

      <div className="workspace">
        <div className={`stage${settings.overlays.cvd ? ' stage--cvd' : ''}`}>
          <div className="stage__viewport" ref={stageViewportRef}>
            <canvas id="gl" ref={canvasRef} className="gl-canvas" />
            {glError && (
              <div className="gl-fallback" role="alert" data-testid="gl-fallback">
                <span className="gl-fallback__title">Heatmap unavailable</span>
                <span className="gl-fallback__body">
                  WebGL2 is not available in this browser/context
                  {glError ? ` (${glError})` : ''}, so the chart canvas cannot render. The DOM
                  panels — symbol search, DOM ladder, time &amp; sales — keep working.
                </span>
              </div>
            )}
            {/* Campaign-3 chart overlay stack, bottom → top: GL canvas →
                indicator overlay → drawings → measure → alert markers →
                crosshair / HUD. Each layer manages its own pointer-events so
                none steals chart pan/zoom gestures while disarmed. */}
            <IndicatorOverlayCanvas chartMap={chartMap} />
            <DrawingLayer
              containerRef={stageViewportRef}
              chartMap={chartMap}
              symbol={activeSymbol}
              market={activeMarket}
              getTimeBase={() => rendererRef.current?.timeline()?.timeBase ?? null}
            />
            <MeasureTool containerRef={stageViewportRef} map={chartMap} />
            <PriceAlerts rendererRef={rendererRef} soundEnabled={settings.alertSound} />
            <Crosshair canvasRef={canvasRef} rendererRef={rendererRef} />
            <HeatLegend colormap={settings.colormap} channel={settings.depthChannel} />
            <PerfHud rendererRef={rendererRef} visible={settings.hudVisible} onToggle={toggleHud} />
            <ClosedBanner />
            <ReconnectBanner />
            <LiveControls
              rendererRef={rendererRef}
              onGoLive={onGoLive}
              onTrackPrice={onTrackPrice}
            />
            <DrawToolbar symbol={activeSymbol} />
            <IndicatorPicker />
            <DepthChannelHotkey onCycle={cycleDepthChannel} />
          </div>
          <PriceAxis canvasRef={priceAxisRef} rendererRef={rendererRef} />
          {settings.overlays.cvd && (
            <>
              <CvdPane rendererRef={rendererRef} />
              <div className="cvd-corner" aria-hidden="true" />
            </>
          )}
          <TimeAxis canvasRef={timeAxisRef} />
          <div className="stage__corner" aria-hidden="true" />
        </div>
        {settings.railVisible && (
          <aside className="right-rail" data-testid="right-rail">
            <Watchlist
              activeKey={`${activeMarket}:${activeSymbol}`}
              onSelect={(key) => {
                const i = key.indexOf(':');
                if (i > 0) onSelectSymbol(key.slice(0, i), key.slice(i + 1));
              }}
            />
            <DomLadder />
            <Tape bigTradeUsd={settings.bigTradeUsd} />
          </aside>
        )}
      </div>

      <Timeline rendererRef={rendererRef} onGoLive={onGoLive} />

      {settingsOpen && (
        <SettingsDrawer
          settings={settings}
          onChange={applyPatch}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {helpOpen && <ShortcutsOverlay onClose={() => setHelpOpen(false)} />}

      {/* lane CE: themeable toast stack + first-run onboarding wizard */}
      <Toaster />
      <OnboardingCard />
    </div>
  );
}
