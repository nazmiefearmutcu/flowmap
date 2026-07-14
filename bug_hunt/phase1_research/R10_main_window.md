# R10 — Main Window Orchestration Analysis

**Phase:** 1 (bug-hunt research)  
**Scope files:**
- `/Users/nazmi/flowmap/flowmap/ui/main_window.py` (~1175 LOC)
- `/Users/nazmi/flowmap/flowmap/ui/toolbar_manager.py`
- `/Users/nazmi/flowmap/flowmap/ui/source_manager.py`
- `/Users/nazmi/flowmap/flowmap/ui/panels/features_dialog.py`

**Related (read for lifecycle/data path):**
- `/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py`
- `/Users/nazmi/flowmap/flowmap/data/crypcodile_live.py`

---

## 1. Window layout composition

### Ownership graph (init)

```
MainWindow
├── ToolbarManager(window, source=None)     # source wired after SourceManager
├── SourceManager(window, toolbar_mgr)      # owns queue, provider, running flag
├── OrderBook(symbol, depth=3000)
├── QTimer _sim_timer (connected, never started; tick is no-op)
├── QTimer _gui_timer (16 ms → _gui_tick)
└── UI tree (below)
```

Circular link pattern:
1. `ToolbarManager(self, None)`
2. `SourceManager(self, toolbar_mgr)`
3. `toolbar_mgr._source = source` (manual back-link)

### Layout tree

```
QMainWindow
├── MenuBar → View (DOM / Icebergs / LLT / Market Pulse)
├── QToolBar (ToolbarManager.create_toolbar)
│   ├── Symbol QLineEdit
│   ├── Start/Stop QPushButton
│   └── Sidebar toggle QPushButton
├── Central QWidget (WA_OpaquePaintEvent)
│   └── QVBoxLayout
│       └── main_splitter (Horizontal)
│           ├── left_container (QGridLayout)
│           │   ├── [0,0] HeatmapWidget          stretch col0=8, row0=5
│           │   ├── [0,1] VolumeProfileOverlay   stretch col1=2
│           │   ├── [1,0] MarketPulse            stretch row1=1
│           │   └── [1,1] pulse_right_spacer
│           └── sidebar QFrame (min 320px)
│               └── QTabWidget
│                   ├── VISUALS (heatmap/BBO/trades/VP toggles)
│                   ├── INDICATORS (LLT/iceberg/stops/pulse)
│                   └── SETTINGS (sidebars, replay mode/speed, centering,
│                                 min size, decay/smooth/sensitivity/bubbles)
├── Docks (Right)
│   ├── DOM Ladder (hidden by default)
│   ├── Significant Icebergs (visible)
│   └── Large Lot Tracker (visible)
└── QStatusBar
```

### Layout notes / drift

| Claim vs code | Finding |
|---|---|
| Docstring: "PriceChart top 22% + Heatmap 78%" | **Stale.** No `PriceChart` is constructed. `price_chart` only referenced defensively in `SourceManager` reset paths. |
| Docstring: "Data sources: Crypcodile Replay" | Partial — default is **LIVE** (`DataSource.CRYPCODILE_LIVE`). |
| Toolbar: replay speed / source combo | Declared on `ToolbarManager` but **never created** in `create_toolbar()`. Speed lives only in sidebar SETTINGS. |
| `FeaturesDetailDialog` | Imported in `main_window.py`, **never instantiated** (dead import / unfinished menu). |

Splitter defaults: sizes `[1180, 320]`, stretch `(8, 1)`.

---

## 2. Start / stop / source change flows

### Boot sequence (`MainWindow.__init__`)

```
_setup_ui() → _setup_docks() → _setup_timers() → _wire_callbacks()
switch_to(current data_source)     # default CRYPCODILE_LIVE → _start_live()
QTimer.singleShot(500, toggle_simulation)  # auto-start
```

- `_gui_timer.start(16)` immediately (~60 FPS).
- `_sim_timer` is wired to `_sim_tick` (pass) but **never started**.

### Data sources

Only two enum values remain:

```python
class DataSource(Enum):
    CRYPCODILE_REPLAY = auto()
    CRYPCODILE_LIVE = auto()
```

Simulator / CCXT paths are residual imports/properties, not switchable from UI.

### Start/stop entry points

| Trigger | Path |
|---|---|
| Toolbar Start/Stop | `ToolbarManager._start_btn.clicked → SourceManager.toggle_simulation` |
| Space key | `MainWindow.keyPressEvent → toggle_simulation` |
| Boot auto-play | `singleShot(500, toggle_simulation)` |
| Replay mode checkbox | `_on_replay_mode_toggled → switch_to(REPLAY\|LIVE)` (stops old, inits new, does **not** auto-start) |
| Symbol edit finish | `on_symbol_changed` (stop → reset → re-init source → optionally re-toggle if was running) |

### `toggle_simulation` branch

- REPLAY → `_toggle_replay`
- LIVE → `_toggle_live`

#### Replay toggle

**Stop path:**
1. `stop_replay()` if present
2. `disconnect()` (which **again** calls `stop_replay()` inside provider)
3. `_running = False`, toolbar Stop→Start UI

**Start path:**
1. If not connected: `connect()` (replay `connect` is lightweight: sets `_connected`, emits `on_connected` → sets `_running=True` **before** data actually streams)
2. Resolve `[start_ns, end_ns]` via `get_time_range`; fallback = last 1 wall-clock hour
3. `start_replay(symbol, start_ns, end_ns, speed)` → new `QThread` + worker
4. Sets `_running=True` again, toolbar state running

#### Live toggle

**Stop:** `disconnect()` (worker stop + `thread.wait(2000)`), clear running  
**Start:** `connect()` only; `_running` set later by `_on_provider_connected` when worker emits connected

### Source switch (`switch_to`)

```
stop_current()
_data_source = source
reset: order_book, pulse, volume_profile, heatmap, (price_chart if any)
_gui_frame = 0; frame_count = 0; _running = False
if REPLAY: _start_replay() else: _start_live()
toolbar update_visibility (no-op); status message
```

`_start_replay` / `_start_live`:
- Construct provider with **shared** `self._queue`
- Connect provider signals → SourceManager handlers
- Do **not** call `connect()` / `start_replay` until user (or boot singleShot) toggles

### Symbol change (`on_symbol_changed`)

```
if empty → restore old text
if changed:
  if was_running or provider exists: stop_current()
  assign symbol; update_thresholds_for_symbol()
  reset book/pulse/vp/heatmap/(price_chart)
  re-_start_replay or _start_live
  if was_running: _toggle_replay / _toggle_live
```

Threshold heuristic: substring match `SOLUSDT` / `ETHUSDT` / else BTC-like defaults for LLT/stops and heatmap engine refs.

---

## 3. Signal wiring between UI and data

### A. Provider → SourceManager (Qt signals)

Wired in `_start_replay` / `_start_live`:

| Signal | Handler | Effect |
|---|---|---|
| `on_snapshot` | `_on_provider_snapshot` | `order_book.apply_snapshot` |
| `on_update` | `_on_provider_update` | `order_book.apply_update` |
| `on_trade` | `_on_provider_trade` | `order_book.record_trade` |
| `on_bbo` | `_on_provider_bbo` | **no-op (`pass`)** |
| `on_connected` | `_on_provider_connected` | `_running=True`, Start→Stop UI |
| `on_disconnected` | `_on_provider_disconnected` | `_running=False`, Stop→Start UI |
| `on_error` | `_on_provider_error` | status bar |
| `replay_progress` | `_on_replay_progress` | status every 30 GUI frames |

Disconnect helper `_disconnect_provider_signals` uses `sig.disconnect()` with no slot (disconnect all).

### B. Worker → queue → GUI timer (actual market data path)

Both providers construct workers with `queue=self._queue`. Worker dispatch is **mutual exclusive**:

```python
if self._queue is not None:
    self._queue.put((msg_type, obj))
else:
    self.sig_*.emit(obj)
```

Because queue is always passed from SourceManager:

- Snapshot/update/trade/bbo **do not emit** worker signals for market data.
- SourceManager’s `on_snapshot` / `on_update` / `on_trade` / `on_bbo` connections for book updates are **dead** for the queue-backed path.
- Only lifecycle/progress signals (connected/disconnected/error/progress) remain live via provider-level re-emits.

### C. GUI drain (`MainWindow._gui_tick`, 16 ms)

Guard: **returns immediately if `not self._source.running`**.

When running:
1. Drain up to 1000 queue messages (`snapshot|update|trade|bbo`)
2. Snapshot clears pending updates/bbos in batch
3. Temporarily null `order_book.on_trade` to avoid double UI work
4. Apply last snapshot / batch updates / last bbo / trades to book
5. Restore `on_trade`
6. Fan-out trades → heatmap, pulse, volume_profile
7. `heatmap.push_snapshot(levels, bbo, ts, cvd)`
8. LLT table refresh; volume_profile.update; DOM levels/bbo
9. Status every 30 frames

### D. OrderBook callbacks

```python
_order_book.on_bbo = _on_bbo   # pass
_order_book.on_trade = _on_trade  # heatmap/pulse/VP — used only when book records trades outside _gui_tick batch path
```

During `_gui_tick` batch apply, trade callback is suppressed; trades applied via bulk `add_trades`.

### E. UI → visualization wiring (sidebar / docks / heatmap)

- Visual toggles → heatmap flags / VP visibility
- Decay, smooth, sensitivity, bubbles, centering, min order size → heatmap engine
- Iceberg dock: `heatmap.iceberg_detected → _on_iceberg_detected` (table, max 100 rows)
- LLT: rebuilt each tick from levels ≥ threshold
- View menu ↔ dock visibility; sidebar checkboxes sync (with `blockSignals`)
- Toolbar sidebar btn ↔ `show_sidebar_cb`

### F. Dead / incomplete wiring

| Item | Status |
|---|---|
| `ToolbarManager._on_source_changed` / `_source_combo` | Method exists; combo never created |
| `ToolbarManager._on_replay_speed_changed` | Not connected (no spinner in toolbar) |
| `update_visibility` / `set_connected_state` | Empty `pass` |
| `on_source_combo_changed` | Empty `pass` |
| `FeaturesDetailDialog` | Import only |
| `_sim_tick` / `_on_bbo` | Empty |
| `SourceManager.simulator` property | Returns `_simulator` which is **never initialized** → would `AttributeError` |

---

## 4. Lifecycle cleanup

### `MainWindow.closeEvent`

```python
def closeEvent(self, event) -> None:
    self._source.stop_current()
    self._gui_timer.stop()
    event.accept()
```

**Does:**
- Provider signal disconnect + stop_replay (if any) + disconnect
- Queue drain attempt
- Stop GUI timer
- Running flag false / toolbar UI reset

**Does not:**
- Stop `_sim_timer` (idle, low risk)
- Cancel pending `QTimer.singleShot(500, toggle_simulation)` if window closed <500 ms after open (race: start after close)
- Explicitly wait/join threads beyond provider `disconnect` waits
- Clear heatmap engine buffers / iceberg & LLT tables
- `deleteLater` provider
- Persist window geometry/state

### `SourceManager.stop_current`

```python
_disconnect_provider_signals(provider)
if stop_replay: stop_replay()
provider.disconnect()   # replay: stop_replay again; live: thread.wait(2000)
_provider = None
# drain queue while not empty
_running = False
toolbar set_start_stop_state(False)
```

Provider thread waits:
- Replay: `QThread.wait(5000)` inside `stop_replay`
- Live: `wait(2000)` inside `disconnect`
- If wait times out, thread may still run while `_provider` is dropped → **orphan thread risk**

### Double-stop on replay

Stop paths often call `stop_replay()` then `disconnect()` → `stop_replay()` again. Currently idempotent-ish (`_worker`/`_thread` nulled), but still redundant.

---

## 5. Settings / state persistence

**None found.**

- No `QSettings`, no `saveState`/`restoreState`, no config file write for UI
- `_historical_hours` stored on window but **never used** in switch/start paths
- Defaults are hardcoded each launch:
  - Symbol / data_dir from ctor args (defaults: `binance-spot:SOLUSDT`, `/Users/nazmi/data`)
  - Replay speed UI: 20.0× (sidebar); SourceManager default `_replay_speed = 20.0`
  - Default source: LIVE
  - Sidebar/dock visibility: fixed defaults
  - Heatmap sliders: decay 92, smooth 10, sensitivity 3000, bubbles 10
- Symbol change and replay mode only mutate in-memory session state

---

## 6. Bug hypotheses

Severity: **H** high / **M** medium / **L** low. Confidence in ( ).

### H1 — Dual data path confusion (dead signal handlers) — **M** (high confidence)

**Evidence:** Workers put only to queue when queue is non-None; SourceManager still connects snapshot/update/trade/bbo signals that never fire for market data. Real path is queue + `_gui_tick`.

**Impact:** Misleading architecture; if someone removes the queue, two full apply paths would double-count. Current behavior is queue-only (signals inert for data).

**Suggested fix:** Either remove dead signal connects for book data when using queue, or remove queue and use Qt signals exclusively—not both patterns.

---

### H2 — `_gui_tick` gated on `running` → drops / freezes UI on edge states — **M** (med)

**Evidence:** `_gui_tick` returns if `not self._source.running`. Late queue messages after disconnect, or data arriving before `on_connected` sets running, are not drained by the timer. `stop_current` drains, but producer races after drain (H3).

**Impact:** Stale queue growth if producer outlives `_running=False` without drain; silent “no UI update” while connected but `_running` false.

---

### H3 — Source switch / stop race with worker puts — **H** (med-high)

**Evidence:** `switch_to` → `stop_current` → disconnect with finite wait → drain → new provider same `queue.Queue` instance.

If old thread still produces after drain (timeout, or put in-flight), new session can apply **stale** snapshots/trades from previous symbol/source.

**Impact:** Ghost book levels, wrong trades, corrupted heatmap history after symbol or REPLAY↔LIVE switch.

**Suggested fix:** Generation token / queue replacement on switch; reject messages with old epoch; always replace queue on `switch_to`.

---

### H4 — Double-start / auto-start race — **M** (med)

**Evidence:**
1. Boot: `switch_to` then `singleShot(500, toggle_simulation)` with no cancel token.
2. User can press Start/Space or flip Replay Mode within 500 ms → second toggle may **stop** auto-start or double-toggle live connect.
3. Symbol change with `was_running` re-calls toggle after re-init.
4. Replay `_toggle_replay` start: `connect()` emits connected (`_running=True`) then `start_replay`; concurrent UI stop can interleave.

**Impact:** Unexpected start/stop, live WS left open while UI says stopped, or vice versa.

---

### H5 — Live vs replay `_running` ownership inconsistency — **M** (high confidence)

| Mode | Who sets `_running=True` on start |
|---|---|
| LIVE | `_on_provider_connected` only (async) |
| REPLAY | `connect()` → connected signal **and** `_toggle_replay` after `start_replay` |

Replay stop sets `_running=False` then `disconnect` may emit `on_disconnected` (again sets false). Live disconnect same.

**Impact:** Toolbar state can flash; for replay, UI shows “running” after lightweight `connect()` even if `start_replay` fails later.

---

### H6 — Resource leak: thread wait timeout + dropped provider — **H** (med)

**Evidence:** `stop_current` nulls `_provider` after `wait(2000|5000)`. No check of `isRunning()`. Worker may still hold queue ref and put forever.

**Impact:** Thread leak, CPU, growing queue memory, cross-talk with new session (H3).

---

### H7 — Queue `task_done` without consumers joining — **L** (high)

**Evidence:** Every `get` calls `task_done()`. Nothing ever `queue.join()`. Harmless unless mismatched get/task_done.

Drain loop `except Exception: break` can leave queue partially full on unexpected errors.

---

### H8 — Hardcoded machine path `/Users/nazmi/data` — **M** (high)

**Evidence:** Defaults in `MainWindow.__init__`, `SourceManager._replay_data_dir`, and fallback list in `_start_replay`.

**Impact:** Other machines fail replay discovery until path exists or is overridden by ctor.

---

### H9 — Symbol threshold / engine config string matching — **M** (med)

**Evidence:** `"SOLUSDT" in self._symbol` etc. Wrong defaults for other symbols (e.g. `SOLUSDC`, alts). Resets normalizer `_initialized = False` on every threshold update.

**Impact:** Wrong LLT/stops/heatmap scale; visual flash on symbol change.

---

### H10 — No close-time cancel of auto-start — **M** (med)

**Evidence:** `closeEvent` does not track/cancel the 500 ms singleShot. Closing quickly can call `toggle_simulation` on a tearing-down window.

**Impact:** Crash or reconnect after close (use-after-close on widgets/status).

---

### H11 — Replay full-range fallback uses wall clock — **H** for correctness (high)

**Evidence:** If `get_time_range` fails, start/end = last 1 hour of **now**, not of dataset. Historical-only lakes yield empty replay while UI looks “running”.

**Impact:** Silent empty replay; user thinks pipeline is broken.

---

### H12 — Iceberg/LLT tables grow with session (bounded but reset missing) — **L**

Iceberg capped at 100 rows; LLT rebuilt to ≤50. On symbol/source switch, tables are **not** cleared (only book/heatmap/pulse/VP reset).

**Impact:** Stale iceberg events from previous symbol remain visible.

---

### H13 — Dead code / AttributeError landmines — **L–M**

- `SourceManager.simulator` → `_simulator` never set
- `FeaturesDetailDialog` unused
- `price_chart` reset branches never run
- Toolbar source combo / replay spinner stubs
- DEBUG stderr stack traces on every `_running` set (noise + perf)

---

### H14 — Double application risk if queue ever disabled — **L** currently

If a future change passes `queue=None`, worker emits signals → SourceManager applies to book **and** any residual queue path could diverge. Today queue-only.

---

### H15 — Space and Start both call same toggle without debounce — **L**

Rapid Space/clicks toggle repeatedly; live reconnect thrash possible (connect/disconnect loops).

---

## 7. Flow summary diagrams

### Happy path — Live boot

```
MainWindow.__init__
  → switch_to(LIVE) → stop_current (noop) → _start_live (provider created, not connected)
  → singleShot 500ms → toggle_simulation → _toggle_live → provider.connect()
  → QThread + LiveWorker
  → on_connected → _running=True, toolbar Stop
  → worker puts (type,obj) → queue
  → _gui_tick drains → OrderBook + Heatmap + Pulse + VP + DOM
```

### Happy path — Replay start

```
switch_to(REPLAY) or already REPLAY
  → _start_replay (provider + subscribe + signals)
  → toggle → connect (immediate on_connected) → start_replay(thread)
  → worker queue puts → _gui_tick
  → replay_progress → status
```

### Stop / switch

```
toggle stop OR switch_to OR symbol change OR closeEvent
  → stop_current
      disconnect signals
      stop_replay / disconnect (thread wait)
      provider=None
      drain queue
      _running=False
  → [switch] reset views → start new provider
```

---

## 8. Priority matrix for Phase 2 validation

| ID | Hypothesis | Validate by |
|---|---|---|
| H3 | Stale queue across switch | Switch symbol/source under load; assert no foreign trades in book |
| H6 | Thread timeout leak | Force slow stop; check `QThread` still running after `stop_current` |
| H4/H10 | Auto-start vs close/toggle | Close <500ms; spam Space during boot |
| H11 | Empty replay range | Point data_dir to old archive; observe empty stream with running UI |
| H2 | Queue not drained when not running | Stop mid-stream; measure queue.qsize growth |
| H1 | Dead signals | Breakpoints on `_on_provider_snapshot` — should not hit with queue set |
| H12 | Table not cleared | Switch symbol after icebergs; rows still old symbol |

---

## 9. Features dialog role

`/Users/nazmi/flowmap/flowmap/ui/panels/features_dialog.py` is a static marketing/help `QDialog` (9 feature cards). **No orchestration role.** Not opened from `MainWindow` (import only). No lifecycle or data coupling.

---

## 10. Key code anchors

| Concern | Location |
|---|---|
| Boot + auto-start | `main_window.py` `__init__` ~L31–62 |
| Layout | `_setup_ui` ~L68–542 |
| Docks | `_setup_docks` ~L544–710 |
| Timers | `_setup_timers` ~L712–715 |
| Queue drain | `_gui_tick` ~L895–973 |
| closeEvent | ~L1172–1175 |
| switch/stop/start | `source_manager.py` `switch_to`/`stop_current`/`_toggle_*` |
| Symbol change | `on_symbol_changed` ~L406–441 |
| Toolbar start | `toolbar_manager.py` `create_toolbar` + `set_start_stop_state` |
| Queue-vs-signal dispatch | `crypcodile_replay.py` ~L510–530; `crypcodile_live.py` ~L175–196 |
| Thread join | replay `stop_replay` wait 5s; live `disconnect` wait 2s |

---

## 11. Bottom line

MainWindow is a **composition root**: layout + docks + 16 ms GUI pump + thin keyboard shortcuts. Real orchestration lives in **SourceManager** (provider lifecycle, queue ownership, start/stop). Toolbar is a thin control strip.

Largest orchestration risks for Phase 2:
1. **Shared unbounded queue** across source/symbol switches without generation fencing  
2. **Finite thread waits** then dropping provider  
3. **Boot singleShot auto-start** without cancellation  
4. **`_running` as sole gate** for draining UI updates  
5. **No settings persistence**; several **dead/stale UI paths** (PriceChart, Features dialog, toolbar source combo, simulator property)

Data path is effectively **queue-only**; SourceManager market-data signal handlers are currently dead code paths when providers are constructed with the shared queue.
