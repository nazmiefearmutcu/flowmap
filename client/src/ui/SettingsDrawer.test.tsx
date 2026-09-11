import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, describe, expect, it } from 'vitest';

import { resetDrawingsForTest } from '../drawings/store';
import { resetIndicatorStoreForTest } from '../indicators/store';
import { setLocale } from '../i18n';
import { setTheme } from '../theme';
import { closeOnboarding, isOnboardingOpen } from './OnboardingCard';
import { SettingsDrawer } from './SettingsDrawer';
import { DEFAULT_SETTINGS, type FlowMapSettings } from './settings';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function settings(over: Partial<FlowMapSettings> = {}): FlowMapSettings {
  return { ...DEFAULT_SETTINGS, overlays: { ...DEFAULT_SETTINGS.overlays }, ...over };
}

function render(node: JSX.Element): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  const handle = { container, root };
  mounted.push(handle);
  return handle;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
});

describe('SettingsDrawer switches', () => {
  it('renders Follow / Right-rail as focusable role=switch buttons that announce state', () => {
    const { container } = render(
      <SettingsDrawer settings={settings({ follow: true, railVisible: false })} onChange={() => {}} onClose={() => {}} />,
    );
    const follow = container.querySelector('[data-testid="toggle-follow"]')!;
    const rail = container.querySelector('[data-testid="toggle-rail"]')!;
    expect(follow.tagName).toBe('BUTTON');
    expect(follow.getAttribute('role')).toBe('switch');
    expect(follow.getAttribute('aria-checked')).toBe('true');
    expect(rail.getAttribute('role')).toBe('switch');
    expect(rail.getAttribute('aria-checked')).toBe('false');
  });

  it('toggling a switch flips the setting via onChange', () => {
    const patches: Array<Partial<FlowMapSettings>> = [];
    const { container } = render(
      <SettingsDrawer settings={settings({ follow: true })} onChange={(p) => patches.push(p)} onClose={() => {}} />,
    );
    click(container.querySelector('[data-testid="toggle-follow"]')!);
    expect(patches).toEqual([{ follow: false }]);
  });
});

describe('SettingsDrawer focus management', () => {
  it('is aria-modal and moves focus to the close button on open', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { container } = render(
      <SettingsDrawer settings={settings()} onChange={() => {}} onClose={() => {}} />,
    );
    const aside = container.querySelector('[data-testid="settings-drawer"]')!;
    expect(aside.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(container.querySelector('[data-testid="settings-close"]'));
    opener.remove();
  });

  it('restores focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const handle = render(
      <SettingsDrawer settings={settings()} onChange={() => {}} onClose={() => {}} />,
    );
    act(() => handle.root.unmount());
    handle.container.remove();
    mounted.pop();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('SettingsDrawer range accessibility', () => {
  it('labels each range and mirrors the readout in aria-valuetext', () => {
    const { container } = render(
      <SettingsDrawer
        settings={settings({ normPercentile: 95, tickGrouping: 3, bubbleMinSize: 0 })}
        onChange={() => {}}
        onClose={() => {}}
      />,
    );
    const norm = container.querySelector('[data-testid="setting-normPercentile"]')!;
    const tick = container.querySelector('[data-testid="setting-tickGrouping"]')!;
    const bubble = container.querySelector('[data-testid="setting-bubble"]')!;
    // i18n pass (MIGRATION.md): the aria label moved onto the shared
    // settings.normalization key (EN text 'Normalization').
    expect(norm.getAttribute('aria-label')).toBe('Normalization');
    expect(norm.getAttribute('aria-valuetext')).toBe('p95');
    expect(tick.getAttribute('aria-label')).toBe('Tick grouping');
    expect(tick.getAttribute('aria-valuetext')).toBe('3 rows / cell');
    expect(bubble.getAttribute('aria-label')).toBe('Bubble size threshold');
    expect(bubble.getAttribute('aria-valuetext')).toBe('all trades');
  });
});

describe('SettingsDrawer restore defaults', () => {
  it('emits a fresh deep copy of DEFAULT_SETTINGS', () => {
    const patches: Array<Partial<FlowMapSettings>> = [];
    const { container } = render(
      <SettingsDrawer
        settings={settings({ colormap: 'classic', follow: false })}
        onChange={(p) => patches.push(p)}
        onClose={() => {}}
      />,
    );
    click(container.querySelector('[data-testid="settings-restore"]')!);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual(DEFAULT_SETTINGS);
    // deep copy — overlays object is not the module singleton
    expect((patches[0] as FlowMapSettings).overlays).not.toBe(DEFAULT_SETTINGS.overlays);
  });
});

describe('SettingsDrawer big-trade threshold', () => {
  /** React-native value assignment (bypasses the tracked value setter). */
  function typeNumber(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('announces itself and emits a clamped bigTradeUsd patch on change', () => {
    const patches: Array<Partial<FlowMapSettings>> = [];
    const { container } = render(
      <SettingsDrawer settings={settings({ bigTradeUsd: 0 })} onChange={(p) => patches.push(p)} onClose={() => {}} />,
    );
    const num = container.querySelector('[data-testid="setting-bigTradeUsd"]') as HTMLInputElement;
    expect(num).not.toBeNull();
    expect(num.getAttribute('aria-label')).toBe('Big trade size (USD, 0 = off)');

    typeNumber(num, '25000');
    expect(patches).toEqual([{ bigTradeUsd: 25000 }]);

    // Junk / empty clears to 0 — the documented OFF value, never NaN.
    typeNumber(num, '');
    expect(patches[1]).toEqual({ bigTradeUsd: 0 });
  });

  it('labels the value "off" at 0 and shows the notional once set (with the hint)', () => {
    const off = render(<SettingsDrawer settings={settings({ bigTradeUsd: 0 })} onChange={() => {}} onClose={() => {}} />);
    const offInput = off.container.querySelector('[data-testid="setting-bigTradeUsd"]')!;
    expect(offInput.parentElement!.textContent).toContain('off');
    expect(offInput.parentElement!.textContent).toContain('Highlights tape rows');

    const on = render(<SettingsDrawer settings={settings({ bigTradeUsd: 50000 })} onChange={() => {}} onClose={() => {}} />);
    const onInput = on.container.querySelector('[data-testid="setting-bigTradeUsd"]')!;
    expect(onInput.parentElement!.textContent).toContain('≥ $50,000');
  });
});

describe('SettingsDrawer sections', () => {
  it('labels the drawer sections', () => {
    const { container } = render(
      <SettingsDrawer settings={settings()} onChange={() => {}} onClose={() => {}} />,
    );
    for (const id of ['section-display', 'section-trades', 'section-view', 'section-overlays']) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });
});

describe('SettingsDrawer depth channel (contract C2)', () => {
  it('renders a segmented control with the four channel modes, marking the active one', () => {
    const { container } = render(
      <SettingsDrawer settings={settings({ depthChannel: 'bid' })} onChange={() => {}} onClose={() => {}} />,
    );
    const group = container.querySelector('[data-testid="setting-depthChannel"]')!;
    const buttons = group.querySelectorAll('button');
    expect([...buttons].map((b) => b.textContent)).toEqual(['Sum', 'Bid', 'Ask', 'Imbalance']);
    expect(
      [...buttons].map((b) => b.getAttribute('aria-pressed')),
    ).toEqual(['false', 'true', 'false', 'false']);
  });

  it('emits a depthChannel patch on click and describes the active mode honestly', () => {
    const patches: Array<Partial<FlowMapSettings>> = [];
    const { container } = render(
      <SettingsDrawer
        settings={settings({ depthChannel: 'sum' })}
        onChange={(p) => patches.push(p)}
        onClose={() => {}}
      />,
    );
    click(container.querySelector('[data-testid="depthChannel-imbalance"]')!);
    expect(patches).toEqual([{ depthChannel: 'imbalance' }]);

    // The hint describes the ACTIVE mode; imbalance names both extremes.
    const hint = container.querySelector('[data-testid="setting-depthChannel"]')
      ?.parentElement?.textContent;
    expect(hint).toContain('Bid + ask intensity'); // sum hint on a default drawer
  });

  it('the imbalance hint keeps neutral, hue-independent wording', () => {
    const { container } = render(
      <SettingsDrawer settings={settings({ depthChannel: 'imbalance' })} onChange={() => {}} onClose={() => {}} />,
    );
    const text = container.querySelector('[data-testid="setting-depthChannel"]')
      ?.parentElement?.textContent!;
    expect(text).toContain('bid-heavy');
    expect(text).toContain('ask-heavy');
  });
});

describe('SettingsDrawer appearance section (INT mount)', () => {
  afterEach(() => {
    setLocale('en');
    setTheme('midnight');
    resetDrawingsForTest();
    resetIndicatorStoreForTest();
    closeOnboarding();
  });

  it('lists the theme registry and pins a choice through setTheme', () => {
    const { container } = render(<SettingsDrawer settings={settings()} onChange={() => {}} onClose={() => {}} />);
    const row = container.querySelector('[data-testid="setting-theme"]')!;
    const ids = ['midnight', 'paper', 'swiss', 'amber', 'sea'];
    for (const id of ids) expect(row.querySelector(`[data-testid="theme-${id}"]`)).not.toBeNull();
    expect(row.querySelector('[data-testid="theme-midnight"]')!.getAttribute('aria-pressed')).toBe('true');

    click(row.querySelector('[data-testid="theme-paper"]')!);
    expect(document.documentElement.dataset.theme).toBe('paper');
    expect(row.querySelector('[data-testid="theme-paper"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('switches the locale to TR and re-renders the drawer through t()', () => {
    const { container } = render(<SettingsDrawer settings={settings()} onChange={() => {}} onClose={() => {}} />);
    expect(container.querySelector('[data-testid="locale-tr"]')).not.toBeNull();
    click(container.querySelector('[data-testid="locale-tr"]')!);
    expect(container.querySelector('[data-testid="section-overlays"]')!.textContent).toBe('Katmanlar');
    expect(container.querySelector('[data-testid="locale-tr"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('toggles the perf HUD through the settings patch', () => {
    const patches: Array<Partial<FlowMapSettings>> = [];
    const { container } = render(
      <SettingsDrawer settings={settings({ hudVisible: false })} onChange={(p) => patches.push(p)} onClose={() => {}} />,
    );
    click(container.querySelector('[data-testid="toggle-hud"]')!);
    expect(patches).toEqual([{ hudVisible: true }]);
  });

  it('toggles the draw toolbar and indicator picker through their stores', () => {
    const { container } = render(<SettingsDrawer settings={settings()} onChange={() => {}} onClose={() => {}} />);
    const toolbar = container.querySelector('[data-testid="toggle-draw-toolbar"]')!;
    const picker = container.querySelector('[data-testid="toggle-indicator-picker"]')!;
    expect(toolbar.getAttribute('aria-checked')).toBe('false');
    expect(picker.getAttribute('aria-checked')).toBe('false');

    click(toolbar);
    click(picker);
    expect(toolbar.getAttribute('aria-checked')).toBe('true');
    expect(picker.getAttribute('aria-checked')).toBe('true');
  });

  it('re-opens the onboarding tour from the drawer', () => {
    const { container } = render(<SettingsDrawer settings={settings()} onChange={() => {}} onClose={() => {}} />);
    expect(isOnboardingOpen()).toBe(false);
    click(container.querySelector('[data-testid="show-onboarding"]')!);
    expect(isOnboardingOpen()).toBe(true);
  });
});
