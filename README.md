# FlowMap

[![CI](https://github.com/nazmiefearmutcu0/FlowMap/actions/workflows/ci.yml/badge.svg)](https://github.com/nazmiefearmutcu0/FlowMap/actions/workflows/ci.yml)

FlowMap is an open-source order-flow depth heatmap for crypto and US equities: a WebGL2 chart
that renders resting liquidity as a live column heatmap, with a DOM ladder, time &amp; sales tape,
CVD, volume profile and a recording-backed replay transport. A Python sidecar normalizes every
market into one binary event stream; a React + WebGL2 client renders it — pan/zoom cost is
independent of history depth because a column, once rasterized to the GPU, is never redrawn.

Live feeds today: crypto L2 depth + tick tape (native incremental connectors for binance, bybit,
coinbase, deribit, okx; every other ccxt venue via a universal snapshot connector), keyless
equity SYNTH depth (Yahoo 1-minute bars, honestly badged, distinct amber ramp) with optional
Alpaca/Finnhub L1 upgrades, and a deterministic `sim:SIM-DEMO` feed that needs no network.
Anything a session shows can be recorded to parquet on disk and replayed with seek/speed/pause.

## Features

- **Depth heatmap** — per-column bid/ask density on a fixed price grid; three colormaps
  (`flow` default, `inferno`, `classic`), SUM-mip zoom-out so walls don't dilute, tolerance
  black point, contrast and normalization controls. **Depth channel modes** (`sum` / `bid` /
  `ask` / `imbalance`) re-color the same map — imbalance renders the signed
  `(bid−ask)/(bid+ask)` field on a CVD-safe divergent ramp.
- **Chart navigation that stays honest at any depth** — wheel zooms time at the cursor,
  Shift/Ctrl+wheel zooms price, drag pans; the price gutter is its own control surface
  (wheel = price zoom, vertical drag = price scale, double-click = re-fit). Time-follow and
  price-track re-arm with your zoom preserved; a Go Live pill appears the moment you scroll
  off the live edge.
- **Order-flow overlays** — DOM ladder, time &amp; sales tape with trade bubbles, BBO, VWAP,
  CVD pane locked to the chart's time axis, volume profile, liquidation/`gap` markers,
  crosshair with the exact per-cell liquidity readout. Every overlay toggles individually.
- **Whole-market symbol search** — `Ctrl-K` / `⌘K` (or `/`) opens a fuzzy, ranked search over
  every subscribable symbol, with live quote, movers and sparklines; symbols typed in either
  spelling (`ETH/BTC` vs `ETHBTC`) are translated, not rejected.
- **Capability badges, never silent downgrades** — `L2` / `L1` / `SYNTH`, `TAPE TICK` /
  `TAPE POLL`, `SIDE EXCHANGE` / `SIDE NA` reflect what the active feed actually delivers.
  Replay that would show a stale tail is refused outright instead of being mislabeled live.
- **Recording-backed replay** — sessions record to parquet under a 20 GB rotating cap;
  replay offers seek, 1–100× speed and pause over exactly what was recorded.
- **Trader conveniences** — export the chart (heatmap + overlays) as a PNG with `E` or the
  TopBar button, stream raw finalized columns from the active session via
  [`/api/export`](docs/user-guide.md#export) (CSV/JSON), measure Δprice/Δtime/Δdepth on the
  chart (`M`), and highlight outsized tape prints with a configurable notional threshold
  (`Settings → Big trade size`).
- **Watchlist rail** — pin up to 30 favorites; each row shows a live quote, signed change
  and a sparkline from a shared 10 s poll that pauses while the tab is hidden. Stale rows
  dim and unreachable symbols show `—`, never a guessed price. Clicking a row switches the
  chart; the empty state offers recents.
- **Annotation & analysis layers** — chart **drawings** (trendline, horizontal ray, rectangle,
  Fibonacci retracement, horizontal line, text) with select/move/resize and per-symbol
  persistence; **indicators** (EMA, SMA, RSI, VWAP, Bollinger, MACD) and synthesized
  **candles** (1m/5m) drawn in sync with the depth columns; **price alerts** (`A`) that are
  client-local, persisted per symbol, and fire a marker pulse + toast + optional WebAudio
  chime (settings toggle) — a fired alert re-arms only after price returns past its band,
  and a background monitor keeps alerts on non-active symbols firing via `/api/quote`; a
  **perf HUD** (`H`) with live fps/frame/upload stats from the renderer.
- **Accessible, honest shell** — seven CVD-safe themes (`T` to cycle: midnight, paper,
  swiss, amber, sea, paper-deut, contrast; OS light/dark honored on first run),
  English/Turkish interface with graceful fallback, a first-run onboarding tour,
  keyboard shortcuts everywhere (`?` for the live cheatsheet), and a polished toast stack.
- **Desktop app** — Tauri 2 shell bundles the client and a relocatable Python sidecar
  (loopback-only), spawns it automatically, keeps a health-monitor thread that respawns it
  if it dies mid-session, and enforces a single running instance, for macOS (Apple Silicon /
  Intel), Windows x64 / ARM64, and Linux (deb / AppImage).

## Screenshots

<!-- Placeholder: replace with fresh captures of the current build. -->
<!-- Capture guide: sim:SIM-DEMO for markers, binance-spot:BTCUSDT for live L2, equity:AAPL replay for SYNTH. -->

| | |
|---|---|
| ![Live Binance BTCUSDT: WebGL2 heatmap, DOM ladder, tick tape](docs/media/heatmap-btcusdt-live.png) | ![equity:AAPL keyless SYNTH tier, replaying a recorded session](docs/media/equity-aapl-synth-replay.png) |
| ![Crosshair with exact per-cell liquidity readout](docs/media/crosshair-readout.png) | ![Settings drawer: colormap, tolerance, normalization, overlay toggles](docs/media/settings-drawer.png) |

More captures (`docs/media/sim-demo-markers.png`) ship in the repo. The screens above predate
the latest feature wave (drawings, indicators, alerts, themes) — fresh captures are tracked in
the [roadmap](ROADMAP.md). The [user guide](docs/user-guide.md) walks through every feature
these screenshots show.

## Documentation

| Doc | What's inside |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | Install, first run, reading the heatmap, replay, measure, alerts, drawings, indicators, themes, shortcuts, export, troubleshooting |
| [docs/architecture.md](docs/architecture.md) | Processes, wire protocol, sessions/grid, recording/replay, API surface |
| [docs/development.md](docs/development.md) | Repo layout, dev environment, test commands, e2e, release/packaging outline |
| [CHANGELOG.md](CHANGELOG.md) | Notable changes per work campaign, newest first |
| [ROADMAP.md](ROADMAP.md) | Near/mid-term plans and explicit non-goals |
| [CONTRIBUTING.md](CONTRIBUTING.md) / [SECURITY.md](SECURITY.md) | Dev setup, PR checklist · threat model, attestation verification |

## Architecture

```
+----------------------------------------------------------+
| Tauri 2 desktop shell (app/, Rust)                       |
|   picks a free loopback port, spawns the Python          |
|   sidecar, injects its URL into the webview,             |
|   terminates it on quit                                  |
|   +------------------------------------------------------+`
|   | WebView: FlowMap client (client/)                    |`
|   | React 18 + TypeScript + WebGL2 renderer              |`
|   | dev: vite :5173   packaged: bundled assets           |`
+---+---------------------^----------------------------------+`
                        |  |
        HTTP /api/*  +  |  |  binary WebSocket /ws (loopback)
        WS proxy        |  |
+----------------------- v ----------------------------------+
| Python 3.13 sidecar (server/, FastAPI + uvicorn, :8720)    |
|   feeds/   router: sim | <exchange>[-<segment>] | equity   |
|            crypto (native L2 diffs / ccxt snapshots)       |
|            equity (keyless SYNTH / Alpaca / Finnhub)       |
|            replay (parquet recordings)                     |
|   core/    time-weighted density grid, sessions, recorder  |
|   proto/   binary wire codec (versioned, f32 depth tiles)  |
+-----------------------^------------------------------------+
                        |  outbound public REST/WS to venues
  recordings on disk:   ~/.flowmap/recordings/{market}/{symbol}/*.parquet
```

The client is a pure renderer of a canonical binary stream; the server normalizes every market
into that stream plus a capability descriptor. Protocol details: [docs/architecture.md](docs/architecture.md).
Design specs live under [docs/superpowers/specs/](docs/superpowers/specs/); the desktop shell is
documented in [app/README.md](app/README.md).

## Quickstart (from source)

Prerequisites: Python 3.13 with [uv](https://docs.astral.sh/uv/) (or plain `python3` plus the
dependencies below), Node 22 with npm.

One-shot helper:

```bash
./scripts/dev.sh            # server :8720 + client :5173, Ctrl-C stops both
# then open http://localhost:5173
```

macOS / Linux, manually:

```bash
# terminal 1 - server
cd server && uv sync && FLOWMAP_PORT=8720 uv run python -m flowmap_server

# terminal 2 - client (vite proxies /api and /ws to :8720)
cd client && npm install && npm run dev
```

Windows (PowerShell):

```powershell
# terminal 1 - server
cd server
uv sync
uv run python -m flowmap_server        # binds 127.0.0.1:8720 by default

# terminal 2 - client (vite proxies /api and /ws to :8720)
cd client
npm install
npm run dev
```

Without uv, any Python 3.13 works: install the dependencies listed in
[`server/pyproject.toml`](server/pyproject.toml) (note the market-data engine `crocodile` is a
git dependency), then from the repo root run `PYTHONPATH=server/src python3 -m flowmap_server`
(bash) or `$env:PYTHONPATH='server/src'; python -m flowmap_server` (PowerShell). The packaged
desktop app needs none of this — it bundles its own relocatable Python ("pyruntime").

Or run the helpers: `powershell -File scripts/dev-windows.ps1` (PowerShell 5.1-compatible) or
`bash scripts/dev-unix.sh`. Both set `FLOWMAP_PORT=8720` and `FLOWMAP_RECORDING_ENABLED=0`
(see the scripts for how to override).

> **Windows path gotcha:** vite's dev server can fail to start or serve when the working
> directory path contains non-ASCII characters (e.g. `C:\Users\<name with diacritics>\...`).
> If vite errors on startup, run it from an ASCII-only path — `scripts/dev-windows.ps1`
> resolves the repo's real path first for this reason.

Pick a symbol in the top bar: `SIM-DEMO` (deterministic, offline), `BTCUSDT` (live Binance L2),
or `AAPL` (keyless SYNTH; real Alpaca L1 + tick tape during market hours with keys set).

### Configuration (server environment variables)

All config is env-first, resolved at startup in
[`server/src/flowmap_server/config.py`](server/src/flowmap_server/config.py) and
[`__main__.py`](server/src/flowmap_server/__main__.py); the `/ws` edge knobs
(`FLOWMAP_WS_*`) are read per connection in
[`api/_env.py`](server/src/flowmap_server/api/_env.py). Defaults in the table are the
shipped defaults.

| Variable | Default | Purpose |
|---|---|---|
| `FLOWMAP_HOST` | `127.0.0.1` | Bind address. Loopback only — anything else is rejected at startup |
| `FLOWMAP_PORT` | `8720` | HTTP + WebSocket port (vite's dev proxy targets this) |
| `FLOWMAP_RING_COLUMNS` | `32768` | In-memory ring buffer depth (columns) |
| `FLOWMAP_MAX_SESSIONS` | `4` | Concurrent subscriptions |
| `FLOWMAP_WS_ALLOWED_ORIGINS` | *(unset)* | Replaces the built-in browser-origin allow-list for `/ws` (comma-separated exact origins; `*` disables the check). Requests without an `Origin` header are always allowed |
| `FLOWMAP_WS_MAX_CONNECTIONS` | `16` | Per-process `/ws` connection cap; over-limit clients are closed with code `1013` |
| `FLOWMAP_REPLAY_MAX_COLS` | `0` | Bound on the columns a no-window replay subscribe loads (`0` follows `FLOWMAP_RING_COLUMNS`); an explicit `start_t`/`end_t` window is never trimmed by this knob |
| `FLOWMAP_DT_CRYPTO_NS` | `250000000` | Grid column cadence for crypto + sim feeds (nanoseconds; 250 ms) |
| `FLOWMAP_DT_EQUITY_KEYLESS_NS` | `10000000000` | Keyless equity last-price poll cadence (10 s) |
| `FLOWMAP_DT_EQUITY_KEYLESS_GRID_NS` | `1000000000` | Keyless equity grid column cadence (1 s) |
| `FLOWMAP_RECORDING_ENABLED` | `1` | `0` / `false` disables all recording writes |
| `FLOWMAP_RECORDING_GB_CAP` | `20.0` | Recording disk cap; oldest files evicted first |
| `FLOWMAP_FLUSH_INTERVAL_S` | `10.0` | Time-based recording flush cadence: a hard app-close loses at most this many seconds of buffered recording per session |
| `FLOWMAP_RETENTION_MIN_INTERVAL_S` | `60.0` | Minimum wall-clock seconds between recording-retention walks per session (`0` = walk after every flush) |
| `FLOWMAP_DATA_DIR` | `~/.flowmap/recordings` | Recording root directory |
| `FLOWMAP_BACKFILL_ENABLED` | `1` | First-launch candle-history backfill onto the chart |
| `FLOWMAP_BACKFILL_MAX_COLS` | `512` | Max candle-columns fetched for backfill |
| `FLOWMAP_BOOK_TOP_N` | `20000` | Book levels per side retained when emitting a crypto book |
| `FLOWMAP_CRYPTO_TICK` | `0` | Crypto grid tick override (0 = auto); useful for sub-cent coins |
| `FLOWMAP_LOG_LEVEL` | `info` | Server + uvicorn log level |
| `FLOWMAP_LOG_FILE` | *(unset)* | Optional extra log file (stderr always receives logs) |
| `ALPACA_API_KEY` + `ALPACA_API_SECRET` | *(unset)* | Optional: equity L1 top-of-book + tick tape (read-only market-data keys) |
| `FINNHUB_API_KEY` | *(unset)* | Optional: equity tick tape |

## Keyboard and pointer controls

Bindings as implemented in [`client/src/ui/keysheet.ts`](client/src/ui/keysheet.ts),
[`client/src/input/keys.ts`](client/src/input/keys.ts) and
[`client/src/input/gestures.ts`](client/src/input/gestures.ts). Press `?` in the app for the
live overlay.

| Input | Action |
|---|---|
| `Space` | Follow the live edge; play/pause in replay |
| `/` or `Ctrl-K` / `⌘K` | Symbol search palette |
| `E` | Export the chart as a PNG download |
| `M` | Measure tool — drag for Δprice / Δtime / Δdepth |
| `A` | Price alert at the crosshair price |
| `H` | Perf HUD (fps / frame ms / uploads / draws / cache) |
| `C` | Cycle depth channel (sum → bid → ask → imbalance) |
| `T` | Cycle theme |
| `?` | Toggle the shortcuts overlay |
| `←` `→` `↑` `↓` | Pan time / price (chart focused) |
| `+` / `−` | Zoom time (chart focused) |
| `F` | Toggle time follow (chart focused) |
| `P` / `Shift+P` | Price track on/off / re-fit price |
| `R` | Return to the live edge |
| `E` | Export the chart as a PNG download |
| `Esc` | Close search / settings / shortcuts |
| Wheel on chart | Zoom time at the cursor column |
| `Shift`/`Ctrl` + wheel | Zoom price at the cursor row |
| Drag on chart | Pan both axes (natural drag) |
| Wheel on price gutter | Zoom price at the cursor row |
| Vertical drag on price gutter | Scale the price axis about the viewport centre |
| Double-click on price gutter | Re-fit the price axis |

## Development

```bash
# client unit tests (1200+ across 85 files and growing, vitest + jsdom)
cd client && npm install && npm test        # or: npx vitest, npm run test:watch
npx tsc -b                                  # typecheck
npm run lint                                # eslint (flat config)
npm run build                               # production bundle (tsc -b && vite build)

# server tests (660+ and growing, pytest, Python 3.13)
cd server && uv sync && uv run pytest -q    # or: PYTHONPATH=server/src pytest server/tests -q
uv run ruff check .                         # lint (ruff)

# Tauri shell tests (Rust)
cd app/src-tauri && cargo test              # Linux needs the Tauri system deps — see ci.yml

# end-to-end (Playwright boots the real server :8720 + vite :5173 itself)
cd client && npx playwright install chromium && npm run e2e
```

E2E prerequisites, repo layout and release/packaging notes: [docs/development.md](docs/development.md).
Protocol and internals: [docs/architecture.md](docs/architecture.md). Continuous integration
runs lint (eslint + ruff), the client suite (ubuntu + windows), the production bundle build,
the server suite (ubuntu + windows), the full Playwright e2e suite (ubuntu) and the shell
`cargo test` on every push/PR:
[.github/workflows/ci.yml](.github/workflows/ci.yml).

### Packaged releases

Installers are self-contained (bundled client + relocatable Python; nothing else to install) and
carry a SLSA build-provenance attestation you can verify locally:

```bash
gh attestation verify <downloaded-file> -R nazmiefearmutcu0/FlowMap
```

See the [releases page](https://github.com/nazmiefearmutcu0/FlowMap/releases/latest) for assets
and [SECURITY.md](SECURITY.md) for what the app reads, writes, and connects to.

## Contributing

Bug reports, feature discussions and PRs are welcome — start with
[CONTRIBUTING.md](CONTRIBUTING.md) (dev setup, commit style, PR checklist).

## Security

The sidecar binds loopback only and there is no authentication by design today; the full
surface — endpoints contacted, files written, threat-model notes — is in
[SECURITY.md](SECURITY.md). Please report vulnerabilities via a
[private security advisory](https://github.com/nazmiefearmutcu0/FlowMap/security/advisories/new),
not a public issue.

## License

[Apache-2.0](LICENSE).
