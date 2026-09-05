/**
 * Reconnect banner (A5) — a slim, truthful overlay for the one status that was
 * previously only readable in the top-bar chip: the socket is DOWN and a
 * reconnect attempt is in flight. Renders ONLY when the store's connection
 * status is literally `reconnecting` — never speculatively — and names the
 * market:symbol it is trying to reach. `role="status"` + `aria-live="polite"`
 * so the transition into (and out of) the state is announced.
 */

import { useFlowMapStore } from '../state/store';

export function ReconnectBanner(): JSX.Element | null {
  const status = useFlowMapStore((s) => s.status);
  const subscription = useFlowMapStore((s) => s.subscription);
  if (status !== 'reconnecting') return null;
  const target = subscription ? `${subscription.market}:${subscription.symbol}` : 'the feed';
  return (
    <div
      className="reconnect-banner"
      role="status"
      aria-live="polite"
      data-testid="reconnect-banner"
    >
      <span className="reconnect-banner__dot" aria-hidden="true" />
      connection lost — reconnecting to {target}…
    </div>
  );
}
