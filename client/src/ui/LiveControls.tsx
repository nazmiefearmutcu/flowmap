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
 *     not destroy the scale the user set.
 *
 * It runs its own light ≤4 Hz poll of the renderer (following + priceFollow +
 * behind readout); nothing here goes into the per-frame render path.
 */

import { useEffect, useState, type RefObject } from 'react';

import { colsBehind } from '../gl/follow';
import type { Renderer } from '../gl/renderer';
import { behindNs, formatDurationCoarseNs } from './replay';

const POLL_MS = 250;

interface LiveControlsProps {
  rendererRef: RefObject<Renderer | null>;
  onGoLive: () => void;
  onTrackPrice: () => void;
}

export function LiveControls({ rendererRef, onGoLive, onTrackPrice }: LiveControlsProps): JSX.Element | null {
  const [following, setFollowing] = useState(true);
  const [priceLocked, setPriceLocked] = useState(false);
  const [behind, setBehind] = useState('');

  useEffect(() => {
    const id = window.setInterval(() => {
      const r = rendererRef.current;
      if (!r) return;
      setFollowing((f) => (f === r.following ? f : r.following));
      setPriceLocked((p) => {
        const locked = r.priceFollow === 'off';
        return p === locked ? p : locked;
      });
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
          title="Resume price tracking (keeps your zoom)"
        >
          TRACK PRICE
        </button>
      )}
    </div>
  );
}
