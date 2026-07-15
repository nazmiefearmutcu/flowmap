# P2-19 — Replay blocking slot vs `QThread.quit`

| Field | Value |
|-------|-------|
| **Agent ID** | P2-19 |
| **Theme** | Replay blocking slot vs QThread quit |
| **Zones** | Z07 |
| **Siblings** | R05 H3/H4/H6, R16 H1/H2/H10, R20 P0-05 |
| **Finding prefix** | `FIND-P219-XX` |
| **Severity prior** | **P0** (zombie thread, stuck stop, mem during load) |
| **Primary files** | `data/crypcodile_replay.py`, `ui/source_manager.py` |

---

## 1. Scope & linked zones / sibling hyps

### Lifecycle

```text
start_replay():
  if replaying: stop_replay()
  worker = _ReplayWorker; signals; moveToThread
  thread.started → worker.run_replay → start_replay(...)  # BLOCKING SLOT
  # Inside: client open, SQL, list(book_iter), list(trade_iter),
  #         time-warp, price rewrite, emit loop, AUTO-LOOP while _running

stop_replay():
  worker.stop()  # _running=False; pause_event.set()
  thread.quit()
  thread.wait(5000)
  null refs
```

Lines: `crypcodile_replay.py:660-735`, worker loop `:477-547`, stop `:555-558`.

### Blocking phases where stop is weak

| Phase | Cooperative stop? |
|-------|-------------------|
| DuckDB/SQL load | Only between stages if checks exist — **long I/O may ignore** |
| `list(book_iter)` / `list(trade_iter)` | **No** mid-iteration check until after full list |
| Price alignment loop | May be long; check? (verify in Phase-3) |
| Emit loop sleeps | Yes — chunked 0.1s + `_running` |
| Auto-loop reload | Outer while `_running` — stop between passes |

### quit() same issue as live

Blocking slot holds thread; `quit()` waits until `start_replay` returns.

### Out of scope

- Time-warp / price rewrite design → P2-39/40  
- Unbounded queue from emit → P2-13  
- SQL injection → P2-41  

---

## 2. Threat model

| Scenario | Impact |
|----------|--------|
| User hits Stop during full materialize | UI waits ≤5s; thread may continue loading → orphan + late puts |
| start_replay while previous not joined | stop then new thread — dual if stop failed |
| Empty range auto-loop (H3) | CPU spin while `_running` |
| pause() via direct call | GIL OK-ish; not Qt-safe pattern |
| set_speed via signal | **Correct** Queued pattern — contrast with stop |
| App exit mid-replay | Destroyed while running |
| OOM during list(iter) | Process kill; stop irrelevant |

---

## 3. Concrete probes

### 3.1 Static

| # | Item | Location |
|---|------|----------|
| S1 | wait(5000) | `:728-730` |
| S2 | stop sets flag + unblocks pause | `:555-558` |
| S3 | Checks in emit loop | `:482-508` |
| S4 | list(book_iter) no cancel | load section ~340+ (R05) |
| S5 | Auto-loop | `:539-541` |
| S6 | set_speed signal vs stop direct | `:751` vs stop_replay |
| S7 | Double stop_replay on disconnect | provider disconnect → stop_replay |

### 3.2 Dynamic probes

**D1 — Stop during emit**

```text
Start replay speed=1; after progress>0.1 Stop
Assert join <5s; no further qsize growth after 1s
```

**D2 — Stop during materialize**

```text
Large range / full history; Stop immediately after Start
Measure: does wait timeout? is thread still running? late puts?
```

**D3 — Rapid start/stop/start**

```text
Toggle 10 times in 5s
Assert ≤1 live worker; no crash
```

**D4 — Empty range**

```text
Wall-clock fallback range with no lake data (R05)
CPU usage while running; auto-loop spin FIND
```

**D5 — Pause/resume**

```text
Pause: no new puts for 2s; Resume: puts continue
Stop while paused: unblocks and exits
```

**D6 — speed=0 stop latency**

```text
Max speed emit; Stop; measure time to last put
```

### 3.3 Instrumentation

Log at: enter materialize, exit materialize, each loop pass, stop requested, thread finished.

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF1 | Stop always joins thread or keeps ownership | Orphan after 5s |
| PF2 | Stop during load aborts load (cancel token) | Load completes after stop |
| PF3 | No auto-loop CPU spin on empty | Busy loop |
| PF4 | Double start safe | Dual threads |
| PF5 | pause/stop responsive ≤0.2s in emit phase | Stuck in long sleep (note: sleep capped 5s but chunked 0.1) |
| PF6 | closeEvent clean | QThread warning |

---

## 5. Fixtures

| Fixture | Use |
|---------|-----|
| Small lake slice | D1 fast |
| Large multi-day lake | D2 stress |
| Empty data_dir | D4 |
| Mock CrypcodileClient.replay slow iterator | Unit cancel |

---

## 6. Phase-3 micro-tasks

1. **P3-19a** — Map all `_running` check points; list gaps during load.  
2. **P3-19b** — D1–D4 repro; FIND tickets.  
3. **P3-19c** — Fix: interruptible materialize (chunked iter + flag) OR load on thread with killable future.  
4. **P3-19d** — Align stop with set_speed: document direct flag writes OK under GIL; use wait until finished signal.  
5. **P3-19e** — Disable auto-loop when empty / add user toggle (product).  

---

## 7. Finding ID format

`FIND-P219-XX`

| Seed | Title | Sev |
|------|-------|-----|
| FIND-P219-01 | quit+wait(5000) orphan on slow load | P0 |
| FIND-P219-02 | list(iter) not cancellable | P0 |
| FIND-P219-03 | Empty auto-loop CPU spin | P0 (R05 H3) |
| FIND-P219-04 | Rapid restart dual thread | P0/P1 |
| FIND-P219-05 | Direct cross-thread stop/pause | P2 |
| FIND-P219-06 | Full materialize OOM risk | P1 (R05 H6) |

---

## 8. Fix strategy sketch

1. **Streaming emit** without full `list()` (architectural; pairs R05).  
2. Short-term: check `_running` every N records during materialize; abort lists.  
3. `stop_replay`: wait; if still running, don’t null refs; emit error; block new start.  
4. `finished` signal → clear `_replaying` on main thread only.  
5. Empty pass: if zero records, sleep backoff or stop with error (no tight loop).  
6. Consider `QThread.requestInterruption` pattern + worker checks.

---

## 9. Dependencies

| Theme | Rel |
|-------|-----|
| **P2-13** | Producer until stopped |
| **P2-17** | Shared teardown pattern |
| **P2-20** | Signals on finished/error after teardown |
| **P2-22** | Queue hygiene after stop |
| **P2-39/40** | Load complexity (warp/rewrite) extends materialize time |

---

## 10. Severity priors

| Source | Sev |
|--------|-----|
| R20 P0-05 | **P0** |
| R05 H4 | High |
| R05 H3 empty spin | P0 |
| R16 H10 mem | P1 |

---

## 11. Code anchors

```719:735:/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py
        self._thread.started.connect(self._worker.run_replay)
        ...
    def stop_replay(self) -> None:
        if self._worker:
            self._worker.stop()
        if self._thread and self._thread.isRunning():
            self._thread.quit()
            self._thread.wait(5000)
        self._worker = None
        self._thread = None
```

```555:558:/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py
    def stop(self) -> None:
        self._running = False
        self._pause_event.set()
```

```539:541:/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py
                if self._running:
                    print("[REPLAY_WORKER] Replay finished, auto-looping/restarting...")
```
