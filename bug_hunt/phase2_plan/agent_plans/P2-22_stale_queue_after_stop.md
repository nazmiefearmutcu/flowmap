# P2-22 — Stale queue after stop / switch

| Field | Value |
|-------|-------|
| **Agent** | P2-22 |
| **Theme n** | 22 |
| **Slug** | `stale_queue_after_stop` |
| **Zones** | **Z10**, **Z05** |
| **Sibling fuel** | **R16** H4 + §1.7 / §5.1 / §6.6; **R10** H2/H3; **R20** P0-01 interaction |
| **Primary modules** | `/Users/nazmi/flowmap/flowmap/ui/source_manager.py`, `/Users/nazmi/flowmap/flowmap/ui/main_window.py` |
| **Secondary** | All producers putting to `SourceManager._queue` (`crypcodile_live`, `crypcodile_replay`, `crypto`) |
| **Track** | B — Concurrency & data plane |
| **Wave** | **W1** |

---

## 1. Scope & linked zones / sibling hyps

### In scope

1. When is the shared `queue.Queue` **drained**?
2. When does `_gui_tick` **refuse** to drain (`if not self._source.running: return`)?
3. Can messages from session N be applied in session N+1?
4. Race window: drain then late `put` from orphan/dying worker.
5. Same queue object reused across `switch_to` (no replacement / no epoch).

### Out of scope

| Concern | Owner |
|---------|-------|
| Disconnect/thread join completeness | **P2-21** |
| Drain cap 1000 starvation while running | **P2-14** |
| Unbounded growth model | **P2-13** |
| Snapshot clears updates batching order | **P2-15** |

### Sibling hypothesis map

| ID | Claim | Mapping |
|----|-------|---------|
| R16-H4 | Stale queue after stop/toggle without drain | **Primary** |
| R16 §5.1 | `_gui_tick` skips drain when not running | **Primary** |
| R10-H2 | Gated on running → silent no UI update / growth | **Primary** |
| R10-H3 | switch_to shared queue; post-drain producer race | **Primary** |
| R20 P0-01 | Unbounded queue + drain cap | Amplifies severity |

### Code anchors

```
source_manager.py
  L81–82   self._queue = queue.Queue()   # single instance for lifetime
  L183–202 stop_current: drain loop L194–200 ONLY on this path
  L451–461 _toggle_replay STOP: stop_replay + disconnect + running=False; **NO drain**
  L493–501 _toggle_live STOP: disconnect + running=False; **NO drain**
  L154–169 switch_to: stop_current (drains) then reset widgets; same queue object

main_window.py
  L895–897 _gui_tick: if not order_book or not source.running: return  # no drain
  L908–926 drain ≤1000 only when running
  L1172–1174 closeEvent → stop_current (drain OK) + timer stop
```

**Critical asymmetry:** only `stop_current` drains; user-facing Stop often uses `_toggle_*`.

---

## 2. Threat model

### Assets

| Asset | Failure |
|-------|---------|
| Book state at session start | Ghost levels / wrong mid from prior session |
| Heatmap history purity | Old trades/prices painted into new session after Start |
| Queue memory | Growth while `running=False` if producer still alive (P2-21) |

### Failure scenarios

| # | Scenario | Mechanism |
|---|----------|-----------|
| S1 | Stop via Space/Start button (`_toggle_live`) mid-stream | Queue retains msgs; `_gui_tick` ignores; **Start** sets running → **first ticks apply stale** |
| S2 | Stop replay via toggle | Same as S1; worse if disconnect incomplete and producer still puts |
| S3 | `switch_to` drain then hung worker puts | New provider starts; stale + new interleaved |
| S4 | Symbol change with `was_running` | Uses `stop_current` (drain) — **good path**; still S3 race |
| S5 | Producer after `running=False` forever | Queue grows unbounded (intersection P2-13 + P2-21) |
| S6 | Drain loop `while not empty` TOCTOU | Between last get and return, put arrives; next start applies it |

### Threat actors

- Fast Start/Stop user.
- High-rate replay (20×) leaving large backlog at stop.
- Racey teardown (P2-21).

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| ST-1 | CFG: every path setting `_running = False` — does it drain? |
| ST-2 | Confirm queue is never replaced (`_queue = queue.Queue()` only in `__init__`) |
| ST-3 | Producers: any stamp of generation/session id? (expect **none**) |
| ST-4 | `_gui_tick` early return — no side-effect drain |

### 3.2 Unit

| ID | Steps | Assert |
|----|-------|--------|
| U1 | Fill queue with 50 synthetic snapshots (prices 1.0); set running=False via toggle-path mock; call `_gui_tick` | Book unchanged; queue still 50 |
| U2 | Then set running=True without drain; `_gui_tick` | Book shows price 1.0 ghost |
| U3 | `stop_current` after fill | `q.empty()`; book reset path separate |
| U4 | Concurrent: thread `put` while main drains | After drain+short sleep, measure residual; document TOCTOU |
| U5 | `switch_to` with injected post-drain put (same queue) | New session applies old msg unless epoch |

### 3.3 Dynamic

| ID | Steps |
|----|-------|
| D1 | Live start → wait for activity → Stop (toggle) → instrument `queue.qsize()` → Start → first `apply_snapshot` prices vs pre-stop |
| D2 | Replay 20× → Stop mid → qsize → Start → look for price discontinuity jump to past |
| D3 | Live → switch_to Replay without Start → qsize after stop_current (expect 0) → contrast toggle |

### 3.4 GUI

| ID | Action | Fail look |
|----|--------|-----------|
| G1 | Stop live, wait 5s, Start | Flash of old BBO before new stream |
| G2 | Stop, change nothing, Start | Same book mid as at stop (if no new WS yet) for >1s while “Connecting” |

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF-1 | Every stop path leaves `q.qsize()==0` **or** all residual msgs are epoch-stamped and dropped | Toggle stop leaves qsize>0 with unstamped msgs |
| PF-2 | First applied message after Start cannot predate session epoch | Stale snapshot applied |
| PF-3 | `running=False` implies either drained or producers cannot put | Unbounded growth while stopped |
| PF-4 | `switch_to` cannot interleave old/new without drop | Cross-source book mash |
| PF-5 | Documented intentional design only if consumer drops by epoch | “Works by accident” is fail |

---

## 5. Fixtures needed

| Fixture | Detail |
|---------|--------|
| Synthetic queue payload factory | `("snapshot", BookSnapshot(...))` with distinct mids 100 / 200 / 300 |
| Session harness wrapping MainWindow/SourceManager | Call toggle vs stop_current |
| `qsize` sampler on timer | 1 ms resolution around stop |
| Epoch-aware spy consumer (test double of `_gui_tick`) | Count dropped vs applied |
| Replay short window fixture | Optional for D2 |

---

## 6. Phase-3 micro-tasks

### MT-22-1 — Drain coverage audit
List all `_running=False` sites; mark drain Y/N; open FIND for each N.

### MT-22-2 — Toggle-stop stale apply proof
Automated U1–U2 style test with real OrderBook; assert mid changes from stale payload → **FIND-P222-01**.

### MT-22-3 — switch_to post-drain race
Inject put after `stop_current` drain returns; start new session; prove apply → **FIND-P222-02**.

### MT-22-4 — Design choice: drain-on-stop vs drain-when-not-running
Spike: (A) always drain in stop paths; (B) `_gui_tick` drains discard-only when not running; (C) replace queue + epoch. Recommend one for Phase-4.

### MT-22-5 — Interaction with drain cap
Stop with qsize=50_000 (if producible); measure drain time on `stop_current` (main-thread hitch) — may spawn FIND for bounded drain or clear() API.

---

## 7. Expected finding IDs

Format: **`FIND-P222-XX`**

| ID | Title | Sev prior |
|----|-------|-----------|
| FIND-P222-01 | Toggle stop leaves queue undrained → stale apply on restart | **P1** (P0 if wrong trading decision risk) |
| FIND-P222-02 | Post-`stop_current` late put contaminates next session | **P0/P1** |
| FIND-P222-03 | `_gui_tick` refuses drain while not running → silent growth | **P1** |
| FIND-P222-04 | Single queue lifetime without epoch | **P1** design |
| FIND-P222-05 | Full drain on main thread hitches under backlog | **P2** |
| FIND-P222-06 | `task_done` without `join` users (hygiene) | **P3** |

---

## 8. Fix strategy sketch

1. **Mandatory drain helper** `_drain_queue(reason)` called from `stop_current`, both toggle stops, and preferably before `running=True` on start.
2. **`_gui_tick` discard mode:** if not running, drain-and-drop (no apply) — belt and suspenders.
3. **Epoch counter** `self._session_id += 1` on every start/switch; producers get id at connect; tuple becomes `(session_id, msg_type, obj)` or side-channel; consumer drops mismatch.
4. **Optional:** replace `self._queue` with new `Queue()` on switch so old producer holds dead queue (still need stop producer — P2-21).
5. Avoid `queue.Queue.clear` (not in stdlib); drain loop or `mutex` + new queue.

---

## 9. Dependencies

| Dep | Note |
|-----|------|
| **P2-21** | Without solid stop, epoch+drain still fight live producers |
| **P2-13** | Growth model quantifies risk if undrained |
| **P2-14** | Cap interacts with restart backlog |
| **P2-15** | Batching only after messages accepted |
| **P2-17/19** | Late puts after failed join |

---

## 10. Severity priors

| Item | Prior | Source |
|------|-------|--------|
| Stale apply after toggle | **P1** (elevate P0 if demo/trading use) | R16-H4 Medium → product-critical |
| Cross-switch contamination | **P0** visual/data | R10-H3, R20 Z10 |
| Growth while stopped | **P1** mem | R16 §5.1 |
| TOCTOU residual single msg | **P2** | General race |

**Confidence:** **Very high** that toggle path does not drain (code-evident). **High** that restart can apply stale if queue non-empty. **Medium** on how often users hit it without switch_to.
