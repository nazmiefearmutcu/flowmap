# R16 — Concurrency, Threading & Qt Thread Safety Audit

**Scope:** `/Users/nazmi/flowmap/flowmap/` + `/Users/nazmi/crypcodile/src/crypcodile/gui/flowmap_window.py`  
**Phase:** Bug-hunt Phase 1 (research only)  
**Date:** 2026-07-13

---

## 1. Executive summary

FlowMap uses a **producer/consumer architecture**:

| Role | Mechanism | Thread |
|------|-----------|--------|
| Market data producers | `QThread` + `moveToThread` workers | Background |
| Optional asyncio I/O | `asyncio` event loop *inside* worker thread | Same background QThread |
| Cross-thread data path | `queue.Queue` (primary) + `pyqtSignal` (status/errors) | BG → Main |
| UI consumer | `QTimer` ~16 ms (`MainWindow._gui_tick`) | Main / GUI |
| Control plane | Direct method calls + a few QueuedConnections | Mixed — **risky** |

**Good patterns present:**

- Workers are plain `QObject`s moved onto `QThread` (not subclassing `QThread.run` for logic).
- Hot-path market data is funneled through a thread-safe `queue.Queue` and drained only on the GUI timer.
- Workers do **not** hold references to widgets; UI updates happen in `MainWindow` / `SourceManager` on the main thread when using the queue path.

**Critical risks:**

1. **Blocking work owns the QThread** — `started → worker.start()/run_replay()` never returns to the thread event loop while running; `QThread.quit()` cannot stop a stuck loop by itself.
2. **Teardown with finite `wait()` then dropping refs** — live: 2 s; crypto/replay: 5 s. Timed-out threads keep running while Python refs become `None` → dangling QThread / worker / asyncio loop.
3. **Cross-thread direct method calls** on worker (`stop()`, `pause()`, `resume()`) instead of always using QueuedConnection / `QMetaObject.invokeMethod`.
4. **Unbounded `queue.Queue`** + high-speed replay → memory growth / GUI lag / freeze.
5. **REST polling (`CryptoProvider`) does blocking I/O on the GUI thread**.
6. **`EventBus` fallback** can invoke main-thread handlers on a worker thread if the dispatcher is missing.
7. **`_gui_tick` skips draining when `not running`** — late producer puts after stop can sit until next start/stop drain (or race with switch).

---

## 2. Inventory: concurrency primitives

### 2.1 `QThread` / `moveToThread`

| File | Class | Pattern |
|------|-------|---------|
| `data/crypto.py` | `CryptoProvider` + `_WsWorker` | `QThread` parented to provider; worker `moveToThread`; `started → start` |
| `data/crypcodile_live.py` | `CrypcodileLiveProvider` + `_LiveWorker` | Same |
| `data/crypcodile_replay.py` | `CrypcodileReplayProvider` + `_ReplayWorker` | Same (`started → run_replay`) |

No other `QThread` usage under `flowmap/`.

### 2.2 `asyncio`

| File | Usage |
|------|--------|
| `data/crypto.py` | New loop per `_WsWorker.start()`; `run_until_complete(_run)`; `run_coroutine_threadsafe(exchange.close)` from `stop()` |
| `data/crypcodile_live.py` | New loop per `_LiveWorker.start()`; `run_until_complete(_run)`; `run_coroutine_threadsafe(transport.close)` from `stop()` |

### 2.3 `threading` / locks / events

| File | Primitive | Role |
|------|-----------|------|
| `core/events.py` | `threading.RLock` | Protect subscriber lists |
| `core/events.py` | `threading.main_thread()` / `current_thread()` | Decide main-thread dispatch |
| `data/crypcodile_replay.py` | `threading.Event` (`_pause_event`) | Pause/resume replay loop |

No `threading.Thread` (stdlib) producers in FlowMap — only Qt threads + Event/RLock.

### 2.4 `queue.Queue`

| File | Role |
|------|------|
| `ui/source_manager.py` | Single shared `self._queue = queue.Queue()` (unbounded) |
| `data/crypto.py`, `crypcodile_live.py`, `crypcodile_replay.py` | Workers `put(("snapshot"\|"update"\|"trade"\|"bbo", obj))` when `queue is not None` |
| `ui/main_window.py` | `_gui_tick` drains up to 1000 msgs/frame via `get_nowait` |

### 2.5 `QTimer` (main thread unless noted)

| Location | Interval / mode | Purpose |
|----------|-----------------|---------|
| `MainWindow._gui_timer` | 16 ms, continuous | Drain queue + paint pipeline |
| `MainWindow._sim_timer` | wired to `_sim_tick` (no-op); **never started** | Dead path |
| `MainWindow` | `singleShot(500, toggle_simulation)` | Auto-start live/replay after open |
| `HeatmapWidget` | `singleShot(50, _deferred_rebuild)` | Throttle rebuilds |
| `MarketPulse._throttle_timer` | 33 ms | CVD paint throttle |
| `DomLadder._update_timer` | single-shot ~50 ms | DOM paint throttle |
| `MarketSimulator._timer` | tick interval | Emits sim data on **GUI** thread |
| `CryptoProvider._poll_timer` | poll interval | REST poll on **GUI** thread |

### 2.6 Signals / slots (cross-thread)

Worker → provider (AutoConnection → Queued when different threads):

- Data: `sig_snapshot/update/trade/bbo` → `on_*.emit` (bypassed when queue mode)
- Lifecycle: `sig_connected/disconnected/error/progress/finished`

Provider-owned:

- `CrypcodileReplayProvider.sig_set_speed → _worker.set_speed` (Queued after move)

### 2.7 Not found

- No `QMutex` / `QReadWriteLock` / `QWaitCondition`
- No `ThreadPoolExecutor` / `concurrent.futures`
- No `asyncio` on the main thread
- `flowmap_window.py` adds **no** threads of its own

---

## 3. Thread architecture diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
##  MAIN / GUI THREAD  (QApplication event loop)
│
│  MainWindow
│    ├─ _gui_timer ──16ms──► _gui_tick
│    │                         ├─ drain SourceManager._queue (≤1000)
│    │                         ├─ OrderBook.apply_* / record_trades
│    │                         ├─ heatmap / pulse / VP / DOM / LLT
│    │                         └─ status (every 30 frames)
│    ├─ _sim_timer (dead)
│    ├─ HeatmapWidget QTimer.singleShot rebuilds
│    ├─ MarketPulse 33ms throttle
│    └─ DomLadder single-shot throttle
│
│  SourceManager (QObject, parent=MainWindow)
│    ├─ owns queue.Queue  ◄──────────────────────────────────────────┐
│    ├─ owns active DataProvider                                     │
│    ├─ stop_current / switch_to / toggle_*  (main thread)           │
│    └─ signal slots (_on_provider_*) → widgets / OrderBook          │
│         (status path; data path mostly unused when queue set)      │
│
│  CrypcodileReplayProvider / CrypcodileLiveProvider / CryptoProvider
│    ├─ live on main thread affinity
│    ├─ create QThread(self) + Worker (no parent)
│    ├─ worker.moveToThread(thread)
│    ├─ connect worker signals → provider signals
│    └─ connect() / disconnect() / start_replay() / stop_replay()
│
│  EventBus (singleton, optional use)
│    └─ MainThreadDispatcher (QObject) for publish→GUI handlers
│
│  MarketSimulator / Crypto REST: QTimer callbacks ON THIS THREAD
└──────────────────────────────────────────────────────────────────────────┘
                │ started signal                  ▲ pyqtSignal (Queued)
                │                                 │ connected/error/progress
                ▼                                 │ (data signals if no queue)
┌──────────────────────────────────────────────────────────────────────────┐
##  WORKER QThread  (one of: Live / Replay / CCXT-WS)
│
│  _LiveWorker.start()
│    └─ asyncio.new_event_loop()
│       └─ run_until_complete(_run)
│            ├─ make_connector + AiohttpWsTransport
│            ├─ FlowMapLiveSink.put → _on_record
│            └─ queue.put(...)  ───────────────────────────────────────┘
│
│  _ReplayWorker.run_replay / start_replay
│    └─ blocking CrypcodileClient.replay, list(records), sleeps
│       ├─ threading.Event pause gate
│       └─ queue.put(...)  ───────────────────────────────────────────┘
│
│  _WsWorker.start()
│    └─ asyncio loop + ccxt.pro watchers + _sender_loop (~33 Hz)
│       └─ queue.put(...)  ───────────────────────────────────────────┘
│
│  NOTE: While start()/run_replay() runs, this thread has NO active
│  Qt event loop processing — only after the slot returns.
└──────────────────────────────────────────────────────────────────────────┘

  crypcodile/gui/flowmap_window.py
    FlowmapWindow(StandaloneMainWindow)
      └─ load_historical_data() SYNCHRONOUS on GUI thread at __init__
         (polars/catalog scan + bin push) — no extra threads
```

---

## 4. Which threads touch Qt widgets?

### 4.1 Forbidden pattern search

| Path | Touches widgets from BG thread? | Notes |
|------|----------------------------------|-------|
| Worker `queue.put` | No | Pure Python queue |
| Worker `sig_*.emit` for data | No direct widget; Qt queues to receiver | Receivers are provider/SourceManager on main |
| Worker `sig_error` / progress | Main (queued) → `status.showMessage` | OK if AutoConnection works |
| `_gui_tick` | Main only | Correct |
| `SourceManager._on_provider_*` | Intended main | Updates OrderBook, toolbar, status |
| `EventBus.publish` fallback | **Possible BG** | If no dispatcher / no `QCoreApplication` |
| `CryptoProvider._poll_tick` | Main | Blocking network freezes UI |
| `flowmap_window.load_historical_data` | Main | Long sync work freezes UI |

**Conclusion:** The designed hot path does **not** paint widgets from workers. Residual risk is (a) EventBus fallback, (b) any future direct signal connection that does heavy UI without queue, (c) calling provider disconnect while slots still fire during teardown.

### 4.2 Dual path: queue vs signals

When `queue is not None` (always true from `SourceManager`):

```text
Worker → queue.put  only for market objects
Worker → signals still used for connected / disconnected / error / progress / finished
```

Yet `SourceManager` still connects:

- `provider.on_snapshot/update/trade/bbo → _on_provider_*`

Those data signals are **not emitted** in queue mode (workers branch on `self._queue`). Dead dual wiring — low risk today, high confusion if someone removes the queue branch later → **double apply** on OrderBook.

---

## 5. Timer vs worker race conditions

### 5.1 `_gui_tick` vs producer

```python
# main_window.py
def _gui_tick(self):
    if not self._order_book or not self._source.running:
        return   # ← does NOT drain queue
    # drain ≤1000, apply batch...
```

| Scenario | Effect |
|----------|--------|
| Producer faster than 1000 msgs / 16 ms | Backlog grows; latency climbs; possible OOM |
| Snapshot then many updates in same drain | Snapshot clears prior updates in the batch — good |
| Trades after snapshot in same batch | Applied after snapshot — good |
| `running=False` while producer still alive (failed stop) | Queue fills; GUI ignores until drain on stop/switch |
| `stop_current` drains then disconnect | Window between drain and thread death can re-fill queue |

### 5.2 GUI timers vs heatmap rebuild

- `_gui_tick` pushes snapshots every frame with data.
- `request_rebuild_throttled` / `singleShot(50)` can rebuild mid-interaction.
- Race is same-thread re-entrancy risk only (paint vs rebuild), not multi-thread — still can cause jank if rebuild is heavy.

### 5.3 Pulse / DOM timers vs `_gui_tick`

All main-thread. Throttles reduce `update()` spam. Safe concurrency-wise; possible stale paint if levels mutate between timer schedule and fire (benign).

### 5.4 Auto-start `singleShot(500)` vs historical load

`FlowmapWindow.__init__` runs `load_historical_data` **before** the event loop processes the 500 ms start. Order is deterministic: history first, then later live connect. Risk is **UI freeze duration**, not a thread race. If load is huge, user sees hung window before first paint.

### 5.5 Simulator timer vs live sources

Simulator not in current `SourceManager` `DataSource` enum (only REPLAY/LIVE). `_sim_timer` is vestigial.

---

## 6. Start / stop / teardown races

### 6.1 Common lifecycle (all three workers)

```text
connect/start_replay:
  worker = Worker(...)
  wire signals
  thread = QThread(provider)
  worker.moveToThread(thread)
  thread.started.connect(worker.blocking_entry)
  thread.finished.connect(thread.deleteLater)
  thread.start()

disconnect/stop_replay:
  worker.stop()          # DIRECT call from main onto worker object
  thread.quit()
  thread.wait(timeout)   # 2s live / 5s crypto & replay
  worker = None
  thread = None
```

### 6.2 Why `quit()` is weak here

`QThread.quit()` asks the **thread’s event loop** to exit. The worker’s blocking entry is invoked from `started` and **holds the thread** until asyncio/replay finishes. The Qt loop only runs after that returns.

So stop depends entirely on:

| Worker | Cooperative stop |
|--------|------------------|
| Replay | `_running=False` + `pause_event.set()`; loop checks flags between sleeps |
| Live | `_running=False` + `transport.close()` via `run_coroutine_threadsafe` — **does not cancel `connector.run()` tasks explicitly**; hope close unblocks |
| Crypto WS | `_running=False` + `exchange.close()` via threadsafe — watcher loops check `_running` after exceptions/sleeps |

If close/replay hangs past `wait()`:

1. Refs nulled → **orphaned QThread + worker + open sockets**.
2. Late `sig_*` may fire into partially torn-down provider (queued slots).
3. `deleteLater` on thread may run while Python wrapper gone — classic crash territory.

### 6.3 Live-specific

- `wait(2000)` is the shortest timeout — most likely orphan path under flaky network.
- Monkeypatch of `aiohttp.ClientSession.ws_connect` is **process-global** (class attribute). Concurrent or multi-provider use mutates global SSL behavior.
- `stop()` does not set loop stop or cancel all tasks; if `transport` is None, only sets flag.

### 6.4 Replay-specific

- `start_replay` if already replaying calls `stop_replay()` then immediately creates a new worker — OK if stop joins; bad if wait times out.
- Entire book/trade history loaded with `list(book_iter)` / `list(trade_iter)` on worker → long `_running` true before first emit; stop only helps after load if client is stuck in I/O.
- Auto-loop: when replay finishes one pass, outer `while self._running` reloads and restarts — stop during load must be cooperative.
- `pause()` / `resume()` / `stop()` are **direct cross-thread** writes to `_running` / Event (GIL makes bool+Event mostly OK; not a Qt-safe pattern for QObject methods).

### 6.5 Crypto-specific

- WS stop similar to live with 5 s wait.
- REST mode: timer stopped on main; `fetch_*` can block GUI for full RTT.

### 6.6 `SourceManager.stop_current`

```text
disconnect signals (all receivers)
stop_replay if present
provider.disconnect()
provider = None
drain queue
running = False
```

Issues:

- Signal disconnect is blanket `sig.disconnect()` — OK.
- If `disconnect()` times out internally, queue drain may miss late puts.
- `switch_to` → `stop_current` then reset widgets then start new provider — good ordering if stop is solid.
- `_toggle_replay` stop path: `stop_replay` + `disconnect` without always going through full `stop_current` drain in all branches — `_toggle_replay` does not drain queue itself (relies on disconnect→stop_replay only). **Stale queue entries remain until next `stop_current` or are applied if `running` stays true.**  
  Actually on stop: sets `_running = False` after disconnect — so `_gui_tick` stops applying, but **queue not drained** on toggle stop. Next start can apply **stale** book updates.

### 6.7 `DataManager` (legacy / alternate path)

- `old.deleteLater()` after disconnect — good if disconnect joined threads.
- Not used by current `MainWindow`/`SourceManager` path (parallel API).

### 6.8 `closeEvent`

```python
self._source.stop_current()
self._gui_timer.stop()
event.accept()
```

No guarantee worker threads finished; app can exit with running QThreads → **exit crash / abort**.

---

## 7. Hypotheses: freezes, segfaults, `QObject::startTimer` warnings

### H1 — Orphaned QThread after timed-out `wait()`  
**Symptom:** Crash on exit, intermittent segfault, “QThread: Destroyed while thread is still running”.  
**Evidence:** `wait(2000|5000)` then `self._thread = None`; `finished → deleteLater` may still fire.  
**Severity:** High.

### H2 — Blocking `connector.run()` / ccxt not interrupted by `transport.close`  
**Symptom:** UI stop button hangs up to wait timeout; subsequent reconnect creates second thread.  
**Evidence:** Live/crypto stop only closes transport/exchange; no task cancellation / `loop.call_soon_threadsafe(loop.stop)`.  
**Severity:** High.

### H3 — Unbounded queue + fast replay  
**Symptom:** Memory climb, multi-second UI freezes, beachball.  
**Evidence:** `queue.Queue()` unbounded; replay speed default 20×; drain cap 1000/frame.  
**Severity:** High for replay.

### H4 — Stale queue after stop/toggle without drain  
**Symptom:** Wrong book after restart; jump to old prices; “ghost” trades.  
**Evidence:** `_toggle_replay` / `_toggle_live` stop sets `running=False` without draining; only `stop_current` drains.  
**Severity:** Medium.

### H5 — REST / historical load on GUI thread  
**Symptom:** Hard freeze, “Application not responding”, delayed paints.  
**Evidence:** `CryptoProvider._poll_tick` uses sync `fetch_order_book`/`fetch_trades`; `FlowmapWindow.load_historical_data` scans all history in `__init__`.  
**Severity:** Medium–High (UX freeze, not necessarily crash).

### H6 — `QObject::startTimer: Timers cannot be started from another thread`  
**Symptom:** Qt warning + silent timer failure / later crash.  
**Plausible causes in this codebase:**
1. Creating or starting a `QTimer` on an object whose thread affinity is not the current thread.
2. Emitting a signal that creates/starts timers in a slot that runs on the wrong thread (mis-parented QObject).
3. `EventBus` calling a GUI handler on a worker (fallback path) that then starts a timer or calls `update()`/widget APIs.
4. Using `QTimer.singleShot` from a worker (not present today; risk if added).
5. Destroying QObject that owns timers while cross-thread events still pending (`deleteLater` races).

**Current code:** All known QTimers are parented to main-thread widgets/providers. **Most likely trigger is teardown race (H1) or EventBus fallback (H7), not normal path.**  
**Severity:** Medium (when it appears).

### H7 — `EventBus` main_thread handler runs on worker  
**Symptom:** Random UI corruption, startTimer warnings, rare segfault.  
**Evidence:** `publish` fallback `handler(event)` when dispatcher is None or no `QCoreApplication`. Dispatcher only constructed on main thread; first publish from BG before main init → fallback.  
**Severity:** Low–Medium (bus barely used in UI path today; exported singleton).

### H8 — Cross-thread direct `stop()` on QObject living in worker thread  
**Symptom:** Subtle state corruption; rare Qt warnings about timers/signals.  
**Evidence:** `stop` is `@pyqtSlot` but invoked as plain Python call from main.  
**Severity:** Low–Medium (flags/Event mostly OK under GIL).

### H9 — Signal delivery after provider/window destruction  
**Symptom:** “wrapped C/C++ object of type … has been deleted”; segfault.  
**Evidence:** Worker can emit after `provider = None`; AutoConnection queues slots to deleted receivers if not disconnected/waited. `stop_current` does disconnect provider signals but worker may still emit to provider intermediate signals.  
**Severity:** Medium on fast switch/close.

### H10 — Replay loads entire history into memory on worker  
**Symptom:** Multi-minute “start” delay; system memory pressure; macOS jetsam.  
**Evidence:** `records = list(book_iter)` + full trade list + multi-pass alignment.  
**Severity:** Medium (perf/freeze of *data* start, GUI may still timer-spin empty).

### H11 — `_gui_tick` disables `on_trade` only partially  
**Symptom:** Inconsistent side effects if other callbacks fire; not primarily a thread bug.  
**Evidence:** Sets `on_trade = None` during batch; `on_bbo` left active during `apply_bbo`. Same-thread only.  
**Severity:** Low.

### H12 — Global aiohttp SSL monkeypatch  
**Symptom:** Other code in process gets `ssl=False`; surprising TLS behavior / rare connection failures.  
**Evidence:** `ClientSession.ws_connect` patched once per process in live worker.  
**Severity:** Low for standalone FlowMap; higher if embedded.

---

## 8. File-by-file notes

### `ui/main_window.py`
- Owns GUI cadence; sole legitimate consumer of the queue for rendering.
- Early-return when not `running` skips drain (H4 interaction).
- `closeEvent` incomplete join (H1).

### `ui/source_manager.py`
- Central concurrency hub: queue ownership + provider lifecycle.
- Connects data signals even under queue mode (dead dual path).
- Toggle stop does not drain queue (H4).

### `data/crypcodile_live.py`
- Asyncio-in-QThread; shortest wait; weak cancel (H1/H2).

### `data/crypcodile_replay.py`
- Blocking worker + pause Event; full materialization (H3/H10).
- `set_speed` correctly uses signal; stop/pause do not.

### `data/crypto.py`
- WS path mirrors live; REST path GUI-blocking (H5).
- Conflation sender ~33 Hz — good for queue pressure vs raw watch.

### `data/simulator.py`
- Main-thread QTimer producer; fine if used alone; not in current source enum.

### `data/manager.py`
- Alternate manager with `deleteLater`; ensure disconnect joins before delete.

### `core/events.py`
- RLock + optional Qt dispatcher; fallback is the footgun (H6/H7).

### `core/order_book.py`
- No locks; **must** stay main-thread only. Current design OK if only `_gui_tick` + main slots touch it.

### `crypcodile/.../flowmap_window.py`
- Thin subclass; historical preload is sync main-thread work (H5).
- Inherits all FlowMap concurrency behavior unchanged.

---

## 9. Recommended fix directions (research only — not implemented)

1. **Hard stop protocol:** From main, `QMetaObject.invokeMethod(worker, "stop", Qt.QueuedConnection)` + `loop.call_soon_threadsafe` cancel-all + `thread.quit()` only after cooperative exit; on timeout, `terminate()` last resort + never null refs until `finished`.
2. **Bounded queue** (`Queue(maxsize=N)`) with drop-oldest or conflate-on-full for book snapshots.
3. **Always drain queue** on any stop path (`stop_current`, toggles, close).
4. **Keep `_gui_tick` able to drain** even when not running (or drain in stop only — pick one consistently).
5. **Move REST / historical load** off GUI (worker + queue, or processEvents-friendly chunking).
6. **Worker lifetime:** parent worker to thread or explicit `worker.deleteLater()` after `finished`; disconnect all worker signals before nulling.
7. **EventBus:** construct dispatcher at app start on main; never call GUI handlers on fallback from BG (log + drop).
8. **Remove dead data-signal wiring** when queue mode is mandatory, or make queue/signal mutually exclusive in API.

---

## 10. Quick reference: threads that exist at runtime

| Thread name (conceptual) | Created by | Lifetime |
|--------------------------|------------|----------|
| Main / GUI | Qt app | Process |
| `crypcodile-live-*` worker QThread | `CrypcodileLiveProvider.connect` | connect → disconnect |
| `crypcodile-replay` worker QThread | `CrypcodileReplayProvider.start_replay` | start_replay → stop_replay |
| `*-ws` worker QThread | `CryptoProvider._start_websocket` | connect → disconnect |

Typically **at most one** data worker if SourceManager enforces single provider; failed teardown can leave extras (H1/H2).

---

## 11. Confidence

| Area | Confidence |
|------|------------|
| Inventory completeness under `flowmap/` | High |
| Queue-first UI safety of paint path | High |
| Teardown / quit / wait hazards | High |
| EventBus currently in live UI path | Medium (exported; little direct use) |
| Exact segfault stack for startTimer | Medium (hypotheses grounded in patterns) |

---

*End of R16 report.*
