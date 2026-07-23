import { describe, expect, it } from 'vitest';

import {
  coreHiPrice,
  isUsableHybrid,
  makeHybrid,
  priceToRow,
  rowToPrice,
  stepAtRow,
  scaleFromEpoch,
  SCALE_KIND_HYBRID,
  upperRows,
  type HybridScale,
  type LinearScale,
} from './priceScale';
import goldenVectors from './priceScale.golden.json';

interface GoldenCase {
  scale: {
    kind: number;
    rows: number;
    p0: number;
    step: number;
    dnRows: number;
    coreRows: number;
    coreP0: number;
    coreStep: number;
    loPrice: number;
    hiPrice: number;
  };
  rows: number[];
  rowToPrice: number[];
  stepAtRow: number[];
  prices: number[];
  priceToRow: number[];
}

const LINEAR: LinearScale = { kind: 'linear', p0: 100, step: 0.5, rows: 2048 };

/** The shipping shape: BTC at $60k, 4096 rows, half of them a $0.50 core. */
function btc(): HybridScale {
  const s = makeHybrid({
    mid: 60_000,
    rows: 4096,
    coreRows: 2048,
    coreStep: 0.5,
    upMult: 11, // +1000%
    dnFloor: 0.01, // −99%
  });
  if (s === null) throw new Error('fixture must build');
  return s;
}

describe('linear scale — must stay bit-identical to the old inlined affine', () => {
  it('maps rows to prices exactly as `p0 + row * step`', () => {
    expect(rowToPrice(LINEAR, 0)).toBe(100);
    expect(rowToPrice(LINEAR, 40)).toBe(120);
    expect(rowToPrice(LINEAR, -10)).toBe(95); // extrapolates (camera overscroll)
  });

  it('inverts exactly', () => {
    expect(priceToRow(LINEAR, 120)).toBe(40);
    expect(priceToRow(LINEAR, 95)).toBe(-10);
  });

  it('has a constant row height', () => {
    expect(stepAtRow(LINEAR, 0)).toBe(0.5);
    expect(stepAtRow(LINEAR, 2000)).toBe(0.5);
  });

  it('returns NaN — not Infinity — on a degenerate zero step', () => {
    expect(Number.isNaN(priceToRow({ ...LINEAR, step: 0 }, 120))).toBe(true);
  });
});

describe('hybrid scale — geometry', () => {
  const s = btc();

  it('splits the grid into lower wing + core + upper wing', () => {
    expect(s.dnRows).toBeGreaterThan(0);
    expect(s.coreRows).toBe(2048);
    expect(upperRows(s)).toBeGreaterThan(0);
    expect(s.dnRows + s.coreRows + upperRows(s)).toBe(s.rows);
  });

  it('is continuous at BOTH joins', () => {
    const loJoin = s.dnRows;
    const hiJoin = s.dnRows + s.coreRows;
    // RELATIVE tolerance: these are ~$60k values, so an absolute epsilon would
    // be testing float64 magnitude, not continuity.
    const rel = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b);
    expect(rel(rowToPrice(s, loJoin - 1e-7), rowToPrice(s, loJoin + 1e-7))).toBeLessThan(1e-9);
    expect(rel(rowToPrice(s, hiJoin - 1e-7), rowToPrice(s, hiJoin + 1e-7))).toBeLessThan(1e-9);
    expect(rel(rowToPrice(s, loJoin), s.coreP0)).toBeLessThan(1e-12);
    expect(rel(rowToPrice(s, hiJoin), coreHiPrice(s))).toBeLessThan(1e-12);
  });

  it('hits the requested coverage at the grid edges', () => {
    expect(rowToPrice(s, 0)).toBeCloseTo(60_000 * 0.01, 6); // −99%
    expect(rowToPrice(s, s.rows)).toBeCloseTo(60_000 * 11, 3); // +1000%
  });

  it('is strictly increasing across the whole grid', () => {
    let prev = -Infinity;
    for (let r = -200; r <= s.rows + 200; r += 7) {
      const p = rowToPrice(s, r);
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('KEEPS the native ladder in the core — the whole point of the design', () => {
    // Every core row is exactly one native tick, and the core covers the same
    // ±0.85% the old narrow grid did. Nothing is lost near the money.
    expect(stepAtRow(s, s.dnRows + 10)).toBeCloseTo(0.5, 9);
    expect(stepAtRow(s, s.dnRows + s.coreRows - 10)).toBeCloseTo(0.5, 9);
    const coverage = ((coreHiPrice(s) - s.coreP0) / 2 / 60_000) * 100;
    expect(coverage).toBeCloseTo(0.853, 2);
  });

  it('spends the wings geometrically, so a % move is the same height either side', () => {
    const dnMid = Math.floor(s.dnRows / 2);
    const upMid = s.dnRows + s.coreRows + Math.floor(upperRows(s) / 2);
    const pctDn = (stepAtRow(s, dnMid) / rowToPrice(s, dnMid)) * 100;
    const pctUp = (stepAtRow(s, upMid) / rowToPrice(s, upMid)) * 100;
    expect(pctDn).toBeCloseTo(pctUp, 2);
    expect(pctUp).toBeLessThan(0.5); // ~0.34%/row at this sizing
  });

  it('makes the wings coarser than the core, never the reverse', () => {
    const coreStep = stepAtRow(s, s.dnRows + 5);
    expect(stepAtRow(s, s.dnRows + s.coreRows + 5)).toBeGreaterThan(coreStep);
    // The lower wing is coarser in PERCENT, but finer in absolute price (it is
    // below the core) — assert the honest direction, not a wrong one.
    const dnPct = stepAtRow(s, 5) / rowToPrice(s, 5);
    const corePct = coreStep / rowToPrice(s, s.dnRows + 5);
    expect(dnPct).toBeGreaterThan(corePct);
  });
});

describe('hybrid scale — inversion', () => {
  const s = btc();

  it('round-trips row → price → row across every zone', () => {
    for (const r of [1, 50, s.dnRows - 1, s.dnRows, s.dnRows + 1, s.dnRows + 1024,
                     s.dnRows + s.coreRows, s.dnRows + s.coreRows + 1, s.rows - 1]) {
      expect(priceToRow(s, rowToPrice(s, r))).toBeCloseTo(r, 6);
    }
  });

  it('round-trips price → row → price at real market prices', () => {
    for (const p of [700, 6_000, 45_000, 59_900, 60_000, 60_400, 120_000, 400_000, 650_000]) {
      expect(rowToPrice(s, priceToRow(s, p))).toBeCloseTo(p, 3);
    }
  });

  it('refuses a non-positive price instead of coercing it to row 0', () => {
    // Log space has no zero. Callers must treat NaN as "off the grid" — silently
    // returning 0 would pile far-out liquidity onto the bottom row.
    expect(Number.isNaN(priceToRow(s, 0))).toBe(true);
    expect(Number.isNaN(priceToRow(s, -5))).toBe(true);
  });

  it('extrapolates monotonically past both edges (camera overscroll)', () => {
    expect(rowToPrice(s, -50)).toBeLessThan(rowToPrice(s, 0));
    expect(rowToPrice(s, s.rows + 50)).toBeGreaterThan(rowToPrice(s, s.rows));
    expect(priceToRow(s, rowToPrice(s, -50))).toBeCloseTo(-50, 4);
  });
});

describe('makeHybrid — refuses degenerate requests rather than shipping a broken map', () => {
  const base = { mid: 60_000, rows: 4096, coreRows: 2048, coreStep: 0.5, upMult: 11, dnFloor: 0.01 };

  it('builds the good case', () => {
    expect(makeHybrid(base)).not.toBeNull();
  });

  it('rejects a non-finite or non-positive mid', () => {
    expect(makeHybrid({ ...base, mid: Number.NaN })).toBeNull();
    expect(makeHybrid({ ...base, mid: 0 })).toBeNull();
    expect(makeHybrid({ ...base, mid: -1 })).toBeNull();
  });

  it('rejects a floor at or above zero-crossing, and an inverted band', () => {
    expect(makeHybrid({ ...base, dnFloor: 0 })).toBeNull();
    expect(makeHybrid({ ...base, dnFloor: 1 })).toBeNull();
    expect(makeHybrid({ ...base, upMult: 1 })).toBeNull();
  });

  it('rejects a core that leaves no room for wings', () => {
    expect(makeHybrid({ ...base, coreRows: 4096 })).toBeNull();
    expect(makeHybrid({ ...base, coreRows: 0 })).toBeNull();
  });

  it('rejects a band NARROWER than the core (hybrid would be the wrong tool)', () => {
    // A core so wide it already swallows the requested band: the caller should
    // just use the linear grid.
    expect(makeHybrid({ ...base, coreStep: 500 })).toBeNull();
  });

  it('rejects a non-positive core step', () => {
    expect(makeHybrid({ ...base, coreStep: 0 })).toBeNull();
    expect(makeHybrid({ ...base, coreStep: Number.NaN })).toBeNull();
  });

  it('works for a cheap instrument too (the grid is scale-free)', () => {
    const alt = makeHybrid({ ...base, mid: 0.5, coreStep: 0.00001 });
    expect(alt).not.toBeNull();
    expect(rowToPrice(alt!, 0)).toBeCloseTo(0.005, 9);
    expect(rowToPrice(alt!, alt!.rows)).toBeCloseTo(5.5, 6);
  });
});

describe('isUsableHybrid — the guard every consumer leans on', () => {
  const s = btc();

  it('accepts the shipping shape', () => {
    expect(isUsableHybrid(s)).toBe(true);
  });

  it('rejects the shapes that would produce NaN or a non-monotone map', () => {
    expect(isUsableHybrid({ ...s, loPrice: 0 })).toBe(false);
    expect(isUsableHybrid({ ...s, loPrice: s.coreP0 + 1 })).toBe(false); // wing inverted
    expect(isUsableHybrid({ ...s, coreStep: 0 })).toBe(false);
    expect(isUsableHybrid({ ...s, coreRows: 0 })).toBe(false);
    expect(isUsableHybrid({ ...s, hiPrice: 1 })).toBe(false); // upper wing inverted
  });

  it('makes an unusable scale return NaN rather than a plausible wrong number', () => {
    const bad: HybridScale = { ...s, loPrice: 0 };
    expect(Number.isNaN(rowToPrice(bad, 100))).toBe(true);
    expect(Number.isNaN(priceToRow(bad, 100))).toBe(true);
  });
});

describe('cross-language parity with the SERVER price scale', () => {
  // The server bins liquidity into rows; this module labels those same rows
  // back into prices. If the two implementations disagree the chart silently
  // shows wrong prices — the worst failure mode available here — so assert
  // against vectors the SERVER produced.
  //
  // Regenerate: cd server && uv run python scripts/write_price_scale_golden.py
  const golden = goldenVectors as Record<string, GoldenCase>;

  for (const [name, c] of Object.entries(golden)) {
    describe(name, () => {
      const s = (c.scale.kind === 0
        ? { kind: 'linear', p0: c.scale.p0, step: c.scale.step, rows: c.scale.rows }
        : {
            kind: 'hybrid',
            rows: c.scale.rows,
            dnRows: c.scale.dnRows,
            coreRows: c.scale.coreRows,
            coreP0: c.scale.coreP0,
            coreStep: c.scale.coreStep,
            loPrice: c.scale.loPrice,
            hiPrice: c.scale.hiPrice,
          }) as never;

      it('agrees with the server on rowToPrice', () => {
        c.rows.forEach((r, i) => {
          const got = rowToPrice(s, r);
          const want = c.rowToPrice[i];
          expect(Math.abs(got - want) / Math.max(Math.abs(want), 1e-12)).toBeLessThan(1e-12);
        });
      });

      it('agrees with the server on priceToRow', () => {
        c.prices.forEach((p, i) => {
          const got = priceToRow(s, p);
          const want = c.priceToRow[i];
          if (Number.isNaN(want)) {
            expect(Number.isNaN(got)).toBe(true);
            return;
          }
          expect(Math.abs(got - want) / Math.max(Math.abs(want), 1e-12)).toBeLessThan(1e-12);
        });
      });

      it('agrees with the server on stepAtRow', () => {
        c.rows.forEach((r, i) => {
          const got = stepAtRow(s, r);
          const want = c.stepAtRow[i];
          expect(Math.abs(got - want) / Math.max(Math.abs(want), 1e-12)).toBeLessThan(1e-12);
        });
      });
    });
  }

  it('reproduces the server-chosen wing split for the shipping BTC shape', () => {
    // Guards the constructor, not just the map: both sides must pick the SAME
    // dnRows from the same request, or every row is off by a constant.
    const s = btc();
    expect(s.dnRows).toBe(golden.btc_hybrid.scale.dnRows);
    expect(s.coreP0).toBe(golden.btc_hybrid.scale.coreP0);
    expect(s.loPrice).toBe(golden.btc_hybrid.scale.loPrice);
    expect(s.hiPrice).toBe(golden.btc_hybrid.scale.hiPrice);
  });
});

describe('scaleFromEpoch — the wire compatibility rule', () => {
  const linearEp = { tick: 0.01, tick_multiple: 5, p0: 90, rows: 2048 };

  it('reads an epoch with NO scale fields as the legacy affine', () => {
    // Every epoch written before the hybrid existed, and every linear epoch
    // written after it (the server omits the defaults).
    const s = scaleFromEpoch(linearEp);
    expect(s.kind).toBe('linear');
    expect(s).toEqual({ kind: 'linear', p0: 90, step: 0.05, rows: 2048 });
  });

  it('reads scale_kind 0 as linear too', () => {
    expect(scaleFromEpoch({ ...linearEp, scale_kind: 0 }).kind).toBe('linear');
  });

  it('reconstructs a hybrid frame exactly', () => {
    const h = btc();
    const s = scaleFromEpoch({
      tick: 0.5,
      tick_multiple: 1,
      p0: 0,
      rows: h.rows,
      scale_kind: SCALE_KIND_HYBRID,
      dn_rows: h.dnRows,
      core_rows: h.coreRows,
      core_p0: h.coreP0,
      core_step: h.coreStep,
      lo_price: h.loPrice,
      hi_price: h.hiPrice,
    });
    expect(s).toEqual(h);
  });

  it('degrades an UNKNOWN scale kind to linear (forward compatibility)', () => {
    // A newer server must never make an older client silently mis-read a
    // piecewise grid as a uniform one.
    expect(scaleFromEpoch({ ...linearEp, scale_kind: 99 }).kind).toBe('linear');
  });

  it('degrades an UNUSABLE hybrid frame to linear rather than mapping garbage', () => {
    const s = scaleFromEpoch({
      ...linearEp,
      scale_kind: SCALE_KIND_HYBRID,
      dn_rows: 100,
      core_rows: 200,
      core_p0: 50,
      core_step: 0.5,
      lo_price: 0, // log space has no zero
      hi_price: 999,
    });
    expect(s.kind).toBe('linear');
  });

  it('tolerates a hybrid frame with missing optional fields', () => {
    // Should not throw or produce undefined-driven NaN; falls back to linear.
    expect(scaleFromEpoch({ ...linearEp, scale_kind: SCALE_KIND_HYBRID }).kind).toBe('linear');
  });
});
