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

function fmtTapeSize(v: number): string {
  if (v >= 1000) return v.toFixed(0);
  if (v >= 100) return v.toFixed(1);
  return v.toFixed(2);
}

export function Tape(): JSX.Element {
  const capability = useFlowMapStore((s) => s.capability);
  const epochs = useFlowMapStore((s) => s.epochs);
  const gridEpoch = useFlowMapStore((s) => s.gridEpoch);
  const [snap, setSnap] = useState<BookSnapshot>(() => getSnapshot());
  const [collapsed, setCollapsed] = useState(false);
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
  };
  const onLeave = (): void => {
    pausedRef.current = false;
    setSnap(getSnapshot());
  };

  const trades = snap.trades.slice(0, TAPE_MAX);
  const threshold = largeThreshold(trades);
  // Price precision from the active epoch's step when known.
  const params = epochs.get(snap.book?.epoch ?? gridEpoch ?? -1);
  const decimals = params ? priceDecimals(params.tick * params.tick_multiple) : 2;
  const badge = tapeBadge(capability);

  return (
    <section className="panel tape" data-testid="tape">
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
                return (
                  <div
                    key={`${t.tsNs}-${i}`}
                    className={`tape__row tape__row--${side}${large ? ' is-large' : ''}`}
                    data-testid="tape-row"
                    data-side={side}
                    data-price={t.price.toFixed(decimals)}
                    data-size={t.size.toFixed(4)}
                    data-large={large ? '1' : '0'}
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
