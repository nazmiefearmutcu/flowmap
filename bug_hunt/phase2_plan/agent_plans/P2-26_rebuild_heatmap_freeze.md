# P2-26 — Full `rebuild_heatmap` freeze budget

| Field | Value |
|-------|-------|
| **Agent** | P2-26 |
| **Theme n** | 26 |
| **Slug** | `rebuild_heatmap_freeze` |
| **Zones** | **Z01**, **Z02** |
| **Sibling fuel** | **R08** H1, S3; **R09** rebuild cost; **R20** perf taxonomy / Z26 |
| **Primary module** | `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py` `rebuild_heatmap` L587–876 |
| **Secondary** | `/Users/nazmi/flowmap/flowmap/engine/density_engine.py`; normalizer; ColorSystem LUTs; SciPy path |
| **Track** | C — Rendering & performance |
| **Wave** | **W3** (instrument earlier OK) |

---

## 1. Scope & linked zones / sibling hyps

### In scope

1. Wall-clock cost of full `rebuild_heatmap` on main thread as f(history length, vis_rows, width, smoothing, depth).
2. Call sites that invoke full rebuild (not only throttled API).
3. Whether throttle (50 ms) limits **start rate** only, not **duration**.
4. SciPy `gaussian_filter1d` cost when `vertical_smoothing > 0.01`.
5. Interaction: rebuild during live `push_snapshot` size-mismatch path.
6. Freeze budget: define pass threshold (e.g. p95 < 32 ms for interactive; < 100 ms acceptable; > 250 ms P0 UX).

### Out of scope

| Concern | Owner |
|---------|-------|
| Throttle race / coalescing correctness | **P2-27** |
| Resize partial vs rebuild | **P2-29** |
| Live vs rebuild normalizer divergence correctness | **P2-11** |
| Mid-mask projection correctness | **P2-07** |

### Sibling map

| ID | Claim |
|----|-------|
| R08-H1 | Full rebuild freezes UI — HIGH |
| R08 S3 | Full rebuild surface |
| R09 cost table | Grids H×W, SciPy ×2, LUT write |
| R20 | Performance hottest Z01/Z02 |

### Code anchors

```
heatmap_widget.py
  L345–405  push_snapshot → rebuild if vr/bw changed
  L587–876  rebuild_heatmap full path
  L611–616  history_slice up to target_bw columns
  L619–632  tick detect scan
  L639–~740 centering pre-pass over history
  L745–817  bid/ask grids fill loop
  L819–832  SciPy smooth
  L834–870  normalize + LUT into _buffer
  L903–919  request_rebuild_throttled (rate only)
  L929–946  reset → rebuild_heatmap
  Callers: zoom, drag release, go live keys, set_min_order_size, etc.
```

---

## 2. Threat model

### Assets

| Asset | Failure |
|-------|---------|
| Interactive latency | Beachball on zoom/resize/go-live |
| Live feed processing | `_gui_tick` delayed → queue backlog (P2-13) |
| Correctness under cancel | No cancel: must finish once started |

### Scenarios

| # | Scenario | Expected cost driver |
|---|----------|----------------------|
| S1 | history=10k, target_bw≈ display cols, vr=400, smooth on | Worst case |
| S2 | Rapid zoom_to_height spam | Throttled starts but each rebuild multi-100ms |
| S3 | Live size change every frame (pathological window) | Rebuild every tick |
| S4 | First SciPy import inside rebuild | One-time hitch |
| S5 | Deep books (3000 levels) in history entries | Loop + array work |
| S6 | rebuild blocks; user input coalesces | Feels frozen |

### Budget proposal (for pass/fail)

| Class | Wall time main thread | Severity if exceeded regularly |
|-------|----------------------|--------------------------------|
| Green | ≤ 16 ms | OK |
| Yellow | 16–50 ms | P2 |
| Orange | 50–150 ms | P1 |
| Red | > 150 ms | **P0** UX freeze |

Tune after measurement; document chosen SLA in findings.

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| ST-1 | Call graph of `rebuild_heatmap` and `request_rebuild_throttled` |
| ST-2 | Identify allocations per call (grids, list(history), copies) |
| ST-3 | SciPy import site inside method vs module |

### 3.2 Microbenchmark (headless)

| ID | Setup | Metric |
|----|-------|--------|
| B1 | Synthetic history N∈{100,500,2k,5k,10k}, vr∈{100,200,400}, smooth∈{0,1.0} | p50/p95 wall ms |
| B2 | Same with min_order_size filtering on | Extra copy cost |
| B3 | Column_width min vs max (target_bw change) | Width scaling |
| B4 | Instrument only centering pre-pass vs grid fill vs LUT | Phase breakdown |

Use `time.perf_counter` around `rebuild_heatmap`; disable paint if needed.

### 3.3 Dynamic integrated

| ID | Steps |
|----|-------|
| D1 | Replay 20× until history full; trigger Go Live rebuild | Wall + UI freeze observation |
| D2 | Hold mouse drag zoom | Frame time |
| D3 | Correlation: rebuild duration vs queue.qsize growth | Cross-theme |

### 3.4 GUI

| ID | Fail |
|----|------|
| G1 | Zoom feels sticky >100 ms |
| G2 | Beachball cursor on macOS during rebuild |

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF-1 | Benchmark table exists for N×vr×smooth | No measurement |
| PF-2 | p95 under agreed SLA for “typical” (e.g. N=display width, vr=200, smooth=0) | Regular Red class |
| PF-3 | Throttle does not claim to cap duration (docs honest) | Docs say “prevents lag” but multi-100ms rebuilds still chained |
| PF-4 | Pathological live rebuild-every-tick identified/fixed or FIND | Silent |
| PF-5 | Phase breakdown points to fix targets | Only total time |

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| Synthetic `BookLevel` history generator (seeded) | B1 |
| HeatmapWidget offscreen with fixed geometry 1920×1080 / 1280×720 | Repro |
| Perf CSV writer | Phase-3 artifact |
| Optional: py-spy / cProfile one-shot | Hot spots |
| Flag `FLOWMAP_PERF=1` (proposed) | Conditional timing logs |

---

## 6. Phase-3 micro-tasks

### MT-26-1 — Call-site inventory
Every rebuild trigger with frequency estimate under live use.

### MT-26-2 — Benchmark matrix B1
Produce table; open FIND-P226-01 if Red.

### MT-26-3 — Phase profiling
Split timing: tick detect, centering, grid, smooth, LUT.

### MT-26-4 — Live interaction test
Replay fill + user zoom; record hitch histogram.

### MT-26-5 — Fix sketch validation (no code)
Evaluate: incremental rebuild dirty columns; downsample history; background rebuild + swap; cap history to target_bw only; cache tick_size.

---

## 7. Expected finding IDs

Format: **`FIND-P226-XX`**

| ID | Title | Sev prior |
|----|-------|-----------|
| FIND-P226-01 | rebuild_heatmap exceeds freeze SLA at realistic N | **P0/P1** |
| FIND-P226-02 | Throttle only limits start rate not duration | **P1** |
| FIND-P226-03 | SciPy import inside hot path first hitch | **P2** |
| FIND-P226-04 | push_snapshot size change forces full rebuild every time | **P1** |
| FIND-P226-05 | O(history) Python loops dominate | **P1** design |
| FIND-P226-06 | Rebuild starves queue drain | **P0** compound |

---

## 8. Fix strategy sketch

1. **Cap work to visible columns** already mostly true (`target_bw`) — ensure history pre-parse reused (partially done).
2. **Dirty-column rebuild** for zoom-only changes that don't need full re-grid when possible.
3. **Move heavy rebuild off main** carefully (engine buffer swap double-buffer) — hard with Qt; medium-term.
4. **Time-slice rebuild** across frames (cooperative) for interactivity.
5. **Import scipy at module load**; preallocate grids.
6. **Avoid rebuild** on paths that only need `engine.resize` + incremental (coord P2-29).
7. Do not start another rebuild until previous done; coalesce (P2-27).

---

## 9. Dependencies

| Dep | Note |
|-----|------|
| **P2-27** | Coalescing races |
| **P2-29** | Resize should call full rebuild — cost tradeoff |
| **P2-11** | Correctness of rebuild vs live path |
| **P2-13/14** | Freeze → backlog |
| **P2-28** | Buffer swap during long rebuild |

---

## 10. Severity priors

| Item | Prior | Source |
|------|-------|--------|
| Main-thread freeze | **P0/P1** | R08-H1 HIGH |
| Typical N cost unknown | Measure first | — |
| Compound queue | **P0** | R20 |

**Confidence:** **High** that path is O(columns×rows) on main thread. **Medium** on absolute ms until B1.
