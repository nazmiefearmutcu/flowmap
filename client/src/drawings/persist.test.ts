/**
 * Persistence tests (lane CF): versioned localStorage documents — exact
 * bigint round-trip through decimal strings, total parsing (garbage reads as
 * empty), wholesale future-version rejection, entry-wise validation, and the
 * bounded per-symbol cap (200, newest kept).
 */

import { describe, expect, it } from 'vitest';

import {
  DRAWINGS_SCHEMA_VERSION,
  MAX_DRAWINGS_PER_SYMBOL,
  capDrawings,
  drawingsKey,
  loadDrawings,
  parseDoc,
  saveDrawings,
  serializeDoc,
  type StorageLike,
} from './persist';
import { DEFAULT_STYLE } from './types';
import type { DrawingsDoc } from './types';
import type { ChartPoint, Drawing } from './types';

function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const P = (t: bigint, price: number): ChartPoint => ({ tNs: t, price });
const trend = (id: string, createdAt: number): Drawing => ({
  id,
  tool: 'trendline',
  createdAt,
  points: [P(1_000_000_000_000n, 101.5), P(2_000_000_000_000n, 99.25)],
  style: { ...DEFAULT_STYLE },
});
const label = (id: string): Drawing => ({
  id,
  tool: 'text',
  createdAt: 5,
  points: [P(0n, 1)],
  style: { ...DEFAULT_STYLE },
  text: 'wall',
});

describe('key + doc shape', () => {
  it('namespaces per market:symbol under the flowmap.drawings prefix', () => {
    expect(drawingsKey('crypto', 'BTCUSDT')).toBe('flowmap.drawings.v1.crypto.BTCUSDT');
  });

  it('serializes bigints as decimal strings and parses them back EXACTLY', () => {
    const doc: DrawingsDoc = { version: DRAWINGS_SCHEMA_VERSION, drawings: [trend('a', 1)] };
    const raw = serializeDoc(doc);
    expect(raw).toContain('"tNs":"1000000000000"'); // string in JSON — a number would corrupt epoch ns
    const out = parseDoc(raw);
    expect(out.length).toBe(1);
    const d0 = out[0] as Drawing;
    expect(d0.points[0].tNs).toBe(1_000_000_000_000n);
    expect(d0.points[1]!.price).toBe(99.25);
  });
});

describe('parseDoc is total', () => {
  it('reads null / empty / garbage as an empty list, never throws', () => {
    expect(parseDoc(null)).toEqual([]);
    expect(parseDoc('')).toEqual([]);
    expect(parseDoc('{not json')).toEqual([]);
    expect(parseDoc('42')).toEqual([]);
    expect(parseDoc('{"version":1}')).toEqual([]); // missing drawings
  });

  it('rejects past AND future schema versions wholesale', () => {
    expect(parseDoc('{"version":2,"drawings":[]}')).toEqual([]);
    expect(parseDoc('{"version":0,"drawings":[]}')).toEqual([]);
  });

  it('drops invalid entries while valid siblings survive', () => {
    const raw = serializeDoc({
      version: DRAWINGS_SCHEMA_VERSION,
      drawings: [
        trend('good', 1),
        { id: 'bad-tool', tool: 'lightsaber', createdAt: 1, points: [], style: DEFAULT_STYLE } as unknown as Drawing,
        { id: 'bad-arity', tool: 'rect', createdAt: 1, points: [P(0n, 1)], style: DEFAULT_STYLE } as unknown as Drawing,
        { id: 'bad-nan', tool: 'hline', createdAt: 1, points: [{ tNs: '0', price: Number.NaN }], style: DEFAULT_STYLE } as unknown as Drawing,
        { id: 'bad-style', tool: 'hline', createdAt: 1, points: [P(0n, 1)], style: { color: 7, width: 2 } } as unknown as Drawing,
        { ...label('bad-text'), text: 42 } as unknown as Drawing,
      ],
    });
    const out = parseDoc(raw);
    expect(out.map((d) => d.id)).toEqual(['good']);
  });

  it('keeps a valid text payload through the round-trip', () => {
    const raw = serializeDoc({
      version: DRAWINGS_SCHEMA_VERSION,
      drawings: [label('t')],
    });
    expect(parseDoc(raw)[0]).toMatchObject({ tool: 'text', text: 'wall' });
  });
});

describe('cap (bounded 200/symbol)', () => {
  it('keeps the NEWEST 200 drawings by createdAt, preserving paint order', () => {
    const items: Drawing[] = [];
    for (let i = 0; i < MAX_DRAWINGS_PER_SYMBOL + 5; i += 1) {
      items.push(trend(`d${i}`, i)); // ascending createdAt; d0 oldest
    }
    const capped = capDrawings(items);
    expect(capped.length).toBe(MAX_DRAWINGS_PER_SYMBOL);
    expect(capped[0].id).toBe('d5'); // the 5 oldest evicted
    expect(capped[capped.length - 1].id).toBe(`d${MAX_DRAWINGS_PER_SYMBOL + 4}`);
  });

  it('enforces the cap on load too', () => {
    const items: Drawing[] = [];
    for (let i = 0; i < MAX_DRAWINGS_PER_SYMBOL + 1; i += 1) items.push(trend(`d${i}`, i));
    const raw = serializeDoc({
      version: DRAWINGS_SCHEMA_VERSION,
      drawings: items,
    });
    expect(parseDoc(raw).length).toBe(MAX_DRAWINGS_PER_SYMBOL);
  });
});

describe('load/save', () => {
  it('round-trips through a storage double, scoped per symbol', () => {
    const st = memStorage();
    saveDrawings(st, 'crypto', 'BTC', [trend('a', 1)]);
    expect(loadDrawings(st, 'crypto', 'BTC').length).toBe(1);
    expect(loadDrawings(st, 'crypto', 'ETH')).toEqual([]); // other symbol unaffected
  });

  it('saving an EMPTY document removes the key (no zombie docs)', () => {
    const st = memStorage();
    saveDrawings(st, 'crypto', 'BTC', [trend('a', 1)]);
    saveDrawings(st, 'crypto', 'BTC', []);
    expect(st.map.has(drawingsKey('crypto', 'BTC'))).toBe(false);
    expect(loadDrawings(st, 'crypto', 'BTC')).toEqual([]);
  });

  it('null storage is a no-op (session-local mode)', () => {
    expect(() => saveDrawings(null, 'm', 's', [trend('a', 1)])).not.toThrow();
    expect(loadDrawings(null, 'm', 's')).toEqual([]);
  });
});
