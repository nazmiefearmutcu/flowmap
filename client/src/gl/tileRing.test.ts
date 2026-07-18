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
  });
});
