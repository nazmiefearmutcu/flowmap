import { afterEach, describe, expect, it } from 'vitest';

import {
  ALL_VENUES,
  capabilityChipClass,
  capabilityChipTitle,
  capabilityChips,
  filterSymbols,
  flattenGroups,
  fuzzyRank,
  fuzzyScore,
  getVenueCatalog,
  groupSymbols,
  marketGroup,
  marketVenueId,
  rankVenueOptions,
  resetVenueCatalog,
  setVenueCatalog,
  venueLabel,
  venueMarkets,
  venueOptions,
  type SymbolEntry,
  type VenueInfo,
} from './symbols';

// The venue catalog is module state (see symbols.ts); every test starts pre-fetch.
afterEach(() => resetVenueCatalog());

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

// Shapes mirror a live GET /api/venues: the server reports each venue's REAL
// depth tier, so equity says SYNTH even though it is a native (non-ccxt) feed.
const CATALOG: VenueInfo[] = [
  { id: 'sim', assetClass: 'sim', depth: 'L2', native: true, segments: [] },
  { id: 'equity', assetClass: 'equity', depth: 'SYNTH', native: true, segments: [] },
  { id: 'binance', assetClass: 'crypto', depth: 'L2', native: true, segments: ['spot', 'usdm', 'coinm'] },
  { id: 'kraken', assetClass: 'crypto', depth: 'L2-snapshot', native: false, segments: [] },
  { id: 'gateio', assetClass: 'crypto', depth: 'L2-snapshot', native: false, segments: [] },
];

describe('marketGroup', () => {
  it('maps wire markets to display groups from the pre-fetch heuristic', () => {
    expect(marketGroup('sim')).toBe('sim');
    expect(marketGroup('equity')).toBe('equity');
    expect(marketGroup('binance-spot')).toBe('crypto');
    expect(marketGroup('binance-futures')).toBe('crypto');
    // Unknown venues fall under crypto.
    expect(marketGroup('kraken')).toBe('crypto');
  });

  it('answers from the /api/venues assetClass once the catalog is installed', () => {
    setVenueCatalog([
      // A venue the heuristic would have blindly called crypto.
      { id: 'nasdaq', assetClass: 'equity', depth: 'L2', native: false, segments: [] },
      { id: 'kraken', assetClass: 'crypto', depth: 'L2-snapshot', native: false, segments: [] },
    ]);
    expect(marketGroup('nasdaq')).toBe('equity');
    expect(marketGroup('kraken')).toBe('crypto');
    // The lookup is on the venue id, so a segmented market string still resolves.
    setVenueCatalog(CATALOG);
    expect(marketGroup('binance-usdm')).toBe('crypto');
    expect(marketGroup('BINANCE-USDM')).toBe('crypto');
  });

  it('falls back to the heuristic for a venue the catalog does not name', () => {
    setVenueCatalog(CATALOG);
    expect(marketGroup('mexc')).toBe('crypto');
    expect(marketGroup('us-equity')).toBe('equity');
  });

  it('ignores an unrecognised assetClass rather than coercing it', () => {
    setVenueCatalog([{ id: 'weird', assetClass: 'futures', depth: 'L2', native: false, segments: [] }]);
    // Not silently bucketed as 'futures'; it falls through to the heuristic.
    expect(marketGroup('weird')).toBe('crypto');
    expect(getVenueCatalog()).toHaveLength(1);
  });
});

describe('marketVenueId', () => {
  it('splits a market string on the FIRST dash only (no venue id contains one)', () => {
    expect(marketVenueId('binance-usdm')).toBe('binance');
    expect(marketVenueId('kraken')).toBe('kraken');
    expect(marketVenueId('OKX')).toBe('okx');
    expect(marketVenueId('base_onchain')).toBe('base_onchain');
  });
});

describe('venueLabel — the top bar names the venue, not the asset class', () => {
  it('shows the market string for crypto and the group word otherwise', () => {
    expect(venueLabel('kraken')).toBe('kraken');
    expect(venueLabel('binance-usdm')).toBe('binance-usdm');
    expect(venueLabel('equity')).toBe('Equity');
    expect(venueLabel('sim')).toBe('Sim');
  });
});

describe('venueMarkets', () => {
  it('expands segments into market strings, else keeps the bare id', () => {
    expect(venueMarkets(CATALOG[2])).toEqual(['binance-spot', 'binance-usdm', 'binance-coinm']);
    expect(venueMarkets(CATALOG[3])).toEqual(['kraken']);
    // A payload missing `segments` must not throw.
    expect(venueMarkets({ id: 'okx', assetClass: 'crypto', depth: 'L2', native: true } as VenueInfo)).toEqual(['okx']);
  });
});

describe('venueOptions', () => {
  it('puts the bundled scope first, then native venues, then the ccxt-served rest', () => {
    const opts = venueOptions(CATALOG);
    expect(opts[0].market).toBe(ALL_VENUES);
    expect(opts.map((o) => o.market)).toEqual([
      'all',
      'sim',
      'equity',
      'binance-spot',
      'binance-usdm',
      'binance-coinm',
      'kraken',
      'gateio',
    ]);
  });

  it('carries each venue’s real depth tier verbatim, never derived from `native`', () => {
    const byMarket = new Map(venueOptions(CATALOG).map((o) => [o.market, o]));
    expect(byMarket.get('binance-usdm')!.depth).toBe('L2');
    expect(byMarket.get('kraken')!.depth).toBe('L2-snapshot');
    // equity is native:true yet only reaches synthetic depth — the badge must
    // follow the server's tier, not the native flag.
    expect(byMarket.get('equity')!.depth).toBe('SYNTH');
    expect(byMarket.get('equity')!.native).toBe(true);
    expect(byMarket.get('sim')!.depth).toBe('L2');
    // The bundled scope spans every tier at once, so it claims none.
    expect(byMarket.get(ALL_VENUES)!.depth).toBe('');
  });

  it('groups each option so the row badge matches the asset class', () => {
    const byMarket = new Map(venueOptions(CATALOG).map((o) => [o.market, o]));
    expect(byMarket.get('equity')!.group).toBe('equity');
    expect(byMarket.get('sim')!.group).toBe('sim');
    expect(byMarket.get('kraken')!.group).toBe('crypto');
    expect(byMarket.get(ALL_VENUES)!.group).toBe('all');
  });

  it('tolerates an empty catalog — the bundled scope is always selectable', () => {
    expect(venueOptions([]).map((o) => o.market)).toEqual([ALL_VENUES]);
  });
});

describe('rankVenueOptions', () => {
  const opts = venueOptions(CATALOG);

  it('keeps the curated order on an empty query', () => {
    expect(rankVenueOptions(opts, '  ').map((o) => o.market)).toEqual(opts.map((o) => o.market));
  });

  it('finds a segment market by its suffix and drops non-matches', () => {
    expect(rankVenueOptions(opts, 'usdm').map((o) => o.market)).toEqual(['binance-usdm']);
    expect(rankVenueOptions(opts, 'krak')[0].market).toBe('kraken');
    expect(rankVenueOptions(opts, 'zzzz')).toEqual([]);
  });

  it('ranks an exact venue id above a longer market string containing it', () => {
    const ranked = rankVenueOptions(opts, 'binance');
    expect(ranked[0].market).toBe('binance-spot');
    expect(ranked.map((o) => o.market)).toContain('binance-coinm');
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

  it('matches the derived display group key/label so a group name surfaces the whole group', () => {
    // No market string contains 'crypto' (binance-spot), but the group does.
    expect(filterSymbols(DIRECTORY, 'crypto')).toEqual([BTC, ETH]);
    // Group label match is case-insensitive.
    expect(filterSymbols(DIRECTORY, 'Simulated')).toEqual([SIM]);
    expect(filterSymbols(DIRECTORY, 'sim')).toEqual([SIM]);
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

  it('carries a ccxt venue’s snapshot depth through verbatim', () => {
    expect(capabilityChips({ depth: 'L2-snapshot', tape: 'tick' })).toEqual(['L2-SNAPSHOT', 'TAPE TICK']);
  });
});

describe('capabilityChipClass', () => {
  // Every depth string the SERVER can actually ship, and the fidelity tier each
  // one is allowed to claim. Table-driven on purpose: a depth string with no row
  // here silently inherits `cap--depth`, which is the overclaim this pins shut.
  //   L2           feeds/crypto.py (native), feeds/sim.py, api/rest.py
  //   L2-snapshot  feeds/crypto.py (ccxt-polled)
  //   SYNTH        feeds/equity.py keyless tier
  //   L1           feeds/equity.py alpaca tier
  //   N/A          feeds/equity.py finnhub tier — NO depth at all
  //   SYNTH_PROFILE  core/session.py legacy equity depth (kept for compat)
  const DEPTH_TIERS: Array<[string, string]> = [
    ['L2', 'cap cap--depth'],
    ['L2-SNAPSHOT', 'cap cap--depth cap--caution'],
    ['L1', 'cap cap--depth'],
    ['SYNTH', 'cap cap--synth'],
    ['SYNTH_PROFILE', 'cap cap--synth'],
    ['N/A', 'cap cap--na'],
    //   UNKNOWN      data/venues.py::_feed_depth fallback for a feed that
    //                states no depth — a SIXTH reachable string the brief's
    //                list of five missed. It asserts nothing, so it may not
    //                inherit the accent that asserts a real order book.
    ['UNKNOWN', 'cap cap--na'],
  ];

  it.each(DEPTH_TIERS)('classifies the %s depth tier as %s', (chip, cls) => {
    expect(capabilityChipClass(chip)).toBe(cls);
  });

  it('gives ABSENT depth its own tier — never the real-depth accent', () => {
    // finnhub ships `depth: 'N/A'`: there is no book at all. Falling through to
    // `cap--depth` would paint "no depth" in the same ink as a native L2 ladder.
    const absent = capabilityChipClass('N/A');
    expect(absent).not.toBe(capabilityChipClass('L2'));
    expect(absent).not.toBe(capabilityChipClass('L1'));
    expect(absent).not.toBe(capabilityChipClass('SYNTH'));
    expect(absent).not.toBe(capabilityChipClass('L2-SNAPSHOT'));
    expect(absent).not.toContain('cap--depth');
  });

  it('keeps SYNTH_PROFILE on the fabricated ramp, exactly like SYNTH', () => {
    // Same fabricated data, two spellings; they must not disagree.
    expect(capabilityChipClass('SYNTH_PROFILE')).toBe(capabilityChipClass('SYNTH'));
  });

  it('treats polled tape as REAL-but-lagging, not fabricated', () => {
    // Polled trades are the venue's own prints, re-read on a timer — a caution
    // step-down on the tape accent, NOT the fabricated-data amber fill.
    expect(capabilityChipClass('TAPE TICK')).toBe('cap cap--tape');
    expect(capabilityChipClass('TAPE FULL')).toBe('cap cap--tape');
    expect(capabilityChipClass('TAPE POLL')).toBe('cap cap--tape cap--caution');
    expect(capabilityChipClass('TAPE POLL')).not.toBe(capabilityChipClass('SYNTH'));
  });

  it('flags inferred / absent trade side with caution, keeps EXCHANGE bare', () => {
    expect(capabilityChipClass('SIDE EXCHANGE')).toBe('cap');
    expect(capabilityChipClass('SIDE INFERRED')).toBe('cap cap--caution');
    expect(capabilityChipClass('SIDE NA')).toBe('cap cap--caution');
  });

  it('separates snapshot depth from BOTH real L2 and fabricated SYNTH', () => {
    const snapshot = capabilityChipClass('L2-SNAPSHOT');
    expect(snapshot).toBe('cap cap--depth cap--caution');
    // The three fidelities must be three distinct classes — a ccxt venue may not
    // look like a native book, and it is not fabricated data either.
    expect(snapshot).not.toBe(capabilityChipClass('L2'));
    expect(snapshot).not.toBe(capabilityChipClass('SYNTH'));
  });
});

describe('capabilityChipTitle', () => {
  it('spells out what snapshot depth and synthetic depth actually mean', () => {
    expect(capabilityChipTitle('L2-SNAPSHOT')).toContain('re-read');
    expect(capabilityChipTitle('SYNTH')).toContain('not a real order book');
    expect(capabilityChipTitle('SYNTH_PROFILE')).toContain('not a real order book');
  });

  it('explains that N/A means no depth at all', () => {
    expect(capabilityChipTitle('N/A')).toContain('no depth');
  });

  it('explains that UNKNOWN is an absence of information, not a tier', () => {
    expect(capabilityChipTitle('UNKNOWN')).toContain('no depth tier reported');
  });

  it('explains that L1 is top-of-book only, not a ladder', () => {
    expect(capabilityChipTitle('L1')).toContain('top of book');
  });

  it('explains the lower-fidelity tape / side tiers', () => {
    expect(capabilityChipTitle('TAPE POLL')).toContain('polled');
    expect(capabilityChipTitle('SIDE INFERRED')).toContain('inferred');
    expect(capabilityChipTitle('SIDE NA')).toContain('no aggressor');
  });

  it('leaves the honest full-fidelity tiers untitled', () => {
    expect(capabilityChipTitle('L2')).toBeUndefined();
    expect(capabilityChipTitle('TAPE TICK')).toBeUndefined();
    expect(capabilityChipTitle('SIDE EXCHANGE')).toBeUndefined();
  });
});

describe('fuzzyScore — tiered ranking', () => {
  it('ranks exact > prefix > substring > subsequence > no-match', () => {
    const exact = fuzzyScore('btc', 'btc');
    const prefix = fuzzyScore('btc', 'btcusdt');
    const sub = fuzzyScore('usd', 'btcusdt');
    const seq = fuzzyScore('bcd', 'btcusdt'); // b..c..d scattered
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(seq);
    expect(seq).toBeGreaterThanOrEqual(0);
    expect(fuzzyScore('xyz', 'btcusdt')).toBe(-1);
  });
  it('empty query matches everything with score 0', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });
});

describe('fuzzyRank — best symbol match first', () => {
  const uni: SymbolEntry[] = [
    { market: 'binance-spot', symbol: 'BTCUSDT', capability: {} },
    { market: 'binance-spot', symbol: 'ETHUSDT', capability: {} },
    { market: 'equity', symbol: 'MSFT', capability: {} },
    { market: 'binance-spot', symbol: 'WBTC', capability: {} },
  ];
  it('puts the prefix match ahead of a mid-string match', () => {
    const r = fuzzyRank(uni, 'btc');
    expect(r[0].symbol).toBe('BTCUSDT'); // prefix beats WBTC's substring
    expect(r.map((e) => e.symbol)).toContain('WBTC');
  });
  it('drops non-matches and respects the limit', () => {
    expect(fuzzyRank(uni, 'zzz')).toEqual([]);
    expect(fuzzyRank(uni, '', 2).length).toBe(2);
  });
});
