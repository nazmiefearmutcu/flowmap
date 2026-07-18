/**
 * Settings drawer (§9, T12). A right-side sheet exposing the workspace knobs:
 * colormap, normalization percentile, tick grouping, bubble-size threshold, follow
 * mode, right-rail visibility, and the heatmap overlay toggles.
 *
 * Every change flows up via `onChange(patch)`; the App merges it, persists the
 * whole object to localStorage, and applies the live-honourable knobs to the
 * renderer (bubble threshold, overlays, follow, rail). The display knobs (colormap
 * / normalization / tick grouping) are persisted so the choice survives reloads.
 */

import { useEffect } from 'react';

import type { OverlayVisibility } from '../gl/overlays/frame';
import { OverlayToggles } from './OverlayToggles';
import type { Colormap, FlowMapSettings } from './settings';

interface SettingsDrawerProps {
  settings: FlowMapSettings;
  onChange: (patch: Partial<FlowMapSettings>) => void;
  onClose: () => void;
}

export function SettingsDrawer({ settings, onChange, onClose }: SettingsDrawerProps): JSX.Element {
  // Esc closes the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleOverlay = (key: keyof OverlayVisibility): void => {
    onChange({ overlays: { ...settings.overlays, [key]: !settings.overlays[key] } });
  };

  return (
    <>
      <div className="drawer-scrim" onMouseDown={onClose} data-testid="settings-scrim" />
      <aside
        className="drawer"
        role="dialog"
        aria-label="settings"
        data-testid="settings-drawer"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="drawer__header">
          <span className="drawer__title">Settings</span>
          <button
            type="button"
            className="drawer__close"
            onClick={onClose}
            data-testid="settings-close"
            aria-label="close settings"
          >
            ✕
          </button>
        </header>

        <div className="drawer__body">
          {/* colormap */}
          <div className="setting">
            <span className="setting__label">Colormap</span>
            <div className="segrow" role="group" aria-label="colormap" data-testid="setting-colormap">
              {(['thermal', 'alt'] as Colormap[]).map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`segrow__btn${settings.colormap === c ? ' is-on' : ''}`}
                  aria-pressed={settings.colormap === c}
                  data-testid={`colormap-${c}`}
                  onClick={() => onChange({ colormap: c })}
                >
                  {c === 'thermal' ? 'Thermal' : 'Alt'}
                </button>
              ))}
            </div>
          </div>

          {/* normalization percentile */}
          <div className="setting">
            <span className="setting__label">
              Normalization
              <span className="setting__value">p{settings.normPercentile}</span>
            </span>
            <input
              type="range"
              className="range"
              min={90}
              max={100}
              step={0.5}
              value={settings.normPercentile}
              data-testid="setting-normPercentile"
              onChange={(e) => onChange({ normPercentile: Number(e.target.value) })}
            />
            <span className="setting__hint">Higher percentile → dimmer, more dynamic-range headroom.</span>
          </div>

          {/* tick grouping */}
          <div className="setting">
            <span className="setting__label">
              Tick grouping
              <span className="setting__value">
                {settings.tickGrouping} row{settings.tickGrouping === 1 ? '' : 's'} / cell
              </span>
            </span>
            <input
              type="range"
              className="range"
              min={1}
              max={16}
              step={1}
              value={settings.tickGrouping}
              data-testid="setting-tickGrouping"
              onChange={(e) => onChange({ tickGrouping: Number(e.target.value) })}
            />
          </div>

          {/* bubble threshold */}
          <div className="setting">
            <span className="setting__label">
              Bubble threshold
              <span className="setting__value">
                {settings.bubbleMinSize > 0 ? `≥ ${settings.bubbleMinSize}` : 'all trades'}
              </span>
            </span>
            <input
              type="range"
              className="range"
              min={0}
              max={100}
              step={1}
              value={settings.bubbleMinSize}
              data-testid="setting-bubble"
              onChange={(e) => onChange({ bubbleMinSize: Number(e.target.value) })}
            />
          </div>

          <div className="drawer__divider" />

          {/* follow mode */}
          <label
            className={`check${settings.follow ? ' is-on' : ''}`}
            data-testid="toggle-follow"
            onClick={() => onChange({ follow: !settings.follow })}
          >
            Follow live edge
            <span className="check__box" aria-hidden="true" />
          </label>

          {/* right rail */}
          <label
            className={`check${settings.railVisible ? ' is-on' : ''}`}
            data-testid="toggle-rail"
            onClick={() => onChange({ railVisible: !settings.railVisible })}
          >
            Right rail (DOM + tape)
            <span className="check__box" aria-hidden="true" />
          </label>

          <div className="drawer__divider" />

          {/* overlays */}
          <div className="setting">
            <span className="setting__label">Overlays</span>
            <OverlayToggles visibility={settings.overlays} onToggle={toggleOverlay} />
          </div>
        </div>
      </aside>
    </>
  );
}
