import { describe, expect, it } from 'vitest';

import {
  capabilityChips,
  filterSymbols,
  flattenGroups,
  groupSymbols,
  marketGroup,
  type SymbolEntry,
} from './symbols';

const SIM: SymbolEntry = { market: 'sim', symbol: 'SIM-DEMO', capability: { depth: 'L2', tape: 'tick' } };
const BTC: SymbolEntry = {
  market: 'binance-spot',
  symbol: 'BTCUSDT',
  capability: { depth: 'L2', tape: 'tick' },
  note: 'live in T9',
};
const ETH: SymbolEntry = { market: 'binance-spot', symbol: 'ETHUSDT', capability: { depth: 'L2', tape: 'tick' } };
const AAPL: SymbolEntry = { market: 'equity', symbol: 'AAPL', capability: { depth: 'SYNTH', tape: 'poll' } };

const DIRECTORY = [SIM, BTC, ETH, AAPL];

describe('marketGroup', () => {
  it('maps wire markets to display groups', () => {
    expect(marketGroup('sim')).toBe('sim');
    expect(marketGroup('equity')).toBe('equity');
    expect(marketGroup('binance-spot')).toBe('crypto');
    expect(marketGroup('binance-futures')).toBe('crypto');
    // Unknown venues fall under crypto.
    expect(marketGroup('kraken')).toBe('crypto');
  });
});

describe('filterSymbols', () => {
  it('case-insensitive substring over symbol and market', () => {
    expect(filterSymbols(DIRECTORY, 'btc')).toEqual([BTC]);
    expect(filterSymbols(DIRECTORY, 'USDT')).toEqual([BTC, ETH]);
    expect(filterSymbols(DIRECTORY, 'equity')).toEqual([AAPL]);
    expect(filterSymbols(DIRECTORY, 'zzz')).toEqual([]);
  });

  it('empty query returns a copy of everything', () => {
    const out = filterSymbols(DIRECTORY, '   ');
    expect(out).toEqual(DIRECTORY);
    expect(out).not.toBe(DIRECTORY);
  });
});

describe('groupSymbols', () => {
  it('orders groups crypto → equity → sim and drops empties', () => {
    const groups = groupSymbols(DIRECTORY);
    expect(groups.map((g) => g.key)).toEqual(['crypto', 'equity', 'sim']);
    expect(groups[0].entries).toEqual([BTC, ETH]);
    expect(groups[0].label).toBe('Crypto');
    expect(groups[1].entries).toEqual([AAPL]);
    expect(groups[2].entries).toEqual([SIM]);
  });

  it('omits a group with no members', () => {
    const groups = groupSymbols([BTC, ETH]);
    expect(groups.map((g) => g.key)).toEqual(['crypto']);
  });
});

describe('flattenGroups', () => {
  it('reproduces the linear render order for keyboard nav', () => {
    const flat = flattenGroups(groupSymbols(DIRECTORY));
    expect(flat).toEqual([BTC, ETH, AAPL, SIM]);
  });
});

describe('capabilityChips', () => {
  it('derives honest depth + tape (+ side) chips', () => {
    expect(capabilityChips({ depth: 'L2', tape: 'tick' })).toEqual(['L2', 'TAPE TICK']);
    expect(capabilityChips({ depth: 'SYNTH', tape: 'poll', trade_side: 'inferred' })).toEqual([
      'SYNTH',
      'TAPE POLL',
      'SIDE INFERRED',
    ]);
    expect(capabilityChips({ depth: 'L2', trades: 'full' })).toEqual(['L2', 'TAPE FULL']);
    expect(capabilityChips(null)).toEqual([]);
    expect(capabilityChips({})).toEqual([]);
  });
});
