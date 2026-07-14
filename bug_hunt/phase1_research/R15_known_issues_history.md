# R15 — Known Issues History (Debug Artifact Mining)

**Agent:** R15  
**Date:** 2026-07-13  
**Scope:** `/Users/nazmi/flowmap` historical debug artifacts + `/Users/nazmi/Crypcodile` FlowMap-related mentions  
**Method:** grep for FIXME/TODO/HACK/BUG/workaround; review `gui_diag.log`, `gui_state*.json` / `new_state*.json`; `verify_*.py` / `diagnose_*.py` / `scratch/*`; Crypcodile `CHALLENGE_REPORT.md`, `progress.md`, flowmap GUI/tests.

---

## Executive summary

FlowMap has **almost no classic `TODO`/`FIXME` markers** in production source. Historical issues live instead in:

1. **Diagnostic/verify scripts** at repo root (`verify_*`, `diagnose_*`, `debug_*`, `test_centering_smoothness.py`)
2. **GUI state dumps** (`gui_diag.log`, `gui_state*.json`, `new_state*.json`)
3. **Inline defensive comments** (centering, single-color heatmap, flicker, stale queue)
4. **Replay workarounds** (trade↔book price alignment hacks in `crypcodile_replay.py`)
5. **Leftover `[DEBUG]` prints** still in production UI code

**Crypcodile `CHALLENGE_REPORT.md` does not mention FlowMap** (it covers Base/x402 hardening only). FlowMap integration risks are code-level (hardcoded paths, SQL interpolation, dual-window ownership).

---

## 1. Historical bugs — status matrix

| ID | Issue | Evidence artifact | Still present? | Severity |
|----|--------|-------------------|----------------|----------|
| H-01 | **BBO / engine center / visible range desync** | `gui_diag.log` | **Likely YES** | P0 |
| H-02 | **Near-empty heatmap (sparse pixels)** | `gui_diag.log`, `verify_*`, `diagnose_*` | **Likely YES** (esp. live/replay BTC) | P0 |
| H-03 | **Single-color heatmap** (bid/ask LUT collapse) | `density_engine.py:372` comment | **Mitigated** (separate LUTs) | was P1 |
| H-04 | **Centering jitter / vertical jump** | `test_centering_smoothness.py`, README claims, engine modes | **Partially mitigated** (`smooth_deadband` default); risk on rebuild | P1 |
| H-05 | **Normalizer ref vs order size mismatch** (washed-out colors) | `diagnose_density.py` | **Risk YES** — `bid_ref`/`ask_ref` defaults **20000** in `EngineConfig` vs older 3000/8000 | P1 |
| H-06 | **Bid/ask row classification sparsity** | `diagnose_classification.py` | Unclear; script assumes snapshot-size classification | P2 |
| H-07 | **Volume profile float key mismatch** | `scratch/debug_vp.py` | **Mitigated** (`round(price, 6)` in VP) — residual risk if other code paths skip round | P2 |
| H-08 | **Trade price vs book price scale/offset** | `crypcodile_replay.py` static + dynamic alignment | **Workaround still present** (rewrites trade prices to BBO/mid) | P1 |
| H-09 | **Trade↔book timestamp warp** | same file (`scale_factor` mapping) | **YES** — intentional but can distort bubbles/VP time | P2 |
| H-10 | **Stale data on source switch** | `source_manager.py` drain comment | Mitigated (queue drain) | was P2 |
| H-11 | **Color flicker from adaptive norm** | `normalizer.py` EMA alpha comment | Mitigated (slow EMA) | was P2 |
| H-12 | **BBO prune / stale book levels** | `tests/test_bbo_pipeline.py` | Covered by tests; logic present | regression-sensitive |
| H-13 | **Replay “No data dir” / wrong symbol UX** | `gui_state_replay_ready.json`, `gui_state.json` | **YES** — status bar shows `No data dir`; symbol field inconsistency (BTC/USDT vs binance-spot:BTCUSDT) | P1 |
| H-14 | **Hardcoded FlowMap path in Crypcodile** | `flowmap_window.py:7` `/Users/nazmi/flowmap` | **YES** | P1 (portability) |
| H-15 | **SQL string interpolation (symbol/date)** | `crypcodile_replay.py`, Crypcodile `flowmap_window.py` | **YES** | P2 security |
| H-16 | **Leftover debug logging in paint / source switch** | `heatmap_renderer.py`, `source_manager.py` | **YES** | P3 (perf/noise) |
| H-17 | **Dual heatmap implementations** | `heatmap_widget.py` vs `heatmap/heatmap_renderer.py` | **YES** — risk of fixing wrong path | P2 maintainability |
| H-18 | **Marker list growth / lag** | prune comments in `heatmap_widget.py` | Mitigated (prune expired) | was P2 |
| H-19 | **Iceberg dock memory growth** | `main_window.py` “Limit rows to 100” | Mitigated | was P3 |
| H-20 | **Striated / non-continuous topography** | `verify_comprehensive.py` checks | Monitor via verify script | P2 visual |

---

## 2. Artifact deep-dives

### 2.1 `gui_diag.log` (smoking gun)

```
bbo: bid=65656.0 ask=65656.01
engine_center_ticks: 6570058   # ≈ 65700.58 at tick_size 0.01
visible_price_range: 65699.8900 - 65701.2700
non_bg_pixels_total: 141
non_bg_pixels_vis: 38
auto_follow: True
widget_size: 1300x557  row_height: 4
```

**Interpretation:**

| Quantity | Value | Problem |
|----------|-------|---------|
| Book BBO mid | ~65656 | Real market mid |
| Engine center | ~65700.58 | ~**44 USD** above BBO |
| Visible window | ~1.38 USD wide around center | **Does not contain BBO** |
| Non-bg pixels | 141 total / 38 visible | Heatmap essentially empty |

With `auto_follow: True` this should not happen if centering tracks mid. Suggests one or more of:

1. **Tick / render_tick_size wrong** (`center_price_ticks` computed with different tick than book prices)
2. **Center frozen from earlier snapshot / rebuild** while BBO updated from live/replay without re-centering
3. **Levels sparse around true mid** so drawn density sits elsewhere, but BBO lines would still be off-screen
4. **History rebuild precompute center** (`heatmap_widget` rebuild loop) diverges from live push path

**Status:** Treat as **open P0** until repro + assert: `|mid - center_price|` within deadband of visible rows.

Related code still present:

- Centering modes in `flowmap/engine/density_engine.py` (`immediate` / `deadband` / `ema` / `smooth_deadband`)
- Rebuild precompute in `flowmap/ui/heatmap_widget.py` (~L634+)
- Default mode: `EngineConfig.centering_mode = "smooth_deadband"`

---

### 2.2 JSON GUI state dumps (summary — no full dumps)

| File | Snapshot meaning (from tree metadata) |
|------|----------------------------------------|
| `gui_state.json` | FlowMap up; Source=Crypcodile Replay; symbol `binance-spot:BTCUSDT`; Price: 65600.26; Start button; REPLAY |
| `gui_state_replay_ready.json` | Same source; symbol field `BTC/USDT`; status **`[REPLAY] BTC/USDT \| No data dir`** |
| `gui_state_after_select*.json` | Post source/symbol UI interactions |
| `gui_state_stopped.json` | Stopped session |
| `new_state*.json` / `new_state_current.json` | Later UI; sidebar VISUALS tabs; replay progress 62%; Stop; mixed symbol display (`binance-spot:BTCUSDT` vs placeholder SOLUSDT) |
| `dropdown_state.json` / `menu_state.json` | Menu/dropdown accessibility trees |
| `get_state.json` | Generic accessibility + screenshot b64 |

**Recurring UX issues from dumps:**

- **Data dir resolution failures** (“No data dir”)
- **Symbol format inconsistency** (`BTC/USDT` vs `binance-spot:BTCUSDT` vs placeholder SOL)
- Many dumps include large `screenshot_png_b64` — useful for visual regression, not for code history

---

### 2.3 Verify / diagnose scripts — intended contracts

#### `verify_comprehensive.py`
Checklist (still authoritative for visual correctness):

| Check | Pass criterion |
|-------|----------------|
| Top zone | ASK / red-dominant density |
| Bottom zone | BID / green-dominant density |
| Unique colors | `> 50` else **FAIL** |
| Accumulation | p95 brightness `> 3×` avg |
| BBO centered | mid in **25–75%** vertical band else **WARN** |
| Zone coverage | top/bot non-bg `> 3%` else **FAIL** |
| PNG | non-bg `> 5%`; continuous topo (not striated) |

#### `verify_v2.py`
- Import + buffer shape + LUT shape asserts
- Coverage `> 0.2%`, unique colors `> 10`
- Orientation: top red-dominant, bottom green-dominant

#### `verify_v4.py`
- BID green≥red / ASK red≥green LUT invariants
- Fail on: no data, coverage `< 1%`, saturation `> 98%`

#### `diagnose_density.py`
- Explicit hypothesis: **normalizer `ref` too high for simulator sizes** → low alpha / washed heatmap
- Current defaults drifted: `EngineConfig.bid_ref/ask_ref = 20000` (higher than older 3000/5000/8000 mentions) — **increases washout risk** for small-size crypto books

#### `diagnose_classification.py`
- Hypothesis: **snapshot size classification** makes ask rows sparse vs density-accumulator classification
- Still references `_bid_density` / `_ask_density` (present in engine)

#### `diagnose_rendering.py`
- Row-by-row buffer analysis; purple/equal RGB rows = bad blending

#### `test_centering_smoothness.py`
- Benchmarks jitter metrics across centering modes (`mean_jitter`, `max_jump`, `avg_dist_to_mid`)
- Documents the product goal: **low vertical jitter without losing mid**

#### `scratch/debug_vp.py`
- Historical bug: VP `_levels` prices vs `_volumes` keys **float mismatch** → empty bars
- Production `volume_profile.py` now uses `price_key = round(price, 6)` consistently

#### `debug_buffer.py` / `scratch/inspect_pixels.py` / `scratch/inspect_bbo.py`
- Pixel-level debug of ask/bid orientation and BBO y-mapping after GUI start

---

### 2.4 Code comments as “known issue ledger”

| Location | Comment intent |
|----------|----------------|
| `density_engine.py:372` | Separate bid/ask color mapping to **avoid single color heatmap bug** |
| `density_engine.py:119` | Running min tick to **avoid vertical scaling jumps** |
| `density_engine.py:253` | Clear rightmost column after shift (ghost column artifact) |
| `normalizer.py` | Slow EMA **to avoid color flicker** |
| `heatmap_renderer.py:244` | Skip repaint **to avoid flicker** |
| `source_manager.py:194` | Drain queue **to prevent stale updates** |
| `heatmap_widget.py:634` | Precompute center **to avoid vertical rolling during rebuild** |
| `heatmap_widget.py:1749/1805` | Prune markers **to prevent lag** |
| `bubbles.py` | Clamp radii so trades don’t dominate screen |
| `main_window.py:1119` | Cap iceberg table rows |

These are **fixed-in-place defenses**, not open TODOs — but they mark regression hotspots.

---

### 2.5 Crypcodile FlowMap integration

| Item | Detail |
|------|--------|
| `CHALLENGE_REPORT.md` | **No FlowMap content** (Base/x402 only) |
| `progress.md` | Generic “Audit TODOs” checkbox — not FlowMap-specific |
| `gui/flowmap_window.py` | Hardcodes `flowmap_path = "/Users/nazmi/flowmap"` and default `data_dir="/Users/nazmi/data"` |
| Historical load | Bins events into heatmap width; SQL via Catalog with interpolated `symbol` |
| Tests | `tests/test_flowmap.py` (CLI orchestration only); `tests/gui/test_flowmap_window.py` (iceberg/LLT docks); `tests/gui/test_flowmap_gui_cua.py` (Auto-Scroll + symbol search) |
| `cli.py` `flowmap` | Spawns separate process running FlowmapWindow |

**Integration risks still present:**

1. Machine-local path hardcoding  
2. Historical preload swallows exceptions to stderr only  
3. Trade alignment / timestamp warp only in standalone replay path — Crypcodile historical bin path may **not** apply same alignment → **divergent bubble placement** between `crypcodile flowmap` and standalone Replay  

---

## 3. Recurring issue patterns

### Pattern A — Vertical alignment stack (highest recurrence)

**Actors:** `center_price_ticks`, `render_tick_size`, `row_height`, `auto_follow`, BBO mid, VP rows, bubble y, price axis.

**Symptoms seen historically:**

- BBO not in visible band (`gui_diag.log`)
- VP bars not lining up with heatmap rows (`debug_vp`)
- Bubbles off-price after replay (`price_shift` / dynamic align)

**Why it recurs:** Multiple independent y-mappers (engine buffer row math vs widget paint vs VP grid vs pulse/CVD) with float price keys and rebuild/scroll paths that recompute center differently.

**Bug-hunt probes:**

1. Assert mid within deadband of center when `auto_follow`  
2. Assert VP row prices equal heatmap visible prices (tick-rounded)  
3. Assert trade y uses same `price_to_row` helper as engine  

### Pattern B — Centering jitter vs lag tradeoff

- `immediate` → max tracking, max jitter  
- `deadband` → jumps when threshold crossed  
- `ema` / `smooth_deadband` → smooth but lag (center can trail mid; if lag > half viewport → H-01)

Default is `smooth_deadband` with `deadband_pct=0.35`, `ema_alpha=0.05`. Aggressive lag under trending BTC can push BBO off-screen **without** a hard snap if drift logic fails or rebuild freezes center.

### Pattern C — Color / intensity collapse

| Sub-issue | Cause | Artifact |
|-----------|-------|----------|
| Single color | Shared LUT / bid-ask mix | Fixed: separate LUTs |
| Washed out | `ref` ≫ book sizes | `diagnose_density`, refs=20000 |
| Too sparse | classification / low levels in view | `diagnose_classification`, `gui_diag` pixel counts |
| Flicker | fast adaptive norm | EMA 0.05 |

### Pattern D — Replay data fidelity hacks

`crypcodile_replay.py` still implements:

1. **Static avg trade vs avg book shift**  
2. **Dynamic per-trade snap to best bid/ask or mid** (overwrites true trade price)  
3. **Linear timestamp remapping** of trade range onto book range  

These are **workarounds for desynced lake channels**, not pure playback. Side effects: bubbles pile on BBO; VP distorted; research of true trade prints becomes invalid.

### Pattern E — Source / symbol / data-dir UX fragility

State dumps show repeated:

- Empty data dir  
- Symbol alias confusion  
- Heavy `[DEBUG]` prints while resolving dirs  

### Pattern F — Dual code paths

- `HeatmapWidget` (main, large file) vs `heatmap/heatmap_renderer.py` (still has Debug PaintEvent prints)  
- Crypcodile embedded historical binning vs standalone replay worker  
- Risk: fix lands in one path only  

---

## 4. Unresolved TODOs / incomplete work

### Explicit TODO/FIXME in FlowMap package
**None found** in `flowmap/**/*.py` (grep).

### Implicit unfinished / debt (still in tree)

| Debt | Location | Notes |
|------|----------|-------|
| Production `[DEBUG]` / `[DEBUG_RUNNING]` prints | `source_manager.py` | stderr noise; should be logger |
| `[Debug PaintEvent]` prints every paint | `heatmap/heatmap_renderer.py` | FPS killer if path used |
| Trade price rewrite as permanent design | `crypcodile_replay.py` | Needs config flag or correct lake timestamps/prices |
| Hardcoded absolute paths | Crypcodile `flowmap_window.py` | Breaks non-`nazmi` machines |
| SQL f-string queries | replay + Crypcodile historical | Catalog quote-escape known issue class in Crypcodile tests |
| `EngineConfig` ref defaults (20000) vs docstrings (3000/8000) | `engine/config.py`, `density_engine` docs | Inconsistent tuning |
| `diagnose_classification` proposed density-based fix | root diagnose script | Not clearly promoted to production as sole path |
| README architecture lists `types.py` | README | May be stale vs `events.py` |
| `progress.md` (Crypcodile) open “Audit TODOs” | not FlowMap-specific | — |
| CHALLENGE docs for FlowMap | **missing** | No adversarial report for visualizer |

### Verify asserts still encoding open acceptance criteria

From `verify_comprehensive.py` / `verify_v4.py` — treat failures as **open product bugs** if still failing on current main:

- unique colors ≤ 50 → **FAIL**  
- zone coverage ≤ 3% → **FAIL**  
- PNG coverage ≤ 5% → **FAIL**  
- BBO outside 25–75% → **WARN** (should upgrade to FAIL given H-01)  
- coverage < 1% or > 98% → **FAIL** (v4)

---

## 5. Recommended bug-hunt priority (from history)

| Priority | Target | Why history says so |
|----------|--------|---------------------|
| P0 | BBO vs center vs visible range (`gui_diag` class) | Empty chart + wrong price window |
| P0 | Live/replay BTC pixel coverage | Same log: 38 vis pixels |
| P1 | Centering modes under trend + rebuild | Multiple scripts exist solely for this |
| P1 | Replay trade alignment honesty | Hides real prints; bubbles/VP wrong |
| P1 | Data dir / symbol resolution | Repeated in GUI dumps |
| P1 | Crypcodile hardcoded path | Integration broken off-machine |
| P2 | Normalizer ref auto-tune for crypto size scales | `diagnose_density` |
| P2 | Single paint path / remove dead debug renderer | Dual heatmap |
| P2 | SQL parameterization | Security class |
| P3 | Strip DEBUG prints | Noise / paint spam |

---

## 6. Artifact inventory (mined)

### FlowMap root diagnostics
- `gui_diag.log`
- `verify_comprehensive.py`, `verify_v2.py`, `verify_v4.py`
- `diagnose_density.py`, `diagnose_classification.py`, `diagnose_rendering.py`
- `debug_buffer.py`, `debug_data.py`
- `test_centering_smoothness.py`, `test_heatmap_output.py`
- `scratch/debug_vp.py`, `scratch/test_engine.py`, `scratch/inspect_*.py`, `scratch/benchmark_rebuild.py`
- `gui_state*.json`, `new_state*.json`, `dropdown_state.json`, `menu_state.json`, `get_state.json`
- `bug_hunt/MASTER_PLAN.md` (taxonomy: correctness, race, leak, FPS, **jitter/flicker**, UX, data source, integration)

### Crypcodile
- `src/crypcodile/gui/flowmap_window.py`
- `tests/test_flowmap.py`, `tests/gui/test_flowmap_window.py`, `tests/gui/test_flowmap_gui_cua.py`
- `CHALLENGE_REPORT.md` (no FlowMap)
- `progress.md` (generic TODO audit)

---

## 7. Conclusion

Historical debug work concentrated on **five themes**:

1. **Centering / jitter / BBO alignment** (most instrumented)  
2. **Color correctness & density normalization**  
3. **Sparse / empty render**  
4. **VP & overlay price-key alignment**  
5. **Replay trade↔book desync workarounds**

Classic TODO comments are scarce; the **live risk register is the diagnostic suite + `gui_diag.log`**, which already records a **P0 mis-centering / empty-buffer state under auto-follow**. Phase 2/3 should open findings from H-01, H-02, H-08, H-13, H-14 first.

---

*End of R15 report.*
