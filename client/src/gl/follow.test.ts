import { describe, expect, it } from 'vitest';

import { KILL_BOTH, KILL_NONE, KILL_PRICE, KILL_TIME } from './camera';
import {
  approach,
  colsBehind,
  isColVisible,
  PAN_KILL_MIN_PX,
  PRICE_DEADBAND_FRACTION,
  PRICE_GLIDE_TAU_MS,
  panFollowKill,
  priceFollowTarget,
  trackedRow,
} from './follow';
import type { HeatmapView } from './heatmap';

const VIEW: HeatmapView = { colOffset: 900, colScale: 200, rowOffset: 196, rowScale: 120 };

describe('panFollowKill — which axes a drag claims', () => {
  it('releases nothing below the threshold on both axes (hand tremor)', () => {
    expect(panFollowKill(3, 4)).toEqual(KILL_NONE);
    expect(panFollowKill(PAN_KILL_MIN_PX - 0.01, PAN_KILL_MIN_PX - 0.01)).toEqual(KILL_NONE);
  });

  it('a deliberately horizontal drag keeps price tracking', () => {
    expect(panFollowKill(150, 2)).toEqual(KILL_TIME);
  });

  it('a deliberately vertical drag keeps time follow', () => {
    expect(panFollowKill(1, 80)).toEqual(KILL_PRICE);
  });

  it('a diagonal drag claims both', () => {
    expect(panFollowKill(40, 40)).toEqual(KILL_BOTH);
  });

  it('is peak-based, so a there-and-back drag cannot dodge the kill', () => {
    // The CALLER feeds peak |displacement|, not a signed net: a 100px-right,
    // 96px-left drag has peak 100 even though it nets to +4.
    expect(panFollowKill(100, 0)).toEqual(KILL_TIME);
    // Sign is irrelevant — magnitude is what a takeover means.
    expect(panFollowKill(-100, 0)).toEqual(KILL_TIME);
  });

  it('fires exactly AT the threshold', () => {
    expect(panFollowKill(PAN_KILL_MIN_PX, 0)).toEqual(KILL_TIME);
  });
});

describe('trackedRow — "where is the price" from one column', () => {
  it('uses the inside-quote midpoint for a two-sided uncrossed book', () => {
    // bid tops at 100, ask starts at 104 → mid of the half-open gap.
    expect(trackedRow(100, 104, 40, 160)).toBe(102.5);
  });

  it('falls back to the extent midpoint for a one-sided (SYNTH) book', () => {
    expect(trackedRow(100, -1, 40, 160)).toBe(100.5);
    expect(trackedRow(-1, 104, 40, 160)).toBe(100.5);
  });

  it('falls back to the extent midpoint on a crossed snapshot', () => {
    // askBot <= bidTop: mid-update crossed book — the extent is still sane.
    expect(trackedRow(120, 110, 40, 160)).toBe(100.5);
  });

  it('returns null for an empty column so the caller keeps the last row', () => {
    expect(trackedRow(-1, -1, -1, -1)).toBeNull();
  });
});

describe('priceFollowTarget — the deadband', () => {
  const CENTER = 256;
  const SPAN = 120;
  const halfBand = (SPAN * PRICE_DEADBAND_FRACTION) / 2; // 36

  it('does not move while price sits inside the middle 60%', () => {
    expect(priceFollowTarget(CENTER, SPAN, CENTER)).toBeNull();
    expect(priceFollowTarget(CENTER, SPAN, CENTER + halfBand - 0.01)).toBeNull();
    expect(priceFollowTarget(CENTER, SPAN, CENTER - halfBand + 0.01)).toBeNull();
  });

  it('targets the FULL tracked row once price escapes, not the band edge', () => {
    // Targeting the edge would re-trigger on the very next column (crawl).
    expect(priceFollowTarget(CENTER, SPAN, CENTER + halfBand + 5)).toBe(CENTER + halfBand + 5);
    expect(priceFollowTarget(CENTER, SPAN, 10)).toBe(10);
  });

  it('gives no target without a tracked row or a usable span', () => {
    expect(priceFollowTarget(CENTER, SPAN, null)).toBeNull();
    expect(priceFollowTarget(CENTER, SPAN, Number.NaN)).toBeNull();
    expect(priceFollowTarget(CENTER, 0, 999)).toBeNull();
  });
});

describe('approach — the glide', () => {
  it('moves a fixed FRACTION of the remaining distance per tau', () => {
    const out = approach(0, 100, PRICE_GLIDE_TAU_MS, PRICE_GLIDE_TAU_MS);
    expect(out).toBeCloseTo(100 * (1 - Math.exp(-1)), 9); // ≈63.2
  });

  it('is frame-rate independent: two half-steps == one whole step', () => {
    const dt = PRICE_GLIDE_TAU_MS;
    const oneStep = approach(0, 100, dt, PRICE_GLIDE_TAU_MS);
    const halfA = approach(0, 100, dt / 2, PRICE_GLIDE_TAU_MS);
    const halfB = approach(halfA, 100, dt / 2, PRICE_GLIDE_TAU_MS);
    expect(halfB).toBeCloseTo(oneStep, 9);
  });

  it('HOLDS on a zero-length frame instead of teleporting', () => {
    // A single combined guard would return `target` here and jump the wall.
    expect(approach(10, 500, 0, PRICE_GLIDE_TAU_MS)).toBe(10);
    expect(approach(10, 500, -5, PRICE_GLIDE_TAU_MS)).toBe(10);
  });

  it('jumps when easing is disabled (tau <= 0)', () => {
    expect(approach(10, 500, 16, 0)).toBe(500);
  });

  it('never overshoots', () => {
    expect(approach(0, 100, 10_000, PRICE_GLIDE_TAU_MS)).toBeLessThanOrEqual(100);
  });
});

describe('isColVisible / colsBehind', () => {
  it('treats the window as half-open [colOffset, colOffset+colScale)', () => {
    expect(isColVisible(VIEW, 900)).toBe(true);
    expect(isColVisible(VIEW, 1099.9)).toBe(true);
    expect(isColVisible(VIEW, 1100)).toBe(false);
    expect(isColVisible(VIEW, 899.9)).toBe(false);
  });

  it('reports 0 columns behind when pinned to (or past) the live edge', () => {
    expect(colsBehind(VIEW, 1099)).toBe(0);
    expect(colsBehind(VIEW, 500)).toBe(0);
  });

  it('reports the gap when scrolled back', () => {
    // right edge = 1100; newest 1600 → 1601 - 1100 = 501 columns behind.
    expect(colsBehind(VIEW, 1600)).toBe(501);
  });
});
