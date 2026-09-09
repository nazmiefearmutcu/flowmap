/**
 * PNG snapshot export (§9 top bar). Pure filename + download plumbing over the
 * renderer's `snapshot()` contract (gl/renderer.ts: force one synchronous full
 * frame, return the canvas as a PNG data URL, or null on a lost GL context).
 *
 * Everything here is DOM-light and injectable (clock + document) so the
 * download-anchor dance and the honest null path are unit-tested without a
 * browser. A null snapshot NEVER produces a download — the caller shows a
 * notice instead (TopBar's dismissible inline note).
 */

/** Local-time `YYYYMMDD-HHMMSS` stamp for export filenames. */
export function pngStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** `flowmap-<market>-<symbol>-<YYYYMMDD-HHMMSS>.png` (local time). */
export function pngFilename(market: string, symbol: string, now: Date): string {
  // Defensive: market/symbol come from the server's symbol list today, but the
  // download attribute must never carry a path separator for any caller.
  const safe = (part: string) => part.replace(/[^\w.-]+/g, '_');
  return `flowmap-${safe(market)}-${safe(symbol)}-${pngStamp(now)}.png`;
}

/** Minimal surface of HTMLAnchorElement the download needs (test-injectable). */
export interface DownloadAnchor {
  href: string;
  download: string;
  click(): void;
}

/** Element factory the download builds its transient anchor through. */
export type AnchorFactory = (tag: string) => DownloadAnchor | null;

/**
 * Trigger a browser download of `dataUrl` as `filename` via a transient anchor.
 * The anchor is created through `makeElement` (default `document.createElement`)
 * so tests can observe it; it is never appended to the DOM — a synthetic click
 * on a detached anchor starts the download in every engine we ship on
 * (Chromium/Tauri + WebKit).
 */
export function downloadPng(
  dataUrl: string,
  filename: string,
  makeElement: AnchorFactory = (tag) => document.createElement(tag) as HTMLAnchorElement,
): DownloadAnchor | null {
  const a = makeElement('a');
  if (!a) return null;
  a.href = dataUrl;
  a.download = filename;
  a.click();
  return a;
}

/**
 * One export attempt. Returns the filename on success (a download was started)
 * or null when the snapshot was refused (lost GL context) — the caller owes the
 * user a visible "unavailable" notice, never a fake success.
 */
export function runPngExport(
  snapshot: string | null,
  market: string,
  symbol: string,
  now: Date,
  makeElement: AnchorFactory = (tag) => document.createElement(tag) as HTMLAnchorElement,
): string | null {
  if (!snapshot) return null;
  const filename = pngFilename(market, symbol, now);
  downloadPng(snapshot, filename, makeElement);
  return filename;
}
