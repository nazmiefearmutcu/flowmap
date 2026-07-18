import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiBase, serverOrigin, wsUrl } from './serverBase';

/**
 * The server-URL base that lets one client build run both same-origin in the
 * vite dev server and against an absolute loopback URL inside the packaged
 * Tauri app (which injects `window.__FLOWMAP_SERVER__`).
 */
describe('serverBase', () => {
  afterEach(() => {
    delete (window as { __FLOWMAP_SERVER__?: string }).__FLOWMAP_SERVER__;
    vi.unstubAllGlobals();
  });

  it('is same-origin when the global is absent (dev / vite proxy)', () => {
    expect(serverOrigin()).toBeNull();
    expect(apiBase()).toBe(''); // relative → proxied
  });

  it('derives the WS URL from window.location when same-origin', () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    // nosemgrep: loopback dev WebSocket URL — assertion, not a live connection.
    expect(wsUrl()).toBe('ws://localhost:5173/ws');
  });

  it('uses wss when the page is served over https', () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'example.test' });
    expect(wsUrl()).toBe('wss://example.test/ws');
  });

  it('reads the injected origin as the REST base in the packaged app', () => {
    window.__FLOWMAP_SERVER__ = 'http://127.0.0.1:52791';
    expect(serverOrigin()).toBe('http://127.0.0.1:52791');
    expect(apiBase()).toBe('http://127.0.0.1:52791');
  });

  it('builds an absolute loopback WebSocket URL from an injected http origin', () => {
    window.__FLOWMAP_SERVER__ = 'http://127.0.0.1:52791';
    // nosemgrep: loopback sidecar WebSocket URL — assertion, not a live connection.
    expect(wsUrl()).toBe('ws://127.0.0.1:52791/ws');
  });

  it('builds a secure WebSocket URL from an injected https origin', () => {
    window.__FLOWMAP_SERVER__ = 'https://127.0.0.1:52791';
    expect(wsUrl()).toBe('wss://127.0.0.1:52791/ws');
  });

  it('tolerates a trailing slash in the injected origin', () => {
    window.__FLOWMAP_SERVER__ = 'http://127.0.0.1:52791/';
    expect(apiBase()).toBe('http://127.0.0.1:52791');
    // nosemgrep: loopback sidecar WebSocket URL — assertion, not a live connection.
    expect(wsUrl()).toBe('ws://127.0.0.1:52791/ws');
  });
});
