# FlowMap v2 — M3: Equity (stockodile) feed + dual-market parity

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Read the
> design spec §7 (capability tiers, equity session model §7.1) at
> `docs/superpowers/specs/2026-07-17-flowmap-v2-bookmap-design.md` BEFORE any task — it is the
> authority for how equities render honestly.

**Goal:** Complete the user's "works in BOTH markets" requirement — wire the stockodile US-equity
feed into the server so an equity symbol renders live through the exact same market-agnostic
client, with honest capability tiers, and prove two-market feature parity.

**Architecture:** Additive server work. The renderer + protocol are market-agnostic (canonical
channels + capability descriptor); M1/M2 already built the `SYNTH_PROFILE` depth mode, the SYNTH
mip ramp (T7), the SYNTH DOM-ladder tier (T11), and honesty badges. M3 adds `feeds/equity.py`
(stockodile → canonical), routes equity markets in the session factory, applies the equity
session model (US market calendar), and verifies parity. **No client rewrite.**

**Key constraints (from the M0 stockodile analysis — verify against source):**
- Equities have **NO L2 depth** from any free source. Best case = Alpaca IEX **L1 BBO** (needs
  `ALPACA_API_KEY`/`SECRET`). **This machine has no equity API keys**, so the live tier is
  **keyless**: Yahoo 1 m bars (7-day window, ~1 req/1.5 s throttle) + google_finance ~10 s
  last-price poll. Keyless therefore renders **SYNTH_PROFILE** depth (volume-at-price from 1 m
  bars), a display-only last-price tape, no tick CVD.
- stockodile uses the same `Sink`/`collect`/`make_provider` architecture as Crypcodile; Entropy's
  `feeds/equities/live.py` is a working reference adapter (read it).
- `USMarketCalendar` (America/New_York, holiday-aware) gates equity sessions. Today may be a
  weekend/after-hours → the feed must handle a CLOSED market (Status closed + next-open; SYNTH
  profile still renders from the last session's Yahoo bars as warmup).
- Config already has `dt_equity_keyed_ns` / `dt_equity_keyless_ns`; server has the
  `FLOWMAP_DT_*` env overrides. Depth mode constants: `MODE_SYNTH_PROFILE=2` (bid-only density,
  ask omitted).

**Working rules:** TDD server-side (feeds adapter fixture-driven, no live network in pytest);
Playwright/visual for the client render. Server code under `server/src/flowmap_server/`; commit
prefix `feat(server)`/`feat(client)`. Opsera two-step commit (touch flag separate call, commit
separate call). No Claude co-author trailer. Symlink caveat. `--ignore` nothing that's green.

---

### Task 1: Server — `EquityFeed` (stockodile → canonical), keyless SYNTH tier

**Files:** `server/src/flowmap_server/feeds/equity.py`, `server/tests/feeds/test_equity_feed.py`,
`server/tests/feeds/fixtures/` (recorded stockodile records or hand-built bars).

- Study `/Users/nazmi/stockodile/src/stockodile/` (providers/factory, providers/yahoo/client,
  providers/google_finance/connector, schema/records, scheduler/calendar, sink/base,
  client/collect) and `/Users/nazmi/Entropy/src/entropy/feeds/equities/live.py` (the reference).
- Implement `EquityFeed(symbol, cfg, *, alpaca_key=None, ...)` implementing the `Feed` protocol
  (`market`, `symbol`, `capability`, `events() -> AsyncIterator[FeedEvent]`, re-callable per the
  Feed docstring). Auto-select tier from env keys: Alpaca (both keys) → keyed L1 tape+quotes;
  Finnhub (key) → keyed tick tape, no quotes; **else keyless** (this machine): Yahoo 1 m bars +
  google_finance last-price poll.
- **Keyless canonical output:**
  - `DepthColumn{mode=SYNTH_PROFILE}`: a **volume-at-price density** built from Yahoo 1 m bars
    over the visible window — for each price level (row), the summed bar volume that traded near
    it (distribute each bar's volume across its o/h/l/c range, or at typical price). bid[] carries
    the density, ask omitted. This is a resting-liquidity **stand-in**, clearly a profile — the
    client renders it with the SYNTH ramp + `SYNTH` badge.
  - Tape: google_finance ~10 s last-price prints → `Trade` with `side_src=na`, marked display-only
    (the capability tape tier is `poll`). Do NOT feed these into CVD.
  - `BarColumn` from the 1 m bars (vwap from typical×vol/vol, approx).
  - Markers: gap only.
  - `capability = {depth:'SYNTH_PROFILE', tape:'poll', trade_side:'na', vwap:'approx', markers:['gap']}`.
- **Equity session model (spec §7.1):** use `stockodile.scheduler.calendar.USMarketCalendar`.
  Outside the session window → `events()` yields `Status{feed_state='closed', next_open_ts}` and
  does NOT advance empty columns; still emits a SYNTH warmup profile from the last session's Yahoo
  bars so the heatmap isn't blank. Session boundaries → `Marker{kind='session_break'}`. All
  time logic in America/New_York (DST from zoneinfo).
- **Tests (fixture-driven, no live network):** feed hand-built 1 m bars → assert a SYNTH_PROFILE
  DepthColumn whose density concentrates at the high-volume price, ask is None, mode==2; a
  display-only Trade from a synthetic last-price sequence; a BarColumn with approx vwap; capability
  dict shape; closed-market → Status(closed)+next_open, no empty-column spam; re-callable events().
- Commit `feat(server): stockodile equity feed — keyless SYNTH tier + session model`.

### Task 2: Server — route equity markets in the session factory + capability in REST

**Files:** `server/src/flowmap_server/core/session.py` (feed-factory site ONLY), `api/rest.py`,
tests.

- Route markets `"equity"` (and/or `"equity-iex"`) → `EquityFeed(symbol, cfg)`; dt from
  `cfg.dt_equity_keyless_ns` (or keyed when keys present). Unknown markets still `NotImplementedError`.
- `/api/symbols`: make the equity entries real (AAPL/MSFT/NVDA/TSLA/SPY already static) — set
  their `capability` to the keyless descriptor (`depth:SYNTH_PROFILE`, `tape:poll`) so the client
  badges are honest, and drop the "live in M4" note (now live in M3). Optionally widen the list
  from the SEC universe if cheap; static is fine.
- Test: subscribe `market="equity", symbol="AAPL"` via the session manager (fixture feed) →
  snapshot has a SYNTH_PROFILE column + the equity capability; REST `/api/symbols?q=aapl` returns
  the SYNTH capability.
- Commit `feat(server): route equity sessions + honest equity capability in REST`.

### Task 3: Client — verify SYNTH rendering + honesty; fill any gaps

**Files:** client — mostly verification; small fixes if the SYNTH paths have gaps.

- Verify end-to-end that a `SYNTH_PROFILE` depth stream renders: the heatmap uses the SYNTH ramp
  (single hue, distinct from bid/ask thermal); the DOM ladder shows the SYNTH volume-at-price tier
  (no bid/ask columns, `SYNTH` badge); the crosshair reads the profile value; bubbles/CVD show the
  honest N/A or "poll"/"approx" badges (never fabricated bid/ask). The overlays/panels already have
  capability gating (T10/T11) — CONFIRM they behave for `depth:SYNTH_PROFILE, tape:poll` and fix
  any place that assumes L2 (e.g. a BBO overlay must hide or show N/A, not synthesize a fake quote).
- Playwright `equity.spec.ts`: inject an equity capability + a SYNTH_PROFILE column set via the
  dev hook, assert the heatmap renders the SYNTH ramp, the ladder shows the profile tier + SYNTH
  badge, and no fake L2 bid/ask appears. Keep the perf gate green.
- Commit `feat(client): SYNTH-profile equity rendering + honesty badges verified`.

### Task 4: Two-market parity matrix + M3 verification

**Files:** `server/tests/test_parity_matrix.py` (or a client e2e), `docs/superpowers/plans/m3-verification.md`.

- Parity matrix: every feature (heatmap, DOM ladder, tape, bubbles, CVD, VWAP, profile, imbalance,
  markers, crosshair, replay) × {crypto (L2/tick), equity-keyless (SYNTH/poll)} asserting the
  SPECIFIED state per spec §7's table — full, badged-reduced, or explicit N/A. Automated where
  possible.
- **Live verification:** boot server + client; render live crypto (Binance BTCUSDT) and an equity
  symbol (keyless AAPL). If the US market is OPEN, show live equity SYNTH profile + last-price
  tape updating. If CLOSED (weekend/after-hours), show the closed-state banner + next-open AND the
  SYNTH warmup profile from Yahoo bars rendering (prove the render path works even when the live
  poll is idle). Screenshot both markets. Document market state honestly.
- `m3-verification.md`: the parity matrix result, both-market screenshots, honest note on the
  keyless equity tier (SYNTH profile, not real depth; no keys on this machine → keyed L1 would
  need ALPACA keys), and a mapping of the user's "both markets" requirement → evidence.
- Commit `feat: M3 dual-market parity — crypto + equity live through one renderer`.

---

## Milestone note
M3 fulfills the literal "her iki markette de çalışsın" requirement: the same renderer serves
crypto (full L2) and equities (honest keyless SYNTH tier, upgradeable to Alpaca L1 by adding keys
with zero code change). Honesty is the design contract — equities never fabricate L2 they can't
source (§7). After M3: optional M4 (replay UI polish, packaging, v1→v2 cutover on `main`).
