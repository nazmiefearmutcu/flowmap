/**
 * Versioned localStorage persistence for chart drawings (campaign 3, lane CF —
 * ported from the old branch's drawings/persist.ts, re-anchored to time-ns).
 *
 * Each market:symbol scope gets its own key so switching instruments never
 * bleeds one chart's trendlines onto another:
 *
 *     flowmap.drawings.v1.<market>.<symbol>
 *
 * The stored payload is a {@link DrawingsDoc}: a schema version plus the
 * drawing list. Anchors' `tNs` is a bigint and JSON has no bigint, so it
 * travels as a decimal string and parses back exactly (epoch ns exceed 2^53 —
 * a number would corrupt them).
 *
 * Corruption policy (mirrors ui/settings.ts). Reading is total and never
 * throws: null / empty / garbage JSON — or a document whose `version` differs
 * from {@link DRAWINGS_SCHEMA_VERSION} — yields an empty list. Future versions
 * are rejected WHOLESALE, never half-parsed: a newer writer's fields may move
 * or reinterpret anything, so honouring part of such a payload would silently
 * corrupt the user's work. Within a current-version document, each entry is
 * validated (known tool; id / tool / points / createdAt / style present and
 * well-typed; exact anchor arity for the tool; finite price; integral tNs) and
 * invalid entries are dropped while their valid siblings survive. The
 * per-symbol cap is enforced on load too: only the NEWEST
 * {@link MAX_DRAWINGS_PER_SYMBOL} entries (by createdAt, then array order)
 * survive. Writes are best-effort: quota / security errors are swallowed.
 */

import { drawingBounds } from './model';
import { isDrawingTool, POINTS_PER_TOOL } from './types';
import type { ChartPoint, Drawing, DrawingsDoc } from './types';

/** Current schema version. Bump ONLY with a migration story in parseDoc. */
export const DRAWINGS_SCHEMA_VERSION = 1;

/** Max drawings retained per symbol (contract: bounded 200/symbol). */
export const MAX_DRAWINGS_PER_SYMBOL = 200;

/** Namespaced storage key holding one market:symbol's drawing document. */
export function drawingsKey(market: string, symbol: string): string {
  return `flowmap.drawings.v1.${market}.${symbol}`;
}

/** Serialize a document for storage (field order exactly as given). */
export function serializeDoc(doc: DrawingsDoc): string {
  return JSON.stringify(doc, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
}

/**
 * Parse a stored document. TOTAL: never throws, never returns malformed
 * drawings — unknown shapes are dropped entry-wise, not fatal.
 */
export function parseDoc(raw: string | null): Drawing[] {
  if (raw === null || raw === '') return [];
  let doc: unknown;
  try {
    doc = JSON.parse(raw, (_k, v: unknown) => {
      // Revive the tNs decimal strings back to exact bigints. Only a string of
      // digits revives — anything else is left alone and validated downstream.
      if (typeof v === 'string' && /^-?\d+$/.test(v) && v.length > 12) {
        try {
          return BigInt(v);
        } catch {
          return v;
        }
      }
      return v;
    });
  } catch {
    return [];
  }
  if (typeof doc !== 'object' || doc === null) return [];
  const rec = doc as Record<string, unknown>;
  if (rec.version !== DRAWINGS_SCHEMA_VERSION) return []; // past AND future: wholesale reject
  if (!Array.isArray(rec.drawings)) return [];
  const out: Drawing[] = [];
  for (const entry of rec.drawings) {
    const d = coerceDrawing(entry);
    if (d !== null) out.push(d);
  }
  return capDrawings(out);
}

/** Keep the newest `MAX_DRAWINGS_PER_SYMBOL` drawings (createdAt, then order). */
export function capDrawings(items: Drawing[]): Drawing[] {
  if (items.length <= MAX_DRAWINGS_PER_SYMBOL) return items;
  const indexed = items.map((d, i) => ({ d, i }));
  indexed.sort((a, b) => a.d.createdAt - b.d.createdAt || a.i - b.i);
  // Newest (last of the ascending sort) survive; paint order is restored.
  const keep = indexed.slice(indexed.length - MAX_DRAWINGS_PER_SYMBOL);
  keep.sort((a, b) => a.i - b.i);
  return keep.map((x) => x.d);
}

/** Structural guard: a plain object (not null, not an array). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A finite number (no NaN/Infinity, no stringly-typed coercion). */
function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A bigint, or an integral number/string that converts to one exactly. */
function coerceTNs(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    try {
      return BigInt(v);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Read data-space anchors, or null if any anchor is malformed: every point
 * must be an object whose tNs is integral and whose price is finite.
 */
function readPoints(raw: unknown[], arity: number): ChartPoint[] | null {
  if (raw.length !== arity) return null;
  const out: ChartPoint[] = [];
  for (const p of raw) {
    if (!isRecord(p)) return null;
    const tNs = coerceTNs(p.tNs);
    if (tNs === null) return null;
    if (!isFiniteNum(p.price)) return null;
    out.push({ tNs, price: p.price });
  }
  return out;
}

/** Validated style, or null when the payload is malformed. */
function readStyle(raw: unknown): { color: string; width: number } | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.color !== 'string' || raw.color === '' || raw.color.length > 32) return null;
  if (!isFiniteNum(raw.width) || raw.width <= 0 || raw.width > 32) return null;
  return { color: raw.color, width: raw.width };
}

/** One validated drawing, or null when the entry is malformed (drop, don't throw). */
function coerceDrawing(entry: unknown): Drawing | null {
  if (!isRecord(entry)) return null;
  if (typeof entry.id !== 'string' || entry.id === '' || entry.id.length > 64) return null;
  if (!isDrawingTool(entry.tool)) return null;
  if (!isFiniteNum(entry.createdAt)) return null;
  const style = readStyle(entry.style);
  if (style === null) return null;
  if (!Array.isArray(entry.points)) return null;
  const points = readPoints(entry.points, POINTS_PER_TOOL[entry.tool]);
  if (points === null) return null;
  const base = { id: entry.id, createdAt: entry.createdAt, style };
  switch (entry.tool) {
    case 'hline':
    case 'hray':
      return { ...base, tool: entry.tool, points: [points[0]] };
    case 'trendline':
    case 'rect':
    case 'fib':
      return { ...base, tool: entry.tool, points: [points[0], points[1]] };
    case 'text': {
      if (typeof entry.text !== 'string' || entry.text.length > 64) return null;
      return { ...base, tool: 'text', points: [points[0]], text: entry.text };
    }
  }
}

/** Load one scope's drawings (total; malformed storage reads as empty). */
export function loadDrawings(
  storage: StorageLike | null,
  market: string,
  symbol: string,
): Drawing[] {
  if (storage === null) return [];
  try {
    return parseDoc(storage.getItem(drawingsKey(market, symbol)));
  } catch {
    return [];
  }
}

/** Best-effort save of one scope's drawings. */
export function saveDrawings(
  storage: StorageLike | null,
  market: string,
  symbol: string,
  items: Drawing[],
): void {
  if (storage === null) return;
  try {
    const capped = capDrawings(items);
    if (capped.length === 0) {
      storage.removeItem?.(drawingsKey(market, symbol));
      return;
    }
    storage.setItem(
      drawingsKey(market, symbol),
      serializeDoc({ version: DRAWINGS_SCHEMA_VERSION, drawings: capped }),
    );
  } catch {
    /* quota / security errors — persistence is best-effort, the session keeps working */
  }
}

/** Minimal Web-Storage subset (mirrors ui/settings.ts / alertsStore). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** Re-export so callers computing visual bounds need no second import. */
export { drawingBounds };
