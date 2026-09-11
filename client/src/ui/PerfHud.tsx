/**
 * PerfHud (campaign 3, lane CD, contract C3) — the render-health chip.
 *
 * A tiny monospace HUD (bottom-left of the chart viewport) showing fps, frame
 * ms, texture uploads, draw calls and the column-cache footprint, read from
 * `renderer.stats()` (EMA-smoothed on the renderer side, contract C3). Polled
 * at 2 Hz — NEVER per frame — and rendering an honest `—` per field while the
 * renderer provides no stats (a build without C3) or before the first poll.
 *
 * `H` toggles visibility; the flag is workspace state, so the component takes
 * `visible` + `onToggle` props and App persists it in the settings store
 * (`hudVisible`). Defensive against the C3 contract landing in either order:
 * `stats()` is feature-detected off the renderer instance.
 */

import { useEffect, useState, type MutableRefObject } from 'react';

import type { Renderer } from '../gl/renderer';
import { classifyTarget, routeGlobalKey } from '../input/keys';
import './features.css';

/** The C3 stats shape CB's renderer ships. All values O(1) reads. */
export interface RendererStats {
  fps: number;
  frameMs: number;
  uploads: number;
  draws: number;
  cacheBytes: number;
}

/** 2 Hz poll — cheap enough to be invisible, fast enough for readable numbers. */
const POLL_MS = 500;

function readStats(renderer: Renderer | null): RendererStats | null {
  if (renderer === null) return null;
  const fn = (renderer as unknown as { stats?: () => RendererStats }).stats;
  if (typeof fn !== 'function') return null; // contract C3 not landed — honest —
  try {
    const s = fn.call(renderer);
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

function fmt1(v: number | null, dash = '—'): string {
  return v === null || !Number.isFinite(v) ? dash : v.toFixed(1);
}

function fmtInt(v: number | null, dash = '—'): string {
  return v === null || !Number.isFinite(v) ? dash : String(Math.round(v));
}

function fmtMb(bytes: number | null, dash = '—'): string {
  if (bytes === null || !Number.isFinite(bytes)) return dash;
  return `${(bytes / 1_048_576).toFixed(0)}MB`;
}

interface PerfHudProps {
  rendererRef: MutableRefObject<Renderer | null>;
  /** Whether the chip is shown (settings `hudVisible`; H toggles via onToggle). */
  visible: boolean;
  /** Toggle callback — App patches settings so the choice persists. */
  onToggle: () => void;
}

export function PerfHud({ rendererRef, visible, onToggle }: PerfHudProps): JSX.Element | null {
  const [stats, setStats] = useState<RendererStats | null>(null);

  // `H` — toggle the chip. Routed through the shared router so the
  // editable/dialog guards live in exactly one place (input/keys.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const action = routeGlobalKey(e.key, classifyTarget(e.target));
      if (action?.type !== 'toggle-hud') return;
      e.preventDefault();
      onToggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onToggle]);

  // 2 Hz poll of the renderer's O(1) stats snapshot.
  useEffect(() => {
    if (!visible) return;
    const tick = (): void => setStats(readStats(rendererRef.current));
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
  }, [visible, rendererRef]);

  if (!visible) return null;
  const dash = '—';

  return (
    <div className="perfhud" data-testid="perf-hud" role="status" aria-label="render performance">
      <span className="perfhud__cell">
        <span className="perfhud__k">fps</span>
        <span className="perfhud__v" data-testid="perfhud-fps">
          {stats ? fmt1(stats.fps) : dash}
        </span>
      </span>
      <span className="perfhud__cell">
        <span className="perfhud__k">frame</span>
        <span className="perfhud__v" data-testid="perfhud-frame">
          {stats ? `${fmt1(stats.frameMs)}ms` : dash}
        </span>
      </span>
      <span className="perfhud__cell">
        <span className="perfhud__k">upl</span>
        <span className="perfhud__v" data-testid="perfhud-uploads">
          {stats ? fmtInt(stats.uploads) : dash}
        </span>
      </span>
      <span className="perfhud__cell">
        <span className="perfhud__k">draws</span>
        <span className="perfhud__v" data-testid="perfhud-draws">
          {stats ? fmtInt(stats.draws) : dash}
        </span>
      </span>
      <span className="perfhud__cell">
        <span className="perfhud__k">cache</span>
        <span className="perfhud__v" data-testid="perfhud-cache">
          {stats ? fmtMb(stats.cacheBytes) : dash}
        </span>
      </span>
    </div>
  );
}
