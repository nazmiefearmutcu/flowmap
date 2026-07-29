/**
 * Top bar (§9, T12) — one tidy row: brand, dual-market symbol search, a
 * venue/market indicator, honest capability badges, the live/replay toggle, a
 * clock (wall time + the stream's latest ts), the connection status, and the
 * rail + settings controls.
 *
 * Everything here is low-frequency: the store slices it reads (status / capability
 * / subscription / paused) update at human rate, the wall clock ticks at 1 Hz, and
 * the stream clock is passed in from the App's ≤4 Hz timeline poll. The heatmap
 * stream never reaches this component.
 */

import { forwardRef, useEffect, useState } from 'react';

import type { StreamMode } from '../proto/types';
import { useFlowMapStore } from '../state/store';
import { SymbolSearch, type SymbolSearchHandle } from './SymbolSearch';
import { Wordmark } from './Wordmark';
import {
  capabilityChipClass,
  capabilityChipTitle,
  capabilityChips,
  marketGroup,
  venueLabel,
} from './symbols';

const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  connecting: 'connecting',
  live: 'live',
  reconnecting: 'reconnecting',
  closed: 'closed',
};

// Capability chips are classified by the ONE shared `capabilityChipClass`
// (ui/symbols.ts), the same function the symbol palette uses. This file used to
// carry its own copy, and the two drifted: the same `SYNTH_PROFILE` string read
// as fabricated depth here and as real depth in the palette. One string, one
// fidelity claim, every surface.

/** The viewer's local time-zone abbreviation (e.g. `GMT+3`, `EST`) for labeling the wall clock. */
function localZoneAbbrev(d: Date): string {
  try {
    const part = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? 'local';
  } catch {
    return 'local';
  }
}

interface TopBarProps {
  onSelectSymbol: (market: string, symbol: string) => void;
  onSetMode: (mode: StreamMode) => void;
  railVisible: boolean;
  onToggleRail: () => void;
  onOpenSettings: () => void;
  /** Formatted latest-stream timestamp from the App's timeline poll (or null). */
  streamClock: string | null;
}

export const TopBar = forwardRef<SymbolSearchHandle, TopBarProps>(function TopBar(
  { onSelectSymbol, onSetMode, railVisible, onToggleRail, onOpenSettings, streamClock },
  searchRef,
) {
  const status = useFlowMapStore((s) => s.status);
  const feedState = useFlowMapStore((s) => s.feedState);
  const capability = useFlowMapStore((s) => s.capability);
  const subscription = useFlowMapStore((s) => s.subscription);

  const [wall, setWall] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setWall(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const market = subscription?.market ?? 'sim';
  const symbol = subscription?.symbol ?? 'SIM-DEMO';
  const mode: StreamMode = subscription?.mode ?? 'live';
  const group = marketGroup(market);
  const chips = capabilityChips(capability);
  const statusText = STATUS_LABEL[status] ?? status;
  const wallText = wall.toTimeString().slice(0, 8);
  const zoneAbbrev = localZoneAbbrev(wall);
  // For equity sessions the reference clock is US-eastern; show it beside the UTC stream ts.
  const etText =
    group === 'equity'
      ? wall.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })
      : null;
  const feedSuffix = feedState && feedState !== 'live' ? ` · ${feedState}` : '';

  return (
    <header className="topbar">
      <span className="topbar__brand">
        <Wordmark height={24} />
      </span>

      <SymbolSearch ref={searchRef} current={`${market}:${symbol}`} onSelect={onSelectSymbol} />

      {/* The venue, not just its asset class: with ~106 reachable venues "Crypto"
          no longer says WHERE the book is coming from, so a crypto session names
          the market string (`kraken`, `binance-usdm`) it is actually subscribed
          to. Equity / sim keep their group word — there the group IS the venue. */}
      <span
        className={`venue venue--${group}`}
        data-testid="venue"
        title={`${market} · ${symbol} · ${group}`}
      >
        <span className="venue__dot" aria-hidden="true" />
        {venueLabel(market)}
        <strong style={{ color: 'var(--text)', fontWeight: 600 }}>{symbol}</strong>
      </span>

      <span className="caps" data-testid="capability-badges">
        {capability === null ? (
          // Pre-Hello: caps aren't loaded yet — a neutral placeholder, NOT "none".
          <span className="cap cap--pending" aria-hidden="true">—</span>
        ) : chips.length === 0 ? (
          // Received a descriptor that genuinely advertises no capabilities.
          <span className="cap cap--na">NO CAPS</span>
        ) : (
          chips.map((c) => (
            <span key={c} className={capabilityChipClass(c)} title={capabilityChipTitle(c)}>
              {c}
            </span>
          ))
        )}
      </span>

      <span className="topbar__spacer" />

      <div className="modeseg" role="group" aria-label="live or replay" data-testid="mode-toggle">
        <button
          type="button"
          data-mode="live"
          className={`modeseg__btn${mode === 'live' ? ' is-on' : ''}`}
          aria-pressed={mode === 'live'}
          data-testid="mode-live"
          onClick={() => onSetMode('live')}
        >
          Live
        </button>
        <button
          type="button"
          data-mode="replay"
          className={`modeseg__btn${mode === 'replay' ? ' is-on' : ''}`}
          aria-pressed={mode === 'replay'}
          data-testid="mode-replay"
          onClick={() => onSetMode('replay')}
        >
          Replay
        </button>
      </div>

      <span
        className={`status status--${status}`}
        data-testid="conn-status"
        role="status"
        aria-live="polite"
        aria-label={`Connection ${statusText}${feedSuffix ? `, feed ${feedState}` : ''}`}
      >
        <span className="status__dot" aria-hidden="true" />
        {statusText}
        {feedSuffix}
      </span>

      <span
        className="clock"
        data-testid="clock"
        aria-label={`Wall clock ${wallText} ${zoneAbbrev}${
          etText ? `, Eastern ${etText}` : ''
        }, stream ${streamClock ?? 'none'} UTC`}
      >
        <span className="clock__wall">
          {wallText} <span className="clock__zone">{zoneAbbrev}</span>
        </span>
        {etText ? <span className="clock__et">{etText} ET</span> : null}
        <span className="clock__stream">{streamClock ? `T ${streamClock} UTC` : '— UTC'}</span>
      </span>

      <button
        type="button"
        className={`tbtn${railVisible ? ' is-on' : ''}`}
        aria-pressed={railVisible}
        onClick={onToggleRail}
        data-testid="rail-toggle"
        title="toggle DOM ladder / tape rail"
      >
        Rail
      </button>

      <button
        type="button"
        className="tbtn"
        onClick={onOpenSettings}
        data-testid="settings-open"
        title="settings"
        aria-haspopup="dialog"
      >
        {/* Force text (monochrome) presentation of the gear via U+FE0E, not the color emoji. */}
        <span aria-hidden="true">{'⚙︎'}</span> Settings
      </button>
    </header>
  );
});
