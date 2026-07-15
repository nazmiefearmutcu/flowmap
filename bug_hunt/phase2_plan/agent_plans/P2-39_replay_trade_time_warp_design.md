# P2-39 — Replay trade time-warp design

| Field | Value |
|-------|-------|
| **Agent** | P2-39 |
| **Theme** | Replay trade time-warp design review |
| **Zones** | Z09 |
| **Sibling hyps** | R05 H1, H6, H9, H10; R20 P0-02 |
| **Severity prior** | **P0** data integrity (causality destroyed) |
| **Primary files** | `/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py` ~290–390, emission loop sleep; `source_manager` time range |

---

## 1. Scope & linked zones/sibling hyps

### In scope
Dual timeline design:

1. Books loaded for `[start_ns, end_ns]` (UI/discovery range).
2. Trades loaded for **global** `[trade_min, trade_max]` = MIN/MAX(local_ts) over **entire** trade table for symbol.
3. Linear remap:
   ```text
   scale = book_span / trade_span
   mapped_ts = start_ns + (trade_ts - t_min_actual) * scale
   ```
4. Liquidations included in trade channel fetch.
5. Materialize all trades in RAM (H6 coupling).
6. Sleep/progress use **mapped** timestamps → progress bar “looks fine”.
7. Cap sleep 5s on gaps (H9) — secondary time distortion.
8. Auto-loop reloads and re-warps forever.

### Out of scope
- Price rewrite BBO snap (P2-40) — applies **after** warp; both compound
- Thread quit (P2-19)
- SQL injection (P2-41)

---

## 2. Threat model

| Property | Honest replay | Current design |
|----------|---------------|----------------|
| Trade↔book causality | trade at T sees book at T | trade from day 1 appears beside book day 7 |
| Density of trades | real burst structure | stretched/compressed uniformly |
| Session length | book window | trades from full history squeezed into window |
| Debugging jumps | real | synthetic timing |
| Memory | window-sized | **all trades ever** for symbol |

**Intent suspicion (R05):** workaround for misaligned series / demo aesthetics — **not** production market replay.

**Threat actors:** any multi-day lake; even same day if trade min/max ≠ selected book range (H8 discovery prefers book min).

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| S1 | SQL trade MIN/MAX vs book frm/to |
| S2 | MappedRecord.local_ts override |
| S3 | scale_factor when t_span=0 |
| S4 | liquidations in same warp |
| S5 | Comments/logs “Aligning” only for price not time |
| S6 | No feature flag to disable warp |

### 3.2 Unit — pure time map

| ID | trade_ts | book [0,100] trade span [0,1000] | mapped |
|----|----------|----------------------------------|--------|
| U1 | 0 | | 0 |
| U2 | 1000 | | 100 |
| U3 | 500 | | 50 |
| U4 | t_span=0 all same ts | | start_ns (scale 1) |
| U5 | trade outside book original | still mapped inside |

Extract function under test by copy or refactor-for-test.

### 3.3 Differential — causality

| ID | Steps | Assert |
|----|-------|--------|
| C1 | Book only in hour 2; trades only in hour 1 | warped trades appear in hour 2 columns |
| C2 | Known trade at book event T with matching price | after warp may not co-locate with same book state |
| C3 | Disable warp (patch frm/to = book range) | causality restored |
| C4 | Count trades loaded vs in-window trades | global ≫ window |

### 3.4 Dynamic / product

| ID | Probe |
|----|-------|
| D1 | Log first/last raw trade ts vs mapped |
| D2 | Progress 0→1 smoothness with warped trades |
| D3 | Memory of raw_trades list size |
| D4 | Auto-loop second pass identical warp |
| D5 | Speed slider interaction (time base is mapped) |

### 3.5 Design review questions (must answer in findings)

1. Is warp intentional product feature or bug?
2. If intentional: is it labeled in UI?
3. Can power users disable?
4. Does Bookmap-style “MBO replay” require 1:1 time?

---

## 4. Pass/fail criteria

| Criterion | Pass | Fail |
|-----------|------|------|
| Default mode | Trades use **same** `[start_ns,end_ns]` as books | Global min/max warp |
| Optional demo mode | Explicit flag “stretch trades to window” | Always on silent |
| Causality sample | Trade timestamp within ε of original relative book | Arbitrary remap |
| Memory | Trade load bounded by window | Full table |
| Disclosure | UI/log states timeline policy | Silent |
| Tests | Unit map + integration flag | none |

---

## 5. Fixtures needed

| Fixture | Description |
|---------|-------------|
| Two-hour book-only + earlier trades hive | C1 |
| Aligned same-window trades+books | baseline identity warp (scale≈1) |
| Single-timestamp trades | U4 |
| Metrics dump harness | raw vs mapped CSV |

---

## 6. Phase-3 agent micro-tasks

### Hunt A — Confirm always-on warp
Code path coverage; no flag. **FIND-P239-01**

### Hunt B — Causality destruction demo
C1 synthetic lake; screenshots + ts table. **FIND-P239-02**

### Hunt C — Volume of extra trades
Count ratio global/window on real data. **FIND-P239-03**

### Hunt D — Interaction with sleep cap
Long quiet in mapped space. **FIND-P239-04**

### Hunt E — Design ADR
Write decision: remove / flag / rename feature. **FIND-P239-05**

---

## 7. Expected finding IDs

Format: **`FIND-P239-XX`**

| ID | Title | Sev |
|----|-------|-----|
| FIND-P239-01 | Global trade range time-warp always on | **P0** |
| FIND-P239-02 | Causality break demo | **P0** |
| FIND-P239-03 | Full-history trade materialize | **P0** mem (H6) |
| FIND-P239-04 | Liquidations warped too | P1 |
| FIND-P239-05 | Progress bar masks fiction | P1 |
| FIND-P239-06 | No disable flag / UI label | P1 |
| FIND-P239-07 | scale when span 0 edge | P2 |
| FIND-P239-08 | Sleep cap 5s secondary warp | P2 |

---

## 8. Fix strategy sketch

1. **Default fix:** `frm=start_ns, to=end_ns` for trades and liquidations (same as books).
2. Optional `timeline_mode=stretch_trades` behind advanced setting for demo.
3. Stream merge by local_ts without full materialize when possible.
4. Log clearly when stretch mode active.
5. Regression test: trade.local_ts ∈ [start,end] after dispatch (raw path).
6. Coordinate with P2-40: after time fix, re-evaluate need for price rewrite.

---

## 9. Dependencies

| Theme | Relation |
|-------|----------|
| **P2-40** price rewrite | Compounds distortion; review **after or with** |
| P2-13/19 | Memory + lifecycle of materialize |
| P2-04/38 | Empty books still warp trades |
| P2-36 | Hist path does **not** time-warp (different bug class) |
| P2-42 | Converter after MappedRecord |

---

## 10. Severity priors from phase1

| Source | Prior |
|--------|-------|
| R05 H1 | **HIGH** |
| R20 P0-02 | **P0** ship-breaker #2 |
| R20 never-drop list includes 39 | critical |

**Verdict:** Design review should recommend **removal from default path** with evidence pack; not a micro-optimization.
