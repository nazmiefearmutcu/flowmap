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

import { t } from '../i18n';
import { useT } from '../i18n/useT';
import type { CloseInfo } from '../net/connection';
import { useFlowMapStore } from '../state/store';

/**
 * Short human text for how the last socket closed. Pure — unit-tested. An
 * unknown/absent code reads as the transport death it is; codes the server
 * actually sends get their real meaning (1001 sidecar shutdown, 1013 refused
 * for load) instead of a raw number dump.
 */
export function closeReasonText(close: CloseInfo | null): string {
  // i18n shell pass: the mapped reasons go through the shared banner keys
  // (module-level `t` — EN default keeps every existing string identical).
  // 1002 / 1003 have no shell key and stay English (transport jargon).
  if (!close) return t('banner.reasonDropped');
  switch (close.code) {
    case 1000:
      return t('banner.reasonSession');
    case 1001:
      return t('banner.reasonShutdown');
    case 1002:
      return 'protocol error';
    case 1003:
      return 'subscription refused';
    case 1013:
      return t('banner.reasonOverloaded');
    case null:
    case 1006:
      return t('banner.reasonDropped');
    default:
      return close.wasClean
        ? t('banner.reasonCode', { code: close.code })
        : t('banner.reasonDropped');
  }
}

export function ReconnectBanner(): JSX.Element | null {
  useT(); // re-render on locale change
  const status = useFlowMapStore((s) => s.status);
  const subscription = useFlowMapStore((s) => s.subscription);
  const lastClose = useFlowMapStore((s) => s.lastClose);
  const attempts = useFlowMapStore((s) => s.reconnectAttempts);
  const retryNow = useFlowMapStore((s) => s.retryNow);
  if (status !== 'reconnecting') return null;
  const target = subscription ? `${subscription.market}:${subscription.symbol}` : t('banner.theFeed');
  return (
    <div
      className="reconnect-banner"
      role="status"
      aria-live="polite"
      data-testid="reconnect-banner"
    >
      <span className="reconnect-banner__dot" aria-hidden="true" />
      <span className="reconnect-banner__text">
        {t('banner.lostReconnecting', { target, reason: closeReasonText(lastClose) })}
        {attempts > 0 ? ` · ${t('banner.attempt', { attempts })}` : ''}
      </span>
      <button
        type="button"
        className="reconnect-banner__retry"
        onClick={retryNow}
        data-testid="reconnect-retry"
        title={t('banner.retryNowHint')}
      >
        {t('banner.retryNow')}
      </button>
    </div>
  );
}
