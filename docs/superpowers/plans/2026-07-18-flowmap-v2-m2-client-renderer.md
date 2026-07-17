# FlowMap v2 — M2: Client GL Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use
> checkbox (`- [ ]`) syntax. Read the design spec §6/§8.3/§9/§10 at
> `docs/superpowers/specs/2026-07-17-flowmap-v2-bookmap-design.md` BEFORE any task — it is the
> authority. The wire contract is the committed golden vectors in
> `server/tests/proto/golden/*.bin` (12 files); the TS decoder MUST decode them byte-for-byte.

**Goal:** A TypeScript + WebGL2 web client that renders the server's canonical order-flow stream
as a Bookmap-standard liquidity heatmap at 60 fps, with pan/zoom cost independent of history size
(the whole point of the rebuild), plus the overlays, panels, and UI shell.

**Architecture:** Vite + React + TypeScript + zustand. The heatmap lives in a WebGL2
`TEXTURE_2D_ARRAY` tile ring; column append = one `texSubImage3D`; pan/zoom = a view-matrix
uniform only (never a CPU re-raster — this is what makes it structurally fast). SUM-mips via FBO
downsample passes for correct zoom-out. Binary WS decoded by a TS mirror of the Python wire
protocol. Verified against the sim feed and live crypto through the real server.

**Tech Stack:** TypeScript, Vite, React 18, zustand, WebGL2 (raw, no three.js), vitest,
Playwright (+ CDP for perf). Node 22 (already installed). Server: `flowmap-server` at
`/Users/nazmi/flowmap/server` (run `uv run python -m flowmap_server`, port 8720).

**Working rules for every task:**
- All client code under `/Users/nazmi/flowmap/client/`. TDD where it fits (proto decode, view
  math, normalization are pure and unit-testable with vitest; GL rendering is verified via
  Playwright pixel/behavior assertions, not mocked-away).
- Commit prefix `feat(client):` etc. NO Claude co-author trailer. Opsera gate: `touch
  /tmp/.opsera-pre-commit-scan-passed` in one Bash call, `git commit` in a SEPARATE call.
- `/Users/nazmi/flowmap` is a symlink to `/Volumes/disk 2/...`; re-verify persistence if an edit
  seems lost.
- Never break the server suite (it's Python, separate; don't touch `server/` except the two
  proto-contract files if a genuine mismatch is found — and only after flagging it).

---

### Task 1: Client scaffold

**Files:** `client/package.json`, `client/tsconfig.json`, `client/vite.config.ts`,
`client/index.html`, `client/src/main.tsx`, `client/src/App.tsx`, `client/.gitignore`,
`client/playwright.config.ts`, `client/vitest.config.ts`.

- [ ] **Step 1:** `package.json` with scripts `dev` (vite), `build` (tsc && vite build),
  `test` (vitest run), `e2e` (playwright test); deps react, react-dom, zustand; devDeps
  typescript, vite, @vitejs/plugin-react, vitest, @playwright/test, @types/react, @types/react-dom.
  Vite dev server on port 5173 (matches server CORS). Proxy `/api` and `/ws` to
  `http://127.0.0.1:8720` in vite.config.ts (so the client talks to the real server in dev).
- [ ] **Step 2:** Minimal `App.tsx` renders a `<canvas>` full-viewport + a placeholder top bar.
  `main.tsx` mounts it.
- [ ] **Step 3:** `npm install` (or `npm ci`), then `npm run build` → succeeds (empty-ish app
  compiles). `npm run test` → vitest runs with 0 tests (exit 0). Add `client/.gitignore`
  (node_modules, dist, playwright-report, test-results).
- [ ] **Step 4:** Commit `feat(client): scaffold vite+react+ts client with server proxy`.

### Task 2: Wire protocol decoder (TS mirror) — golden-vector verified

**Files:** `client/src/proto/types.ts`, `client/src/proto/decode.ts`, `client/src/proto/encode.ts`,
`client/src/proto/decode.test.ts`, `client/tests/golden/` (symlink or copy of the server's
`server/tests/proto/golden/*.bin` — COPY them at build-time via a script `client/scripts/sync-golden.mjs`
that reads from `../server/tests/proto/golden/`, so the cross-language contract is pinned).

**Contract:** mirror `server/src/flowmap_server/proto/wire.py` EXACTLY. Envelope
`<BBHI>` = `{u8 type, u8 ver, u16 flags, u32 payload_len}` little-endian; `FLAG_JSON=0x0001`;
`payload_len` is UNPADDED, `next_offset = offset + 8 + ceil4(payload_len)`. Hot message layouts
per spec §6.2 (DEPTH_COL `<IIqBBHI>` header then bid f32×n then ask f32×n, ask omitted when
mode==SYNTH_PROFILE=2; BAR_COL, TRADE with u8-len venue, BBO, PING/PONG, HISTORY_RESP nested).
Cold messages are JSON. Types in `types.ts` mirror `events.py` field names EXACTLY (the T4 review
flagged `capability` not `capability_descriptor` — use the golden/plan names).

- [ ] **Step 1:** `sync-golden.mjs` copies the 12 `.bin` files into `client/tests/golden/`.
  Run it; commit the copies (they're the contract snapshot).
- [ ] **Step 2:** Write `decode.test.ts` (vitest): load each golden `.bin`, `decode` it, assert
  the decoded fields match hardcoded expected values (transcribe from the Python
  `golden_fixture_events()` — read `server/src/flowmap_server/proto/wire.py` for the exact fixed
  values). Also: envelope parse, unknown-type skip via payload_len, multi-message frame iteration
  (concatenated goldens decode in sequence), DEPTH_COL f32 zero-copy alignment (bid starts at
  message offset 32), truncated buffer throws, SYNTH_PROFILE ask omission.
- [ ] **Step 3:** Run → RED. Implement `types.ts` + `decode.ts` (DataView for headers with
  `littleEndian=true`; `Float32Array` subarray views over the frame buffer for bid/ask — copy out
  so the frame can be GC'd). `encode.ts` only needs the client→server control messages
  (Subscribe/Unsubscribe/Seek/SetSpeed/Pause/Resume/HistoryRequest/Pong — all JSON-flagged) plus a
  round-trip of Ping/Pong for tests. Run → GREEN.
- [ ] **Step 4:** Add an `encode↔decode` round-trip test for every control message. Commit
  `feat(client): wire protocol decoder mirroring server, golden-vector verified`.

### Task 3: WebSocket client + connection/session state

**Files:** `client/src/net/connection.ts`, `client/src/net/connection.test.ts`,
`client/src/state/store.ts` (zustand).

**Contract:** `Connection` opens a binary WS to `/ws`, sends `Subscribe`, and drives a callback
stream of decoded messages. Handles: Hello (store session_id, protocol_version, capability,
norm_seed), EpochStart (maintain an epoch→params map), Ping→auto-Pong, Status, reconnect with
backoff on close (re-subscribe → fresh snapshot; dedup columns by `(epoch, col_seq)` so re-snapshot
is idempotent), HistoryRequest/Response correlation by req_id. Exposes an event emitter or callback
interface the renderer/store subscribe to. Malformed frame from server → log + drop that frame,
don't kill the connection (defensive; server is trusted but the decoder must be robust).

- [ ] **Step 1:** Tests (vitest) with a fake WS (inject a socket-like object): Subscribe sent on
  open; Hello parsed into state; EpochStart builds the epoch map; Ping auto-Pongs; a close triggers
  reconnect+re-subscribe (fake timers); `(epoch,col_seq)` dedup drops a re-delivered column;
  HistoryResponse routed to the matching req_id waiter.
- [ ] **Step 2–3:** RED → implement → GREEN. The zustand store holds connection status, capability,
  current epoch map, and exposes actions (subscribe(market,symbol), requestHistory(before_t,n)).
- [ ] **Step 4:** Commit `feat(client): binary WS connection with reconnect, epoch map, history correlation`.

### Task 4: WebGL2 heatmap core — tile array, column append, thermal shader

**Files:** `client/src/gl/context.ts` (GL2 init + EXT_color_buffer_float check + capability probe),
`client/src/gl/tileRing.ts` (TEXTURE_2D_ARRAY ring, texSubImage3D append, LRU residency),
`client/src/gl/heatmap.ts` (the draw: view matrix, per-epoch row transform, LUT, decode uniform),
`client/src/gl/shaders/heatmap.vert`, `client/src/gl/shaders/heatmap.frag`, `client/src/gl/lut.ts`
(thermal colormap → 256×1 RGBA texture), and Playwright specs
`client/tests/e2e/heatmap.spec.ts`.

**Contract (spec §8.3):** storage = one `TEXTURE_2D_ARRAY` per channel-pair, 256 cols × rows ×
layers, internal format `RG16F` (bid/ask density). Column append = `texSubImage3D` into
(tile layer, x within tile). **Value decode:** densities arrive f32 in the wire but were f16 on the
server; upload as-is into RG16F. Per-instrument fixed scale from the capability descriptor folded
into a decode uniform so the thermal ramp uses the p99-ish range. Fragment shader: `texelFetch`
(NOT sampler filtering — sidesteps the 16-unit bind limit and enables manual cross-layer taps and
sum-filtering) → apply decode + normalization uniform → sample the 256-entry thermal LUT
(deep blue→cyan→yellow→white). SYNTH_PROFILE mode → a distinct single-hue ramp. Pan/zoom is
ENTIRELY a change to the view-matrix uniform + which layers/x-range the draw covers — no CPU
re-raster, ever. Per-epoch groups: each epoch's tiles carry a row→price affine (p0/tick differ per
epoch); one draw batch per visible epoch.

- [ ] **Step 1:** `context.ts`: create WebGL2 context, REQUIRE `EXT_color_buffer_float` (throw a
  clear error if absent), read MAX_TEXTURE_IMAGE_UNITS / MAX_ARRAY_TEXTURE_LAYERS / MAX_TEXTURE_SIZE
  and expose them. Playwright test: page loads, context initializes, capabilities logged, no GL
  errors (read via a test hook on window).
- [ ] **Step 2:** `tileRing.ts`: allocate the array texture (256 × rows × N layers), `appendColumn(bid: Float32Array, ask: Float32Array|null, colSeq, epoch, t0)` → texSubImage3D into the right layer/x; track which absolute col_seq range is resident; LRU-evict full-res layers when the ring is full (M2 minimal: fixed ring of layers, wrap oldest — deep-scroll backfill is Task 8). Unit-ish test via Playwright: append 300 columns, assert the texture has the expected resident range (query via a GL readback test hook).
- [ ] **Step 3:** shaders + `heatmap.ts` + `lut.ts`: render the resident columns as a textured
  quad; view matrix maps (col, row) → clip space; decode+normalize+LUT in the frag shader.
  Playwright: drive a fixed synthetic column set (a JS test hook that appends known data — e.g. a
  bright wall row), screenshot, assert the wall row is bright and positioned correctly (sample
  pixels via canvas readback). Assert light/dark backgrounds and buy/sell not needed yet — just the
  heatmap.
- [ ] **Step 4:** Commit `feat(client): WebGL2 heatmap core — tile array, texSubImage3D append, thermal shader`.

### Task 5: Live wiring — server stream → renderer, auto-follow right edge

**Files:** `client/src/gl/renderer.ts` (orchestrates: subscribe to store's column stream → tileRing
append → request draw on rAF when dirty), `client/src/App.tsx` (wire canvas + connection + a hardcoded
sim subscribe), Playwright `client/tests/e2e/live-sim.spec.ts`.

**Contract:** rAF render loop that draws only when dirty (new column or view change). New finalized
columns append + shift the auto-follow view so the right edge tracks live. Partial (final=false)
columns update the rightmost column in place. This is the first END-TO-END visible result: boot the
real server (sim), the client renders a live scrolling heatmap.

- [ ] **Step 1:** Playwright `live-sim.spec.ts`: start the real server (`uv run python -m
  flowmap_server` on a test port via a Playwright global-setup that spawns+health-polls it, or
  document manual boot), load the client pointed at it, subscribe sim, wait 3s, assert: canvas
  pixels change over time (heatmap scrolls), no console errors, no GL errors, ≥1 non-background
  region present. Capture a screenshot artifact.
- [ ] **Step 2–3:** implement renderer wiring → GREEN. Handle Hello/EpochStart/DepthColumn(final &
  partial)/BarColumn from the store.
- [ ] **Step 4:** Commit `feat(client): live sim heatmap end-to-end (scrolling right edge)`.
  **This is the first milestone-visible deliverable — capture a screenshot in the commit body.**

### Task 6: View transform — pan, zoom (time & price), the §10 perf gates

**Files:** `client/src/gl/camera.ts` (view state: time offset, time scale, price center, price
scale; pan/zoom mutate ONLY these → uniform), `client/src/gl/camera.test.ts` (pure math),
`client/src/input/gestures.ts` (wheel=zoom, drag=pan, keyboard arrows/+-/F/R), Playwright
`client/tests/e2e/perf.spec.ts` (the gates).

**Contract (spec §10, the whole reason for the rebuild):** pan (drag+keyboard) and zoom (wheel,
time & price) mutate camera state → one uniform update → one draw. Cost MUST be independent of
history depth. Gates, measured via CDP:
- Pan with ≥10 000 columns resident: ≥55 fps sustained.
- Continuous wheel zoom (time & price): ≥55 fps sustained.
- Input→frame latency <32 ms p95 (harness pinned to the built-in 120Hz display).
- Client GPU memory under the residency policy ≤300 MB.

- [ ] **Step 1:** `camera.test.ts` (vitest, pure): pan/zoom/fit/reset/follow math; zoom is
  cursor-anchored (the price/time under the cursor stays put); clamping.
- [ ] **Step 2:** `gestures.ts` maps input events to camera ops. `perf.spec.ts`: a Playwright test
  that (a) preloads 10 000 columns via a JS test hook (reuse the sim `generate_history` shape — the
  client hook appends 10k synthetic columns directly into the tileRing, bypassing the network for a
  deterministic pre-loaded history), (b) drives synthetic wheel+drag input via CDP, (c) samples
  frame timing with `requestAnimationFrame` deltas or CDP tracing, (d) asserts ≥55 fps and writes
  `client/perf_report.json`.
- [ ] **Step 3:** implement camera + gestures until the gates pass. If 10k full-res columns exceed
  the layer budget, this task may need Task 7's mips first — if so, note it and reorder.
- [ ] **Step 4:** Commit `feat(client): pan/zoom camera + input; §10 perf gates pass`. **Put the
  perf numbers (fps for pan and zoom) in the commit body — this is the headline metric.**

### Task 7: SUM-mips for correct zoom-out

**Files:** `client/src/gl/mips.ts` (FBO ping-pong 4×4 SUM downsample into level-1/-2 array
textures), shader updates in `heatmap.frag` (level selection via texelFetch at level + 1/16^L
rescale folded into the normalization uniform; 2–4 tap manual SUM between levels),
Playwright `client/tests/e2e/mips.spec.ts`.

**Contract (spec §8.3):** mips are SUMS not averages (a 500-lot wall must stay a 500-lot wall
zoomed out, not dilute to 125). Incremental GPU downsample every 4th/16th column append. Saturate
sums at 60 000 (RG16F max 65 504). `generateMipmap` is NEVER used.

- [ ] **Step 1:** `mips.spec.ts`: append a column set with a single bright wall row surrounded by
  empties; zoom out past the level-1 threshold; assert (pixel readback) the wall stays bright
  (sum-preserved), NOT averaged-down. Compare a wall region's brightness at native vs mip zoom.
- [ ] **Step 2–3:** implement FBO SUM downsample + shader level selection → GREEN.
- [ ] **Step 4:** Commit `feat(client): SUM-mips for correct-liquidity zoom-out`.

### Task 8: Deep scroll-back — residency LRU + HistoryRequest backfill

**Files:** `client/src/gl/tileRing.ts` (extend: full-res residency window + mip-only for older;
LRU eviction; re-fetch on scroll-in), `client/src/net/history.ts` (request older columns as the
view pans left past the resident range; splice HistoryResponse columns into the ring),
Playwright `client/tests/e2e/scrollback.spec.ts`.

**Contract (spec §8.3 residency):** full-res tiles for a recent window (~16k cols ≈ 256 MB);
older ranges resident at mip level only; scroll-in past the full-res window issues HistoryRequests
and re-populates; deep zoom-out renders from mips exclusively so the full extent never needs
native residency. `webglcontextlost` → recreate + re-fetch visible range.

- [ ] **Step 1:** `scrollback.spec.ts`: with a server holding >16k columns (drive the sim long
  enough or use the server's history/recording), pan left past the resident window → assert older
  columns appear (HistoryRequest fired, columns rendered), GPU memory stays ≤300 MB (CDP memory).
  Also a `webglcontextlost` simulation (WEBGL_lose_context extension) → recover.
- [ ] **Step 2–3:** implement → GREEN.
- [ ] **Step 4:** Commit `feat(client): deep scroll-back with LRU residency + history backfill + context-loss recovery`.

### Task 9: Client-side normalization + crosshair readout

**Files:** `client/src/gl/normalize.ts` (per-tile coarse CPU histogram, viewport percentile merge,
EMA), `client/src/gl/columnCache.ts` (CPU cache of recent columns' exact values for the crosshair),
`client/src/ui/Crosshair.tsx`, tests.

**Contract (spec §8.3):** normalization percentile computed over the VISIBLE window (not the live
edge) from per-tile 256-bin histograms merged on pan/zoom settle (<1ms), EMA-smoothed, ×16^L on mip
levels; `Hello.norm_seed` seeds frame 0. Crosshair liquidity readout reads the CPU column cache
(exact grouped sums), NEVER GPU-filtered texels.

- [ ] **Step 1:** vitest for histogram build/merge/percentile + EMA; a test that panning into a
  different-liquidity region renormalizes to the viewport. Playwright: crosshair over a known wall
  shows the correct summed size (from the cache).
- [ ] **Step 2–3:** implement → GREEN.
- [ ] **Step 4:** Commit `feat(client): viewport-percentile normalization + crosshair cache readout`.

### Task 10: Overlays — trades/bubbles, BBO, VWAP, volume profile, markers

**Files:** `client/src/gl/overlays/{bubbles,bbo,vwap,profile,markers}.ts` (instanced GL sprites/
lines), `client/src/gl/textLayer.ts` (2D-canvas text over the GL canvas for axis labels + readouts),
`client/src/ui/PriceAxis.tsx`, `client/src/ui/TimeAxis.tsx`, Playwright specs per overlay.

**Contract (spec §2 G2, §9):** volume bubbles (size∝volume, color by aggressor side, from the tape/
Trade stream), current BBO lines + price-axis badges, VWAP line (from BarColumn vwap_num/den),
volume profile (POC-aligned, from bar volumes), event markers (liquidation/halt/gap/session_break/
large_lot/iceberg — colored glyphs on the time axis), price axis (right) + time axis (bottom) with
the 2D-canvas text layer. All overlays draw as instanced primitives + one text layer; they consume
only canonical channels so they work in both markets (capability-gated per §7).

- [ ] **Step 1–N (per overlay, TDD-ish):** for each overlay write a Playwright spec that drives
  known data and asserts the visual (pixel sample or DOM for text), then implement. Keep each
  overlay a focused file.
- [ ] **Final step:** Commit `feat(client): trade bubbles, BBO, VWAP, volume profile, markers, axes`.
  (May be split into 2–3 commits if large — one per logical group.)

### Task 11: DOM ladder + time & sales tape panels

**Files:** `client/src/ui/DomLadder.tsx`, `client/src/ui/Tape.tsx`, `client/src/state/bookStore.ts`
(maintain current book/BBO + recent trades for the panels), tests.

**Contract (spec §9):** right rail = DOM ladder (price rungs with bid/ask sizes from the current
book / L1 band / SYNTH profile depending on capability) + a scrolling tape (recent trades, colored
by side), both collapsible. Capability badges (`L2`/`L1`/`SYNTH`/`TAPE 10s`) shown per pane (§7
honesty rule).

- [ ] **Step 1–3:** tests (React Testing Library / Playwright) → implement → GREEN.
- [ ] **Step 4:** Commit `feat(client): DOM ladder + time&sales tape with capability badges`.

### Task 12: UI shell — symbol search, capability badges, timeline minimap, replay transport, keyboard

**Files:** `client/src/ui/TopBar.tsx` (dual-market symbol search hitting `/api/symbols`, venue
picker, capability badges, live/replay toggle, clock), `client/src/ui/Timeline.tsx` (minimap of
session extent + replay transport play/pause/speed/seek → Seek/SetSpeed/Pause/Resume control
messages), `client/src/ui/SettingsDrawer.tsx` (colormap, normalization, tick grouping, bubble
threshold, follow mode), `client/src/input/keys.ts` (arrows pan, +/- zoom, F follow, R reset,
Space play/pause), design polish pass, tests.

**Contract (spec §9):** the full trading-terminal shell. Apply the frontend-design skill for the
visual pass (near-black bg, thermal heatmap, teal/red accents, JetBrains Mono numerics, dense
layout). Symbol search merges crypto (Crypcodile registry / static M1 shortlist) + US tickers.

- [ ] **Step 1:** invoke the `frontend-design` skill for the visual system (colors, type, spacing,
  component styling) before building the shell components.
- [ ] **Step 2–N:** build + test each shell piece; wire replay transport to the control messages.
- [ ] **Final:** Commit `feat(client): UI shell — symbol search, timeline/replay, settings, keyboard, visual polish`.

### Task 13: M2 integration gate + dual-market visual verification

**Files:** `client/tests/e2e/acceptance.spec.ts`, `docs/superpowers/plans/m2-verification.md`,
update root `README.md` / add `scripts/dev.sh` (boots server + vite together).

- [ ] **Step 1:** Full client suite green: `npm run test` (vitest) + `npm run e2e` (Playwright).
- [ ] **Step 2:** Boot server + client; drive the Browser pane (preview tools) to verify VISUALLY:
  sim heatmap scrolls + pans/zooms at 60fps (perf_report.json), then live `binance-spot:BTCUSDT`
  renders real depth/trades, pan back through history is smooth (NOT 1fps — the original bug),
  zoom-scroll is smooth. Capture screenshots of both markets.
- [ ] **Step 3:** `m2-verification.md`: perf gate numbers, screenshots, a "1fps bug is gone"
  before/after note, dual-market evidence, and an acceptance table.
- [ ] **Step 4:** Commit `feat(client): M2 integration verification — 60fps dual-market heatmap`.

---

## Milestone note

M2 delivers the visible, fast frontend — the core of the user's request. After M2, remaining
milestones per the design doc §13: **M3** (equity adapter + capability tiers + the two-market
parity matrix — stockodile wiring, since M1/M2 prove the crypto path), **M4** record/replay UI
polish, **M5** packaging, README, and the v1→v2 cutover on `main`. Equity (stockodile) live wiring
is intentionally deferred to M3: M1's server and M2's client are market-agnostic (they consume
canonical channels), so equity is an additive server feed + capability-tier work, not a client
rewrite.
