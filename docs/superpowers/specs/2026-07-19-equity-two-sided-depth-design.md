# FlowMap — Equity Two-Sided Depth (stockodile 0.2.0) — Design

**Date:** 2026-07-19 · **Status:** In progress (autonomous increment) · **Branch:** `main`

Upgrade FlowMap's US-equity depth from a **bid-only** volume-at-price profile to a
**two-sided** (bid + ask) synthetic depth, consuming stockodile 0.2.0's new depth
synthesis, and fill the previously-empty keyed-Alpaca depth channel with a real L1
two-sided book. This is the "data you said couldn't be pulled is now pullable" ask:
the equity **ask side** (and real Alpaca L1 top-of-book) now render.

## Context / what changed upstream
stockodile advanced 0.1.2 → **0.2.0** (public `main` @`8ea71db`), adding `stockodile.depth`:
- `depth.vap` (pure): `reference_price(bars)` = last close; `volume_at_price(bars, bins)`;
  `split_ladder(profile, ref, top_n)` → `(bids below ref desc, asks above ref asc)`.
- `depth.SyntheticYahooDepthSource` / `AlpacaL1DepthSource` / `select_depth_source()` facade
  (env-switch: Alpaca L1 iff both `ALPACA_API_KEY`/`SECRET`, else keyless synthetic).
- `DepthProfile` record; `Level = tuple[float, float]` (price, size).

Live AAPL (ref 333.74): 10 bids / 2 asks (honest asymmetry — price near session high),
raw sizes **2.8M–16.1M shares** → **f16 overflow** (grid ring max 65 504); must normalize.

## Design

### Server — `feeds/equity.py`
- **Keyless / finnhub depth (verifiable here):** keep FlowMap's **cumulative** bar
  accumulation and 60 s bar-refresh / 10 s re-assert lifecycle (this is what makes the
  heatmap evolve over time and never hammers Yahoo — a per-column `snapshot()` would
  429). Replace the bid-only emit with a **two-sided split**: partition the cumulative
  `(price→size)` buckets into bid (`price ≤ ref`) and ask (`price > ref`) around a
  **reference price** — mirroring stockodile `split_ladder` semantics and using
  `stockodile.depth.vap.reference_price` for the default ref. During warmup `ref` = that
  bar's close (the bid/ask boundary walks with historical price → genuine depth-over-time);
  live, `ref` = the polled last price. Normalize the **combined** bid+ask peak to
  `PROFILE_PEAK_TARGET` (single scale factor → cross-side ratios preserved; f16-safe).
- **Alpaca (keyed) depth:** derive a real **2-level L1** two-sided `BookState` from the
  already-streamed BBO (bid_px/ask_px + normalized sizes) — real-time, no extra REST.
  Fills the currently-empty keyed depth channel. (Unit-tested; no live keys on this box.)
- Display-only last-price tape, session/markers, market-closed handling: **unchanged**.
- Capability: keyless `depth: "SYNTH"` (was `"SYNTH_PROFILE"`, now two-sided but still
  honestly synthetic), alpaca `depth: "L1"` (was `"L1_BAND"`), finnhub unchanged (`N/A`).

### Server — `core/session.py`
- `_EQUITY_DEPTH_MODE`: map `"SYNTH"`/`"L1"` → `MODE_L1_BAND` (two-channel render); keep
  legacy `"SYNTH_PROFILE"`/`"L1_BAND"` entries for compatibility. Keyless cadence keyed off
  the synthetic tier (`depth in {"SYNTH","SYNTH_PROFILE"}` → `dt_equity_keyless_ns`).
- No new wire mode ⟹ the 12 golden vectors + TS mirror stay byte-identical.

### Client — `ui/DomLadder.tsx`
- **Decouple render-shape from badge.** Render two-sided bid/ask cells whenever the book
  actually has an ask channel (`mode !== SYNTH_PROFILE`), regardless of tier; render the
  single-channel profile only for a genuinely one-sided book. The **badge** text still comes
  from `capability.depth` (`SYNTH`/`L1`/`L2`) — honest tier, unchanged. Best bid/ask + mid
  derive from the density arrays (the existing sim/L2 path) for two-sided synthetic.
- Heatmap: already renders two channels for crypto L2 → **no change** (two-sided equity
  density renders automatically).

## Honesty (spec §7)
Two-sided synthetic depth is still **synthetic** — a relative volume-at-price shape, not
real resting orders — and stays badged `SYNTH` everywhere. Only keyed Alpaca is badged `L1`
(real top-of-book). No fabricated depth; asymmetry (e.g. 10 bids / 2 asks) is shown as-is.

## Verification
- Server pytest (feeds/equity + session + wire golden vectors unchanged).
- Client vitest (DomLadder two-sided-synth + badge) + e2e.
- **Live AAPL**: two-sided heatmap (bid band below / ask band above the walking mid), DOM
  shows bid+ask rungs with `SYNTH` badge, density texels bounded (no `∞`/blown heatmap).
- Fresh-clone smoke (public install still resolves the new pin).
- Re-publish **1.0.1**: rebuild DMG (sidecar venv now stockodile 0.2.0), push, cut release.
