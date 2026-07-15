# Track A Summary — Core Correctness (P2-01 … P2-10)

**Coordinator:** Phase-2 planning  
**Date:** 2026-07-13  
**Scope:** Themes n=1..10 from `themes.json` (Track A first 10 of 12)  
**Research base:** R03, R07, R08, R11, R17, R20  
**Plans dir:** `/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/`

> Note: Track A in R20 includes themes **01–12**. This package covers **01–10** only (order book → tick/polyline). Themes **11–12** (normalizer live vs rebuild; color LUT/docs) remain for a follow-on Track A tail plan.

---

## 1. Plan file index

| n | Agent plan | Slug | Zones | FIND prefix | Sev prior |
|---|------------|------|-------|-------------|-----------|
| 01 | [P2-01_l2_snapshot_replace_vs_delta.md](./P2-01_l2_snapshot_replace_vs_delta.md) | L2 snap vs delta | Z11 | `FIND-P201-` | P0 |
| 02 | [P2-02_crossed_book_bbo_invariants_prune.md](./P2-02_crossed_book_bbo_invariants_prune.md) | Cross / BBO / prune | Z11 | `FIND-P202-` | P0 |
| 03 | [P2-03_side_enum_exhaustiveness.md](./P2-03_side_enum_exhaustiveness.md) | Side enum | Z08,Z04 | `FIND-P203-` | P1 (P0 if BID/ASK trades live) |
| 04 | [P2-04_bookdelta_is_snapshot_delta_only.md](./P2-04_bookdelta_is_snapshot_delta_only.md) | is_snapshot / delta-only | Z08,Z12 | `FIND-P204-` | P0 |
| 05 | [P2-05_trade_liquidation_field_mapping.md](./P2-05_trade_liquidation_field_mapping.md) | Trade/liq mapping | Z08,Z04 | `FIND-P205-` | P0–P1 |
| 06 | [P2-06_cvd_nan_volume_delta_contract.md](./P2-06_cvd_nan_volume_delta_contract.md) | CVD NaN | Z11,Z05 | `FIND-P206-` | **P0** |
| 07 | [P2-07_density_mid_mask_bid_ask_projection.md](./P2-07_density_mid_mask_bid_ask_projection.md) | Mid-mask / project | Z02 | `FIND-P207-` | **P0** |
| 08 | [P2-08_buffer_scroll_clear_right_column.md](./P2-08_buffer_scroll_clear_right_column.md) | Scroll + clear-right | Z02 | `FIND-P208-` | P1 (P0 if ghosts) |
| 09 | [P2-09_oneshot_tick_detect_ticks_per_row.md](./P2-09_oneshot_tick_detect_ticks_per_row.md) | Tick lock / tpr | Z03 | `FIND-P209-` | **P0** |
| 10 | [P2-10_tick_vs_render_tick_polylines.md](./P2-10_tick_vs_render_tick_polylines.md) | tick vs render lines | Z03,Z01 | `FIND-P210-` | **P0** |

---

## 2. Stack vertical (why this order)

```text
Ingress mapping (04, 05, 03)
        │
        ▼
   OrderBook (01, 02, 06)
        │
        ▼
   Density project (07, 08)
        │
        ▼
   Tick grid (09)
        │
        ▼
   Paint overlays Y (10)  ← do not start before 09
```

Aligned with R20 critical path fragment:

```text
Z08 → Z11 → Z05(partial via 06) → Z02 → Z03 → Z01
```

---

## 3. Recommended Phase-3 wave schedule (Track A 01–10)

### Wave A1 — Book truth (parallel 4 agents)

| Parallel | Theme | Micro-hunts first |
|----------|-------|-------------------|
| ‖ | P2-01 | H1 unit matrix, H3 double absorb |
| ‖ | P2-02 | H1 cross wipe, H2 apply_bbo zero |
| ‖ | P2-06 | H1–H2 NaN prove + status |
| ‖ | P2-03 | H1 static audit, H2 consumer matrix |

**Exit A1:** OrderBook unit suite exists; CVD contract decided; side audit table committed; FINDs filed even if unfixed.

### Wave A2 — Mapping fidelity (parallel 2–3)

| Parallel | Theme | Notes |
|----------|-------|-------|
| ‖ | P2-04 | Dispatch is_snapshot + delta-only |
| ‖ | P2-05 | Converter goldens + liq double + epsilon |
| after 03 | P2-03-H5 | Dual CVD e2e with real mapped sides |

**Exit A2:** Synthetic book+trade stream produces known `get_levels` + CVD; FIND on delta-only lakes.

### Wave A3 — Density + tick (serial-ish)

| Order | Theme | Why serial |
|-------|-------|------------|
| 1 | P2-09 | Wrong tick poisons all row math |
| 2 | P2-07 | Mid-mask / max.at on correct grid |
| ‖ 2 | P2-08 | Scroll/clear independent of mask once draw works |
| 3 | P2-10 | Polylines after grid known; includes buffer-vs-visible Y audit |

**Exit A3:** Golden density column tests; tick lock FINDs; history line Y equals `_price_to_screen_y` for tpr∈{1,10,100} or FIND open.

---

## 4. Cross-theme FIND collision rules

| Topic | Owner theme | Others cite |
|-------|-------------|-------------|
| Double absorb trade+L2 | **P2-01** | P2-05 |
| Cross wipe empty book | **P2-02** | P2-07 |
| BUY-only UI | **P2-03** | P2-05, P2-06 |
| is_snapshot wipe | **P2-04** | P2-01 |
| receive_ts / wall clock stamp | **P2-05** | R11 overlays |
| get_volume_delta nan | **P2-06** | — |
| Mid-mask drop | **P2-07** | — |
| Ghost column | **P2-08** | P2-29 resize (Track C) |
| One-shot tick | **P2-09** | P2-10 |
| History line tick unit | **P2-10** | — |

Do **not** open duplicate FINDs; use `see also FIND-P20X-YY`.

---

## 5. Shared fixtures (create once)

| Path (suggested) | Used by |
|------------------|---------|
| `bug_hunt/fixtures/books/simple_l2.json` | 01, 02, 07 |
| `bug_hunt/fixtures/books/full_cross.json` | 02 |
| `bug_hunt/fixtures/books/snap_then_delta_seq.json` | 01, 04 |
| `bug_hunt/fixtures/trades/side_matrix.json` | 03, 05, 06 |
| `bug_hunt/fixtures/replay/delta_only_synthetic.jsonl` | 04 |
| Engine synthetic helpers (Python) | 07, 08, 09, 10 |

Simulator (`data/simulator.py`) is the preferred **oracle generator** for A1 (R04 / Z18) — do not require live exchange for Track A signoff.

---

## 6. Source anchors cheat-sheet

| Area | Absolute path | Hot lines |
|------|---------------|-----------|
| OrderBook snap/delta | `/Users/nazmi/flowmap/flowmap/core/order_book.py` | 64–132, 166–263, 349–354, 358–464 |
| Side helpers | `/Users/nazmi/flowmap/flowmap/core/__init__.py` | 12–42, 76–86 |
| GUI apply batch | `/Users/nazmi/flowmap/flowmap/ui/main_window.py` | 895–959, 985–996 |
| Dispatch / converters | `/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py` | 76–208 |
| Density scroll/draw | `/Users/nazmi/flowmap/flowmap/engine/density_engine.py` | 119–131, 250–255, 300–394, 534–535 |
| History polyline | `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py` | 297–305, 1401–1430 |
| Bubbles side | `/Users/nazmi/flowmap/flowmap/ui/bubbles.py` | 111–125 |
| Pulse side | `/Users/nazmi/flowmap/flowmap/ui/pulse.py` | 219, 238 |
| Symbol tpr | `/Users/nazmi/flowmap/flowmap/ui/source_manager.py` | ~383–403 |

Existing tests: only `tests/test_bbo_pipeline.py` — **coverage gap is intentional Phase-3 work**.

---

## 7. Highest-confidence P0 cluster (expect findings)

From code already read during planning (not yet formally filed as FINDs):

| Likely FIND | Evidence |
|-------------|----------|
| P2-06 NaN CVD | `order_book.py:351–353` returns `math.nan` |
| P2-10 polyline tick | `heatmap_widget.py:1408` uses `tick_size` not `render_tick_size` |
| P2-10 Y scale #2 | same helper uses `height()/bh` vs visible `row_height` mapping |
| P2-09 dead refine + ignored param | `density_engine.py:119–131` |
| P2-07 mid-mask | `density_engine.py:373–374` |
| P2-02 dual-delete cross | `order_book.py:382–391` |
| P2-03 BUY-only UI | pulse/bubbles/cvd strict `Side.BUY` |

Phase-3 agents must still **reproduce with tests** before marking verified.

---

## 8. Must-keep themes (R20)

If capacity is cut, **never drop** from this set: **06, 09, 10** (also 13–15, 17–19, 24, 29, 39–41, 47–48 outside this track).

Within 01–10 priority if forced ranking:

```text
06 = 09 = 10 > 01 = 02 = 04 = 07 > 05 = 03 > 08
```

---

## 9. Dependencies on other tracks (do not block A1)

| Other theme | Interaction |
|-------------|-------------|
| P2-13/14/15 (queue) | Batch ordering assumptions in 01 |
| P2-29 resize H15 | May look like P2-08 failure |
| P2-39/40 replay warp | Price/time may invalidate 05 absorption oracles — mark expected |
| P2-11/12 | Normalizer/color after 07 |
| P2-32 bubbles | Overlaps 03 side bias |

---

## 10. Phase-3 agent launch checklist

For each hunt agent prompt, include:

1. Absolute plan path for P2-0N  
2. FIND prefix and collision rules (§4)  
3. File:line anchors (§6)  
4. Pass/fail from plan §4  
5. “No product code fixes unless hunt is fix-verification (H-last)” — planning default: **find + repro only** unless user expands  
6. Write findings under agreed schema (R20 §8 `P2_findings_schema.md` when present)

---

## 11. Tail still missing (Track A 11–12)

| n | Theme | Zones | Why after 01–10 |
|---|-------|-------|-----------------|
| 11 | Normalizer live vs rebuild | Z02 | Needs stable projection (07) |
| 12 | Color LUT / gamma / stale docs | Z01 | Docs/LUT after pixels meaningful |

---

## 12. Bottom line

Track A 01–10 plans are **execution-ready**: each has threat model, unit matrices, fixtures, 3–5 micro-hunts, FIND prefixes, fix sketches, and severity priors grounded in R03/R07/R08/R11/R17/R20 and current `flowmap/` line anchors. Start **Wave A1** immediately with pure `OrderBook` + CVD + side audit (no GUI). Defer paint/polyline work until tick grid (09) is characterized.
