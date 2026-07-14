# P2 Unified Attack Plan — 50 Themes → Phase 3 (100 Agents)

**Date:** 2026-07-13  
**Scope:** `/Users/nazmi/flowmap` + Crypcodile `flowmap_window`  
**Inputs:** R01–R20, MASTER_PLAN, themes.json, 50 agent plans (Track A–E)  
**Outputs:** This plan + findings schema + GUI matrix + zone/theme plans  

---

## 0. Executive intent

Phase 3 runs **~100 execution agents** against the risk stack:

```text
Ingress (live/replay/CCXT) → queue → OrderBook → Density → Paint / overlays
Embed hist bypasses queue → same book/density
Ship paths + packaging gate usability
```

**Rule (R20):** ~60% capacity on CRITICAL; **never** schedule pure paint hunts before mapping + queue + book truth planned/signed.

---

## 1. Severity gates

| Sev | Definition |
|-----|------------|
| **P0** | Wrong market state, crash, unbounded lag/mem, global SSL, non-portable ship path, silent package death |
| **P1** | Systematic skew, broken switch/reconnect, major UX desync, SQL fragility |
| **P2** | Rare edges, F+ heuristics, secondary overlays |
| **P3** | Polish, dead code, docs |

Finding records: `P2_findings_schema.md` → `FIND-P2NN-XX`.

---

## 2. Zone map (Z01–Z20) → themes

| Zone | Name | Themes (primary) | Wave |
|------|------|------------------|------|
| Z01 | Paint / QImage | 12, 25–29, 50 | W3 |
| Z02 | Density project/scroll | 07–08, 11, 26, 29, 31 | W2 |
| Z03 | Tick / Y map | 09–10 | W2 |
| Z04 | Trade overlays | 03, 05, 30, 32 | W3 |
| Z05 | GUI tick drain | 06, 13–16, 22 | W1 |
| Z06 | Live WS/SSL | 17–18, 20 | W1 |
| Z07 | Replay lifecycle | 13, 19–20 | W1 |
| Z08 | Record mapping | 03–05, 04 | W1 |
| Z09 | Time/price warp | 39–40 | W2 |
| Z10 | Source switch | 21–22 | W1 |
| Z11 | OrderBook | 01–02, 06 | W1 |
| Z12 | Hist preload / embed | 04, 35–38, 42 | W2 |
| Z13 | Paths / SQL | 35, 41, 47 | W1 |
| Z14 | VP / DOM | 33–34 | W3 |
| Z15 | Iceberg/LLT | 45 | W3 |
| Z16 | Input nav | 43–44, 50 | W3 |
| Z17 | CCXT | 23–24 | W1 |
| Z18 | Simulator oracle | 49 | W1 bootstrap / W4 CI |
| Z19 | Plugins | 46 | W4 |
| Z20 | Packaging | 47–48, 50 | W4 (+ smoke W1) |

---

## 3. All 50 themes (master index)

### Track A — Core correctness (01–12)

| N | Theme | Zones | Sibling | Phase-3 focus |
|---|-------|-------|---------|---------------|
| 01 | L2 snapshot replace vs delta matrix | Z11 | R03 | Snapshot vs delta apply matrix unit tests |
| 02 | Crossed book BBO invariants prune | Z11 | R03 | Uncross/prune invariants |
| 03 | Side enum exhaustiveness | Z08,Z04 | R17,R11 | is_buy_side vs BUY-only UI |
| 04 | BookDelta is_snapshot delta-only | Z08,Z12 | R05 | Empty book without snapshot |
| 05 | Trade liquidation field mapping | Z08,Z04 | R05,R06 | Dispatch converters |
| 06 | CVD NaN volume delta contract | Z11,Z05 | R17 | get_volume_delta NaN |
| 07 | Density mid-mask bid/ask projection | Z02 | R07 | Opposite side dropped |
| 08 | Buffer scroll clear-right column | Z02 | R07 | Scroll/shift buffer |
| 09 | One-shot tick detect ticks_per_row | Z03 | R17,R07 | Wrong grid lock |
| 10 | tick_size vs render_tick_size polylines | Z03,Z01 | R17,R08 | History line misalign |
| 11 | Normalizer live vs rebuild divergence | Z02 | R07 | Dual norm paths |
| 12 | Color LUT gamma stale docs | Z01 | R07,R09 | LUT/docs mismatch |

### Track B — Concurrency & data plane (13–24)

| N | Theme | Zones | Sibling | Phase-3 focus |
|---|-------|-------|---------|---------------|
| 13 | Unbounded queue growth model | Z05,Z07 | R16,R05 | queue.Queue growth under burst |
| 14 | Drain limit 1000 starvation | Z05 | R16,R10 | _gui_tick cap |
| 15 | Snapshot clears updates batching | Z05 | R10 | Batch order |
| 16 | Callback disable on_trade None | Z05 | R10,R03 | Plugin/wrapper clobber |
| 17 | Live asyncio quit wait teardown | Z06 | R16,R06 | Zombie QThread |
| 18 | Global SSL monkeypatch blast radius | Z06 | R06 | ssl=False aiohttp |
| 19 | Replay blocking slot vs QThread quit | Z07 | R05,R16 | Blocking start_replay |
| 20 | Dual emit path queue vs signals | Z06,Z07 | R16 | Dead signal handlers |
| 21 | Source switch disconnect completeness | Z10 | R16 | switch_to races |
| 22 | Stale queue after stop switch | Z10,Z05 | R16 | Queue not drained |
| 23 | REST polling on GUI thread | Z17 | R06 | REST blocks Qt |
| 24 | CCXT book identity stall | Z17 | R06 | `is not last_ob` |

### Track C — Rendering & performance (25–34)

| N | Theme | Zones | Sibling | Phase-3 focus |
|---|-------|-------|---------|---------------|
| 25 | OpenGL base vs CPU paint | Z01 | R08 | QOpenGL unused paint |
| 26 | rebuild_heatmap freeze budget | Z01,Z02 | R08 | Main-thread freeze |
| 27 | Throttled deferred rebuild races | Z01 | R08 | singleShot 50ms |
| 28 | QImage zero-copy buffer rebind | Z01 | R08,R09 | Buffer ownership |
| 29 | Resize blank history H15 | Z01,Z02 | R08 | resizeEvent partial push |
| 30 | Trade deque percentile hitch | Z04 | R08 | Trade history cost |
| 31 | Density dict unbounded prices | Z02 | R07,R16 | Memory growth |
| 32 | Bubbles pulse draw cost side bias | Z04 | R11 | BUY-only + perf |
| 33 | DOM refresh vs paint throttle | Z14 | R12 | DOM lag |
| 34 | VP row Y vs heatmap row_height | Z14 | R12 | Y skew |

### Track D — Integration & Crypcodile (35–42)

| N | Theme | Zones | Sibling | Phase-3 focus |
|---|-------|-------|---------|---------------|
| 35 | Hardcoded sys.path embed fragility | Z12,Z13 | R02 | Path inject |
| 36 | Hist equal-time binning fidelity | Z12 | R02 | Bin compress |
| 37 | Gap ≥ bw full wipe semantics | Z12 | R02 | Hist gap wipe |
| 38 | Catalog empty partial channels | Z12 | R05,R02 | Missing channels |
| 39 | Replay trade time-warp design | Z09 | R05 | H1 time warp |
| 40 | Replay price rewrite design | Z09 | R05 | H2 price rewrite |
| 41 | SQL symbol injection quoting | Z13 | R05 | f-string SQL |
| 42 | Standalone vs embed API drift | Z12 | R02,R14 | Dual converters |

### Track E — UX, security, packaging, harness (43–50)

| N | Theme | Zones | Sibling | Phase-3 focus |
|---|-------|-------|---------|---------------|
| 43 | Navigation F scroll go live | Z16 | R08,R18 | auto_follow desync |
| 44 | Wheel Ctrl-scroll UX contract | Z16 | R08,R18 | README vs code |
| 45 | Iceberg LLT false positive design | Z15 | R08 | F+ heuristics |
| 46 | Plugin RCE model before wiring | Z19 | R13 | exec_module risk |
| 47 | Portable data_dir no machine paths | Z13,Z20 | R13 | Hardcoded paths |
| 48 | PyInstaller console hiddenimports UPX | Z20 | R13 | Packaging crash |
| 49 | Simulator differential oracle | Z18 | R04 | Test harness |
| 50 | cua-driver GUI matrix | Z01,Z16,Z20 | R18,MASTER | Computer-use scenarios |

**Plans:** `/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/P2-NN_*.md`  
**Track E summary:** `TRACK_E_SUMMARY.md`

---

## 4. Critical path & dependency graph

```text
Z13 paths/SQL (47, 41, 35)
        │
        ▼
Z06 live ∥ Z07 replay ∥ Z17 CCXT (17–24, 19)
        │
        ▼
Z08 mapping (03–05, 04) ──► Z11 book (01, 02, 06)
        │
        ▼
Z10 switch ──► Z05 gui_tick (13–16, 22)
        │
        ├──► Z09 warp (39, 40)
        ├──► Z12 hist (36–38, 42)
        ▼
Z02 density (07, 08, 11, 31) ──► Z03 tick (09, 10)
        │
        ▼
Z01 paint (25–29, 12) + Z04 trades (30, 32) + Z14/Z15 + Z16 (43, 44)
        │
        ▼
Z18 oracle (49) · Z19 plugins (46) · Z20 package (48) · CUA (50)
```

**Critical path one-liner:**  
`Z13 → (Z06∥Z07∥Z17) → Z08 → Z11 → Z05 → Z02 → Z03 → Z01`

Parallel ASAP: Z10, Z09, Z12, Z20 smoke.

---

## 5. Wave plan W1–W4 (Phase 3)

### Wave 1 — Data plane truthful & non-zombie

| Goal | No silent stall; book/trade map unit tests green |
|------|--------------------------------------------------|
| **Zones** | Z13, Z11, Z08, Z05, Z06, Z07, Z10, Z17 |
| **Themes** | **01–06, 13–24, 41, 47**, 49-bootstrap, 50-C0 optional |
| **Agents (hint)** | ~40 |
| **Exit criteria** | |
| | - Drain/queue behavior measured (13–15) |
| | - Live/replay teardown no hang on quit sample (17, 19, 47 quit) |
| | - Snapshot/delta/side/trade map tests (01–05) |
| | - CVD NaN characterized (06) |
| | - SSL monkeypatch documented (18) |
| | - CCXT stall confirmed/skip if unused (23–24) |
| | - Paths inventory + HOME sandbox (47) |
| | - SQL inventory + quote tests (41) |
| | - Sim event recorder seed (49) |
| **P0 targets** | P0-01…07, 10–12, 14 from R20 |

### Wave 2 — Engine + hist/replay fidelity

| Goal | Golden density columns; tick grid consistent; warp documented |
|------|----------------------------------------------------------------|
| **Zones** | Z09, Z12, Z02, Z03 |
| **Themes** | **07–12, 35–40, 42**, 31, 49 density goldens |
| **Agents** | ~25 |
| **Exit criteria** | |
| | - Mid-mask / scroll / norm findings (07, 08, 11) |
| | - ticks_per_row + tick vs render_tick (09, 10) |
| | - LUT/docs (12) |
| | - Time warp + price rewrite design FINDs (39, 40) |
| | - Hist bin, gap wipe, catalog empty (36–38) |
| | - Embed path + converter diff (35, 42) |
| | - Unbounded density prices (31) |
| **Block** | No mass paint pixel hunts until 09/10 signed |

### Wave 3 — Pixels & interaction

| Goal | Resize/history paint OK; overlays align; input matrix |
|------|--------------------------------------------------------|
| **Zones** | Z01, Z04, Z14, Z15, Z16 |
| **Themes** | **25–30, 32–34, 43–45**, 50-C2…C6 |
| **Agents** | ~25 |
| **Exit criteria** | |
| | - OpenGL/CPU, rebuild freeze, deferred race, QImage, H15 (25–29) |
| | - Trade hitch, bubbles bias (30, 32) |
| | - DOM/VP Y (33, 34) |
| | - Nav + wheel contracts (43, 44) |
| | - Iceberg/LLT F+ (45) |
| | - CUA C2–C6 executed |

### Wave 4 — Harness, security model, ship

| Goal | Portable paths; package cold-start; plugin model; CI oracle |
|------|--------------------------------------------------------------|
| **Zones** | Z18, Z19, Z20 + residual |
| **Themes** | **46, 48, 49-CI, 47 residual, 50-C7**, any open P0/P1 |
| **Agents** | ~10 + residual reassignment |
| **Exit criteria** | |
| | - Plugin security model written; **not wired** without Model B (46) |
| | - Spec audit + cold start matrix + crash log plan (48) |
| | - pytest oracles in tree (49) |
| | - `strings` app free of `/Users/nazmi` or FIND accepted (47) |
| | - Packaged CUA C7 |
| | - Registry: all P0 either fixed-handoff or explicit waive |

---

## 6. Phase-3 agent capacity model (100)

| Bucket | Agents | Work |
|--------|-------:|------|
| W1 unit/static concurrency | 28 | Themes 01–06, 13–24 |
| W1 paths/SQL/oracle bootstrap | 8 | 41, 47, 49 |
| W2 density/tick/hist/warp | 22 | 07–12, 35–42, 31 |
| W3 render/overlay | 14 | 25–34 |
| W3 UX + CUA serial slots | 12 | 43–45, 50 (time-multiplexed) |
| W4 package/security/CI | 8 | 46, 48, 49, residual |
| Float / flake / dual-confirm | 8 | Repro hard FINDs |
| **Total** | **100** | |

**GUI serialization:** ≤1 CUA agent per display; schedule G1–G9 shifts (see `P2_gui_automation_matrix.md`).

---

## 7. Never-drop list (if capacity cut)

From R20: **06, 09, 10, 13–15, 17–19, 24, 29, 39–41, 47–48**.

If <50 planning existed these stay; for execution, these get agents first within each wave.

---

## 8. Fixtures & oracles (shared)

| Fixture | Owner | Consumers |
|---------|-------|-----------|
| Mini parquet lake | 38/47 | Replay, hist, SQL |
| Evil symbol list | 41 | SQL, UI |
| Sim seed recorder | 49 | A/B/C unit |
| Golden density `.npy` | 49/07 | Density |
| Converter golden rows | 42 | Embed drift |
| CUA screenshot baselines | 50 | UX |
| HOME sandbox | 47 | Portability |
| FlowMap.app | 48 | Package |

Preferred root: `/Users/nazmi/flowmap/bug_hunt/phase3_execution/fixtures/` (create in Phase 3).

---

## 9. Taxonomy × wave heat map

| Taxonomy | Hottest themes | Wave |
|----------|----------------|------|
| correctness | 01–12, 39–40, 42 | W1–W2 |
| concurrency | 13–22 | W1 |
| memory | 13, 31, 39 materialize | W1–W2 |
| performance | 14, 26, 30, 32–34 | W1, W3 |
| rendering | 25–29, 10, 34 | W3 |
| input_ux | 43–44, 50 | W3 |
| data_source | 17–19, 23–24, 38–40 | W1–W2 |
| integration | 35–38, 42 | W2 |
| packaging | 47–48 | W1 inv / W4 |
| security | 18, 41, 46 | W1, W4 |

---

## 10. Reporting & handoff

| Phase 3 artifact | Path |
|------------------|------|
| Findings JSONL | `phase3_execution/findings/FINDINGS.jsonl` |
| Schema | `phase2_plan/P2_findings_schema.md` |
| Per-theme reports | `phase3_execution/by_theme/P2-NN.md` |
| CUA shots | `phase3_execution/cua_shots/` |
| Phase 4 input | P0/P1 open list sorted by zone critical path |

**Fix phase (Phase 4):** regression tests preferred; GUI verify via CUA smoke C0.

---

## 11. Entry commands (agents)

```bash
# Unit book
cd /Users/nazmi/flowmap && python -m unittest tests.test_bbo_pipeline -v

# Dev GUI
python /Users/nazmi/flowmap/run_flowmap.py

# Static path audit
rg -n "/Users/nazmi" /Users/nazmi/flowmap/flowmap /Users/nazmi/Crypcodile/src/crypcodile/gui --glob '*.py'

# SQL audit
rg -n "WHERE symbol = '" /Users/nazmi/flowmap/flowmap /Users/nazmi/Crypcodile/src/crypcodile/gui --glob '*.py'

# Plugin call sites
rg -n "discover_plugins|load_and_register" /Users/nazmi/flowmap/flowmap --glob '*.py'
```

---

## 12. Track plan file index

| Track | Summary | Plans |
|-------|---------|-------|
| A 01–12 | (roster) | `agent_plans/P2-01_*` … (coordinators A–D) |
| B 13–24 | | |
| C 25–34 | | |
| D 35–42 | | includes 41–42 written with E |
| E 43–50 | **`TRACK_E_SUMMARY.md`** | P2-41…50 complete |

> **Note:** This coordinator (E) authored themes **41–50** fully plus unified docs. Themes **01–40** plans are owned by parallel Phase-2 coordinators; this unified plan still schedules all 50 for Phase 3 using themes.json + R20.

---

## 13. Phase-2 completion checklist

- [x] themes.json n=1..50  
- [x] R20 wave model absorbed  
- [x] Track E plans P2-41…50  
- [x] TRACK_E_SUMMARY.md  
- [x] P2_findings_schema.md  
- [x] P2_gui_automation_matrix.md  
- [x] P2_unified_attack_plan.md (this file)  
- [ ] Zone specs Z01–Z20 (optional separate; zones covered in theme plans + R20)  
- [ ] Confirm agent_plans P2-01…40 present from other coordinators  

---

## 14. One-page Phase-3 kickoff

1. Spawn W1 pool on 01–06, 13–24, 41, 47, 49.  
2. Lock display for CUA C0 (01, 02, 47).  
3. Open FINDINGS.jsonl; enforce schema.  
4. Daily: merge P0 list; no W3 paint until W1 exit.  
5. W2 density/hist/warp.  
6. W3 pixels + full CUA.  
7. W4 package + plugin model + oracle CI.  
8. Hand Phase 4 the P0/P1 registry.

**End of unified plan.**
