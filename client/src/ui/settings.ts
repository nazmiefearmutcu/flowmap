/**
 * Persisted workspace settings (§9 settings drawer, T12) — pure load/save over a
 * Storage-shaped backend, so persistence + defaults + corruption tolerance are
 * unit-tested without a real browser.
 *
 * Everything the drawer controls lives here and is written to localStorage on
 * every change, and re-read + applied on boot. Almost all of it is honoured LIVE
 * by the renderer (contrast, tolerance, colormap, normalization, bubble
 * threshold, overlays, both follow axes, rail); `priceBand` is applied by
 * re-subscribing (it changes the SERVER's grid geometry), and `tickGrouping` is
 * persisted-only for now.
 *
 * **Migration policy.** `normalizeSettings` is a total coercion over an
 * arbitrary parsed blob with a per-field default, so a stored payload that
 * predates any field adopts that field's default with no migration code and no
 * `SETTINGS_KEY` bump. The one deliberate exception is `colormap`: its legacy
 * values (`'thermal'` / `'alt'`) were persisted on every mount but NEVER applied
 * to the renderer, so a stored value carries no user intent — honouring it would
 * mean returning users silently never see the new default ramp. Both legacy
 * strings therefore fall through to {@link DEFAULT_COLORMAP} on purpose.
 */

import { DEFAULT_CONTRAST, DEFAULT_TOLERANCE } from '../gl/heatmap';
import { DEFAULT_COLORMAP, type Colormap } from '../gl/lut';
import {
  DEFAULT_OVERLAY_VISIBILITY,
  type OverlayVisibility,
} from '../gl/overlays/frame';

export type { Colormap };

/**
 * Server price-grid coverage around the reference price (§8.1). The grid is a
 * LINEAR affine over a fixed row count, so range and resolution are the same
 * knob — widening the band coarsens every row. See the drawer hint.
 *   - `native` — today's grid: finest rows, narrowest coverage.
 *   - `wide`   — ±50% around mid.
 *   - `full`   — −100% / +1000%. A range SCAN mode: at this width the live book
 *     collapses into a couple of rows on a major, so it answers "are there walls
 *     far out?", not "what is the ladder doing".
 */
export type PriceBand = 'native' | 'wide' | 'full';

export const PRICE_BANDS: readonly PriceBand[] = ['native', 'wide', 'full'] as const;

export interface FlowMapSettings {
  /** Heatmap display contrast 0–100 (drives the perceptual gamma, §8.3). */
  contrast: number;
  /** Heatmap black point 0–100 — how much density a cell needs to paint at all. */
  tolerance: number;
  /** Heatmap colormap family. */
  colormap: Colormap;
  /** Viewport-normalization percentile (§8.3; higher = dimmer, more headroom). */
  normPercentile: number;
  /** Price rows grouped into one heatmap cell (tick grouping). */
  tickGrouping: number;
  /** Minimum trade size drawn as a tape bubble overlay. */
  bubbleMinSize: number;
  /** Auto-follow the live right edge — the TIME axis. */
  follow: boolean;
  /** Auto-track price on the PRICE axis (keeps your zoom, recentres on drift). */
  followPrice: boolean;
  /** Server price-grid coverage. Changing it re-subscribes. */
  priceBand: PriceBand;
  /** Right rail (DOM ladder + tape) visibility. */
  railVisible: boolean;
  /** Which heatmap overlays are on. */
  overlays: OverlayVisibility;
}

export const SETTINGS_KEY = 'flowmap.settings.v1';

export const DEFAULT_SETTINGS: FlowMapSettings = {
  contrast: DEFAULT_CONTRAST,
  tolerance: DEFAULT_TOLERANCE,
  colormap: DEFAULT_COLORMAP,
  normPercentile: 99,
  tickGrouping: 1,
  bubbleMinSize: 0,
  follow: true,
  followPrice: true,
  priceBand: 'native',
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
    contrast: Math.round(clampNumber(o.contrast, 0, 100, DEFAULT_SETTINGS.contrast)),
    tolerance: Math.round(clampNumber(o.tolerance, 0, 100, DEFAULT_SETTINGS.tolerance)),
    // Only 'classic' is honoured; every other stored value (including the legacy
    // 'thermal' / 'alt' from the never-applied knob) adopts the default. See the
    // migration note in the module docblock.
    colormap: o.colormap === 'classic' ? 'classic' : DEFAULT_COLORMAP,
    normPercentile: clampNumber(o.normPercentile, 50, 100, DEFAULT_SETTINGS.normPercentile),
    tickGrouping: Math.round(clampNumber(o.tickGrouping, 1, 32, DEFAULT_SETTINGS.tickGrouping)),
    bubbleMinSize: clampNumber(o.bubbleMinSize, 0, 1e9, DEFAULT_SETTINGS.bubbleMinSize),
    follow: typeof o.follow === 'boolean' ? o.follow : DEFAULT_SETTINGS.follow,
    followPrice:
      typeof o.followPrice === 'boolean' ? o.followPrice : DEFAULT_SETTINGS.followPrice,
    priceBand: PRICE_BANDS.includes(o.priceBand as PriceBand)
      ? (o.priceBand as PriceBand)
      : DEFAULT_SETTINGS.priceBand,
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
