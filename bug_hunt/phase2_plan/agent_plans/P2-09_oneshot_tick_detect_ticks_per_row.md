# P2-09 — One-Shot Tick Detect + `ticks_per_row`

**Agent:** P2-09  
**Track:** A — Core correctness  
**Theme n:** 9  
**Finding ID prefix:** `FIND-P209-`  
**Severity prior:** **P0** (R17 H-T1, R07 H3, R20 P0-08 — permanent wrong vertical grid)

---

## 1. Scope & linked zones / sibling hyps

| Item | Value |
|------|-------|
| **Zones** | **Z03** |
| **Siblings** | R17 H-T1–T5,T7–T8; R07 §3; R20 P0-08 |
| **Primary** | `density_engine.py` tick detect :119–131; `render_tick_size` :534–535 |
| **Symbol defaults** | `source_manager.py` ~383–403 (`ticks_per_row` SOL=2, ETH=10, else BTC=100) |
| **Rebuild detect** | `heatmap_widget.py` rebuild ~620–632 |
| **Param** | `detect_tick_size` on push_snapshot **ignored** (R17 T2) |

### Non-scope

- History polyline using raw tick_size → **P2-10**  
- Mid-mask → P2-07  

---

## 2. Threat model

**Detection algorithm:**

```text
if not _tick_size_detected:
  min positive price diff among levels (round 6 dp)
  lock tick_size forever
else branch min-update: DEAD CODE
```

**Risks:**

1. **Sparse first book:** min gap = 5× true tick → permanent vertical collapse (fewer rows spanning price range).  
2. **Default 0.05** until first multi-level snap — wrong for BTC early frames.  
3. **`detect_tick_size=False` ignored** — callers cannot suppress/force.  
4. **`ticks_per_row` heuristic** fragile symbol strings (`MYETHUSDT` → ETH settings).  
5. **render_tick_size = tick_size * ticks_per_row** — compound error.  
6. **Rebuild** forces redetect from history min — may disagree with live lock if reset incomplete.  
7. **tick_size=0** → Inf rows (R17 H-N2) if mis-set.  
8. Float boundary `.5` row flips (R17 T8).

---

## 3. Concrete probes

### 3.1 Static

1. Prove dead else branch :127–131 structure.  
2. Prove `detect_tick_size` unused in body.  
3. Read source_manager symbol → ticks_per_row table fully.  
4. Default `tick_size` in engine `__init__`.

### 3.2 Unit — lock poison

| Probe | First levels prices | True tick | Assert locked |
|-------|---------------------|-----------|---------------|
| L1 | 100, 100.5, 101 (tick 0.5) | 0.5 | 0.5 |
| L2 | 100, 101 only (true tick 0.1, sparse) | 0.1 | **locks 1.0** → FIND |
| L3 | Second snap denser after L2 | 0.1 | **stays 1.0** (no refine) |
| L4 | Single level only | — | stays default 0.05 |
| L5 | detect_tick_size=False with multi level | — | **still locks** (ignored param) |
| L6 | tick forced 0 | — | no Inf if guarded (expect fail) |

### 3.3 Unit — ticks_per_row

| Probe | tick | tpr | render | row(mid+render) |
|-------|------|-----|--------|-----------------|
| R1 | 0.1 | 1 | 0.1 | neighbor 1 row |
| R2 | 0.1 | 10 | 1.0 | 10 ticks/row |
| R3 | 0.1 | 100 | 10 | BTC-like |

Assert `round(price/render_tick_size)` spacing.

### 3.4 Unit — symbol heuristic

| Symbol string | Expected tpr (actual code) |
|---------------|----------------------------|
| BTCUSDT | 100 |
| ETHUSDT | 10 |
| SOLUSDT | 2 |
| btcusdt | ? |
| BTC-USDT | ? |
| MYETHUSDT | ETH branch? |

### 3.5 Dynamic

1. Start replay on sparse open → measure tick_size in engine debugger.  
2. Change ticks_per_row via price zoom → rebuild; historical RGBA scale wrong until rebuild (doc).  
3. Compare exchange exchangeInfo tickSize vs detected.

### 3.6 Anchors

| Topic | Line |
|-------|------|
| One-shot detect | `density_engine.py:119–131` |
| Default tick | engine init ~72 |
| render_tick_size | `density_engine.py:534–535` |
| Rebuild detect | `heatmap_widget.py:620–632` |
| Symbol tpr | `source_manager.py:386–397` |

---

## 4. Pass / fail criteria

| | Criteria |
|--|----------|
| **PASS** | Tick from exchange meta or multi-sample min with redetect; sparse first book recovers; detect_tick_size honored; tpr from config not fragile substring only |
| **FAIL** | L2–L3 poison lock; param ignored; tpr wrong family; tick 0 crash |

---

## 5. Fixtures

| Fixture | |
|---------|--|
| Sparse vs dense level lists | same true tick 0.1 |
| Symbol string table | unit |
| Optional exchange tickSize JSON | oracle |

---

## 6. Phase-3 micro-tasks

### P2-09-H1 — Dead branch + ignored param static FIND  
FIND-P209-01/02 code facts.

### P2-09-H2 — Sparse lock L2–L3 unit  
FIND-P209-03 permanent wrong tick.

### P2-09-H3 — ticks_per_row × row mapping R1–R3  
Golden rows.

### P2-09-H4 — Symbol heuristic matrix  
FIND-P209-04 fragile match.

### P2-09-H5 — Rebuild vs live tick redetect divergence  
After reset/rebuild only.

---

## 7. Finding ID prefix

`FIND-P209-`

| ID | Issue |
|----|-------|
| FIND-P209-01 | Dead min-update branch |
| FIND-P209-02 | detect_tick_size ignored |
| FIND-P209-03 | Sparse first snap locks wrong tick |
| FIND-P209-04 | Symbol tpr heuristic |
| FIND-P209-05 | Default 0.05 early frames |
| FIND-P209-06 | tick_size=0 unsafe |

---

## 8. Fix strategy sketch

1. Prefer **exchange tick** from instrument metadata when available.  
2. Else running **min gap with sample count threshold** (N snapshots) before freeze.  
3. Honor `detect_tick_size`; allow force set API.  
4. `ticks_per_row` from user/config + safe defaults by asset class.  
5. Guard `render_tick_size > 0` on live path (rebuild already has fallback 0.05).  
6. Rebuild and live share one `TickGrid` object.

---

## 9. Dependencies

| | |
|--|--|
| **Depends** | P2-01 for multi-level books |
| **Hard blocks** | **P2-10** (polyline uses tick_size); P2-07 row mapping |
| **Never drop** | R20 must-keep theme 09 |

---

## 10. Severity priors

| Issue | Prior |
|-------|-------|
| One-shot wrong lock | **P0** |
| Ignored param / dead code | **P1** (enables bug) |
| Symbol tpr | **P1** |
| Default 0.05 | **P1** early |

**Wave:** W2 (Z03).
