# FlowMap v2 — M3 (Equity feed + dual-market parity) Verification

**Date:** 2026-07-18 · **Branch:** `v2` · **Scope:** M3 (Tasks 1–4) — stockodile equity feed,
equity session routing, SYNTH-profile client rendering, and the two-market parity matrix (the §G3
gate). This closes M3 and fulfils the user's core requirement: **FlowMap works in BOTH markets
(crypto + equities) through one renderer, with honest capability tiers.**

## The headline: one renderer, both markets, honest parity

The same market-agnostic WebGL2 renderer + UI shell serves **crypto (Crypcodile, full L2)** and
**US equities (stockodile, keyless SYNTH tier)**. Nothing is silently degraded and nothing
fabricated is rendered as measured data — every feature is present in both markets in one of three
honest states: **full**, **badged-reduced**, or **explicit N/A** (§7). Proven live end-to-end
against **real Binance BTCUSDT** and **real keyless AAPL** (Yahoo bars), and asserted cell-by-cell
by an automated Playwright parity spec.

## Parity matrix (§7 two-market table) — resolved

Every feature driven through the SAME renderer for a crypto-shaped session (L2 · tick · exchange)
and an equity-keyless-shaped session (SYNTH_PROFILE · poll · na). Machine-asserted in
`client/tests/e2e/parity.spec.ts`; the resolved matrix is also written to
`client/tests/e2e/__artifacts__/parity-matrix.json`.

| Feature | Crypto (Crypcodile, L2/tick) | Equity keyless (stockodile, SYNTH/poll) | State | Evidence |
|---|---|---|---|---|
| **Heatmap** | thermal ramp (`RAMP_THERMAL`) | **SYNTH amber** ramp (`RAMP_SYNTH`) | full / distinct-honest | `currentRamp` 0 vs 1 — ramps **differ** (asserted `.not.toBe`) |
| **DOM ladder** | L2 full book, bid + ask columns, `L2` badge | SYNTH volume-at-price profile, **no bid/ask**, `SYNTH` badge | full / reduced | `ladder-badge`; `.ladder__cell--bid/ask` >0 crypto, **=0** equity; `.ladder__profile` rungs equity |
| **Tape** | `TAPE TICK` | `TAPE POLL` (display-only) | full / reduced | `tape-badge` text |
| **CVD / side** | `SIDE EXCHANGE` (real aggressor) | `SIDE NA` (explicit N/A — no tick tape) | full / explicit-N/A | capability chips; `trade_side` = exchange vs na |
| **BBO overlay** | drawn (real channel quote, non-null) | **null — never fabricated** | full / explicit-N/A | `overlayEffectiveBboForTest()` non-null crypto, **null** equity |
| **VWAP** | real (from tape, no badge) | `approx` badge (Σ typical×vol / Σvol from 1 m bars) | full / badged | `capability.vwap` ≠ approx vs `= approx`; `VWAP approx` overlay badge |
| **Bubbles** | full (tick tape) | `BUBBLES 1m AGG` badge (poll tape drives it) | full / badged | `capability.tape` tick vs poll; overlay honesty badge |
| **Markers** | present (liquidation, gap) | present (gap, session_break) | present / present | `overlayDebug.markers` ≥2 both |
| **Crosshair** | present (exact price+size readout on hover) | present | present / present | `crosshair-readout` visible on canvas hover (both) |
| **Replay controls** | present (play/pause, 1×–100×, seek) | present | present / present | `transport` + `speeds` mounted (both) |

`parity.spec.ts` — 3 tests, all green: the crypto column, the equity-keyless column (each a fresh
page), and a combined run that drives **both through ONE renderer instance** (reset between),
asserts the ramps differ and the BBO honesty holds across the switch, and writes the matrix +
screenshots.

## Live dual-market verification (real feeds, one UI)

Booted `python -m flowmap_server` (8720, recording off) + vite (5173), and drove BOTH markets
through the same running client. Screenshots (durable, full-res 1280×800):

- **Crypto:** `docs/superpowers/plans/assets/live-crypto-btcusdt.png`
- **Equity:** `docs/superpowers/plans/assets/live-equity-aapl.png`

(Report thumbnails from the parity spec live at `client/tests/e2e/__artifacts__/parity-{crypto,equity,both}.png`.)

### What I SAW — crypto (live Binance BTCUSDT)

`connectAndSubscribe('binance-spot','BTCUSDT')` → within seconds a **live thermal liquidity
heatmap** dominated the stage: cyan/blue/white persistent liquidity walls on near-black. The grid
**re-anchored to BTC's real price frame** — `gridEpoch 0→1`, `p0 63623`, price axis rebased to
~$63,800–$64,600 (the initial sim epoch 0 discarded). On-canvas BBO label `B 64140.0 ×0.04`. The
**L2 DOM ladder** showed the real Binance book (~$64,136–$64,143), best bid **$64,140.0** with a
teal/red size column and the best-bid rung highlighted. The **T&S tape** streamed real Binance
prints at ~$64,140 with sub-second timestamps (12:14:xx), coloured by side. Badges: `L2 · TAPE
TICK · SIDE EXCHANGE`, status `LIVE`. Status confirmed programmatically: `status:'live'`,
`capability {depth:L2, tape:tick, trade_side:exchange}`, 169+ resident live columns, `ramp 0`.

### What I SAW — equity (live keyless AAPL, weekend → CLOSED)

`connectAndSubscribe('equity','AAPL')` → the same renderer flipped to the **amber SYNTH
volume-at-price profile** (distinct single-hue ramp, `ramp 1`), **re-anchored to AAPL's real price
frame** (epoch `p0 311.92`, tick `0.01`, 4096 rows → axis ~$329–$335, AAPL ≈ $332). 512 warmup
columns rendered from the last session's Yahoo 1 m bars. Top-left honesty badges: **`BUBBLES 1m
AGG`** and **`VWAP approx`**. Banner: **`MARKET CLOSED — opens in 2d 01:15:27`** (today is
Saturday 2026-07-18 → US market closed; next open Monday, live countdown). The **DOM ladder**
showed the SYNTH tier — `SYNTH` badge, a single volume-at-price profile column (POC **1000 @
332.40** highlighted, plus 99.63@332.47, 49.06@332.45, …), and **zero bid/ask columns** (no
fabricated two-sided book). The **T&S tape** read `TAPE POLL` / "waiting for tape…" — honest: a
closed market has no live poll prints. Badges: `SYNTH_PROFILE · TAPE POLL · SIDE NA`, status `LIVE
· CLOSED`. Confirmed programmatically: `feedState:'closed'`, keyless capability descriptor, 15
profile rungs, **0 bid cells**, 512 resident warmup columns.

**Yahoo rate-limit note (honest):** the server logged `Yahoo Finance rate limit (HTTP 429)` on the
first AAPL warmup requests and backed off (5 s → 10 s, up to 5 attempts). The token-bucket +
backoff (§7) then **succeeded** — bars loaded and the SYNTH warmup profile rendered as shown. So
the equity render path is proven live even though the market is closed and Yahoo throttled the
first calls. Had 429 persisted with no bars, the fallback was the parity e2e + T3's prior AAPL
screenshot; it was not needed.

## The keyless equity tier — honest scope (no overclaim)

- The equity depth is a **SYNTH relative-volume profile** (volume-at-price from Yahoo 1 m bars),
  **not real L2 order-book depth**. It is clearly labelled (`SYNTH` badge, amber ramp, single
  profile column) and never presented as a two-sided book. Equities have **no free L2 depth** from
  any source — this is the honest best-effort keyless tier, not a limitation hidden from the user.
- **This machine has no equity API keys.** With `ALPACA_API_KEY/SECRET`, the feed auto-upgrades to
  the **L1_BAND** tier (real IEX BBO px+sz, inferred-side tick tape, real VWAP) with **zero client
  code change** — the client already renders whatever canonical stream + capability descriptor it
  receives (the L1/SYNTH ladder tiers and honesty badges are built in). `FINNHUB_API_KEY` gives a
  keyed tick tape. Keys are auto-detected from env; the tier is chosen server-side.
- **Weekend = market closed** is the real, correct state: SYNTH warmup profile from the last
  session's bars + closed banner + next-open countdown, no empty-column accumulation (§7.1). This
  is expected honest behaviour, not a failure.

## User requirement → evidence

The user's requirement: **"her iki markette de sorunsuz çalışsın"** (works in both markets).

| Requirement facet | Evidence |
|---|---|
| Works in crypto | Live Binance BTCUSDT: real L2 book, real tape, thermal heatmap rebased to BTC (`live-crypto-btcusdt.png`); M1 live-verified real Binance |
| Works in equities | Live keyless AAPL: SYNTH amber profile re-anchored to AAPL, closed banner + countdown, honest badges (`live-equity-aapl.png`) |
| **Both** through one renderer | parity.spec test 3 drives crypto→(reset)→equity through ONE renderer instance; ramps differ, BBO honesty holds; same UI, no market-specific client logic |
| Honest (not fabricated) | BBO null for keyless, no bid/ask columns, `SIDE NA`, `SYNTH`/`POLL`/`approx`/`1m AGG` badges — all asserted |
| No regression / fast | 240 unit + 18 e2e + 152 pytest green; perf gate PASS (history-independent pan/zoom) |

## Automated suites (all green)

- **Client unit (vitest):** **240 passed** (21 files) — decoder golden vectors, camera/view math,
  tile ring, normalization, bookStore, overlays geometry, symbol filter, settings, keys, session
  reset, ClosedBanner.
- **Client e2e (Playwright, real server + SwiftShader):** **18 passed** (15 M2 + **3 new parity**)
  — heatmap, live-sim, SUM-mips, normalize+crosshair, scroll-back+context-loss, §10 perf gates,
  overlays, panels, shell, session-switch, equity SYNTH, **parity matrix (×3)**.
- **`npm run build` (tsc + vite):** clean (263 kB / 84 kB gzip).
- **Server (pytest):** **152 passed** — grid golden/epoch invariants, protocol vectors, both feed
  adapters (crypto + equity fixtures), side-inference, record/replay, equity session model, REST
  capability.
- **Perf gate (§10):** **PASS** — history-independence ratio **0.889** (10k vs 200 cols; frame
  cost ~constant → v1 1-fps bug structurally gone), pan/zoom **59.9 fps** (vsync-capped under
  SwiftShader; uncapped draw sub-ms), input→frame proxy p95 **18.5 ms** (<32 ms gate), GPU ring
  **80 MB** (<300 MB gate). `client/perf_report.json`.

## M1 + M2 + M3 — what's done

- **M1 (server core):** sim feed, time×price grid + epochs (re-anchor, coarsen), hand-packed binary
  protocol + cross-language golden vectors, crypto (Crypcodile) + equity (stockodile) feed
  adapters, self-recording. Live-verified real Binance in M1. `m1-verification.md`.
- **M2 (client GL renderer):** market-agnostic WebGL2 renderer — TEXTURE_2D_ARRAY tile ring,
  SUM-mips (walls survive zoom-out), residency/LRU + scroll-back, viewport normalization, exact
  crosshair, overlays (bubbles/BBO/VWAP/profile/markers/axes), DOM ladder + tape, top bar / replay
  transport / settings / keyboard. **The v1 1-fps pan/zoom bug is structurally eliminated**
  (transform-only rendering; cost independent of history). Live-verified crypto. `m2-verification.md`.
- **M3 (equity + dual-market parity — this doc):** `feeds/equity.py` (keyless SYNTH tier + Alpaca
  L1 / Finnhub keyed tiers wired, auto-selected from env), equity session routing + honest REST
  capability, US market calendar session model (closed banner / next-open / warmup), SYNTH client
  rendering verified, and the two-market parity matrix (§G3 gate) — automated + live.

**M3 status: COMPLETE.** The same renderer serves crypto (full L2) and equities (honest keyless
SYNTH, zero-code upgrade to Alpaca L1 by adding keys). The "both markets" requirement is met.

## Remaining (optional) — M4

Only optional work remains: **M4 — packaging + the v1→v2 cutover on `main`** (replay UI polish,
package script, README, remove v1 PyQt files once v2 owns `main`). v1 stays intact on `main` until
that cutover; nothing blocks it.
