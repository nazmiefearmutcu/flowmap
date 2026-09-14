import { describe, expect, it } from 'vitest';

import { Markers } from './markers';
import { GridMap, type TimeSlots } from './coords';
import type { OverlayFrame } from './frame';
import type { Marker } from '../../proto/types';

/**
 * Minimal frame stub for driving `Markers.draw`. The GridMap methods used are
 * stubbed with simple, deterministic transforms so we can assert where glyphs
 * and labels land. Marker `ts_ns` doubles as the label x anchor: `tsToCol`
 * returns it and `cssX` is the identity, so a marker's chip starts at
 * `ts + glyphPx + 2` for priced kinds and `ts + 3` for vertical kinds.
 * `cssY(0)` maps to the bottom of the canvas (grid row 0), which is what makes
 * off-canvas label placement observable.
 */
const CSS_H = 600;
const CSS_W = 800;

function makeFrame() {
  const textCalls: Array<{ x: number; y: number; label: string }> = [];
  const hatchXs: number[] = [];
  const gm = {
    hasEvents: true,
    dims: { cssW: CSS_W, cssH: CSS_H },
    pxToClipW: (px: number) => px / CSS_W,
    pxToClipH: (px: number) => px / CSS_H,
    // Keep every marker on-screen and let ts BE the anchor x.
    tsToCol: (ts: bigint) => Number(ts),
    clipX: (_col: number) => 0,
    clipY: (row: number) => (row === 0 ? -1 : 0),
    cssX: (col: number) => col,
    // Bottom-of-canvas for row 0, so an off-canvas label is easy to detect.
    cssY: (row: number) => CSS_H - row,
    priceToRow: (_p: number) => 5,
  };
  const frame = {
    gm,
    solid: {
      begin() {},
      addThickLine(x: number) {
        hatchXs.push(x);
      },
      addTri() {},
      addQuad() {},
      flush() {},
    },
    points: {},
    text: {
      text(x: number, y: number, label: string) {
        textCalls.push({ x, y, label });
      },
    },
    resident: null,
    capability: null,
    columnArrays: () => null,
  } as unknown as OverlayFrame;
  return { frame, textCalls, hatchXs };
}

function marker(kind: Marker['kind'], price: number | null, ts = 1000): Marker {
  return { ts_ns: ts, price, kind, text: '' } as unknown as Marker;
}

function seamMarker(ts = 1000): Marker {
  return { ts_ns: ts, price: null, kind: 'gap', text: 'history seam (cadence break)' } as unknown as Marker;
}

describe('Markers label placement', () => {
  it('places null-price marker labels near the top, not off-canvas', () => {
    const m = new Markers();
    m.add(marker('large_lot', null));
    const { frame, textCalls } = makeFrame();
    m.draw(frame);

    expect(textCalls).toHaveLength(1);
    // The label must sit near the top (matching the glyph at clip y 0.94), not
    // at cssY(0) === CSS_H (the bottom / off-canvas).
    expect(textCalls[0].y).toBeLessThan(CSS_H * 0.1);
    expect(textCalls[0].y).toBeGreaterThanOrEqual(0);
  });

  it('places priced marker labels at the price row', () => {
    const m = new Markers();
    m.add(marker('large_lot', 123.5));
    const { frame, textCalls } = makeFrame();
    m.draw(frame);

    expect(textCalls).toHaveLength(1);
    // cssY(priceToRow(p)+0.5) === cssY(5.5) === CSS_H - 5.5, plus the +3 nudge.
    expect(textCalls[0].y).toBeCloseTo(CSS_H - 5.5 + 3);
  });

  it('matches the vertical-marker label top offset for null-price markers', () => {
    const priced = new Markers();
    const vertical = new Markers();
    vertical.add(marker('gap', null));
    priced.add(marker('info', null));

    const a = makeFrame();
    const b = makeFrame();
    vertical.draw(a.frame);
    priced.draw(b.frame);

    // Vertical markers use a fixed cssY of 12; null-price glyph labels match it.
    expect(a.textCalls[0].y).toBe(12);
    expect(b.textCalls[0].y).toBe(12);
  });
});

describe('Markers declutter policy (QA14 gapstack)', () => {
  it('collapses a near-identical kind run into one counted badge, keeping every hatch', () => {
    const m = new Markers();
    // Six gaps ~9 px apart (the real BTC pile-up geometry): one chip, six hatches.
    for (const ts of [100, 109, 118, 127, 136, 145]) m.add(marker('gap', null, ts));
    const { frame, textCalls, hatchXs } = makeFrame();
    m.draw(frame);

    expect(hatchXs).toHaveLength(6); // honour: every gap still draws its hatch
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0].label).toBe('GAP ×6');
  });

  it('does not merge kinds that are far apart', () => {
    const m = new Markers();
    m.add(marker('gap', null, 100));
    m.add(marker('gap', null, 300));
    const { frame, textCalls } = makeFrame();
    m.draw(frame);

    expect(textCalls.map((t) => t.label)).toEqual(['GAP', 'GAP']);
    expect(textCalls[0].y).toBe(12);
    expect(textCalls[1].y).toBe(12);
  });

  it('labels seam markers SEAM and collapses them separately from plain gaps', () => {
    const m = new Markers();
    m.add(seamMarker(100));
    m.add(seamMarker(106));
    m.add(marker('gap', null, 103));
    const { frame, textCalls } = makeFrame();
    m.draw(frame);

    const labels = textCalls.map((t) => t.label).sort();
    expect(labels).toEqual(['GAP', 'SEAM ×2']);
  });

  it('offsets overlapping labels away from each other vertically', () => {
    const m = new Markers();
    m.add(marker('large_lot', null, 100)); // rank 2, top lane at y 12
    m.add(marker('gap', null, 100)); // rank 0, same top lane
    const { frame, textCalls } = makeFrame();
    m.draw(frame);

    const gap = textCalls.find((t) => t.label === 'GAP');
    const lot = textCalls.find((t) => t.label === 'LOT');
    expect(gap).toBeTruthy();
    expect(lot).toBeTruthy();
    expect(gap!.y).toBe(12);
    expect(lot!.y).toBe(24); // pushed one pitch down — no overprint
  });

  it('caps labels by priority gap > seam > marker (lowest dropped, glyphs intact)', () => {
    const m = new Markers({ maxLabels: 2 });
    m.add(marker('info', null, 100)); // rank 2
    m.add(marker('gap', null, 100)); // rank 0
    m.add(seamMarker(104)); // rank 1
    const { frame, textCalls, hatchXs } = makeFrame();
    m.draw(frame);

    expect(textCalls.map((t) => t.label)).toEqual(['GAP', 'SEAM']);
    // The dropped INFO chip must not cost its glyph, and both verticals keep hatches.
    expect(hatchXs).toHaveLength(2);
  });

  it('merges chained near markers even when the first-to-last span exceeds the radius', () => {
    const m = new Markers();
    // 12 gaps at 10 px steps → 110 px total span; single-linkage still → one badge.
    for (let i = 0; i < 12; i++) m.add(marker('gap', null, 100 + i * 10));
    const { frame, textCalls } = makeFrame();
    m.draw(frame);
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0].label).toBe('GAP ×12');
  });
});

/**
 * Seam knot anchoring (F22, F9-L1). Geometry mirrors the measured reattach
 * seam: live columns at 1 s cadence, then a reconstructed block whose t0 runs
 * BACKWARD of the column it lands after (the head jump), then the live
 * resumption at the trailing knot. The piecewise table is therefore
 * non-monotonic, and coords.ts's ascending binary search buries the trailing
 * knot several block columns inside the block; with a long pre-block run the
 * leading knot is also outside the table's time range, so the naive mapping
 * hands it to the live affine (far off-view).
 */
function seamGrid(liveBefore: number, blockCols = 60) {
  const startSeq = 100;
  const t0 = new Float64Array(liveBefore + blockCols + 3);
  for (let i = 0; i < liveBefore; i++) t0[i] = 1000 + i; // pre-block live, 1 s cadence
  const headT0 = 900; // backward jump of (t0 of last live col) − 900
  for (let j = 0; j < blockCols; j++) t0[liveBefore + j] = headT0 + j * 3.75; // block, 3.75 s
  const resumeT0 = t0[liveBefore + blockCols - 1] - 5.25; // measured trailing overshoot
  t0[liveBefore + blockCols] = resumeT0;
  t0[liveBefore + blockCols + 1] = resumeT0 + 1;
  t0[liveBefore + blockCols + 2] = resumeT0 + 2;
  const slots: TimeSlots = { t0, startSeq };
  return {
    slots,
    headCol: startSeq + liveBefore,
    headTs: headT0,
    tailCol: startSeq + liveBefore + blockCols,
    tailTs: resumeT0,
    lastT0: resumeT0 + 2,
  };
}

function makeSeamFrame(g: ReturnType<typeof seamGrid>, colScale = 80) {
  const textCalls: Array<{ x: number; y: number; label: string }> = [];
  const hatchXs: number[] = [];
  // 80 columns across the 800 px canvas, framed on the block head + tail.
  const gm = new GridMap(
    { colOffset: g.headCol - 4, colScale, rowOffset: 0, rowScale: 8 },
    { drawW: 1600, drawH: 600, cssW: 800, cssH: 600 },
    // dt matches the production ratio (live 0.25 s columns vs the block's
    // stretched cadence), so the affine fallback is as wrong as it is live.
    { anchorSeq: g.tailCol + 2, anchorT0Ns: BigInt(g.lastT0), dtNs: 0.25, slots: g.slots },
    { p0: 0, step: 1 },
  );
  const frame = {
    gm,
    solid: {
      begin() {},
      addThickLine(x: number) {
        hatchXs.push(x);
      },
      addTri() {},
      addQuad() {},
      flush() {},
    },
    points: {},
    text: {
      text(x: number, y: number, label: string) {
        textCalls.push({ x, y, label });
      },
    },
    resident: null,
    capability: null,
    columnArrays: () => null,
  } as unknown as OverlayFrame;
  return { frame, textCalls, hatchXs, gm };
}

describe('Markers seam knot anchoring (F22, F9-L1)', () => {
  it('anchors the trailing seam badge on the block-end knot, not N columns inside the block', () => {
    const g = seamGrid(12);
    const m = new Markers();
    m.add(seamMarker(g.tailTs));
    const { frame, textCalls, hatchXs, gm } = makeSeamFrame(g);

    // Precondition: the naive mapping really is buried inside the block (the
    // binary search over the non-monotonic table stops early).
    const naive = gm.tsToCol(BigInt(g.tailTs));
    expect(g.tailCol - naive).toBeGreaterThan(1);

    m.draw(frame);
    expect(hatchXs).toHaveLength(1);
    expect(hatchXs[0]).toBeCloseTo(gm.clipX(g.tailCol), 10); // the block end, exactly
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0].label).toBe('SEAM');
    expect(textCalls[0].x).toBeCloseTo(gm.cssX(g.tailCol) + 3, 10);
  });

  it('anchors the leading seam badge on the discontinuity edge even when the affine maps it off-view', () => {
    // A pre-block run longer than the bounded local scan: only the seam
    // markers' full-table fallback can find the head knot.
    const g = seamGrid(1100);
    const m = new Markers();
    m.add(seamMarker(g.headTs));
    const { frame, textCalls, hatchXs, gm } = makeSeamFrame(g);

    // Precondition: the naive mapping is nowhere near the seam (off-view affine).
    const naive = gm.tsToCol(BigInt(g.headTs));
    expect(Math.abs(naive - g.headCol)).toBeGreaterThan(400);

    m.draw(frame);
    expect(hatchXs).toHaveLength(1);
    expect(hatchXs[0]).toBeCloseTo(gm.clipX(g.headCol), 10); // first column of the block
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0].x).toBeCloseTo(gm.cssX(g.headCol) + 3, 10);
  });

  it('keeps the column-center placement for a vertical marker that is not a knot', () => {
    const g = seamGrid(12);
    const ts = g.tailTs - 1.5; // between knots (1114.5 → stored as 1115, no knot)
    const m = new Markers();
    m.add(marker('gap', null, ts));
    const { frame, textCalls, hatchXs, gm } = makeSeamFrame(g);

    const naive = gm.tsToCol(BigInt(Math.round(ts)));
    m.draw(frame);
    expect(hatchXs).toHaveLength(1);
    expect(hatchXs[0]).toBeCloseTo(gm.clipX(naive + 0.5), 10);
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0].x).toBeCloseTo(gm.cssX(naive + 0.5) + 3, 10);
  });

  it('reads SEAM ×2 for two co-located seam knots once collapsed (F16 policy)', () => {
    const g = seamGrid(12);
    const m = new Markers();
    // Head + tail knots collapse once the block is only ~30 px wide.
    m.add(seamMarker(g.headTs));
    m.add(seamMarker(g.tailTs));
    const { frame, textCalls, hatchXs } = makeSeamFrame(g, 1600);

    m.draw(frame);
    expect(hatchXs).toHaveLength(2); // honesty: both hatches stay
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0].label).toBe('SEAM ×2');
  });
});
