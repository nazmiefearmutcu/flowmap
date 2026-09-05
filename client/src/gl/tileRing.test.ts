import { describe, expect, it } from 'vitest';

import { Residency } from './tileRing';

/**
 * Pure full-res residency book-keeping (T8) — the addressing/eviction logic the
 * tile ring uses, exercised with NO WebGL context. A small ring
 * (colsPerTile=4, layers=2 → capacity 8) keeps the windows easy to reason about.
 */

const cap = 8;
function make(): Residency {
  return new Residency(cap, /* colsPerTile */ 4, /* layers */ 2);
}

describe('Residency window (T8 LRU)', () => {
  it('is empty before any column', () => {
    const r = make();
    expect(r.range()).toBeNull();
    expect(r.isResident(0)).toBe(false);
    expect(r.budgetCols).toBe(cap);
  });

  it('grows forward on live appends and reports the resident window', () => {
    const r = make();
    for (let s = 0; s < cap; s++) r.note(s);
    expect(r.range()).toEqual({ oldest: 0, newest: cap - 1, count: cap });
    expect(r.isResident(0)).toBe(true);
    expect(r.isResident(cap - 1)).toBe(true);
  });

  it('evicts the OLDEST when a forward append overruns the budget', () => {
    const r = make();
    for (let s = 0; s <= cap; s++) r.note(s); // one past a full ring
    // The wrap physically overwrote slot(0); the window slides forward by one.
    expect(r.range()).toEqual({ oldest: 1, newest: cap, count: cap });
    expect(r.isResident(0)).toBe(false);
    expect(r.isResident(cap)).toBe(true);
  });

  it('grows BACKWARD on scroll-back backfill (older col_seq splice)', () => {
    const r = make();
    // A partial live window [10, 12] (count 3).
    r.note(10);
    r.note(11);
    r.note(12);
    expect(r.range()).toEqual({ oldest: 10, newest: 12, count: 3 });
    // Backfill [7, 8, 9] ascending: with room in the budget, BOTH the fetched
    // and the live columns stay resident.
    r.note(7);
    r.note(8);
    r.note(9);
    expect(r.range()).toEqual({ oldest: 7, newest: 12, count: 6 });
    expect(r.isResident(7)).toBe(true);
    expect(r.isResident(12)).toBe(true);
  });

  it('evicts the NEWEST (live edge) when backfill overruns a full ring', () => {
    const r = make();
    // Full window [10, 17] (count 8 == capacity), live edge at 17.
    for (let s = 10; s <= 17; s++) r.note(s);
    expect(r.range()).toEqual({ oldest: 10, newest: 17, count: cap });
    // Backfill 6: backward growth overruns → the far (live) end 17 falls out.
    r.note(6);
    expect(r.range()).toEqual({ oldest: 6, newest: 13, count: cap });
    expect(r.isResident(17)).toBe(false); // live edge evicted (LRU — not viewed)
    expect(r.isResident(6)).toBe(true);
  });

  it('is a no-op for an in-place overwrite of a resident column', () => {
    const r = make();
    for (let s = 0; s < cap; s++) r.note(s);
    r.note(3); // re-write a resident column (e.g. a forming-edge re-send)
    expect(r.range()).toEqual({ oldest: 0, newest: cap - 1, count: cap });
  });

  it('never exceeds the budget width across a mixed forward/backward walk', () => {
    const r = make();
    for (let s = 0; s < 5; s++) r.note(s); // [0,4]
    for (let s = 5; s < 20; s++) r.note(s); // slides forward, stays width ≤ cap
    r.note(11); // backfill into the middle-ish
    r.note(10);
    const range = r.range()!;
    expect(range.count).toBeLessThanOrEqual(cap);
    expect(range.newest - range.oldest + 1).toBe(range.count);
  });

  it('tracks a per-tile-layer LRU order (least-recently-touched first)', () => {
    const r = make();
    // cols 0..3 -> layer 0, cols 4..7 -> layer 1.
    for (let s = 0; s < 4; s++) r.note(s); // layer 0 last touched
    r.note(4); // layer 1 touched most recently
    expect(r.lruLayerOrder()).toEqual([0, 1]);
    // Now touch layer 0 again (col 8 wraps into layer 0): it becomes MRU.
    r.note(8);
    expect(r.lruLayerOrder()).toEqual([1, 0]);
  });

  it('reset clears the window', () => {
    const r = make();
    r.note(5);
    r.reset();
    expect(r.range()).toBeNull();
    expect(r.validFromSeq()).toBe(-1);
  });
});

describe('Residency validFrom — the stale-slot gate across a gap', () => {
  /**
   * `range()` is a pure interval: after a forward GAP (col_seq > newest+1) it
   * claims columns whose ring slots still hold PREVIOUS data. `validFromSeq()`
   * is the first column the GPU may actually paint; the heatmap gates on it so
   * a go-live after a deep scroll-back cannot paint the stale band as live.
   */
  it('equals the window oldest while appends are contiguous', () => {
    const r = make();
    r.note(10);
    r.note(11);
    r.note(12);
    expect(r.validFromSeq()).toBe(10);
    expect(r.range()!.oldest).toBe(10);
  });

  it('jumps to the gap edge on a forward gap growth (go-live after scroll-back)', () => {
    const r = make();
    for (let s = 10; s <= 12; s++) r.note(s);
    r.note(20); // gap: 13..19 were never written (their slots hold old data)
    // The window still spans the gap (the budget clamp slid oldest forward), but
    // validity starts at the first column actually written after the gap.
    expect(r.range()).toEqual({ oldest: 13, newest: 20, count: 8 });
    expect(r.validFromSeq()).toBe(20);
  });

  it('stays at the gap edge while live appends fill forward', () => {
    const r = make();
    r.note(20);
    r.note(40); // gap jump
    r.note(41);
    r.note(42); // contiguous live appends
    expect(r.range()!.newest).toBe(42);
    expect(r.validFromSeq()).toBe(40);
  });

  it('extends down for a normal scroll-back page (window had no gap)', () => {
    const r = make();
    r.note(10);
    r.note(11);
    r.note(12);
    // A backfill page ascending [7,8,9]: the window grows backward and the
    // page's not-yet-written slots are zeroed texture, so claiming validity
    // down to 7 immediately is honest.
    r.note(7);
    expect(r.validFromSeq()).toBe(7);
    r.note(8);
    r.note(9);
    expect(r.validFromSeq()).toBe(7);
    expect(r.range()).toEqual({ oldest: 7, newest: 12, count: 6 });
  });

  it('never extends across an unfetched band after a gap (chain descends from oldest)', () => {
    const r = make();
    r.note(40); // pre-gap live edge
    r.note(60); // gap forward growth (go-live) → window [53, 60], validFrom 60
    expect(r.validFromSeq()).toBe(60);
    // Post-gap backfill descends from the window's oldest (53), far below the
    // gap edge: the band is unfetched and must not be claimed. The backward
    // budget clamp pulls newest down to 58, and validity bounds at newest —
    // at worst a ONE-column claim, never the whole stale band.
    r.note(51);
    expect(r.range()).toEqual({ oldest: 51, newest: 58, count: 8 });
    expect(r.validFromSeq()).toBe(58);
    r.note(52);
    expect(r.validFromSeq()).toBe(58);
  });

  it('never starts before the window oldest after a budget clamp', () => {
    const r = make();
    r.note(3);
    r.note(30); // gap → oldest clamps to 30-8+1 = 23, validFrom 30
    expect(r.validFromSeq()).toBe(30);
    // Live appends slide oldest forward; once the clamp evicts the gap edge,
    // validity clamps up to the window (it cannot precede it).
    for (let s = 31; s <= 37; s++) r.note(s);
    expect(r.range()!.oldest).toBe(30);
    expect(r.validFromSeq()).toBe(30);
    r.note(38); // oldest slides to 31, past the gap edge 30
    expect(r.range()!.oldest).toBe(31);
    expect(r.validFromSeq()).toBe(31);
  });

  it('never runs past the newest when a backward clamp evicts below the gap edge', () => {
    const r = make();
    r.note(20);
    r.note(40); // gap → window [33, 40], validFrom 40
    expect(r.validFromSeq()).toBe(40);
    // A stray backfill page lands below the window: backward growth clamps
    // newest down to oldest+cap-1 = 37, below the gap edge. The invariant
    // validFrom ≤ newest must hold (the clamp bounds it at newest).
    r.note(30);
    expect(r.range()!.newest).toBe(37);
    expect(r.validFromSeq()).toBe(37);
  });

  it('an in-place rewrite inside a gap band does not validate the band', () => {
    const r = make();
    r.note(20);
    r.note(40); // gap → window [33, 40], validFrom 40
    r.note(35); // one stray backfilled column inside the claimed band
    expect(r.validFromSeq()).toBe(40);
  });
});
