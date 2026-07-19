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

import { useEffect, useRef } from 'react';

import type { OverlayVisibility } from '../gl/overlays/frame';
import { OverlayToggles } from './OverlayToggles';
import { DEFAULT_SETTINGS, type Colormap, type FlowMapSettings } from './settings';

interface SettingsDrawerProps {
  settings: FlowMapSettings;
  onChange: (patch: Partial<FlowMapSettings>) => void;
  onClose: () => void;
}

export function SettingsDrawer({ settings, onChange, onClose }: SettingsDrawerProps): JSX.Element {
  const asideRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

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

  // Modal focus management: capture the opener, move focus inside on open, and
  // restore it on close (WCAG 2.4.3).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // Trap Tab / Shift+Tab within the drawer while it is open.
  const onTrapKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const aside = asideRef.current;
    if (!aside) return;
    const focusable = aside.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !aside.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const toggleOverlay = (key: keyof OverlayVisibility): void => {
    onChange({ overlays: { ...settings.overlays, [key]: !settings.overlays[key] } });
  };

  const restoreDefaults = (): void => {
    onChange({ ...DEFAULT_SETTINGS, overlays: { ...DEFAULT_SETTINGS.overlays } });
  };

  return (
    <>
      <div className="drawer-scrim" onMouseDown={onClose} data-testid="settings-scrim" />
      <aside
        ref={asideRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="settings"
        data-testid="settings-drawer"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onTrapKeyDown}
      >
        <header className="drawer__header">
          <span className="drawer__title">Settings</span>
          <button
            ref={closeRef}
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
          <span className="drawer__section" data-testid="section-display">
            Display
          </span>

          {/* heatmap contrast (drives the perceptual display gamma; live) */}
          <div className="setting">
            <span className="setting__label">
              Contrast
              <span className="setting__value">{settings.contrast}</span>
            </span>
            <input
              type="range"
              className="range"
              min={0}
              max={100}
              step={1}
              value={settings.contrast}
              aria-label="Heatmap contrast"
              aria-valuetext={`${settings.contrast}`}
              data-testid="setting-contrast"
              onChange={(e) => onChange({ contrast: Number(e.target.value) })}
            />
            <span className="setting__hint">
              Lifts the mid-density field vs. the brightest walls — higher is punchier.
            </span>
          </div>

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
              aria-label="Normalization percentile"
              aria-valuetext={`p${settings.normPercentile}`}
              data-testid="setting-normPercentile"
              onChange={(e) => onChange({ normPercentile: Number(e.target.value) })}
            />
            <span className="setting__hint">Higher percentile → dimmer, more dynamic-range headroom.</span>
          </div>

          <span className="drawer__section" data-testid="section-trades">
            Trades
          </span>

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
              aria-label="Tick grouping"
              aria-valuetext={`${settings.tickGrouping} row${settings.tickGrouping === 1 ? '' : 's'} / cell`}
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
              aria-label="Bubble size threshold"
              aria-valuetext={settings.bubbleMinSize > 0 ? `≥ ${settings.bubbleMinSize}` : 'all trades'}
              data-testid="setting-bubble"
              onChange={(e) => onChange({ bubbleMinSize: Number(e.target.value) })}
            />
          </div>

          <span className="drawer__section" data-testid="section-view">
            View
          </span>

          {/* follow mode */}
          <button
            type="button"
            role="switch"
            aria-checked={settings.follow}
            className={`check${settings.follow ? ' is-on' : ''}`}
            data-testid="toggle-follow"
            onClick={() => onChange({ follow: !settings.follow })}
          >
            Follow live edge
            <span className="check__box" aria-hidden="true" />
          </button>

          {/* right rail */}
          <button
            type="button"
            role="switch"
            aria-checked={settings.railVisible}
            className={`check${settings.railVisible ? ' is-on' : ''}`}
            data-testid="toggle-rail"
            onClick={() => onChange({ railVisible: !settings.railVisible })}
          >
            Right rail (DOM + tape)
            <span className="check__box" aria-hidden="true" />
          </button>

          <span className="drawer__section" data-testid="section-overlays">
            Overlays
          </span>

          {/* overlays */}
          <div className="setting">
            <OverlayToggles visibility={settings.overlays} onToggle={toggleOverlay} />
          </div>

          {/* restore defaults */}
          <button
            type="button"
            className="drawer__restore"
            data-testid="settings-restore"
            onClick={restoreDefaults}
          >
            Restore defaults
          </button>
        </div>
      </aside>
    </>
  );
}
