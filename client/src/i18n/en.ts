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
  'topbar.png': 'PNG',
  'topbar.rail': 'Rail',
  'topbar.settingsLabel': 'Settings',
  'topbar.replayUnavailable': 'no recording — replay unavailable',
  'topbar.replayUnavailableHint':
    'This session has no recording, so the server refused Replay (close 1003). The chart re-subscribed to LIVE; switch symbols to build a recording, then try Replay again.',

  // --- SettingsDrawer ---
  'drawer.title': 'Settings',
  'drawer.close': 'close settings',
  'drawer.sectionAppearance': 'Appearance',
  'drawer.sectionDisplay': 'Display',
  'drawer.sectionTrades': 'Trades',
  'drawer.sectionView': 'View',
  'drawer.sectionAlerts': 'Alerts',
  'drawer.sectionKeyboard': 'Keyboard',
  'settings.colormap': 'Colormap',
  'settings.colormapHint':
    'Flow keeps the field dark and lets walls earn warm gold; Inferno separates size by hue (indigo → red → gold); Classic is the legacy blue→cyan→yellow ramp. Synthetic depth always stays amber.',
  'settings.contrast': 'Contrast',
  'settings.contrastHint': 'Lifts the mid-density field vs. the brightest walls — higher is punchier.',
  'settings.tolerance': 'Tolerance',
  'settings.toleranceHint':
    'Black point: hides cells below this share of the viewport’s density percentile, so only liquidity worth reading paints. It is relative to what is on screen, not a fixed lot size.',
  'settings.normalization': 'Normalization',
  'settings.normalizationHint':
    'White point: the density percentile mapped to full brightness. Lower (p80) makes the field punchy and saturated; higher (p100) is dim with more headroom.',
  'settings.tickGrouping': 'Tick grouping',
  'settings.rowsPerCell': '{n} rows / cell',
  'settings.rowsPerCellOne': '1 row / cell',
  'settings.bubble': 'Bubble threshold',
  'settings.bubbleThreshold': 'Bubble size threshold',
  'settings.allTrades': 'all trades',
  'settings.off': 'off',
  'settings.bigTrade': 'Big trade size (USD, 0 = off)',
  'settings.bigTradeLabel': 'Big trade size',
  'settings.bigTradeHint':
    'Highlights tape rows at or above this notional (price × size, USD). 0 turns the highlight off.',
  'settings.depthChannel': 'Depth channel',
  'settings.channel.sum': 'Sum',
  'settings.channel.bid': 'Bid',
  'settings.channel.ask': 'Ask',
  'settings.channel.imbalance': 'Imbalance',
  'settings.channelHint.sum': 'Bid + ask intensity in one view — the default rendering.',
  'settings.channelHint.bid': 'Resting BID size only — read accumulation and support walls.',
  'settings.channelHint.ask': 'Resting ASK size only — read supply and resistance walls.',
  'settings.channelHint.imbalance':
    'Signed (bid−ask)/(bid+ask) per cell: one end of the ramp is bid-heavy, the other ask-heavy, so one-sided walls stand out immediately. Cycles with C.',
  'settings.hud': 'Perf HUD (H)',
  'settings.drawToolbar': 'Draw toolbar (D)',
  'settings.indicatorPicker': 'Indicator picker (I)',
  'settings.showOnboarding': 'Show onboarding tour',
  'settings.follow': 'Follow',
  'settings.followLive': 'Follow live edge (time)',
  'settings.followPrice': 'Track price (keeps your zoom)',
  'settings.rightRail': 'Right rail (DOM + tape)',
  'settings.priceRange': 'Price range',
  'settings.band.native': 'Native',
  'settings.band.wide': '±50%',
  'settings.band.full': '−100/+1000%',
  'settings.band.deep': 'Deep',
  'settings.bandHint.native': 'Finest price rows, narrowest coverage — the trading default.',
  'settings.bandHint.wide': 'About 50× coarser rows; far-out resting size becomes visible.',
  'settings.bandHint.full':
    'Range SCAN only: rows get so coarse the live book collapses to a few of them.',
  'settings.bandHint.deep':
    'Full ladder resolution near the price AND coverage to −99%/+1000%. The frame is fixed for the session, so a sustained move walks the book out into the coarse wings until you reconnect.',
  'settings.historyDepth': 'History on launch',
  'settings.history.off': 'Off',
  'settings.history.1h': '1H',
  'settings.history.4h': '4H',
  'settings.history.1d': '1D',
  'settings.history.max': 'Max',
  'settings.historyHint':
    'How much past data to pull into the chart when a symbol loads. Applies on the next symbol switch or reload. Bounded by what the server retains.',
  'settings.restoreDefaults': 'Restore defaults',
  'settings.alertSound': 'Alert sound',
  'settings.alertSoundHint': 'Play a short tone when a price alert fires.',
  'settings.overlays': 'Overlays',
  'settings.theme': 'Theme',
  'settings.language': 'Language',

  // --- banners (reconnect / closed) ---
  'banner.reconnecting': 'Reconnecting…',
  'banner.lostReconnecting': 'connection lost — reconnecting to {target} · {reason}',
  'banner.theFeed': 'the feed',
  'banner.attempt': 'attempt {attempts}',
  'banner.retryNow': 'retry now',
  'banner.retryNowHint': 'skip the wait and reconnect immediately',
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
  'shortcuts.footerToggle': 'toggle',
  'shortcuts.footerClose': 'close',

  // --- keysheet (shared by ShortcutsOverlay + SettingsDrawer) ---
  'keysheet.space': 'follow live edge · play/pause in replay',
  'keysheet.slash': '⌘K / Ctrl-K — symbol search',
  'keysheet.export': 'export the chart as a PNG download',
  'keysheet.measure': 'measure tool — drag on the chart for Δprice / Δtime / Δdepth',
  'keysheet.alert': 'price alert at the crosshair price (list: bell button on the chart)',
  'keysheet.hud': 'perf HUD — fps / frame ms / uploads / draws / cache',
  'keysheet.channel': 'cycle depth channel: sum → bid → ask → imbalance',
  'keysheet.theme': 'cycle color theme: midnight → paper → swiss → amber → sea → paper-deut → contrast',
  'keysheet.draw': 'toggle the draw toolbar (trendline · hline · ray · rect · fib · text)',
  'keysheet.indicator': 'toggle the indicator picker',
  'keysheet.delete': 'delete the selected drawing',
  'keysheet.undo': 'undo drawings · Ctrl+Shift+Z / Ctrl+Y redo',
  'keysheet.help': 'toggle this shortcuts overlay',
  'keysheet.pan': 'pan time / price (chart focused)',
  'keysheet.zoom': 'zoom time (chart focused)',
  'keysheet.follow': 'toggle time follow (chart focused)',
  'keysheet.priceTrack': 'price track on/off · Shift+P re-fit',
  'keysheet.liveEdge': 'return to the live edge',
  'keysheet.escape': 'close dialogs (search · settings · this overlay) · cancel a measure drag · cancel / deselect a drawing',
  'keysheet.axis': 'price zoom / scale · dbl-click re-fit',

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
