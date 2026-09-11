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
import { LOCALES, getLocale, localeLabel, setLocale } from '../i18n';
import { useT } from '../i18n/useT';
import { THEME_IDS, THEMES, useTheme } from '../theme';
import { toggleDrawToolbar, useDrawingsStore } from '../drawings/store';
import { useIndicatorStore } from '../indicators/store';
import { isTopOverlay, pushOverlay } from './overlayStack';
import { toggleIndicatorPicker } from './IndicatorPicker';
import { openOnboarding } from './OnboardingCard';
import { OverlayToggles } from './OverlayToggles';
import { KEYSHEET } from './keysheet';
import {
  DEFAULT_SETTINGS,
  DEPTH_CHANNELS,
  HISTORY_DEPTHS,
  PRICE_BANDS,
  type Colormap,
  type DepthChannelMode,
  type FlowMapSettings,
  type HistoryDepth,
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

/** Human labels for the depth display channel (contract C2). */
const CHANNEL_LABEL: Record<DepthChannelMode, string> = {
  sum: 'Sum',
  bid: 'Bid',
  ask: 'Ask',
  imbalance: 'Imbalance',
};
const CHANNEL_HINT: Record<DepthChannelMode, string> = {
  sum: 'Bid + ask intensity in one view — the default rendering.',
  bid: 'Resting BID size only — read accumulation and support walls.',
  ask: 'Resting ASK size only — read supply and resistance walls.',
  imbalance: 'Signed (bid−ask)/(bid+ask) per cell: one end of the ramp is bid-heavy, the other ask-heavy, so one-sided walls stand out immediately. Cycles with C.',
};

/** Human labels for the first-launch history-depth choices. */
const HISTORY_LABEL: Record<HistoryDepth, string> = {
  off: 'Off',
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
  max: 'Max',
};

/**
 * The keyboard surface lives in ui/keysheet.ts, SHARED with the `?` shortcuts
 * overlay so the drawer and the overlay can never drift apart. Every entry is a
 * binding that actually exists in code (input/keys.ts, input/gestures.ts, the
 * App-level `?` toggle) — no aspirational ones.
 */

interface SettingsDrawerProps {
  settings: FlowMapSettings;
  onChange: (patch: Partial<FlowMapSettings>) => void;
  onClose: () => void;
}

export function SettingsDrawer({ settings, onChange, onClose }: SettingsDrawerProps): JSX.Element {
  const t = useT(); // re-renders on locale change (i18n shell pass)
  const { theme, setTheme } = useTheme();
  const toolbarVisible = useDrawingsStore((s) => s.toolbarVisible);
  const pickerOpen = useIndicatorStore((s) => s.pickerOpen);
  const asideRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Esc closes the drawer — but only when the drawer is the TOPMOST open
  // overlay. If the `?` shortcuts overlay sits above it, that overlay's own
  // Escape handler owns the keystroke; `stopPropagation` cannot express this
  // between two listeners on the same window target (see ui/overlayStack.ts).
  useEffect(() => {
    const off = pushOverlay('settings');
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isTopOverlay('settings')) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      off();
    };
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
          <span className="drawer__title">{t('drawer.title')}</span>
          <button
            ref={closeRef}
            type="button"
            className="drawer__close"
            onClick={onClose}
            data-testid="settings-close"
            aria-label={t('drawer.close')}
          >
            ✕
          </button>
        </header>

        <div className="drawer__body">
          <span className="drawer__section" data-testid="section-appearance">
            Appearance
          </span>

          {/* theme picker (lane CE registry; T cycles, this pins a choice) */}
          <div className="setting">
            <span className="setting__label">{t('settings.theme')}</span>
            <div className="segrow" role="group" aria-label="theme" data-testid="setting-theme">
              {THEME_IDS.map((id) => (
                <button
                  type="button"
                  key={id}
                  className={`segrow__btn${theme === id ? ' is-on' : ''}`}
                  aria-pressed={theme === id}
                  data-testid={`theme-${id}`}
                  onClick={() => setTheme(id)}
                >
                  {THEMES[id].label}
                </button>
              ))}
            </div>
            <span className="setting__hint">
              {`${THEMES[theme].label} · ${THEMES[theme].mode} — ${THEMES[theme].cvd}`}
            </span>
          </div>

          {/* language picker (i18n shell: EN default + TR). useT() above makes
              the whole drawer re-render the moment setLocale lands. */}
          <div className="setting">
            <span className="setting__label">{t('settings.language')}</span>
            <div className="segrow" role="group" aria-label="language" data-testid="setting-locale">
              {LOCALES.map((l) => (
                <button
                  type="button"
                  key={l}
                  className={`segrow__btn${getLocale() === l ? ' is-on' : ''}`}
                  aria-pressed={getLocale() === l}
                  data-testid={`locale-${l}`}
                  onClick={() => setLocale(l)}
                >
                  {localeLabel(l)}
                </button>
              ))}
            </div>
          </div>

          {/* panel toggles — surfaces whose setters live in the feature stores */}
          <button
            type="button"
            role="switch"
            aria-checked={settings.hudVisible}
            className={`check${settings.hudVisible ? ' is-on' : ''}`}
            data-testid="toggle-hud"
            onClick={() => onChange({ hudVisible: !settings.hudVisible })}
          >
            Perf HUD (H)
            <span className="check__box" aria-hidden="true" />
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={toolbarVisible}
            className={`check${toolbarVisible ? ' is-on' : ''}`}
            data-testid="toggle-draw-toolbar"
            onClick={toggleDrawToolbar}
          >
            Draw toolbar (D)
            <span className="check__box" aria-hidden="true" />
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={pickerOpen}
            className={`check${pickerOpen ? ' is-on' : ''}`}
            data-testid="toggle-indicator-picker"
            onClick={toggleIndicatorPicker}
          >
            Indicator picker (I)
            <span className="check__box" aria-hidden="true" />
          </button>

          {/* re-run the first-run wizard (Skip/Done persist; Esc only hides) */}
          <button
            type="button"
            className="drawer__restore"
            data-testid="show-onboarding"
            onClick={openOnboarding}
          >
            Show onboarding tour
          </button>

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
              aria-label={t('settings.contrast')}
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
            <span className="setting__label">{t('settings.colormap')}</span>
            <div className="segrow" role="group" aria-label="colormap" data-testid="setting-colormap">
              {(['flow', 'inferno', 'classic'] as Colormap[]).map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`segrow__btn${settings.colormap === c ? ' is-on' : ''}`}
                  aria-pressed={settings.colormap === c}
                  data-testid={`colormap-${c}`}
                  onClick={() => onChange({ colormap: c })}
                >
                  {c === 'flow' ? 'Flow' : c === 'inferno' ? 'Inferno' : 'Classic'}
                </button>
              ))}
            </div>
            <span className="setting__hint">
              Flow keeps the field dark and lets walls earn warm gold; Inferno
              separates size by hue (indigo → red → gold); Classic is the legacy
              blue→cyan→yellow ramp. Synthetic depth always stays amber.
            </span>
          </div>

          {/* depth display channel (contract C2) — applied via renderer.setDepthChannel */}
          <div className="setting">
            <span className="setting__label">Depth channel</span>
            <div className="segrow" role="group" aria-label="depth channel" data-testid="setting-depthChannel">
              {DEPTH_CHANNELS.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`segrow__btn${settings.depthChannel === c ? ' is-on' : ''}`}
                  aria-pressed={settings.depthChannel === c}
                  data-testid={`depthChannel-${c}`}
                  onClick={() => onChange({ depthChannel: c })}
                >
                  {CHANNEL_LABEL[c]}
                </button>
              ))}
            </div>
            <span className="setting__hint">{CHANNEL_HINT[settings.depthChannel]}</span>
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
              min={80}
              max={100}
              step={0.5}
              value={settings.normPercentile}
              aria-label={t('settings.normalization')}
              aria-valuetext={`p${settings.normPercentile}`}
              data-testid="setting-normPercentile"
              onChange={(e) => onChange({ normPercentile: Number(e.target.value) })}
            />
            <span className="setting__hint">
              White point: the density percentile mapped to full brightness. Lower (p80) makes
              the field punchy and saturated; higher (p100) is dim with more headroom.
            </span>
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
              aria-label={t('settings.tolerance')}
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
              aria-label={t('settings.tickGrouping')}
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
              aria-label={t('settings.bubbleThreshold')}
              aria-valuetext={settings.bubbleMinSize > 0 ? `≥ ${settings.bubbleMinSize}` : 'all trades'}
              data-testid="setting-bubble"
              onChange={(e) => onChange({ bubbleMinSize: Number(e.target.value) })}
            />
          </div>

          {/* big-trade tape highlight — absolute USD notional, 0 = off */}
          <div className="setting">
            <span className="setting__label">
              Big trade size
              <span className="setting__value">
                {settings.bigTradeUsd > 0
                  ? `≥ $${Math.round(settings.bigTradeUsd).toLocaleString('en-US')}`
                  : 'off'}
              </span>
            </span>
            <input
              type="number"
              className="setting__num"
              min={0}
              step={1000}
              value={settings.bigTradeUsd}
              aria-label={t('settings.bigTrade')}
              data-testid="setting-bigTradeUsd"
              onChange={(e) => {
                const n = Number(e.target.value);
                // Same ceiling normalizeSettings applies on load, so the live
                // value and the next load agree.
                onChange({
                  bigTradeUsd: Number.isFinite(n) && n > 0 ? Math.min(n, 1e9) : 0,
                });
              }}
            />
            <span className="setting__hint">
              Highlights tape rows at or above this notional (price × size, USD). 0 turns the
              highlight off.
            </span>
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
            <span className="setting__label">{t('settings.priceRange')}</span>
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

          {/* first-launch history depth */}
          <div className="setting">
            <span className="setting__label">{t('settings.historyDepth')}</span>
            <div className="segrow" role="group" aria-label="history depth" data-testid="setting-historyDepth">
              {HISTORY_DEPTHS.map((d) => (
                <button
                  type="button"
                  key={d}
                  className={`segrow__btn${settings.historyDepth === d ? ' is-on' : ''}`}
                  aria-pressed={settings.historyDepth === d}
                  data-testid={`historyDepth-${d}`}
                  onClick={() => onChange({ historyDepth: d })}
                >
                  {HISTORY_LABEL[d]}
                </button>
              ))}
            </div>
            <span className="setting__hint">
              How much past data to pull into the chart when a symbol loads. Applies on the next
              symbol switch or reload. Bounded by what the server retains.
            </span>
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
            {t('settings.overlays')}
          </span>

          {/* overlays */}
          <div className="setting">
            <OverlayToggles visibility={settings.overlays} onToggle={toggleOverlay} />
          </div>

          {/* keyboard reference — every binding verified against the code */}
          <span className="drawer__section" data-testid="section-keys">
            Keyboard
          </span>
          <div className="keysheet" data-testid="keysheet">
            {KEYSHEET.map((entry) => (
              <div key={entry.keys} className="keysheet__row">
                <kbd className="keysheet__keys">{entry.keys}</kbd>
                <span className="keysheet__action">{entry.action}</span>
              </div>
            ))}
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
