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
import {
  DEFAULT_SETTINGS,
  PRICE_BANDS,
  type Colormap,
  type FlowMapSettings,
  type PriceBand,
} from './settings';

/** Human labels + the honest trade-off for each server price band (§8.1). */
const BAND_LABEL: Record<PriceBand, string> = {
  native: 'Native',
  wide: '±50%',
  full: '−100/+1000%',
  deep: 'Deep',
};
const BAND_HINT: Record<PriceBand, string> = {
  native: 'Finest price rows, narrowest coverage — the trading default.',
  wide: 'About 50× coarser rows; far-out resting size becomes visible.',
  full: 'Range SCAN only: rows get so coarse the live book collapses to a few of them.',
  deep: 'Full ladder resolution near the price AND coverage to −99%/+1000%. The frame is fixed for the session, so a sustained move walks the book out into the coarse wings until you reconnect.',
};

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
              {(['inferno', 'classic'] as Colormap[]).map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`segrow__btn${settings.colormap === c ? ' is-on' : ''}`}
                  aria-pressed={settings.colormap === c}
                  data-testid={`colormap-${c}`}
                  onClick={() => onChange({ colormap: c })}
                >
                  {c === 'inferno' ? 'Inferno' : 'Classic'}
                </button>
              ))}
            </div>
            <span className="setting__hint">
              Inferno separates size by hue (indigo → red → gold → white); Classic is the
              legacy blue→cyan→white ramp. Synthetic depth always stays amber.
            </span>
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

          {/* heatmap tolerance — the black point on normalized density (live) */}
          <div className="setting">
            <span className="setting__label">
              Tolerance
              <span className="setting__value">
                {settings.tolerance > 0 ? settings.tolerance : 'off'}
              </span>
            </span>
            <input
              type="range"
              className="range"
              min={0}
              max={100}
              step={1}
              value={settings.tolerance}
              aria-label="Heatmap tolerance"
              aria-valuetext={settings.tolerance > 0 ? `${settings.tolerance}` : 'off'}
              data-testid="setting-tolerance"
              onChange={(e) => onChange({ tolerance: Number(e.target.value) })}
            />
            <span className="setting__hint">
              Black point: hides cells below this share of the viewport&rsquo;s density
              percentile, so only liquidity worth reading paints. It is relative to what is
              on screen, not a fixed lot size.
            </span>
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
            Follow live edge (time)
            <span className="check__box" aria-hidden="true" />
          </button>

          {/* price auto-follow */}
          <button
            type="button"
            role="switch"
            aria-checked={settings.followPrice}
            className={`check${settings.followPrice ? ' is-on' : ''}`}
            data-testid="toggle-follow-price"
            onClick={() => onChange({ followPrice: !settings.followPrice })}
          >
            Track price (keeps your zoom)
            <span className="check__box" aria-hidden="true" />
          </button>

          {/* server price band — changing it re-subscribes */}
          <div className="setting">
            <span className="setting__label">Price range</span>
            <div className="segrow" role="group" aria-label="price range" data-testid="setting-priceBand">
              {PRICE_BANDS.map((b) => (
                <button
                  type="button"
                  key={b}
                  className={`segrow__btn${settings.priceBand === b ? ' is-on' : ''}`}
                  aria-pressed={settings.priceBand === b}
                  data-testid={`priceBand-${b}`}
                  onClick={() => onChange({ priceBand: b })}
                >
                  {BAND_LABEL[b]}
                </button>
              ))}
            </div>
            <span className="setting__hint">{BAND_HINT[settings.priceBand]}</span>
          </div>

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
