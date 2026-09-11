# Roadmap

Status labels are honest: **shipped** means it is in the current build,
**planned** means designed/surveyed with intent to build, **exploring** means
the shape is not settled. Nothing here is a promise of a date.

## Near-term (candidates for the next campaigns)

These are the items deliberately deferred from the 2026-09-10 campaign, in
rough priority order:

- **Windowed replay** — *planned, designed.* Subscribe with a `start`/`end`
  range so replay boots mid-recording without reading whole parquet parts. The
  wire and API halves are specced; it needs one core-side accessor (see the
  campaign's `NEEDS-CORE` notes) before it can compose.
- **Multi-chart layouts (1 / 2 / 4) with crosshair sync** — *planned.* Grid
  slots, each with its own market:symbol + camera, synced crosshair for
  basis/spread comparison. Design must respect WebGL context limits and the
  current session/band re-subscribe semantics.
- **Watchlist + favorites panel** — *planned.* Persistent rows polling the
  existing `GET /api/quote`, favorites/groups, momentum and volume badges,
  per-row sparkline; merges with the symbol-search recents store.
- **Alert sound + smarter re-arm** — *planned.* Optional WebAudio tone on alert
  fire (today: visual pulse + toast only), and a hysteresis/re-arm band beyond
  the current 60-second snooze so a price hovering at the level does not spam.
- **i18n for feature panes** — *planned.* The English/Turkish translation
  layer currently covers the shell (top bar, drawer, banners, shortcuts,
  onboarding, toasts); the drawing, indicator and alert surfaces are next,
  after their string sets settle.
- **More CVD-safe themes** — *planned, cheap.* The theme registry makes an
  additional palette (e.g. light deuteranopia, dark high-contrast) a
  mechanical token block; user demand decides how many ship.
- **Divergent legend + channel polish** — *planned.* A heat legend variant for
  the imbalance channel's blue↔orange ramp and related reading aids.
- **E2E coverage for the new features** — *planned.* Playwright specs for
  drawings/indicators/alerts interactions, plus a deep time-zoom-out mip-level
  spec and an imbalance-render smoke (mock-GL cannot prove pixels).
- **Lint + coverage gates in CI** — *planned.* The CI matrix now proves
  typecheck, unit tests, the production bundle and the Rust shell on two OSes;
  a lint gate and coverage reporting are the remaining gaps.

## Mid-term

- **Replay review tools** — bookmarks/markers on the timeline, session divider
  lines with per-session stats, loop, and shareable view+playback links.
- **Server-synced alerts** — alerts are client-local (`localStorage`) today;
  server-side alert endpoints with re-derivation would let them survive a
  reload and eventually notify while detached.
- **Wider indicator set** — the kernel layer is registry-driven and pure;
  wiring the further pre-validated kernels (ATR, supertrend, ichimoku, …) and
  sub-pane rendering is incremental once candles/overlays have soaked.
- **Shell surface** — deeper Tauri bridge (window/fullscreen controls) and a
  documented release runbook; an auto-updater remains an owner decision, not a
  default.
- **Power-user shell** — command palette with filters, chart context menu,
  status bar with connection detail.

## Non-goals

- **Trading.** FlowMap reads public market data and draws it. No order
  placement, no wallets, no withdrawal-capable keys — there is no code path
  and none will be added.
- **Telemetry / analytics.** No SDK, no beacon, no crash reporting.
- **Hosted / multi-user service.** The server is a loopback-only single-user
  sidecar by design; it will not grow a public deployment mode or remote
  auth-as-a-service.
- **Silent security-posture changes.** The loopback API is unauthenticated by
  deliberate trade (see [SECURITY.md](SECURITY.md)); any hardening (token,
  origin pinning) will be designed openly and announced, never shipped as a
  quiet tightening.
- **Auto-updater by default.** Updates are downloads the user initiates and
  can verify via build provenance.
- **Wholesale merges of the old prototype branch.** Feature ports are
  file-by-file against the current transport/GL core; the old renderer, net
  and store layers are strictly behind the current ones and will not be
  resurrected.
