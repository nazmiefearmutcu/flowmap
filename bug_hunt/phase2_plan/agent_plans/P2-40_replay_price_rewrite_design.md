# P2-40 — Replay price rewrite design

| Field | Value |
|-------|-------|
| **Agent** | P2-40 |
| **Theme** | Replay price rewrite design review |
| **Zones** | Z09 |
| **Sibling hyps** | R05 H2, H15, H16; R20 P0-03 |
| **Severity prior** | **P0** data integrity (prices are synthesized) |
| **Primary files** | `/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py` ~303–474 (`MappedRecord`, static AVG shift, `LocalBookTracker` dynamic pass) |

---

## 1. Scope & linked zones/sibling hyps

### In scope
Two-stage price mutation of trades:

**Stage A — Static shift**
```sql
price_shift = AVG(book_delta bid prices) - AVG(trade prices)  -- full tables, not windowed
```
Applied as initial `MappedRecord.price_shift`.

**Stage B — Dynamic rewrite (overrides A)**
`LocalBookTracker` walks merged records in mapped-time order:
- buy aggressor → `target = best ask`
- sell aggressor → `target = best bid`
- else → `last_known_mid`
- `price_shift = target - original_price`

So **every successful trade is forced onto BBO/mid** at warped time.

Also:
- `original_trend` EMA computed then **unused** (H15)
- AVG unnest SQL schema fragility (H16)
- Interaction with time-warp (P2-39): tracker sees book at **mapped** co-location
- Downstream: bubbles, VP, VWAP, iceberg heuristics all see fake prices

### Out of scope
- Time warp algorithm details (P2-39) except compound effect
- Live path prices (should be untouched — verify)
- Order book level prices (not rewritten)

---

## 2. Threat model

| Claimed feature | Actual |
|-----------------|--------|
| “Replay trades” | Synthetic prints on TOB |
| Jump detection | Hidden or fabricated relative to true prints |
| VWAP / CVD price | CVD uses size/side; VWAP uses **rewritten** price |
| Heatmap trade dots Y | Sit on BBO rows always → “perfect” prints |
| Debug misaligned series | May have been why shift was added |

**Integrity threat:** Research users exporting mental model of tape get **false tape**. Any strategy research on replay is invalid.

**Compound with H1:** trades from wrong era snapped onto unrelated book → pure fiction.

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| S1 | MappedRecord.price property = raw + shift |
| S2 | Stage B overwrites shift always when target found |
| S3 | `_dispatch_record` reads price via getattr → shifted |
| S4 | Live/hist paths lack LocalBookTracker (confirm) |
| S5 | Dead original_trend |
| S6 | AVG queries unscoped by time window |

### 3.2 Unit — rewrite rules

| ID | Book state | side | raw px | out px |
|----|------------|------|--------|--------|
| U1 | bid 100 ask 101 | buy | 99 | **101** |
| U2 | bid 100 ask 101 | sell | 102 | **100** |
| U3 | empty book, mid known | buy | 50 | mid |
| U4 | empty, no mid | any | 50 | static shift only |
| U5 | static shift 5, then dynamic | buy | 10 | best ask (dynamic wins) |
| U6 | side string weird | | | mid/fallback |

### 3.3 Differential integrity

| ID | Steps | Metric |
|----|-------|--------|
| I1 | Capture original prices before shift | max\|out-raw\| |
| I2 | Same replay with Stage B disabled | compare trade Y on heatmap |
| I3 | Same with Stage A only | |
| I4 | Real tape known print away from BBO (mid-touch) | rewritten to touch |
| I5 | VWAP session value raw vs rewritten | |

### 3.4 AVG shift edge

| ID | Probe |
|----|-------|
| A1 | Empty book_delta AVG | exception → shift 0 |
| A2 | Struct field rename | H16 |
| A3 | Full-table AVG vs window AVG differ | large bias |

### 3.5 Design review questions

1. Why was rewrite introduced? (git blame / comments)
2. Is “align trades to book” a temporary debug hack left on?
3. Should replay offer `price_mode=raw|static_shift|bbo_snap`?
4. Does any UI claim “real trade prices”?

---

## 4. Pass/fail criteria

| Criterion | Pass | Fail |
|-----------|------|------|
| Default | Emit **raw** trade prices from lake | BBO snap always |
| Optional align | Explicit advanced mode | silent |
| Static shift | Off by default; if on, window-scoped + logged | full-table silent |
| EMA dead code | removed or used | dead cost |
| Tests | raw path golden prices | none |
| Live unaffected | live prices raw | accidental share |

---

## 5. Fixtures needed

| Fixture | Description |
|---------|-------------|
| Trades off-BBO with known book | U1–U2 |
| Window where AVG(trade)≠AVG(book) | static shift |
| Golden raw trade list from parquet | |
| Toggle harness monkeypatching LocalBookTracker pass | |

---

## 6. Phase-3 agent micro-tasks

### Hunt A — Always-on dynamic rewrite proof
Count aligned_count log; assert = n_trades. **FIND-P240-01**

### Hunt B — Price delta distribution
Histogram \|rewrite\| on real symbol. **FIND-P240-02**

### Hunt C — Disable experiment
Patch skip Stage B; visual + metric compare. **FIND-P240-03**

### Hunt D — Static AVG scope bug
Full-table vs window AVG. **FIND-P240-04**

### Hunt E — Downstream consumers
List all readers of Trade.price in GUI tick. **FIND-P240-05**

### Hunt F — ADR with P2-39
Joint recommendation: raw time + raw price default. **FIND-P240-06**

---

## 7. Expected finding IDs

Format: **`FIND-P240-XX`**

| ID | Title | Sev |
|----|-------|-----|
| FIND-P240-01 | Dynamic BBO/mid price rewrite always on | **P0** |
| FIND-P240-02 | Static full-table AVG shift | **P0–P1** |
| FIND-P240-03 | Compound fiction with time-warp | **P0** |
| FIND-P240-04 | VWAP/bubbles use fake prices | P1 |
| FIND-P240-05 | original_trend dead computation | P3 |
| FIND-P240-06 | AVG unnest schema fragile | P2 |
| FIND-P240-07 | No UI disclosure | P1 |
| FIND-P240-08 | Side parse `"buy" in side_str` fragility | P2 |

---

## 8. Fix strategy sketch

1. **Remove Stage B from default path** (highest integrity win).
2. Remove or gate Stage A; if kept, compute on **same window** as replay and log magnitude.
3. Feature flag: `replay_price_mode = raw | static_shift | snap_bbo`.
4. Delete unused EMA trend map.
5. Golden tests: dispatched Trade.price == parquet price in raw mode.
6. Document that prior “alignment” was debug debt.
7. After fix, re-check iceberg/LLT false positives (P2-45) on replay.

---

## 9. Dependencies

| Theme | Relation |
|-------|----------|
| **P2-39** | **Must coordinate** — same module, compound bug |
| P2-05 trade mapping | dispatch after rewrite |
| P2-32 bubbles Y | sits on BBO due to rewrite |
| P2-34 VP | volumes at fake prices |
| P2-45 iceberg | heuristics on false tape |
| P2-06 CVD | size-based; price less critical |
| P2-36 hist | uses raw dict prices (inconsistent modes!) |

**Note:** Hist preload does **not** rewrite prices; Replay does → **standalone REPLAY vs CLI hist disagree** on same lake.

---

## 10. Severity priors from phase1

| Source | Prior |
|--------|-------|
| R05 H2 | **HIGH** |
| R20 P0-03 | **P0** |
| R20 never-drop 39–41 | includes 40 |

**Verdict:** Phase-3 evidence pack + ADR; default path must become raw prices. Design review complete only when product owner decision recorded (recommend raw).
