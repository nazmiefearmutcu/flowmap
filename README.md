# FlowMap

[![tests](https://github.com/nazmiefearmutcu/flowmap/actions/workflows/test.yml/badge.svg)](https://github.com/nazmiefearmutcu/flowmap/actions/workflows/test.yml)

**An institutional-grade, dual-market order-flow visualizer — real-time liquidity heatmap, DOM
ladder, time & sales, and order-flow overlays for crypto and US equities, in one renderer.**

![FlowMap rendering live Binance BTCUSDT order flow](docs/media/heatmap-btcusdt-live.png)
<sub>Live `binance-spot:BTCUSDT` — WebGL2 liquidity heatmap, DOM ladder, and tick tape, ~15 minutes
into a session. Columns are rasterized once on the GPU, so pan/zoom cost never grows with history.</sub>

FlowMap is a ground-up rebuild of an earlier PyQt6 desktop app that re-rasterized the entire visible
history on the CPU every pan/zoom frame, so scrolling back through history collapsed to ~1 fps.
FlowMap puts history in a WebGL2 texture and makes pan/zoom a pure view transform — **interaction cost
is independent of history depth**. It renders one market-data engine —
[Crocodile](https://github.com/nazmiefearmutcu/Crocodile), which covers crypto and US equities —
behind one market-agnostic view.

## Highlights

- **60 fps pan/zoom at any history depth.** A column, once uploaded to the GPU, is never
  re-rasterized; pan and both zoom axes only change a uniform. Measured: draw cost is ~0.2 ms
  whether 200 or 10 000 columns are resident (history-independent — the old 1-fps bug is
  structurally gone).
- **Professional order flow:** liquidity heatmap (inferno ramp — indigo → red → saturated gold,
  never white, so a max-density wall stays distinct from the white price line and relative size
  reads by hue and not just brightness — with correct SUM-mip zoom-out so walls don't dilute),
  DOM ladder, time & sales tape, prominent trade bubbles, a bright **last-price line** that
  persists as far back as the book, BBO, VWAP, a **CVD** (cumulative volume delta) lower pane
  locked to the chart's time axis, volume profile, event markers, crosshair with exact liquidity
  readout, deep scroll-back, replay transport. Every overlay toggles individually.
- **Chart controls that behave like the tools you already use.** The price gutter is a control
  surface: wheel scales price at the cursor, a vertical drag scales the axis, double-click
  re-fits. The two axes follow independently — scroll back through time and price keeps
  auto-scaling; zoom price and the right edge stays pinned to now, with your zoom preserved and
  the window recentring only when price leaves a central deadband. Re-arming price-follow **keeps
  your zoom** (it never re-frames the book out from under you); an in-chart **Go Live / Track
  Price** pill appears the moment you scroll off the live edge. Price and time both zoom out far
  past the grid, so nothing hits an artificial wall. A **Tolerance** black point (calibrated with a
  sensible non-zero default) hides sub-threshold density so only liquidity worth reading paints.
- **The whole crypto market, not a shortlist.** **104 crypto venues** are subscribable (plus
  equities and the sim feed — 106 rows from `/api/venues`). Five have hand-written connectors
  that stream true incremental book diffs (`L2`) — binance, bybit, coinbase, deribit, okx — and
  every other ccxt venue id is served by the universal connector, which re-reads the book whole
  each tick (`L2-snapshot`). That difference is a badge in the UI, never a silent downgrade. Symbols are
  enumerated live from the venue itself, in the venue's own spelling, and a symbol typed in the
  other spelling (`ETH/BTC` vs `ETHBTC`) is translated rather than rejected.
- **A command palette for the whole market.** Press **⌘K / Ctrl-K** (or `/`) for a centre-screen
  search over every crypto + equity symbol the engine reaches — fuzzy-ranked, with the day's top
  movers, live price, % change and a mini sparkline, and honest capability chips per row. On first
  launch you choose from the settings how much history to pull straight onto the chart.
- **Configurable price coverage, including one that does not compromise.** On a linear grid range
  and resolution are the same knob: `native` keeps the finest rows, `±50%` and `−100%/+1000%`
  trade resolution for reach, and the widest of those is a range **scan** mode. **`Deep`** breaks
  the tie with a piecewise scale — a linear core at the instrument's native tick, wrapped in
  logarithmic wings. On BTC at $60k that is **±0.853% at $0.50/row — the exact ladder the narrow
  grid gives — plus coverage to −99%/+1000% at ~0.34%/row**. `Deep` is now the **default**, so
  price zooms out to the full range out of the box; `native` (finest rows, narrowest coverage) is
  one click away in the drawer.
- **Two markets, one renderer, honest tiers:** crypto shows full L2 depth + tick tape; US equities
  show what their free data actually supports — a keyless **two-sided** volume-at-price SYNTH depth
  (Yahoo 1 m bars, bid below / ask above a reference price that tracks the market) that upgrades to
  real Alpaca IEX L1 top-of-book with zero code change when `ALPACA_API_KEY`/`SECRET` are set.
  Synthetic depth renders in a distinct amber ramp and carries a `SYNTH` badge — capability badges
  (`L2` / `L1` / `SYNTH`, `TAPE TICK` / `TAPE POLL`, `SIDE EXCHANGE` / `SIDE NA`) are always honest,
  no fabricated depth.

## Screenshots

| | |
|---|---|
| ![equity:AAPL on the keyless SYNTH tier, replaying a recorded market-hours session](docs/media/equity-aapl-synth-replay.png) <br><sub>`equity:AAPL` on the keyless SYNTH tier, replaying a recorded market-hours session — distinct amber ramp, honest `SYNTH` / `TAPE POLL` badges, market-closed banner, synthetic book in the DOM.</sub> | ![sim:SIM-DEMO deterministic feed with walls and liquidation markers](docs/media/sim-demo-markers.png) <br><sub>`sim:SIM-DEMO` deterministic feed — liquidity walls, buy/sell trade bubbles, VWAP line, and `LIQ` liquidation event markers.</sub> |
| ![Crosshair with the exact per-cell liquidity readout](docs/media/crosshair-readout.png) <br><sub>Crosshair with the exact per-cell readout: source tier, column timestamp, price, and resting bid/ask liquidity.</sub> | ![Settings drawer over the live heatmap](docs/media/settings-drawer.png) <br><sub>The display pipeline is live: contrast (gamma), colormap, tolerance (black point), normalization percentile, tick grouping, bubble threshold, price range, both follow axes, and per-overlay toggles.</sub> |

## Architecture

```
client/   TypeScript + React + WebGL2 renderer (Vite)
          heatmap tile-array + SUM-mips + camera + overlays + DOM/tape + UI shell
server/   Python 3.13 asyncio gateway (FastAPI, binary WebSocket, loopback-only)
          time-weighted density grid + sessions + parquet recording/replay
          feeds/  crypto (104 venues) · equity · deterministic sim — one router
```

The client is a pure renderer of a canonical binary stream (`docs/superpowers/specs/`); the server
normalizes every market into that stream + a capability descriptor. See
`docs/superpowers/plans/m1-verification.md`, `m2-verification.md`, `m3-verification.md` for the
verification record (live Binance + live equity evidence, perf gates, parity matrix).

## Install

Two supported paths, and the first one asks you to trust nothing:

- **Run from source** — [below](#run-it). Python 3.13 + `uv`, Node 22 + npm, one script. No
  binary involved.
- **Download an installer** — self-contained, and **verifiable**: every installer is signed with
  a build-provenance attestation that ties it to this repo and the commit it was built from.
  [Check it in one command](#verify-your-download) before you run it.

Every installer on the [latest release](https://github.com/nazmiefearmutcu/flowmap/releases/latest)
is **fully self-contained** — it bundles the WebGL2 client *and* a relocatable Python 3.13 running
the server, so there is nothing else to install (no Python, no Node, no `uv`). Every one of them is
built on its own CPU — there is no emulated build in the list, Windows on ARM included.

**Click your platform — the download starts immediately** (v1.3.1.1):

**What's new in v1.3.1.1** — the heatmap is visible out of the box (sane tolerance and white-point
defaults), the price axis zooms out as far as the time axis, **Go Live** keeps your scale instead
of resetting it, trade bubbles no longer hide the price line, and the live edge updates at 20 Hz
between feed bursts.

| Platform | Download | Install |
|---|---|---|
| 🍎 **macOS — Apple Silicon** (M1/M2/M3/M4) | **[⬇️ FlowMap_1.3.1_aarch64.dmg](https://github.com/nazmiefearmutcu/flowmap/releases/download/v1.3.1.1/FlowMap_1.3.1_aarch64.dmg)** · ~175 MB | open the dmg, drag **FlowMap** into **Applications** |
| 🍎 **macOS — Intel** | **[⬇️ FlowMap_1.3.1_x86_64.dmg](https://github.com/nazmiefearmutcu/flowmap/releases/download/v1.3.1.1/FlowMap_1.3.1_x86_64.dmg)** · ~183 MB | same as above |
| 🪟 **Windows 10/11 — Intel / AMD (x64)** | **[⬇️ FlowMap_1.3.1_x64-setup.exe](https://github.com/nazmiefearmutcu/flowmap/releases/download/v1.3.1.1/FlowMap_1.3.1_x64-setup.exe)** · ~121 MB | run it — installs per-user, no admin needed |
| 🪟 **Windows 11 — ARM** (Snapdragon X, ARM Surface) | **[⬇️ FlowMap_1.3.1_arm64-setup.exe](https://github.com/nazmiefearmutcu/flowmap/releases/download/v1.3.1.1/FlowMap_1.3.1_arm64-setup.exe)** · ~90 MB | run it — **native ARM64**, not emulated |
| 🪟 Windows x64 — *MSI, managed deployment* | **[⬇️ FlowMap_1.3.1_x64_en-US.msi](https://github.com/nazmiefearmutcu/flowmap/releases/download/v1.3.1.1/FlowMap_1.3.1_x64_en-US.msi)** · ~196 MB | standard MSI installer |
| 🪟 Windows ARM — *MSI, managed deployment* | **[⬇️ FlowMap_1.3.1_arm64_en-US.msi](https://github.com/nazmiefearmutcu/flowmap/releases/download/v1.3.1.1/FlowMap_1.3.1_arm64_en-US.msi)** · ~158 MB | standard MSI installer |
| 🐧 **Linux x64 — Debian/Ubuntu/Mint** | **[⬇️ FlowMap_1.3.1_amd64.deb](https://github.com/nazmiefearmutcu/flowmap/releases/download/v1.3.1.1/FlowMap_1.3.1_amd64.deb)** · ~479 MB | `sudo apt install ./FlowMap_1.3.1_amd64.deb` |
| 🐧 **Linux x64 — any distro, portable** | **[⬇️ FlowMap_1.3.1_amd64.AppImage](https://github.com/nazmiefearmutcu/flowmap/releases/download/v1.3.1.1/FlowMap_1.3.1_amd64.AppImage)** · ~354 MB | `chmod +x` it, then run it |

*Installer files keep the 1.3.1 name because the app bundle version must stay semver-valid; this release is v1.3.1.1.*

*Which Mac do I have?* → Apple menu → **About This Mac**: "Chip: Apple M…" = Apple Silicon, "Processor: Intel…" = Intel.
*Which Windows do I have?* → **Settings → System → About → System type**: "ARM-based processor" = ARM, anything else = x64.

### Verify your download

An installer from a stranger's GitHub deserves suspicion, and "the source is open" does not answer
it — the source is not what you downloaded. So every installer is signed at build time with a
**SLSA build-provenance attestation**: a public, Sigstore-backed statement binding that exact file's
digest to this repository, this workflow, and the commit it was built from.

```bash
gh attestation verify ~/Downloads/<the-file-you-downloaded> -R nazmiefearmutcu/flowmap
```

A pass prints the workflow run and commit that produced it. **A failure means the file did not come
from this repository — don't run it.** Each release also ships a `SHA256SUMS` asset, for a check
that needs no tooling: `shasum -a 256 -c SHA256SUMS`.

Every release from v1.3.1 onward carries attestations; v1.3.0's assets predate them. What the app
does on your machine — loopback-only server, no telemetry, no wallet or trading keys, no
auto-updater, and the full list of endpoints it talks to — is written down in
[SECURITY.md](SECURITY.md).

> **First launch — unsigned app warnings.** The apps are **ad-hoc / unsigned and not notarized**
> (code-signing certificates for a paid Apple Developer ID / Windows publisher are not available for
> this project), so the OS will warn on first open:
> - **macOS:** **right-click → Open** (confirm once), or run `xattr -cr /Applications/FlowMap.app`.
> - **Windows:** SmartScreen → **More info → Run anyway**.
>
> After the first confirmation the app launches normally. Do this *after* the attestation check
> above — the warning is about a missing certificate, and the attestation is what replaces the
> assurance that certificate would have given you.

Installers are produced per OS+arch on CI (native Python wheels can't be cross-built), and each one
boots its bundled server and answers `/api/health` on that OS before the release accepts it.
Platforms without a prebuilt installer — Linux on ARM and 32-bit systems — can **run from source**
(below).

On Windows ARM the ARM64 build ships one deliberate difference, for a reason outside this project's
control: `pyarrow` publishes no `win_arm64` wheel in any release, so that build omits it and
`cryptography` is pinned to the last version that has one. Neither is on a path FlowMap uses —
recording is polars, and the omitted pyarrow only serves an Arrow export FlowMap never calls — and
the release gate imports the full lazy closure on the machine that built it, so the difference is
measured rather than assumed. `app/README.md` has the table.

## Run it

Prereqs: Python 3.13 + [uv](https://docs.astral.sh/uv/), Node 22 + npm.

```bash
./scripts/dev.sh          # boots the server (:8720) + the client dev server (:5173)
# then open http://localhost:5173
```

Or manually:

```bash
# terminal 1 — server
cd server && uv sync && FLOWMAP_PORT=8720 uv run python -m flowmap_server
# terminal 2 — client
cd client && npm install && npm run dev
```

In the top-bar symbol search: pick `SIM-DEMO` (deterministic demo feed), a crypto pair
(`BTCUSDT` → live Binance), or a US ticker (`AAPL` → keyless two-sided SYNTH depth; real Alpaca L1
top-of-book + live tick during market hours with Alpaca keys).

**Optional live tiers** (auto-detected from the environment):
`ALPACA_API_KEY` + `ALPACA_API_SECRET` → equity L1 tick tape + quotes; `FINNHUB_API_KEY` → equity
tick tape. Without keys, equities run the honest keyless SYNTH tier.

## Tests

```bash
cd server && uv run pytest -q          # gateway: grid, protocol, sessions, feeds, recording
cd client && npm test && npm run e2e   # renderer units + Playwright (heatmap, perf gate, parity)
```

The Playwright suite includes the §10 performance gate (history-independent frame cost) and the
two-market parity matrix.

## Security

What FlowMap connects to, what it writes, what it never asks for, and how to verify a download —
[SECURITY.md](SECURITY.md). Vulnerabilities go to a
[private advisory](https://github.com/nazmiefearmutcu/flowmap/security/advisories/new), not a public
issue.

## License

Apache-2.0 — see [LICENSE](LICENSE).
