/**
 * PNG snapshot export (§9 top bar) — BOOKMAP-CLASS COMPOSITION.
 *
 * QA13 H1+H2 (swarm2, 2026-09-14): the old export was the raw GL bitmap only —
 * no price line, no axes, no last-price pill, no legend, no honesty badges, so
 * a shared artifact carried neither a price/time reference nor its fidelity
 * caveats. This module now composes the PNG from ALL the exportable layers:
 *
 *   GL heat canvas  +  over-heatmap 2D ink (price line / gridlines / badges)
 *   + price gutter  +  time gutter  +  price-family legend chip
 *   + density ramp chip  +  provenance footer (symbol · venue · mode · stamp,
 *     and the honest caveats when the state is reconstructed / scrolled back).
 *
 * Determinism: the composition reads only the layer bitmaps and the chrome the
 * caller hands in; every colour that is not theme-read comes from the shared
 * overlay palette (`OVERLAY`) or fixed chart-island tokens, and the timestamp is
 * the SAME `now` the filename is built from. No live UI chrome is scraped into
 * the pixels (the DOM is only used to LOCATE the layer canvases and read the
 * active chart theme's chrome colours).
 *
 * DPR: every source canvas is addressed at its own backing-store resolution and
 * pasted 1:1, so a DPR2 session exports a 2× bitmap (2236×1391 for 1118×672+DPS
 * layers) with scaled chips/footer — no resampling anywhere.
 *
 * The pure filename/anchor plumbing and the honest null path (a lost GL context
 * NEVER produces a download; the caller shows a notice instead) are unchanged.
 */

import { OVERLAY } from '../gl/overlays/palette';
import {
  RAMP_THEME,
  RAMP_THEME_SYNTH,
  rampCssGradient,
  rampForColormap,
  type Colormap,
} from '../gl/lut';

const FONT_STACK = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Local-time `YYYYMMDD-HHMMSS` stamp for export filenames. */
export function pngStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Local-time `YYYY-MM-DD HH:MM:SS` stamp for the provenance footer. */
export function pngDisplayStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** `flowmap-<market>-<symbol>-<YYYYMMDD-HHMMSS>.png` (local time). */
export function pngFilename(market: string, symbol: string, now: Date): string {
  // Defensive: market/symbol come from the server's symbol list today, but the
  // download attribute must never carry a path separator for any caller.
  const safe = (part: string) => part.replace(/[^\w.-]+/g, '_');
  return `flowmap-${safe(market)}-${safe(symbol)}-${pngStamp(now)}.png`;
}

/** Minimal surface of HTMLAnchorElement the download needs (test-injectable). */
export interface DownloadAnchor {
  href: string;
  download: string;
  click(): void;
}

/** Element factory the download builds its transient anchor through. */
export type AnchorFactory = (tag: string) => DownloadAnchor | null;

/**
 * Trigger a browser download of `dataUrl` as `filename` via a transient anchor.
 * The anchor is created through `makeElement` (default `document.createElement`)
 * so tests can observe it; it is never appended to the DOM — a synthetic click
 * on a detached anchor starts the download in every engine we ship on
 * (Chromium/Tauri + WebKit).
 */
export function downloadPng(
  dataUrl: string,
  filename: string,
  makeElement: AnchorFactory = (tag) => document.createElement(tag) as HTMLAnchorElement,
): DownloadAnchor | null {
  const a = makeElement('a');
  if (!a) return null;
  a.href = dataUrl;
  a.download = filename;
  a.click();
  return a;
}

// ---------------------------------------------------------------------------
// Layer composition (QA13 H1+H2)
// ---------------------------------------------------------------------------

/** Chart-island chrome the composition paints from (theme-aware when read live). */
export interface ExportChrome {
  /** Chip plate fill (legend chips + footer). */
  plateBg: string;
  /** Chip/footer hairline. */
  plateBorder: string;
  /** Secondary chip ink (labels). */
  ink: string;
  /** Primary chip ink (tier/title). */
  inkBright: string;
  /** Axis gutter ground (the CSS background the gutter canvases sit on). */
  gutterBg: string;
  /** Ground under the GL bitmap (guards against a non-opaque first row). */
  chartBg: string;
  /** Caution ink for honesty notes. */
  warn: string;
}

/** Midnight defaults — the literals `ui/theme.css` ships (dark-island rule). */
export const DEFAULT_EXPORT_CHROME: ExportChrome = {
  plateBg: 'rgba(8, 11, 17, 0.92)',
  plateBorder: '#1a2030',
  ink: '#93a1b4',
  inkBright: '#e6edf3',
  gutterBg: '#0e121a',
  chartBg: '#05080e',
  warn: '#d6a13a',
};

/** The on-screen layers one export composes (all optional but `gl`). */
export interface ExportLayers {
  /** Heatmap GL canvas — callers MUST force a fresh frame before gathering. */
  gl: HTMLCanvasElement;
  /** The over-heatmap 2D ink layer (price line / gridlines / badges). */
  ink?: HTMLCanvasElement | null;
  /** Right-hand price gutter (labels + last-price pill). */
  priceAxis?: HTMLCanvasElement | null;
  /** Bottom time gutter. */
  timeAxis?: HTMLCanvasElement | null;
  /** Device-pixel ratio of the sources; default derived from `gl`. */
  dpr?: number;
  /** Chart chrome colours; default {@link DEFAULT_EXPORT_CHROME}. */
  chrome?: Partial<ExportChrome> | null;
}

/** Provenance inputs for {@link exportProvenanceNotes} (all live-state reads). */
export interface ExportProvenanceInput {
  /** Renderer time-follow flag: `false` = the view is scrolled back. */
  following?: boolean | null;
  /** Subscription mode (`'live'` | `'replay'`). */
  mode?: string | null;
  /** Server capability map (history / depth / tape fidelity tiers). */
  capability?: Record<string, unknown> | null;
}

/**
 * The honest caveats the artifact must travel with (QA13 H2): text the screen
 * shows via badges/chips that the raw bitmap silently dropped. Pure.
 */
export function exportProvenanceNotes(input: ExportProvenanceInput): string[] {
  const notes: string[] = [];
  if (input.mode === 'replay') notes.push('replay');
  if (input.following === false) notes.push('scrolled back');
  const cap = input.capability;
  if (cap) {
    if (cap.history === 'reconstructed') notes.push('history ≈ reconstructed');
    if (typeof cap.depth === 'string' && cap.depth.startsWith('SYNTH')) notes.push('synthetic depth');
    if (typeof cap.tape === 'string' && cap.tape !== 'tick') notes.push(`tape ${cap.tape}`);
  }
  return notes;
}

/** Legend descriptor for the density ramp chip (colormap + honesty tier). */
export interface ExportLegend {
  colormap: Colormap;
  /** Synthetic depth is painted from the theme's synth row (amber identity). */
  synth?: boolean;
  /** Tier tag under the ramp (`L2`, `SYNTH`, …). */
  tier?: string;
}

/** Options for {@link composeExportLayers}. */
export interface ExportComposeOptions {
  /** Provenance footer descriptor; omit for a bare chart (tests). */
  meta?: { market: string; symbol: string; mode: string; at: Date } | null;
  /** Honesty caveats, appended to the footer (see {@link exportProvenanceNotes}). */
  notes?: readonly string[];
  /** Density ramp chip; omit to skip it. */
  legend?: ExportLegend | null;
  /** Test seam: canvas factory (default `document.createElement('canvas')`). */
  createCanvas?: () => HTMLCanvasElement;
}

/** Minimal renderer surface the export needs (avoids importing gl/renderer). */
export interface ExportSnapshotter {
  snapshot(): string | null;
}

/**
 * Gather the live export layers. Calls `renderer.snapshot()` first: this FORCES
 * one synchronous heatmap+overlay frame (so every layer bitmap is the same
 * instant) and returns null on a lost GL context — the honest no-download path.
 * Pure DOM lookups afterwards; the chrome colours come from the live chart chips
 * so paper/swiss exports stay legible too.
 */
export function collectExportLayers(
  renderer: ExportSnapshotter | null | undefined,
  doc: Document | null | undefined = typeof document === 'undefined' ? null : document,
): ExportLayers | null {
  if (!renderer || !doc) return null;
  if (renderer.snapshot() === null) return null;
  const gl =
    (doc.getElementById('gl') as HTMLCanvasElement | null) ??
    doc.querySelector<HTMLCanvasElement>('canvas.gl-canvas');
  if (!gl) return null;
  return {
    gl,
    ink: doc.querySelector<HTMLCanvasElement>('canvas.overlay-text'),
    priceAxis: doc.querySelector<HTMLCanvasElement>('.price-axis canvas'),
    timeAxis: doc.querySelector<HTMLCanvasElement>('.time-axis canvas'),
    dpr: gl.clientWidth > 0 ? gl.width / Math.max(1, gl.clientWidth) : undefined,
    chrome: readExportChrome(doc),
  };
}

/** Read the chart-island chrome from the live legend chips (theme-aware). */
function readExportChrome(doc: Document): Partial<ExportChrome> {
  const style = (el: Element | null): CSSStyleDeclaration | null => {
    const view = doc.defaultView;
    if (!el || !view || typeof view.getComputedStyle !== 'function') return null;
    return view.getComputedStyle(el);
  };
  const pick = (v: string | null | undefined, fallback: string): string =>
    v && v !== 'transparent' && v !== 'rgba(0, 0, 0, 0)' ? v : fallback;

  const legend = style(doc.querySelector('.chart-legend'));
  const legendLabel = style(doc.querySelector('.chart-legend__label'));
  const heatInk = style(doc.querySelector('.heat-legend__channel')) ?? style(doc.querySelector('.heat-legend__tier'));
  const priceGutter = style(doc.querySelector('.price-axis'));
  const glCanvas = style(doc.querySelector('canvas.gl-canvas') ?? doc.getElementById('gl'));

  return {
    plateBg: pick(legend?.backgroundColor, DEFAULT_EXPORT_CHROME.plateBg),
    plateBorder: pick(legend?.borderTopColor, DEFAULT_EXPORT_CHROME.plateBorder),
    ink: pick(legendLabel?.color, DEFAULT_EXPORT_CHROME.ink),
    inkBright: pick(heatInk?.color, DEFAULT_EXPORT_CHROME.inkBright),
    gutterBg: pick(priceGutter?.backgroundColor, DEFAULT_EXPORT_CHROME.gutterBg),
    chartBg: pick(glCanvas?.backgroundColor, DEFAULT_EXPORT_CHROME.chartBg),
  };
}

/** One parsed colour stop of a LUT row's CSS gradient (0..1 position). */
export interface ExportRampStop {
  css: string;
  t: number;
}

/**
 * Parse the same CSS gradient the on-screen heat legend paints from
 * (`rampCssGradient` of the lut) into canvas-ready stops. The legend and the
 * texture share one stop list, so the chip cannot drift from the heatmap ramp.
 */
export function exportRampStops(row: number): ExportRampStop[] {
  const css = rampCssGradient(row);
  const stops: ExportRampStop[] = [];
  const re = /rgb\((\d+),\s*(\d+),\s*(\d+)\)\s*([\d.]+)%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    stops.push({ css: `rgb(${m[1]}, ${m[2]}, ${m[3]})`, t: Number(m[4]) / 100 });
  }
  return stops;
}

/** Legend rows to paint for a colormap (theme rows resolve via the lut store). */
function exportLegendRow(legend: ExportLegend): number {
  if (legend.synth) return RAMP_THEME_SYNTH;
  if (legend.colormap === 'theme') return RAMP_THEME;
  return rampForColormap(legend.colormap);
}

/** Price-family legend entries — the same four the on-screen ChartLegend keys. */
function priceLegendItems(): Array<{ label: string; kind: 'line' | 'pair' | 'dots'; colors: string[] }> {
  return [
    { label: 'Last price', kind: 'line', colors: [OVERLAY.price.css] },
    { label: 'VWAP', kind: 'line', colors: [OVERLAY.vwap.css] },
    { label: 'BBO', kind: 'pair', colors: [OVERLAY.bid.css, OVERLAY.ask.css] },
    { label: 'Trades', kind: 'dots', colors: [OVERLAY.buy.css, OVERLAY.sell.css] },
  ];
}

/**
 * Compose the export bitmap from the live layers (QA13 H1+H2). Returns null when
 * there is nothing to compose (no GL layer / no 2D context) — the caller's
 * honest-failure path. The output is opaque, DPR-native, and camera-independent
 * (no UI chrome beyond the fixed chips + provenance footer).
 */
export function composeExportLayers(
  layers: ExportLayers | null | undefined,
  opts: ExportComposeOptions = {},
): HTMLCanvasElement | null {
  const gl = layers?.gl;
  if (!gl || gl.width <= 0 || gl.height <= 0) return null;
  const makeCanvas = opts.createCanvas ?? (() => document.createElement('canvas'));
  const canvas = makeCanvas();
  if (!canvas) return null;
  const chrome: ExportChrome = { ...DEFAULT_EXPORT_CHROME, ...(layers?.chrome ?? {}) };
  const dpr =
    layers?.dpr && layers.dpr > 0
      ? layers.dpr
      : gl.clientWidth > 0
        ? gl.width / Math.max(1, gl.clientWidth)
        : 1;

  const glW = gl.width;
  const glH = gl.height;
  const pW = layers?.priceAxis?.width ?? 0;
  const tH = layers?.timeAxis?.height ?? 0;
  const footerH = opts.meta || (opts.notes && opts.notes.length > 0) ? Math.round(20 * dpr) : 0;
  const W = glW + pW;
  const H = glH + tH + footerH;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const px = (n: number) => Math.round(n * dpr);

  // 1) Grounds: gutter chrome everywhere, then the chart ground under the GL.
  ctx.fillStyle = chrome.gutterBg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = chrome.chartBg;
  ctx.fillRect(0, 0, glW, glH);

  // 2) Layers at their own device resolution (no resampling, DPR-native).
  ctx.drawImage(gl, 0, 0);
  const ink = layers?.ink;
  if (ink && ink.width > 0 && ink.height > 0) ctx.drawImage(ink, 0, 0);
  const priceAxis = layers?.priceAxis;
  if (priceAxis && pW > 0) ctx.drawImage(priceAxis, glW, 0);
  const timeAxis = layers?.timeAxis;
  if (timeAxis && tH > 0) ctx.drawImage(timeAxis, 0, glH);

  // 3) Hairlines where the gutters meet the chart (the CSS borders are not on
  //    the canvases; without them a light theme's gutters look detached).
  ctx.strokeStyle = chrome.plateBorder;
  ctx.lineWidth = 1;
  if (pW > 0) {
    ctx.beginPath();
    ctx.moveTo(glW + 0.5, 0);
    ctx.lineTo(glW + 0.5, glH + tH);
    ctx.stroke();
  }
  if (tH > 0) {
    ctx.beginPath();
    ctx.moveTo(0, glH + 0.5);
    ctx.lineTo(W, glH + 0.5);
    ctx.stroke();
  }

  // 4) Price-family legend chip (top-left, mirrors the on-screen ChartLegend).
  drawPriceLegendChip(ctx, px(6), px(6), dpr, chrome);

  // 5) Density ramp chip (top-right, mirrors the on-screen HeatLegend).
  if (opts.legend) {
    const stops = exportRampStops(exportLegendRow(opts.legend));
    if (stops.length > 1) drawRampChip(ctx, W, px(6), dpr, chrome, stops, opts.legend.tier);
  }

  // 6) Provenance footer: identity always, honesty caveats when the state has
  //    any (QA13 H2 — the caveats MUST travel with the artifact).
  if (footerH > 0) {
    const y0 = glH + tH;
    ctx.fillStyle = chrome.plateBg;
    ctx.fillRect(0, y0, W, footerH);
    ctx.strokeStyle = chrome.plateBorder;
    ctx.beginPath();
    ctx.moveTo(0, y0 + 0.5);
    ctx.lineTo(W, y0 + 0.5);
    ctx.stroke();
    const cy = y0 + footerH / 2;
    ctx.font = `400 ${px(10)}px ${FONT_STACK}`;
    ctx.textBaseline = 'middle';
    if (opts.meta) {
      const left = `flowmap · ${opts.meta.market}:${opts.meta.symbol} · ${opts.meta.mode} · ${pngDisplayStamp(opts.meta.at)}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = chrome.ink;
      ctx.fillText(left, px(8), cy);
    }
    const notes = (opts.notes ?? []).filter((n) => n.length > 0);
    if (notes.length > 0) {
      ctx.textAlign = 'right';
      ctx.fillStyle = chrome.warn;
      ctx.fillText(notes.join(' · '), W - px(8), cy);
    }
  }

  return canvas;
}

/** Plate + border of a chart chip (square terminal corners, like the DOM chips). */
function chipPlate(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, chrome: ExportChrome): void {
  ctx.fillStyle = chrome.plateBg;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = chrome.plateBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/** The price-family legend chip (same four entries as the DOM ChartLegend). */
function drawPriceLegendChip(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  dpr: number,
  chrome: ExportChrome,
): void {
  const px = (n: number) => Math.round(n * dpr);
  const pad = px(6);
  const gap = px(10);
  const swatchW = px(14);
  const labelGap = px(4);
  const size = px(10);
  ctx.font = `400 ${size}px ${FONT_STACK}`;
  const items = priceLegendItems();
  const widths = items.map((it) => swatchW + labelGap + ctx.measureText(it.label).width);
  const totalW = pad * 2 + widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1);
  const h = px(18);
  chipPlate(ctx, x0, y0, totalW, h, chrome);
  let x = x0 + pad;
  const cy = y0 + h / 2;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'line') {
      ctx.fillStyle = it.colors[0];
      ctx.fillRect(x, cy - px(1), swatchW, px(2));
    } else if (it.kind === 'pair') {
      ctx.fillStyle = it.colors[0];
      ctx.fillRect(x, cy - px(4), swatchW, px(2));
      ctx.fillStyle = it.colors[1];
      ctx.fillRect(x, cy + px(2), swatchW, px(2));
    } else {
      ctx.fillStyle = it.colors[0];
      ctx.beginPath();
      ctx.arc(x + px(3), cy, px(3), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = it.colors[1];
      ctx.beginPath();
      ctx.arc(x + px(10), cy, px(3), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = chrome.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(it.label, x + swatchW + labelGap, cy);
    x += widths[i] + gap;
  }
}

/** The vertical density ramp chip (more at top, less at bottom — like HeatLegend). */
function drawRampChip(
  ctx: CanvasRenderingContext2D,
  rightX: number,
  y0: number,
  dpr: number,
  chrome: ExportChrome,
  stops: ExportRampStop[],
  tier: string | undefined,
): void {
  const px = (n: number) => Math.round(n * dpr);
  const pad = px(5);
  const barW = px(8);
  const barH = px(56);
  const size = px(9);
  ctx.font = `400 ${size}px ${FONT_STACK}`;
  const tierText = tier && tier.length > 0 ? tier : '';
  const textW = Math.max(
    ctx.measureText('more').width,
    ctx.measureText('less').width,
    tierText ? ctx.measureText(tierText).width : 0,
  );
  const chipW = pad * 2 + Math.max(barW, textW);
  const moreH = px(11);
  const chipH = pad * 2 + moreH + barH + moreH + (tierText ? px(13) : 0);
  const x0 = rightX - px(6) - chipW;
  chipPlate(ctx, x0, y0, chipW, chipH, chrome);
  const cx = x0 + chipW / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = chrome.ink;
  ctx.fillText('more', cx, y0 + pad + moreH / 2);
  const barTop = y0 + pad + moreH;
  const grad = ctx.createLinearGradient(0, barTop + barH, 0, barTop);
  for (const s of stops) grad.addColorStop(Math.max(0, Math.min(1, s.t)), s.css);
  ctx.fillStyle = grad;
  ctx.fillRect(cx - barW / 2, barTop, barW, barH);
  ctx.fillText('less', cx, barTop + barH + moreH / 2);
  if (tierText) {
    ctx.fillStyle = chrome.inkBright;
    ctx.fillText(tierText, cx, barTop + barH + moreH + px(6));
  }
}

/** Options for {@link runPngExport}. */
export interface RunPngExportOptions {
  /** Honesty caveats for the footer (see {@link exportProvenanceNotes}). */
  notes?: readonly string[];
  /** Density ramp chip; omit to skip it. */
  legend?: ExportLegend | null;
  /** Subscription mode, named in the footer. */
  mode?: string;
  /** Test seam: canvas factory for the composition. */
  createCanvas?: () => HTMLCanvasElement;
}

/**
 * One export attempt. `source` is either the raw GL data URL (legacy/fallback)
 * or the gathered {@link ExportLayers} (the shipped path — composed export).
 * Returns the filename on success (a download was started) or null when there
 * was nothing to draw (lost GL context / empty layers) — the caller owes the
 * user a visible "unavailable" notice, never a fake success.
 */
export function runPngExport(
  source: string | ExportLayers | null,
  market: string,
  symbol: string,
  now: Date,
  makeElement: AnchorFactory = (tag) => document.createElement(tag) as HTMLAnchorElement,
  opts: RunPngExportOptions = {},
): string | null {
  if (!source) return null;
  let dataUrl: string | null;
  if (typeof source === 'string') {
    dataUrl = source;
  } else {
    const composed = composeExportLayers(source, {
      meta: { market, symbol, mode: opts.mode ?? 'live', at: now },
      notes: opts.notes,
      legend: opts.legend,
      createCanvas: opts.createCanvas,
    });
    dataUrl = composed ? composed.toDataURL('image/png') : null;
  }
  if (!dataUrl) return null;
  const filename = pngFilename(market, symbol, now);
  downloadPng(dataUrl, filename, makeElement);
  return filename;
}
