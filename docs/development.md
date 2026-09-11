# FlowMap development guide

## Repository layout

```
app/       Tauri 2 desktop shell (Rust): sidecar lifecycle, bundling scripts,
           platform tauri.<os>.conf.json overrides. See app/README.md.
client/    React 18 + TypeScript + WebGL2 renderer. Vite dev server (:5173)
           proxies /api and /ws to the server on :8720.
  src/gl/      renderer: column textures, SUM-mips, camera, colormaps (gl/lut.ts),
               depth channel modes + renderer stats
  src/input/   gestures.ts (wheel/drag), keys.ts (global keyboard)
  src/net/     connection.ts (WS), history.ts (paged history), serverBase.ts
  src/proto/   decode.ts / encode.ts — TypeScript mirror of the server wire codec
  src/state/   stores: book/tape, settings, alerts, quote feed
  src/theme/   theme registry (7 CVD-safe palettes), CSS-variable tokens
  src/i18n/    EN/TR shell translation (t(), locale persistence)
  src/drawings/  chart annotation model + persistence (2D overlay in src/ui)
  src/indicators/ + src/candles/  indicator kernels, registry, candle synthesis
  src/ui/      top bar, symbol search, DOM ladder, tape, CVD pane, settings,
               measure tool, price alerts, watchlist rail, drawings/indicator
               canvases, ...
  tests/e2e/   Playwright specs (32 tests / 16 files: heatmap, live-sim,
               equity, parity, perf gates, scrollback, tail-columns, axis,
               overlays, panels, normalize, session-switch, shell, mips,
               features, gl4)
server/    Python 3.13 sidecar (FastAPI + uvicorn, asyncio).
  src/flowmap_server/
    api/     REST (/api/health, /api/symbols, /api/venues, /api/universe,
             /api/movers, /api/quote, /api/export) + the binary /ws WebSocket
             (origin gate + connection cap) + _env.py (WS env knobs)
    core/    density grid, sessions, recorder, price scale, backfill, session stats
    data/    bundled symbol universe + venue catalog
    feeds/   sim, crypto (Crocodile), equity, replay, and the router
    proto/   wire.py (binary codec) + events.py (msgspec event types)
  tests/     pytest suite (asyncio_mode=auto, 60 s timeout per test)
docs/       architecture.md, development.md, user-guide.md, design specs
            (superpowers/specs), screenshots (media/)
scripts/    dev.sh, dev-windows.ps1, dev-unix.sh (dev boot), package.sh
            (client production bundle)
.github/    workflows: ci.yml (push/PR gate: client tsc + eslint + vitest on
            ubuntu+windows, production bundle build, server pytest + ruff on
            ubuntu+windows, shell cargo test, full Playwright e2e on ubuntu),
            release.yml (packaged, attested installers)
```

## Dev environment

- Python 3.13 + [uv](https://docs.astral.sh/uv/) — `cd server && uv sync` creates the venv and
  installs runtime + dev dependencies (the market-data engine `crocodile` is pinned to an exact
  git commit in `server/pyproject.toml`).
- Node 22 + npm — `cd client && npm install`.
- One-shot boot: `./scripts/dev.sh` (bash), `bash scripts/dev-unix.sh` (no uv required if a
  Python 3.13 is on PATH), or `powershell -File scripts/dev-windows.ps1` (PowerShell 5.1+).
  Helpers start the server on `FLOWMAP_PORT=8720` with recording disabled, then vite.
- Windows note: vite can fail when the project path contains non-ASCII characters; the PowerShell
  helper resolves the repo's real path first. Prefer an ASCII-only checkout path.

## Tests

```bash
# client unit tests (vitest + jsdom, ~1243 tests across 85 files)
cd client && npm test              # = vitest run; npm run test:watch for watch mode
npx tsc -b                         # strict typecheck across client tsconfig projects
npm run lint                       # eslint flat config (errors fail; warnings allowed)
npm run build                      # production bundle proof (tsc -b && vite build)

# server tests (pytest, ~664 tests)
cd server && uv sync && uv run pytest -q
uv run ruff check .                # lint (ruff)
# without uv, from the repo root:
PYTHONPATH=server/src pytest server/tests -q

# Tauri shell tests (Rust; Linux needs the Tauri system deps — copy the apt list
# from .github/workflows/ci.yml's shell job)
cd app/src-tauri && cargo test
```

pytest is configured in `server/pyproject.toml` (`asyncio_mode = "auto"`,
`timeout = 60`, `testpaths = ["tests"]`), so running `pytest server/tests` from the repo root
still picks the config up (rootdir resolves to `server/`). Dev dependencies if you install them
manually: `pytest`, `pytest-asyncio`, `pytest-timeout`, `httpx`, `websockets`, plus the runtime
imports (`fastapi`, `uvicorn`, `msgspec`, `numpy`, `polars`, `aiohttp`, `certifi`, and `crocodile`
from its pinned git revision).

## End-to-end (Playwright)

```bash
cd client
npx playwright install chromium    # one-time browser download
npm run e2e                        # = npx playwright test
# Windows PowerShell blocks npx.ps1 — use the cmd shim instead:
cmd /c "npx playwright test"
```

The suite is **32 tests in 16 spec files**: heatmap, live-sim, equity, parity, perf, scrollback,
tail-columns, axis-scale, overlays, panels, normalize, session-switch, shell, mips, `features`
(drawings persistence, alert fire, theme/locale flips, watchlist switching, replay refusal) and
`gl4` (tick grouping, deep time-zoom mips, imbalance pixels, context-loss follow intent).

Prerequisites and behavior (from `client/playwright.config.ts`):

- **`uv` must be on your PATH** — the config boots the real stack for you via two `webServer`
  entries: the actual `flowmap_server` (`uv run python -m flowmap_server`, cwd `server/`) and
  the vite dev server. You do not need to boot anything yourself, but the server entry resolves
  `uv` from PATH.
- **Server boot env for e2e**: `FLOWMAP_PORT=8720`, `FLOWMAP_RECORDING_ENABLED=0` (e2e never
  touches disk or rehydrates a stale tail), `FLOWMAP_LOG_LEVEL=warning`, and
  `FLOWMAP_DT_CRYPTO_NS=25000000` — a 25 ms sim cadence (40 columns/s) so scroll-back specs
  overrun the client's full-res budget in seconds instead of minutes.
- **`reuseExistingServer` is enabled when `CI` is unset**: a manually booted server on `:8720`
  (or vite on `:5173`) will be reused, which speeds up local iteration. In CI it always boots
  fresh servers.
- **CI serializes the suite**: `workers: process.env.CI ? 1 : undefined` — two concurrent
  canvas-heavy specs starve each other's CPU on SwiftShader and trip the perf spec's honest
  thresholds. Locally the suite stays parallel; CI also retries twice (`retries: 2`).
- **Onboarding/theme storage state** is seeded for every browser context
  (`tests/e2e/onboarded-state.json`: `flowmap.onboarded=1`, `flowmap.theme=midnight`) — the
  first-run tour's scrim would otherwise swallow the first pointer/wheel interaction.
- vite is pinned to `--host 127.0.0.1` (vite otherwise binds `[::1]` only, which the IPv4
  readiness URL cannot reach).
- Headless WebGL2 works: Chromium is launched with ANGLE→SwiftShader
  (`--use-angle=swiftshader --enable-unsafe-swiftshader`), so heatmap specs render on GPU-less
  CI runners.
- **CI job**: `e2e` (ubuntu, 30-minute timeout) in `.github/workflows/ci.yml` installs
  Playwright chromium with system deps, runs `uv sync --frozen` in `server/`, then
  `npx playwright test` with `CI=1`. The perf gate's fps thresholds are the known flake risk on
  shared runners (it has a documented software-GL fallback).

## Release / packaging outline

The desktop app is built per-OS (native Python wheels cannot be cross-built); CI
(`.github/workflows/release.yml`) produces the installers, `SHA256SUMS`, and SLSA build-provenance
attestations. Manual outline (from `app/README.md` — read it before building):

1. Build the client bundle (`cd client && npm run build` — runs `tsc -b && vite build`).
2. Build the relocatable Python runtime ("pyruntime", python-build-standalone) for the target
   triple: `app/scripts/bundle-python.sh`.
3. Build the shell: `cargo tauri build` in `app/src-tauri` with the platform config
   (`tauri.<platform>.conf.json` is merged over `tauri.conf.json` by the Tauri CLI). macOS has a
   full pipeline in `app/scripts/build-dmg.sh`.
4. The bundle embeds client assets + pyruntime + the Python dependencies. Nothing is fetched at
   first run.

Secrets policy: no signing certificates exist for this project (installers are ad-hoc/unsigned;
the attestation is the integrity story), and feed credentials (`ALPACA_API_KEY`/`SECRET`,
`FINNHUB_API_KEY`) are **runtime** environment variables read by the server process — they are
never build inputs and never embedded in any artifact.

Local iteration never needs a packaging step: `npm run dev` plus the test commands above cover
day-to-day work; reserve `vite build` / `tauri build` / `cargo` for actual release builds.
