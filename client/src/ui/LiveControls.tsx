/**
 * In-chart live/follow affordance (§9 transport).
 *
 * A small popup that surfaces INSIDE the chart (bottom-centre of the viewport)
 * only when a follow axis is off, so the user always sees how to get back to live
 * without hunting for the footer GO LIVE button (which sits outside the chart and
 * is easy to miss). Two independent chips:
 *
 *   - GO LIVE  — shown when time-follow is off (the view trails the live edge);
 *     re-pins the right edge and re-arms follow via the App's onGoLive.
 *   - TRACK PRICE — shown when the price axis is locked; re-enables price tracking
 *     as 'track' (KEEPS the user's zoom, only recentres) — never 'fit', so it does
 *     not destroy the scale the user set. When the live edge is off-screen the
 *     App's composite ALSO re-pins time (see App.onTrackPrice) — the tooltip
 *     says so, so the click is never a silent surprise.
 *
 * Replay chrome (survey S4 D4, campaign 2026-09-11): in `replay` mode these
 * chips are HIDDEN entirely. "GO LIVE" is meaningless against a replay head and
 * contradicts the transport pill, and "TRACK PRICE" alone cannot express the
 * replay-specific return-to-head action — the Timeline transport owns replay
 * navigation. Hiding (not disabling) keeps the surface honest: no affordance
 * that claims something it cannot do.
 *
 * It runs its own light ≤4 Hz poll of the renderer (following + priceFollow +
 * live-edge visibility + behind readout); nothing here goes into the per-frame
 * render path.
 */

import { useEffect, useState, type RefObject } from 'react';

import { colsBehind } from '../gl/follow';
import type { Renderer } from '../gl/renderer';
import type { StreamMode } from '../proto/types';
import { behindNs, formatDurationCoarseNs } from './replay';

const POLL_MS = 250;

/** CP1 seam (B2 lane): optional until the renderer ships the getter — a missing
 *  value is "unknown", which reads as visible (no hint about a return we cannot
 *  verify). */
type RendererCp1 = Renderer & { readonly liveEdgeVisible?: boolean };

interface LiveControlsProps {
  rendererRef: RefObject<Renderer | null>;
  onGoLive: () => void;
  onTrackPrice: () => void;
  /** Current stream mode; the chips are a LIVE-mode affordance only. */
  mode?: StreamMode;
}

export function LiveControls({
  rendererRef,
  onGoLive,
  onTrackPrice,
  mode = 'live',
}: LiveControlsProps): JSX.Element | null {
  const [following, setFollowing] = useState(true);
  const [priceLocked, setPriceLocked] = useState(false);
  const [edgeVisible, setEdgeVisible] = useState(true);
  const [behind, setBehind] = useState('');

  useEffect(() => {
    const id = window.setInterval(() => {
      const r = rendererRef.current as RendererCp1 | null;
      if (!r) return;
      setFollowing((f) => (f === r.following ? f : r.following));
      setPriceLocked((p) => {
        const locked = r.priceFollow === 'off';
        return p === locked ? p : locked;
      });
      const edge = r.liveEdgeVisible !== false;
      setEdgeVisible((e) => (e === edge ? e : edge));
      const tl = r.timeline();
      let next = '';
      if (tl && tl.timeBase) {
        const lag = colsBehind(
          { colOffset: tl.viewStartCol, colScale: tl.viewEndCol - tl.viewStartCol, rowOffset: 0, rowScale: 1 },
          tl.newestSeq,
        );
        if (lag > 0 && tl.timeBase.dtNs > 0) next = formatDurationCoarseNs(behindNs(lag, tl.timeBase.dtNs));
      }
      setBehind((b) => (b === next ? b : next));
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [rendererRef]);

  if (mode === 'replay') return null;
  if (following && !priceLocked) return null;

  return (
    <div className="livectl" data-testid="live-controls">
      {!following && (
        <button
          type="button"
          className="livectl__chip livectl__chip--live"
          data-testid="chip-go-live"
          onClick={onGoLive}
          title="Return to the live edge"
        >
          <span className="livectl__dot" aria-hidden="true" />
          GO LIVE{behind ? ` · −${behind}` : ''}
        </button>
      )}
      {priceLocked && (
        <button
          type="button"
          className="livectl__chip"
          data-testid="chip-track-price"
          onClick={onTrackPrice}
          title={
            edgeVisible
              ? 'Resume price tracking (keeps your zoom)'
              : 'Resume price tracking and return to the live edge (keeps your zoom)'
          }
        >
          TRACK PRICE
        </button>
      )}
    </div>
  );
}
