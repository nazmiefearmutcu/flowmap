# P2-45 — Iceberg / LLT False Positive Design

| Field | Value |
|-------|-------|
| **Agent** | P2-45 |
| **Theme n** | 45 |
| **Track** | E — heuristics |
| **Zones** | **Z15** (Iceberg / LLT / stops) |
| **Siblings** | R08 H10, R11 (overlays), R18 INDICATORS/docks, simulator icebergs R04 |
| **Severity prior** | **P1–P2** (F+ noise degrades trust; not data-plane P0) |
| **Focus** | F+/F− heuristics for iceberg, LLT, stops trackers |

---

## 1. Scope & linked zones / sibling hyps

### Primary code
- `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py` — `_iceberg_accum_data`, `_iceberg_markers`, `iceberg_detected`, LLT flags, stop flags
- Main window LLT dock rebuild from book levels ≥ threshold
- INDICATORS: LLT Threshold, Iceberg Tracker, Stops Tracker, Stops Threshold
- Simulator: `/Users/nazmi/flowmap/flowmap/data/simulator.py` — `_inject_iceberg`, `_apply_iceberg` (ground truth for sim-only F-rate)

### What “iceberg” means in this product
Not exchange-native iceberg API — **heuristic**: volume accumulation at a price over time, then emit marker/signal. R08 H10 flags F+ risk.

### LLT
Large Lot Tracker: levels (or trades?) ≥ threshold — dock table rebuilt each GUI tick (max 50 rows). Threshold symbol-heuristic (SOL 5000, ETH 250, BTC 15).

### Stops
`stops_enabled` + `stop_threshold` — audit detection logic vs intentional.

---

## 2. Threat model

| Failure | Impact |
|---------|--------|
| F+ iceberg on every refresh of large resting order | Dock spam, trader noise |
| F− when real refresh pattern exists | Missed signal (if users trust feature) |
| LLT threshold wrong for symbol after switch | Empty or flooded dock |
| Min Size filter dock vs sidebar desync (UX-07) | Operator confuses filter |
| Iceberg min filter only on insert | Changing filter doesn’t purge rows |
| Unbounded `_iceberg_markers` / accum dict | Mem (coord Z02/Z04) |
| Heuristic uses wall clock vs exchange ts | Wrong timing under replay warp (P2-39) |

---

## 3. Concrete probes

### 3.1 Static — algorithm extraction

Document algorithm in plan update / findings:

```text
For each level push:
  accum[price] = (volume, last_ts)
  if condition_X: emit iceberg_detected, append marker
```

Extract exact condition_X, decay/reset of accum, side handling, price quantization.

### 3.2 Synthetic F+ suite

| Scenario | Expect |
|----------|--------|
| Static large bid never trades | No iceberg OR documented “resting wall” behavior |
| Periodic size refresh same price (sim iceberg) | Detect within N ticks |
| Random noise book | F+ rate < threshold (e.g. <1/min) |
| Flash crash wipe | Markers cleared or marked stale |
| Threshold extreme 1 vs 50000 | Monotonic sensitivity |

### 3.3 Simulator oracle (with P2-49)

Simulator **knows** injected icebergs (`_iceberg_orders`).  
Compare detected set vs true set → precision/recall.

### 3.4 LLT

1. Seed book with levels {threshold-1, threshold, threshold+1}.
2. Assert dock rows only ≥ threshold.
3. Symbol switch SOL→BTC: threshold jumps; rows re-filter.

### 3.5 Stops

Mirror iceberg: extract rule, synthetic true/false cases.

### 3.6 GUI

CUA-14, CUA-15, CUA-16, CUA-17 (dock visibility).

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| HEU-P1 | Documented precision/recall on sim oracle | Unknown F+ rate |
| HEU-P2 | LLT row set == levels ≥ thresh (cap 50) | Missing/extra rows |
| HEU-P3 | Disable toggles stop all new emits | Signals continue |
| HEU-P4 | Accum structures bounded or aged out | Unbounded growth |
| HEU-P5 | Filter change policy documented | Stale rows violate user expectation silently |

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| Simulator with forced iceberg inject API | Oracle |
| Scripted Level2 sequence JSON | Pure unit F+/F− |
| Symbol threshold table | SOL/ETH/BTC |
| Max 100 iceberg dock / 50 LLT caps | Stress |

---

## 6. Phase-3 micro-tasks

| Hunt | Work |
|------|------|
| **H-45A** | Reverse-engineer iceberg + stops algorithms; write pseudocode finding |
| **H-45B** | Sim precision/recall experiment + FIND for F+ rate |
| **H-45C** | LLT correctness + symbol threshold matrix |
| **H-45D** | Cap/leak markers & accum dict under long run |
| **H-45E** | UX desync min-size dual spinners (coord R18 UX-07) |

---

## 7. Expected finding IDs — `FIND-P245-XX`

| ID | Sev | Title |
|----|-----|-------|
| FIND-P245-01 | P2 | Iceberg F+ on static walls |
| FIND-P245-02 | P2 | Iceberg F− on true refresh pattern |
| FIND-P245-03 | P1 | Unbounded iceberg accum/markers |
| FIND-P245-04 | P2 | LLT threshold symbol heuristic wrong |
| FIND-P245-05 | P2 | Stops false positive rule |
| FIND-P245-06 | P2 | Dock filter insert-only (UX-17) |
| FIND-P245-07 | P2 | LLT dual spinner desync (UX-07) |
| FIND-P245-08 | P2 | Replay ts vs wall clock breaks heuristic |

---

## 8. Fix strategy sketch

1. Publish heuristic formula in UI tooltip / Features dialog (if wired).
2. Age-out accum with exchange timestamps.
3. Hysteresis / cooldown per price to cut F+.
4. Bound markers (ring buffer).
5. Bidirectional spinner sync.
6. Optional: disable icebergs by default until calibrated.

---

## 9. Dependencies

| Theme | Link |
|-------|------|
| P2-49 | Sim oracle |
| P2-39 | Time warp breaks ts heuristics |
| P2-32 | Bubbles/pulse side bias may co-paint |
| P2-50 | CUA docks |
| P2-16 | Callback wrap if plugins touch same signals |

---

## 10. Severity priors

R08 H10 → **P1–P2**. Memory unbounded → elevates **P1**. Pure UX filter desync → **P2**.
