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

/** Case-insensitive substring filter over symbol AND market (defensive dedupe of the server filter). */
export function filterSymbols(entries: readonly SymbolEntry[], q: string): SymbolEntry[] {
  const needle = q.trim().toLowerCase();
  if (needle === '') return [...entries];
  return entries.filter(
    (e) => e.symbol.toLowerCase().includes(needle) || e.market.toLowerCase().includes(needle),
  );
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
