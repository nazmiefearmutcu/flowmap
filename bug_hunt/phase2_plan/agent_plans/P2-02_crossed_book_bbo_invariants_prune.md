# P2-02 — Crossed Book / BBO Invariants / Prune Depth

**Agent:** P2-02  
**Track:** A — Core correctness  
**Theme n:** 2  
**Finding ID prefix:** `FIND-P202-`  
**Severity prior:** **P0** (crossed wipe can empty book → blank heatmap / zero mid)

---

## 1. Scope & linked zones / sibling hyps

| Item | Value |
|------|-------|
| **Zones** | **Z11** |
| **Siblings** | R03 §4.2, §4.3, H-R03-01, H-R03-03, H-R03-18, H-R03-19 |
| **Primary** | `core/order_book.py` `_recalc_bbo` :358–418, `_prune_book` :438–464, `apply_bbo` :134–163 |
| **Consumers** | mid for density mid-mask (P2-07), center ticks, DOM BBO |

### Linked hypotheses

| ID | Claim |
|----|-------|
| H-R03-01 | Full cross deletes **both** sides’ conflicting levels → can wipe book |
| H-R03-03 | `apply_bbo` inserts zero-size TOB; skips `_recalc_bbo` cross repair |
| H-R03-18 | ±15% mid prune drops deep levels needed for zoomed heatmap |
| H-R03-19 | Crossed state can persist after pure BBO path |

### Non-scope

- Snapshot/delta replace matrix → P2-01  
- Trade absorption epsilon → P2-05 / R17 H-F1  

---

## 2. Threat model

**Invariants claimed (R03 §2.5):**

1. After `_recalc_bbo` with both sides present: best_bid ≤ best_ask (strict prefer).  
2. No zero/negative sizes via snap/update — **broken by apply_bbo**.  
3. Best bid = max bid key; best ask = min ask key.  
4. Levels outside ±15% mid eventually dropped when both BBOs exist.

**Failure modes:**

| Mode | Mechanism | User impact |
|------|-----------|-------------|
| Full wipe on cross | Remove all `bid ≥ best_ask` AND all `ask ≤ best_bid` using **pre-prune** BBO | Empty book; mid=0; density mid-mask fallback |
| Asymmetric survival | Legitimate race (bid briefly ≥ ask) destroys good depth | Flash blank walls |
| Zero-size TOB | `apply_bbo` writes size 0 into SortedDict | Ghost levels; BBO size 0 |
| Locked cross via BBO | `apply_bbo` sets bests without full cross clear of opposite interior | bid≥ask in cache |
| Over-prune | ±15% fixed band independent of UI zoom | Deep liquidity invisible when panned |
| Count fallback | No mid → keep `depth*5` extremes only | With depth=3000, max_keep=15000 — memory; with small depth, drops |

---

## 3. Concrete probes

### 3.1 Static

1. Trace `_recalc_bbo` crossed block :378–408 line-by-line with example bid=100, ask=99, sizes>0.  
2. Compare `apply_bbo` stale prune (`p > bid`, `p < ask`) vs equal-cross (`bid == ask`).  
3. Confirm `mid_price` / `spread` return 0 when either side missing.  
4. Note MainWindow constructs `OrderBook(..., depth=3000)`.

### 3.2 Unit matrix

| Probe | Setup | Assert |
|-------|-------|--------|
| C1 | bid 100@1, ask 99@1 only → trigger `_recalc_bbo` | **Document:** both empty? (H-R03-01) |
| C2 | bid 100, 98; ask 99, 101 → cross repair | Which levels survive? Prefer keep non-crossing rest |
| C3 | bid 100, ask 100 (locked) | Same as ≥ |
| C4 | Deep book + transient cross only at TOB | Interior levels preserved |
| C5 | `apply_bbo(bid=100, bid_size=0, ask=101, ask_size=1)` | No zero bid key; best consistent |
| C6 | `apply_bbo` with bid > ask | Crossed cache vs after next update |
| C7 | mid=100, levels at 84.9 and 115.1 | Pruned after `_prune_book` |
| C8 | mid=100, levels at 85.0 and 115.0 | Boundary keep/drop exact |
| C9 | One-sided book (bids only) | mid None path; count prune only |
| C10 | Empty book | bests 0; no exception |
| C11 | NaN/Inf prices (fuzz) | No SortedDict corruption (expect fail → FIND) |

### 3.3 Dynamic

1. Replay through known crossed moments (exchange races) if available.  
2. Inject synthetic crossed BBO via queue into running MainWindow (debug) — observe heatmap blanking duration.  
3. Zoom heatmap fully out (`ticks_per_row` / deep view) — verify levels near ±15% edge present in `get_levels` vs exchange.

### 3.4 Anchors

| Topic | File:line |
|-------|-----------|
| Cross repair | `order_book.py:378–408` |
| apply_bbo | `order_book.py:134–163` |
| prune ±15% | `order_book.py:438–451` |
| count prune | `order_book.py:452–464` |
| mid_price | property near get_levels |

---

## 4. Pass / fail criteria

| | Criteria |
|--|----------|
| **PASS** | Documented invariant suite; either code preserves non-conflicting depth under C1–C4 **or** intentional wipe is product-documented + no empty-book crash path; apply_bbo never stores size≤0; prune band has tests |
| **FAIL** | C1 empties book when one side should survive under a chosen policy; zero-size levels persist; mid NaN/exceptions; prune deletes TOB incorrectly |

**Policy decision (for hunters):** Prefer exchange-mirror policy:  
- On cross: drop **bids ≥ ask** OR drop **asks ≤ bid**, not both using the same pre-state (standard: remove bids ≥ best_ask using **current** ask, then re-read, or keep last sequence). Phase-3 must pick and test one policy — flag current dual-delete as FIND if it wipes.

---

## 5. Fixtures

| Fixture | Purpose |
|---------|---------|
| `fixtures/books/full_cross.json` | Two-level full cross |
| `fixtures/books/tob_cross_deep.json` | Cross only at top, deep interior |
| `fixtures/books/locked_market.json` | bid == ask |
| `fixtures/books/wide_depth_15pct.json` | Levels at 0.84×mid … 1.16×mid |

---

## 6. Phase-3 micro-tasks

### P2-02-H1 — Crossed wipe characterization  
Prove C1–C4 with golden expectations; file FIND-P202-01 if dual-delete empties.

### P2-02-H2 — apply_bbo zero-size & skip cross  
C5–C6; FIND-P202-02 if zero size stored.

### P2-02-H3 — Prune band vs depth parameter  
C7–C9; measure impact of depth=3000 vs ±15%; FIND if deep walls vanish at realistic BTC mids.

### P2-02-H4 — BBO cache invariant continuous assert  
Property test: after any mutator, if both best>0 then best_bid < best_ask (or ≤ per product); FIND-P202-03.

### P2-02-H5 — Interaction with density mid=0  
After wipe, call DensityEngine.push_snapshot with empty levels — ensure no crash (bridge to P2-07).

---

## 7. Finding ID prefix

`FIND-P202-`

| Suggested | Issue |
|-----------|-------|
| FIND-P202-01 | Dual-sided cross wipe empties book |
| FIND-P202-02 | apply_bbo zero-size levels |
| FIND-P202-03 | Crossed BBO cache after apply_bbo |
| FIND-P202-04 | ±15% over-prune vs UI zoom |
| FIND-P202-05 | NaN key corruption |

---

## 8. Fix strategy sketch

1. **Cross policy:** Iterative prune: while crossed, remove only the stale side (e.g. bids ≥ ask first), recompute BBO, then asks ≤ bid; or keep larger size side. Never delete both using frozen pre-BBO in one simultaneous pass without re-check.  
2. **apply_bbo:** Skip insert if size≤0 (pop level); call `_recalc_bbo` or shared uncross.  
3. **Prune:** Make band configurable (tick-relative or % of visible range); don’t prune inside visible heatmap window.  
4. **Guard:** Reject NaN/Inf prices at mutator entry.

---

## 9. Dependencies

| | |
|--|--|
| **Depends** | P2-01 for healthy apply paths before stressing cross |
| **Blocks** | P2-07 (mid-mask needs sane mid); Z14 DOM centering |
| **Parallel OK** | With P2-03 once fixtures ready |

---

## 10. Severity priors

| Issue | Prior |
|-------|-------|
| Empty book on simple cross | **P0** (H-R03-01) |
| Zero-size BBO levels | **P1** (H-R03-03) |
| ±15% prune too aggressive | **P2** (H-R03-18) |
| Crossed cache transient | **P1** (H-R03-19) |

**Wave:** W1.
