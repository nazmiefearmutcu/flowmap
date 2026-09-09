import { describe, expect, it } from 'vitest';

import { fmtPct, fmtPrice, sparkDirection, sparkPath } from './spark';

describe('sparkPath', () => {
  it('returns empty for no data', () => {
    expect(sparkPath([], 56, 18)).toBe('');
  });
  it('starts with a moveto and fits inside the padded box', () => {
    const d = sparkPath([1, 2, 3], 56, 18, 1);
    expect(d.startsWith('M')).toBe(true);
    // 3 vertices → one M + two L commands
    expect((d.match(/L/g) ?? []).length).toBe(2);
  });
  it('puts the max at the top (small y) and min at the bottom', () => {
    // two points: min then max → first y is larger (lower) than second
    const d = sparkPath([0, 10], 100, 100, 0);
    const ys = d.match(/[ML][\d.]+ ([\d.]+)/g)!.map((s) => Number(s.split(' ')[1]));
    expect(ys[0]).toBeGreaterThan(ys[1]);
  });
  it('skips non-finite points instead of emitting "LNaN"', () => {
    const d = sparkPath([1, Number.NaN, 3], 100, 100, 0);
    expect(d).not.toContain('NaN');
    expect(d).not.toContain('Infinity');
    // The two finite points still draw: one M (resume) + one L.
    expect((d.match(/L/g) ?? []).length).toBe(1);
  });
});

describe('sparkDirection', () => {
  it('is +1 up, -1 down, 0 flat/short', () => {
    expect(sparkDirection([1, 2])).toBe(1);
    expect(sparkDirection([2, 1])).toBe(-1);
    expect(sparkDirection([2, 2])).toBe(0);
    expect(sparkDirection([5])).toBe(0);
  });
});

describe('fmtPct / fmtPrice', () => {
  it('signs percentages and dashes null', () => {
    expect(fmtPct(3.2)).toBe('+3.20%');
    expect(fmtPct(-0.5)).toBe('−0.50%');
    expect(fmtPct(null)).toBe('—');
  });
  it('adapts price decimals to magnitude', () => {
    expect(fmtPrice(64000)).toBe('64,000');
    expect(fmtPrice(210.5)).toBe('210.50');
    expect(fmtPrice(0.1234)).toBe('0.1234');
    expect(fmtPrice(null)).toBe('—');
  });
  it('formats subnormal prices fixed-point, never exponential ("1.2e-9")', () => {
    // toPrecision(3) printed "1.2e-9" — exponential is not a readable price.
    expect(fmtPrice(1.2e-9)).toBe('0.00000000120');
    expect(fmtPrice(0.009)).toBe('0.00900');
    expect(fmtPrice(0)).toBe('0.00');
  });
});
