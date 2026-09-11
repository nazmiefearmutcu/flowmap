/**
 * Time-bucketed OHLCV candle synthesis from the trade stream (campaign 3, lane CG).
 *
 * A pure, framework-free builder: trades go in one at a time, candles come out.
 * It is the price-structure source for the indicator kernels (indicators/) — the
 * depth heatmap shows resting liquidity, but SMA/RSI/MACD-class studies need
 * candles, and this feed's honest way to get them is to aggregate the tape.
 *
 * Semantics (all pinned by synth.test.ts):
 *  - Bucket = `floor(ts_ns / timeframe)`; each trade merges into its bucket:
 *    `o` = first merged price, `h`/`l` = extremes, `c` = price of the LATEST
 *    trade by `ts_ns` (ties: latest arrival), `v` = Σ size, `trades` = count.
 *  - OUT-OF-ORDER trades (a straggler with an older ts) merge into their own
 *    older bucket whenever it is still resident; `c` only moves for trades at
 *    or after that bucket's last seen ts, so a late trade never overwrites a
 *    newer close with an older price.
 *  - DUPLICATES are suppressed idempotently: an exact `(ts, price, size)`
 *    repeat within the last {@link DUP_WINDOW} merged trades is dropped (this
 *    is what a WS re-delivery / reconnect overlap looks like). The window is
 *    honest about its reach: a burst replay of MORE than DUP_WINDOW trades
 *    would double-count volume, but that is a full session replay — a
 *    reset-for-new-session scenario, not a push-stream one.
 *  - Bounded ring ({@link DEFAULT_RING} buckets, drop-oldest): a trade older
 *    than the oldest resident bucket is counted in `droppedLate` and ignored.
 *  - Non-finite price/size or a negative ts is quarantined (`nonFinite`) —
 *    corrupt wire data must not poison a candle.
 *
 * Per-push cost is O(DUP_WINDOW) for the dedup scan (a 64-entry linear probe
 * over flat arrays — no allocation) plus O(1) merge work; nothing recomputes
 * over history. Bucket identity uses bigint math (`ts / tf`) so ns-scale
 * timestamps never lose precision.
 */

/** One synthesized OHLCV candle. All fields are plain numbers except the times. */
export interface Candle {
  /** Bucket index (`floor(ts / timeframe)`) — the monotonic candle id. */
  bi: number;
  /** Bucket start time in ns (`bi * timeframe`). */
  t0Ns: bigint;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Accumulated trade size (base units, not quote). */
  v: number;
  /** Merged (dup-suppressed) trade count — a liquidity/participation proxy. */
  trades: number;
  /** ts of the latest trade merged into this bucket (close authority). */
  lastTsNs: bigint;
}

/** Default candle ring — 2000 buckets ≈ 33 h of 1-minute candles. */
export const DEFAULT_RING = 2000;
/** Exact-duplicate suppression window (merged-trade recency). */
export const DUP_WINDOW = 64;

export interface SynthStats {
  /** Trades merged into candles. */
  merged: number;
  /** Exact duplicates within the recency window (skipped). */
  dupSkipped: number;
  /** Trades older than the oldest resident bucket (skipped). */
  droppedLate: number;
  /** Non-finite price/size or negative ts (quarantined). */
  nonFinite: number;
}

export interface CandleSynth {
  /** Current timeframe in ns per bucket. */
  readonly timeframeNs: number;
  /** Merge one trade. Quarantines/dedupes/late-drops per the module contract. */
  push(tsNs: bigint, price: number, size: number): void;
  /** Oldest-first snapshot of the resident candles (one array per call). */
  candles(): Candle[];
  /** Number of resident buckets. */
  count(): number;
  /** Monotonic mutation counter — cheap "did anything change" for repaint loops. */
  version(): number;
  /** Lifetime counters (not reset by {@link reset}). */
  stats(): SynthStats;
  /** Change the bucket size. A different timeframe resets the ring (incompatible buckets). */
  setTimeframe(ns: number): void;
  /** Drop every candle (session switch). Counters survive; version bumps. */
  reset(): void;
}

/** Validate a timeframe: a finite number ≥ 1 ns. */
function validTf(ns: number): number {
  if (!Number.isFinite(ns) || ns < 1) {
    throw new RangeError(`timeframe must be a finite number >= 1ns, got ${ns}`);
  }
  return ns;
}

/** Create a streaming candle builder for one timeframe. */
export function createCandleSynth(timeframeNs: number, ring: number = DEFAULT_RING): CandleSynth {
  if (!Number.isInteger(ring) || ring < 1) {
    throw new RangeError(`ring must be an integer >= 1, got ${ring}`);
  }
  let tf = validTf(timeframeNs);
  const tfBig = () => BigInt(Math.round(tf));

  const slots: (Candle | undefined)[] = new Array(ring);
  let firstBi: bigint | null = null; // bucket index of the oldest resident candle
  let lastBi: bigint | null = null; // bucket index of the newest candle seen
  let ver = 0;

  // Dedup ring of recent merged-trade signatures (flat arrays, no allocation).
  const dupTs = new BigInt64Array(DUP_WINDOW);
  const dupPx = new Float64Array(DUP_WINDOW);
  const dupSz = new Float64Array(DUP_WINDOW);
  let dupHead = 0;
  let dupCount = 0;

  const stats: SynthStats = { merged: 0, dupSkipped: 0, droppedLate: 0, nonFinite: 0 };

  function clearRing(): void {
    slots.fill(undefined);
    firstBi = null;
    lastBi = null;
  }

  return {
    get timeframeNs(): number {
      return tf;
    },

    push(tsNs, price, size) {
      if (
        !Number.isFinite(price) ||
        !Number.isFinite(size) ||
        typeof tsNs !== 'bigint' ||
        tsNs < 0n
      ) {
        stats.nonFinite += 1;
        return;
      }
      // --- exact-duplicate suppression (idempotent re-delivery) --------------
      const checkN = Math.min(dupCount, DUP_WINDOW);
      let idx = dupHead === 0 ? DUP_WINDOW - 1 : dupHead - 1; // newest → oldest
      for (let i = 0; i < checkN; i += 1) {
        if (dupTs[idx] === tsNs && dupPx[idx] === price && dupSz[idx] === size) {
          stats.dupSkipped += 1;
          return;
        }
        idx = idx === 0 ? DUP_WINDOW - 1 : idx - 1;
      }

      const bi = tsNs / tfBig();

      if (firstBi === null) {
        firstBi = bi;
      } else if (bi < firstBi) {
        // Older than the oldest resident bucket — the candle it belongs to has
        // already been evicted (its slot may have been recycled by a newer
        // bucket); merging would resurrect a stale candle and lose the head.
        stats.droppedLate += 1;
        return;
      }

      if (lastBi === null || bi > lastBi) lastBi = bi;
      // Advance the resident window: a bucket whose slot this push just (or is
      // about to) recycled is no longer resident. Keeps span ≤ ring so the
      // snapshot walk and the late-trade test both stay O(ring) and correct.
      if (lastBi - firstBi >= BigInt(ring)) firstBi = lastBi - BigInt(ring - 1);

      const slot = Number(bi % BigInt(ring));
      const cur = slots[slot];
      if (cur === undefined || cur.bi !== Number(bi)) {
        // NOTE bi fits a double exactly while < 2^53 buckets; a 1ns timeframe
        // for 2^53 ns ≈ 104 days is far outside a session's life. Guarded below.
        const biNum = Number(bi);
        if (!Number.isSafeInteger(biNum)) {
          stats.droppedLate += 1;
          return;
        }
        slots[slot] = {
          bi: biNum,
          t0Ns: bi * tfBig(),
          o: price,
          h: price,
          l: price,
          c: price,
          v: size,
          trades: 1,
          lastTsNs: tsNs,
        };
      } else {
        cur.h = cur.h < price ? price : cur.h;
        cur.l = cur.l > price ? price : cur.l;
        cur.v += size;
        cur.trades += 1;
        if (tsNs >= cur.lastTsNs) {
          cur.c = price;
          cur.lastTsNs = tsNs;
        }
      }

      // Record the signature AFTER a successful merge (a dropped trade was not
      // merged, so its re-delivery should be free to merge then).
      dupTs[dupHead] = tsNs;
      dupPx[dupHead] = price;
      dupSz[dupHead] = size;
      dupHead = (dupHead + 1) % DUP_WINDOW;
      if (dupCount < DUP_WINDOW) dupCount += 1;

      stats.merged += 1;
      ver += 1;
    },

    candles() {
      if (firstBi === null || lastBi === null) return [];
      const out: Candle[] = [];
      let bi = firstBi;
      while (bi <= lastBi && out.length <= ring) {
        const c = slots[Number(bi % BigInt(ring))];
        if (c !== undefined && c.bi === Number(bi)) out.push(c);
        bi += 1n;
      }
      return out;
    },

    count() {
      if (firstBi === null || lastBi === null) return 0;
      let n = 0;
      for (let bi = firstBi; bi <= lastBi; bi += 1n) {
        const c = slots[Number(bi % BigInt(ring))];
        if (c !== undefined && c.bi === Number(bi)) n += 1;
      }
      return n;
    },

    version() {
      return ver;
    },

    stats() {
      return { ...stats };
    },

    setTimeframe(ns) {
      const next = validTf(ns);
      if (next === tf) return;
      tf = next;
      clearRing();
      dupHead = 0;
      dupCount = 0;
      ver += 1;
    },

    reset() {
      clearRing();
      dupHead = 0;
      dupCount = 0;
      ver += 1;
    },
  };
}
