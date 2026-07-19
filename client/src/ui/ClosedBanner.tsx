/**
 * Closed-market banner (§7.1 equity session model).
 *
 * When the server reports a terminal `Status{feed_state='closed', next_open_ts}`
 * (an equity RTH window that is closed — nights, weekends, holidays) the store
 * surfaces `feedState==='closed'` + `nextOpenTs`. This small, unobtrusive banner
 * (near-black, amber accent) then overlays the stage with "MARKET CLOSED" and a
 * live countdown to the next open. It is HONEST: it never implies a live feed —
 * the last session's SYNTH warmup profile stays visible behind it (spec §7.1
 * "no empty-column accumulation"), and the banner just states the closed state.
 *
 * Only mounts its 1 Hz ticker while closed; renders nothing otherwise (the vast
 * majority of the time — crypto is 24/7, equities are open during RTH), so there
 * is zero cost on the common path.
 */

import { useEffect, useState } from 'react';

import { useFlowMapStore } from '../state/store';

/**
 * Format a positive remaining-millisecond span as `HH:MM:SS`, prefixed with
 * `Nd ` when it exceeds a day (a weekend gap to Monday's open is ~2 days).
 * Non-finite / non-positive spans read `00:00:00` (opening imminently). Pure —
 * unit-tested without React or a clock.
 */
export function formatCountdown(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '00:00:00';
  const totalSec = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSec / 86_400);
  const h = Math.floor((totalSec % 86_400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hms = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return days > 0 ? `${days}d ${hms}` : hms;
}

export function ClosedBanner(): JSX.Element | null {
  const feedState = useFlowMapStore((s) => s.feedState);
  const nextOpenTs = useFlowMapStore((s) => s.nextOpenTs);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const closed = feedState === 'closed';

  // Tick once a second while closed so the countdown updates; no timer runs on
  // the common (open / crypto) path.
  useEffect(() => {
    if (!closed) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [closed]);

  if (!closed) return null;

  const remainingMs = nextOpenTs !== null ? Number(nextOpenTs / 1_000_000n) - nowMs : null;
  const showCountdown = remainingMs !== null && remainingMs > 0;

  return (
    <div
      className="closed-banner"
      role="status"
      aria-label="Market closed"
      data-testid="closed-banner"
    >
      <span className="closed-banner__dot" aria-hidden="true" />
      <span className="closed-banner__label">MARKET CLOSED</span>
      {showCountdown && (
        <span
          className="closed-banner__countdown"
          aria-live="off"
          data-testid="closed-countdown"
        >
          opens in {formatCountdown(remainingMs)}
        </span>
      )}
    </div>
  );
}
