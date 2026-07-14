# Phase 3 Findings Registry

Canonical per-finding reports: `bug_hunt/phase3_execution/findings/FIND-*.md`  
**Rule:** append new rows; do not delete other agents’ entries. Full detail always lives in the FIND file.

---

## Wave1 EMBED / PACKAGING (P2-35..38, 42, 46, 47, 48)

| ID | Sev | Status | Title | Location | Plan | Agent |
|----|-----|--------|-------|----------|------|-------|
| FIND-P235-01 | P0 | CONFIRMED | Hardcoded `/Users/nazmi/flowmap` sys.path | flowmap_window.py:7 | P2-35 | static |
| FIND-P235-04 | P1 | CONFIRMED | insert(0) shadows site-packages flowmap | flowmap_window.py:6-9 | P2-35 | W1-EMBED |
| FIND-P236-01 | P0 | CONFIRMED | Hist bw from 1×1 buffer before show | flowmap_window.py:176; density_engine.py:77 | P2-36 | W1-EMBED |
| FIND-P236-02 | P1 | CONFIRMED | Equal-time bins discard intra-bin L2 | flowmap_window.py:169-228 | P2-36 | W1-EMBED |
| FIND-P237-01 | P1 | CONFIRMED | Gap ≥ bw silent full hist wipe | flowmap_window.py:230-243 | P2-37 | W1-EMBED |
| FIND-P238-02 | P1 | CONFIRMED | Hist no snapshot/bootstrap gate | flowmap_window.py:119-145 | P2-38 | W1-EMBED |
| FIND-P238-03 | P1 | CONFIRMED | Empty catalog silent return | flowmap_window.py:147-148 | P2-38 | W1-EMBED |
| FIND-P242-01 | P1 | CONFIRMED | Dual converters embed ≠ `_dispatch_record` | dict_to_flowmap vs crypcodile_replay | P2-42 | W1-EMBED |
| FIND-P242-03 | P1 | CONFIRMED | Hist races 500ms auto-live | main_window.py:60-62 | P2-42 | W1-EMBED |
| FIND-P246-01 | P0 | LATENT | Plugin `exec_module` RCE if wired | plugins/loader.py:79-93 | P2-46 | W1-PACK |
| FIND-P246-03 | P1 | LATENT | Plugin sys.path + mutable OrderBook | loader.py + plugin_api.py | P2-46 | W1-PACK |
| FIND-P247-01 | P0 | CONFIRMED | Hardcoded data_dir `/Users/nazmi/data` | main_window/source_manager | P2-47 | static |
| FIND-P247-05 | P1 | CONFIRMED | No CLI/env data_dir override standalone | main.py + source_manager | P2-47 | W1-PACK |
| FIND-P248-01 | P0 | FIXED | `console=False` silent crash no log | FlowMap.spec (console=True) | P2-48 | W1-PACK |
| FIND-P248-02 | P1 | FIXED | UPX + empty hiddenimports + ver 0.0.0 | FlowMap.spec (upx=False, hiddenimports, 0.1.0) | P2-48 | W1-PACK |

**W1 new files this wave:** FIND-P235-04, P236-01/02, P237-01, P238-02/03, P242-01/03, P246-01/03, P247-05, P248-01/02 (12). Pre-existing siblings: P235-01, P247-01.

---

## Other phase-3 findings (index by file present)

| ID | Sev (best-effort) | Plan / area | File |
|----|-------------------|-------------|------|
| FIND-P206-01 | P0 | P2-06 CVD NaN | FIND-P206-01.md |
| FIND-P207-01..05 | P0–P2 | P2-07 mid-mask / max / decay | FIND-P207-*.md |
| FIND-P208-01 | P1 | P2-08 col_idx ghosts | FIND-P208-01.md |
| FIND-P209-01..02 | P0–P1 | P2-09 tick detect / symbol tpr | FIND-P209-*.md |
| FIND-P210-01 | P0 | P2-10 tick polyline | FIND-P210-01.md |
| FIND-P210-02 | P0 | P2-10 buffer Y scale | FIND-P210-02.md |
| FIND-P211-01..03 | P1–P2 | P2-11 normalizer live/rebuild | FIND-P211-*.md |
| FIND-P212-01..02 | P2–P3 | P2-12 color LUT docs | FIND-P212-*.md |
| FIND-P213-01 | P0 | P2-13 unbounded queue | FIND-P213-01.md |
| FIND-P213-02 | P1 | P2-13 delta fan-out | FIND-P213-02.md |
| FIND-P214-01 | P0 | P2-14 drain 1000 | FIND-P214-01.md |
| FIND-P214-02 | P1 | P2-14 FIFO starve | FIND-P214-02.md |
| FIND-P215-01 | P1 | P2-15 snap clears | FIND-P215-01.md |
| FIND-P215-02 | P1 | P2-15 batch order | FIND-P215-02.md |
| FIND-P216-01 | — | P2-16 callbacks | FIND-P216-01.md |
| FIND-P216-02 | — | P2-16 | FIND-P216-02.md |
| FIND-P217-01 | P0 | P2-17 live teardown | FIND-P217-01.md |
| FIND-P217-02 | P1 | P2-17 quit | FIND-P217-02.md |
| FIND-P217-05 | P0 | P2-17 no reconnect **FIXED** | FIND-P217-05.md |
| FIND-P217-07 | P1 | P2-17 live channels | FIND-P217-07.md |
| FIND-P218-01 | P0 | P2-18 SSL | FIND-P218-01.md |
| FIND-P218-02 | — | P2-18 | FIND-P218-02.md |
| FIND-P219-01 | P1 | P2-19 replay block | FIND-P219-01.md |
| FIND-P219-02 | P1 | P2-19 empty loop | FIND-P219-02.md |
| FIND-P219-03 | P0 | P2-19 CPU spin | FIND-P219-03.md |
| FIND-P220-01 | P1 | P2-20 dual emit | FIND-P220-01.md |
| FIND-P221-01 | — | P2-21 source switch | FIND-P221-01.md |
| FIND-P222-01 | P1 | P2-22 stale queue | FIND-P222-01.md |
| FIND-P222-02 | P1 | P2-22 session epoch | FIND-P222-02.md |
| FIND-P223-01 | P1 | P2-23 REST GUI | FIND-P223-01.md |
| FIND-P223-05 | — | P2-23 | FIND-P223-05.md |
| FIND-P224-01 | P0 | P2-24 CCXT stall (fixed?) | FIND-P224-01.md |
| FIND-P224-04 | P1 | P2-24 dual BBO | FIND-P224-04.md |
| FIND-P225-01 | P2 | P2-25 OpenGL | FIND-P225-01.md |
| FIND-P226-01 | — | P2-26 rebuild | FIND-P226-01.md |
| FIND-P226-02 | P2 | P2-26 view_changed | FIND-P226-02.md |
| FIND-P227-01 | P2 | P2-27 throttle | FIND-P227-01.md |
| FIND-P228-01 | P1 | P2-28 QImage buffer | FIND-P228-01.md |
| FIND-P229-01 | — | P2-29 resize | FIND-P229-01.md |
| FIND-P229-02 | P2 | P2-29 needs_rebuild | FIND-P229-02.md |
| FIND-P230-01 | P2 | P2-30 trade percentile | FIND-P230-01.md |
| FIND-P232-01 | — | P2-32 bubbles | FIND-P232-01.md |
| FIND-P232-02 | — | P2-32 | FIND-P232-02.md |
| FIND-P232-03 | — | P2-32 | FIND-P232-03.md |
| FIND-P233-01 | P1 | P2-33 DOM | FIND-P233-01.md |
| FIND-P233-02 | P2 | P2-33 wheel | FIND-P233-02.md |
| FIND-P234-01 | — | P2-34 VP row | FIND-P234-01.md |
| FIND-P239-01 | P0 | P2-39 time-warp | FIND-P239-01.md |
| FIND-P239-03 | P0 | P2-39 OOM materialize | FIND-P239-03.md |
| FIND-P239-08 | — | P2-39 | FIND-P239-08.md |
| FIND-P240-01 | — | P2-40 price rewrite | FIND-P240-01.md |
| FIND-P240-02 | — | P2-40 | FIND-P240-02.md |
| FIND-P240-03 | — | P2-40 | FIND-P240-03.md |
| FIND-P240-09 | P1 | P2-40 bootstrap pollute | FIND-P240-09.md |
| FIND-P241-01 | P1 | P2-41 SQL f-string | FIND-P241-01.md |
| FIND-P243-01 | P1 | P2-43 F key follow | FIND-P243-01.md |
| FIND-P243-02 | P2 | P2-43 reset_view scroll | FIND-P243-02.md |
| FIND-P244-01 | P1 FIXED | P2-44 wheel/README | FIND-P244-01.md |
| FIND-P244-02 | P1 | P2-44 dual +/- keys | FIND-P244-02.md |
| FIND-ERR-01..08 | mix | error handling wave | FIND-ERR-*.md |
| FIND-NUM-01..08 | mix | numeric edge wave | FIND-NUM-*.md |
| FIND-SEC-01..08 | mix | secondary correctness | FIND-SEC-*.md |

---

## Severity snapshot (W1 EMBED/PACK only)

| Sev | Count | IDs |
|-----|-------|-----|
| P0 | 5 | P235-01, P236-01, P246-01 (latent), P247-01, P248-01 |
| P1 | 10 | P235-04, P236-02, P237-01, P238-02/03, P242-01/03, P246-03 (latent), P247-05, P248-02 |

## Top ship blockers (EMBED/PACK)

1. **P236-01** — hist compress to 1 column (bw=1 pre-show)  
2. **P247-01 / P235-01** — machine paths  
3. **P248-01** — windowed silent death  
4. **P237-01** — stale lake wipe after building hist  
5. **P246-01** — do not wire plugins without model B  

---

## Wave1 DENSITY / TICK (P2-07..12)

| ID | Sev | Status | Title | Location | Plan | Agent |
|----|-----|--------|-------|----------|------|-------|
| FIND-P207-01 | P0 | CONFIRMED | Mid-mask drops opposite-side liquidity | density_engine.py:362-374 | P2-07 | W1-DENSITY |
| FIND-P207-02 | P0 | CONFIRMED | maximum.at understates multi-tick rows | density_engine.py:305-315 | P2-07 | W1-DENSITY |
| FIND-P207-03 | P2 | CONFIRMED | Live `>` vs rebuild `>=` no-mid side | density_engine.py:369 vs heatmap:855 | P2-07 | W1-DENSITY |
| FIND-P207-04 | P2 | CONFIRMED | BBO row overwrite erases TOB density | density_engine.py:384-394 | P2-07 | W1-DENSITY |
| FIND-P207-05 | P1 | FIXED | Decay/density accumulation dead (docs+UI lie) | density_engine.py; main_window decay disabled | P2-07 | W1-DENSITY |
| FIND-P208-01 | P1 | CONFIRMED | col_idx path no clear-column (ghosts) | density_engine.py:172-176 | P2-08 | W1-DENSITY |
| FIND-P209-01 | P0 | FIXED | One-shot tick lock; dead refine; detect_tick ignored | density_engine.py:119-131 | P2-09 | W1-DENSITY |
| FIND-P209-02 | P1 | CONFIRMED | Symbol ticks_per_row/ref substring heuristics | source_manager.py:386-403 | P2-09 | W1-DENSITY |
| FIND-P210-01 | P0 | CONFIRMED | History polyline tick_size not render_tick_size | heatmap_widget.py:1408,1418 | P2-10 | W1-DENSITY |
| FIND-P210-02 | P0 | CONFIRMED | History Y full-buffer scale vs center-slice blit | heatmap_widget.py:1406-1420 vs 1177-1183 | P2-10 | W1-DENSITY |
| FIND-P211-01 | P1 | CONFIRMED | Live sequential norm ≠ rebuild batch p98 | density_engine + heatmap rebuild | P2-11 | W1-DENSITY |
| FIND-P211-02 | P1 | CONFIRMED | Rebuild resets global_ref; frozen live scale | heatmap_widget.py:606-608 | P2-11 | W1-DENSITY |
| FIND-P211-03 | P2 | CONFIRMED | Normalizer docs fixed-linear; code adaptive **2.5 | normalizer.py:1-51 | P2-11 | W1-DENSITY |
| FIND-P212-01 | P2 | CONFIRMED | Dual LUT: BOOKMAP live; build_lut/apply dead | color_system.py | P2-12 | W1-DENSITY |
| FIND-P212-02 | P3 | CONFIRMED | Alpha t^1.5 / gamma docs describe unused path | color_system.py:1-32 | P2-12 | W1-DENSITY |

**W1 DENSITY new/updated:** 15 FIND files (P207×5, P208×1, P209×2, P210×2 deepen+new, P211×3, P212×2).  
**Siblings:** FIND-NUM-06 (tick lock), FIND-NUM-03 (symbol tpr) — cross-linked from P209.

### Severity snapshot (W1 DENSITY/TICK)

| Sev | Count | IDs |
|-----|-------|-----|
| P0 | 5 | P207-01, P207-02, P209-01, P210-01, P210-02 |
| P1 | 5 | P207-05, P208-01, P209-02, P211-01, P211-02 |
| P2 | 4 | P207-03, P207-04, P211-03, P212-01 |
| P3 | 1 | P212-02 |

### Top ship blockers (DENSITY/TICK)

1. **P210-01 + P210-02** — mid/BBO history lines wrong tick unit + wrong Y scale (compound)  
2. **P207-01** — mid-mask drops opposite-side walls  
3. **P207-02** — max-not-sum understates BTC tpr=100 walls  
4. **P209-01** — sparse first book permanent wrong tick grid  
5. **P207-05** — Decay slider dead; docs/UI lie  

---

## Wave1 HISTORICAL gui_diag (R15 H-01 / H-02)

| ID | Sev | Status | Title | Location | Plan | Agent |
|----|-----|--------|-------|----------|------|-------|
| FIND-HIST-01 | P0 | CONFIRMED | H-01 BBO/center/visible desync still open | density_engine.py:182-248; heatmap_widget.py | R15 H-01 | HIST |
| FIND-HIST-02 | P0 | CONFIRMED | H-02 near-empty heatmap still open | density_engine.py:300-315; gui_diag.log | R15 H-02 | HIST |
| FIND-HIST-03 | P1 | CONFIRMED | smooth_deadband row-tick thresholds lag on BTC tpr | density_engine.py:215-233; config.py:22-24 | R15 H-01/H-04 | HIST |
| FIND-HIST-04 | P1 | CONFIRMED | auto_follow=False freezes engine push/center | heatmap_widget.py:345-405 | R15 H-01 | HIST |
| FIND-HIST-05 | P1 | CONFIRMED | tpr change scale-poisons center; no H-01 regression test | source_manager.py:391-411 | R15 H-01 | HIST |

**Artifact:** `/Users/nazmi/flowmap/gui_diag.log` — mid≈65656, center≈65700.58, vis 65699.89–65701.27, auto_follow=True, non_bg_vis=38.  
**Verdict:** H-01 and H-02 **still present** in current code paths (not historical-only).  
**Cross-links:** FIND-P243-01 (F flag-only), FIND-P209-01/02 (tick/tpr), FIND-P207-02 (max-not-sum sparsity).  

---

## Wave1 BOOK / order_book (P2-01,02,03,04,06)

| ID | Sev | Status | Title | Location | Plan | Agent |
|----|-----|--------|-------|----------|------|-------|
| FIND-P201-01 | P0 | CONFIRMED | Trade+L2 double absorption | order_book.py:166-205; main_window.py:937-944 | P2-01 | W1-BOOK |
| FIND-P201-02 | P1 | CONFIRMED | Snapshot does not reset _max_* peaks | order_book.py:64-82 | P2-01 | W1-BOOK |
| FIND-P201-05 | P2 | CONFIRMED | Absorption epsilon 5e-5 miss | order_book.py:183-186 | P2-01 | W1-BOOK |
| FIND-P201-06 | P0 | REFUTED | Snapshot residual pre-snap levels | order_book.py:64-67 | P2-01 | W1-BOOK |
| FIND-P202-01 | P0 | REFUTED | Dual-prune wipes both sides | order_book.py:381-424 | P2-02 | W1-BOOK |
| FIND-P202-02 | P1 | CONFIRMED | apply_bbo zero-size TOB insert | order_book.py:136-151 | P2-02 | W1-BOOK |
| FIND-P202-03 | P1 | CONFIRMED | apply_bbo leaves crossed BBO | order_book.py:134-164 | P2-02 | W1-BOOK |
| FIND-P202-04 | P2 | CONFIRMED | Hard-coded ±15% prune vs UI zoom | order_book.py:454-467 | P2-02 | W1-BOOK |
| FIND-P202-05 | P2 | CONFIRMED | NaN price accepted into book | order_book.py:84-96 | P2-02 | W1-BOOK |
| FIND-P202-06 | P1 | CONFIRMED | TOB cross bid wipe → mid=0 | order_book.py:387-404 | P2-02 | W1-BOOK |
| FIND-P203-01 | P1 | CONFIRMED | BID trade CVD split book vs pulse | order_book/pulse/bubbles | P2-03 | W1-BOOK |
| FIND-P203-02 | P1 | CONFIRMED | ASK trade bubbles 0 + plugin ignore | bubbles.py; plugin_api.py | P2-03 | W1-BOOK |
| FIND-P203-03 | P2 | CONFIRMED | Unknown side defaults BUY | crypcodile_replay.py:76-83 | P2-03 | W1-BOOK |
| FIND-P203-04 | P1 | CONFIRMED | Level2Update BUY/SELL → asks | order_book.py:86 | P2-03 | W1-BOOK |
| FIND-P204-01 | P0 | CONFIRMED | Delta-only incomplete book | order_book.py:84; is_snapshot path | P2-04 | W1-BOOK |
| FIND-P204-02 | P0 | CONFIRMED | False is_snapshot leaves stale levels | crypcodile_replay.py:188-201 | P2-04 | W1-BOOK |
| FIND-P206-01 | P0 | REFUTED | get_volume_delta NaN (now 0.0) | order_book.py:349-357 | P2-06 | W1-BOOK |
| FIND-P206-02 | P0 | REFUTED | Status bar NaN CVD | main_window.py:996 | P2-06 | W1-BOOK |
| FIND-P206-04 | P1 | REFUTED | reset re-NaNs CVD | order_book reset+get_volume_delta | P2-06 | W1-BOOK |

**Probes:** `bug_hunt/phase3_execution/W1/probe_order_book_wave1.py` (venv), `W1/probe_order_book_wave1_stdlib.py` (stdlib mirror of current OrderBook), results `W1/probe_order_book_wave1_results.json`.

### Must-cover verdict

| Theme | Result |
|-------|--------|
| Crossed book wipe both sides | **REFUTED** (iterative uncross); residual **FIND-P202-06** mid=0 |
| NaN CVD | **REFUTED** (API returns 0.0); deepen P206-01/02/04 |
| Zero-size BBO | **CONFIRMED** FIND-P202-02 |
| Trade+L2 double absorb | **CONFIRMED** FIND-P201-01 |
| Side mapping | **CONFIRMED** FIND-P203-01/02/03/04 |

### Severity snapshot (W1 BOOK)

| Sev | CONFIRMED | REFUTED |
|-----|-----------|---------|
| P0 | P201-01, P204-01, P204-02 | P201-06, P202-01, P206-01, P206-02 |
| P1 | P201-02, P202-02/03/06, P203-01/02/04 | P206-04 |
| P2 | P201-05, P202-04/05, P203-03 | — |

### Top ship blockers (BOOK)

1. **FIND-P201-01** — double absorption understates walls every L2+trade tick  
2. **FIND-P204-01/02** — delta-only / mis-flagged snapshot books  
3. **FIND-P203-01** — dual CVD series / invisible BID bubbles  
4. **FIND-P202-02/03** — BBO zero-size + crossed cache  

