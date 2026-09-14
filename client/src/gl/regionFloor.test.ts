import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RECON_FLOOR_SCALE,
  reconFloorFor,
  RegionTracker,
  REGION_LIVE,
  REGION_RECON,
} from './regionFloor';

describe('reconFloorFor — the relative per-region floor (lane F17, D5 L1)', () => {
  it('scales the live floor by the recon multiplier and keeps slider 0 an exact no-op', () => {
    expect(reconFloorFor(0.0128, 0.25)).toBeCloseTo(0.0032, 12);
    expect(reconFloorFor(0, 0.25)).toBe(0);
    expect(reconFloorFor(0.0128, 1)).toBe(0.0128); // 1 = inert (exact live floor)
  });

  it('is RELATIVE: a lower/higher floor keeps the same ratio (not an absolute cut)', () => {
    expect(reconFloorFor(0.01, 0.25)).toBeCloseTo(0.0025, 12);
    expect(reconFloorFor(0.1, 0.25)).toBeCloseTo(0.025, 12);
  });

  it('clamps scale into (0,1] and degrades poisoned input to the live floor', () => {
    expect(reconFloorFor(0.02, 2)).toBe(0.02); // never hide MORE than live
    expect(reconFloorFor(0.02, -3)).toBe(0); // a negative cut is clamped to tol-0
    expect(reconFloorFor(0.02, Number.NaN)).toBe(0.02);
    expect(reconFloorFor(Number.NaN, 0.25)).toBe(0);
    expect(reconFloorFor(-1, 0.25)).toBe(0);
  });

  it('the shipped default sits strictly between inert (1) and tol-0 (0)', () => {
    expect(DEFAULT_RECON_FLOOR_SCALE).toBeGreaterThan(0);
    expect(DEFAULT_RECON_FLOOR_SCALE).toBeLessThan(1);
  });
});

describe('RegionTracker — per-column tags in ring-slot space', () => {
  it('defaults every column to live and ignores never-marked columns', () => {
    const t = new RegionTracker(8);
    expect(t.kindAt(0)).toBe(REGION_LIVE);
    expect(t.kindAt(7)).toBe(REGION_LIVE);
    expect(t.kindAt(-3)).toBe(REGION_LIVE);
    expect(t.hasRecon).toBe(false);
    expect(t.reconColumns).toBe(0);
    expect(t.revision).toBe(0);
  });

  it('marks, reads back and rounds-trips slots the way the ring addresses them', () => {
    const t = new RegionTracker(8);
    t.mark(3, REGION_RECON);
    t.mark(11, REGION_RECON); // slot 3 again (mod 8)
    expect(t.kindAt(3)).toBe(REGION_LIVE); // slot reused by a different column
    expect(t.kindAt(11)).toBe(REGION_RECON);
    expect(t.kindAt(-5)).toBe(REGION_LIVE); // (-5 mod 8) = 3 — stamped for 11
    expect(t.reconColumns).toBe(1);
    expect(t.revision).toBe(2);
  });

  it('is idempotent (no revision churn) and counts recon columns exactly', () => {
    const t = new RegionTracker(16);
    expect(t.mark(4, REGION_RECON)).toBe(true);
    expect(t.mark(4, REGION_RECON)).toBe(false);
    expect(t.revision).toBe(1);
    expect(t.reconColumns).toBe(1);
    expect(t.mark(4, REGION_LIVE)).toBe(true);
    expect(t.reconColumns).toBe(0);
    expect(t.hasRecon).toBe(false);
  });

  it('markRange covers inclusive spans and refuses runaway/NaN spans', () => {
    const t = new RegionTracker(16);
    const changed = t.markRange(5, 9, REGION_RECON);
    expect(changed).toBe(5);
    expect(t.kindAt(4)).toBe(REGION_LIVE);
    expect(t.kindAt(5)).toBe(REGION_RECON);
    expect(t.kindAt(9)).toBe(REGION_RECON);
    expect(t.reconColumns).toBe(5);
    // Reversed ends are normalized.
    t.markRange(9, 5, REGION_LIVE);
    expect(t.reconColumns).toBe(0);
    // A span longer than 2× capacity is a caller bug and changes nothing.
    const before = t.revision;
    expect(t.markRange(0, 100000, REGION_RECON)).toBe(0);
    expect(t.revision).toBe(before);
    expect(t.markRange(Number.NaN, 3, REGION_RECON)).toBe(0);
  });

  it('clear() drops stamps + tags so a later reused slot starts live', () => {
    const t = new RegionTracker(8);
    t.mark(2, REGION_RECON);
    t.clear();
    expect(t.kindAt(2)).toBe(REGION_LIVE);
    expect(t.reconColumns).toBe(0);
    expect(t.hasRecon).toBe(false);
    expect(t.mark(2, REGION_RECON)).toBe(true); // wasn't stamped anymore
    expect(t.reconColumns).toBe(1);
  });

  it('exposes the slot-indexed tag array the heatmap uploads verbatim', () => {
    const t = new RegionTracker(4);
    t.mark(1, REGION_RECON);
    t.mark(3, REGION_RECON);
    expect(Array.from(t.tags)).toEqual([0, 1, 0, 1]);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new RegionTracker(0)).toThrow();
    expect(() => new RegionTracker(Number.NaN)).toThrow();
  });
});
