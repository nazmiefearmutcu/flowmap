/**
 * Reconnect banner (A5) — a slim, truthful overlay for the one status that was
 * previously only readable in the top-bar chip: the socket is DOWN and a
 * reconnect attempt is in flight. Renders ONLY when the store's connection
 * status is literally `reconnecting` — never speculatively — and names the
 * market:symbol it is trying to reach, HOW the last socket closed (the
 * transport's close info, spelled as one calm human line), and which attempt
 * this is. The "retry now" button skips the remaining backoff by re-entering
 * the connection's own reconnect path. `role="status"` + `aria-live="polite"`
 * so the transition into (and out of) the state is announced.
 */

import type { CloseInfo } from '../net/connection';
import { useFlowMapStore } from '../state/store';

/**
 * Short human text for how the last socket closed. Pure — unit-tested. An
 * unknown/absent code reads as the transport death it is; codes the server
 * actually sends get their real meaning (1001 sidecar shutdown, 1013 refused
 * for load) instead of a raw number dump.
 */
export function closeReasonText(close: CloseInfo | null): string {
  if (!close) return 'connection dropped';
  switch (close.code) {
    case 1000:
      return 'server closed the session';
    case 1001:
      return 'server shut down';
    case 1002:
      return 'protocol error';
    case 1003:
      return 'subscription refused';
    case 1013:
      return 'server overloaded';
    case null:
    case 1006:
      return 'connection dropped';
    default:
      return close.wasClean ? `server closed (code ${close.code})` : 'connection dropped';
  }
}

export function ReconnectBanner(): JSX.Element | null {
  const status = useFlowMapStore((s) => s.status);
  const subscription = useFlowMapStore((s) => s.subscription);
  const lastClose = useFlowMapStore((s) => s.lastClose);
  const attempts = useFlowMapStore((s) => s.reconnectAttempts);
  const retryNow = useFlowMapStore((s) => s.retryNow);
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
      <span className="reconnect-banner__text">
        connection lost — reconnecting to {target} · {closeReasonText(lastClose)}
        {attempts > 0 ? ` · attempt ${attempts}` : ''}
      </span>
      <button
        type="button"
        className="reconnect-banner__retry"
        onClick={retryNow}
        data-testid="reconnect-retry"
        title="skip the wait and reconnect immediately"
      >
        retry now
      </button>
    </div>
  );
}
