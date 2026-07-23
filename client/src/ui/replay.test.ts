import { describe, expect, it } from 'vitest';

import {
  behindNs,
  clampSpeed,
  formatDurationCoarseNs,
  formatDurationNs,
  fractionOfExtent,
  nextSpeed,
  phaseLabel,
  seekTargetNs,
  SPEED_STEPS,
  transportPhase,
} from './replay';

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

describe('formatDurationNs', () => {
  it('renders HH:MM:SS.mmm from a ns duration', () => {
    expect(formatDurationNs(0n)).toBe('00:00:00.000');
    expect(formatDurationNs(1_000_000n)).toBe('00:00:00.001'); // 1 ms
    expect(formatDurationNs(1_500_000_000n)).toBe('00:00:01.500'); // 1.5 s
    expect(formatDurationNs(61_000_000_000n)).toBe('00:01:01.000'); // 1 m 1 s
    expect(formatDurationNs(3_661_250_000_000n)).toBe('01:01:01.250'); // 1h 1m 1s 250ms
  });

  it('clamps negatives to zero and keeps ns precision on long sessions', () => {
    expect(formatDurationNs(-5n)).toBe('00:00:00.000');
    // 10h 0m 0s 999ms
    expect(formatDurationNs(36_000_000_000_000n + 999_000_000n)).toBe('10:00:00.999');
  });
});

describe('nextSpeed — the one cycling control over the whole ladder', () => {
  it('steps up through every rung and wraps', () => {
    expect(nextSpeed(1)).toBe(2);
    expect(nextSpeed(2)).toBe(5);
    expect(nextSpeed(5)).toBe(10);
    expect(nextSpeed(10)).toBe(50);
    expect(nextSpeed(50)).toBe(100);
    expect(nextSpeed(100)).toBe(1); // wraps
  });

  it('steps down and wraps the other way', () => {
    expect(nextSpeed(5, -1)).toBe(2);
    expect(nextSpeed(1, -1)).toBe(100);
  });

  it('snaps an off-ladder value onto the ladder before stepping', () => {
    // A stale/garbage store value must not dump the user back to 1x.
    expect(nextSpeed(7)).toBe(10); // 7 -> clamp 5 -> next 10
    expect(nextSpeed(0)).toBe(2); // below the ladder -> clamp 1 -> next 2
    expect(nextSpeed(1e6)).toBe(1); // above -> clamp 100 -> wraps
  });

  it('reaches every rung from any start (the ladder is fully exposed)', () => {
    const seen = new Set<number>();
    let s: number = 1;
    for (let i = 0; i < SPEED_STEPS.length; i++) {
      s = nextSpeed(s);
      seen.add(s);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([...SPEED_STEPS]);
  });
});

describe('transportPhase / phaseLabel', () => {
  it('reports the CAMERA state in live mode, not the connection', () => {
    expect(transportPhase(false, false, true)).toBe('live-following');
    expect(transportPhase(false, false, false)).toBe('live-detached');
    expect(phaseLabel('live-following', 1)).toBe('FOLLOWING');
    expect(phaseLabel('live-detached', 1)).toBe('SCROLLED BACK');
  });

  it('reports play state and speed in replay mode', () => {
    expect(transportPhase(true, false, true)).toBe('replay-playing');
    expect(transportPhase(true, true, true)).toBe('replay-paused');
    expect(phaseLabel('replay-playing', 5)).toBe('REPLAY 5× PLAYING');
    expect(phaseLabel('replay-paused', 100)).toBe('REPLAY 100× PAUSED');
  });

  it('ignores `following` in replay (the scrubber owns position there)', () => {
    expect(transportPhase(true, false, false)).toBe('replay-playing');
  });
});

describe('behindNs / formatDurationCoarseNs', () => {
  it('converts a column lag to ns', () => {
    expect(behindNs(4, 250_000_000)).toBe(1_000_000_000n);
  });

  it('is zero when pinned to the live edge or the cadence is unknown', () => {
    expect(behindNs(0, 250_000_000)).toBe(0n);
    expect(behindNs(-3, 250_000_000)).toBe(0n);
    expect(behindNs(10, 0)).toBe(0n);
  });

  it('formats HH:MM:SS with no millisecond churn', () => {
    expect(formatDurationCoarseNs(0n)).toBe('00:00:00');
    expect(formatDurationCoarseNs(90_500_000_000n)).toBe('00:01:30');
    expect(formatDurationCoarseNs(3_723_000_000_000n)).toBe('01:02:03');
    expect(formatDurationCoarseNs(-5n)).toBe('00:00:00');
  });

  it('differs from formatDurationNs precisely by the .mmm field', () => {
    expect(formatDurationNs(90_500_000_000n)).toBe('00:01:30.500');
    expect(formatDurationCoarseNs(90_500_000_000n)).toBe('00:01:30');
  });
});
