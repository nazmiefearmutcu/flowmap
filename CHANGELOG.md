# Changelog

All notable changes to FlowMap are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); entries are grouped by
the work campaign that produced them (dates and commit ranges from git history).
Unreleased work sits on top of the newest listed commit.

## [Unreleased] — campaign 3 (2026-09-10)

Client + server feature campaign on top of `840cc96`
([compare](https://github.com/nazmiefearmutcu0/FlowMap/compare/840cc96...HEAD)).

### Added

- **Chart annotation (drawings)** — 2D-canvas overlay above the heatmap:
  trendline, horizontal ray, rectangle, Fibonacci retracement, horizontal line
  and text tools, with select/move/resize/delete and per-symbol persistence in
  `localStorage`.
- **Indicators + candles** — candle synthesis from the tape/price stream with a
  selectable interval (1m/5m), plus a registry-driven indicator overlay
  (EMA, SMA, RSI, VWAP, Bollinger, MACD) with editable parameters, drawn on a
  2D canvas riding the chart's price scale.
- **Measure tool** (`M`) — drag on the chart for a dashed rectangle with
  Δprice (absolute + %), Δtime and depth inside the row band; `Esc` cancels;
  honest `—` readouts when geometry or book data is missing.
- **On-chart price alerts** (`A`) — client-local, persisted per symbol in
  `localStorage` (max 50 per symbol), alert line + solid-red pulse on fire,
  toast via the new Toaster, 60 s snooze/re-arm, alerts popover with typed
  entry, delete and clear-fired.
- **Depth channel modes** — renderer channel selection `sum` / `bid` / `ask` /
  `imbalance` (`C` cycles, segmented control in the settings drawer). Imbalance
  `(bid−ask)/(bid+ask)` renders on a CVD-safe divergent blue↔orange ramp;
  `sum` is bit-identical to previous releases, and synthetic (SYNTH) sessions
  keep rendering `sum` with the setting remembered for real-depth feeds.
- **Perf HUD** (`H`) — fps / frame ms / uploads / draws / cache footprint chip,
  polled at 2 Hz from a new `renderer.stats()` API; every field degrades to `—`
  when unavailable.
- **Themes** — five CVD-safe themes (`midnight` default — byte-identical to the
  previous look, `paper`, `swiss`, `amber`, `sea` deuteranopia-safe), applied
  via CSS-variable token blocks with a canvas-palette bridge; `T` cycles;
  first run honors `prefers-color-scheme`; choice persists.
- **i18n (EN/TR shell)** — dependency-free `t()` with English default and
  Turkish translation covering the shell (top bar, settings drawer, banners,
  shortcuts overlay, onboarding, toasts); missing keys fall back to English,
  never to raw key names.
- **Toaster** — stacked toast queue (info/success/warn/error, auto-dismiss,
  hover-pause, max 5) with a polite live region; other components post through
  `window.__flowmapToast`.
- **Onboarding** — first-run 3-step tour (connect/symbol, mouse & keys,
  shortcuts) with focus trap; only Skip/Done dismiss it permanently — `Esc`
  merely closes, so the tour returns next launch.
- **`/api/health` v3** — a new session-stats producer is surfaced verbatim
  under `stats` (drop counters, restarts, active/rejected sessions, real EMA
  `latency_ms`, per-feed `staleness_ms`, `clock_skew_ms`, recording health with
  flush-failure counts) plus `stats_available`; legacy fields unchanged.
- **`/api/export`** — `GET /api/export?format=csv|json&columns=N&symbol=`
  streams the last-N finalized density columns of a session as CSV (with
  metadata comment header) or JSON; bounded by the ring and a 64 MiB cap, with
  structured 404/400/422 errors.
- **WS admission control** — WebSocket connections are gated by browser-origin
  allow-list (loopback dev origins + `tauri://localhost` /
  `https://tauri.localhost`; env-overridable via `FLOWMAP_WS_ALLOWED_ORIGINS`,
  `*` disables) with close code `1008`, and by a per-process connection cap
  (`FLOWMAP_WS_MAX_CONNECTIONS`, default 16) with close code `1013` and an
  honest reason string.
- **Real connection telemetry** — WS ping RTT now feeds `latency_ms`, and an
  optional client timestamp on `Subscribe` yields `clock_skew_ms` (backward
  compatible in both wire directions; golden vector pinned).
- **CI** — new Windows leg (pytest + tsc/vitest), `cargo test` leg for the
  Tauri shell, and a `vite build` production-bundle gate; concurrency
  cancel-in-progress; legacy combined `test.yml` workflow retired (its jobs
  are a subset of `ci.yml`).
- **Docs** — `docs/user-guide.md`, `CHANGELOG.md`, `ROADMAP.md`; README and
  architecture docs updated to the new feature set.

### Changed

- Mip level selection now takes the coarser of the row/column axis needs, so
  deep time-zoom-out suppresses aliasing backfill as well (2-argument behavior
  unchanged).
- Column cache is a slot-addressed preallocated pool mirroring the GPU ring —
  no per-column allocations or large buffer churn in steady state.
- Normalization memoizes the visible-tile merge (no re-merge per dirty frame)
  and history-page mip rebuilds are batched into one pass per level/segment
  instead of dozens of tiny framebuffer passes.
- Re-subscribing a WebSocket drains the shared client queue and bumps a
  subscription epoch, so frames of the old symbol can never flush after the
  new session's Hello/snapshot.
- Book tape is a fixed head-index ring iterated backward for newest-first
  snapshots (no per-flush `slice().reverse()` double allocation); the CVD pane
  projects into a reused buffer (allocation-free per repaint).

## [1.4.0] — 2026-09-10 — campaign 2

`bd80f35..840cc96`
([compare](https://github.com/nazmiefearmutcu0/FlowMap/compare/17b0c47...840cc96)).

### Fixed

- Server replay/record integrity wave: recording flush and replay-attach
  robustness; feed hardening.
- GL correctness wave: normalizer/mip gates, hybrid BBO, premultiplied blend,
  renderer snapshot semantics.

### Added

- Transport honesty guards, input guards, PNG chart export (`E` / TopBar
  button), configurable big-trade highlight in the tape.
- Desktop shell: single-instance OS lock, sidecar health monitor with respawn,
  version 1.4.0.

### Changed

- Docs and CI brought to truth: professional README, architecture and
  development guides, dev boot scripts.

## 2026-09-06 — six-agent upgrade

`3607a17..17b0c47`
([compare](https://github.com/nazmiefearmutcu0/FlowMap/compare/a529eaa...17b0c47)).

- Server: replay attach re-validates recording freshness; malformed-trade
  guard; refused subscribes logged; `/api/health`, file logging, structured
  REST errors, WS frame hardening.
- Client: reconnect backoff jitter, history-reset leak fix, epoch-safe depth
  book; heatmap gap-band gating and seam-free sampling; shortcuts overlay,
  symbol recents + fuzzy search scoring, accessibility and truthful states.
- Repo: professional README, `docs/architecture.md`, `docs/development.md`,
  CI workflows, dev boot scripts.

## 2026-09-05 — chart rebuild & honesty wave

`e60168f..a529eaa`
([compare](https://github.com/nazmiefearmutcu0/FlowMap/compare/bd71738...a529eaa)).

- TradingView-grade chart + smooth flow-colormap WebGL2 heatmap; bilinear
  sampling in slot space fixes the faded-past-first-tile-layer artifact.
- Honest replay-unavailable state (no silent reconnect loop).

## 2026-09-03 — review campaign

`69249f6..bd71738`
([compare](https://github.com/nazmiefearmutcu0/FlowMap/compare/7ae45a1...bd71738)).

- Server review wave: f16 saturation, hybrid price-scale persistence,
  boot-teardown race, columnar tail decode.
- Client review wave: WebGL2 fallback, responsive top bar, replay honesty.
- Honest replay refusal, WebSocket liveness, reconnect race fixes; single-flight
  cache lock prune.
- Recording-backed replay engine: design, implementation and Playwright e2e.

## Earlier releases

Initial public releases through v1.3.1.1 (up to 2026-08-01) predate this
changelog; see the
[releases page](https://github.com/nazmiefearmutcu0/FlowMap/releases) for
notes and assets.

[Unreleased]: https://github.com/nazmiefearmutcu0/FlowMap/compare/840cc96...HEAD
[1.4.0]: https://github.com/nazmiefearmutcu0/FlowMap/compare/17b0c47...840cc96
