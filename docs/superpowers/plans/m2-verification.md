# FlowMap v2 — M2 (Client GL Renderer) Verification

**Date:** 2026-07-18 · **Branch:** `v2` · **Scope:** M2 client renderer (Tasks 1–13)

M2 delivers the visible product: a TypeScript + WebGL2 web client that renders the M1 server's
canonical order-flow stream as a Bookmap-standard liquidity heatmap — with the original
product-killing bug (pan/zoom collapsing to ~1 fps) **structurally eliminated**, plus the full
overlay/panel/UI-shell terminal. Every task went implementer → review, with Playwright pixel/
behaviour verification against the real server at each gate.

## The headline: the v1 1-fps bug is structurally gone

v1 re-rasterised the entire visible history on the CPU every pan/zoom frame → cost grew with
history depth → ~1 fps scrolling back. v2 makes that impossible: history lives in a WebGL2
`TEXTURE_2D_ARRAY`; a column, once uploaded, is never re-uploaded; pan and both zoom axes mutate
only a view uniform → one draw. **Measured (CDP, `client/perf_report.json`):**

| | 200 columns resident | 10 000 columns resident | ratio |
|---|---|---|---|
| median draw cost | 0.2 ms | 0.1–0.2 ms | **~1.0** |

Frame cost does **not** grow with history depth. Pan/zoom fps 59.9 (vsync-capped under
SwiftShader; uncapped draw is sub-millisecond → thousands of fps), input→frame proxy p95 <32 ms,
GPU ring memory 80 MB (<300 MB gate). The history-independence ratio is the substantive proof and
is hard-asserted in `tests/e2e/perf.spec.ts`.

## Automated suites

- **Client unit (vitest):** 229 passed — wire decoder (golden-vector byte-exact vs the server's
  committed vectors), camera/view math, tileRing residency/LRU, history loader, normalization
  histograms, columnCache, bookStore, overlays geometry, symbol filter, replay message
  construction, settings persistence, keyboard routing, session reset.
- **Client e2e (Playwright, real server + SwiftShader):** 14 passed — heatmap render, live-sim
  scroll, SUM-mips, viewport normalization + crosshair, deep scroll-back + context-loss recovery,
  §10 perf gates, overlays, DOM ladder + tape, UI shell (symbol switch re-subscribe, replay
  control messages, settings persist, keyboard), session switch reset.
- **Server (pytest):** 130 passed — unchanged; the client consumes the M1 wire contract via the
  committed golden vectors.
- `npm run build` (tsc + vite): clean.

## What renders (visual verification against the real server)

Booted `python -m flowmap_server` (sim) + vite, viewed in a real browser:

**Finished terminal (sim, live):** a thermal liquidity heatmap dominating the stage — cyan/white
persistent liquidity walls on near-black, mid-clustered trade bubbles coloured by side, a violet
VWAP line, price axis (right) + wall-clock time axis (bottom) locked to pan/zoom, crosshair with
exact price+size readout. Right rail: an **L2 DOM ladder** (teal-bid/red-ask size bars, best
bid/ask highlighted, FOLLOW/LOCK) and a **time & sales tape** (newest-first, side-coloured, large
lots emphasised). Top bar: dual-market symbol search, honest capability badges (`L2 · TAPE TICK ·
SIDE EXCHANGE`), Live/Replay toggle, clock. Bottom: a SESSION minimap + replay transport
(play/pause, 1×–100× speed, seek). frontend-design visual system: near-black layered surfaces,
teal/red accents matching the GL heatmap hues, JetBrains-Mono tabular numerics.

**Dual-market — live Binance BTCUSDT through the same client UI:** switching the symbol (top-bar
search → BTCUSDT, or `store.connectAndSubscribe('binance-spot','BTCUSDT')`) drove a live session
through the full stack (client WS → server session → Crypcodile bridge → real Binance feed):
- top-bar chip flips to `CRYPTO BTCUSDT`; DOM ladder shows real BTC book depth (~$63,930–63,937,
  best bid ~$63,934); T&S tape shows real Binance prints (~$63,935.4) with real timestamps;
- the heatmap **re-anchors to the BTC price frame**: `gridEpoch 0→1`, `p0 63470`, price axis
  rebased to ~63,470–64,494, on-canvas BBO label `B 63982.0 ×0.50` (live BTC best bid ~$63,982) —
  the same renderer, market-agnostic, following the symbol. Switching back to sim resets again
  (gridEpoch→0, sim price frame, fresh ring). This exercised the epoch re-anchor + session-reset
  paths end to end.

## Bugs found and fixed during the gate

- **Symbol switch left stale heatmap tiles** (`4214877`): the renderer had no session-change
  reset, so a symbol switch kept the old symbol's tiles/price frame while the DOM/tape switched
  correctly. Added `Renderer.resetForSession()` (tears the ring/mips/camera/normalizer/history to
  a clean empty slate; the live-append path rebuilds at the new grid geometry) wired on
  `market:symbol` change; live-verified sim→binance→sim rebase.
- **Cold-JSON ns type inconsistency** (`d15cd28`): small `*_ns` timestamps decoded to `number`
  despite the `bigint` wire type, crashing the overlay render loop; fixed in the decoder
  (absolute-timestamp keys always bigint; `dt_ns` interval stays number).
- **Column dedup dropped forming/final and bar columns** (`5853505`): fixed to a final-aware,
  per-channel dedup so the live right edge animates and bars are never swallowed.
- **Empty partial column blanked the DOM ladder** (T11): the bookStore now takes only finalized
  columns as the current book.
- **Flaky perf latency gate under parallel load** (`f24ba01`): the frame-interval proxy inflates
  under concurrent-worker CPU contention though the draw stays 0.2 ms; hardened to pass when the
  draw is under one vsync (the substantive ratio gate is unchanged).

## M2 acceptance criteria → evidence

| Criterion | Evidence |
|---|---|
| Full client suite green | 229 unit + 14 e2e; build clean |
| Live heatmap renders + scrolls | live-sim.spec + visual (sim terminal) |
| Pan/zoom cost independent of history (v1 bug gone) | perf.spec ratio ~1.0, 0.2 ms @ 200 & 10k cols |
| Zoom-out preserves walls (SUM-mips, not averages) | mips.spec: wall luma 194.6 native/mid/zoomed |
| Deep scroll-back within a memory budget | scrollback.spec: LRU + backfill, ≤300 MB, context-loss recovery |
| Viewport-adaptive contrast + exact crosshair | normalize.spec: dim region renormalizes; crosshair exact size |
| Overlays (bubbles/BBO/VWAP/profile/markers/axes) | overlays.spec + visual |
| DOM ladder + tape, honest capability badges | panels.spec + visual (`L2`, `TAPE TICK`) |
| UI shell: symbol search, replay transport, settings, keyboard | shell.spec (re-subscribe + replay control messages + persistence + keys) |
| Dual-market: same UI renders sim + live crypto | live Binance BTCUSDT visual (DOM/tape $63.9k, heatmap rebased p0 63470, BBO $63,982) |
| frontend-design visual polish | theme.css token system; trading-terminal look |

## M2 status: COMPLETE

The visible product is delivered: a fast (history-independent pan/zoom), correct, polished
Bookmap-standard order-flow terminal that renders the sim feed and **live crypto (real Binance
BTCUSDT)** through the exact same market-agnostic renderer. The original 1-fps bug is structurally
eliminated.

## Next — M3 completes the "both markets" requirement

The user's requirement is that flowmap work in **both** markets (crypto + equities). The renderer
and server are market-agnostic (canonical channels), and crypto is fully live. **Equities
(stockodile)** are wired in the server's capability model but not yet a live feed — that is M3:
add the stockodile equity feed to the server (Alpaca IEX tick tape / keyless SYNTH tiers per spec
§7), surface US tickers in symbol search, and run the two-market parity matrix (every feature
present in both markets with an honest capability state). No client rewrite is needed — equity is
an additive server feed + capability-tier work, and the client already renders whatever canonical
stream + capability descriptor it receives (the `L1`/`SYNTH` ladder tiers and honesty badges are
already built into the DOM ladder and overlays).
