import { describe, expect, it } from 'vitest';

import { Cvd } from './cvd';
import { PriceLine } from './priceLine';
import type { BarColumn } from '../../proto/types';
import { MsgType } from '../../proto/types';

function bar(col_seq: number, close: number, cvd: number): BarColumn {
  return {
    type: MsgType.BAR_COL,
    epoch: 0,
    col_seq,
    t0_ns: 0n,
    o: close,
    h: close,
    l: close,
    c: close,
    vol_buy: 0,
    vol_sell: 0,
    cvd_cum: cvd,
    vwap_num_cum: 0,
    vwap_den_cum: 0,
  };
}

describe('Cvd data holder', () => {
  it('records cvd_cum by col_seq and returns the visible ascending series', () => {
    const c = new Cvd();
    c.add(bar(5, 100, 30));
    c.add(bar(3, 100, 10));
    c.add(bar(4, 100, 20));
    expect(c.size).toBe(3);
    expect(c.series(3, 5)).toEqual([
      { col: 3, cvd: 10 },
      { col: 4, cvd: 20 },
      { col: 5, cvd: 30 },
    ]);
    // window clips
    expect(c.series(4, 4)).toEqual([{ col: 4, cvd: 20 }]);
  });

  it('prunes columns outside the resident window', () => {
    const c = new Cvd();
    for (let i = 0; i < 10; i++) c.add(bar(i, 100, i));
    c.prune(4, 7, 0);
    expect(c.valueAt(3)).toBeNaN();
    expect(c.valueAt(5)).toBe(5);
    expect(c.valueAt(8)).toBeNaN();
  });

  it('ignores non-finite cvd', () => {
    const c = new Cvd();
    c.add(bar(1, 100, Number.NaN));
    expect(c.size).toBe(0);
  });
});

describe('PriceLine data holder', () => {
  it('records close by col_seq and prunes to the window', () => {
    const p = new PriceLine();
    p.add(bar(1, 101, 0));
    p.add(bar(2, 102, 0));
    expect(p.valueAt(2)).toBe(102);
    p.prune(2, 5, 0);
    expect(p.valueAt(1)).toBeNaN();
    expect(p.valueAt(2)).toBe(102);
  });
});
