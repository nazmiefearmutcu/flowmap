/**
 * Overlay visibility toggles (§9 settings: which overlays are on), M2 T10.
 *
 * A compact button row in the top bar. Default all on except the volume profile
 * (a denser, opt-in overlay). Each click flips one overlay via the renderer's
 * imperative `setOverlayVisibility` — this is UI state, not per-frame data, so it
 * lives in React.
 */

import type { OverlayVisibility } from '../gl/overlays/frame';

const ITEMS: Array<[keyof OverlayVisibility, string, string]> = [
  ['bubbles', 'Bubbles', 'Bubbles — trade size bubbles on the tape'],
  ['bbo', 'BBO', 'BBO — best bid/offer'],
  ['vwap', 'VWAP', 'VWAP — volume-weighted average price'],
  ['profile', 'Profile', 'Profile — volume profile'],
  ['markers', 'Markers', 'Markers — event markers'],
  ['axes', 'Axes', 'Axes — price/time axes'],
];

interface OverlayTogglesProps {
  visibility: OverlayVisibility;
  onToggle: (key: keyof OverlayVisibility) => void;
}

export function OverlayToggles({ visibility, onToggle }: OverlayTogglesProps): JSX.Element {
  return (
    <div className="overlay-toggles" role="group" aria-label="overlay toggles">
      {ITEMS.map(([key, label, description]) => (
        <button
          key={key}
          type="button"
          className={`overlay-toggle${visibility[key] ? ' is-on' : ''}`}
          aria-pressed={visibility[key]}
          aria-label={description}
          title={description}
          onClick={() => onToggle(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
