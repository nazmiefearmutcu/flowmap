# P2-13 — Unbounded queue growth model

| Field | Value |
|-------|-------|
| **Agent ID** | P2-13 |
| **Theme** | Unbounded queue growth model |
| **Zones** | Z05 (GUI tick drain), Z07 (Replay worker lifecycle) |
| **Siblings** | R16 H3/H4, R05 H6 (materialize), R10 H2/H3, R20 P0-01 |
| **Finding prefix** | `FIND-P213-XX` |
| **Severity prior** | **P0** (lag, freeze, OOM) |
| **Primary files** | `ui/source_manager.py`, `ui/main_window.py`, `data/crypcodile_replay.py`, `data/crypcodile_live.py` |

---

## 1. Scope & linked zones / sibling hyps

### In scope

Model and measure:

```text
Producer rate (puts/s)  vs  Consumer rate (≤1000 msgs / 16ms ≈ 62.5k msgs/s theoretical)
Queue depth over time under: live burst, replay speed=0, replay speed=20×, GUI stall
```

Confirm:

- `queue.Queue()` is **unbounded** (no `maxsize`) — `source_manager.py:81-82`  
- Producers never `put` with timeout / never drop — live L179-187, replay L513-521  
- Consumer only drains when `_source.running` — `main_window.py:896-897`  
- Replay can emit N Level2Update **per book_delta** (one per level) — multiplies queue pressure  

### Out of scope

- Drain batch semantics (snapshot clears) → **P2-15**  
- Drain cap starvation details → **P2-14** (coupled; share model)  
- Stale after stop → **P2-22**  
- Thread teardown → P2-17/19  

### Sibling anchors

| ID | Claim |
|----|-------|
| R16 H3 | Unbounded queue + fast replay → mem climb / freeze |
| R05 H6 | Full materialize + high emit rate |
| R20 P0-01 | Drain 1000 + unbounded queue = ship-breaker #1 |
| R10 | `_gui_tick` is sole consumer for market data |

---

## 2. Threat model

| Scenario | Producer | Consumer | Queue growth |
|----------|----------|----------|--------------|
| Replay speed=0 (max) | No sleep between records; book_delta → many updates | 1000/16ms | **Linear growth** if emit > 62.5k/s |
| Replay speed=20× | Sleep /20 | same | High if dense lake |
| Live flash crash / reconnect burst | WS flood | same | Spike |
| GUI blocked (rebuild, hist load, REST) | Continues | **0** while blocked (timer delayed) | Unbounded |
| `running=False` but worker alive | Continues | **skipped** early return | Unbounded until stop drain |
| User pause replay | Event blocks emit | drains residual | Shrinks |

**Assets at risk:** process RSS, UI latency, heatmaps lagging “now”, eventual macOS jetsam / kill.

**Attacker model:** not required — normal max-speed replay is enough.

---

## 3. Concrete probes

### 3.1 Static

| # | Check | Location |
|---|-------|----------|
| S1 | `Queue()` no maxsize | `source_manager.py:81-82` |
| S2 | All put sites | live `:179-187`, replay `:513-521`, crypto sender |
| S3 | Drain limit | `main_window.py:908-910` |
| S4 | Early return no drain | `main_window.py:896-897` |
| S5 | stop_current drain | `source_manager.py:194-200` |
| S6 | Toggle stop **no** drain | `_toggle_replay` `:456-460`, `_toggle_live` `:497-500` |
| S7 | Multi-update per delta | `_dispatch_record` in replay (R05) |

### 3.2 Analytic model (required deliverable)

```text
Let λ = mean producer messages/sec
Let μ = min(1000 / 0.016, actual_apply_rate) ≈ min(62500, apply_cost_limited)

If λ > μ: depth ≈ (λ - μ) * t
RSS_queue ≈ depth * (object_overhead + payload)

book_delta with D levels → D update messages
If books every 50ms with D=200 → 4000 updates/s base + trades
At speed=0, Δt→0 → λ limited only by Python loop + put
```

Phase-3 must **measure** λ, μ, depth, RSS on machine.

### 3.3 Unit / harness probes

**U1 — Synthetic producer**

```text
Background thread: put(("update", dummy), 200_000 times as fast as possible
Main: QTimer 16ms drain 1000
Plot q.qsize() every 100ms
Expect: growth if dummy apply is cheap but 1000 cap still limits μ=62.5k
(If put alone is 200k/s and drain 62.5k → grow ~137k/s)
```

**U2 — Replay max speed**

```text
start_replay(..., speed=0) on real lake
Sample SourceManager._queue.qsize every 100ms for 30s
Record max depth, final RSS (resource.getrusage)
```

**U3 — GUI stall simulation**

```text
Monkeypatch _gui_tick body to sleep(0.5) while producer runs
Observe depth growth
```

**U4 — running=False**

```text
Start producer; set _running=False without stop_current drain
Assert queue grows; _gui_tick returns immediately
```

### 3.4 Dynamic / GUI

- Replay 20× vs 0: status latency (progress vs wall), beachball  
- Instruments: optional DEBUG log of qsize every 30 frames in `_update_status_message`

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF1 | Queue max depth bounded under 60s max-speed replay | Monotonic growth without bound |
| PF2 | Drop/coalesce policy **or** backpressure **or** larger drain with proof | Silent unbounded |
| PF3 | When not running: no producer puts **or** continuous drain | Growth with running=False |
| PF4 | Documented SLA: max lag ms under λ | Unknown lag |
| PF5 | RSS growth < threshold (e.g. +500MB) for 2min replay | Multi-GB climb |

---

## 5. Fixtures

| Fixture | Purpose |
|---------|---------|
| Small synthetic lake / mock worker | Controlled λ without DuckDB |
| Real `/Users/nazmi/data` book_delta dense day | Stress |
| Dummy Level2Update factory | Cheap put payload |
| Metrics CSV template | t, qsize, rss, processed |

---

## 6. Phase-3 micro-tasks

1. **P3-13a** — Instrument `qsize` + RSS logging (temporary); run U2/U3; attach charts to FIND-P213-01.  
2. **P3-13b** — Count average messages per book_delta from `_dispatch_record` on sample lake.  
3. **P3-13c** — Design review: maxsize+drop oldest snapshot / conflate updates vs block producer (must not deadlock asyncio).  
4. **P3-13d** — Cross-check with P2-14: is 1000 the bottleneck or apply cost? Measure with limit=10000 trial.  
5. **P3-13e** — Fix sketch validation: generation-token queue replacement (P2-22) interaction.

---

## 7. Finding ID format

`FIND-P213-XX`

| Seed | Title | Sev |
|------|-------|-----|
| FIND-P213-01 | queue.Queue unbounded | P0 |
| FIND-P213-02 | Producer ignores consumer lag | P0 |
| FIND-P213-03 | book_delta fan-out multiplies msgs | P0/P1 |
| FIND-P213-04 | running=False skips drain | P1 (→P2-22) |
| FIND-P213-05 | Replay speed=0 worst case | P0 |

---

## 8. Fix strategy sketch

Options (pick after measurement):

| Option | Idea | Pros | Cons |
|--------|------|------|------|
| A | `Queue(maxsize=N)` + drop oldest non-snapshot | Bounds mem | Needs careful drop policy |
| B | Conflate: worker keeps latest book; queue only snapshots @33Hz | Like crypto sender_loop | Loses intermediate deltas |
| C | Raise drain limit + faster apply | Simple | Still unbounded if GUI stalls |
| D | Backpressure: pause replay when qsize>N | Fair | Cross-thread pause already exists |
| E | Hybrid: B for live, D for replay | Tuned | Complexity |

**Minimum viable:** maxsize + drop updates but **never drop last snapshot**; always drain when `not running` too.

---

## 9. Dependencies

| Theme | Rel |
|-------|-----|
| **P2-14** | Same bottleneck; share metrics |
| **P2-15** | Batching affects effective apply cost |
| **P2-19** | Replay producer lifecycle |
| **P2-22** | Stale queue after stop |
| **P2-17** | Live zombie continues puts |
| **P2-26** | rebuild freezes GUI → consumer stalls |

---

## 10. Severity priors

| Source | Sev |
|--------|-----|
| R20 #1 ship-breaker | **P0** |
| R16 H3 | High |
| Likelihood | **Certain** under speed=0 replay |

---

## 11. Code anchors

```81:82:/Users/nazmi/flowmap/flowmap/ui/source_manager.py
        self._queue = queue.Queue()
```

```895:910:/Users/nazmi/flowmap/flowmap/ui/main_window.py
    def _gui_tick(self) -> None:
        if not self._order_book or not self._source.running:
            return
        ...
        limit = 1000
        while processed < limit and not q.empty():
```

```513:521:/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py
                        if self._queue is not None:
                            ...
                                self._queue.put(("update", obj))
```
