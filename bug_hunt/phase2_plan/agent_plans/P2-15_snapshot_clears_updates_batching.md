# P2-15 — Snapshot clears updates batching

| Field | Value |
|-------|-------|
| **Agent ID** | P2-15 |
| **Theme** | Snapshot clears updates batching |
| **Zones** | Z05 |
| **Siblings** | R10 §3.C, R16 §5.1, R03 (L2 semantics) |
| **Finding prefix** | `FIND-P215-XX` |
| **Severity prior** | **P1** (correctness of book if order wrong); **P0** if multi-tick loses snapshot ordering vs lake |
| **Primary files** | `ui/main_window.py` (`_gui_tick`), `core/order_book.py` |

---

## 1. Scope & linked zones / sibling hyps

### In-batch logic (current)

```text
On msg snapshot:
  snapshots.append(obj)
  updates.clear()   # drop earlier updates in THIS drain batch
  bbos.clear()
# trades NEVER cleared by snapshot
# Apply order:
  apply_snapshot(snapshots[-1])  # only last snapshot
  apply_updates(updates)         # updates AFTER last snapshot only
  apply_bbo(bbos[-1])
  record_trades(trades)          # ALL trades in batch, including pre-snapshot
```

Locations: `main_window.py:914-917`, `:937-944`.

### Questions to prove

1. Is clearing **updates** before last snapshot correct vs exchange semantics?  
2. Should **trades** before snapshot be dropped or applied? (Currently applied — may double-affect book if snapshot already includes trade absorption.)  
3. Multiple snapshots in one batch: only last kept — intermediate discarded (OK if full replace).  
4. **Cross-tick** problem: updates drained tick N, snapshot arrives tick N+1 — updates already applied (correct). Opposite: 1000 updates no snapshot, next tick snapshot — OK.  
5. Snapshot does **not** clear trades in batch — intentional?  
6. BBO cleared with snapshot but last bbo after snapshot kept — OK.  
7. Interaction with `record_trades` mutating book after snapshot — order matters.

### Out of scope

- Drain cap → P2-14  
- L2 apply math internals → P2-01/02  
- Dual signal path → P2-20  

---

## 2. Threat model

| Scenario | Risk |
|----------|------|
| Batch: updates A, snapshot S, updates B | A dropped, S then B — **correct** for full replace S |
| Batch: trades T1, snapshot S, trades T2 | T1 applied **after** S in apply order — **T1 never seen by book before S**, but applied after S → may punch holes in S that exchange already reflected |
| Batch: snapshot S1, S2 | Only S2 applied — OK |
| Batch: updates only, no snap | All applied — OK |
| Snapshot and updates interleaved across tick boundary with cap | Stale updates applied then later snapshot — usually OK |
| Plugin / future path uses on_trade during batch | P2-16 |

**Market truth risk:** trade-after-snapshot order within batch can desync from live exchange if trades were already in the snapshotted book.

---

## 3. Concrete probes

### 3.1 Static order audit

Document exact apply sequence:

```937:944:/Users/nazmi/flowmap/flowmap/ui/main_window.py
        if snapshots:
            self._order_book.apply_snapshot(snapshots[-1])
        if updates:
            self._order_book.apply_updates(updates)
        if bbos:
            self._order_book.apply_bbo(bbos[-1])
        if trades:
            self._order_book.record_trades(trades)
```

Vs drain collection order (FIFO lists).

### 3.2 Unit matrix (required)

Build minimal `OrderBook` + synthetic messages:

| Case | Queue order | Expected book | Probe |
|------|-------------|---------------|-------|
| C1 | U(bid 100=5), S(bid 100=9) | bid 100=9 | updates cleared |
| C2 | S(bid 100=9), U(bid 100=0 remove) | bid 100 gone | update after snap |
| C3 | S1, S2 | S2 only | last snap |
| C4 | U1, U2 no S | both applied | |
| C5 | Trade buy 1@100, S full book | **Document actual** after record_trades | trade-after-snap |
| C6 | S, Trade | trade absorption on S | |
| C7 | BBO1, S, BBO2 | BBO2 only if after S in list; cleared on S so only post-S | |
| C8 | U, BBO, S | U&BBO cleared; S only | |
| C9 | 1500 U then S (multi-tick with limit 1000) | first tick applies 1000 U; second applies rest U then need S in later batch | multi-tick |

### 3.3 Differential vs replay lake

- Take short lake segment with book_snapshot or is_snapshot delta.  
- Apply via queue simulation vs direct chronological OrderBook apply without batching.  
- Diff final bids/asks.

### 3.4 Live sanity

- On live connect first messages often snapshot then deltas — confirm no missing wall.

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF1 | C1–C4 match L2 replace semantics | Updates leak across snapshot in same batch |
| PF2 | Explicit policy for trades vs snapshot documented and tested | Silent desync |
| PF3 | Multi-snapshot batch = last only | Intermediate required state lost incorrectly |
| PF4 | BBO after snapshot wins | Stale BBO after full snap |
| PF5 | Cross-tick with drain cap converges to same book as unlimited drain | Permanent wrong book |

---

## 5. Fixtures

| Fixture | Content |
|---------|---------|
| `fixtures/batch_cases.json` | Ordered msg lists + expected best bid/ask sizes |
| Synthetic Level2Snapshot/Update/Trade builders | Unit test helpers |
| Golden book after C5 | Once policy chosen |

---

## 6. Phase-3 micro-tasks

1. **P3-15a** — Implement C1–C9 unit tests; open FINDs for mismatches.  
2. **P3-15b** — Decide trade policy: (i) clear trades on snapshot like updates, (ii) apply trades only after snapshot in time order with per-msg loop, (iii) keep current.  
3. **P3-15c** — Optional rewrite drain to **single chronological apply** loop without list batching (simplest correctness).  
4. **P3-15d** — Measure performance of chronological vs batch.  
5. **P3-15e** — Document contract in main_window docstring for future agents.

---

## 7. Finding ID format

`FIND-P215-XX`

| Seed | Title |
|------|-------|
| FIND-P215-01 | updates.clear() on snapshot (verify correct) |
| FIND-P215-02 | trades not cleared — book punch after snapshot |
| FIND-P215-03 | only last snapshot applied |
| FIND-P215-04 | apply order snap→upd→bbo→trades vs event time |
| FIND-P215-05 | multi-tick partial drain breaks atomic batch assumptions |

---

## 8. Fix strategy sketch

**Preferred for correctness:** process messages in FIFO order one-by-one (or micro-batch only identical types), still cap count/budget:

```text
for msg in drained:
  if snapshot: apply_snapshot
  elif update: apply_update
  elif trade: record_trade
  elif bbo: apply_bbo
```

**If keep batching:**

- Clear **trades** on snapshot too, **or** partition trades into pre/post snapshot and drop pre.  
- Keep updates.clear() + bbos.clear().  
- Apply trades only post-snapshot subset.

---

## 9. Dependencies

| Theme | Rel |
|-------|-----|
| **P2-01/02/04** | L2 semantics definition of snapshot |
| **P2-14** | Multi-tick splits batches |
| **P2-16** | on_trade side effects during apply |
| **P2-05** | Trade field mapping before batch tests |

---

## 10. Severity priors

| Source | Sev |
|--------|-----|
| R10 batching notes | Medium–High |
| Wrong book | **P0** if C5 fails badly |
| Clear updates same-batch | Likely **correct** (P2 confirm) |

---

## 11. Code anchors

```914:917:/Users/nazmi/flowmap/flowmap/ui/main_window.py
                if msg_type == "snapshot":
                    snapshots.append(obj)
                    updates.clear()  # snapshot overrides past increments
                    bbos.clear()     # snapshot overrides past increments
```

```937:944:/Users/nazmi/flowmap/flowmap/ui/main_window.py
        if snapshots:
            self._order_book.apply_snapshot(snapshots[-1])
        if updates:
            self._order_book.apply_updates(updates)
        if bbos:
            self._order_book.apply_bbo(bbos[-1])
        if trades:
            self._order_book.record_trades(trades)
```

Note: UI fan-out of trades to heatmap is **separate** at `:949-953` and does not use OrderBook callback during batch (see P2-16).
