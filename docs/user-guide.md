# FlowMap user guide

How to install FlowMap, connect to a market, read the depth heatmap, and use
replay, measurement, alerts, the watchlist, drawings, indicators and export. For
how the pieces work inside, see [architecture.md](architecture.md); for
build/test commands, [development.md](development.md).

Contents: [Install](#install) · [First run](#first-run) ·
[Connecting](#connecting--picking-symbols) · [Reading the heatmap](#reading-the-heatmap) ·
[Replay](#replay--seek) · [Measure tool](#measure-tool) ·
[Price alerts](#price-alerts) · [Watchlist](#watchlist) · [Drawings](#drawings) ·
[Indicators & candles](#indicators--candles) · [Themes & language](#themes--language) ·
[Keyboard reference](#keyboard--pointer-reference) · [Export](#export) ·
[Health endpoint](#health-endpoint) · [Troubleshooting](#troubleshooting)

## Install

**Desktop app (recommended).** Download the installer for your platform from the
[releases page](https://github.com/nazmiefearmutcu0/FlowMap/releases/latest) —
macOS (Apple Silicon / Intel), Windows x64 / ARM64, or Linux (deb / AppImage).
Installers are self-contained: they bundle the client and a private Python
runtime, so nothing else needs to be installed and nothing is fetched at first
run. They are **unsigned**; verify the download with the SLSA build-provenance
attestation (`gh attestation verify <file> -R nazmiefearmutcu0/FlowMap`) or the
`SHA256SUMS` asset before bypassing the OS warning — the exact steps are in
[SECURITY.md](../SECURITY.md).

**From source.** You need Python 3.13 with [uv](https://docs.astral.sh/uv/) and
Node 22 with npm:

```bash
./scripts/dev.sh            # server on :8720 + vite on :5173
# then open http://localhost:5173
```

Manual boot and Windows/PowerShell variants are in the
[README](../README.md#quickstart-from-source). From source there is no
packaging step; the packaged app and the dev setup behave the same otherwise.

## First run

On the very first launch a short three-step tour appears: (1) connect and pick
a symbol, (2) mouse and keyboard navigation, (3) where the shortcuts overlay
lives. Notes on its honesty rules:

- **Skip** and **Done** dismiss the tour permanently; pressing `Esc` or
  clicking away only closes it for this session — it will greet you again next
  launch until you explicitly dismiss it.
- The tour is keyboard-accessible (focus is trapped inside while open and
  restored when it closes).

Pick `sim:SIM-DEMO` if you want to look around with no network and no keys; it
is a deterministic feed, so the same window of tape repeats identically.

## Connecting & picking symbols

Press `/` (or `Ctrl-K` / `⌘K`) for the symbol palette: a fuzzy, ranked search
over every subscribable symbol with live quote, movers and sparklines. Symbols
typed in either spelling (`ETH/BTC` vs `ETHBTC`) are translated, not rejected.

Market grammar (what you can type into the search or the socket):

- `sim:SIM-DEMO` — deterministic, offline.
- `<exchange>[-<segment>]:<SYMBOL>` — e.g. `binance:BTCUSDT`,
  `bybit-usdm:ETHUSDT`. Native incremental L2 on binance, bybit, coinbase,
  deribit, okx; every other ccxt venue via snapshot polling.
- `equity:AAPL` — keyless synthetic depth (Yahoo 1-minute bars) on a distinct
  amber ramp; with `ALPACA_API_KEY`/`SECRET` or `FINNHUB_API_KEY` in the
  environment it upgrades to real L1 top-of-book and tick tape during market
  hours.

**Capability badges, never silent downgrades.** The top bar shows what the
active feed actually delivers — `L2` / `L1` / `SYNTH`, `TAPE TICK` / `TAPE
POLL`, `SIDE EXCHANGE` / `SIDE NA`. If a badge says the side or the tape is
degraded, that is the truth of the stream, not a UI guess.

Up to 4 sessions can be subscribed at once (`FLOWMAP_MAX_SESSIONS`).

## Reading the heatmap

The chart is a column-per-tick heatmap of **resting liquidity**: time flows
left → right, price is the vertical axis, and color intensity is how much
bid/ask size rests at that price during that column. Because each column is
rasterized to the GPU once, pan/zoom stays smooth no matter how deep the
history. Zoom with the wheel (time at the cursor), Shift/Ctrl+wheel (price) or
the price gutter (wheel = zoom, drag = scale, double-click = re-fit). The
crosshair shows the exact per-cell liquidity readout.

**Depth channel modes** choose what the colors mean. Press `C` to cycle, or use
the *Depth channel* segmented control in `Settings → Display`:

| Mode | Shows | Notes |
|---|---|---|
| `sum` (default) | bid + ask density | The classic view, unchanged since the first release. |
| `bid` | bid-side density only | Normalized with the same percentile pipeline. |
| `ask` | ask-side density only | As `bid`, other side. |
| `imbalance` | signed `(bid−ask)/(bid+ask)` | Fixed −1…+1 scale; one end of the divergent blue↔orange ramp is bid-heavy, the other ask-heavy; the neutral middle is balance. |

The setting persists across launches. If the active session is a synthetic
(SYNTH) feed — which has no real two-sided book — the renderer keeps showing
the honest `sum`/amber view and re-applies your channel when a real-depth
session is active again.

Three colormaps (`flow` default, `inferno`, `classic`), tolerance, contrast,
normalization percentile and overlay toggles live in the settings drawer
(gear icon). The DOM ladder (right rail) shows the live book around the
crosshair; the tape below it streams trades, with outsized prints highlighted
at a configurable notional threshold (`Settings → Big trade size`); the CVD
pane is locked to the chart's time axis.

## Replay & seek

Everything a session shows is recorded to parquet on disk (20 GB rotating cap,
disable with `FLOWMAP_RECORDING_ENABLED=0`). Toggle live → replay in the top
bar; the timeline at the bottom becomes a transport with a minimap:

- **Seek** by clicking/dragging the playhead; **speed** 1–100×; **pause**.
- `Space` plays/pauses; `R` returns to the live edge; the **Go Live** pill
  appears the moment you scroll off the live edge.
- Replay is **honest**: it plays back exactly what was recorded. A replay
  request with no usable recording is refused explicitly, a stale recorded
  tail is refused rather than relabeled live, and where a recorded tail meets
  a live edge a gap marker is shown instead of invented continuity.
- **Bounded loads.** A replay with no explicit window loads the newest bounded
  window of the recording (the grid ring, or `FLOWMAP_REPLAY_MAX_COLS` if set)
  and warns if the recording was truncated to fit. The wire and the client
  already support a `[start_t, end_t)` subscription window (re-subscribed as a
  distinct session), but there is **no UI to pick a window yet** — the
  interactive window picker is still on the [roadmap](../ROADMAP.md).

## Measure tool

Press `M`, then click-drag on the chart. A dashed rectangle shows:

- **Δprice** — absolute (signed) and % between the two corners,
- **Δtime** — humanized (ms/s/m/h/d),
- **depth** — resting size inside the rectangle's row band, read from the
  settled book.

If a value cannot be computed honestly (off-grid corner, no book yet), the
readout shows `—` instead of a guess. `Esc` cancels the drag or clears the
result; a completed measurement stays until the next click. The tool works in
replay too. Press `M` again (or `Esc`) to disarm.

## Price alerts

Price alerts are **client-local**: they live in your browser's
`localStorage`, per symbol, and are evaluated against the live book mid (or
last trade) about ten times per second — they never leave your machine.

- Press `A` to create an alert at the crosshair price; the bell button
  (chart's bottom-right) opens the alert list, where you can type an exact
  level, delete, snooze, manually re-arm, or clear fired alerts.
- Direction (above/below) is derived from the market mid at creation time.
- When a level crosses: the line marker turns solid red and pulses briefly, a
  toast names the symbol, an optional chime plays (`Settings → Alerts → Alert
  sound`, on by default), and the alert moves to a fired log.
- **Re-arm is price-based, not timer-based.** A fired alert stays latched until
  the price returns past a re-arm band (~0.1% beyond the level); the next
  crossing then fires. A price hovering at the level therefore cannot spam.
  Snooze is a 60-second mute of the alert (it no longer clears the latch);
  `re-arm` in the popover arms it again immediately while keeping the band.
- **Non-active symbols keep watching.** A background monitor polls the server's
  quote endpoint (10 s cadence, paused while the browser tab is hidden) for
  every symbol you have alerts on, so you still get the toast/chime while
  another symbol is on the chart. It only evaluates fresh quotes — a stale or
  unreachable quote never fires an alert.
- **Replay is honest here too.** While the chart is in replay mode the
  book-price evaluator pauses (historical prices must not fire a "live" alert);
  the quote monitor above keeps running on live REST data.
- Limits: at most 50 alerts per symbol (oldest evicted).

Alerts are edge-triggered per crossing; removing the alert or clearing fired
entries is immediate and local.

## Watchlist

The watchlist is a small favorites rail above the DOM ladder: a persistent,
local list of `market:symbol` keys you want at a glance.

- **Add** — the `+ Add current` button adds the symbol on the chart. The list
  holds up to 30 favorites; adding a 31st is refused (nothing is silently
  evicted).
- **Select** — click a row (or press Enter on it) to switch the chart to that
  symbol; the active row is highlighted.
- **Remove** — click the star (`★`) toggle or the `×` control on a row; neither
  selects the row.
- **Quotes** — every row shows the live price and signed change with a
  sparkline, refreshed from a shared 10-second poll that pauses while the tab
  is hidden. Rows dim with a `stale` chip when the venue quote is stale;
  unreachable symbols show `—` rather than a guessed price.
- **Empty state** — until you pin something, the panel offers your recent
  symbols as one-click suggestions (suggestions don't auto-favorite).

The list persists in your browser (`flowmap.watchlist.v1`) per machine and
never leaves it.

## Drawings

Annotate the chart with the drawing toolbar (color and clear-all included):

- **Tools**: trendline, horizontal ray, rectangle, Fibonacci retracement,
  horizontal line, and text.
- **Edit**: select a drawing to move or resize it; delete removes it.
- **Persistence** is per market:symbol in `localStorage` — your BTCUSDT
  trendlines are waiting for you next session, and your ETHUSDT chart is not
  polluted by them.
- Anchors are stored in **chart space** (price + time), so drawings follow the
  data when you pan, zoom or replay — not the pixels.

`Esc` deselects/cancels the armed tool. Drawing overlays sit above the heatmap
and never eat chart pan/zoom unless a tool is armed.

## Indicators & candles

On top of the depth heatmap you can synthesize classic price structure from
the same stream:

- **Candles** — OHLC bars built from the tape/price stream, with a selectable
  interval (1m/5m), drawn in sync with the depth columns.
- **Indicators** — a picker with editable parameters covering the common
  overlays: **EMA, SMA, RSI, VWAP, Bollinger, MACD**. Overlays draw on a
  canvas riding the same price scale as the heatmap; RSI/MACD style panes
  align to the chart's time axis.

Kernels are pure, unit-tested functions; the overlay is a visualization of
exactly the column data the server delivered.

## Themes & language

- **Themes** — press `T` to cycle seven palettes: `midnight` (the default dark,
  identical to the original palette), `paper` (light), `swiss` (high-contrast
  light), `amber` (warm dark terminal), `sea` (deuteranopia-safe: the sell side
  reads blue, warnings violet), `paper-deut` (light deuteranopia: teal bid /
  blue ask) and `contrast` (true-black, maximum-contrast ink). First launch
  follows your OS light/dark preference; your explicit choice persists. Canvas
  overlays (grid, axes, markers) follow the theme, not just the chrome.
- **Language** — the interface ships in English with a Turkish translation of
  the shell (top bar, settings drawer, banners, shortcuts overlay, onboarding,
  toasts). The choice persists; missing translations fall back to English
  text, never to raw key names. Feature panes are English-only for now (see
  the [roadmap](../ROADMAP.md)).

## Keyboard & pointer reference

Press `?` in the app for the live overlay (it is generated from the same
source of truth as this table — `client/src/ui/keysheet.ts`).

| Input | Action |
|---|---|
| `Space` | Follow the live edge · play/pause in replay |
| `/` or `Ctrl-K` / `⌘K` | Symbol search palette |
| `E` | Export the chart as a PNG download |
| `M` | Measure tool — drag on the chart for Δprice / Δtime / Δdepth |
| `A` | Price alert at the crosshair price (list: bell button on the chart) |
| `H` | Perf HUD — fps / frame ms / uploads / draws / cache |
| `C` | Cycle depth channel: sum → bid → ask → imbalance |
| `T` | Cycle theme (midnight → paper → swiss → amber → sea → paper-deut → contrast) |
| `?` | Toggle the shortcuts overlay |
| `←` `→` `↑` `↓` | Pan time / price (chart focused) |
| `+` / `−` | Zoom time (chart focused) |
| `F` | Toggle time follow (chart focused) |
| `P` / `Shift+P` | Price track on/off · re-fit price |
| `R` | Return to the live edge |
| `Esc` | Close dialogs (search · settings · shortcuts) · cancel a measure drag · deselect a drawing |
| Wheel on chart | Zoom time at the cursor column |
| `Shift`/`Ctrl` + wheel | Zoom price at the cursor row |
| Drag on chart | Pan both axes (natural drag) |
| Wheel on price gutter | Zoom price at the cursor row |
| Vertical drag on price gutter | Scale the price axis about the viewport centre |
| Double-click on price gutter | Re-fit the price axis |

## Export

Two exports, both local:

- **Chart PNG** — `E` or the TopBar camera button renders the heatmap plus
  overlays (crosshair, markers, axes) to a PNG download. This is a picture of
  what you see.
- **Raw column data** — the server streams the finalized density grid:

  ```bash
  # last 240 columns (default) of the active session as CSV
  curl -OJ "http://127.0.0.1:8720/api/export?format=csv"

  # explicit symbol, JSON, last 1000 columns
  curl -s "http://127.0.0.1:8720/api/export?format=json&columns=1000&symbol=binance:BTCUSDT" -o btc.json
  ```

  CSV starts with a `#` metadata comment (symbol, market, tick, column
  cadence, extents) then one row per column of raw bid/ask values per price
  row; JSON is `{"symbol","tick","columns":[{"t0","bids","asks"}]}`. `columns`
  is clamped to what the ring still holds; oversized requests are refused with
  a structured error rather than truncated silently.

## Health endpoint

`GET /api/health` is the operational snapshot — useful for "is it alive, and
how healthy is the session?" without touching the app. Alongside status,
version, wire-protocol version, uptime and recording-enabled, v3 adds a
`stats` object (when the stats producer is present; `stats_available` says
so): drop counters per source, restarts, active/rejected sessions, real
measured WebSocket latency (`latency_ms`, EMA), per-feed staleness
(`staleness_ms`), `clock_skew_ms`, and recording health (flush failures, last
flush time). The server passes the producer's snapshot through unreshaped, so
scripts can rely on field names.

## Troubleshooting

**Nothing connects / the chart is empty**

- Open `http://127.0.0.1:8720/api/health` in a browser. If it answers, the
  sidecar is fine and the problem is the client↔server link; if not, see the
  next point.
- From source, the server logs to **stderr**; set `FLOWMAP_LOG_FILE=<path>` to
  also tee logs to a file. The desktop app spawns the sidecar itself and
  restarts it if it dies mid-session.

**WebSocket closes with `1008 — origin not allowed`**

The server only accepts browser origins it knows (localhost/127.0.0.1 dev
origins and the Tauri webview origins). If you serve the client from a
different origin, set `FLOWMAP_WS_ALLOWED_ORIGINS` to a comma-separated list
(e.g. `http://192.168.1.10:5173`) — or `*` to disable the check entirely on a
machine where that is acceptable. Requests with no `Origin` header
(non-browser tools like `curl`/scripts) are never blocked.

**WebSocket closes with `1013 — connection cap reached`**

Too many simultaneous WS connections for one server process (default cap 16,
`FLOWMAP_WS_MAX_CONNECTIONS`). Close stale tabs/scripts or raise the cap.

**Subscribe refused: limit / no-recording / no-feed**

Session cap is 4 (`FLOWMAP_MAX_SESSIONS`). Replay of a symbol with recordings
disabled or missing is refused with an explicit reason — nothing is faked.
Recordings live under `~/.flowmap/recordings/` (override:
`FLOWMAP_DATA_DIR`).

**vite fails to start on Windows**

vite's dev server can fail when the repo path contains non-ASCII characters.
Check out to an ASCII-only path, or use `scripts/dev-windows.ps1`, which
resolves the real path first.

**Port conflicts**

From source, `FLOWMAP_PORT` moves the server (vite's proxy targets whatever
you set it to). The packaged app picks a free loopback port itself, so a stuck
8720 cannot block it.
