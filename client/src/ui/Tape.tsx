/**
 * Time & sales tape panel (§9 right rail, M2 T11).
 *
 * A scrolling list of the most recent trades (newest on top), each row: time
 * (HH:MM:SS.mmm), price, size, colored by aggressor side (buy teal / sell red /
 * unknown grey). Bounded to the last ~200. Large trades are emphasized (bold +
 * background tint) above a rolling threshold (the p90 of the visible sizes — a
 * display emphasis, not a data claim). The badge is HONEST (§7): `TAPE TICK` for a
 * real tick tape, else `TAPE <mode>` (e.g. `TAPE POLL` / `TAPE 10S`) — it always
 * states the actual tier.
 *
 * Time is formatted from `ts_ns` as UTC wall-clock HH:MM:SS.mmm, matching the
 * crosshair readout; the sim's ts_ns is session-relative so it reads as elapsed T+.
 *
 * Auto-scroll keeps the newest trade at the top; hovering the tape PAUSES updates
 * (freezing the list so a row can be read) and resuming snaps to the latest. Trades
 * arrive off the module-scoped {@link bookStore} at ~10 Hz, off the React
 * high-frequency path so the GL loop is untouched.
 *
 * On top of the rolling p90 display emphasis, a PERSISTED absolute threshold
 * (settings.bigTradeUsd, via the `bigTradeUsd` prop) gives rows at or above the
 * notional a static accent highlight plus an honest header chip (`3 big`); it is
 * off at 0 (the default) and renders nothing then.
 */

import { useEffect, useRef, useState } from 'react';

import { SIDE_BUY, SIDE_SELL } from '../proto/types';
import {
  subscribe,
  getSnapshot,
  type BookSnapshot,
  type TapeTrade,
} from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { priceDecimals } from './DomLadder';

/** Max rows rendered (spec §9: "last ~200"). */
const TAPE_MAX = 200;
/** Minimum trades before the large-lot emphasis kicks in (avoid noise on cold start). */
const LARGE_MIN_SAMPLES = 12;

/** Honest tape-tier badge from the capability descriptor. */
export function tapeBadge(capability: Record<string, unknown> | null): string {
  const t = capability?.tape;
  if (typeof t !== 'string') return 'TAPE';
  return `TAPE ${t.toUpperCase()}`;
}

/** The p90 size over the visible trades, or Infinity when too few samples. */
export function largeThreshold(trades: readonly TapeTrade[]): number {
  if (trades.length < LARGE_MIN_SAMPLES) return Number.POSITIVE_INFINITY;
  const sizes = trades.map((t) => t.size).sort((a, b) => a - b);
  const idx = Math.floor(sizes.length * 0.9);
  return sizes[Math.min(idx, sizes.length - 1)];
}

/**
 * The persisted big-trade rule (settings.bigTradeUsd): a trade qualifies when
 * its notional `price × size` reaches `thresholdUsd`. Pure + strict:
 *   - a threshold at or below 0 (or non-finite) is OFF — nothing is ever big;
 *   - a NaN price or size is never big (no honest notional, no highlight);
 *   - the boundary counts: exactly at the threshold IS big.
 */
export function isBigTrade(price: number, qty: number, thresholdUsd: number): boolean {
  if (!(thresholdUsd > 0)) return false;
  if (!Number.isFinite(price) || !Number.isFinite(qty)) return false;
  return price * qty >= thresholdUsd;
}

export type TapeSide = 'buy' | 'sell' | 'unknown';

export function sideClass(side: number): TapeSide {
  if (side === SIDE_BUY) return 'buy';
  if (side === SIDE_SELL) return 'sell';
  return 'unknown';
}

/** ns → HH:MM:SS.mmm (UTC; matches the crosshair, sim ts_ns is session-relative). */
export function fmtTapeTime(ns: bigint): string {
  const ms = Number(ns / 1_000_000n);
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toISOString().substring(11, 23);
  } catch {
    return '—';
  }
}

/**
 * Tape size text with adaptive precision (2–4 significant decimals by
 * magnitude). The old fixed 2dp printed "0.00" for BTC-class fills of
 * 0.0001–0.004 — a wall of fake zeros. Sub-unit sizes keep 3dp down to 0.1
 * and 4dp below (the data-size precision); anything smaller than even 4dp
 * falls back to 2 significant digits so a real print never reads "0.0000".
 */
export function fmtTapeSize(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1000) return v.toFixed(0);
  if (v >= 100) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  if (v <= 0) return '0';
  if (v >= 0.1) return v.toFixed(3);
  if (v >= 0.0001) return v.toFixed(4);
  return v.toPrecision(2);
}

/**
 * Stable React keys for the tape rows. A trade carries no sequence number, so
 * the identity is its content (ts + price + size + side) plus an occurrence
 * index for genuine duplicates. The index is assigned OLDEST-FIRST (right-to-
 * left over the newest-first array) so prepending a newer trade never renumbers
 * an older row's key — the old `${tsNs}-${i}` positional key remounted every
 * visible row ~10 times a second (each append shifts every index by one).
 */
export function tapeKeys(trades: readonly TapeTrade[]): string[] {
  const seen = new Map<string, number>();
  const keys = new Array<string>(trades.length);
  for (let i = trades.length - 1; i >= 0; i -= 1) {
    const t = trades[i];
    const base = `${t.tsNs}-${t.price}-${t.size}-${t.side}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    keys[i] = `${base}-${n}`;
  }
  return keys;
}

export function Tape({ bigTradeUsd = 0 }: { bigTradeUsd?: number }): JSX.Element {
  const capability = useFlowMapStore((s) => s.capability);
  const epochs = useFlowMapStore((s) => s.epochs);
  const gridEpoch = useFlowMapStore((s) => s.gridEpoch);
  const [snap, setSnap] = useState<BookSnapshot>(() => getSnapshot());
  const [collapsed, setCollapsed] = useState(false);
  // Hover-pause freezes the list so a row can be read; without a visible
  // indicator that read like a stuck feed, so the header says HELD.
  const [held, setHeld] = useState(false);
  const pausedRef = useRef(false);

  useEffect(
    () =>
      subscribe((s) => {
        if (!pausedRef.current) setSnap(s);
      }),
    [],
  );

  const onEnter = (): void => {
    pausedRef.current = true;
    setHeld(true);
  };
  const onLeave = (): void => {
    pausedRef.current = false;
    setHeld(false);
    setSnap(getSnapshot());
  };

  const trades = snap.trades.slice(0, TAPE_MAX);
  const keys = tapeKeys(trades);
  const threshold = largeThreshold(trades);
  // Absolute notional highlight (settings.bigTradeUsd; 0 = off). Computed once
  // per render so the header chip and the row classes always agree.
  const bigActive = bigTradeUsd > 0;
  const bigCount = bigActive
    ? trades.reduce((n, t) => n + (isBigTrade(t.price, t.size, bigTradeUsd) ? 1 : 0), 0)
    : 0;
  // Price precision from the active epoch's step when known.
  const params = epochs.get(snap.book?.epoch ?? gridEpoch ?? -1);
  const decimals = params ? priceDecimals(params.tick * params.tick_multiple) : 2;
  const badge = tapeBadge(capability);

  return (
    <section className={`panel tape${collapsed ? ' is-collapsed' : ''}`} data-testid="tape">
      <header className="panel__header">
        <button
          type="button"
          className="panel__collapse"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
          data-testid="tape-collapse"
        >
          <span className="panel__chevron">{collapsed ? '▸' : '▾'}</span>
          <span className="panel__title">T&amp;S</span>
        </button>
        <span className="panel__badge panel__badge--tape" data-testid="tape-badge">
          {badge}
        </span>
        {held && (
          <span className="panel__badge tape__held" data-testid="tape-held" title="updates paused while reading — leave the tape to resume">
            HELD
          </span>
        )}
        {bigActive && (
          <span
            className="panel__badge tape__big"
            data-testid="tape-big"
            title={`tape rows at or above $${bigTradeUsd.toLocaleString('en-US')} notional`}
          >
            {bigCount} big
          </span>
        )}
      </header>
      {!collapsed && (
        <div
          className="tape__body"
          data-testid="tape-body"
          onPointerEnter={onEnter}
          onPointerLeave={onLeave}
        >
          {trades.length === 0 ? (
            <div className="panel__empty">waiting for tape…</div>
          ) : (
            <div className="tape__rows">
              {trades.map((t, i) => {
                const side = sideClass(t.side);
                const large = t.size >= threshold;
                const big = isBigTrade(t.price, t.size, bigTradeUsd);
                return (
                  <div
                    key={keys[i]}
                    className={`tape__row tape__row--${side}${large ? ' is-large' : ''}${big ? ' is-big' : ''}`}
                    data-testid="tape-row"
                    data-side={side}
                    data-price={t.price.toFixed(decimals)}
                    data-size={t.size.toFixed(4)}
                    data-large={large ? '1' : '0'}
                    data-big={big ? '1' : '0'}
                  >
                    <span className="tape__time">{fmtTapeTime(t.tsNs)}</span>
                    <span className="tape__px">{t.price.toFixed(decimals)}</span>
                    <span className="tape__sz">{fmtTapeSize(t.size)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
