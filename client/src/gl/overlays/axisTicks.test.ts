import { describe, expect, it } from 'vitest';

import {
  fmtClock,
  fmtClockMs,
  niceStep,
  niceTimeStepNs,
  priceDecimals,
  priceTickModel,
  priceTicks,
  timeTickModel,
  timeTicks,
} from './axisTicks';

describe('niceStep', () => {
  it('rounds up to 1/2/5 × 10ᵏ', () => {
    expect(niceStep(0.3)).toBeCloseTo(0.5);
    expect(niceStep(1)).toBe(1);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(11)).toBe(20);
    expect(niceStep(0)).toBe(1); // degenerate → safe default
  });
});

describe('priceTicks', () => {
  it('produces nice, ascending ticks spanning the range', () => {
    const t = priceTicks(100, 110, 5, 0.5);
    expect(t[0]).toBe(100);
    expect(t[t.length - 1]).toBe(110);
    // Step nice(10/5=2)=2 → 100,102,…,110.
    expect(t).toEqual([100, 102, 104, 106, 108, 110]);
  });

  it('never labels finer than the grid step', () => {
    const t = priceTicks(100, 100.5, 10, 0.5);
    expect(t).toEqual([100, 100.5]);
  });

  it('is empty for a degenerate range', () => {
    expect(priceTicks(100, 100, 5, 0.5)).toEqual([]);
  });
});

describe('priceTickModel', () => {
  it('exposes the chosen tick step alongside the ticks', () => {
    const m = priceTickModel(100, 110, 5, 0.5);
    expect(m.step).toBe(2); // nice(10/5=2)=2
    expect(m.ticks).toEqual([100, 102, 104, 106, 108, 110]);
    // Decimals derived from the TICK step are minimal (no spurious '.00').
    expect(priceDecimals(m.step)).toBe(0);
  });

  it('is empty (step 0) for a degenerate range', () => {
    expect(priceTickModel(100, 100, 5, 0.5)).toEqual({ step: 0, ticks: [] });
  });
});

describe('priceDecimals', () => {
  it('derives decimals from the step', () => {
    expect(priceDecimals(0.5)).toBe(1);
    expect(priceDecimals(0.01)).toBe(2);
    expect(priceDecimals(1)).toBe(0);
  });
});

describe('time ticks', () => {
  it('snaps to a human interval ≥ the wanted spacing', () => {
    expect(niceTimeStepNs(1e9, 5)).toBe(2.5e8); // want 2e8 → 250 ms
    expect(niceTimeStepNs(6e10, 6)).toBe(1e10); // want 1e10 → 10 s
  });

  it('produces aligned ascending ticks over the span', () => {
    const t = timeTicks(0n, 1_000_000_000n, 5);
    expect(t).toEqual([0n, 250_000_000n, 500_000_000n, 750_000_000n, 1_000_000_000n]);
  });

  it('is empty for a zero span', () => {
    expect(timeTicks(100n, 100n, 5)).toEqual([]);
  });
});

describe('timeTickModel', () => {
  it('exposes the sub-second step so labels can pick a ms format', () => {
    const m = timeTickModel(0n, 1_000_000_000n, 5);
    expect(m.step).toBe(250_000_000n); // 250 ms < 1 s
    expect(m.ticks).toEqual([0n, 250_000_000n, 500_000_000n, 750_000_000n, 1_000_000_000n]);

    // With a sub-second step, HH:MM:SS collapses to identical rows but the ms
    // format keeps every tick distinct — the whole point of picking fmtClockMs.
    const clock = m.ticks.map(fmtClock);
    const clockMs = m.ticks.map(fmtClockMs);
    expect(new Set(clock).size).toBeLessThan(m.ticks.length);
    expect(new Set(clockMs).size).toBe(m.ticks.length);
    expect(clockMs).toEqual([
      '00:00:00.000',
      '00:00:00.250',
      '00:00:00.500',
      '00:00:00.750',
      '00:00:01.000',
    ]);
  });

  it('reports a ≥1 s step for coarse spans (fmtClock is enough)', () => {
    const m = timeTickModel(0n, 60_000_000_000n, 6);
    expect(m.step).toBe(10_000_000_000n); // 10 s
    expect(m.step >= 1_000_000_000n).toBe(true);
  });

  it('is empty (step 0) for a zero span', () => {
    expect(timeTickModel(100n, 100n, 5)).toEqual({ step: 0n, ticks: [] });
  });
});

describe('fmtClock', () => {
  it('formats ns as HH:MM:SS (session-relative)', () => {
    expect(fmtClock(0n)).toBe('00:00:00');
    expect(fmtClock(3_661_000_000_000n)).toBe('01:01:01');
  });
});
