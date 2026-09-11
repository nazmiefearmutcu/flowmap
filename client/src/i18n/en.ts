/**
 * English string table (lane CE, C7) — the SOURCE OF TRUTH for shell keys.
 * Every key lives here; `tr.ts` may omit keys (lookup falls back to English).
 * Feature panes stay English by design (contract C7) — do not add
 * feature-pane strings here without a shell reason.
 */
export const en: Record<string, string> = {
  // --- brand (never translated; doubles as the TR→EN fallback case) ---
  'app.title': 'FlowMap',

  // --- TopBar ---
  'topbar.searchPlaceholder': 'Search symbols',
  'topbar.live': 'Live',
  'topbar.replay': 'Replay',
  'topbar.liveOrReplay': 'live or replay',
  'topbar.noCaps': 'NO CAPS',
  'topbar.settings': 'settings',
  'topbar.exportPng': 'Export PNG',
  'topbar.exportPngHint': 'export chart as PNG (E)',
  'topbar.toggleRail': 'toggle DOM ladder / tape rail',
  'topbar.dismissNotice': 'dismiss export notice',

  // --- SettingsDrawer ---
  'drawer.title': 'Settings',
  'drawer.close': 'close settings',
  'settings.colormap': 'Colormap',
  'settings.contrast': 'Contrast',
  'settings.tolerance': 'Tolerance',
  'settings.normalization': 'Normalization',
  'settings.tickGrouping': 'Tick grouping',
  'settings.bubbleThreshold': 'Bubble size threshold',
  'settings.bigTrade': 'Big trade size (USD, 0 = off)',
  'settings.priceRange': 'Price range',
  'settings.historyDepth': 'History on launch',
  'settings.overlays': 'Overlays',
  'settings.follow': 'Follow',
  'settings.theme': 'Theme',
  'settings.language': 'Language',

  // --- banners (reconnect / closed) ---
  'banner.reconnecting': 'Reconnecting…',
  'banner.reasonDropped': 'connection dropped',
  'banner.reasonShutdown': 'server shut down',
  'banner.reasonSession': 'server closed the session',
  'banner.reasonOverloaded': 'server overloaded',
  'banner.reasonCode': 'server closed (code {code})',
  'banner.closed': 'MARKET CLOSED',
  'banner.opensIn': 'opens in {time}',
  'banner.noFeed': 'NO FEED',
  'banner.noFeedDetail': 'no feed available for this market',

  // --- ShortcutsOverlay ---
  'shortcuts.title': 'Keyboard shortcuts',
  'shortcuts.close': 'close shortcuts',

  // --- OnboardingCard ---
  'onboarding.title': 'Welcome to FlowMap',
  'onboarding.step.connect.title': 'Connect a market',
  'onboarding.step.connect.body':
    'Search a symbol in the top bar and pick Live or Replay — the depth heatmap starts streaming for that market.',
  'onboarding.step.mouse.title': 'Mouse & keys',
  'onboarding.step.mouse.body':
    'Drag pans the map and the wheel zooms time. Arrow keys nudge the view; + / − zoom price; F follows the live edge.',
  'onboarding.step.shortcuts.title': 'Every shortcut',
  'onboarding.step.shortcuts.body':
    'Press ? anytime for the full shortcut sheet, and T to cycle color themes.',
  'onboarding.next': 'Next',
  'onboarding.done': 'Done',
  'onboarding.skip': 'Skip',
  'onboarding.stepOf': 'Step {current} of {total}',
  'onboarding.hint': 'Esc hides this until your next visit.',

  // --- Toaster ---
  'toast.dismiss': 'Dismiss notification',
};
