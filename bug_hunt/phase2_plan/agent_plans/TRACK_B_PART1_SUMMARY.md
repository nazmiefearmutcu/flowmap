# Track B Part 1 Summary — Themes P2-11 … P2-20

| Field | Value |
|-------|-------|
| **Coordinator** | Phase-2 planning (P2-11–P2-20) |
| **Date** | 2026-07-13 |
| **Scope** | Track A tail (11–12) + Track B concurrency core (13–20) |
| **Source of truth** | `themes.json`, `R20_risk_prioritization.md`, siblings R07/R16/R10/R05/R06 |
| **Code root** | `/Users/nazmi/flowmap/flowmap/` |

---

## 1. What this batch covers

| # | Slug file | Theme | Zones | Band |
|---|-----------|-------|-------|------|
| 11 | `P2-11_normalizer_live_vs_rebuild.md` | Normalizer live vs rebuild | Z02 | Track A / HIGH–P0 visual |
| 12 | `P2-12_color_lut_gamma_stale_docs.md` | Color LUT / gamma / docs | Z01 | Track A / P1–P2 |
| 13 | `P2-13_unbounded_queue_growth.md` | Unbounded queue growth | Z05,Z07 | Track B / **P0** |
| 14 | `P2-14_drain_limit_1000_starvation.md` | Drain limit 1000 | Z05 | Track B / **P0** |
| 15 | `P2-15_snapshot_clears_updates_batching.md` | Snapshot batch clear | Z05 | Track B / P0–P1 |
| 16 | `P2-16_callback_disable_on_trade_none.md` | on_trade=None | Z05 | Track B / P1–P2 |
| 17 | `P2-17_live_asyncio_quit_wait_teardown.md` | Live asyncio teardown | Z06 | Track B / **P0** |
| 18 | `P2-18_global_ssl_monkeypatch.md` | SSL ssl=False global | Z06 | Track B / **P0** |
| 19 | `P2-19_replay_blocking_slot_vs_qthread_quit.md` | Replay quit/wait | Z07 | Track B / **P0** |
| 20 | `P2-20_dual_emit_path_queue_vs_signals.md` | Queue vs signals | Z06,Z07 | Track B / P1 latent P0 |

**Note:** Themes 11–12 are listed under Track A in R20 but fall in the n=11..20 planning window; 13–20 are the start of Track B (full Track B continues 21–24).

---

## 2. Architecture spine (shared)

```text
Worker QThread (live asyncio | replay blocking)
    │  queue.put  XOR  sig_*.emit
    ▼
SourceManager._queue   (unbounded Queue)
    │
    ▼
MainWindow._gui_tick @16ms
    │  drain ≤1000
    │  snapshot clears updates/bbos in batch
    │  on_trade=None during book apply
    ▼
OrderBook → HeatmapWidget.push_snapshot
    │              │
    │              ├─ live: DensityEngine._draw_column + per-col AdaptiveNormalizer
    │              └─ rebuild: batch grid + reset ref + SciPy smooth + BOOKMAP LUT
    ▼
uint8 buffer → paint
```

R20 critical path fragment relevant here:

```text
(Z06 ∥ Z07) → … → Z05 → Z02 → … → Z01
```

---

## 3. Cross-theme dependency graph

```text
                    P2-18 SSL
                       │
P2-17 Live teardown ───┼─── P2-19 Replay teardown
         │             │            │
         └──────┬──────┴─────┬──────┘
                ▼            ▼
           P2-13 unbounded queue ◄── P2-20 dual path (latent double)
                │
           P2-14 drain 1000
                │
           P2-15 batch snapshot semantics
                │
           P2-16 on_trade callback
                │
                ▼
           OrderBook truth (Track A 01–06)
                │
           P2-11 normalizer live/rebuild
                │
           P2-12 LUT / docs
                ▼
           Z01 paint (Track C)
```

**Suggested Phase-3 execution order within 11–20:**

1. **P2-13 + P2-14** (measure queue) — ship-breaker  
2. **P2-17 + P2-19** (teardown) — parallel with 13  
3. **P2-18** (SSL) — small, parallel  
4. **P2-20** (architecture cleanup) — before anyone “simplifies” paths  
5. **P2-15 + P2-16** (gui_tick correctness)  
6. **P2-11 + P2-12** (visual engine) — after book/queue stable  

Do **not** hunt paint-only before 13–15–17–19 signoff (R20 rule).

---

## 4. Finding ID registry (prefixes)

| Theme | Prefix | Example |
|-------|--------|---------|
| 11 | `FIND-P211-XX` | FIND-P211-01 batch vs sequential ref |
| 12 | `FIND-P212-XX` | FIND-P212-01 dual LUT system |
| 13 | `FIND-P213-XX` | FIND-P213-01 unbounded Queue |
| 14 | `FIND-P214-XX` | FIND-P214-01 hard cap lag |
| 15 | `FIND-P215-XX` | FIND-P215-02 trades after snapshot |
| 16 | `FIND-P216-XX` | FIND-P216-01 missing finally |
| 17 | `FIND-P217-XX` | FIND-P217-01 wait(2000) orphan |
| 18 | `FIND-P218-XX` | FIND-P218-01 global ssl=False |
| 19 | `FIND-P219-XX` | FIND-P219-02 uncancellable list() |
| 20 | `FIND-P220-XX` | FIND-P220-02 dual-apply latent |

---

## 5. Severity prior rollup

| Sev | Themes | R20 anchors |
|-----|--------|-------------|
| **P0** | 13, 14, 17, 18, 19 (+15 if trade/snap wrong; +20 if dual fires) | P0-01, P0-05, P0-11 |
| **P1** | 11 (color jump), 15 (policy), 16 (stuck callback), 20 (dead path) | R07 H4/H5/H9, R10 H1 |
| **P2–P3** | 12 (docs/dead LUT), parts of 16/20 | R07 H15/H16 |

---

## 6. Shared fixtures & harness needs

| Asset | Used by |
|-------|---------|
| Unbounded queue metrics logger (`qsize`, RSS, processed/tick) | 13, 14, 17, 19, 22(later) |
| Synthetic Level2Snapshot/Update/Trade factories | 14, 15, 16, 20 |
| Mock QThread workers with controllable hang | 17, 19 |
| AdaptiveNormalizer column ladders | 11 |
| LUT golden `.npy` | 12 |
| Real lake `/Users/nazmi/data` (optional) | 13, 14, 19 |
| QSignalSpy + QCoreApplication | 20 |

---

## 7. Top concrete code anchors (quick index)

| Issue | File:lines |
|-------|------------|
| Unbounded queue | `ui/source_manager.py:81-82` |
| Drain cap 1000 | `ui/main_window.py:908-910` |
| Early return no drain | `ui/main_window.py:896-897` |
| Snapshot clears updates | `ui/main_window.py:914-917` |
| Apply order | `ui/main_window.py:937-944` |
| on_trade=None | `ui/main_window.py:934-947` |
| Live SSL patch | `data/crypcodile_live.py:100-108` |
| Live wait 2s | `data/crypcodile_live.py:253-260` |
| Live queue XOR signal | `data/crypcodile_live.py:179-196` |
| Replay wait 5s | `data/crypcodile_replay.py:723-735` |
| Replay emit XOR | `data/crypcodile_replay.py:513-530` |
| Replay auto-loop | `data/crypcodile_replay.py:539-541` |
| Live normalizer per col | `engine/density_engine.py:338-355` |
| Rebuild reset ref | `ui/heatmap_widget.py:606-608` |
| Rebuild batch update | `ui/heatmap_widget.py:834-845` |
| BOOKMAP LUT write | `engine/density_engine.py:376-382` |
| Stale docs LUT | `engine/color_system.py:1-4, 30-32, 162-164` |
| Dead data signal connects | `ui/source_manager.py:256-261, 304-307` |
| Toggle stop no drain | `ui/source_manager.py:456-460, 497-500` |

---

## 8. Phase-3 micro-task count

| Theme | Micro-tasks | Focus |
|-------|-------------|-------|
| 11 | 5 | Norm divergence tests + policy |
| 12 | 5 | LUT inventory + golden + docs |
| 13 | 5 | Growth model + backpressure design |
| 14 | 5 | Cap vs budget drain |
| 15 | 5 | Batch matrix C1–C9 |
| 16 | 5 | try/finally + notify=False API |
| 17 | 5 | Zombie repro + cancel shutdown |
| 18 | 5 | Remove global patch |
| 19 | 5 | Cancellable load + empty loop |
| 20 | 5 | XOR enforce + dead connect cleanup |
| **Total** | **50** | Executable hunts |

---

## 9. Fix sketch portfolio (package ideas)

| Package | Themes | Idea |
|---------|--------|------|
| **Q-Bound** | 13, 14, 22 | maxsize + budget drain + drain when not running |
| **Thread-Join** | 17, 19, 21 | supervised stop, no null-on-timeout, cancel tasks |
| **SSL-Scope** | 18 | per-transport ssl, default verify |
| **Single-Plane** | 20, 16 | one data path; explicit notify flags |
| **Norm-OnePipe** | 11, 12 | shared normalize+LUT; honest docs |
| **Batch-Truth** | 15 | chronological apply or clear trades with snapshot |

---

## 10. Handoff notes for Phase-3 agents

1. Read the matching `P2-NN_*.md` fully before coding tests.  
2. Cite sibling hyp IDs (R07 H9, R16 H3, …) in FIND bodies.  
3. Prefer **unit/harness** over live exchange for 13–16, 20; use live carefully for 17–18.  
4. Do not “fix” paint brightness until 11’s policy decision (A/B/C) is recorded.  
5. Themes **21–24** (switch races, stale queue, REST GUI, CCXT stall) continue Track B — coordinate queue generation tokens with 13/17/19.  
6. Absolute plan paths:

```text
/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/P2-11_normalizer_live_vs_rebuild.md
/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/P2-12_color_lut_gamma_stale_docs.md
/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/P2-13_unbounded_queue_growth.md
/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/P2-14_drain_limit_1000_starvation.md
/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/P2-15_snapshot_clears_updates_batching.md
/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/P2-16_callback_disable_on_trade_none.md
/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/P2-17_live_asyncio_quit_wait_teardown.md
/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/P2-18_global_ssl_monkeypatch.md
/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/P2-19_replay_blocking_slot_vs_qthread_quit.md
/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/P2-20_dual_emit_path_queue_vs_signals.md
/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/TRACK_B_PART1_SUMMARY.md
```

---

## 11. Exit criteria for this planning batch

- [x] Each theme has Scope, Threat model, Probes with file:line, Pass/fail, Fixtures, 3–5 micro-tasks, FIND prefix, Fix sketch, Dependencies, Severity priors  
- [x] Line anchors verified against current tree (2026-07-13)  
- [x] Cross-links to R05/R06/R07/R10/R16/R20  
- [x] Summary for coordinators of waves W1 (queue/threads) and W2 (density/norm)

**Planning batch P2-11…20 complete.** Phase-3 may assign hunters per micro-task without further research churn unless code moves invalidate line anchors.
