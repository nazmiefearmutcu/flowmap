# P2-38 — Catalog empty/partial channels

| Field | Value |
|-------|-------|
| **Agent** | P2-38 |
| **Theme** | Catalog empty partial channels |
| **Zones** | Z12 |
| **Sibling hyps** | R05 §2 lake layout H5; R02 hist scan list; R20 P1-08 adjacent |
| **Severity prior** | **P0–P1** empty/wrong book when channels incomplete |
| **Primary files** | `flowmap_window.load_historical_data` scans; `crypcodile_replay` channel lists; Catalog.scan; real lake `/Users/nazmi/data` |

---

## 1. Scope & linked zones/sibling hyps

### In scope
**Embedded hist channels scanned:**
- `book_snapshot`
- `book_delta`
- `trade`
- **Not:** `book_ticker`, `liquidation`

**Observed real lake (R05):**
- present: `book_delta`, `trade`
- absent: `book_snapshot`, `book_ticker`, `liquidation`

**Implications:**
- Bootstrap depends on `book_delta.is_snapshot` (R05 H5)
- `dict_to_flowmap_objects` maps is_snapshot deltas → Level2Snapshot; pure deltas on empty book → corrupt/empty
- Empty all channels → early `return` without user feedback
- Partial: trades only → hist with trades on empty book
- Exceptions on scan → empty DataFrame swallow

**Replay path contrast:** channels include book_ticker; liquidations; still needs snapshot/bootstrap.

### Out of scope
- Time warp of trades (P2-39)
- SQL injection on symbol (P2-41)
- Live channel subscription list (R06) except comparison table

---

## 2. Threat model

| Lake shape | Hist preload result | Replay result |
|------------|---------------------|---------------|
| delta + trade (real) | OK **iff** is_snapshot rows exist early | H5 risk same |
| trade only | trades on empty book; heatmap empty/NaN mid | book-less |
| snapshot + trade | good bootstrap | good |
| empty | silent no-op return | empty auto-loop (H3) |
| snapshot only | books without trades/CVD | books only |
| corrupt parquet | exception → empty DF | error signal or print |

**User threat:** “I have data in the lake” but wrong channel mix → blank UI; no actionable error.

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| S1 | List channels in load_historical_data try/except blocks |
| S2 | dict_to_flowmap: is_snapshot, missing liquidation |
| S3 | Replay worker channel lists |
| S4 | Catalog.scan API empty behavior |
| S5 | Early return `if not events` |

### 3.2 Unit — matrix

| ID | Channels present | Assert |
|----|------------------|--------|
| M1 | none | return; no reset (or document) |
| M2 | trade only | events non-empty; book empty after bins |
| M3 | book_delta is_snapshot=True first | book builds |
| M4 | book_delta all is_snapshot=False | empty/wrong book (H5) |
| M5 | book_snapshot + delta | correct |
| M6 | scan throws | empty DF; continues other channels |
| M7 | bids as dict vs tuple | normalization path |

### 3.3 Integration real lake

| ID | Steps |
|----|-------|
| R1 | Inventory `/Users/nazmi/data` channels/dates |
| R2 | load_historical for `binance-spot:BTCUSDT` (or present symbol) |
| R3 | Count is_snapshot true in first 100 deltas |
| R4 | After load (pre-gap), order_book depth > 0? |
| R5 | Replay same symbol window | compare |

### 3.4 UX / errors

| ID | Probe |
|----|-------|
| X1 | Any status bar message on empty? |
| X2 | stderr only? |
| X3 | CLI still opens blank window | |

### 3.5 Bootstrap deep dive

| ID | Probe |
|----|-------|
| B1 | Apply first non-snapshot deltas on empty OrderBook | sizes at absolute prices without prior |
| B2 | First is_snapshot mid-stream | recovery |
| B3 | size=0 removes on empty | no-op |

---

## 4. Pass/fail criteria

| Criterion | Pass | Fail |
|-----------|------|------|
| Partial lake | Degrades with **explicit** diagnostics | Silent blank |
| Bootstrap | Requires snapshot or flagged snapshot-delta; else error state | Corrupt book silent |
| Empty | User-visible “no data for symbol/range” | bare return |
| Channel policy | Documented required set | tribal knowledge |
| Normalization | dict and tuple levels both work | one format dies |
| Liquidation | hist includes or documents omit | inconsistent with live |

---

## 5. Fixtures needed

| Fixture | Description |
|---------|-------------|
| Minimal hive per matrix cell M1–M6 | tmp_path pytest |
| Captured real partition sample (small) | |
| Delta stream without is_snapshot | H5 repro |
| Mixed dict/tuple level encodings | |

---

## 6. Phase-3 agent micro-tasks

### Hunt A — Real lake inventory
R1–R4 script; table per symbol. **FIND-P238-01**

### Hunt B — H5 bootstrap on hist path
M4 synthetic through dict_to_flowmap + OrderBook. **FIND-P238-02**

### Hunt C — Empty/partial UX
M1–M2 user-visible outcomes. **FIND-P238-03**

### Hunt D — Channel parity table
hist vs live vs replay channels. **FIND-P238-04**

### Hunt E — Exception swallow audit
each scan try/except; recommend logging. **FIND-P238-05**

---

## 7. Expected finding IDs

Format: **`FIND-P238-XX`**

| ID | Title | Sev |
|----|-------|-----|
| FIND-P238-01 | Production lake lacks book_snapshot | P1 info / env |
| FIND-P238-02 | Hist fails without is_snapshot bootstrap | **P0–P1** |
| FIND-P238-03 | Empty catalog silent return | P1 |
| FIND-P238-04 | Liquidation/BBO not scanned in hist | P2 |
| FIND-P238-05 | Scan exceptions swallowed | P2 |
| FIND-P238-06 | Trade-only hist paints empty density | P1 |
| FIND-P238-07 | Channel parity undocumented | P2 |

---

## 8. Fix strategy sketch

1. **Required channel policy:** need snapshot **or** first delta is_snapshot; else show error panel with channel checklist.
2. Optional: synthesize snapshot from first N deltas if exchange guarantees full depth on connect (risky — only if schema known).
3. Log missing channels at INFO with paths globbed.
4. Include liquidation in hist scan if present.
5. Unify empty UX with replay H3 (no busy loop on hist — already returns).
6. Tests for each lake shape fixture.

---

## 9. Dependencies

| Theme | Relation |
|-------|----------|
| P2-04 BookDelta is_snapshot | Core bootstrap |
| P2-36 binning | Applies whatever events exist |
| P2-37 gap wipe | After partial success |
| P2-39/40 replay | Parallel channel issues |
| P2-05 liquidations | Mapping if channel added |

---

## 10. Severity priors from phase1

| Source | Prior |
|--------|-------|
| R05 H5 | **HIGH / P0–P1** |
| R05 real layout | no book_snapshot |
| R02 missing channels in preload | called out |

**Verdict:** Phase-3 starts with **real lake inventory + is_snapshot rate**; likely confirms ship-risk for default CLI hist.
