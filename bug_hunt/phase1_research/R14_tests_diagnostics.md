# R14 — Existing Tests & Diagnostic Scripts Inventory

**Agent:** R14  
**Date:** 2026-07-13  
**Scope:** `/Users/nazmi/flowmap` tests/diagnostics + Crypcodile FlowMap-related tests  
**Goal:** Catalog coverage, gaps, flaky/env-dependent tests, known failures, Phase 3 regression suite

---

## 1. Executive Summary

| Category | Count | Formal CI-ready? |
|----------|------:|------------------|
| Standalone FlowMap unit tests (`tests/`) | **1 file / 2 cases** | Partial (unittest) |
| Root ad-hoc verify/diagnose/bench scripts | **~20 scripts** | No |
| Scratch exploratory scripts | **~15 Python scripts** | No |
| Crypcodile FlowMap tests | **3 files / 7 cases** | Mixed |
| pytest config / CI test entry for FlowMap | **None** | — |

**Bottom line:** FlowMap is almost untested as a library. The only real unit tests cover `OrderBook.apply_bbo`. Engine, renderer, replay, live, overlays, and GUI are validated only by one-off scripts, screenshots, and Crypcodile CLI/GUI smoke tests. There is no pytest.ini, no `tests/` suite for density/color/replay, and no automated regression gate.

---

## 2. Catalog — Standalone FlowMap

### 2.1 Formal tests (`/Users/nazmi/flowmap/tests/`)

| File | Framework | Cases | Coverage |
|------|-----------|-------|----------|
| `tests/test_bbo_pipeline.py` | `unittest` | `test_apply_bbo_updates_state`, `test_apply_bbo_prunes_stale_levels` | `OrderBook.apply_bbo`: sets best bid/ask/sizes, inserts into `_bids`/`_asks`, prunes crossed/stale levels |

**Not covered by this suite:** snapshot/update/trade APIs, `get_levels`, imbalance, volume delta, mid/spread, reset, concurrency.

**Run:**
```bash
cd /Users/nazmi/flowmap && python -m unittest tests.test_bbo_pipeline -v
```

---

### 2.2 Verification scripts (root) — assert-ish, exit-code capable

| Script | Type | What it covers | Assertions / verdict |
|--------|------|----------------|----------------------|
| `verify_v2.py` | Import + engine smoke | Imports engine/UI; buffer shape; LUT shapes; normalizer range; 50 synthetic ticks → coverage & orientation | Hard asserts: coverage>0.2%, unique colors>10; exit 1 on fail |
| `verify_v4.py` | Headless buffer verify | LUT bid/ask dominance; sim→engine 40 ticks; coverage / alpha bins / orientation | Soft issues list; FAIL if coverage<1% or saturated>98% or no data |
| `verify_comprehensive.py` | GUI widget + PNG | 500 sim ticks into heatmap; buffer zones; PNG analysis | Print-based checklist (old `BookmapHeatmap` API path via alias) |
| `headless_render.py` | Engine→QImage PNG | 60 ticks; save `flowmap_headless_render.png`; dark/red/green/line stats | Print-only analysis |
| `test_heatmap_output.py` | Widget PNG | Bookmap-style checklist (grid, BBO, density) | Pixmap pixel sampling |
| `test_centering_smoothness.py` | Engine centering modes | Compare immediate / deadband / ema / smooth_deadband on synthetic path | Metrics only (n_rolls, jitter, dist_to_mid) — no pass/fail threshold |
| `test_swap.py` | QImage format experiment | ARGB32/RGB32/RGBA8888 byte order | Manual print |
| `test_bgra.py` | QImage.Format dump | List available formats | Manual print |

**Staleness note:** `verify_comprehensive.py` and `test_heatmap_output.py` import `from flowmap.ui.heatmap import BookmapHeatmap`. That is an **alias** to `HeatmapWidget` (`heatmap/__init__.py`). The old renderer class still lives in `heatmap_renderer.py` but is not the primary export. Scripts may partially work if `set_levels`/`set_bbo` still exist on `HeatmapWidget` (they do), but internal field names like `_history` may diverge.

---

### 2.3 Diagnostic scripts (root)

| Script | Intent / hypothesis | Inputs | Outputs |
|--------|---------------------|--------|---------|
| `diagnose_density.py` | Simulator sizes vs normalizer `ref` mismatch (ref too high → washed out) | Sim params + ref sweeps; needs QApplication | Per-ref alpha/coverage stats |
| `diagnose_rendering.py` | Buffer row dump, LUT violations, `_draw_column` blend, bid/ask both-density, purple anomaly RGB | Same as verify_v4 (sim 40 ticks) | Console diagnostics; searches for R=124 G=114 B=151 |
| `diagnose_classification.py` | Why ask rows sparse — snapshot-side vs density-side classification | 60 sim ticks | Bid/ask ratios; imbalanced ticks; rightmost red/green counts |
| `debug_buffer.py` | Live GUI buffer dump after sim | MainWindow + 15s wait | Per-row RGBA dominance on rightmost col |
| `debug_data.py` | Replay price-history jumps >$10 | CrypcodileClient `@ /Users/nazmi/data`, BTCUSDT time window | Jump list from engine history |
| `gui_test.py` | Auto-start sim, grab window+heatmap PNG, analyze colors | Display/Qt GUI | `flowmap_gui_auto.png`, `flowmap_heatmap_widget.png` |
| `profile_heatmap_tmp.py` | cProfile / paint path experiments | Offscreen HeatmapWidget | Profile stats |

**Known diagnostic themes (from script comments + `gui_diag.log`):**
1. Normalizer ref vs simulator volume scale
2. Sparse ask classification / bid-heavy paint
3. Purple/gray anomalous pixels
4. Centering / visible range vs true BBO mismatch

---

### 2.4 Benchmarks

| Script | Target | Notes |
|--------|--------|-------|
| `benchmark_rendering.py` | HeatmapWidget + MainWindow; uncapped vs 60 FPS; 800×600 & 1920×1080 | Offscreen Qt; writes timing; result snapshot in `benchmark_report.json` |
| `benchmark_heatmap_gpu.py` | CPU vs OpenGL `HeatmapWidget` via dual `exec` of source | Fragile (dynamic compile of `heatmap_widget.py`) |
| `scratch/benchmark_rebuild.py` | DensityEngine rebuild / centering microbench | Experimental OptimizedDensityEngine subclass |

**`benchmark_report.json` highlights (historical run):**

| Resolution | Target | Mode | FPS | Max paint (ms) |
|------------|--------|------|-----|----------------|
| 800×600 | HeatmapWidget | Uncapped | ~56 | **269** |
| 800×600 | MainWindow | Uncapped | ~148 | 95 |
| 1920×1080 | HeatmapWidget | Capped 60 | ~26 | **151** |
| 1920×1080 | MainWindow | Capped 60 | ~39 | 156 |

**Implication:** paint spikes and sub-60 capped FPS at 1080p are known performance signals for Phase 3, not pass/fail tests.

---

### 2.5 Scratch scripts (`/Users/nazmi/flowmap/scratch/`)

| File | Role | Env dependency |
|------|------|----------------|
| `test_engine.py` | Real replay → DensityEngine centering steps | `CrypcodileClient(data_dir='/Users/nazmi/data')`, fixed `min_ns` |
| `test_replay.py` | Inspect book_delta record types | Same data dir + timestamps |
| `test_sim.py` | 5 simulator ticks print | None |
| `test_density.py` | Sim→engine buffer row inspect | None |
| `test_symbols.py` | `CrypcodileReplayProvider.load_symbols` | `/Users/nazmi/data` |
| `check_prices.py` | SQL query best bid/ask from book_delta | data dir |
| `debug_book.py` | Print book_delta rows | data dir |
| `debug_v4.py` | Mini sim buffer non_bg per tick | None |
| `debug_vp.py` | Volume profile float-key match after sim | GUI MainWindow |
| `debug_gui.py` | cua-driver click/type symbol (hardcoded PID/window) | Running app + cua-driver |
| `set_speed.py` | cua-driver speed control | Running app |
| `find_flowmap_win.py` | Window discovery | Desktop |
| `inspect_pixels.py`, `inspect_bbo.py` | Offline PNG pixel sampling | External screenshot paths under `.gemini/...` |
| `benchmark_rebuild.py` | Rebuild microbench | None |

**Many scratch scripts hardcode absolute paths** (`/Users/nazmi/data`, Gemini brain screenshot paths, PIDs). Not reusable as regression.

---

### 2.6 GUI state / log artifacts (not tests, useful for known failures)

| Artifact | Signal |
|----------|--------|
| `gui_diag.log` | Live-ish diagnostics dump (see §4) |
| `gui_state*.json`, `new_state*.json`, `get_state.json` | cua-driver window state + base64 screenshots |
| `flowmap_*.png`, `heatmap_*.png`, `test_step_*.png` | Manual visual regression corpus (no automated diff) |
| `benchmark_report.json` | Performance baseline |
| `build/FlowMap/warn-FlowMap.txt` | PyInstaller missing-module noise (Windows modules, etc.) — packaging, not functional tests |

---

## 3. Catalog — Crypcodile FlowMap tests

Path base: `/Users/nazmi/Crypcodile/tests/`

### 3.1 CLI (`test_flowmap.py`)

| Test | Coverage |
|------|----------|
| `test_flowmap_help` | `crypcodile flowmap --help` flags present |
| `test_flowmap_missing_symbol_non_interactive` | Error without symbol when non-interactive |
| `test_flowmap_command_orchestration` | Mocks Process; asserts `run_flowmap_gui` target + args |

**Does not** start real GUI, load data, or assert heatmap correctness.

### 3.2 GUI unit (`gui/test_flowmap_window.py`)

| Test | Coverage | Guards |
|------|----------|--------|
| `test_flowmap_window_initialization` | Window title, symbol on book/source, iceberg dock widgets | `@pytest.mark.skipif(not HAS_GUI_LIBS)`; `QT_QPA_PLATFORM=offscreen` |
| `test_flowmap_window_iceberg_tracking` | Min size filter, table row values, clear | Same |
| `test_flowmap_window_llt_tracking` | LLT table filter/sort BID/ASK | Same |

**Scope:** Crypcodile-embedded `FlowmapWindow` docks (iceberg / large-lot tracker). **Not** standalone `MainWindow`, density engine, or paint.

### 3.3 GUI e2e CUA (`gui/test_flowmap_gui_cua.py`)

| Test | Coverage | Guards |
|------|----------|--------|
| `test_flowmap_gui_cua` | Requires **already-running** "Crypcodile Flowmap Visualizer"; cua-driver list_windows → toggle Auto-Scroll → set symbol ETHUSDT | `pytest.skip` if window missing; needs `cua-driver` on PATH |

**Highly environment-dependent** — not CI-safe without harness that launches app first.

### 3.4 Related (indirect)

Other Crypcodile suites (`client/test_replay.py`, `replay/test_orderbook.py`, exchange book tests) exercise data that FlowMap consumes, but **do not import FlowMap**. Treat as upstream data-layer coverage, not FlowMap regression.

---

## 4. Known failures / diagnostic signals (from logs & scripts)

### 4.1 `gui_diag.log` — live centering / sparsity

```
bbo: bid=65656.0 ask=65656.01
visible_price_range: 65699.8900 - 65701.2700   # ~$44 away from BBO
non_bg_pixels_total: 141
non_bg_pixels_vis: 38
auto_follow: True
```

**Signals for Phase 3:**
- **P0/P1 candidate:** auto_follow / centering leaves visible window far from live BBO → empty heatmap.
- Sparse paint (141 non-bg pixels total) despite full book (500 bids + 500 asks).

### 4.2 Script-documented bug hunts

| Source | Hypothesis / symptom |
|--------|----------------------|
| `diagnose_classification.py` docstring | Ask rows sparse; density-based vs snapshot-based side classification mismatch |
| `diagnose_density.py` docstring | `ref=5000` (or similar) too high for simulator volumes → low alpha |
| `diagnose_rendering.py` | Purple anomaly RGB; dual bid+ask density on same price; non-LUT pixels |
| `scratch/debug_vp.py` | Volume profile float-key mismatch (level prices vs volume dict keys) |
| `debug_data.py` | Large mid-price jumps in engine history during replay (>$10 steps) |
| `benchmark_report.json` | Max paint 100–270 ms spikes; 1080p capped ~26–39 FPS |

### 4.3 Stale / broken tooling risk

| Item | Risk |
|------|------|
| Dual heatmap implementations (`heatmap_widget.py` vs `heatmap/heatmap_renderer.py`) | Old verify scripts may target wrong mental model |
| Scratch hardcoded PID/window_id | Instant fail when app restarts |
| No captured pytest JUnit / failure logs in-repo | Failures live only in agent session history / console |

---

## 5. Coverage map vs production modules

| Module (hotspots from MASTER_PLAN) | LOC-ish | Unit tests | Ad-hoc scripts |
|------------------------------------|---------|------------|----------------|
| `ui/heatmap_widget.py` | ~2349 | **None** | verify/gui/benchmark/profile |
| `ui/main_window.py` | ~1175 | **None** | gui_test, debug_buffer, debug_vp |
| `data/crypcodile_replay.py` | ~961 | **None** | test_engine, debug_data, test_symbols |
| `data/simulator.py` | ~782 | **None** | almost all verify/diagnose |
| `engine/density_engine.py` | ~586 | **None** (verify_v2/v4 soft) | heavy |
| `engine/color_system.py` | — | **None** | verify_v4 LUT checks |
| `engine/normalizer.py` | — | **None** | diagnose_density |
| `core/order_book.py` | — | **apply_bbo only** | used transitively |
| `core/events.py` / config | — | **None** | — |
| `data/crypcodile_live.py` | — | **None** | — |
| `data/crypto.py` / manager / base | — | **None** | — |
| `ui/overlays/*` (VP, VWAP, CVD) | — | **None** | debug_vp only |
| `ui/dom/dom_ladder.py` | — | **None** | — |
| `ui/bubbles.py`, `pulse.py`, `price_chart.py` | — | **None** | — |
| `ui/source_manager.py`, toolbar, theme | — | **None** | — |
| `plugins/*` | — | **None** | — |
| Crypcodile `gui/flowmap_window.py` | — | Init + iceberg + LLT | CUA e2e (manual app) |
| Crypcodile CLI flowmap | — | Help/args/process mock | — |

---

## 6. Gaps (no unit tests for X)

Priority-ordered gaps for bug-hunt / Phase 3:

### P0 — Correctness core
1. **DensityEngine:** `push_snapshot`, decay, history scroll, buffer shape after resize, bid/ask paint separation, center modes (`immediate`/`deadband`/`ema`/`smooth_deadband`)
2. **OrderBook:** `apply_snapshot`, `apply_update`, `record_trade`, crossed-book handling, prune, `get_levels` ordering
3. **BBO pipeline end-to-end:** ticker → book → engine column (only unit-level apply_bbo exists)
4. **Centering vs BBO:** regression for `gui_diag.log` (visible range must include mid)

### P1 — Data sources
5. **CrypcodileReplayProvider:** symbol load, time range, speed/pause, record dispatch (`_dispatch_record` side mapping)
6. **CrypcodileLive:** reconnect, symbol switch, queue backpressure
7. **Simulator:** deterministic seeded invariants (spread>0, bid<ask, depth counts)

### P2 — Render / UI
8. **ColorSystem LUTs:** bid G≥R, ask R≥G, alpha monotonicity (today only in verify_v4 prints)
9. **AdaptiveNormalizer:** fixed_ref, adapt, clamp [0,1]
10. **HeatmapWidget paint path:** QImage format (BGRA/RGBA swap — `test_swap`/`profile` experiments), price axis, auto_follow
11. **Overlays:** volume profile key equality (float), VWAP, CVD accumulation
12. **DOM ladder / bubbles / pulse**

### P3 — Integration / packaging / UX
13. **Standalone MainWindow** source switch sim↔replay↔live
14. **Plugins loader** isolation / path injection
15. **App launch** headless + packaged `dist/FlowMap.app`
16. **Performance budgets** (FPS / paint p99) as soft regression gates

---

## 7. Flaky / environment-dependent tests

| Asset | Why flaky / gated |
|-------|-------------------|
| `gui/test_flowmap_gui_cua.py` | Requires live window + cua-driver; timing sleeps (1–2s); Accessibility |
| `gui_test.py`, `debug_buffer.py` | Real display; wall-clock timers; non-deterministic sim |
| All scripts using `/Users/nazmi/data` | Local dataset + hard-coded nanosecond ranges |
| `scratch/debug_gui.py`, `set_speed.py` | Hardcoded PID/WINDOW_ID |
| `scratch/inspect_*.py` | External absolute screenshot paths |
| `benchmark_*` | CPU load, machine-specific FPS; not deterministic pass/fail |
| `test_centering_smoothness.py` | Stochastic path fixed seed, but **no thresholds** → never fails |
| `verify_v2` density coverage | Uses `np.random.lognormal` without seed → coverage asserts can flake |
| `test_flowmap_window_*` | Skips without PyQt6; offscreen may differ on Linux CI |
| `benchmark_heatmap_gpu.py` | `exec` of full widget source; OpenGL platform dependent |

**CI-safe today (standalone):** essentially only `tests/test_bbo_pipeline.py`  
**CI-safe today (Crypcodile FlowMap):** CLI tests + offscreen window tests if PyQt6 installed

---

## 8. Recommended Phase 3 regression suite

### 8.1 Design principles
- Prefer **pure unit tests** (no Qt) for core math/book/engine.
- Prefer **offscreen Qt** for widget buffer/PNG checks.
- Prefer **fixture-based replay** (small parquet/json in `tests/fixtures/`) over live `/Users/nazmi/data`.
- Gate performance with **budgets**, not absolute FPS equality.
- Convert existing diagnostics into **assertive** tests with seeds.

### 8.2 Suite tiers

#### Tier A — Always-on unit (fast, no Qt) — **must build first**

| Test module (proposed) | Source to lock | Asserts |
|------------------------|----------------|---------|
| `tests/test_order_book.py` | Extend BBO suite | snapshot, delta, trade, prune, crossed, reset, get_levels |
| `tests/test_color_system.py` | From `verify_v4` LUT section | shapes, bid G≥R, ask R≥G, alpha curve |
| `tests/test_normalizer.py` | From `diagnose_density` | clamp, fixed_ref effect, adapt direction |
| `tests/test_density_engine.py` | From `verify_v2`/`v4` + centering | seeded sim; coverage band; top red / bottom green; no dual paint bugs; center modes metrics with thresholds |
| `tests/test_centering_regression.py` | From `test_centering_smoothness` + `gui_diag` | after N ticks, mid within visible range when `auto_follow=True` |
| `tests/test_dispatch_record.py` | `crypcodile_replay._dispatch_record` | side map, BBO from ticker, delta zero-size removes |

**Entry:**
```bash
python -m pytest /Users/nazmi/flowmap/tests -q
# or unittest discovery until pytest added as dev dep
```

#### Tier B — Headless Qt (medium)

| Test module | Based on | Asserts |
|-------------|----------|---------|
| `tests/test_heatmap_buffer.py` | `headless_render` / `verify_v4` | buffer non_bg > threshold after 60 ticks; unique colors > N |
| `tests/test_heatmap_qimage_format.py` | `test_swap` | round-trip pixel R/G not swapped unexpectedly |
| `tests/test_volume_profile_keys.py` | `scratch/debug_vp.py` | float key match after N sim ticks |
| Crypcodile `test_flowmap_window.py` | existing | keep offscreen; add MainWindow smoke if shared |

#### Tier C — Integration (opt-in markers)

| Marker | Tests | Requires |
|--------|-------|----------|
| `@pytest.mark.data` | Replay fixture slice → engine columns | Checked-in mini fixtures |
| `@pytest.mark.gui_cua` | CUA Auto-Scroll / symbol switch | App launch fixture + cua-driver |
| `@pytest.mark.perf` | paint p95 < X ms; capped FPS ≥ Y | Offscreen; machine class |

#### Tier D — Visual / manual (Phase 3 investigation only)
- Reuse PNG corpus + `diagnose_*` when hunting rendering bugs
- Do **not** block CI on screenshot pixel equality without stable fixtures

### 8.3 Concrete Phase 3 regression checklist (minimum)

1. **Unit:** OrderBook BBO prune (existing) + snapshot/update/trade  
2. **Unit:** DensityEngine seeded 40-tick PASS criteria from `verify_v4`  
3. **Unit:** Centering `auto_follow` keeps BBO in viewport (locks `gui_diag.log` failure class)  
4. **Unit:** ColorSystem LUT invariants  
5. **Unit:** AdaptiveNormalizer clamp + ref  
6. **Headless:** HeatmapWidget buffer coverage after sim  
7. **Unit:** `_dispatch_record` + zero-size delta  
8. **Crypcodile:** keep CLI + window iceberg/LLT  
9. **Optional:** CUA e2e behind marker, with app spawn fixture  
10. **Optional:** perf budgets from `benchmark_report.json` as soft thresholds  

### 8.4 Scripts to promote vs retire

| Promote → pytest | Keep as manual diagnose | Retire / rewrite |
|------------------|-------------------------|------------------|
| `verify_v2.py`, `verify_v4.py` | `diagnose_*` | Hardcoded PID scratch GUI scripts |
| `test_centering_smoothness.py` (add thresholds) | `benchmark_*` | External-path `inspect_*.py` |
| BBO pipeline | `gui_test.py` for visual | `verify_comprehensive` if fields diverge (rewrite against HeatmapWidget) |

### 8.5 Suggested directory layout

```
flowmap/tests/
  conftest.py                 # seeds, offscreen Qt fixture
  fixtures/mini_book_slice/   # small recorded deltas (if available)
  test_bbo_pipeline.py        # existing
  test_order_book.py
  test_color_system.py
  test_normalizer.py
  test_density_engine.py
  test_centering.py
  test_replay_dispatch.py
  test_heatmap_headless.py    # @pytest.mark.qt
  test_volume_profile.py
```

Add to `setup.py` extras:
```python
"dev": ["pytest>=7", "pytest-qt>=4"]
```

No `pytest.ini` today — add:
```ini
[pytest]
testpaths = tests
markers =
    qt: needs PyQt6 offscreen
    data: needs fixtures/data dir
    gui_cua: needs cua-driver + live window
    perf: performance budgets
```

---

## 9. Inventory index (absolute paths)

### Formal
- `/Users/nazmi/flowmap/tests/test_bbo_pipeline.py`
- `/Users/nazmi/Crypcodile/tests/test_flowmap.py`
- `/Users/nazmi/Crypcodile/tests/gui/test_flowmap_window.py`
- `/Users/nazmi/Crypcodile/tests/gui/test_flowmap_gui_cua.py`

### Verify / diagnose / bench / root tests
- `/Users/nazmi/flowmap/verify_v2.py`
- `/Users/nazmi/flowmap/verify_v4.py`
- `/Users/nazmi/flowmap/verify_comprehensive.py`
- `/Users/nazmi/flowmap/diagnose_density.py`
- `/Users/nazmi/flowmap/diagnose_rendering.py`
- `/Users/nazmi/flowmap/diagnose_classification.py`
- `/Users/nazmi/flowmap/gui_test.py`
- `/Users/nazmi/flowmap/headless_render.py`
- `/Users/nazmi/flowmap/benchmark_rendering.py`
- `/Users/nazmi/flowmap/benchmark_heatmap_gpu.py`
- `/Users/nazmi/flowmap/benchmark_report.json`
- `/Users/nazmi/flowmap/debug_buffer.py`
- `/Users/nazmi/flowmap/debug_data.py`
- `/Users/nazmi/flowmap/test_centering_smoothness.py`
- `/Users/nazmi/flowmap/test_heatmap_output.py`
- `/Users/nazmi/flowmap/test_swap.py`
- `/Users/nazmi/flowmap/test_bgra.py`
- `/Users/nazmi/flowmap/profile_heatmap_tmp.py`
- `/Users/nazmi/flowmap/gui_diag.log`

### Scratch
- `/Users/nazmi/flowmap/scratch/test_engine.py`
- `/Users/nazmi/flowmap/scratch/test_replay.py`
- `/Users/nazmi/flowmap/scratch/test_sim.py`
- `/Users/nazmi/flowmap/scratch/test_density.py`
- `/Users/nazmi/flowmap/scratch/test_symbols.py`
- `/Users/nazmi/flowmap/scratch/debug_*.py`
- `/Users/nazmi/flowmap/scratch/inspect_*.py`
- `/Users/nazmi/flowmap/scratch/benchmark_rebuild.py`
- `/Users/nazmi/flowmap/scratch/check_prices.py`
- `/Users/nazmi/flowmap/scratch/set_speed.py`
- `/Users/nazmi/flowmap/scratch/find_flowmap_win.py`

---

## 10. Recommendations for other Phase 1 / Phase 2 agents

1. Treat **`gui_diag.log` centering offset** as a top correctness candidate when prioritizing.
2. Do not assume verify scripts are green — several are print-only or unseeded.
3. Phase 3 should **lock diagnose hypotheses into failing unit tests first**, then fix.
4. Crypcodile tests prove **launcher + dock widgets**, not standalone heatmap fidelity.
5. Performance numbers exist (`benchmark_report.json`) but no automated gate — add only after paint path stabilizes.

---

*End of R14 report.*
