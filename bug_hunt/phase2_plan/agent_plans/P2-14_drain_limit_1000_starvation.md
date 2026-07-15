# P2-14 — Drain limit 1000 starvation

| Field | Value |
|-------|-------|
| **Agent ID** | P2-14 |
| **Theme** | Drain limit 1000 starvation |
| **Zones** | Z05 |
| **Siblings** | R16, R10, R20 P0-01 |
| **Finding prefix** | `FIND-P214-XX` |
| **Severity prior** | **P0** (sustained lag under burst) |
| **Primary files** | `ui/main_window.py` (`_gui_tick`) |

---

## 1. Scope & linked zones / sibling hyps

### In scope

The hard cap:

```python
limit = 1000  # main_window.py:908
while processed < limit and not q.empty():
```

Consequences:

1. **Starvation of tail messages** within a tick: messages beyond 1000 wait ≥16ms more.  
2. **Priority inversion:** trades/snapshots mixed FIFO — a flood of updates can delay a later snapshot by many ticks.  
3. **Fairness:** no prioritization of `snapshot` over `update`.  
4. **Theoretical max throughput:** 1000/0.016 ≈ **62,500 msgs/s** — may be lower if apply is slow.  
5. Interaction with **empty() check** before get (minor race with multi-producer — only one producer typical).

### Out of scope

- Unbounded growth model math → P2-13 (complement)  
- Snapshot clearing updates **inside** batch → P2-15  
- OrderBook apply correctness → Track A  

### Coupled invariant

```text
If backlog B > 1000:
  lag_ticks ≈ ceil(B / 1000)
  lag_ms ≈ lag_ticks * 16
  At B=100_000 → ~1.6s structural lag even if apply is free
```

---

## 2. Threat model

| Threat | Effect |
|--------|--------|
| Replay speed=0 dense deltas | Structural multi-second lag; heatmap “behind” |
| Snapshot buried behind 50k updates | User sees old book longer; then big jump |
| apply_updates O(n*levels) heavy | Effective μ << 62.5k → worse than cap alone |
| Status/UI thinks connected/live | User trusts stale book for trading decisions |

---

## 3. Concrete probes

### 3.1 Static

| Line | Code | Note |
|------|------|------|
| `main_window.py:908` | `limit = 1000` | Magic constant, no config |
| `:910` | `while processed < limit and not q.empty()` | empty() not atomic with get — OK single producer |
| `:924` | `task_done()` | No join consumers |
| `:896-897` | early return | Zero drain when stopped |

### 3.2 Unit probes

**U1 — Cap enforcement**

```text
Fill queue with 2500 tagged messages (id=0..2499)
One _gui_tick call (or extract drain function)
Assert: processed==1000, qsize==1500, first applied id=0..999
```

**U2 — Lag accumulation**

```text
Producer 10_000 msg/tick equivalent over 10 ticks
Consumer 1000/tick
After 10 ticks: backlog = 90_000 if producer synced per tick... 
Better: continuous producer 100k/s for 1s, consumer 62.5k/s
Measure time until qsize returns to 0 after producer stops
```

**U3 — Snapshot latency under flood**

```text
Put 5000 updates, then 1 snapshot, then 100 updates
Drain 1000 at a time; record which tick snapshot applied
Expect: snapshot applied on tick 6 (after 5000 updates) if FIFO
(Unless P2-15 clear logic only within same drain batch)
```

**U4 — Increase limit experiment**

```text
limit=10000 vs 1000: wall time per tick, lag_ms, UI FPS
Find knee where apply dominates
```

**U5 — empty() vs get_nowait**

```text
Confirm Empty handling; no infinite loop
```

### 3.3 Dynamic

- Replay speed=0: measure time from progress=0.5 signal to book mid matching lake mid at that progress (semantic lag).  
- Live: artificial burst (if possible) or network replay of capture.

### 3.4 Instrumentation

Add temporary:

```python
if processed == limit and not q.empty():
    self._drain_starved = True
    self._last_backlog = q.qsize()
```

Surface in status bar for experiments.

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF1 | Under max load, lag_ms < SLA (e.g. 200ms p99) | Multi-second structural lag |
| PF2 | Snapshots applied within ≤1 tick of dequeue opportunity | Snapshot stuck behind huge update flood for many ticks |
| PF3 | Limit configurable or justified by profiling | Magic 1000 with no measurement |
| PF4 | Tick budget: drain+apply < 16ms p95 on target hardware | Ticks overshoot → cascading lag |
| PF5 | Starvation counter == 0 in steady live | Counter always high in replay 20× |

---

## 5. Fixtures

| Fixture | Use |
|---------|-----|
| `make_n_updates(n)` | U1–U3 |
| Prebuilt queue pickle of 50k msgs | Perf |
| Lake segment known density | Semantic lag |

---

## 6. Phase-3 micro-tasks

1. **P3-14a** — Extract `_drain_queue(limit)` pure function for testability; U1 unit test.  
2. **P3-14b** — Measure apply cost breakdown: snapshot vs update vs trade vs heatmap push.  
3. **P3-14c** — Experiment adaptive limit: drain until 8ms budget or empty.  
4. **P3-14d** — Priority drain: always process latest snapshot first (scan or dual queue).  
5. **P3-14e** — File FIND with charts; recommend limit + policy for P2-13 fix package.

---

## 7. Finding ID format

`FIND-P214-XX`

| Seed | Title |
|------|-------|
| FIND-P214-01 | Hard cap 1000 causes multi-tick lag |
| FIND-P214-02 | FIFO starves snapshot behind updates |
| FIND-P214-03 | No budget-based drain |
| FIND-P214-04 | Cap interacts with heavy push_snapshot |

---

## 8. Fix strategy sketch

1. **Budget-based drain:** `while time < deadline and not empty`.  
2. **Two-phase drain:**  
   - Phase A: scan up to N for latest snapshot index; clear pre-snapshot updates (extends P2-15).  
   - Phase B: apply rest until budget.  
3. **Raise cap** only after measuring apply cost (don’t blindly set 1e6).  
4. **Conflation at producer** (P2-13) reduces need for huge caps.  
5. Expose `gui_drain_limit` in EngineConfig / settings.

---

## 9. Dependencies

| Theme | Rel |
|-------|-----|
| **P2-13** | Growth model; shared metrics |
| **P2-15** | Within-batch snapshot clear; multi-tick snapshot delay still issue |
| **P2-26** | Heavy rebuild steals budget from drain |
| **P2-11** | push_snapshot cost on every non-empty tick |

---

## 10. Severity priors

| Source | Sev |
|--------|-----|
| R20 P0-01 | **P0** |
| R16 | High |
| Likelihood | High under replay |

---

## 11. Code anchors

```895:926:/Users/nazmi/flowmap/flowmap/ui/main_window.py
    def _gui_tick(self) -> None:
        if not self._order_book or not self._source.running:
            return
        ...
        limit = 1000
        processed = 0
        while processed < limit and not q.empty():
            try:
                msg_type, obj = q.get_nowait()
                processed += 1
                if msg_type == "snapshot":
                    snapshots.append(obj)
                    updates.clear()
                    bbos.clear()
                ...
```
