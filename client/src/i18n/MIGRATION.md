# i18n MIGRATION.md — shell components → keys (lane CE, contract C7)

The i18n module (`client/src/i18n/`) ships EN + TR tables for SHELL strings
only. **No existing component was edited by lane CE** (out of zone). This file
is the recipe for INT / future waves to convert each component. Pattern:

```tsx
import { useT } from '../i18n/useT';
// inside the component:
const t = useT();
// <button aria-label={t('drawer.close')}>
```

Non-React modules (e.g. `closeReasonText`) import `{ t }` from `../i18n`
directly. Fallback rules: missing TR entry → English; unknown key → the key
itself, so conversion can proceed key-by-key without breakage.

## Keys by component

### `ui/TopBar.tsx`
| Current literal | Key |
|---|---|
| search placeholder "Search symbols" | `topbar.searchPlaceholder` |
| Live segment | `topbar.live` |
| Replay segment | `topbar.replay` |
| group aria "live or replay" | `topbar.liveOrReplay` |
| "NO CAPS" chip | `topbar.noCaps` |
| settings button title "settings" | `topbar.settings` |
| "Export PNG" aria | `topbar.exportPng` |
| "export chart as PNG (E)" title | `topbar.exportPngHint` |
| "toggle DOM ladder / tape rail" title | `topbar.toggleRail` |
| "dismiss export notice" aria | `topbar.dismissNotice` |

### `ui/SettingsDrawer.tsx`
| Current literal | Key |
|---|---|
| "Settings" title | `drawer.title` |
| "close settings" aria | `drawer.close` |
| "Colormap" label | `settings.colormap` |
| "Heatmap contrast" aria | `settings.contrast` |
| "Heatmap tolerance" aria | `settings.tolerance` |
| "Normalization percentile" aria | `settings.normalization` |
| "Tick grouping" aria | `settings.tickGrouping` |
| "Bubble size threshold" aria | `settings.bubbleThreshold` |
| "Big trade size (USD, 0 = off)" aria | `settings.bigTrade` |
| "Price range" label | `settings.priceRange` |
| "History on launch" label | `settings.historyDepth` |

Suggested NEW drawer sections (INT): theme picker → `settings.theme`,
language picker → `settings.language`, overlays → `settings.overlays`,
follow → `settings.follow`.

### `ui/ClosedBanner.tsx`
| Current literal | Key |
|---|---|
| "Market closed" aria | `banner.closed` (label text is the same key) |
| "No feed for this market" aria | `banner.noFeedDetail` |
| "NO FEED" label | `banner.noFeed` |
| "opens in HH:MM:SS" | `banner.opensIn` + `{time}` var |

### `ui/ReconnectBanner.tsx`
| Current literal (`closeReasonText`) | Key |
|---|---|
| "connection dropped" | `banner.reasonDropped` |
| "server shut down" | `banner.reasonShutdown` |
| "server closed the session" | `banner.reasonSession` |
| "server overloaded" | `banner.reasonOverloaded` |
| "server closed (code N)" | `banner.reasonCode` + `{code}` var |
| "Reconnecting…" prefix | `banner.reconnecting` |

### `ui/ShortcutsOverlay.tsx`
| Current literal | Key |
|---|---|
| "Keyboard shortcuts" title | `shortcuts.title` |
| "close shortcuts" aria | `shortcuts.close` |
| "keyboard shortcuts" aria-label | `shortcuts.title` |

### `ui/Toaster.tsx` (lane CE — already converted)
- `toast.dismiss` — close-button aria label.

### `ui/OnboardingCard.tsx` (lane CE — already converted)
- `onboarding.title`, `onboarding.step.connect.title|body`,
  `onboarding.step.mouse.title|body`, `onboarding.step.shortcuts.title|body`,
  `onboarding.next`, `onboarding.done`, `onboarding.skip`,
  `onboarding.stepOf` (`{current}`, `{total}`), `onboarding.hint`.

## Rules
- EN table (`i18n/en.ts`) is the source of truth: every key exists there.
- TR table (`i18n/tr.ts`) may omit keys — never render a bare key.
- Locale persists in `flowmap.locale`; boot calls `initLocale()` (see
  MOUNT-SNIPPET-CE in `lane-CE.md`).
- Feature panes (drawings, indicators, alerts…) stay English per C7.
