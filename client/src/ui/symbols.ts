/**
 * Symbol directory helpers (§9 top bar, T12) — pure, so the grouping / filtering
 * / capability-chip logic is unit-tested without the network or the DOM.
 *
 * The server's `GET /api/symbols?q=` already substring-filters; these helpers add
 * the client-side concerns: mapping a wire `market` to a display group (crypto /
 * equity / sim), ordering + partitioning the flat list into groups for the
 * dropdown, deriving the small capability chips each row shows, and flattening the
 * groups back to a linear order for keyboard navigation.
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

const GROUP_ORDER: SymbolGroupKey[] = ['crypto', 'equity', 'sim'];
const GROUP_LABEL: Record<SymbolGroupKey, string> = {
  crypto: 'Crypto',
  equity: 'Equity',
  sim: 'Simulated',
};

/** Map a wire `market` to its display group. Unknown venues fall under crypto. */
export function marketGroup(market: string): SymbolGroupKey {
  const m = market.toLowerCase();
  if (m === 'sim') return 'sim';
  if (m === 'equity' || m === 'stock' || m === 'us-equity') return 'equity';
  // binance-spot / binance-futures / crypto / anything else → crypto.
  return 'crypto';
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
 * Classify a capability chip into a CSS class so the amber honesty style (§7) can
 * apply. Synthetic depth ('SYNTH') and polled tape ('TAPE POLL') get `cap--synth`
 * (amber); real depth tiers get `cap--depth`; other tape chips get `cap--tape`.
 */
export function capabilityChipClass(chip: string): string {
  if (chip === 'SYNTH' || chip === 'TAPE POLL') return 'cap cap--synth';
  if (chip.startsWith('TAPE ')) return 'cap cap--tape';
  if (chip.startsWith('SIDE ')) return 'cap';
  return 'cap cap--depth';
}
