# Track C/D Summary — Themes P2-31 … P2-40

**Coordinator:** Phase-2 planning (agents P2-31–P2-40)  
**Date:** 2026-07-13  
**Scope:** Track C tail (rendering/perf 31–34) + Track D head (integration/Crypcodile 35–40)  
**Inputs:** `themes.json`, R20, R07, R11, R12, R02, R05; code under `/Users/nazmi/flowmap/flowmap/` and `/Users/nazmi/Crypcodile/src/crypcodile/gui/flowmap_window.py`  
**Plans dir:** `/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/`

---

## 1. Roster & plan files

| # | Theme | Track | Zones | Plan file |
|---|-------|-------|-------|-----------|
| 31 | Density dict unbounded prices | C | Z02 | [P2-31_density_dict_unbounded_prices.md](./P2-31_density_dict_unbounded_prices.md) |
| 32 | Bubbles/pulse draw cost + side bias | C | Z04 | [P2-32_bubbles_pulse_draw_cost_side_bias.md](./P2-32_bubbles_pulse_draw_cost_side_bias.md) |
| 33 | DOM refresh vs paint throttle | C | Z14 | [P2-33_dom_refresh_vs_paint_throttle.md](./P2-33_dom_refresh_vs_paint_throttle.md) |
| 34 | VP row Y vs heatmap row_height | C | Z14 | [P2-34_vp_row_y_vs_heatmap_row_height.md](./P2-34_vp_row_y_vs_heatmap_row_height.md) |
| 35 | Hardcoded sys.path embed fragility | D | Z12,Z13 | [P2-35_hardcoded_syspath_embed_fragility.md](./P2-35_hardcoded_syspath_embed_fragility.md) |
| 36 | Hist equal-time binning fidelity | D | Z12 | [P2-36_hist_equal_time_binning_fidelity.md](./P2-36_hist_equal_time_binning_fidelity.md) |
| 37 | Gap ≥ bw full wipe semantics | D | Z12 | [P2-37_gap_bw_full_wipe_semantics.md](./P2-37_gap_bw_full_wipe_semantics.md) |
| 38 | Catalog empty/partial channels | D | Z12 | [P2-38_catalog_empty_partial_channels.md](./P2-38_catalog_empty_partial_channels.md) |
| 39 | Replay trade time-warp design | D | Z09 | [P2-39_replay_trade_time_warp_design.md](./P2-39_replay_trade_time_warp_design.md) |
| 40 | Replay price rewrite design | D | Z09 | [P2-40_replay_price_rewrite_design.md](./P2-40_replay_price_rewrite_design.md) |

Each plan contains all required template sections: scope, threat model, probes, pass/fail, fixtures, Phase-3 micro-tasks, FIND-IDs, fix sketch, dependencies, severity priors.

---

## 2. Severity heatmap (planning priors)

| Sev | Themes | Rationale (phase1 consensus) |
|-----|--------|------------------------------|
| **P0** | **35, 39, 40** | Path inject ship-break; dual-timeline + price fiction (R20 top ship-breakers #2,#4) |
| **P0–P1** | **36, 38** | Hist compress / missing snapshot bootstrap on real lakes |
| **P1** | **31, 32, 34, 37** | Mem growth vectors; side/column overlay bugs; VP Y skew; silent hist wipe |
| **P1–P2** | **33** | DOM not BBO-centered (P1 product) + throttle races (P2) |

**R20 “never drop” overlap in this range:** **39, 40** (and 41 just outside).

---

## 3. Dependency graph (31–40)

```
P2-35 sys.path ─────────────────────────────────────────────┐
    │                                                         │
    ▼                                                         ▼
P2-38 channels ──► P2-36 binning ──► P2-37 gap wipe ──► live tail
    │                    │
    │                    └──► Z02 density / Z04 trades (shared push_snapshot)
    │
P2-39 time-warp ◄──────────────┐
    │                          │  same module crypcodile_replay.py
P2-40 price rewrite ───────────┘
    │
    └──► P2-32 bubbles Y, P2-34 VP keys, P2-45 later

Track C internal:
P2-31 history mem ──► P2-26 rebuild (upstream Track C)
P2-32 ◄── P2-03 side enum, P2-30 percentile
P2-33 DOM ── parallel ── P2-34 VP  (both Z14; different widgets)
P2-34 ◄── P2-10 tick/render_tick Y truth
```

### Recommended Phase-3 wave order for this band

| Wave | Themes | Why |
|------|--------|-----|
| **W1** | 35, 39, 40 | P0 integrity/portability; unlock/invalidate other tests |
| **W2** | 38, 36, 37 | CLI hist pipeline in order |
| **W3** | 34, 32 | High-confidence visual/overlay correctness |
| **W4** | 31, 33 | Mem model + DOM UX (can parallelize with W3) |

Parallelism: **35 ∥ 39+40** (different repos/modules); **33 ∥ 34**; **31** after long soak fixtures ready.

---

## 4. Track C deep notes (31–34)

### P2-31 Density / memory
- Engine `_bid_density`/`_ask_density` are **snapshot-replaced**, not classic unbounded accumulators (R07 docs stale).
- Real growth suspects: `HeatmapWidget._all_prices` (append-only set), `_history` maxlen 10k holding full level arrays, OrderBook ±15% still large.
- Couples hard to **P2-26** rebuild freeze budget.

### P2-32 Bubbles / pulse
- BUY-only side branch; column off-by-one vs `_frame_count`; bisect vs merge; 10k draw + dual dots; pulse ignores scroll.
- Coordinate findings with **P2-03** and **P2-30** to avoid triple-counting same root causes.

### P2-33 DOM
- 16ms feed / 50ms paint; split `set_levels`/`set_bbo`; **highest-N window not BBO-centered** (R12-H03 P1); `_depth` unused.
- Product severity > FPS tuning.

### P2-34 VP Y
- Highest-confidence geometric P1: `y = i*h/bh` vs heatmap `i*row_height`; `row_height` stored unused; `round(price,6)` keys.
- Fix sketch: shared `price_to_y` / fixed pitch + tick keys.

---

## 5. Track D deep notes (35–40)

### P2-35 Path inject
```python
flowmap_path = "/Users/nazmi/flowmap"  # flowmap_window.py:7
sys.path.insert(0, flowmap_path)
```
P0 portability; `insert(0)` shadows site-packages; no pin. Fix = packaging/env, not heatmap.

### P2-36 Equal-time bins
- `bw` columns for entire `historical_hours` → severe compress.
- **Critical probe:** is `get_buffer().shape[1]` already real width at preload (pre-show)? If 1 → total collapse.
- Not the same as event replay (standalone REPLAY).

### P2-37 Gap wipe
```text
if gap_bins >= bw: reset everything
```
On stale lakes (data days old, wall-clock now) → **destroys successful preload**. Local `/Users/nazmi/data` is a prime trigger.

### P2-38 Partial channels
Real lake often **book_delta+trade only**. Bootstrap needs `is_snapshot` (R05 H5). Empty → silent return. Hist omits liquidation/BBO.

### P2-39 Time-warp
Trades from **global** min/max ts linearly mapped into book window. Causality destroyed; progress looks healthy; RAM holds all trades. **Default must become same-window trades.**

### P2-40 Price rewrite
Static AVG shift + **dynamic snap every trade to BBO/mid**. Replay tape is synthetic. Hist path does **not** rewrite → mode inconsistency. **Default must become raw prices.**

---

## 6. Cross-cutting fixtures (share across agents)

| Fixture | Used by |
|---------|---------|
| Real lake inventory script (`exchange=*/channel=*`) | 36–38, 39–40 |
| Synthetic hive builders (tmp_path) | 36–40 |
| Frozen `time.time_ns` | 37 |
| Side enum trade matrix | 32 |
| Geometry grid (h, row_height, bh) | 34 |
| RSS soak harness (2h) | 31 |
| Import isolation venv | 35 |
| Replay raw-vs-mutated golden CSV | 39, 40 |

---

## 7. Finding ID namespaces

| Theme | Format |
|-------|--------|
| 31 | `FIND-P231-XX` |
| 32 | `FIND-P232-XX` |
| 33 | `FIND-P233-XX` |
| 34 | `FIND-P234-XX` |
| 35 | `FIND-P235-XX` |
| 36 | `FIND-P236-XX` |
| 37 | `FIND-P237-XX` |
| 38 | `FIND-P238-XX` |
| 39 | `FIND-P239-XX` |
| 40 | `FIND-P240-XX` |

---

## 8. Sibling research index (this band)

| Report | Fuel for |
|--------|----------|
| **R20** | Priority, P0 cluster P0-02/03/07, zone graph |
| **R07** | Density storage truth, docs vs code, projection (31, links 34 Y) |
| **R11** | Bubbles/pulse architecture, A1–A9, perf (32) |
| **R12** | DOM/VP hypotheses H01–H15 (33, 34) |
| **R02** | Embed path, hist pipeline, dual converters (35–38) |
| **R05** | Replay H1–H16, lake layout (38–40) |

---

## 9. Explicit non-goals for Phase-3 on these themes

- Do **not** implement fixes in Phase-3 (evidence + FIND reports only).
- Do **not** expand into P2-41 SQL or P2-42 API drift except as **linked** notes.
- Do **not** re-litigate OpenGL/paint (25–29) except when 31 drives rebuild cost.
- Do **not** “fix” replay by making warp “smoother” — integrity default is raw.

---

## 10. Coordinator checklist (done)

- [x] themes 31–40 read from `themes.json`
- [x] R20 + R07,R11,R12,R02,R05 consumed
- [x] Code anchors verified in density_engine, heatmap_widget, bubbles, dom_ladder, volume_profile, flowmap_window, crypcodile_replay
- [x] Ten agent plan files written under `agent_plans/`
- [x] This summary written as `TRACK_C_D_SUMMARY.md`

**Phase-3 handoff:** Start W1 agents on **P2-35, P2-39, P2-40** with self-contained prompts citing the plan paths above.
