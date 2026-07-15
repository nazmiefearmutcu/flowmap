# P2-04 — BookDelta `is_snapshot` / Delta-Only Books

**Agent:** P2-04  
**Track:** A — Core correctness  
**Theme n:** 4  
**Finding ID prefix:** `FIND-P204-`  
**Severity prior:** **P0** (delta-only lakes leave empty or drifted book; wrong is_snapshot → catastrophic replace/merge)

---

## 1. Scope & linked zones / sibling hyps

| Item | Value |
|------|-------|
| **Zones** | **Z08**, **Z12** (hist preload may also start mid-stream) |
| **Siblings** | R05 H5; R03 snapshot semantics; R02 hist path |
| **Primary** | `data/crypcodile_replay.py` `_dispatch_record` :174–208, especially :188–201 |
| **Related** | Replay local_book `apply_snapshot` :430–443; live `_dispatch` in crypcodile_live; Crypcodile `flowmap_window` hist |
| **Apply sink** | `OrderBook.apply_snapshot` vs `apply_updates` |

### Linked hypotheses

| ID | Claim |
|----|-------|
| R05 H5 | BookDelta with `is_snapshot=True` must become full replace; false path is incremental |
| Theme focus | **Delta-only lakes** (no book_snapshot channel) → empty book if first events are non-snapshot deltas applied to empty OrderBook |

### Non-scope

- Trade time warp / price rewrite → P2-39/40  
- SQL symbol → P2-41  

---

## 2. Threat model

**Dispatch truth (code):**

```text
tag == book_snapshot → Level2Snapshot (full)
tag == book_delta && is_snapshot → Level2Snapshot (built from delta bids/asks, size>0 filter)
tag == book_delta && !is_snapshot → list[Level2Update]
```

**Risks:**

1. **Missing first snapshot:** OrderBook starts empty; pure deltas only insert/remove relative to empty → incomplete book (only touched prices).  
2. **False `is_snapshot`:** Incremental delta treated as full replace → **wipes** all untouched levels → sparse wrong book.  
3. **False negative `is_snapshot`:** True snapshot encoded as delta without flag → applied as patches on empty or stale → massive drift.  
4. **Size filter asymmetry:** is_snapshot path filters `s > 0`; true zero levels for clear-all not expressible as empty snapshot sides if zeros stripped — empty bids tuple clears all bids (good for replace) but cannot “clear one side only” mid-book without full both-side payload.  
5. **GUI type routing:** queue msg_type `"snapshot"` vs `"update"` — if dispatcher emits Level2Snapshot but enqueued as wrong type, apply path wrong.  
6. **Hist preload (Z12):** equal-time bins may inject partial books without initial exchange snapshot.

---

## 3. Concrete probes

### 3.1 Static

1. Read `_dispatch_record` book_delta branch fully.  
2. Trace queue put sites in `crypcodile_replay.py` / `crypcodile_live.py` for msg_type assignment on snapshot vs update.  
3. Grep `is_snapshot` across flowmap + Crypcodile.  
4. Confirm `_cryp_book_delta_to_flowmap_updates` emits BID/ASK correctly (not BUY/SELL).

### 3.2 Unit — dispatch

| Probe | Input | Expected type |
|-------|-------|---------------|
| D1 | Mock BookSnapshot | `Level2Snapshot` |
| D2 | BookDelta is_snapshot=True with 10 levels | `Level2Snapshot`, not list of updates |
| D3 | BookDelta is_snapshot=False | `list[Level2Update]` |
| D4 | Delta is_snapshot with size=0 levels | zeros excluded; book clear of those prices on apply |
| D5 | Unknown channel | `[]` silent skip |

### 3.3 Unit — OrderBook under delta-only stream

| Probe | Stream | Expected |
|-------|--------|----------|
| B1 | 100 deltas, never snap, starting empty | Only prices mentioned present — **assert incomplete vs full book oracle** |
| B2 | Snap (via is_snapshot delta) then deltas | Matches oracle full replay |
| B3 | is_snapshot mid-stream with partial top-N only | Levels outside payload **gone** after replace — document |
| B4 | Two consecutive is_snapshot deltas | Second fully replaces first |
| B5 | Wrong flag: full depth payload with is_snapshot=False after empty | Drifted sparse book |

### 3.4 Integration

1. Catalog real lake: channels present for a known day (`book_snapshot` missing?).  
2. Replay 60s with logging of first book event type and `len(bids)+len(asks)` over time — detect “never exceeds N touched prices”.  
3. Crypcodile hist preload path: first bin content empty? gap wipe interaction (P2-37 sibling).

### 3.5 Anchors

| Topic | Anchor |
|-------|--------|
| is_snapshot → Level2Snapshot | `crypcodile_replay.py:188–200` |
| delta → updates | `crypcodile_replay.py:129–159, 201` |
| local replay book | `crypcodile_replay.py:430–443` |
| Live emit | `crypcodile_live.py` ~180+ |
| OrderBook replace | `order_book.py:64–82` |

---

## 4. Pass / fail criteria

| | Criteria |
|--|----------|
| **PASS** | D1–D5 green; B2/B4 correct; product has explicit recovery if B1 (resync/snap request or UI warning); queue type matches object type |
| **FAIL** | is_snapshot True/False mis-dispatch; delta-only session shows near-empty heatmap without error; mid-stream false snapshot wipes depth silently |

---

## 5. Fixtures

| Fixture | Description |
|---------|-------------|
| Synthetic msgspec/dataclass mocks for BookDelta | With/without is_snapshot |
| `fixtures/replay/delta_only_synthetic.jsonl` | Ordered deltas only |
| `fixtures/replay/snap_then_delta.jsonl` | Canonical good stream |
| Optional: real catalog metadata dump | Channel list for symbol/day |

---

## 6. Phase-3 micro-tasks

### P2-04-H1 — Dispatch unit tests for is_snapshot  
D1–D5 → FIND-P204-01 if wrong type.

### P2-04-H2 — Delta-only empty-book characterization  
B1 with metrics; FIND-P204-02 severity P0 if production lakes often lack snapshots.

### P2-04-H3 — False is_snapshot wipe  
B3 crafted partial snapshot → prove wipe; document recovery needs.

### P2-04-H4 — Queue msg_type fidelity  
Trace live/replay enqueue; assert snapshot objects always `"snapshot"`.

### P2-04-H5 — Z12 hist first-bin  
Read flowmap_window hist apply; if delta-like without full book, FIND-P204-05.

---

## 7. Finding ID prefix

`FIND-P204-`

| ID | Issue |
|----|-------|
| FIND-P204-01 | is_snapshot dispatch wrong type |
| FIND-P204-02 | Delta-only → empty/sparse book silent |
| FIND-P204-03 | Partial is_snapshot wipes deep book |
| FIND-P204-04 | msg_type mismatch |
| FIND-P204-05 | Hist preload lacks initial snap |

---

## 8. Fix strategy sketch

1. **Detect incomplete book:** If no snapshot ever applied, flag UI “waiting for snapshot” / don’t paint density as truth.  
2. **Force resync:** On live, request snapshot when gap or empty TOB after N deltas.  
3. **is_snapshot validation:** Require min depth or both sides non-empty before treating as replace; else treat as delta.  
4. **Catalog gate:** Refuse replay start if required channels missing (ties P2-38).  
5. Align size=0 in snapshot payload: if exchange sends full image including zeros, don’t strip before replace **or** clear first then add positives (current clear-on-apply handles empty sides).

---

## 9. Dependencies

| | |
|--|--|
| **Depends** | P2-01 (apply_snapshot semantics) |
| **Blocks** | Trustworthy replay (Z09), hist (Z12) visual hunts |
| **Related** | P2-38 catalog empty channels |

---

## 10. Severity priors

| Issue | Prior |
|-------|-------|
| Delta-only empty book | **P0** |
| False is_snapshot wipe | **P0** |
| Silent skip unknown channels | **P1** |
| Queue type mismatch | **P0** if present |

**Wave:** W1 (Z08).
