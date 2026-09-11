# Roadmap

Status labels are honest: **shipped** means it is in the current build,
**planned** means designed/surveyed with intent to build, **exploring** means
the shape is not settled. Nothing here is a promise of a date.

## Shipped since this list was written (2026-09-11 campaign)

These were the deferrals from the 2026-09-10 roadmap that closed next; all are
in the current build:

- **Watchlist + favorites panel** — *shipped.* A favorites rail (cap 30,
  persisted under `flowmap.watchlist.v1`) with live quotes, signed change and
  sparklines from a shared visibility-gated `GET /api/quote` poll; stale rows
  dim, unreachable symbols show `—`, and a row click switches the chart.
- **Alert sound + smarter re-arm** — *shipped.* An optional WebAudio chime with
  a settings toggle, plus a re-arm band: a fired alert stays latched until price
  returns past `level ∓ ~0.1%`, replacing the blind 60-second refire.
- **More CVD-safe themes** — *shipped.* `paper-deut` (light deuteranopia) and
  `contrast` (true-black high contrast); the registry now cycles 7 palettes.
- **Divergent legend + channel polish** — *shipped* in the campaign-3 follow-up
  wave: the heat legend mirrors the imbalance channel (ask-heavy/bid-heavy
  caps) and stays honest on synthetic feeds.
- **E2E coverage for the new features** — *shipped.* Two new spec files (11
  tests) cover drawings persistence, alert firing, theme/locale flips, watchlist
  switching, tick grouping, deep time-zoom mips, imbalance pixels and
  context-loss intent; the whole suite now runs in CI (ubuntu, serialized).
- **Lint gate in CI** — *shipped.* Client eslint (`npm run lint`) and server
  ruff (`uv run ruff check .`) run as CI steps.

## Near-term (still open from the 2026-09-10 campaign)

Rough priority order:

- **Windowed replay (interactive)** — *plumbing shipped, UI planned.* The
  server honors a `[start_t, end_t)` subscribe window (and refuses a mismatched
  re-attach); the client carries `end_t` on the wire and re-subscribes on a
  window change. What remains is the UI: picking a window on the timeline
  instead of opening the newest bounded window.
- **Multi-chart layouts (1 / 2 / 4) with crosshair sync** — *planned.* Grid
  slots, each with its own market:symbol + camera, synced crosshair for
  basis/spread comparison. Design must respect WebGL context limits and the
  current session/band re-subscribe semantics.
- **i18n for feature panes** — *planned.* The remaining shell holes closed in
  the 2026-09-11 campaign (82 keys); the drawing, indicator and alert surfaces
  are next, after their string sets settle.
- **Coverage gates in CI** — *planned.* Lint and e2e are gated now; coverage
  reporting and non-decreasing thresholds are the remaining gap.

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
