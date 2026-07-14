# R20 — Risk-Prioritized Attack Surface Map (Phase 1 → Phase 2 Bridge)

**Agent:** R20  
**Date:** 2026-07-13  
**Status:** **Synthesized** from independent code sizing + all Phase-1 siblings `R01`–`R19` (present under `phase1_research/`).  
**Role:** Single prioritization source of truth for Phase-2 planning and Phase-3 wave order.

**Scope:**

| Tree | Path |
|------|------|
| Standalone FlowMap | `/Users/nazmi/flowmap` |
| Crypcodile embed | `/Users/nazmi/Crypcodile/src/crypcodile/gui/flowmap_window.py` (+ CLI launch) |
| Sibling research | `/Users/nazmi/flowmap/bug_hunt/phase1_research/R01_*.md` … `R19_*.md` |

---

## 0. Executive summary

### Active runtime path (R01)

```
Crypcodile Live | Replay | (CCXT legacy)
    → QThread worker + unbounded queue.Queue
    → MainWindow._gui_tick (~16 ms, drain ≤1000)
    → OrderBook
    → HeatmapWidget.push_snapshot → DensityEngine
    → paintEvent + VP / Pulse / bubbles / DOM
```

### Risk concentrates on one vertical stack

| Layer | Highest-risk modules | Sibling anchors |
|-------|----------------------|-----------------|
| Ingress | `crypcodile_replay`, `crypcodile_live`, `crypto` | R05, R06, R16 |
| Control | `source_manager`, `main_window._gui_tick` | R10, R16 |
| Book | `order_book` | R03, R17 |
| Engine | `density_engine`, normalizer/color | R07, R17 |
| View | `heatmap_widget` (god-object ~2349 LOC) | R08, R09, R17, R18 |
| Overlays | VP, DOM, pulse/bubbles, VWAP | R11, R12 |
| Embed | `flowmap_window` hist preload + path inject | R02 |
| Ship | packaging, hardcoded paths, plugins | R13 |

### Top 10 ship-breakers (cross-report consensus)

| # | Issue | Sev | Primary citations |
|---|-------|-----|-------------------|
| 1 | Unbounded queue + 1000/tick drain → lag/freeze under burst/replay | **P0** | R16, R06, R10 |
| 2 | Replay dual-timeline + price rewrite (trades warped / rewritten) | **P0** | R05 H1–H2 |
| 3 | Thread teardown: blocking worker slots + finite `wait()` → zombies | **P0** | R16, R05 H4 |
| 4 | Hardcoded `/Users/nazmi/data` (+ `/Users/nazmi/flowmap` path inject) | **P0** | R13-C1, R02 |
| 5 | Density/docs lie: decay unused; mid-mask drops opposite side; one-shot tick | **P0** | R07, R17 H-T1 |
| 6 | `tick_size` vs `render_tick_size` history polyline skew | **P0** | R17 H-T6, R08 H3 |
| 7 | `get_volume_delta()` → NaN before first trade | **P0** | R17 H-N1 |
| 8 | Live SSL `ssl=False` global monkeypatch + no reconnect | **P0/P1** | R06 H2/H4, R16 |
| 9 | Resize partial push → blank/garbled history (no full rebuild) | **P1→P0 visual** | R08 H15 |
| 10 | CCXT `is not last_ob` identity check → book stalls after first emit | **P0** (if CCXT path used) | R06 H1 |

**Phase-2 rule:** ~60% of agent capacity on CRITICAL modules/zones; never schedule paint-only hunts before mapping + queue + book truth is planned.

---

## 1. Sibling research index (what each R contributed)

| ID | Focus | Highest-value outputs for prioritization |
|----|-------|------------------------------------------|
| R01 | Architecture | Active vs legacy paths; auto-start live @500ms; stack diagram |
| R02 | Crypcodile embed | Path inject; hist bin path vs standalone; CLI process model |
| R03 | Order book / events | L2 apply semantics, prune, CVD, callbacks |
| R04 | Data manager / simulator | Simulator as oracle; DataManager legacy/unused primary UI |
| R05 | Replay | Dual timeline, price rewrite, materialize-all, auto-loop spin, SQL |
| R06 | Live + CCXT | SSL patch, no reconnect, CCXT identity stall, REST on GUI thread |
| R07 | Density / color | Stale docs, mid-mask, ticks_per_row collapse, norm divergence |
| R08 | Heatmap structure | God-object; H15 resize; dual rebuild paths; OpenGL base-only |
| R09 | Heatmap rendering | Paint stack / artifacts (pair with R08) |
| R10 | Main window | `_gui_tick` batching, wiring, lifecycle |
| R11 | Bubbles / pulse / chart | Overlay side BUY bias, throttles |
| R12 | VP / DOM / theme | Row Y mismatch, `round(price,6)`, DOM not BBO-centered |
| R13 | Plugins / packaging | Hardcoded data_dir P0; unsandboxed plugins; console=False |
| R14 | Tests / diagnostics | Coverage gaps for critical path |
| R15 | Known issues history | Prior pain points (use as regression seeds) |
| R16 | Concurrency | Queue unbounded; quit ineffective; cross-thread direct calls |
| R17 | Numeric edges | tick/render_tick, NaN CVD, side maps, wall-clock trade ts |
| R18 | UX / input matrix | Wheel/Ctrl semantics, focus, keyboard dual handlers |
| R19 | Error handling | Silent swallows; empty UX |

---

## 2. Module risk ranking (impact × likelihood)

**I** = user/data impact (1–5), **L** = likelihood (size × concurrency × smell × sibling hit density).  
**Risk = I × L**. Adjusted after sibling consensus (↑/↓ notes).

| Rank | Module | LOC≈ | I | L | Risk | Band | Sibling weight | Why |
|------|--------|------|---|---|------|------|----------------|-----|
| 1 | `ui/heatmap_widget.py` | 2349 | 5 | 5 | **25** | CRITICAL | R08, R09, R17, R18 | God-widget; paint; trade ts; resize H15; tick mismatch |
| 2 | `data/crypcodile_replay.py` | 961 | 5 | 5 | **25** | CRITICAL | R05, R16 | Dual timeline, rewrite, OOM, zombie thread, SQL |
| 3 | `engine/density_engine.py` | 586 | 5 | 5 | **25** | CRITICAL | R07, R17 | Projection truth; tick lock; mid-mask; rebuild divergence |
| 4 | `ui/main_window.py` | 1175 | 5 | 4 | **20** | CRITICAL | R10, R16, R17 | Drain 1000; NaN CVD pipe; wires all |
| 5 | `ui/source_manager.py` | mid+ | 5 | 4 | **20** | CRITICAL | R10, R05, R06, R16 | Switch races; symbol heuristics; defaults |
| 6 | `data/crypcodile_live.py` | mid | 5 | 4 | **20** | CRITICAL | R06, R16 | SSL patch; no reconnect; asyncio-in-QThread |
| 7 | Crypcodile `gui/flowmap_window.py` | ~250+ | 5 | 4 | **20** | CRITICAL | R02, R13 | Path inject; hist bin/gap wipe; SQL symbol |
| 8 | `core/order_book.py` | mid | 5 | 4 | **20** | CRITICAL ↑ | R03, R17 | Foundation + NaN CVD + epsilon match |
| 9 | `data/crypto.py` | mid-large | 4 | 5 | **20** | CRITICAL ↑ | R06, R16 | H1 book stall; REST blocks GUI |
| 10 | `engine/normalizer.py` + `color_system.py` | sm–mid | 4 | 4 | **16** | HIGH | R07 | Live vs rebuild norm diverge; docs lie |
| 11 | `ui/overlays/volume_profile.py` | mid | 4 | 4 | **16** | HIGH ↑ | R12, R17 | Y grid mismatch; round(price,6) |
| 12 | `ui/pulse.py` + bubbles | mid | 3 | 4 | **12** | HIGH | R11, R17 | Side BUY-only; throttle |
| 13 | `ui/dom/dom_ladder.py` | mid | 3 | 3 | **9** | MED | R12 | Not BBO-centered; depth unused |
| 14 | Packaging / entry | N/A | 5 | 4 | **20** | CRITICAL ↑ | R13 | Hardcoded paths; windowed silent crash |
| 15 | `data/simulator.py` | 782 | 2 | 3 | **6** | LOW–MED ↓ | R04 | Oracle value high, prod path low |
| 16 | `data/manager.py` + base | small | 2 | 3 | **6** | LOW | R01, R04 | Legacy primary path unused |
| 17 | Plugins loader/API | mid | 3 | 3 | **9** | MED | R13 | RCE if wired; **currently unwired** |
| 18 | VWAP / CVDOverlay | small | 2 | 3 | **6** | LOW–MED | R12 | VWAP always-on; CVDOverlay dead |
| 19 | Toolbar / features dialog | mid | 2 | 2 | **4** | LOW | R10, R18 | State desync |
| 20 | Theme | small | 1 | 2 | **2** | LOW | R12 | Hardcode vs Colors |

### Band → Phase-2 capacity

| Band | Risk | % of Phase-2 agents |
|------|------|---------------------|
| CRITICAL | ≥20 | **55–60%** |
| HIGH | 12–19 | **25%** |
| MEDIUM | 8–11 | **10%** |
| LOW | ≤7 | **5–10%** (oracle/harness only for simulator) |

---

## 3. Twenty hunt zones (Phase 2 planning units)

Ordered by priority. Each zone is a Phase-3 work package with sibling hypothesis hooks.

| ID | Zone | Primary files | Classes | Sev | Sibling hyp IDs (non-exhaustive) |
|----|------|---------------|---------|-----|----------------------------------|
| **Z01** | Paint path & buffer→QImage | `heatmap_widget` paint/render | Render, crash, perf | P0–P1 | R08 H1,H6,H16; R09 |
| **Z02** | Density project/scroll/rebuild | `density_engine` | Correctness, perf | **P0** | R07 all; R08 rebuild dual path |
| **Z03** | Tick / center / y-mapping | density + heatmap `_price_*` | Correctness, jitter | **P0** | R17 H-T1,H-T5,H-T6; R08 H3 |
| **Z04** | Trade/liquidation overlays | heatmap add/draw trades | Correctness, time | **P0–P1** | R17 H-TS1; R08 H11; R11 |
| **Z05** | GUI tick queue drain | `main_window._gui_tick` | Concurrency, stall | **P0** | R16; R10 |
| **Z06** | Live WS + SSL + reconnect | `crypcodile_live` | Concurrency, security | **P0** | R06 H2–H7; R16 |
| **Z07** | Replay worker lifecycle | `crypcodile_replay` thread | Concurrency, mem | **P0** | R05 H3,H4,H6; R16 |
| **Z08** | Record mapping fidelity | dispatch/side maps | Correctness | **P0** | R05 H5; R03; R17 H-S* |
| **Z09** | Replay time/price distortion | warp + price rewrite | Correctness | **P0** | R05 H1,H2,H9 |
| **Z10** | Source switch / queue hygiene | `source_manager` | Race, leak | **P0** | R16; R10 |
| **Z11** | OrderBook math | `order_book` | Correctness | **P0** | R03; R17 H-N1,H-F1 |
| **Z12** | Crypcodile hist preload | `flowmap_window` | Integration | **P0–P1** | R02; gap wipe |
| **Z13** | Paths / SQL / defaults | data_dir, symbol SQL | Security, ship | **P0** | R13-C1; R05 H7; R02 |
| **Z14** | Volume profile sync | `volume_profile` | Correctness | P1 | R12 P1 row Y; R17 H-F2 |
| **Z15** | Iceberg / LLT / stops | heatmap heuristics | F+/F- | P1–P2 | R08 H10 |
| **Z16** | Input / navigation | mouse/wheel/key | UX, state | P1 | R08 H4,H5,H12; R18 |
| **Z17** | CCXT dual transport | `crypto.py` | Data, GUI freeze | **P0** if used | R06 H1,H3,H9,H11 |
| **Z18** | Simulator differential oracle | `simulator` | Harness | P1 | R04 |
| **Z19** | Plugins security model | loader/API | Security | P0 if enable | R13-S1–S4 |
| **Z20** | Packaging / cold start | `FlowMap.spec`, main | Crash | **P0** | R13-P*, R13-C* |

### Secondary zones (fold into above if headcount tight)

- **Z14b** DOM ladder (R12) → with Z14  
- **Z04b** Pulse/bubbles side bias (R11/R17) → with Z04  
- **Z01b** Legacy `heatmap_renderer.py` dead path (R08) → docs/delete only, not hunt  

---

## 4. Zone dependency graph

```
Z13 Paths/SQL/defaults ──────────────────────────────┐
        │                                             │
        ▼                                             ▼
   Z07 Replay lifecycle          Z06 Live            Z20 Packaging
        │                           │                     │
        ▼                           ▼                     │
   Z09 Time/price warp         Z17 CCXT ──┐               │
        │                           │     │               │
        └──────────┬────────────────┘     │               │
                   ▼                      │               │
                Z08 Mapping ◄─────────────┘               │
                   │                                      │
                   ▼                                      │
                Z11 OrderBook                             │
                   │                                      │
                   ▼                                      │
        Z10 Switch ──► Z05 GUI tick ◄── Z16 (indirect)    │
                   │                                      │
         ┌─────────┴─────────┐                            │
         ▼                   ▼                            │
      Z02 Density         Z04 Trades                      │
         │                   │                            │
         ▼                   ▼                            │
      Z03 Tick/Y          Z14 VP / Z15 heuristics         │
         │                   │                            │
         └─────────┬─────────┘                            │
                   ▼                                      │
                Z01 Paint ◄───────────────────────────────┘
                   ▲
                   │
                Z12 Hist preload (bypasses queue; hits OrderBook+Density directly)

Z18 Simulator ── oracle for Z11, Z02, Z05
Z19 Plugins ── independent until wired
```

### Critical path (must plan first)

```
Z13 → (Z06 ∥ Z07 ∥ Z17) → Z08 → Z11 → Z05 → Z02 → Z03 → Z01
```

Parallel ASAP: **Z10**, **Z09**, **Z12**, **Z20**.

---

## 5. Phase-2 agent specializations (50 themes)

One theme ≈ one Phase-2 planning agent. Anchors cite zones + sibling IDs.

### Track A — Core correctness (01–12)

| # | Theme | Zones | Sibling fuel |
|---|-------|-------|--------------|
| 01 | L2 snapshot replace vs delta matrix | Z11 | R03 |
| 02 | Crossed book / BBO invariants / prune depth | Z11 | R03 |
| 03 | Side enum exhaustiveness (`is_buy_side` vs BUY-only UI) | Z08, Z04 | R17 H-S*, R11 |
| 04 | BookDelta `is_snapshot` / delta-only books | Z08, Z12 | R05 H5 |
| 05 | Trade/liquidation field mapping | Z08, Z04 | R05, R06 |
| 06 | CVD NaN + volume delta contract | Z11, Z05 | R17 H-N1 |
| 07 | Density mid-mask & bid/ask projection | Z02 | R07 |
| 08 | Buffer scroll + clear-right column | Z02 | R07 |
| 09 | One-shot tick detect + `ticks_per_row` | Z03 | R17 H-T1, R07 |
| 10 | `tick_size` vs `render_tick_size` polylines | Z03, Z01 | R17 H-T6, R08 H3 |
| 11 | Normalizer live vs rebuild divergence | Z02 | R07 |
| 12 | Color LUT / gamma / stale docs audit | Z01 | R07 |

### Track B — Concurrency & data plane (13–24)

| # | Theme | Zones | Sibling fuel |
|---|-------|-------|--------------|
| 13 | Unbounded queue growth model | Z05, Z07 | R16, R05 H6 |
| 14 | Drain limit 1000 starvation | Z05 | R16, R10 |
| 15 | Snapshot clears updates batching | Z05 | R10 |
| 16 | Callback disable `on_trade=None` | Z05 | R10 |
| 17 | Live asyncio + quit/wait teardown | Z06 | R16, R06 |
| 18 | Global SSL monkeypatch blast radius | Z06 | R06 H4 |
| 19 | Replay blocking slot vs `QThread.quit` | Z07 | R05 H4, R16 |
| 20 | Dual emit path (queue vs signals) | Z06, Z07 | R16 |
| 21 | Source switch disconnect completeness | Z10 | R16 |
| 22 | Stale queue after stop/switch | Z10, Z05 | R16 §1.7 |
| 23 | REST polling on GUI thread | Z17 | R06 H3 |
| 24 | CCXT book identity stall (`is not last_ob`) | Z17 | R06 H1 |

### Track C — Rendering & performance (25–34)

| # | Theme | Zones | Sibling fuel |
|---|-------|-------|--------------|
| 25 | OpenGL base vs CPU paint (test gap) | Z01 | R08 H16 |
| 26 | Full `rebuild_heatmap` freeze budget | Z01, Z02 | R08 H1 |
| 27 | Throttled deferred rebuild races | Z01 | R08 |
| 28 | QImage zero-copy / buffer rebind | Z01 | R08 H6 |
| 29 | Resize blank history (H15) | Z01, Z02 | R08 H15 |
| 30 | Trade deque / percentile hitch | Z04 | R08 H19 |
| 31 | Density dict unbounded prices | Z02 | R07, R16 mem |
| 32 | Bubbles/pulse draw cost + side bias | Z04 | R11 |
| 33 | DOM refresh rate vs paint throttle | Z14 | R12 |
| 34 | VP row Y vs heatmap `row_height` | Z14 | R12 P1 |

### Track D — Integration & Crypcodile (35–42)

| # | Theme | Zones | Sibling fuel |
|---|-------|-------|--------------|
| 35 | Hardcoded `sys.path` embed fragility | Z12, Z13 | R02 |
| 36 | Hist equal-time binning fidelity | Z12 | R02 |
| 37 | Gap ≥ bw full wipe semantics | Z12 | R02 / code |
| 38 | Catalog empty/partial channels | Z12 | R05 layout, R02 |
| 39 | Replay trade time-warp design review | Z09 | R05 H1 |
| 40 | Replay price rewrite design review | Z09 | R05 H2 |
| 41 | SQL symbol injection / quoting | Z13 | R05 H7 |
| 42 | Standalone vs embed API drift + tests | Z12 | R02, R14 |

### Track E — UX, security, packaging, harness (43–50)

| # | Theme | Zones | Sibling fuel |
|---|-------|-------|--------------|
| 43 | Navigation matrix (F, scroll, go live) | Z16 | R08 H4/H5, R18 |
| 44 | Wheel/Ctrl-scroll UX contract | Z16 | R08, R18 |
| 45 | Iceberg/LLT false positive design | Z15 | R08 H10 |
| 46 | Plugin RCE model before wiring | Z19 | R13-S* |
| 47 | Portable `data_dir` + no machine paths | Z13, Z20 | R13-C1 |
| 48 | PyInstaller console/hiddenimports/UPX | Z20 | R13-P* |
| 49 | Simulator as differential oracle | Z18 | R04 |
| 50 | cua-driver / mac-computer-use GUI matrix | Z01,Z16,Z20 | MASTER_PLAN |

**If consolidating <50 agents — never drop:** 06, 09, 10, 13–15, 17–19, 24, 29, 39–41, 47–48.

---

## 6. Attack surface × taxonomy (MASTER_PLAN)

| # | Taxonomy | Hottest zones | Consensus leads |
|---|----------|---------------|-----------------|
| 1 | Correctness | Z08–Z11, Z02–Z03, Z09, Z12, Z14 | Dual timeline; tick mismatch; mid-mask; NaN CVD |
| 2 | Concurrency | Z05–Z07, Z10, Z17 | Unbounded queue; quit/wait; REST on GUI |
| 3 | Memory | Z07, Z02, Z04 | `list(book_iter)`; history 10k; density dicts |
| 4 | Performance | Z01, Z02, Z05, Z26 | rebuild freeze; drain lag |
| 5 | Rendering artifacts | Z01, Z03, Z29, Z34 | resize blank; polyline skew; VP Y |
| 6 | Input / UX | Z16 | F/auto_follow; dual key handlers |
| 7 | Data source edges | Z06, Z07, Z12, Z17 | reconnect; empty loop; hist wipe |
| 8 | Integration | Z12, Z35–42 | path inject; dual converters |
| 9 | Packaging | Z20, Z13 | hardcoded path; console=False |
| 10 | Security | Z13, Z18, Z19 | SQL f-string; ssl=False; plugin exec |

---

## 7. Smell / hypothesis registry (Phase-3 entry points)

Prioritized merge of independent scan + sibling hyps. **Not verified fixes** — entry points only.

### P0 cluster

| ID | Smell | Location | Sources |
|----|-------|----------|---------|
| P0-01 | Drain cap 1000 + unbounded queue | `main_window._gui_tick` | R16, R10, this |
| P0-02 | Trades time-warped to book window | `crypcodile_replay` | R05 H1 |
| P0-03 | Trade prices rewritten to book mid/BBO | `crypcodile_replay` | R05 H2 |
| P0-04 | Empty replay auto-loop CPU spin | `crypcodile_replay` | R05 H3 |
| P0-05 | `QThread.quit` ineffective on blocking worker | live/replay/crypto | R05 H4, R16 |
| P0-06 | Hardcoded `/Users/nazmi/data` | MainWindow, SourceManager | R13-C1 |
| P0-07 | Hardcoded `/Users/nazmi/flowmap` inject | Crypcodile flowmap_window | R02 |
| P0-08 | One-shot tick detect locks wrong grid | `density_engine` | R17 H-T1, R07 |
| P0-09 | History line uses `tick_size` not `render_tick_size` | heatmap ~1408 | R17 H-T6, R08 H3 |
| P0-10 | `get_volume_delta` → NaN | order_book → gui_tick | R17 H-N1 |
| P0-11 | aiohttp `ssl=False` monkeypatch | crypcodile_live | R06 H4 |
| P0-12 | CCXT OB identity check stalls book | crypto.py | R06 H1 |
| P0-13 | Packaging console=False silent death | FlowMap.spec | R13-P3/C2 |
| P0-14 | No live reconnect after connector fail | crypcodile_live | R06 H2 |

### P1 cluster (sample)

| ID | Smell | Sources |
|----|-------|---------|
| P1-01 | Resize one-column push skips full rebuild | R08 H15 |
| P1-02 | REST fetch on GUI thread | R06 H3 |
| P1-03 | Trade overlay stamps `time.time()` | R17 H-TS1 |
| P1-04 | VP Y uses `i*h/bh` vs fixed row_height | R12 |
| P1-05 | `round(price, 6)` VP binning | R12, R17 H-F2 |
| P1-06 | Side BUY-only in pulse/bubbles | R17, R11 |
| P1-07 | SQL f-string symbol | R05 H7, flowmap_window |
| P1-08 | Live omits book_ticker/liquidation channels | R06 H6/H7 |
| P1-09 | Full materialize replay OOM | R05 H6 |
| P1-10 | Hist gap ≥ bw wipes state | flowmap_window code |
| P1-11 | Auto-follow / F / scroll_offset desync | R08 H4/H5 |
| P1-12 | Plugin exec_module if enabled | R13-S1 |
| P1-13 | OpenGL context fail packaged | R13-C4 |
| P1-14 | Trade–book epsilon 5e-5 not tick-relative | R17 H-F1 |
| P1-15 | Density “decay” docs false / unused | R07 |

---

## 8. Phase-2 deliverables (recommended files)

Under `/Users/nazmi/flowmap/bug_hunt/phase2_plan/`:

| File | Purpose |
|------|---------|
| `P2_unified_attack_plan.md` | This doc condensed + wave schedule |
| `P2_zone_specs/` (`Z01`…`Z20`) | Repro, fixtures, pass/fail, linked hyp IDs |
| `P2_agent_roster_50.md` | Theme → agent assignment |
| `P2_fixtures_oracles.md` | Simulator + known parquet ranges + golden buffers |
| `P2_gui_automation_matrix.md` | cua-driver / screenshots for Z01/Z16/Z20 |
| `P2_findings_schema.md` | ID, P0–P3, file:line, repro, expected/actual, fix hint, sibling cite |

### Severity gates (Phase 3)

| Sev | Definition |
|-----|------------|
| **P0** | Wrong market state, crash, unbounded lag/mem, global security patch, non-portable ship path |
| **P1** | Systematic visual/data skew, broken switch/reconnect, major UX desync |
| **P2** | Rare edges, F+ heuristics, secondary overlays |
| **P3** | Polish, dead code, theme, docs |

---

## 9. Phase-3 wave plan

| Wave | Zones | Goal | Exit criteria |
|------|-------|------|---------------|
| **W1** | Z13, Z11, Z08, Z05, Z06, Z07, Z10, Z17 | Data plane truthful & non-zombie | No silent stall; book/trade map unit tests green |
| **W2** | Z09, Z12, Z02, Z03 | Engine + hist/replay fidelity | Golden density columns; tick grid consistent |
| **W3** | Z01, Z04, Z14, Z16, Z15 | Pixels & interaction | Resize/history paint OK; overlays align |
| **W4** | Z18, Z19, Z20 + residual | Harness, security model, ship | Portable paths; package cold-start matrix |

Do **not** start W3 paint hunts before W1 mapping+queue signoff (avoids thrash).

---

## 10. Effort allocation (50 Phase-2 agents)

| Track | # | % | Focus |
|-------|---|---|-------|
| A Core correctness | 12 | 24% | Book, map, density, tick |
| B Concurrency/data | 12 | 24% | Queue, threads, live/CCXT |
| C Render/perf | 10 | 20% | Paint, resize, overlays draw |
| D Integration | 8 | 16% | Embed, hist, replay distortion |
| E UX/sec/pkg/harness | 8 | 16% | Paths, package, plugins, GUI auto |

---

## 11. Absolute path index

### FlowMap

- `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py`
- `/Users/nazmi/flowmap/flowmap/engine/density_engine.py`
- `/Users/nazmi/flowmap/flowmap/engine/normalizer.py`
- `/Users/nazmi/flowmap/flowmap/engine/color_system.py`
- `/Users/nazmi/flowmap/flowmap/ui/main_window.py`
- `/Users/nazmi/flowmap/flowmap/ui/source_manager.py`
- `/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py`
- `/Users/nazmi/flowmap/flowmap/data/crypcodile_live.py`
- `/Users/nazmi/flowmap/flowmap/data/crypto.py`
- `/Users/nazmi/flowmap/flowmap/data/simulator.py`
- `/Users/nazmi/flowmap/flowmap/data/manager.py`
- `/Users/nazmi/flowmap/flowmap/data/base.py`
- `/Users/nazmi/flowmap/flowmap/core/order_book.py`
- `/Users/nazmi/flowmap/flowmap/core/events.py`
- `/Users/nazmi/flowmap/flowmap/ui/overlays/volume_profile.py`
- `/Users/nazmi/flowmap/flowmap/ui/overlays/vwap.py`
- `/Users/nazmi/flowmap/flowmap/ui/overlays/cvd.py`
- `/Users/nazmi/flowmap/flowmap/ui/dom/dom_ladder.py`
- `/Users/nazmi/flowmap/flowmap/ui/bubbles.py`
- `/Users/nazmi/flowmap/flowmap/ui/pulse.py`
- `/Users/nazmi/flowmap/flowmap/plugins/loader.py`
- `/Users/nazmi/flowmap/flowmap/plugins/plugin_api.py`
- `/Users/nazmi/flowmap/flowmap/main.py`
- `/Users/nazmi/flowmap/run_flowmap.py`
- `/Users/nazmi/flowmap/FlowMap.spec`

### Crypcodile

- `/Users/nazmi/Crypcodile/src/crypcodile/gui/flowmap_window.py`
- `/Users/nazmi/Crypcodile/src/crypcodile/cli.py` (flowmap command)
- `/Users/nazmi/Crypcodile/tests/gui/test_flowmap_window.py`
- `/Users/nazmi/Crypcodile/tests/gui/test_flowmap_gui_cua.py`

### Sibling reports

- `/Users/nazmi/flowmap/bug_hunt/phase1_research/R01_architecture.md` … `R19_error_handling.md`
- This file: `/Users/nazmi/flowmap/bug_hunt/phase1_research/R20_risk_prioritization.md`

---

## 12. Bottom line for Phase-2 planners

1. **Trust the consensus stack**, not file count alone — but the largest files *are* the riskiest; ranking aligns with R05/R07/R08/R16.  
2. **Queue + worker teardown is the concurrency P0 hub** (R16).  
3. **Replay is not “historical playback”** — it is warp+rewrite+loop (R05); treat as intentional design risk, not a single typo.  
4. **DensityEngine docs are untrustworthy** (R07) — re-derive invariants from code before testing “decay.”  
5. **HeatmapWidget is one product with DensityEngine** — Z01–Z03 planned together.  
6. **Ship path is broken for anyone but the author** (R13 hardcoded data_dir) — packaging is P0, not polish.  
7. **Crypcodile embed is a third data path** (hist bins), not a thin wrapper (R02).  
8. **Wave order:** mapping/queue/book → density/tick → paint/overlays → package/plugins.  
9. Prefer **simulator + fixed parquet** oracles before live exchanges (R04, Z18).  
10. Cite sibling hyp IDs in Phase-3 findings for traceability.

---

*R20 complete. Phase-2 may begin from this document without waiting for further Phase-1 churn; re-rank only if Phase-3 disproves a CRITICAL assumption.*
