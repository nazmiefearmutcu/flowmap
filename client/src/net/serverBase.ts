/**
 * Resolve the FlowMap server's base URL.
 *
 * Two deployment shapes share one client build:
 *
 * - **Dev (browser + vite proxy):** the SPA is served same-origin and vite
 *   proxies `/api` + `/ws` to the real server on 8720. The global is absent, so
 *   REST calls stay same-origin (`''`) and the WS URL is derived from
 *   `window.location` — behaviour unchanged from before this module existed.
 *
 * - **Packaged desktop app (Tauri):** the webview loads the bundled static
 *   client from `tauri://localhost`, so there is no proxy and same-origin does
 *   not reach the server. The Tauri shell spawns the Python sidecar on a free
 *   loopback port and injects `window.__FLOWMAP_SERVER__ =
 *   "http://127.0.0.1:<port>"` before the page loads; the client reads that
 *   global as the absolute base for both REST and the WebSocket.
 */

declare global {
  interface Window {
    /** Absolute server origin injected by the Tauri shell, e.g. `http://127.0.0.1:52791`. */
    __FLOWMAP_SERVER__?: string;
  }
}

/**
 * The injected absolute server origin (no trailing slash), or `null` when
 * running same-origin in the browser dev server.
 */
export function serverOrigin(): string | null {
  if (typeof window === 'undefined') return null;
  const injected = window.__FLOWMAP_SERVER__;
  if (typeof injected === 'string' && injected.length > 0) {
    return injected.replace(/\/+$/, ''); // tolerate a trailing slash in the injected value
  }
  return null;
}

/**
 * Base to prefix REST paths with, e.g. `` `${apiBase()}/api/symbols` ``. The
 * absolute injected origin in the packaged app; the empty string (same-origin)
 * in dev so the vite proxy handles it.
 */
export function apiBase(): string {
  return serverOrigin() ?? '';
}

/**
 * Absolute URL for the `/ws` endpoint. Derived from the injected origin in the
 * packaged app (`http`→`ws`, `https`→`wss`); otherwise from `window.location`
 * (same-origin, proxied in dev).
 */
export function wsUrl(): string {
  const origin = serverOrigin();
  if (origin !== null) {
    const scheme = origin.startsWith('https:') ? 'wss:' : 'ws:';
    const rest = origin.replace(/^https?:/, '');
    return `${scheme}${rest}/ws`;
  }
  if (typeof window !== 'undefined' && window.location) {
    const { protocol, host } = window.location;
    const scheme = protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${host}/ws`;
  }
  return 'ws://localhost/ws';
}
