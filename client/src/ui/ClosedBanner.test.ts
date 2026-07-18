import { describe, expect, it } from 'vitest';

import { formatCountdown } from './ClosedBanner';

describe('formatCountdown (§7.1 closed-market countdown)', () => {
  it('formats sub-day spans as HH:MM:SS with zero padding', () => {
    expect(formatCountdown(0)).toBe('00:00:00');
    expect(formatCountdown(1_000)).toBe('00:00:01');
    expect(formatCountdown(65_000)).toBe('00:01:05');
    expect(formatCountdown((2 * 3600 + 3 * 60 + 4) * 1000)).toBe('02:03:04');
    expect(formatCountdown((23 * 3600 + 59 * 60 + 59) * 1000)).toBe('23:59:59');
  });

  it('prefixes whole days for a weekend-length gap', () => {
    // 2 days + 17:30:05 — a Friday-night-to-Monday-open span.
    const ms = (2 * 86_400 + 17 * 3600 + 30 * 60 + 5) * 1000;
    expect(formatCountdown(ms)).toBe('2d 17:30:05');
    expect(formatCountdown(86_400 * 1000)).toBe('1d 00:00:00');
  });

  it('floors sub-second remainders (no rounding up)', () => {
    expect(formatCountdown(1_999)).toBe('00:00:01');
    expect(formatCountdown(999)).toBe('00:00:00');
  });

  it('reads 00:00:00 for non-positive or non-finite spans', () => {
    expect(formatCountdown(-5_000)).toBe('00:00:00');
    expect(formatCountdown(Number.NaN)).toBe('00:00:00');
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe('00:00:00');
  });
});
