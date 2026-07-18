import { describe, expect, it } from 'vitest';

import { SPEED_STEPS, clampSpeed, fractionOfExtent, seekTargetNs } from './replay';

describe('SPEED_STEPS', () => {
  it('is the 1–100× ladder from §9', () => {
    expect([...SPEED_STEPS]).toEqual([1, 2, 5, 10, 50, 100]);
  });
});

describe('clampSpeed', () => {
  it('floors to the nearest step at or below the input', () => {
    expect(clampSpeed(1)).toBe(1);
    expect(clampSpeed(3)).toBe(2);
    expect(clampSpeed(0.5)).toBe(1);
    expect(clampSpeed(49)).toBe(10);
    expect(clampSpeed(1000)).toBe(100);
  });
});

describe('seekTargetNs', () => {
  const extent = { startNs: 1_000_000_000n, endNs: 3_000_000_000n }; // 2 s span

  it('maps fraction endpoints exactly', () => {
    expect(seekTargetNs(0, extent)).toBe(1_000_000_000n);
    expect(seekTargetNs(1, extent)).toBe(3_000_000_000n);
    expect(seekTargetNs(0.5, extent)).toBe(2_000_000_000n);
  });

  it('clamps out-of-range fractions', () => {
    expect(seekTargetNs(-0.4, extent)).toBe(extent.startNs);
    expect(seekTargetNs(2.5, extent)).toBe(extent.endNs);
  });

  it('a zero/negative-width extent seeks to its start', () => {
    expect(seekTargetNs(0.7, { startNs: 5n, endNs: 5n })).toBe(5n);
    expect(seekTargetNs(0.7, { startNs: 9n, endNs: 3n })).toBe(9n);
  });

  it('keeps nanosecond precision on a large extent', () => {
    const big = { startNs: 1_752_710_400_000_000_000n, endNs: 1_752_710_400_000_000_000n + 1_000_000_000n };
    expect(seekTargetNs(0.25, big)).toBe(1_752_710_400_000_000_000n + 250_000_000n);
  });
});

describe('fractionOfExtent', () => {
  const extent = { startNs: 1_000_000_000n, endNs: 3_000_000_000n };
  it('inverts seekTargetNs at the midpoint and clamps', () => {
    expect(fractionOfExtent(2_000_000_000n, extent)).toBeCloseTo(0.5, 6);
    expect(fractionOfExtent(0n, extent)).toBe(0);
    expect(fractionOfExtent(9_000_000_000n, extent)).toBe(1);
    expect(fractionOfExtent(5n, { startNs: 5n, endNs: 5n })).toBe(0);
  });
});
