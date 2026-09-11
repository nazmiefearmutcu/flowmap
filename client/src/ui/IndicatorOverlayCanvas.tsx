/**
 * IndicatorOverlayCanvas (campaign 3, lane CG) — draws the ACTIVE indicators.
 *
 * One 2D canvas riding the chart stack inside a positioned host (the parent is
 * `position:relative` — the campaign canvas rule), `pointer-events:none`, so
 * pan/zoom/crosshair gestures are untouched. Two visual zones:
 *
 *  - OVERLAY pane (SMA / EMA / VWAP / Bollinger): polylines mapped through the
 *    SAME price scale and camera as the heatmap, via the injected
 *    {@link ChartMapPair} (the lane-CD contract — INT passes the identical
 *    `rendererChartMap(rendererRef)` pair it already builds for MeasureTool;
 *    the DEFAULT is the identity map so the canvas renders standalone).
 *  - SUB pane (RSI / MACD / ATR / OBV): a translucent strip pinned to the
 *    BOTTOM of the canvas with its own per-lane y-scale, a zero line for
 *    histograms, and text labels. Height is configurable ({@link subPaneHeight}).
 *
 * Data path: candles from candles/store (live + replayed trades), indicator
 * math from streaming kernels (indicators/kernels) — O(1) per candle push. The
 * closed-candle history is fed once into per-instance value rings and each
 * repaint only PEEKS the forming candle. Repaints follow the CvdPane pattern:
 * a cheap signature (size, DPR, candle version, active list, epoch, camera
 * probe) gates the paint and an idle backoff stops the rAF spin.
 */

import { useEffect, useRef } from 'react';

import { getSnapshot, subscribe, type CandleSnapshot } from '../candles/store';
import { defById, type IndicatorDef, type OutputSpec } from '../indicators/registry';
import { useIndicatorStore } from '../indicators/store';
import type { IndicatorKernel } from '../indicators/kernels/types';
import { priceToRow as scalePriceToRow, scaleFromEpoch } from '../gl/priceScale';
import { useFlowMapStore } from '../state/store';
import type { ChartMapPair } from './MeasureTool';
import '../indicators/indicators.css';

/** Slot capacity for per-candle value rings (≥ synth ring 2000; resident span < ring, so slots are unique). */
const SLOT_CAP = 4096;

/** Literal fallbacks when a --indi-cN var is not resolvable (tests, exotic hosts). */
const FALLBACK_COLORS: Readonly<Record<string, string>> = {
  '--indi-c1': '#4cc2b5',
  '--indi-c2': '#e0a94e',
  '--indi-c3': '#9a86e8',
  '--indi-c4': '#5aa2e0',
  '--indi-c5': '#e8635f',
  '--indi-c6': '#67c96a',
};

const IDENTITY_TO = (col: number, row: number): { x: number; y: number } => ({ x: col, y: row });

/** Per-active-indicator drawn state: kernel + one value ring per output key. */
interface InstanceState {
  uid: string;
  def: IndicatorDef;
  kernel: IndicatorKernel;
  /** Value per candle slot (NaN = no value), one Float64Array per output key. */
  rings: Float64Array[];
  paramsSig: string;
  /** Bucket id of the last CLOSED candle committed to the kernel (−1 = none). */
  lastFedBi: number;
}

export interface IndicatorOverlayCanvasProps {
  /**
   * Container px ⇄ data space. INT passes the same `rendererChartMap(rendererRef)`
   * pair the other chart overlays use; defaults to the identity map.
   */
  chartMap?: ChartMapPair;
  /** Sub-pane strip height in CSS px (clamped to ≥ 40). Default 96. */
  subPaneHeight?: number;
}

/** Adaptive value formatting for pane labels (compact, finite-safe). */
function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  if (abs === 0) return '0';
  return v.toPrecision(2);
}

export function IndicatorOverlayCanvas({
  chartMap,
  subPaneHeight = 96,
}: IndicatorOverlayCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<ChartMapPair | undefined>(chartMap);
  mapRef.current = chartMap;
  const stripRef = useRef(Math.max(40, Math.round(subPaneHeight)));
  stripRef.current = Math.max(40, Math.round(subPaneHeight));
  const hasActive = useIndicatorStore((s) => s.active.length > 0);

  // Keep the indicator store pointed at the CURRENT symbol: the active list is
  // per-symbol persisted (`flowmap.indicators.<symbol>`), so a symbol switch
  // must swap it. Effect-scoped vanilla subscription (no re-render — the draw
  // loop reads the store imperatively; `active.length` drives only visibility).
  const subscription = useFlowMapStore((s) => s.subscription);
  useEffect(() => {
    useIndicatorStore.getState().syncSymbol(subscription?.symbol ?? null);
  }, [subscription]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Keep-alive subscriber: the candles store wires its `onStream` feed and
    // session watcher lazily on its FIRST subscriber, and this canvas is the
    // only production consumer (it polls `getSnapshot()` — it never needs the
    // change callbacks). Without this the synth never sees a trade and every
    // indicator draws nothing (R2: the lane-shipped wiring gap).
    const unsubCandles = subscribe(() => {});

    const instances = new Map<string, InstanceState>();
    let lastSig = '';
    let lastActiveSig = '';
    let snapVersion = -1;
    let cachedSnap: CandleSnapshot | null = null;
    let raf = 0;
    let pollTimer = 0;
    let idleStep = 0;
    const IDLE_MAX_MS = 250;

    const scheduleNext = (painted: boolean): void => {
      idleStep = painted ? 0 : Math.min(idleStep + 1, 8);
      const wait = painted ? 0 : Math.min(IDLE_MAX_MS, 2 ** idleStep);
      if (wait === 0) raf = requestAnimationFrame(draw);
      else pollTimer = window.setTimeout(() => { raf = requestAnimationFrame(draw); }, wait);
    };

    // --- kernel instance management -------------------------------------------

    const makeInstance = (
      uid: string,
      defId: string,
      params: Record<string, number>,
      paramsSig: string,
    ): InstanceState | null => {
      const def = defById(defId);
      if (def === null) return null;
      let kernel: IndicatorKernel;
      try {
        kernel = def.create(params);
      } catch {
        return null; // unclappable param combo (e.g. MACD fast>=slow): draw nothing
      }
      const rings = def.outputs.map(() => new Float64Array(SLOT_CAP).fill(Number.NaN));
      return { uid, def, kernel, rings, paramsSig, lastFedBi: -1 };
    };

    /** Sync the instance map to the active list; rebuilt instances refeed lazily. */
    const syncInstances = (active: readonly { uid: string; defId: string; params: Record<string, number> }[]): void => {
      const seen = new Set<string>();
      for (const a of active) {
        seen.add(a.uid);
        const sig = `${a.defId}|${JSON.stringify(a.params)}`;
        const cur = instances.get(a.uid);
        if (cur !== undefined && cur.paramsSig === sig) continue;
        instances.set(a.uid, makeInstance(a.uid, a.defId, a.params, sig) ?? {
          uid: a.uid,
          def: defById('sma')!,
          kernel: { outputKeys: ['x'], push: () => [null], peek: () => [null], reset: () => {} },
          rings: [new Float64Array(SLOT_CAP).fill(Number.NaN)],
          paramsSig: sig,
          lastFedBi: Number.MAX_SAFE_INTEGER, // broken entry: never fed, never drawn
        });
      }
      for (const uid of [...instances.keys()]) {
        if (!seen.has(uid)) instances.delete(uid);
      }
      snapVersion = -1; // force a feed pass so fresh instances load history
    };

    // --- feeding the kernels ----------------------------------------------------

    /** Commit every CLOSED candle newer than what the kernels already saw. */
    const feedNew = (snap: CandleSnapshot): void => {
      const cs = snap.candles;
      for (let i = 0; i < cs.length; i += 1) {
        const candle = cs[i];
        for (const inst of instances.values()) {
          if (candle.bi <= inst.lastFedBi) continue;
          const values = inst.kernel.push({ o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v });
          const slot = candle.bi % SLOT_CAP;
          for (let k = 0; k < inst.rings.length; k += 1) {
            const v = values[k];
            inst.rings[k][slot] = v === null || !Number.isFinite(v) ? Number.NaN : v;
          }
          inst.lastFedBi = candle.bi;
        }
      }
    };

    /** Reset kernels and replay the whole closed history (O(ring), rare). */
    const rebuildAll = (snap: CandleSnapshot): void => {
      for (const inst of instances.values()) {
        inst.kernel.reset();
        for (const r of inst.rings) r.fill(Number.NaN);
        inst.lastFedBi = -1;
      }
      feedNew(snap);
    };

    /** Peek the forming candle into the rings WITHOUT committing it. */
    const peekForming = (snap: CandleSnapshot): void => {
      const cs = snap.candles;
      if (cs.length === 0) return;
      const forming = cs[cs.length - 1];
      for (const inst of instances.values()) {
        const values = inst.kernel.peek({ o: forming.o, h: forming.h, l: forming.l, c: forming.c, v: forming.v });
        const slot = forming.bi % SLOT_CAP;
        for (let k = 0; k < inst.rings.length; k += 1) {
          const v = values[k];
          inst.rings[k][slot] = v === null || !Number.isFinite(v) ? Number.NaN : v;
        }
      }
    };

    /**
     * True when fed history is stale beyond appending (timeframe switch, ring
     * eviction/rewind, or a late trade revising an ALREADY-FED closed candle's
     * close) — the only events a streaming kernel cannot absorb incrementally.
     * Rare by construction; the rebuild is O(ring).
     */
    const needsRebuild = (prev: CandleSnapshot, next: CandleSnapshot): boolean => {
      if (prev.timeframeNs !== next.timeframeNs) return true;
      const prevCs = prev.candles;
      const nextCs = next.candles;
      const n = Math.min(prevCs.length, nextCs.length);
      for (let i = 0; i < n; i += 1) {
        if (prevCs[i].bi !== nextCs[i].bi || prevCs[i].c !== nextCs[i].c) return true;
      }
      return false;
    };

    // --- drawing ----------------------------------------------------------------

    let styleEl: CSSStyleDeclaration | null = null;
    const resolveColor = (out: OutputSpec, override: string | null | undefined): string => {
      if (override !== null && override !== undefined && override.length > 0) return override;
      if (styleEl === null) styleEl = getComputedStyle(document.documentElement);
      const raw = styleEl.getPropertyValue(out.colorVar).trim();
      if (raw.length > 0) return raw;
      return FALLBACK_COLORS[out.colorVar] ?? '#8ea0b5';
    };

    /** Candle bucket-start time → fractional chart column (NaN when unmappable). */
    const candleCol = (t0Ns: bigint, tfNs: number, tm: CandleSnapshot['timeMap']): number => {
      if (tm === null) return Number.NaN;
      const mid = t0Ns + BigInt(Math.round(tfNs / 2));
      return tm.anchorSeq + Number(mid - tm.anchorT0Ns) / tm.dtNs;
    };

    const paint = (): void => {
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW === 0 || cssH === 0) return;
      const wantW = Math.round(cssW * dpr);
      const wantH = Math.round(cssH * dpr);
      if (canvas.width !== wantW || canvas.height !== wantH) {
        canvas.width = wantW;
        canvas.height = wantH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const active = useIndicatorStore.getState().active;
      const snap = getSnapshot();
      const cs = snap.candles;
      const tfNs = snap.timeframeNs;
      const to = mapRef.current?.toChart ?? IDENTITY_TO;
      const fm = useFlowMapStore.getState();
      const ep = fm.gridEpoch === null ? undefined : fm.epochs.get(fm.gridEpoch);
      const scale = ep === undefined ? null : scaleFromEpoch(ep);
      const slotOf = (bi: number): number => bi % SLOT_CAP;

      styleEl = null; // re-resolve theme colors each paint

      const stripH = stripRef.current;
      const subActive = active.filter((a) => instances.get(a.uid)?.def.pane === 'sub');
      const chartBottom = subActive.length > 0 ? cssH - stripH : cssH;

      const lineColors = new Map<string, string>();
      const colorOf = (uid: string, out: OutputSpec): string => {
        const key = `${uid}|${out.key}`;
        let c = lineColors.get(key);
        if (c === undefined) {
          const a = active.find((x) => x.uid === uid);
          c = resolveColor(out, a?.colors[out.key]);
          lineColors.set(key, c);
        }
        return c;
      };

      // --- overlay pane -----------------------------------------------------------
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const a of active) {
        const inst = instances.get(a.uid);
        if (inst === undefined || inst.def.pane !== 'overlay' || scale === null) continue;
        for (let oi = 0; oi < inst.def.outputs.length; oi += 1) {
          const out = inst.def.outputs[oi];
          const ring = inst.rings[oi];
          ctx.strokeStyle = colorOf(a.uid, out);
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, cssW, chartBottom); // overlays never run into the sub strip
          ctx.clip();
          let started = false;
          for (let i = 0; i < cs.length; i += 1) {
            const v = ring[slotOf(cs[i].bi)];
            const col = candleCol(cs[i].t0Ns, tfNs, snap.timeMap);
            if (!Number.isFinite(v) || !Number.isFinite(col)) {
              started = false;
              continue;
            }
            const p = to(col, scalePriceToRow(scale, v));
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
              started = false;
              continue;
            }
            if (started) ctx.lineTo(p.x, p.y);
            else {
              ctx.moveTo(p.x, p.y);
              started = true;
            }
          }
          ctx.stroke();
          ctx.restore();
        }
      }

      // --- sub pane strip -----------------------------------------------------------
      if (subActive.length === 0) return;
      const laneH = stripH / subActive.length;
      ctx.fillStyle = 'rgba(8, 11, 17, 0.82)';
      ctx.fillRect(0, cssH - stripH, cssW, stripH);
      ctx.strokeStyle = 'rgba(35, 44, 62, 0.95)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, cssH - stripH + 0.5);
      ctx.lineTo(cssW, cssH - stripH + 0.5);
      ctx.stroke();

      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'top';

      for (let li = 0; li < subActive.length; li += 1) {
        const a = subActive[li];
        const inst = instances.get(a.uid);
        if (inst === undefined) continue;
        const laneTop = cssH - stripH + li * laneH;
        const laneBottom = laneTop + laneH;
        const y0 = laneTop + 3;
        const y1 = laneBottom - 5;

        // Lane scale: min/max across ALL outputs of this indicator.
        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        for (const ring of inst.rings) {
          for (let i = 0; i < cs.length; i += 1) {
            const v = ring[slotOf(cs[i].bi)];
            if (Number.isFinite(v)) {
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
          }
        }
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
        if (hi === lo) {
          hi += Math.abs(hi) * 1e-6 + 1e-9;
          lo -= Math.abs(lo) * 1e-6 + 1e-9;
        }
        const yOf = (v: number): number => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);

        // Lane separator + scale labels.
        ctx.strokeStyle = 'rgba(26, 32, 48, 0.55)';
        ctx.beginPath();
        if (li < subActive.length - 1) {
          ctx.moveTo(0, laneBottom - 0.5);
          ctx.lineTo(cssW, laneBottom - 0.5);
        }
        ctx.stroke();
        ctx.fillStyle = 'rgba(111, 123, 140, 0.9)';
        ctx.textAlign = 'left';
        ctx.fillText(fmtVal(hi), 4, y0);
        ctx.fillText(fmtVal(lo), 4, y1 - 10);

        const xOf = (i: number): number => {
          const col = candleCol(cs[i].t0Ns, tfNs, snap.timeMap);
          return Number.isFinite(col) ? to(col, 0).x : Number.NaN;
        };

        // Zero line when the lane spans it (MACD-style lanes).
        if (lo < 0 && hi > 0) {
          const zy = yOf(0);
          ctx.strokeStyle = 'rgba(111, 123, 140, 0.35)';
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(0, zy);
          ctx.lineTo(cssW, zy);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Histogram outputs first (behind the lines), then lines.
        for (let oi = 0; oi < inst.def.outputs.length; oi += 1) {
          const out = inst.def.outputs[oi];
          if (!out.histogram) continue;
          const ring = inst.rings[oi];
          ctx.fillStyle = colorOf(a.uid, out);
          const zy = yOf(0);
          const halfW = Math.max(1, Math.min(4, cssW / Math.max(8, cs.length) / 2));
          for (let i = 0; i < cs.length; i += 1) {
            const v = ring[slotOf(cs[i].bi)];
            if (!Number.isFinite(v)) continue;
            const x = xOf(i);
            if (!Number.isFinite(x)) continue;
            const y = yOf(v);
            ctx.fillRect(x - halfW, Math.min(y, zy), halfW * 2, Math.max(1, Math.abs(y - zy)));
          }
        }
        for (let oi = 0; oi < inst.def.outputs.length; oi += 1) {
          const out = inst.def.outputs[oi];
          if (out.histogram) continue;
          const ring = inst.rings[oi];
          ctx.strokeStyle = colorOf(a.uid, out);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < cs.length; i += 1) {
            const v = ring[slotOf(cs[i].bi)];
            if (!Number.isFinite(v)) {
              started = false;
              continue;
            }
            const x = xOf(i);
            if (!Number.isFinite(x)) {
              started = false;
              continue;
            }
            const y = yOf(v);
            if (started) ctx.lineTo(x, y);
            else {
              ctx.moveTo(x, y);
              started = true;
            }
          }
          ctx.stroke();
        }

        // Lane title (left, after the scale labels) + latest values (right).
        ctx.fillStyle = 'rgba(230, 237, 243, 0.95)';
        ctx.textAlign = 'left';
        ctx.fillText(inst.def.outputs.map((o) => o.label).join('·'), 40, y0);
        let labelX = cssW - 6;
        ctx.textAlign = 'right';
        for (let oi = inst.def.outputs.length - 1; oi >= 0; oi -= 1) {
          const out = inst.def.outputs[oi];
          const ring = inst.rings[oi];
          let last = Number.NaN;
          for (let i = cs.length - 1; i >= 0; i -= 1) {
            const v = ring[slotOf(cs[i].bi)];
            if (Number.isFinite(v)) {
              last = v;
              break;
            }
          }
          if (!Number.isFinite(last)) continue;
          const text = fmtVal(last);
          ctx.fillStyle = colorOf(a.uid, out);
          ctx.fillText(text, labelX, y0);
          labelX -= ctx.measureText(text).width + 10;
        }
      }
    };

    // --- the signature-gated loop (CvdPane pattern) -------------------------------

    const draw = (): void => {
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const store = useIndicatorStore.getState();
      const activeSig = store.active
        .map((a) => `${a.uid}:${a.defId}:${JSON.stringify(a.params)}:${JSON.stringify(a.colors)}`)
        .join(',');
      if (activeSig !== lastActiveSig) {
        lastActiveSig = activeSig;
        syncInstances(store.active);
      }
      const snap = getSnapshot();
      if (snap.version !== snapVersion) {
        const prev = cachedSnap;
        cachedSnap = snap;
        if (prev !== null && needsRebuild(prev, snap)) rebuildAll(snap);
        else feedNew(snap);
        snapVersion = snap.version;
        peekForming(snap);
      }
      const fm = useFlowMapStore.getState();
      const ep = fm.gridEpoch === null ? undefined : fm.epochs.get(fm.gridEpoch);
      // Camera probe: two mapped corners catch pan, zoom, and scale changes.
      const to = mapRef.current?.toChart ?? IDENTITY_TO;
      const c0 = to(0, 0);
      const c1 = to(1000, 1000);
      const sig = `${cssW}x${cssH}|${dpr}|${stripRef.current}|${activeSig}|${snap.version}|${
        snap.timeMap === null
          ? 'tm0'
          : `${snap.timeMap.anchorSeq}:${snap.timeMap.anchorT0Ns}:${snap.timeMap.dtNs}`
      }|${fm.gridEpoch}|${ep ? `${ep.p0}:${ep.rows}:${ep.dt_ns}:${ep.scale_kind ?? 0}` : 'ep0'}|${c0.x},${c0.y},${c1.x},${c1.y}`;
      let painted = false;
      // NOTE the gate is the SIGNATURE, not `active.length > 0` (S3 C-1): when
      // the last indicator is removed the signature must still change (empty
      // activeSig), and paint()'s first op is a full clearRect — skipping the
      // empty case left the last EMA/RSI line inked on the canvas forever.
      if (cssW !== 0 && cssH !== 0 && sig !== lastSig) {
        lastSig = sig;
        paint();
        painted = true;
      }
      scheduleNext(painted);
    };

    scheduleNext(true);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(pollTimer);
      instances.clear();
      unsubCandles();
    };
  }, []);

  return (
    <div className="indi-host" data-testid="indi-overlay" aria-hidden={!hasActive}>
      <canvas ref={canvasRef} className="indi-canvas" aria-hidden="true" />
    </div>
  );
}
