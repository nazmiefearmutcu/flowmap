# FlowMap — Dual-Market Order-Flow Visualizer

**Date:** 2026-07-17
**Status:** Approved for implementation (autonomous session; user directive: full rebuild, do not
stop until both markets verified). Revised after a 4-lens adversarial review (GPU renderer,
protocol/backpressure, equity parity, completeness); all high/medium findings incorporated.
**Branch:** `v2` in `nazmiefearmutcu/flowmap`

## 1. Why a rebuild

FlowMap v1 (PyQt6, ~14.7k LOC) has two fatal, *structural* problems:

1. **Pan/zoom collapses to ~1 fps.** Every pan step (`scroll_time` → `rebuild_heatmap`) and every zoom
   wheel notch re-rasterizes the entire visible history window on the CPU:
   a Python per-column loop (`_rebuild_fill_column_range`, heatmap_widget.py:888), two full-grid
   `scipy.ndimage.gaussian_filter1d` passes plus full-grid normalize/LUT (`_rebuild_finalize`, :973),
   over a `deque(maxlen=10000)` history at `buf_h = vis_rows*5` rows. Cost is O(history × height)
   *per frame*. The 50 ms throttle cannot save a >500 ms rebuild. The v1 benchmarks only measured the
   cheap live-append path and never exercised pan/zoom, which is why the README claims 100+ fps.
2. **The "GPU" path is not GPU.** `QOpenGLWidget` only blits a CPU-computed QImage. All density math,
   smoothing, and colormapping is NumPy on the GUI thread.

Additionally v1 is crypto-only, and the UI design quality is poor. Incremental fixes were mapped in
`bug_hunt/` (R01, R09) and never landed; the architecture makes them palliative. v2 is a ground-up
rebuild.

## 2. Goals

- **G1 — Perf:** 60 fps pan/zoom/scale at any history depth. Interaction cost must be
  **independent of history size** (transform-only rendering). Hard gates in §10.
- **G2 — Order-flow standard:** liquidity heatmap, DOM ladder, volume bubbles, time & sales,
  CVD, VWAP, volume profile, imbalance, large-lot/iceberg markers, event markers, crosshair
  liquidity readout, auto-follow, replay.
- **G3 — Dual market, honest feature parity:** crypto (Crypcodile) and US equities (stockodile).
  **Every feature is present in both markets with an honest capability state** — full fidelity,
  reduced fidelity with a badge, or an explicit labeled N/A ("requires tick tape / L2"). Nothing is
  silently degraded and nothing fabricated is rendered as measured data.
- **G4 — Modern frontend:** dark, dense, professional trading-terminal aesthetic.
- **G5 — Verifiable:** automated FPS gates and a two-market feature-parity test matrix must pass
  before "done".

## 3. Non-goals

- Order execution / trading (data visualization only).
- Paid data subscriptions (free tiers and keyless sources only; keyed free tiers are optional
  enhancements, auto-detected from env).
- Windows/Linux packaging (macOS first; web stack keeps ports open).
- Reusing any v1 rendering code. v1 stays intact on `main` until v2 replaces it.

## 4. Approaches considered

| | Approach | Verdict |
|---|---|---|
| A | PyQt6 + real GPU (VisPy/GLSL inside Qt) | Single-process, but GLSL-in-Qt tooling is painful, UI polish ceiling is low, automated UI/perf testing is weak. Repeats v1's ecosystem trap. |
| B | **Web client (TypeScript + WebGL2) + Python asyncio gateway** | **Chosen.** GPU texture rendering makes pan/zoom transform-only (structurally solves G1). Best design ceiling (G4). Fully automatable in-browser perf/e2e testing (G5). Python gateway imports Crypcodile/stockodile in-process (both are Python ≥3.12 libraries with the same Sink/collect architecture). Proven model (professional web-based order-flow terminals). |
| C | Native Rust/wgpu | Max raw perf but slowest to build and cannot import the Python data layer in-process; IPC needed anyway. Perf headroom of B is already far above target. |

Packaging note: run as `server + browser window` first. The user's showMe project proves the
Tauri + sidecar route if a native shell is wanted later; nothing in this design blocks it.

## 5. Architecture overview

```
┌────────────────────────── client/ (TS, Vite, React, WebGL2) ──────────────────────────┐
│  Heatmap GL engine   DOM ladder   Tape   Bubbles/overlays   Timeline   Replay ctrls   │
│  - TEXTURE_2D_ARRAY tile ring     - pan/zoom = view transform only                    │
│  - column append = texSubImage3D  - SUM-mips via FBO passes; LUT in fragment shader   │
└──────────────△ binary WebSocket (snapshot + deltas) ── REST (symbols/capabilities) ───┘
               │ 127.0.0.1 only
┌──────────────┴────────────── server/ (Python 3.13, uv, asyncio) ──────────────────────┐
│  api/      ws.py (binary frames, FastAPI+uvicorn)  rest.py (search/capabilities/     │
│            replay catalog)                                                            │
│  core/     grid.py (time×price ring + epochs)  book.py  session.py  detect.py         │
│            record.py (self-recording, retention-capped)                               │
│  feeds/    crypto.py (Crypcodile connectors)  equity.py (stockodile providers +       │
│            direct YahooClient warmup)  sim.py (deterministic synthetic market)        │
└───────────────────────────────────────────────────────────────────────────────────────┘
        │                                  │
   Crypcodile (WS: Binance/OKX/Bybit/    stockodile (Alpaca IEX WS if keys; Finnhub WS
   Coinbase/Deribit; L2 depth + trades;   if key; keyless: Yahoo 1m bars + last-price
   lake replay via DuckDB/Parquet)        polling; SEC/EDGAR universe; USMarketCalendar)
```

One server process. Sessions are keyed by `session_id`; a session wraps a shared
(feed, grid) for one `(market, symbol, mode[, recording])` and is refcounted by subscribing
clients (§11). The client is a pure renderer of the canonical stream; it contains no
market-specific logic. Note: stockodile's `YahooClient` is a plain REST client, not a Sink
provider — `feeds/equity.py` drives Sink providers for streaming *and* direct YahooClient calls
for 1 m-bar warmup/refresh.

## 6. Canonical stream model & wire protocol

### 6.1 Events

msgspec structs are the **in-process representation only**; the wire encoding is hand-packed
binary per §6.2 (msgspec does msgpack/JSON, not C layout). Canonical events:

- `Hello {protocol_version, session_id, grid_epoch, epoch_params, capability_descriptor, norm_seed}`
  — first message after subscribe; server rejects mismatched protocol majors.
- `EpochStart {epoch, epoch_params(tick, tick_multiple, dt, p0, rows)}` — announces every new
  epoch in-stream (re-anchor, coarsen, seek) so the client never round-trips to learn grid
  geometry.
- `Trade {ts_ns, price, size, side(buy|sell|unknown), side_src(exchange|inferred|na), venue}`
- `BBO {ts_ns, bid_px, bid_sz, ask_px, ask_sz}`
- `DepthColumn {epoch, t0_ns, col_seq, mode(L2|L1_BAND|SYNTH_PROFILE), final, bid[f32×n], ask[f32×n]}`
  — density is **time-weighted resting size** over the interval (§8.1). In `SYNTH_PROFILE` mode
  only `bid[]` is filled (single-channel density) and the client renders it with a distinct
  non-bid/ask colormap.
- `BarColumn {epoch, t0_ns, col_seq, ohlc, vol_buy, vol_sell, cvd_cum, vwap_num_cum, vwap_den_cum}`
  — `*_cum` fields are **session-cumulative running totals** so dropped columns self-heal.
- `Marker {ts_ns, kind(liquidation|halt|luld|gap|session_break|large_lot|iceberg|info), price?, size?, text}`
- `Status {feed_state(live|degraded|closed|reconnecting), capability_descriptor, latency_ms, clock_skew_ms, next_open_ts?}`
- `Ping {server_send_ns}` / `Pong {echo, client_recv_ns}` at ~1 Hz — sources `latency_ms`/skew;
  there is no other clock mechanism.
- Client→server control: `Subscribe {market, symbol, mode(live|replay), source?, start_t?}`,
  `Unsubscribe`, `Seek {t}`, `SetSpeed {x}`, `Pause`, `Resume`,
  `HistoryRequest {req_id, before_t, n_cols}`.
- `HistoryResponse {req_id, epoch, oldest_available_t, depth_cols[], bar_cols[], markers[], big_trades[]}`
  — server returns the available intersection (possibly empty); `oldest_available_t` tells the
  client when scroll-back is exhausted. `big_trades` = trades ≥ bubble threshold, so historical
  bubbles render without shipping full tape history.

### 6.2 Framing

Every message: envelope `{u8 type, u8 ver, u16 flags, u32 payload_len}` then payload; messages
batched per WS frame, flushed 10–30 Hz. Unknown types are skippable via `payload_len`. Tag
ranges: 0x01–0x3F data, 0x40–0x7F control, 0x80+ reserved. Bulk f32 payloads are padded to
4-byte alignment within the frame so the client can create zero-copy `Float32Array` views
(little-endian assumed; `DataView(littleEndian=true)` for headers). The protocol table lives in
one source (`server/src/flowmap_server/proto/protocol.py`) and is mirrored to
`client/src/proto/protocol.ts`; cross-language **golden-vector tests** (§12) keep them in lockstep.
`permessage-deflate` is enabled (depth payloads are sparse and highly compressible).

### 6.3 Sessions, snapshot, resync

- **Identity:** every column message carries `(epoch, t0_ns, col_seq)`. `grid_epoch` increments on
  any change to `(tick, tick_multiple, dt, p0 basis)` — including re-anchoring (§8.2) and replay
  seeks; each is announced in-stream by `EpochStart`. Columns for an epoch the client has no
  `EpochStart` for are buffered briefly, then a re-snapshot is requested; a `Seek`-induced epoch
  clears live tiles and re-snapshots. Dedupe key: `(epoch, col_seq)`.
  Finalized columns are **immutable**; the in-progress column is progressively re-sent each flush
  (replace-in-place by `(epoch, col_seq)`, `final` flag marks the last write) so the right edge is
  never stale by more than a flush interval even at dt = 15 s.
- **Snapshot on subscribe:** `Hello` + last **512** depth+bar columns + Markers in that range +
  last 500 trades (tape warm-up) + current book/BBO. Chunked into ≤64-column WS frames interleaved
  with live deltas; the client backfills older history via prioritized `HistoryRequest`s.
- **Reconnect:** WS drop → auto-reconnect → re-subscribe → snapshot; client reconciles by
  `(epoch, col_seq)` — idempotent because finalized columns are immutable.
- **Backpressure (per client, live and replay identically):** send queues are per-client and
  bounded. Depth/bar columns are **never coalesced**; on lag (oldest-unsent age >2 s) the server
  drops oldest whole columns and emits a `Marker{kind=gap}` — dropped columns remain in the ring
  and are recoverable via `HistoryRequest`. Tape/BBO messages may be coalesced (latest-wins).

## 7. Capability model — honest dual-market parity

Per (market, provider) capability descriptor; it drives badges and explicit N/A states, never
silent degradation.

| Channel | Crypto (Crypcodile) | Equity, Alpaca keys (IEX) | Equity, Finnhub key | Equity, keyless |
|---|---|---|---|---|
| Depth | **L2 full book** (Binance/OKX hardened resync; Bybit/Coinbase best-effort) | **L1_BAND** (real IEX BBO px+sz) | — (N/A badge) | **SYNTH_PROFILE** (volume-at-price from 1 m bars) |
| Tape | tick (exchange side) | tick (side **inferred**, quote rule vs L1) | tick (side inferred, tick rule) | last-price poll ~10 s, display-only |
| CVD / bubbles | full | full, badge "inferred side" | full, badge "inferred side" | CVD: **N/A** ("requires tick tape — add ALPACA/FINNHUB keys"); bubbles: 1-minute aggregates from Yahoo bar volume deltas, badge "1m AGG" |
| Imbalance | L2 multi-level | "BBO imbalance (1 level)" badge | N/A badge | N/A badge |
| Iceberg | L2 refill detection | N/A ("requires L2") | N/A | N/A |
| Large-lot | rolling-percentile on tape | same (inferred side) | same | N/A (no tick tape) |
| DOM ladder | L2 ladder | L1 row + volume-profile rows (labeled) | N/A → profile ladder (SYNTH) | volume-profile ladder (SYNTH label) |
| Markers | liquidations (`@forceOrder`), gaps | halts via Alpaca `statuses` channel (**requires stockodile connector extension**, TradingStatus schema already exists); LULD is SIP-only → N/A; gaps | gaps only | gaps only |
| VWAP | from tape | from tape (Alpaca bar `vw` seeds) | from tape | from 1 m bars Σ(typical×vol)/Σvol, badge "approx" |
| Replay | Crypcodile lake + self-recording | self-recording | self-recording | self-recording + Yahoo 1 m warmup (7 d) |

Rules and honesty constraints:

- The L1_BAND heatmap may add **decorative** queue-decay shading around the BBO band; shaded
  texels are visually distinct (low-alpha hatch) and **excluded from every numeric feature** —
  crosshair readout off the BBO row returns "N/A (L1)".
- Keyless google_finance prints (synthetic size 1.0) drive **only** the last-price line and tape
  display marked SYNTH; they never feed CVD, bubbles, or profiles. Yahoo is warmup + slow refresh
  (≥60 s/symbol, token-bucket ~1 req/1.5 s with 429 backoff); google_finance is CSS-scrape-fragile —
  fallback chain `msn_money → stooq`, and a "stale tape" marker when all pollers fail.
- Keyless grid cadence dt = **10 s** (matches the ~10 s poll cycle; no half-empty columns);
  Alpaca/Finnhub equity dt = 1 s; crypto dt = 250 ms.
- Equity trade side: US tapes carry no aggressor side. Server infers it in `feeds/equity.py`
  (quote rule/Lee-Ready against Alpaca L1; tick rule for Finnhub) and stamps `side_src=inferred`.
- Keys auto-detected from env (`ALPACA_API_KEY/SECRET`, `FINNHUB_API_KEY`); currently absent on
  this machine → the keyless tier must be genuinely useful and honest; keyed tiers activate with
  no code changes.
- `record.py` records every live session's canonical stream to Parquet (polars) with a size-capped
  retention policy (default 20 GB, prune oldest, off-switch in config), giving equities
  first-class replay parity by self-recording.

### 7.1 Equity session model

`stockodile.scheduler.calendar.USMarketCalendar` (America/New_York, holiday-aware; DST inherited
from zoneinfo) is the authority. Columns advance only 04:00–20:00 ET; extended hours render
shaded (IEX prints are RTH-only — noted in the capability descriptor). Outside the window:
`Status{feed_state=closed, next_open_ts}`, UI banner + countdown, **no empty-column
accumulation**. Session boundaries emit `Marker{kind=session_break}` and render as labeled breaks
in the time axis (order-flow-style compressed gap). Crypto runs 24/7 with no session logic.

## 8. The renderer core (G1 mechanism)

### 8.1 Server grid (`core/grid.py`)

Per session: a NumPy ring of columns at fixed cadence dt (§7) and fixed price grid per epoch.
Density semantics: **time-weighted resting size** — each book update adds
`prev_depth × (t_now − t_prev)` into the current column; finalize divides by dt. Two different
update cadences over the same book must produce byte-identical columns (golden test, §12); this
prevents venue update-rate from masquerading as liquidity. Accumulation is vectorized
(`np.add.at` on level-index arrays); no per-level Python loops. Current column accumulates in
f32; finalized columns are stored f16 in the ring.

Ring: default 32 768 columns (~2.3 h crypto @250 ms, ~9 h equity @1 s). Worst-case RAM
32 768 × 4 096 × 2 × 2 B ≈ 512 MiB/session; typical (≤2 048 rows) ≤256 MiB. Default max
**4 concurrent sessions** (config), idle teardown after last unsubscribe + 60 s grace.
`HistoryRequest` beyond the RAM ring is served from the session's own recording (Parquet, slower
path) — scroll-back is bounded only by disk, not RAM.

**Restart:** on session start, rehydrate the ring tail from the newest self-recording for that
(market, symbol) if it is fresher than one ring span; else cold-start with a `gap` Marker. Crypto
sessions may additionally warm up from the Crypcodile lake when local data exists.

### 8.2 Price grid, epochs, drift

`tick_multiple` is fixed **at session start**: target span ≈ 8 % of price, rows ≤4 096
(`rows = span / (tick × multiple)`). All columns in an epoch share one `(p0, tick, multiple, dt)`
— there is **no per-column p0**, which keeps tiles row-aligned and mips valid. When mid-price
exits the central 70 % of the span, the server **re-anchors**: bumps `grid_epoch`, re-centers p0,
and continues; history is *never* re-binned. The client keeps per-epoch tile groups, each
rendered with its own row→price affine transform (still transform-only; one draw batch per
visible epoch, epochs on screen are ≤ a handful). If a fast market exhausts re-anchoring
(pathological), a new epoch with a coarser multiple starts and a boundary Marker is emitted.

Tick-size metadata: crypto from Crypcodile `InstrumentRegistry` with a defined fallback when
`tick_size is None` (derive from observed book level spacing, else price-magnitude table);
equity per SEC Rule 612 ($0.01 for ≥$1.00, $0.0001 below; sub-penny prints are binned, never
rejected).

### 8.3 Client renderer (WebGL2)

- **Storage:** one `TEXTURE_2D_ARRAY` per channel pair, 256 cols × rows × layers, `RG16F`
  (bid/ask). texelFetch-based manual filtering in the fragment shader — this sidesteps the
  16-texture-unit bind limit, kills tile-seam artifacts (cross-layer taps), and enables correct
  sum-filtering. Column append = one `texSubImage3D` (Float32Array source, ≤32 KB; driver
  converts to f16).
- **Value encoding:** per-instrument fixed scale from the capability descriptor, chosen so p99.9
  level size ≈ 1e2 (uniform-carried; f16 max 65 504 then survives ×256 sum-mips). Golden
  round-trip test bounds the encode error (§12).
- **Mips are SUMS, not averages** (a 500-lot wall must stay a 500-lot wall zoomed out):
  incremental GPU downsample passes (ping-pong FBO, 4×4 SUM) into level-1/-2 array textures on
  every 4th/16th column append. `EXT_color_buffer_float` is a **hard requirement** checked at
  startup. Rendering selects level explicitly (textureLod-equivalent via texelFetch at level) and
  folds the 1/16^L rescale into the normalization uniform; between-level zooms do a manual 2–4
  tap SUM over the finer level. `generateMipmap` is never used (produces ×2 averages). The
  downsample shader saturates sums at 60 000 (f16 max is 65 504; an extreme wall ×256 at level 2
  can overflow — saturation is visually inert because the normalization percentile sits far
  below, and numeric readouts come from the CPU cache, not texels).
- **Residency policy (the §10 memory gate assumes this):** full-res tiles for a recent window of
  ~16 k columns (≈256 MB at 4 096 rows); older ranges resident at mip levels only; LRU eviction
  of full-res tiles, re-fetch via `HistoryRequest` on deep-scroll zoom-in. Deep zoom-out renders
  exclusively from mips, so full extent never needs native residency. `webglcontextlost` →
  recreate context, re-fetch visible range from server (client also keeps a compact CPU column
  cache for the crosshair, which doubles as instant-recovery data).
- **Normalization:** client-side. Coarse CPU histogram (256 bins) per tile updated at
  append/backfill; on pan/zoom settle the visible tiles' histograms merge (<1 ms), percentile
  extracted, EMA-smoothed, ×16^L when rendering a mip level. `Hello.norm_seed` seeds the first
  frame. Panning into an overnight-liquidity regime renormalizes to the viewport, not the live
  edge.
- **Crosshair liquidity readout** reads the CPU column cache (exact grouped sums), never
  GPU-filtered texels.
- **Overlays** (bubbles, VWAP, profile, markers) are instanced GL sprites/lines + one 2D-canvas
  text layer. Frame loop: rAF, render only on dirty (new data or view change).

## 9. UI design

Trading-terminal aesthetic: near-black background, thermal heatmap (deep blue → cyan → yellow →
white), buy/sell accent pair (teal/red), JetBrains Mono numerics, dense but breathable layout.
SYNTH_PROFILE mode uses a visually distinct single-hue colormap. Layout: left = heatmap
(dominant) with price axis right and time axis bottom; right rail = DOM ladder + tape
(collapsible); top bar = dual-market symbol search (crypto pairs from Crypcodile registry, US
tickers from SEC universe), venue picker, capability badges, live/replay toggle, clock; bottom =
timeline minimap with session extent + replay transport (play/pause/speed 1–100×/seek). Settings
drawer: colormap, normalization, tick grouping, bubble threshold, follow mode, recording
retention. Keyboard: arrows pan, `+/-` zoom, `F` follow, `R` reset, `Space` play/pause. The
frontend-design skill is applied at implementation time; this section fixes information
architecture only.

## 10. Performance budget (hard gates, automated)

| Metric | Gate |
|---|---|
| Pan (drag & keyboard) with ≥10 000 columns loaded | ≥55 fps sustained |
| Continuous wheel zoom (time & price) | ≥55 fps sustained |
| Input → frame latency (CDP input timestamp → presentation, harness pinned to the built-in 120 Hz display) | <32 ms p95 (<2 vsync of active refresh) |
| Live append stress (dt=50 ms columns, 2 000-level book — explicit stress config, not the shipped default) | server grid update <2 ms; client decode+upload+mip-pass+frame <8 ms |
| Client GPU memory under the §8.3 residency policy | ≤300 MB |
| Cold start to first heatmap (sim source) | <3 s |

Measured by a Playwright/CDP harness driving synthetic input against the sim feed with a
pre-loaded 10 k-column history; runs headed on this Mac; results written to `perf_report.json`.

## 11. Error handling & lifecycle

- Feed reconnect/backoff/gap-resync inherited from Crypcodile (`gap_bridge`) and stockodile
  (`Provider.run` supervision); gaps surface as `Marker{kind=gap}` + visual hatching, never
  silent interpolation.
- Sessions: refcounted by subscribers; feed+grid shared; **send queues, lag and drop state are
  strictly per-client** (§6.3); teardown after last unsubscribe + 60 s grace. A crashed session
  restarts with backoff and reports via `Status`; other sessions unaffected.
- Replay is a session variant `(market, symbol, mode=replay, source)` with its own `session_id` —
  live and replay of the same symbol coexist. The server owns the replay clock and re-emits the
  canonical stream at the requested speed; `Seek` = bump epoch, clear ring, fresh snapshot at the
  target time. Backpressure rules apply identically (at 100× crypto ≈ 13 MB/s on loopback — fine).
- Keyless equity is an explicit UI state, not an error. Feed-poller failures escalate
  `Status{degraded}` with the failing provider named.
- Config: single env-first source (`FLOWMAP_PORT` default 8720, vite dev 5173,
  `ALPACA_API_KEY/SECRET`, `FINNHUB_API_KEY`, ring/cadence/retention overrides). Server binds
  **127.0.0.1 only — asserted in code**, CORS restricted to the client origin. Recording
  retention: 20 GB cap, prune oldest, toggleable.

## 12. Testing strategy

- **Server unit (pytest):** grid golden tests (book fixture → expected column; **two update
  cadences → byte-identical column**), epoch re-anchor invariants (history never re-binned),
  encode round-trip error bounds, both feed adapters against recorded fixtures, side-inference
  rule tests, record/replay round-trip, protocol encode golden vectors.
- **Client unit (vitest):** view/epoch transform math (pan/zoom/fit/follow across epoch groups),
  protocol decode against the same golden vectors (cross-language lockstep), histogram/
  normalization, LUT.
- **E2E (Playwright):** boots server (sim feed), asserts heatmap pixels change, exercises every
  feature; **perf gates of §10**; visual snapshots per pane; context-loss recovery test.
- **Parity matrix (the G3 gate):** every feature × {crypto-sim, equity-sim(keyless-shaped),
  equity-sim(alpaca-shaped), crypto-live(Binance BTCUSDT), equity-live(keyless AAPL)} — each cell
  asserts the *specified* state: full, badged-reduced, or explicit N/A per §7's table. Automated
  where possible; live cells verified in a headed browser session with screenshots before
  declaring done.
- **Live verification:** real Binance WS and real keyless equity session observed ≥5 min each,
  pan/zoom exercised under live load.

## 13. Dependencies & repository layout

Neither `crypcodile` nor `stockodile` is on PyPI. Both are consumed as **uv path dependencies to
the local checkouts** (`/Users/nazmi/Crypcodile`, `/Users/nazmi/stockodile`) via
`tool.uv.sources` for dev, with pinned git SHAs recorded for reproducibility (local checkouts are
authoritative during this build).

Both drag heavyweight mandatory deps a headless gateway must not install (Crypcodile: PyQt6,
pyqtgraph, streamlit, matplotlib, scipy, xgboost, web3; stockodile: web3, fastapi). **Mitigation
(explicit work item M1):** add optional-dependency groups upstream — `crypcodile[core]`
(msgspec, websockets, aiohttp, polars, pyarrow, duckdb, numpy) and `stockodile[core]` — the user
owns both repos, so this is a small upstream PR each; flowmap-server depends on the `core`
extras. Also fix/verify Crypcodile's `__init__` xgboost-MagicMock side effect is inert under
`[core]`. Fallback if upstream splitting stalls: `--no-deps` install plus an explicit transitive
list, with a CI smoke test that imports `feeds/` cleanly.

Two more upstream work items surfaced by review: extend stockodile's AlpacaProvider to subscribe
the `statuses` channel (halt markers; TradingStatus schema exists, no provider emits it), and
have it forward `Quote` records (Entropy's reference adapter drops them; we need L1).

Server API stack: **FastAPI + uvicorn only** (REST + binary WS). aiohttp/websockets remain
transitive deps of the data libraries, not part of our API surface.

```
flowmap/  (branch v2)
├── server/   pyproject.toml (uv; crypcodile[core] & stockodile[core] via tool.uv.sources,
│             msgspec, numpy, polars, fastapi, uvicorn)
│             src/flowmap_server/{api,core,feeds,proto}/
├── client/   package.json (vite, react, typescript, zustand, vitest, playwright)
│             src/{gl,ui,proto,state}/
├── docs/superpowers/specs|plans/
└── scripts/  dev.sh (uv run server + vite dev), package.sh
```

Old v1 package remains untouched on `main`; the `v2` branch adds the new tree alongside and
removes v1 files only when v2 passes all gates (§10, §12).

Milestones: **M1** upstream dep-splits + server core (sim feed, grid+epochs, protocol,
golden vectors) → **M2** client GL renderer (tile array, sum-mips, residency, 60 fps gates on
sim) → **M3** overlays/DOM/tape/profile/detectors → **M4** equity adapter + capability tiers +
session model + parity matrix → **M5** record/replay both markets → **M6** polish, live
verification, packaging script, README.

Implementation proceeds via subagent-driven development with referee gates before merges.
