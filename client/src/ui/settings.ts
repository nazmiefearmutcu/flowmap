/**
 * Persisted workspace settings (§9 settings drawer, T12) — pure load/save over a
 * Storage-shaped backend, so persistence + defaults + corruption tolerance are
 * unit-tested without a real browser.
 *
 * Everything the drawer controls lives here and is written to localStorage on
 * every change, and re-read + applied on boot. Fields the renderer can honour live
 * (bubble threshold, overlays, follow, rail) are applied by App; the display knobs
 * (colormap / normalization percentile / tick grouping) are persisted so the
 * choice survives reloads and is ready for the renderer to consume.
 */

import {
  DEFAULT_OVERLAY_VISIBILITY,
  type OverlayVisibility,
} from '../gl/overlays/frame';

export type Colormap = 'thermal' | 'alt';

export interface FlowMapSettings {
  /** Heatmap colormap family (thermal blue→white, or the alt single-hue ramp). */
  colormap: Colormap;
  /** Viewport-normalization percentile (§8.3; higher = dimmer, more headroom). */
  normPercentile: number;
  /** Price rows grouped into one heatmap cell (tick grouping). */
  tickGrouping: number;
  /** Minimum trade size drawn as a tape bubble overlay. */
  bubbleMinSize: number;
  /** Auto-follow the live right edge. */
  follow: boolean;
  /** Right rail (DOM ladder + tape) visibility. */
  railVisible: boolean;
  /** Which heatmap overlays are on. */
  overlays: OverlayVisibility;
}

export const SETTINGS_KEY = 'flowmap.settings.v1';

export const DEFAULT_SETTINGS: FlowMapSettings = {
  colormap: 'thermal',
  normPercentile: 99,
  tickGrouping: 1,
  bubbleMinSize: 0,
  follow: true,
  railVisible: true,
  overlays: { ...DEFAULT_OVERLAY_VISIBILITY },
};

/** Minimal structural subset of the Web Storage API these helpers need. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Coerce arbitrary parsed JSON into a valid, fully-populated settings object. */
export function normalizeSettings(raw: unknown): FlowMapSettings {
  const o = (raw ?? {}) as Partial<FlowMapSettings> & Record<string, unknown>;
  const overlaysIn = (o.overlays ?? {}) as Partial<OverlayVisibility>;
  const overlays: OverlayVisibility = { ...DEFAULT_OVERLAY_VISIBILITY };
  for (const k of Object.keys(overlays) as (keyof OverlayVisibility)[]) {
    if (typeof overlaysIn[k] === 'boolean') overlays[k] = overlaysIn[k] as boolean;
  }
  return {
    colormap: o.colormap === 'alt' ? 'alt' : 'thermal',
    normPercentile: clampNumber(o.normPercentile, 50, 100, DEFAULT_SETTINGS.normPercentile),
    tickGrouping: Math.round(clampNumber(o.tickGrouping, 1, 32, DEFAULT_SETTINGS.tickGrouping)),
    bubbleMinSize: clampNumber(o.bubbleMinSize, 0, 1e9, DEFAULT_SETTINGS.bubbleMinSize),
    follow: typeof o.follow === 'boolean' ? o.follow : DEFAULT_SETTINGS.follow,
    railVisible: typeof o.railVisible === 'boolean' ? o.railVisible : DEFAULT_SETTINGS.railVisible,
    overlays,
  };
}

/** Read + normalize settings; any parse error yields the defaults (never throws). */
export function loadSettings(storage: StorageLike | null | undefined): FlowMapSettings {
  if (!storage) return { ...DEFAULT_SETTINGS, overlays: { ...DEFAULT_OVERLAY_VISIBILITY } };
  try {
    const text = storage.getItem(SETTINGS_KEY);
    if (!text) return { ...DEFAULT_SETTINGS, overlays: { ...DEFAULT_OVERLAY_VISIBILITY } };
    return normalizeSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_SETTINGS, overlays: { ...DEFAULT_OVERLAY_VISIBILITY } };
  }
}

/** Persist settings; swallows quota / serialization errors (best-effort). */
export function saveSettings(
  settings: FlowMapSettings,
  storage: StorageLike | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage full / unavailable — settings simply won't persist this session */
  }
}
