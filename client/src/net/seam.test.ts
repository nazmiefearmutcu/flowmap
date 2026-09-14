/**
 * Seam detector unit tests (QA3 C-1 honesty fix).
 *
 * Numbers mirror the measured repro: live columns at dt=250 ms, a reconstructed
 * block at 3.75 s/col, a −1806.5 s leading backward jump and a −9 s trailing one.
 */
import { describe, expect, it } from 'vitest';

import {
  detectDepthSeam,
  SEAM_MIN_DEVIATION_NS,
  seamGapMarker,
  SeamTracker,
  seamToleranceNs,
} from './seam';
import { MsgType } from '../proto/types';

const DT = 250_000_000n; // 250 ms live cadence

function s(epoch: number, colSeq: number, t0: bigint) {
  return { epoch, col_seq: colSeq, t0_ns: t0 };
}

/** t0 of a live column: colSeq × dt. */
function live(colSeq: number, epoch = 0): ReturnType<typeof s> {
  return s(epoch, colSeq, BigInt(colSeq) * DT);
}

describe('detectDepthSeam', () => {
  it('returns null for a clean cadence-consistent step', () => {
    expect(detectDepthSeam(live(10), live(11), DT)).toBeNull();
  });

  it('returns null for a clean multi-column seq jump (sim capped gap)', () => {
    // The server emits its OWN gap marker for a seq skip; t0 still matches.
    expect(detectDepthSeam(live(10), live(40), DT)).toBeNull();
  });

  it('reports a backward jump (the measured −1806.5 s leading seam)', () => {
    const prev = live(7678); // 21:24:38 live
    const head = s(0, 7679, prev.t0_ns - 1_806_500_000_000n); // reconstructed head
    const verdict = detectDepthSeam(prev, head, DT);
    expect(verdict).toMatchObject({ kind: 'backward', expectedNs: null });
    expect(verdict?.deltaNs).toBe(-1_806_500_000_000n);
  });

  it('reports a backward jump even with dt unknown', () => {
    const prev = live(5);
    const next = s(0, 6, prev.t0_ns - 60_000_000_000n);
    expect(detectDepthSeam(prev, next, null)?.kind).toBe('backward');
  });

  it('reports the reconstructed-block warp (3.75 s step at 250 ms dt)', () => {
    // The block's own cadence: each column is 3.75 s after the previous one,
    // while the epoch still says 250 ms.
    const head = s(0, 7679, BigInt(7679) * DT - 1_806_500_000_000n);
    const next = s(0, 7680, head.t0_ns + 3_750_000_000n);
    const verdict = detectDepthSeam(head, next, DT);
    expect(verdict?.kind).toBe('warp');
    expect(verdict?.expectedNs).toBe(DT);
    expect(verdict?.deltaNs).toBe(3_750_000_000n);
  });

  it('ignores sub-tolerance jitter', () => {
    const a = live(10);
    const b = s(0, 11, a.t0_ns + DT + 500_000_000n); // +0.5 s < 1 s floor
    expect(detectDepthSeam(a, b, DT)).toBeNull();
  });

  it('skips a warp when epochs differ (a re-anchor legitimately changes dt)', () => {
    const prev = live(10, 1);
    const next = s(2, 11, prev.t0_ns + 5_000_000_000n);
    expect(detectDepthSeam(prev, next, DT)).toBeNull();
  });

  it('never reports for forming/duplicate re-sends (col_seq not advancing)', () => {
    expect(detectDepthSeam(live(10), live(10), DT)).toBeNull();
    expect(detectDepthSeam(live(20), live(15), DT)).toBeNull();
  });

  it('seamToleranceNs is max(dt×4, 1 s)', () => {
    expect(seamToleranceNs(DT)).toBe(SEAM_MIN_DEVIATION_NS);
    expect(seamToleranceNs(2_000_000_000n)).toBe(8_000_000_000n);
    expect(seamToleranceNs(null)).toBe(SEAM_MIN_DEVIATION_NS);
  });

  it('seamGapMarker builds a price-less gap Marker at the resumption t0', () => {
    const m = seamGapMarker(42n);
    expect(m).toEqual({
      type: MsgType.MARKER,
      ts_ns: 42n,
      kind: 'gap',
      text: 'history seam',
      price: null,
      size: null,
    });
  });
});

describe('SeamTracker', () => {
  it('fires once per clean run + once per backward boundary', () => {
    const tracker = new SeamTracker();
    // clean live run
    expect(tracker.observe(live(1), DT)).toBeNull();
    expect(tracker.observe(live(2), DT)).toBeNull();
    // leading backward seam: fires
    const head = s(0, 3, live(3).t0_ns - 1_800_000_000_000n);
    expect(tracker.observe(head, DT)?.kind).toBe('backward');
    // every internal block step is warped (3.75 s vs 250 ms) — suppressed
    let fired = 0;
    let t0 = head.t0_ns;
    for (let c = 4; c < 60; c++) {
      t0 += 3_750_000_000n; // one reconstructed column per 3.75 s
      const v = tracker.observe(s(0, c, t0), DT);
      if (v !== null) fired++;
    }
    expect(fired).toBe(0);
    // trailing backward seam (block ends ahead, live resumes earlier): fires
    const resume = s(0, 60, t0 - 9_000_000_000n);
    expect(tracker.observe(resume, DT)?.kind).toBe('backward');
  });

  it('fires the head of a warp run, then re-arms after the run becomes consistent', () => {
    const tracker = new SeamTracker();
    expect(tracker.observe(live(1), DT)).toBeNull();
    // a warp with no backward boundary (e.g. a page splice): first pair fires
    expect(tracker.observe(live(2), DT)).toBeNull(); // consistent baseline
    const warped1 = s(0, 3, live(2).t0_ns + 3_750_000_000n);
    expect(tracker.observe(warped1, DT)?.kind).toBe('warp');
    // next warped step suppressed
    const warped2 = s(0, 4, warped1.t0_ns + 3_750_000_000n);
    expect(tracker.observe(warped2, DT)).toBeNull();
    // a consistent step re-arms the detector
    const consistent = s(0, 5, warped2.t0_ns + DT);
    expect(tracker.observe(consistent, DT)).toBeNull();
    const warped3 = s(0, 6, consistent.t0_ns + 3_750_000_000n);
    expect(tracker.observe(warped3, DT)?.kind).toBe('warp');
  });

  it('reset() forgets the cursor so a new session starts clean', () => {
    const tracker = new SeamTracker();
    tracker.observe(live(500), DT);
    tracker.reset();
    // A fresh session's first column (low seq, low t0) is never a seam.
    expect(tracker.observe(live(1), DT)).toBeNull();
    expect(tracker.observe(live(2), DT)).toBeNull();
  });

  it('does not regress the cursor on an older snapshot re-send', () => {
    const tracker = new SeamTracker();
    expect(tracker.observe(live(50), DT)).toBeNull();
    // an older finalized re-send slips through (forming path) — no verdict and
    // no cursor regression; the next live column still measures against seq 50
    expect(tracker.observe(live(40), DT)).toBeNull();
    expect(tracker.observe(live(51), DT)).toBeNull();
  });
});
