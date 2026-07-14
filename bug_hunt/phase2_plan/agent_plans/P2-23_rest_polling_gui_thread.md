# P2-23 — REST polling on GUI thread

| Field | Value |
|-------|-------|
| **Agent** | P2-23 |
| **Theme n** | 23 |
| **Slug** | `rest_polling_gui_thread` |
| **Zones** | **Z17** (CCXT dual transport) |
| **Sibling fuel** | **R06** H3, H5 (partial), H19; **R16** H5; **R20** P1-02 |
| **Primary module** | `/Users/nazmi/flowmap/flowmap/data/crypto.py` |
| **Secondary** | `data/manager.py` (legacy CryptoProvider wiring), SourceManager (CCXT **not** in current DataSource enum — still ship risk if re-enabled / external) |
| **Track** | B — Concurrency & data plane |
| **Wave** | **W1** (if CCXT path used) / document dead-path if unused |

---

## 1. Scope & linked zones / sibling hyps

### In scope

1. `CryptoProvider._start_polling` / `_poll_tick` runs on **Qt main thread** via `QTimer`.
2. Synchronous `fetch_order_book` + `fetch_trades` block the event loop for full RTT (+ retries).
3. Fallback path: `connect()` when `force_rest` or `ImportError` on `ccxt.pro`.
4. Interaction: GUI freeze → `_gui_tick` delay → queue backlog if other sources exist; EventBus edge cases.
5. Confirm whether production UI can still reach CryptoProvider (enum only LIVE/REPLAY today).

### Out of scope

| Concern | Owner |
|---------|-------|
| CCXT WS identity stall | **P2-24** |
| Crypcodile live asyncio | P2-17 |
| Hist preload blocking GUI in embed | Track D / R02 |

### Sibling map

| ID | Claim |
|----|-------|
| R06-H3 | REST polling blocks Qt main thread — **High** |
| R16-H5 | REST / historical load on GUI — Medium–High |
| R20 P1-02 | REST fetch on GUI thread |
| R06 §3.1 | REST mode timer on provider (main) L496–534 |

### Code anchors

```
crypto.py
  L5        docstring: graceful fallback to REST polling via QTimer
  L321      class doc mentions Polling
  L374      self._poll_timer: Optional[QTimer]
  L387–400  connect: force_rest → _start_polling; else WS, ImportError → REST
  L402–407  disconnect: _stop_websocket + _stop_polling
  L471–488  _start_polling: create ccxt exchange; on_connected; QTimer → _poll_tick
  L490–494  _stop_polling: stop timer; clear exchange
  L496–534  _poll_tick: fetch_order_book + fetch_trades (sync) on caller thread
  L519–528  queue put or signal emit after fetch
```

**SourceManager today:** `DataSource` only `CRYPCODILE_REPLAY` / `CRYPCODILE_LIVE` — CryptoProvider import remains (`source_manager.py` L15). Dead UI path ≠ dead code path (packaging, tests, future re-enable, DataManager).

---

## 2. Threat model

### Assets

| Asset | Failure |
|-------|---------|
| UI responsiveness (16 ms tick, paint, input) | Multi-second beachball |
| Timer accuracy | Cascading delayed QTimers |
| Fairness under multi-window / embed | Whole process freezes |

### Scenarios

| # | Scenario | Impact |
|---|----------|--------|
| S1 | `force_rest=True` + poll_interval 1s + 500 ms RTT | ~50%+ main thread blocked |
| S2 | Network hang (no timeout on fetch) | Hard freeze until TCP timeout (10–60s+) |
| S3 | RateLimitExceeded storm | Error emits OK; still paid latency before except |
| S4 | ImportError → silent fallback to REST in “WS mode” product | User thinks WS; gets freezing REST |
| S5 | Dual fetch (book + trades) sequential | 2× RTT per tick |
| S6 | Queue mode still blocks: put happens **after** fetch on main | Queue does **not** help freeze |

### Non-goals

Proving exchange correctness; only **threading placement** and freeze budget.

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| ST-1 | Confirm `_poll_timer` parented to `CryptoProvider` living on main thread |
| ST-2 | No `moveToThread` for REST path |
| ST-3 | Inventory `force_rest` call sites / config |
| ST-4 | Trace DataManager / tests constructing CryptoProvider |
| ST-5 | Check ccxt default timeouts (`timeout` in `_ccxt_config`) |

### 3.2 Unit / integration

| ID | Steps | Metric |
|----|-------|--------|
| U1 | Mock exchange `fetch_order_book` sleep 200 ms; drive `_poll_tick` on QTest | Main thread blocked ≥200 ms (instrument with timestamp around call) |
| U2 | Mock hang 5s | GUI events not processed (post QEvent, check delivery time) |
| U3 | WS path import fail → assert `_start_polling` called | Fallback behavior |
| U4 | `_stop_polling` mid-fetch | Document: fetch cannot cancel; stop only prevents next timer |

### 3.3 Dynamic

| ID | Steps |
|----|-------|
| D1 | Real REST against public Binance with artificial `poll_interval=0.2` | Measure `QApplication` event latency (input lag) |
| D2 | Airplane mode mid-poll | Freeze duration vs OS TCP timeout |
| D3 | Compare WS path event latency baseline | Control |

### 3.4 GUI

| ID | Action | Fail |
|----|--------|------|
| G1 | Drag heatmap while REST polling | Stutter matching poll RTT |
| G2 | Type in symbol field during poll | Key delay |

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF-1 | No sync network I/O on GUI thread in any CryptoProvider mode | `_poll_tick` does fetch_* on main |
| PF-2 | REST mode keeps event-loop stall p99 < 16 ms excluding intentional test mocks | Stall ≈ RTT |
| PF-3 | Fallback to REST is **visible** in UI/status | Silent ImportError fallback |
| PF-4 | Disconnect cancels in-flight or isolates it off-GUI | Uncancelable main-thread hang |
| PF-5 | If path is dead in product, document + gate test still exists so re-enable doesn't regress | Dead code with known freeze shipped untested |

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| `FakeCcxtExchange` with controllable latency / hang | Unit |
| `force_rest=True` CryptoProvider factory | Integration |
| Event-latency probe widget (`QTimer` 0 ms ping) | Measure GUI stall |
| Optional: `ccxt` offline stub | CI without network |
| Matrix: `poll_interval` ∈ {0.2, 1.0, 5.0} | Perf table |

---

## 6. Phase-3 micro-tasks

### MT-23-1 — Reachability map
Is CryptoProvider reachable from shipped UI, embed, CLI, tests? Output: reachability matrix + risk if dead.

### MT-23-2 — Prove main-thread block
U1 with FakeCcxt; attach stack or timestamps; FIND with file:line.

### MT-23-3 — Timeout / hang characterization
Document default ccxt timeout; airplane-mode freeze duration; FIND if no timeout.

### MT-23-4 — Fix spike design
Worker+queue for REST (mirror WS worker) or `QtConcurrent` / threadpool; API sketch only.

### MT-23-5 — Fallback UX
ImportError path: status string + metric; ensure not silent.

---

## 7. Expected finding IDs

Format: **`FIND-P223-XX`**

| ID | Title | Sev prior |
|----|-------|-----------|
| FIND-P223-01 | `_poll_tick` sync HTTP on GUI thread | **P0** if path live; **P1** if dead-but-shipped |
| FIND-P223-02 | Sequential book+trades doubles block | **P1** |
| FIND-P223-03 | No cancel for in-flight REST on disconnect | **P1** |
| FIND-P223-04 | Silent WS→REST fallback on ImportError | **P1** |
| FIND-P223-05 | Missing/short timeout → multi-minute freeze | **P0/P1** |
| FIND-P223-06 | CryptoProvider still imported but unused (dead risk) | **P2** docs |

---

## 8. Fix strategy sketch

1. **Move REST to QThread worker** identical shape to `_WsWorker`: loop sleep `poll_interval`, fetch, `queue.put`.
2. Provider on main only owns timer **or** better: worker self-paces with asyncio/sleep — **no QTimer fetch**.
3. Set explicit `timeout` in ccxt config (e.g. 5–10 s) and surface errors.
4. On disconnect: set `_running=False`; do not null exchange until worker joined.
5. UI: “REST (fallback)” badge if not WS.
6. If product permanently drops CCXT: quarantine module + tests that fail if reintroduced without thread fix.

---

## 9. Dependencies

| Dep | Note |
|-----|------|
| **P2-24** | Same file; WS path different bug |
| **P2-21/22** | If REST rewired through SourceManager queue |
| **P2-13** | Queue growth if REST floods |
| **P2-17** | Parallel pattern for off-main I/O |

---

## 10. Severity priors

| Item | Prior | Source |
|------|-------|--------|
| REST on GUI | **P0** when used; **P1** latent | R06-H3 High, R20 P1-02 |
| Hang without timeout | **P0** | UX freeze |
| Dead path documentation | **P2** | Product |

**Confidence:** **Very high** code does sync fetch on timer thread affinity = provider = main. **Medium** on production exposure (enum drop).
