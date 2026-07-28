/**
 * Symbol directory helpers (§9 top bar, T12) — pure, so the grouping / filtering
 * / capability-chip logic is unit-tested without the network or the DOM.
 *
 * The server's `GET /api/symbols?q=` already substring-filters; these helpers add
 * the client-side concerns: mapping a wire `market` to a display group (crypto /
 * equity / sim), ordering + partitioning the flat list into groups for the
 * dropdown, deriving the small capability chips each row shows, and flattening the
 * groups back to a linear order for keyboard navigation.
 *
 * The venue half of this module (`VenueInfo` → `venueOptions`) backs the picker's
 * venue selector. `GET /api/venues` reports ~106 venues; a market string is a
 * venue `id` or `id + "-" + segment` (no venue id contains a `-`, so a single
 * partition parses it). The catalog is ALSO the grouping authority: once it has
 * been fetched, `marketGroup` answers from the server's `assetClass` instead of
 * guessing, and the old string heuristic survives only as the pre-fetch fallback.
 */

export interface SymbolEntry {
  market: string;
  symbol: string;
  capability: Record<string, unknown>;
  note?: string;
}

export type SymbolGroupKey = 'crypto' | 'equity' | 'sim';

export interface SymbolGroup {
  key: SymbolGroupKey;
  label: string;
  entries: SymbolEntry[];
}

/** One venue as `GET /api/venues` reports it. */
export interface VenueInfo {
  /** Venue id: an exchange (`kraken`), or `equity` / `sim`. Never contains `-`. */
  id: string;
  /** `crypto` | `equity` | `sim` — the grouping authority once fetched. */
  assetClass: string;
  /** `L2` for a native connector, `L2-snapshot` for a ccxt-polled book. */
  depth: string;
  /** True when a hand-written connector streams true incremental book diffs. */
  native: boolean;
  /** Sub-markets that suffix the id (`binance` → spot/usdm/coinm); usually empty. */
  segments: string[];
}

/** One row of the picker's venue list — a selectable scope plus how to badge it. */
export interface VenueOption {
  /** The wire `market` to enumerate, or `all` for the bundled cross-venue directory. */
  market: string;
  label: string;
  group: SymbolGroupKey | 'all';
  /** Depth tier to badge, or `''` when the honest tier is per-symbol (see `venueOptions`). */
  depth: string;
  native: boolean;
}

/** The scope that serves the bundled, instant `market=all` directory. */
export const ALL_VENUES = 'all';

const GROUP_ORDER: SymbolGroupKey[] = ['crypto', 'equity', 'sim'];
const GROUP_LABEL: Record<SymbolGroupKey, string> = {
  crypto: 'Crypto',
  equity: 'Equity',
  sim: 'Simulated',
};

/** Short group labels for the top bar's venue chip (the long form says 'Simulated'). */
const VENUE_GROUP_LABEL: Record<SymbolGroupKey, string> = {
  crypto: 'Crypto',
  equity: 'Equity',
  sim: 'Sim',
};

// --- venue catalog registry -------------------------------------------------
// A plain module-level cache rather than a subscribable store: every consumer
// (top bar, palette rows) re-renders on its own cadence, and the fallback
// heuristic below already agrees with the catalog for every venue this build
// ships — so a pre-fetch frame cannot show a group the catalog would contradict.
let venueGroups: ReadonlyMap<string, SymbolGroupKey> = new Map();
let venueCatalog: readonly VenueInfo[] = [];

/** Narrow a wire `assetClass` to a display group, or null when it is unknown. */
export function venueAssetGroup(assetClass: string | undefined): SymbolGroupKey | null {
  if (assetClass === 'crypto' || assetClass === 'equity' || assetClass === 'sim') return assetClass;
  return null;
}

/** Install the `/api/venues` payload as the grouping authority. */
export function setVenueCatalog(venues: readonly VenueInfo[]): void {
  const groups = new Map<string, SymbolGroupKey>();
  for (const v of venues) {
    const key = venueAssetGroup(v?.assetClass);
    // An unrecognised assetClass is left OUT rather than coerced, so such a venue
    // keeps falling through to the heuristic instead of being mislabelled.
    if (key && typeof v.id === 'string' && v.id !== '') groups.set(v.id.toLowerCase(), key);
  }
  venueGroups = groups;
  venueCatalog = venues;
}

/** The installed catalog (empty before `/api/venues` resolves). */
export function getVenueCatalog(): readonly VenueInfo[] {
  return venueCatalog;
}

/** Drop the catalog — the pre-fetch state. Exists for tests and for a failed reload. */
export function resetVenueCatalog(): void {
  venueGroups = new Map();
  venueCatalog = [];
}

/** The exchange half of a market string: `binance-usdm` → `binance`, `okx` → `okx`. */
export function marketVenueId(market: string): string {
  const dash = market.indexOf('-');
  return (dash < 0 ? market : market.slice(0, dash)).toLowerCase();
}

/**
 * Map a wire `market` to its display group — from the fetched `/api/venues`
 * `assetClass` when we have it, else from the legacy string heuristic (which
 * defaults ~104 crypto venue ids to crypto, right but blind).
 */
export function marketGroup(market: string): SymbolGroupKey {
  const m = market.toLowerCase();
  const known = venueGroups.get(marketVenueId(m));
  if (known) return known;
  if (m === 'sim') return 'sim';
  if (m === 'equity' || m === 'stock' || m === 'us-equity') return 'equity';
  // binance-spot / binance-futures / crypto / anything else → crypto.
  return 'crypto';
}

/**
 * The top bar's venue text. Crypto shows the market string itself (`kraken`,
 * `binance-usdm`) — with ~104 venues, "Crypto" alone no longer identifies
 * anything — while equity / sim keep their group word, which IS their venue.
 */
export function venueLabel(market: string): string {
  const group = marketGroup(market);
  return group === 'crypto' ? market : VENUE_GROUP_LABEL[group];
}

/** Every market string a venue can be subscribed as (one per segment, else the bare id). */
export function venueMarkets(venue: VenueInfo): string[] {
  const segments = Array.isArray(venue.segments) ? venue.segments : [];
  return segments.length > 0 ? segments.map((s) => `${venue.id}-${s}`) : [venue.id];
}

/**
 * Flatten the catalog into the picker's venue list: the bundled `all` scope
 * first, then the native venues (true incremental books — including equity and
 * sim), then the ccxt-served rest, each preserving catalog order.
 *
 * The depth badge is carried VERBATIM off the catalog for every venue, because
 * the server reports each venue's real tier rather than deriving it from
 * `native` — so equity reads `SYNTH`, a ccxt venue reads `L2-snapshot`, and only
 * a venue that truly streams diffs reads `L2`. The bundled `all` scope spans
 * every tier at once, so it honestly carries none.
 */
export function venueOptions(venues: readonly VenueInfo[]): VenueOption[] {
  const native: VenueOption[] = [];
  const served: VenueOption[] = [];
  for (const v of venues) {
    if (typeof v?.id !== 'string' || v.id === '') continue;
    const group = venueAssetGroup(v.assetClass) ?? marketGroup(v.id);
    const depth = typeof v.depth === 'string' ? v.depth : '';
    for (const market of venueMarkets(v)) {
      (v.native ? native : served).push({ market, label: market, group, depth, native: !!v.native });
    }
  }
  return [
    { market: ALL_VENUES, label: 'All markets', group: 'all', depth: '', native: true },
    ...native,
    ...served,
  ];
}

/**
 * Fuzzy-rank venue options by the query, best first. Ranks on the market string
 * (what the user types) and falls back to the label, so `usdm` finds
 * `binance-usdm` and `all` finds the bundled scope. Empty query keeps the
 * curated order above.
 */
export function rankVenueOptions(
  options: readonly VenueOption[],
  q: string,
  limit = 300,
): VenueOption[] {
  if (q.trim() === '') return options.slice(0, limit);
  const scored: Array<{ option: VenueOption; score: number }> = [];
  for (const option of options) {
    const score = Math.max(fuzzyScore(q, option.market), fuzzyScore(q, option.label) - 20);
    if (score >= 0) scored.push({ option, score });
  }
  scored.sort((a, b) => b.score - a.score || a.option.market.length - b.option.market.length);
  return scored.slice(0, limit).map((r) => r.option);
}

/**
 * Case-insensitive substring filter over symbol AND market (defensive dedupe of
 * the server filter), plus the derived display group key/label so typing
 * 'crypto' / 'equity' / 'sim' (or 'Simulated') surfaces the whole group.
 */
export function filterSymbols(entries: readonly SymbolEntry[], q: string): SymbolEntry[] {
  const needle = q.trim().toLowerCase();
  if (needle === '') return [...entries];
  return entries.filter((e) => {
    if (e.symbol.toLowerCase().includes(needle) || e.market.toLowerCase().includes(needle)) return true;
    const key = marketGroup(e.market);
    return key.includes(needle) || GROUP_LABEL[key].toLowerCase().includes(needle);
  });
}

/** Partition entries into ordered, non-empty display groups. Order within a group is preserved. */
export function groupSymbols(entries: readonly SymbolEntry[]): SymbolGroup[] {
  const buckets = new Map<SymbolGroupKey, SymbolEntry[]>();
  for (const e of entries) {
    const key = marketGroup(e.market);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(e);
    else buckets.set(key, [e]);
  }
  const out: SymbolGroup[] = [];
  for (const key of GROUP_ORDER) {
    const bucket = buckets.get(key);
    if (bucket && bucket.length > 0) {
      out.push({ key, label: GROUP_LABEL[key], entries: bucket });
    }
  }
  return out;
}

/** Flatten grouped entries back into the linear order the dropdown renders (for keyboard nav). */
export function flattenGroups(groups: readonly SymbolGroup[]): SymbolEntry[] {
  return groups.flatMap((g) => g.entries);
}

/**
 * Fuzzy score of `query` against `text` (higher = better; -1 = no match). Tiers,
 * highest first: exact → prefix → substring → scattered subsequence. Within the
 * subsequence tier, contiguous runs and a start-of-string hit are rewarded, and
 * shorter texts win ties — so "BT" ranks BTCUSDT above a coincidental match in a
 * longer ticker. This is the ranking the substring-only server filter lacked.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (q === '') return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - t.length;
  const sub = t.indexOf(q);
  if (sub >= 0) return 600 - sub - t.length * 0.1;
  let qi = 0;
  let score = 0;
  let run = 0;
  let prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      run = ti === prev + 1 ? run + 1 : 1;
      score += run;
      if (ti === 0) score += 5;
      prev = ti;
      qi += 1;
    }
  }
  if (qi < q.length) return -1; // not every query char was consumed → no match
  return 100 + score - t.length * 0.1;
}

/**
 * Fuzzy-rank a directory by the query, best first. A match on the SYMBOL ranks
 * above a match on the market/venue. Empty query returns the input order (capped).
 */
export function fuzzyRank(entries: readonly SymbolEntry[], q: string, limit = 60): SymbolEntry[] {
  if (q.trim() === '') return entries.slice(0, limit);
  const scored: Array<{ entry: SymbolEntry; score: number }> = [];
  for (const e of entries) {
    const s = Math.max(fuzzyScore(q, e.symbol), fuzzyScore(q, e.market) - 60);
    if (s >= 0) scored.push({ entry: e, score: s });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.symbol.length - b.entry.symbol.length);
  return scored.slice(0, limit).map((r) => r.entry);
}

/**
 * Small capability chips for a directory row / the top bar. Honest (§7): shows the
 * real depth + tape tiers straight off the capability descriptor, uppercased.
 */
export function capabilityChips(capability: Record<string, unknown> | null | undefined): string[] {
  if (!capability) return [];
  const chips: string[] = [];
  const depth = capability.depth;
  if (typeof depth === 'string') chips.push(depth.toUpperCase());
  const tape = capability.tape ?? capability.trades;
  if (typeof tape === 'string') chips.push(`TAPE ${tape.toUpperCase()}`);
  const side = capability.trade_side;
  if (typeof side === 'string') chips.push(`SIDE ${side.toUpperCase()}`);
  return chips;
}

/**
 * THE capability-chip classifier (§7 honesty). One function, every surface — the
 * top bar and the symbol palette must make the same fidelity claim about the same
 * string, or the app contradicts itself depending on where you look.
 *
 * Four tiers, and every reachable chip string lands in exactly one:
 *
 * - `cap--depth`            REAL, streamed venue depth: `L2` (native crypto /
 *                           sim), `L1` (Alpaca top-of-book — real quotes, fewer
 *                           of them; the CHIP TEXT carries that distinction).
 * - `cap--depth cap--caution`  REAL but lower fidelity: `L2-SNAPSHOT`, a ccxt
 *                           book re-read whole each tick instead of diffed. A
 *                           ccxt venue must never look like a native L2 feed —
 *                           and it is not fabricated data either.
 * - `cap--synth`            FABRICATED: `SYNTH` / `SYNTH_PROFILE`, equity depth
 *                           reconstructed from a price+volume print. Two
 *                           spellings of one thing (server core/session.py keeps
 *                           `SYNTH_PROFILE` for compatibility), so they MUST
 *                           classify identically.
 * - `cap--na`               NO CLAIM: `N/A` — the finnhub equity tier ships no
 *                           book at all (server feeds/equity.py) — and
 *                           `UNKNOWN`, the fallback `data/venues.py::_feed_depth`
 *                           emits for a feed that states no depth. "Nothing" and
 *                           "we don't know" may not borrow the accent that means
 *                           "a real order book".
 *
 * Tape and side chips follow the same real / real-but-lagging / absent shape:
 * polled tape is the venue's OWN prints on a timer (caution, not fabricated), and
 * an inferred or missing aggressor side is a caution step-down on a bare chip.
 */
export function capabilityChipClass(chip: string): string {
  if (chip.startsWith('TAPE')) {
    return chip.includes('POLL') ? 'cap cap--tape cap--caution' : 'cap cap--tape';
  }
  if (chip.startsWith('SIDE')) {
    return chip.includes('INFERRED') || chip.includes('NA') ? 'cap cap--caution' : 'cap';
  }
  // --- depth chips ---
  if (chip.startsWith('SYNTH')) return 'cap cap--synth';
  if (isNoClaimTier(chip)) return 'cap cap--na';
  if (chip.includes('SNAPSHOT')) return 'cap cap--depth cap--caution';
  return 'cap cap--depth';
}

/**
 * Depth strings that assert NO fidelity: `N/A` (the tier ships no book) and
 * `UNKNOWN` (the server could not read a depth off the feed). Neither may fall
 * through to the real-depth accent — falling through is the overclaim.
 */
function isNoClaimTier(chip: string): boolean {
  return chip === 'N/A' || chip === 'NA' || chip === 'NONE' || chip === 'UNKNOWN' || chip === '';
}

/** Hover text spelling out what a lower-fidelity chip actually means, or undefined. */
export function capabilityChipTitle(chip: string): string | undefined {
  if (chip.startsWith('TAPE')) {
    return chip.includes('POLL')
      ? 'polled tape — real venue prints, but re-read on a timer rather than streamed, so bursts arrive coalesced'
      : undefined;
  }
  if (chip.startsWith('SIDE')) {
    if (chip.includes('INFERRED')) {
      return 'inferred aggressor side — derived from the quote/tick rule, not reported by the venue';
    }
    if (chip.includes('NA')) {
      return 'no aggressor side — this tier cannot say who lifted whom, so CVD is not computed';
    }
    return undefined;
  }
  if (chip.startsWith('SYNTH')) return 'synthetic depth — reconstructed, not a real order book';
  if (chip === 'UNKNOWN') {
    return 'no depth tier reported — the feed states none, so make no assumption about what the book here is';
  }
  if (isNoClaimTier(chip)) {
    return 'no depth at all — this tier ships no order book, so the heatmap has nothing but the tape to draw from';
  }
  if (chip.includes('SNAPSHOT')) {
    return 'snapshot depth — the whole book is re-read each tick (ccxt polling), not streamed as incremental venue diffs';
  }
  if (chip === 'L1') {
    return 'top of book only — the real best bid/ask, extruded into a band; there is no depth ladder behind it';
  }
  return undefined;
}
