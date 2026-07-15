# R02 — Crypcodile-Embedded FlowMap Integration Map

**Agent:** R02  
**Date:** 2026-07-13  
**Scope:** How Crypcodile launches / wraps standalone FlowMap; data feeds; API surface; tests; divergence risks  
**Repos:** `/Users/nazmi/Crypcodile`, `/Users/nazmi/flowmap`

---

## Executive summary

| Question | Answer |
|----------|--------|
| How launched? | CLI `crypcodile flowmap` → `multiprocessing.Process(target=run_flowmap_gui)` → `FlowmapWindow` |
| Vendor or reimplement? | **Neither fully.** Thin subclass + path inject of live standalone package (`sys.path` → `/Users/nazmi/flowmap`). Not a copy tree; not a full reimplementation. |
| Shared feeds? | Live & replay providers live **inside standalone** `flowmap/data/crypcodile_{live,replay}.py` and import Crypcodile. Embedded path adds a **third** historical path: `Catalog.scan` + bin-compress preload. |
| Coupling style | Fragile **filesystem path** coupling, not pip dependency / monorepo package pin. |
| Biggest risks | Hardcoded paths; dual record→event converters; historical preload wiped/ignored on symbol change; auto-live after 500 ms; no package install of `flowmap` in Crypcodile deps. |

---

## 1. Launch path (Crypcodile GUI)

### 1.1 CLI entry

**File:** `/Users/nazmi/Crypcodile/src/crypcodile/cli.py` (~2520–2614)

```
user shell
  └─ typer: crypcodile flowmap [--symbol] [--historical-hours] [--data-dir]
       ├─ resolve_data_dir / interactive symbol selection (book_snapshot channel)
       ├─ require canonical "exchange:symbol" form
       └─ multiprocessing.Process(
              target=run_flowmap_gui,
              args=(symbol, str(data_dir), historical_hours),
              daemon=True
          )
              └─ run_flowmap_gui(...)
                   ├─ faulthandler (SIGUSR1 / SIGINFO on macOS)
                   ├─ QApplication
                   ├─ FlowmapWindow(initial_symbol, data_dir, historical_hours)
                   ├─ win.show()
                   └─ app.exec()
```

**CLI options (public):**

| Option | Default | Role |
|--------|---------|------|
| `--symbol` | interactive / required non-TTY | Canonical symbol e.g. `binance-spot:BTCUSDT` |
| `--historical-hours` | `2.0` | Preload window for `FlowmapWindow.load_historical_data` |
| `--data-dir` | `data` (resolved) | Crypcodile data lake root |

**Process model:**
- Parent process starts daemon child, echoes launch, then `join()` (unless `CRYPCODILE_SHELL=1`).
- KeyboardInterrupt → `terminate()` child.
- GUI is **not** in-process with CLI; separate Python process (macOS/Qt friendly).

### 1.2 Package export

**File:** `/Users/nazmi/Crypcodile/src/crypcodile/gui/__init__.py`

```python
from crypcodile.gui.flowmap_window import FlowmapWindow
__all__ = ["FlowmapWindow"]
```

No other Crypcodile GUI module launches FlowMap (no menu host / main app window found). Grep shows only CLI + `gui/flowmap_window.py` + tests + changelog/docs mentioning bookmap/heatmap product history.

### 1.3 Standalone launch (contrast)

| Path | Entry | Window class |
|------|-------|--------------|
| Standalone | `flowmap.main:main` / `run_flowmap.py` / `flowmap` console script | `flowmap.ui.main_window.MainWindow` title `"FlowMap"` |
| Embedded | `crypcodile flowmap` → `run_flowmap_gui` | `FlowmapWindow` title `"Crypcodile Flowmap Visualizer - [{symbol}]"` |

CUA GUI tests key off **Crypcodile** window title string.

---

## 2. Vendor vs import: architecture

### 2.1 Decision: live import of sibling repo (not vendored)

**File:** `/Users/nazmi/Crypcodile/src/crypcodile/gui/flowmap_window.py` lines 6–12

```python
flowmap_path = "/Users/nazmi/flowmap"   # HARDCODED absolute path
if flowmap_path not in sys.path:
    sys.path.insert(0, flowmap_path)

from flowmap.ui.main_window import MainWindow as StandaloneMainWindow
from flowmap.core import Level2Snapshot, Level2Update, Trade, BBO, Side as FlowmapSide, is_buy_side
```

**Implications:**
- No copy of `flowmap/` under Crypcodile tree.
- No `pip install -e ../flowmap` declared in Crypcodile packaging for this path (setup of standalone is separate: `/Users/nazmi/flowmap/setup.py`).
- Any machine without `/Users/nazmi/flowmap` breaks import at module load time.
- Subclassing means **standalone UI/engine changes apply immediately** (stated intent in class docstring) — also means **standalone regressions hit Crypcodile without a pin**.

### 2.2 What Crypcodile owns vs FlowMap owns

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Crypcodile process (flowmap GUI child)                                  │
│                                                                         │
│  crypcodile.cli.run_flowmap_gui                                         │
│       │                                                                 │
│       ▼                                                                 │
│  crypcodile.gui.flowmap_window.FlowmapWindow  ──inherits──┐             │
│       │  + load_historical_data (Catalog/polars)          │             │
│       │  + dict_to_flowmap_objects                        │             │
│       │  + window title prefix                            │             │
│       ▼                                                   ▼             │
│  ┌─────────────────────────────────────────────────────────────┐        │
│  │ STANDALONE package: flowmap (sys.path /Users/nazmi/flowmap) │        │
│  │  ui.main_window.MainWindow                                  │        │
│  │  ui.source_manager.SourceManager                            │        │
│  │  ui.heatmap_widget / engine.density_engine / core.order_book│        │
│  │  data.crypcodile_live.CrypcodileLiveProvider  ──imports──┐  │        │
│  │  data.crypcodile_replay.CrypcodileReplayProvider ────────┤  │        │
│  └──────────────────────────────────────────────────────────┼──┘        │
│                                                             ▼           │
│  crypcodile.exchanges.factory.make_connector / AiohttpWsTransport       │
│  crypcodile.client.CrypcodileClient / schema.records / store.catalog    │
└─────────────────────────────────────────────────────────────────────────┘
```

**Bidirectional dependency:**
- Crypcodile GUI → imports FlowMap package (path hack).
- FlowMap data providers → optional-import Crypcodile (if not installed, providers emit errors).

This is a **circular runtime coupling** between two repos, not a clean library boundary.

---

## 3. Shared data feeds: live / replay / historical

### 3.1 SourceManager (standalone — used by both)

**File:** `/Users/nazmi/flowmap/flowmap/ui/source_manager.py`

| Enum | Provider | Start |
|------|----------|-------|
| `DataSource.CRYPCODILE_LIVE` (**default**) | `CrypcodileLiveProvider` | `_start_live` → connect on toggle |
| `DataSource.CRYPCODILE_REPLAY` | `CrypcodileReplayProvider` | `_start_replay` → `start_replay` on toggle |

Docstring still mentions “Simulator | Crypcodile Replay | CCXT Live”; enum currently only has **REPLAY** and **LIVE** (simulator/CCXT paths residual/dead vs UI).

**Default startup (MainWindow.__init__):**
1. `self._source.switch_to(self._source.data_source)` → LIVE provider init, **resets** book/heatmap/pulse/VP.
2. `QTimer.singleShot(500, self._source.toggle_simulation)` → auto-start live connect.

### 3.2 Live feed (shared)

**File:** `/Users/nazmi/flowmap/flowmap/data/crypcodile_live.py`

- QThread + asyncio worker.
- `make_connector(exchange, symbols, channels=["trade","book_snapshot","book_delta"], out=FlowMapLiveSink)`.
- `AiohttpWsTransport` if missing.
- Records converted via `_dispatch_record` (from replay module).
- Thread-safe path: puts `("snapshot"|"update"|"trade"|"bbo", obj)` on `queue.Queue`.
- **SSL disabled** via monkeypatch on `aiohttp.ClientSession.ws_connect` (`ssl=False`) — security/divergence note.
- Exchange kwargs: binance `market`, bybit `category`, okx `region="global"`.

Consumed on GUI thread by `MainWindow._gui_tick` (drain ≤1000 msgs/frame).

### 3.3 Replay feed (shared standalone path)

**File:** `/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py`

- `CrypcodileClient.replay()` in background worker.
- Speed control, pause, progress signal.
- Typed Records → FlowMap core types via `_dispatch_record` / helpers.
- Time range: `get_time_range(data_dir, symbol)` or fallback last 1 hour wall clock.
- Used when UI source is REPLAY — **not** the same code path as Crypcodile’s CLI historical preload.

### 3.4 Embedded historical preload (Crypcodile-only)

**File:** `/Users/nazmi/Crypcodile/src/crypcodile/gui/flowmap_window.py`  
**Methods:** `load_historical_data`, module-level `dict_to_flowmap_objects`

Pipeline:

1. `Catalog(data_dir)`.
2. `end_ns` = max trade `local_ts` for symbol (SQL string interp) or `time.time_ns()`.
3. `start_ns = end_ns - historical_hours * 1e9`.
4. `catalog.scan("book_snapshot"|"book_delta"|"trade", symbol, start_ns, end_ns)` → polars.
5. Merge/sort by `local_ts`; normalize bids/asks (dict or tuple).
6. Bin into `bw = heatmap._engine.get_buffer().shape[1]` equal-time bins.
7. Per bin: apply L2/trade to `_order_book`; `heatmap.add_trades`; `push_snapshot` once per bin.
8. Gap-fill from last DB ts to now (or full reset if gap ≥ buffer width).

**Called only once** from `FlowmapWindow.__init__` if `historical_hours > 0`, **after** `super().__init__` (so after LIVE switch_to reset, before 500 ms live start).

### 3.5 Feed comparison matrix

| Concern | Standalone LIVE | Standalone REPLAY | Crypcodile CLI embedded |
|---------|-----------------|-------------------|-------------------------|
| L2 source | WS connector | Client.replay | Preload: Catalog.scan; then LIVE WS |
| Converter | `_dispatch_record` (typed) | `_dispatch_record` | **`dict_to_flowmap_objects`** (dict) + later LIVE `_dispatch_record` |
| Temporal resolution | event-level | event-level @ speed | **compressed to heatmap width bins** |
| Liquidation channel | via record tag | yes | **not scanned** in preload |
| book_ticker/BBO | live path can emit | yes | preload: no BBO channel scan |
| Auto-start | 500 ms live | if switched | same MainWindow auto-live |
| Symbol change | restarts provider | restarts provider | **does not re-run load_historical_data** |

---

## 4. API surface

### 4.1 Crypcodile → FlowMap (public / integration)

| Symbol | Location | Role |
|--------|----------|------|
| `FlowmapWindow` | `crypcodile.gui.flowmap_window` | Subclass of standalone `MainWindow` |
| `FlowmapWindow.__init__(initial_symbol, data_dir, historical_hours)` | same | Title + optional historical |
| `FlowmapWindow.load_historical_data(data_dir, symbol, historical_hours)` | same | Catalog bin preload |
| `dict_to_flowmap_objects(event: dict) -> list` | module function | Dict channel → core types |
| `run_flowmap_gui(symbol, data_dir, historical_hours)` | `cli.py` | Process target |
| `crypcodile flowmap` | typer command | User entry |
| `crypcodile.gui.FlowmapWindow` | package export | Import convenience |

### 4.2 FlowMap core types used by embedder

From `flowmap.core` (also re-exported via package):

- `Level2Snapshot`, `Level2Update`, `Trade`, `BBO`, `Side`, `is_buy_side`
- Order book API used by preload: `apply_snapshot`, `apply_update`, `record_trade`, `apply_bbo`, `get_levels`, `get_volume_delta`, `reset`, `.symbol`, `.bbo`
- Heatmap: `add_trades`, `push_snapshot(levels, bbo, ts, cvd=)`, `reset`, `_engine.get_buffer()`
- Pulse / VP: `reset`, `add_trades`, `update`

### 4.3 FlowMap → Crypcodile (providers)

| Provider API | Live | Replay |
|--------------|------|--------|
| `connect` / `disconnect` | yes | yes |
| `subscribe` / `unsubscribe` | no-op | yes |
| Signals: `on_snapshot`, `on_update`, `on_trade`, `on_bbo`, `on_connected`, `on_disconnected`, `on_error` | yes | yes |
| `start_replay` / `stop_replay` / `set_speed` / `get_time_range` / `load_symbols` / `replay_progress` | n/a | yes |
| Crypcodile imports | `make_connector`, `AiohttpWsTransport`, `InstrumentRegistry`, `Sink`, `Record` | `CrypcodileClient`, schema records/enums |

### 4.4 MainWindow public-ish methods inherited by FlowmapWindow

(From standalone `main_window.py` — relevant to tests / integration)

| Method | Notes |
|--------|-------|
| `_on_iceberg_detected` | Used by unit tests |
| `_clear_iceberg_table` | Used by unit tests |
| `_update_llt_table` | Used by unit tests |
| `set_cvd_visible` | UI |
| `closeEvent` | stops source + timer |
| `_gui_tick` | queue drain + render push |
| Docks: `_iceberg_dock`, `_llt_dock`, `_iceberg_table`, `_llt_table`, spins | asserted by tests |

FlowmapWindow does **not** override symbol-change, live toggle, or closeEvent — all inherit.

### 4.5 Channel mapping (`dict_to_flowmap_objects`)

| `event["channel"]` | Output |
|--------------------|--------|
| `book_snapshot` | `[Level2Snapshot]` (filter size>0) |
| `book_delta` + `is_snapshot=True` | `[Level2Snapshot]` |
| `book_delta` (incremental) | `[Level2Update, ...]` BID/ASK |
| `trade` | `[Trade]` side via `is_buy_side`; size from `amount` or `size`; liquidation flag |
| other | `[]` |

Parallel typed path in `_dispatch_record` also maps `book_ticker` → BBO and `liquidation` → Trade(is_liquidation=True). **Dict path does not.**

---

## 5. Test coverage & gaps

### 5.1 Existing tests

| File | What it covers | Strength |
|------|----------------|----------|
| `/Users/nazmi/Crypcodile/tests/test_flowmap.py` | CLI help flags; non-interactive missing symbol; Process orchestration target/args | Good for CLI glue |
| `/Users/nazmi/Crypcodile/tests/gui/test_flowmap_window.py` | Init title/symbol; iceberg table filter/clear; LLT table filter/sort | UI docks only; needs PyQt6 |
| `/Users/nazmi/Crypcodile/tests/gui/test_flowmap_gui_cua.py` | Live window: Auto-Scroll toggle, symbol text field → ETHUSDT (cua-driver) | Manual/running-window; skips if no window |

Standalone: `/Users/nazmi/flowmap/tests/test_bbo_pipeline.py` (+ many scratch/manual scripts) — not Crypcodile package tests.

### 5.2 Coverage gaps (high value for bug-hunt)

| Gap | Why it matters |
|-----|----------------|
| **No unit tests for `dict_to_flowmap_objects`** | Dual converter drift vs `_dispatch_record` |
| **No tests for `load_historical_data`** | Binning, gap-fill, empty catalog, polars edge cases |
| **No mock Catalog / empty data_dir** | Init currently hits real scan paths (exceptions swallowed) |
| **No test that historical survives live start** | Race with 500 ms auto-live |
| **No symbol-change re-historical** | Behavioral bug candidate |
| **No SQL injection / symbol sanitization** | f-string in Catalog query |
| **No import-path failure test** | Missing `/Users/nazmi/flowmap` |
| **No multiproc crash / ImportError path** | `run_flowmap_gui` swallows ImportError to stderr |
| **No contract tests** FlowMap heatmap `push_snapshot` signature vs embedder call | API drift |
| **CUA test** assumes human-started window; not CI-deterministic without fixture process |
| **No replay mode tests** through Crypcodile CLI | CLI always LIVE after historical |
| **SSL monkeypatch** untested / unflagged | Security & multi-process side effects |
| **Daemon process + join** edge cases | parent exit, orphan GUI |

---

## 6. Divergence risks vs `/Users/nazmi/flowmap`

### 6.1 Structural / packaging (P0–P1)

| Risk | Detail |
|------|--------|
| **Hardcoded `flowmap_path = "/Users/nazmi/flowmap"`** | Non-portable; breaks other users/CI machines; no env var override. |
| **Hardcoded default `data_dir="/Users/nazmi/data"`** | Same in MainWindow and SourceManager defaults. |
| **No version pin** | Subclass inherits HEAD of sibling checkout; silent behavioral churn. |
| **Circular optional imports** | FlowMap providers optional-import crypcodile; Crypcodile GUI hard-requires flowmap path. |
| **Not installed as editable dep** | `setup.py` of flowmap doesn’t list crypcodile; Crypcodile doesn’t vendor flowmap. |

### 6.2 Dual conversion / data correctness (P0–P1)

| Risk | Detail |
|------|--------|
| **`dict_to_flowmap_objects` vs `_dispatch_record`** | Parallel logic; delta-as-snapshot, side maps, liquidations diverge. |
| **Historical bin compress vs event replay** | Preload loses intra-bin L2 path; heatmap columns ≠ event truth. |
| **Gap-fill holds last book** | Can paint stale depth into “now” columns until live arrives. |
| **SQL f-string symbol** | `WHERE symbol = '{symbol}'` — injection / quote breakage. |
| **Bids/asks normalization only in preload** | Live/replay assume typed tuples; catalog rows may differ. |

### 6.3 Lifecycle / UI (P1–P2)

| Risk | Detail |
|------|--------|
| **Historical only at construct** | Symbol change / source switch does not reload catalog history. |
| **`switch_to` resets heatmap** | Switching LIVE↔REPLAY clears preloaded history. |
| **Auto live 500 ms** | Standalone & embedded always auto-start LIVE; CLI historical_hours can race live snapshots. |
| **Title vs symbol field** | Window title set once in FlowmapWindow; symbol edits may update toolbar/status but title may stale unless MainWindow updates it (verify in phase 3). |
| **DEBUG prints / stack traces** | SourceManager `_running` setter prints stack to stderr — noise/perf in embedded mode. |

### 6.4 Security / ops (P1–P2)

| Risk | Detail |
|------|--------|
| Live SSL verification disabled globally on ClientSession | Affects whole process. |
| Multiprocessing daemon GUI | Parent die may kill GUI abruptly; no IPC for status. |

### 6.5 Dead / misleading surface

| Item | Note |
|------|------|
| CHANGELOG / PROJECT.md “Bookmap” naming | Product history; code is FlowmapWindow only (pycache had bookmap_window remnants historically; no current `.py`). |
| SourceManager docstring “three sources” | Enum is two. |
| `DataManager` / simulator / crypto providers | Present in package; not default MainWindow path. |

---

## 7. Known TODOs / FIXMEs / debug debt

**Crypcodile `gui/`:** no `TODO`/`FIXME` comments found.

**FlowMap package (relevant to integration):**

| Location | Kind | Note |
|----------|------|------|
| `flowmap/data/base.py` | NOTE | QObject vs ABCMeta constraint |
| `flowmap/ui/source_manager.py` | DEBUG | `print` + `traceback.print_stack` on `_running`; DEBUG prints in `switch_to`, `_start_replay`, `start_replay` |
| Live SSL monkeypatch | undocumented risk | not marked TODO |
| Hardcoded paths | multiple | MainWindow, SourceManager, FlowmapWindow |

No formal TODO list for dual converter consolidation or packaging.

---

## 8. Integration diagram (sequence)

```
CLI parent                          GUI child process
─────────                          ────────────────
flowmap(symbol, hours, dir)
  Process.start ──────────────────► run_flowmap_gui
                                      QApplication
                                      FlowmapWindow.__init__
                                        │
                                        ├─ super(MainWindow).__init__
                                        │    OrderBook, SourceManager(LIVE),
                                        │    heatmap/pulse/VP/docks
                                        │    switch_to(LIVE)  → reset UI state
                                        │    QTimer 500ms → toggle_simulation
                                        │
                                        ├─ setWindowTitle("Crypcodile …")
                                        │
                                        └─ load_historical_data  (if hours>0)
                                             Catalog.scan → bins → push_snapshot*
                                      show()
                                      [~500ms]
                                      _toggle_live → CrypcodileLiveProvider.connect
                                           QThread asyncio make_connector
                                           queue ← records
                                      _gui_tick drains queue → book/heatmap
```

\* Historical push uses same heatmap API as live `_gui_tick`.

---

## 9. File inventory (integration-critical)

### Crypcodile

| Path | Role |
|------|------|
| `src/crypcodile/gui/flowmap_window.py` | Embed wrapper (~254 lines) |
| `src/crypcodile/gui/__init__.py` | Export |
| `src/crypcodile/cli.py` (`flowmap`, `run_flowmap_gui`) | Launch |
| `src/crypcodile/store/catalog.py` | Historical scan (used by preload) |
| `tests/test_flowmap.py` | CLI tests |
| `tests/gui/test_flowmap_window.py` | Unit GUI |
| `tests/gui/test_flowmap_gui_cua.py` | CUA e2e |

### FlowMap (consumed)

| Path | Role |
|------|------|
| `flowmap/ui/main_window.py` | Base window |
| `flowmap/ui/source_manager.py` | LIVE/REPLAY lifecycle |
| `flowmap/data/crypcodile_live.py` | Live bridge |
| `flowmap/data/crypcodile_replay.py` | Replay + `_dispatch_record` |
| `flowmap/data/base.py` | DataProvider signals |
| `flowmap/core/__init__.py` + `order_book.py` | Types + book |
| `flowmap/ui/heatmap_widget.py` | `push_snapshot` / trades |
| `flowmap/main.py` | Standalone entry |
| `setup.py` | Package metadata (no crypcodile hard dep) |

---

## 10. Recommended phase-2/3 focus (integration class #8)

1. **Replace hardcoded path** with env `FLOWMAP_HOME` / editable install; fail clearly.
2. **Unify converters** — single module shared by preload dict path and typed `_dispatch_record` (or preload via Client.replay batch without wall-clock sleep).
3. **Tests:** pure unit matrix for converters; Catalog mock historical; init+live survival; symbol change policy.
4. **Document product mode:** CLI = “historical snapshot columns + live tail” vs standalone REPLAY = full event playback.
5. **Remove or gate** SSL monkeypatch and SourceManager DEBUG stack dumps.
6. **Pin** flowmap version/commit when embedded from Crypcodile releases.

---

## 11. Answers checklist (GOAL mapping)

1. **Launch:** `crypcodile flowmap` → multiprocessing → `FlowmapWindow` (subclass of standalone MainWindow). No in-app menu host.
2. **Vendor/copy?** No. **Live sys.path import** of sibling `/Users/nazmi/flowmap` + thin subclass + historical preload logic.
3. **Feeds:** Live/replay providers shared inside FlowMap calling Crypcodile; embedded adds Catalog bin-preload then auto-LIVE.
4. **API surface:** `FlowmapWindow`, `load_historical_data`, `dict_to_flowmap_objects`, CLI `run_flowmap_gui`; providers’ DataProvider signals + Crypcodile factory/client.
5. **Test gaps:** converters, historical load, path/import, multiproc, replay via CLI, contract of heatmap APIs, CUA fixture.
6. **Divergence risks:** path hardcoding, dual converters, binning vs event fidelity, lifecycle resets, unpinned sibling, SSL patch, debug noise.

---

*End of R02 report.*
