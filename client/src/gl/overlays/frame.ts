/**
 * The per-frame draw context handed to every overlay (M2 T10).
 *
 * The renderer builds ONE of these each dirty frame — the camera snapshot
 * ({@link GridMap}), the two shared GL batches, the text layer, the resident
 * column clamp, and the capability descriptor (for §7 honesty gating) — then
 * calls each enabled overlay's `draw(frame)` in the spec draw order
 * (profile → vwap → bbo → bubbles → markers). Overlays never own GL state; they
 * emit clip-space geometry into the shared batches and flush in call order.
 */

import type { GridMap } from './coords';
import type { PointBatch, SolidBatch } from './primitives';
import type { TextLayer } from '../textLayer';

export interface OverlayFrame {
  /** Immutable camera + epoch transform for this frame. */
  gm: GridMap;
  /** Shared colored-triangle batch (lines/rects/glyphs). */
  solid: SolidBatch;
  /** Shared round-point batch (trade bubbles). */
  points: PointBatch;
  /** Shared 2D text layer over the heatmap (badges/labels). */
  text: TextLayer;
  /** Resident column clamp so every overlay stays O(visible). */
  resident: { oldest: number; newest: number } | null;
  /** Feed capability descriptor (drives badges / N/A states). */
  capability: Record<string, unknown> | null;
  /**
   * Exact per-column density arrays (from the CPU column cache) for the volume
   * profile — the EXACT resting-liquidity values, never GPU/mip texels. Null for
   * uncached columns (deep history not fetched).
   */
  columnArrays: (col: number) => { bid: Float32Array; ask: Float32Array | null } | null;
}

/** The overlays a user can toggle; default all on except the profile. */
export interface OverlayVisibility {
  bubbles: boolean;
  bbo: boolean;
  vwap: boolean;
  profile: boolean;
  markers: boolean;
  axes: boolean;
}

export const DEFAULT_OVERLAY_VISIBILITY: OverlayVisibility = {
  bubbles: true,
  bbo: true,
  vwap: true,
  profile: false,
  markers: true,
  axes: true,
};
