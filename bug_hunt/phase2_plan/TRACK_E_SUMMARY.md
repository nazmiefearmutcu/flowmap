# Track E Summary — Themes P2-41 … P2-50

**Track:** UX, security, packaging, harness, GUI automation  
**Agents:** P2-41 … P2-50  
**Date:** 2026-07-13  
**Plans dir:** `/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/`

---

## 1. Roster

| # | Slug file | Zones | Sev band | One-line mission |
|---|-----------|-------|----------|------------------|
| 41 | `P2-41_sql_symbol_injection_quoting.md` | Z13 | P1 (P0 if multi-stmt) | Parameterize / validate all symbol SQL |
| 42 | `P2-42_standalone_vs_embed_api_drift.md` | Z12 | P0–P1 | Single converter + contract tests embed↔standalone |
| 43 | `P2-43_navigation_matrix_f_scroll_go_live.md` | Z16 | P1 | auto_follow / scroll / Go Live state machine |
| 44 | `P2-44_wheel_ctrl_scroll_ux_contract.md` | Z16 | P1 | README↔code wheel/key contract |
| 45 | `P2-45_iceberg_llt_false_positive_design.md` | Z15 | P1–P2 | Heuristic F+/F− + LLT correctness |
| 46 | `P2-46_plugin_rce_model_before_wiring.md` | Z19 | P0 latent | Security model before any plugin wire |
| 47 | `P2-47_portable_data_dir_no_machine_paths.md` | Z13,Z20 | **P0** | Kill `/Users/nazmi/*` defaults |
| 48 | `P2-48_pyinstaller_console_hiddenimports_upx.md` | Z20 | **P0** | Spec hygiene + cold-start matrix |
| 49 | `P2-49_simulator_differential_oracle.md` | Z18 | P1 harness | Sim oracle for A/B/C tracks |
| 50 | `P2-50_cua_driver_gui_matrix.md` | Z01,Z16,Z20 | P1 enabler | Full CUA-01…50 automation |

**R20 never-drop (Track E subset):** 41, 47, 48 (plus 39–40 in Track D).

---

## 2. Shared sources

| Source | Use |
|--------|-----|
| R13 | Plugins, packaging, hardcoded paths |
| R18 | Full control + CUA matrix |
| R05 H7 | SQL f-string |
| R02 | Embed path inject, hist, dual converters |
| R04 | Simulator oracle |
| R14 | Test gaps |
| R20 | Priority / waves |
| MASTER_PLAN | cua-driver + findings rules |
| Code | `crypcodile_replay.py`, `flowmap_window.py`, `FlowMap.spec`, `plugins/*`, `heatmap_widget.py`, `source_manager.py` |

---

## 3. Dependency graph (Track E)

```text
P2-47 paths ─────────────┬──────────► P2-48 packaging
                         │
P2-41 SQL ◄── same lakes ┤
                         │
P2-42 drift ──► P2-35..41 (owns contract; delegates slices)
                         │
P2-49 oracle ──► P2-45 heuristics, many Track A/B/C tests
                         │
P2-46 plugins ── independent until wire; packaging must not enable
                         │
P2-43 nav ──┐
P2-44 wheel ┼──► P2-50 CUA execution
P2-45 docks ┘
```

---

## 4. Phase-3 wave placement (Track E)

| Wave | Themes | Notes |
|------|--------|-------|
| **W1** | **47**, 41 (static), 49 bootstrap | Z13 first on critical path |
| **W2** | 42 (converters), 41 dynamic | With Z12 hist |
| **W3** | 43, 44, 45, 50 C0–C2 | After data plane stable |
| **W4** | **48**, 46 model, 49 CI gate, 50 C7 package | Ship + security model |

---

## 5. Micro-task count (execution load)

| Theme | Hunts | Est. Phase-3 agents |
|-------|------:|--------------------:|
| 41 | 5 | 2–3 |
| 42 | 5 | 3–4 |
| 43 | 5 | 2–3 |
| 44 | 5 | 2 |
| 45 | 5 | 2–3 |
| 46 | 5 | 2 |
| 47 | 5 | 2–3 |
| 48 | 6 | 3–4 |
| 49 | 6 | 3–4 (shared fixture owners) |
| 50 | 7 | 8–12 (CUA suite) |
| **Total Track E** | **~54** | **~30–40 of 100** |

CUA agents are wall-clock serialized on one display → plan shifts, not pure parallel.

---

## 6. Top ship-breakers in Track E

1. **P2-47** `/Users/nazmi/data` + `/Users/nazmi/flowmap` — non-portable ship  
2. **P2-48** `console=False` + UPX + empty hiddenimports — silent death  
3. **P2-42** dual converters — wrong market picture in embed  
4. **P2-41** SQL symbol — silent empty hist / fragile queries  
5. **P2-46** plugin RCE — release blocker if naively wired  
6. **P2-43/44** navigation + README lies — trust/UX  
7. **P2-50** without C0 — no GUI regression gate  

---

## 7. Deliverables checklist

| Artifact | Status |
|----------|--------|
| `agent_plans/P2-41_*.md` … `P2-50_*.md` | Written |
| `TRACK_E_SUMMARY.md` | This file |
| `P2_unified_attack_plan.md` | Written (all 50 themes) |
| `P2_findings_schema.md` | Written |
| `P2_gui_automation_matrix.md` | Written (CUA master) |

---

## 8. Finding ID prefixes

| Theme | Prefix |
|-------|--------|
| 41 | FIND-P241-XX |
| 42 | FIND-P242-XX |
| 43 | FIND-P243-XX |
| 44 | FIND-P244-XX |
| 45 | FIND-P245-XX |
| 46 | FIND-P246-XX |
| 47 | FIND-P247-XX |
| 48 | FIND-P248-XX |
| 49 | FIND-P249-XX |
| 50 | FIND-P250-XX (infra); product → owner theme |

---

## 9. Coordination rules

1. **Do not wire plugins** until P2-46 Model B sign-off.  
2. **Paths before packaging strings scan** (47 → 48).  
3. **CUA product bugs** file under owner theme with `discovered_by: CUA-NN`.  
4. **Oracle fixtures** from 49 land in `tests/oracles/` for Track A reuse.  
5. **Embed vs standalone** converter tests owned by 42; do not duplicate in 05/08 without link.  

---

## 10. Exit criteria for Track E Phase-2

- [x] 10 full plans with template sections 1–10  
- [x] Complete CUA list in P2-50  
- [x] Unified plan W1–W4 maps all 50 themes  
- [x] Findings schema for Phase-3 registry  
- [x] GUI automation matrix standalone doc  

**Phase-2 Track E planning: complete.**
