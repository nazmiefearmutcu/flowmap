/**
 * Toast stack (lane CE) — dependency-free global notifications, pinned
 * bottom-right above the timeline rail (ported from old-branch ui/Toasts,
 * re-grounded: module-level store instead of the old zustand toastStore, so
 * ANY lane can push a toast from plain code via the exported {@link toast}).
 *
 * - kinds: info (default) / success / warn / error, severity on the left
 *   accent border (teal/teal/amber/red — the shell's own channels).
 * - auto-dismiss after `ttlMs` (default 5s); hovering a toast PAUSES its
 *   timer and leaving resumes the remainder.
 * - max 5 visible; the OLDEST drops when a sixth arrives.
 * - the wrapper is ONE polite live region (role="status"), so a burst
 *   announces as calm status updates rather than interruptive alerts.
 * - on mount binds `window.__flowmapToast = (msg, kind?) => toast(...)` —
 *   the legacy hook lane CD's alert toasts call — and unbinds on unmount.
 * - renders null while empty: zero DOM, zero cost on the common path.
 */

import { useEffect, useSyncExternalStore } from 'react';

import { useT } from '../i18n/useT';
import '../theme/shell.css';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface ToastOptions {
  kind?: ToastKind;
  /** Auto-dismiss delay; non-positive / non-finite falls back to the default. */
  ttlMs?: number;
}

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  ttlMs: number;
}

export const MAX_TOASTS = 5;
export const DEFAULT_TTL_MS = 5000;

declare global {
  interface Window {
    /** Legacy toast hook — assigned by <Toaster/> on mount. */
    __flowmapToast?: (message: string, kind?: ToastKind) => void;
  }
}

/* ---------------------------------------------------------------- store */

let seq = 0;
let entries: Toast[] = [];
const listeners = new Set<() => void>();
/** id → live timer bookkeeping (handle 0 = paused). */
const timers = new Map<number, { handle: number; remainingMs: number; startedAt: number }>();

function notify(): void {
  listeners.forEach((l) => l());
}

function expire(id: number): void {
  timers.delete(id);
  dismissToast(id);
}

function schedule(id: number, delayMs: number): void {
  timers.set(id, {
    handle: window.setTimeout(() => expire(id), delayMs),
    remainingMs: delayMs,
    startedAt: Date.now(),
  });
}

/** Push a toast (caps the stack at {@link MAX_TOASTS}, oldest dropped first). */
export function toast(message: string, opts: ToastOptions = {}): Toast {
  const kind: ToastKind = opts.kind ?? 'info';
  const ttlMs =
    opts.ttlMs !== undefined && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
      ? opts.ttlMs
      : DEFAULT_TTL_MS;
  const entry: Toast = { id: ++seq, message, kind, ttlMs };
  entries =
    entries.length >= MAX_TOASTS
      ? [...entries.slice(entries.length - MAX_TOASTS + 1), entry]
      : [...entries, entry];
  schedule(entry.id, ttlMs);
  notify();
  return entry;
}

/** Remove a toast now (close button, expiry). No-op for unknown ids. */
export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) {
    window.clearTimeout(timer.handle);
    timers.delete(id);
  }
  const next = entries.filter((e) => e.id !== id);
  if (next.length !== entries.length) {
    entries = next;
    notify();
  }
}

/** Pause a toast's auto-dismiss timer (hover in). */
export function pauseToast(id: number): void {
  const timer = timers.get(id);
  if (!timer || timer.handle === 0) return;
  window.clearTimeout(timer.handle);
  timer.remainingMs -= Date.now() - timer.startedAt;
  timer.handle = 0;
}

/** Resume a paused toast's remaining ttl (hover out). */
export function resumeToast(id: number): void {
  const timer = timers.get(id);
  if (!timer || timer.handle !== 0) return;
  timer.startedAt = Date.now();
  timer.handle = window.setTimeout(() => expire(id), Math.max(timer.remainingMs, 0));
}

export function getToasts(): Toast[] {
  return entries;
}

export function subscribeToasts(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test seam: clear the stack and every pending timer. */
export function resetToasts(): void {
  for (const timer of timers.values()) window.clearTimeout(timer.handle);
  timers.clear();
  entries = [];
  notify();
}

/* ----------------------------------------------------------- component */

export function Toaster(): JSX.Element | null {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  const t = useT();

  // Legacy window hook for lanes that push toasts from non-React code.
  useEffect(() => {
    window.__flowmapToast = (message: string, kind?: ToastKind) => toast(message, { kind });
    return () => {
      delete window.__flowmapToast;
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite" data-testid="toasts">
      {toasts.map((toast_) => (
        <div
          key={toast_.id}
          className={`toast toast--${toast_.kind}`}
          data-testid={`toast-${toast_.id}`}
          onMouseEnter={() => pauseToast(toast_.id)}
          onMouseLeave={() => resumeToast(toast_.id)}
        >
          <span className="toast__message">{toast_.message}</span>
          <button
            type="button"
            className="toast__close"
            aria-label={t('toast.dismiss')}
            data-testid={`toast-close-${toast_.id}`}
            onClick={() => dismissToast(toast_.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
