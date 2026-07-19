import { describe, expect, it } from 'vitest';

import { fmtSize, fmtTime } from './Crosshair';

describe('fmtSize', () => {
  it('renders "—" for null', () => {
    expect(fmtSize(null)).toBe('—');
  });

  // §7 honesty: a non-finite (f16-overflowed / over-range) bucket must never read
  // as a fabricated number — it shows the honest glyph, not "Infinity"/"NaN".
  it('shows the ∞ glyph for +Infinity, never "Infinity"', () => {
    expect(fmtSize(Infinity)).toBe('∞');
  });

  it('shows "—" for NaN, never "NaN"', () => {
    expect(fmtSize(NaN)).toBe('—');
  });

  it('shows "—" for -Infinity', () => {
    expect(fmtSize(-Infinity)).toBe('—');
  });

  it('keeps the small-size decimal bands', () => {
    expect(fmtSize(0)).toBe('0');
    expect(fmtSize(1.234)).toBe('1.23');
    expect(fmtSize(12.5)).toBe('12.50');
    expect(fmtSize(150.4)).toBe('150.4');
  });

  it('groups thousands in the 1e3..1e4 band', () => {
    expect(fmtSize(1000)).toBe('1,000');
    expect(fmtSize(9999)).toBe('9,999');
  });

  it('compacts to K past 10k and M past 1e6', () => {
    expect(fmtSize(10_000)).toBe('10.0K');
    expect(fmtSize(12_500)).toBe('12.5K');
    expect(fmtSize(250_000)).toBe('250K');
    expect(fmtSize(1_500_000)).toBe('1.5M');
    expect(fmtSize(12_000_000)).toBe('12M');
  });
});

describe('fmtTime', () => {
  it('renders "—" for null', () => {
    expect(fmtTime(null)).toBe('—');
  });

  it('renders HH:MM:SS.mmm with an explicit UTC "z" suffix', () => {
    // 2021-01-01T00:00:01.500Z → 1_609_459_201_500 ms → ns
    const ns = 1_609_459_201_500n * 1_000_000n;
    expect(fmtTime(ns)).toBe('00:00:01.500z');
  });
});
