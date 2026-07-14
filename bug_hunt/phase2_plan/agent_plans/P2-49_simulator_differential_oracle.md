# P2-49 — Simulator Differential Oracle

| Field | Value |
|-------|-------|
| **Agent** | P2-49 |
| **Theme n** | 49 |
| **Track** | E — Harness |
| **Zones** | **Z18** |
| **Siblings** | R04, R14, R20 Z18, capacity “oracle/harness only” |
| **Severity prior** | Harness **P1** (enabler); sim product bugs **P2** (not primary UI path) |
| **Focus** | MarketSimulator as controlled oracle for OrderBook / density / GUI |

---

## 1. Scope & linked zones / sibling hyps

### Files
- `/Users/nazmi/flowmap/flowmap/data/simulator.py` (~782 LOC)
- `/Users/nazmi/flowmap/flowmap/data/manager.py` — `simulator` source
- `/Users/nazmi/flowmap/flowmap/data/base.py` — DataProvider contract
- **UI gap:** `DataSource` enum LIVE/REPLAY only — sim **not** in SourceManager (R18 UX-19)

### R04 key points
- Full L2 + trades + icebergs synthetic
- Docstring claims vs code mismatches
- Not wired to primary UI path
- High **oracle** value for differential tests

### Oracle consumers (other themes)

| Theme | Use sim for |
|-------|-------------|
| P2-01–02, 06 | OrderBook apply |
| P2-07–11 | Density / norm |
| P2-13–15 | Queue / drain under load |
| P2-45 | Iceberg F+/F− labeled truth |
| P2-50 | Optional offline CUA without network |

---

## 2. Threat model (harness)

| Risk | Mitigation |
|------|------------|
| Oracle wrong → false confidence | Cross-check invariants (BBO uncrossed, sum sizes) |
| Sim not representative of exchange | Label tests “sim-class” vs “lake-class” |
| UI can’t select sim | Programmatic inject for tests; optional dev flag |
| Docstring lies in sim | FIND-P249 doc bugs; don’t trust docs for oracle |

---

## 3. Concrete probes

### 3.1 Capability inventory

| Feature | API | Deterministic seed? |
|---------|-----|---------------------|
| Tick interval | ctor | |
| base_price, tick_size | ctor | |
| depth_levels | ctor | |
| Iceberg inject | `_inject_iceberg` | private — may need test hook |
| Momentum / walls | internal | |
| connect/disconnect | public | |
| reset | public mid-stream | |

### 3.2 Determinism harness

```python
random.seed(0)  # if sim uses random
s1 = MarketSimulator(...); events1 = capture_n(s1, 100)
random.seed(0)
s2 = MarketSimulator(...); events2 = capture_n(s2, 100)
assert events1 == events2
```

Fail → FIND non-determinism (still usable with recorded fixtures).

### 3.3 Differential pipelines

```text
Sim events
  ├─► OrderBook alone → assert invariants
  ├─► OrderBook → DensityEngine → buffer hash golden
  └─► MainWindow queue inject → GUI tick → screenshot hash
```

### 3.4 Invariant suite (always on)

- best_bid < best_ask (or equal policy documented)
- sizes ≥ 0
- snapshot replace clears stale levels (coord P2-01)
- CVD finite after first trade (P2-06)
- No NaN in density buffer

### 3.5 Wire options for Phase 3 (don’t all implement)

A. Unit-only (no UI)  
B. `DataManager.set_source("simulator")` behind test helper  
C. Dev env `FLOWMAP_SOURCE=simulator` (Phase 4)

### 3.6 R14 script reuse

Map `verify_v2.py`, `verify_v4.py`, `diagnose_*.py` → formal pytest with pass/fail.

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| ORC-P1 | Seeded event capture reproducible OR fixtures checked in | Random only |
| ORC-P2 | ≥1 golden density buffer test in CI | No automated oracle |
| ORC-P3 | Invariant suite green on 1000 ticks | Violations |
| ORC-P4 | Iceberg ground-truth export for P2-45 | No labels |
| ORC-P5 | Document sim ≠ exchange | Overclaim |

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| `fixtures/sim_seed0_100.json` | Recorded events |
| Golden numpy buffer `.npy` | Density |
| Invariant checker module | Shared |
| Optional QOffscreenSurface GUI | Widget tests |

---

## 6. Phase-3 micro-tasks

| Hunt | Work |
|------|------|
| **H-49A** | Sim API map + docstring vs code FINDs (R04) |
| **H-49B** | Determinism + event recorder |
| **H-49C** | OrderBook invariant battery on sim stream |
| **H-49D** | Density golden + hook for P2-07/11 |
| **H-49E** | Iceberg label export for P2-45 |
| **H-49F** | Promote verify_v2/v4 asserts into pytest |

---

## 7. Expected finding IDs — `FIND-P249-XX`

| ID | Sev | Title |
|----|-----|-------|
| FIND-P249-01 | P2 | Docstring feature mismatch vs simulator code |
| FIND-P249-02 | P1 | Non-deterministic without seed control |
| FIND-P249-03 | P2 | UI cannot select simulator (README lie UX-19) |
| FIND-P249-04 | P2 | DataManager vs SourceManager dual architecture |
| FIND-P249-05 | P2 | reset() mid-stream timer quirks |
| FIND-P249-06 | P3 | Multi-symbol subscribe decorative only |
| FIND-P249-07 | P1 meta | Missing CI oracle (harness gap) |

---

## 8. Fix strategy sketch

1. Add `seed` param; gate all `random` calls.
2. Public `export_truth()` for icebergs/walls.
3. `tests/oracles/sim_pipeline.py` shared by tracks A/C.
4. Optional SourceManager `SIMULATOR` behind env for CUA offline.
5. Align docstring with code or fix code to match docs.

---

## 9. Dependencies

**Provides for:** P2-01–15, 26–32, 45, 50 offline.  
**Depends on:** none to start inventory.  
**Wave:** W4 harness but **bootstrap early** in W1 for shared fixtures.

---

## 10. Severity priors

R20 band LOW–MED for sim module risk; **harness value HIGH**. Treat missing oracle as **P1 process** finding; sim-only product bugs **P2**.
