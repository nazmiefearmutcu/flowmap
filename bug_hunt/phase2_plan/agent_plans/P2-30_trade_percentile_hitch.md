# P2-30 — Trade deque / percentile hitch

| Field | Value |
|-------|-------|
| **Agent** | P2-30 |
| **Theme n** | 30 |
| **Slug** | `trade_percentile_hitch` |
| **Zones** | **Z04** |
| **Sibling fuel** | **R08** H19; **R09** trade overlay costs; **R11** bubbles/pulse (adjacent); **R17** trade ts |
| **Primary module** | `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py` `_trades` deque, `add_trade(s)`, `_update_trade_size_percentiles` L574–585 |
| **Secondary** | `paintEvent` / `_draw_trades` L1559–1633; `get_visible_trades`; main_window batch `add_trades` |
| **Track** | C — Rendering & performance |
| **Wave** | **W3** |

---

## 1. Scope & linked zones / sibling hyps

### In scope

1. `_update_trade_size_percentiles` runs on **every** `add_trade` / `add_trades` batch:
   - builds `sizes = [t[1] for t in self._trades]` up to maxlen (10k);
   - `np.median` + `np.percentile(..., 95)` every time.
2. Cost under trade bursts (replay 20×, liquidations storm, busy SOL).
3. Interaction with paint: percentiles avoid recompute in paint (good) but push cost to ingest path on GUI thread (`_gui_tick` → `add_trades`).
4. Deque maxlen / memory of trade tuples.
5. Whether batch path still O(n) full scan once per batch (yes) vs once per trade in `add_trade` (once per call).
6. Secondary: `list(self._trades)` in draw paths (R09) — inventory only; primary is percentiles.

### Out of scope

| Concern | Owner |
|---------|-------|
| Side BUY bias bubbles | P2-32 / R11 |
| Trade time stamp wall clock | R17 / other |
| Iceberg F+ | P2-45 |
| Book trade mapping | Track A |

### Sibling map

| ID | Claim |
|----|-------|
| R08-H19 | Percentiles over all trades deque LOW hitch |
| R09 | list(trades) + bisect per cache rebuild |
| R20 Z04 | Trade overlays P0–P1 class |

### Code anchors

```
heatmap_widget.py
  ~trades deque maxlen 10000 (init region)
  L423–495  add_trade → ends with _update_trade_size_percentiles
  L497–572  add_trades → single _update_trade_size_percentiles at L571
  L574–585  median + p95 over all sizes
  L1559+    _draw_trades uses _trade_med_size / _trade_p95_size
main_window.py
  L949–950  heatmap.add_trades(trades) per gui tick with trades
```

---

## 2. Threat model

### Assets

| Asset | Failure |
|-------|---------|
| GUI frame budget during `_gui_tick` | Hitch every batch |
| Trade dot sizing correctness | Stale percentiles if over-throttled badly |
| Memory | 10k trades × tuple overhead |

### Scenarios

| # | Scenario | Cost shape |
|---|----------|------------|
| S1 | 10k trades full; each tick +50 trades | O(10k) sort-like percentile each tick |
| S2 | add_trade called 500× individually | 500× full scans |
| S3 | Quiet market | Negligible |
| S4 | Combined with rebuild (P2-26) | Stacked hitches |
| S5 | Percentile every batch when only 1 new trade | Waste |

### Severity

Usually **P2** hitch; elevate **P1** if p95 ingest >5–10 ms under realistic replay.

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| ST-1 | maxlen of `_trades` |
| ST-2 | All callers of `_update_trade_size_percentiles` |
| ST-3 | Draw path uses cached med/p95 only |

### 3.2 Microbenchmark

| ID | Setup | Metric |
|----|-------|--------|
| B1 | Pre-fill deque n∈{100,1k,5k,10k}; call `_update_trade_size_percentiles` ×100 | p95 µs/ms |
| B2 | `add_trades` batch sizes 1, 10, 100, 1000 with full deque | Cost per batch |
| B3 | Compare incremental approx (running p² / t-digest / sample) | Fix oracle |

### 3.3 Dynamic

| ID | Steps |
|----|-------|
| D1 | Replay busy symbol 20×; instrument time in add_trades | Hitch histogram |
| D2 | Live SOL; same | Realism |
| D3 | Correlate with `_gui_tick` duration | End-to-end |

### 3.4 GUI

| ID | Fail |
|----|------|
| G1 | Visible stutter when tape is hot |
| G2 | Dot sizes jump wildly if fix wrong |

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF-1 | Benchmark table for n=10k | No data |
| PF-2 | p95 update cost < 1 ms at n=10k **or** FIND filed with measured cost | Hidden multi-ms |
| PF-3 | Batch path updates percentiles ≤ once per batch | Per-trade full scan in batch API |
| PF-4 | Dot sizing still uses robust med/p95 semantics after any fix | Broken scale |
| PF-5 | No full list copy required solely for percentiles | Unneeded alloc |

Note: `add_trades` already once per batch (pass for PF-3 on batch API). `add_trade` once per trade is fail under storm if used.

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| Synthetic Trade list generator | B1/B2 |
| HeatmapWidget without show() | Headless bench |
| Busy replay window | D1 |
| Perf counter wrapper | CSV |

---

## 6. Phase-3 micro-tasks

### MT-30-1 — Measure B1/B2
Produce numbers; severity from data.

### MT-30-2 — Call frequency under replay
How often `_update_trade_size_percentiles` per second.

### MT-30-3 — Draw-path cost inventory
R09 list(trades) — separate FIND if heavy (optional FIND-P230-0x).

### MT-30-4 — Fix design options
(a) Recompute every K trades or every T ms; (b) numpy fromarray ring buffer; (c) running approx; (d) sample last 512 only for sizing.

### MT-30-5 — Correctness of sizing after throttle
Visual/unit: med/p95 stable enough for dots.

---

## 7. Expected finding IDs

Format: **`FIND-P230-XX`**

| ID | Title | Sev prior |
|----|-------|-----------|
| FIND-P230-01 | Full-deque median/percentile each ingest | **P2** (P1 if ms-class) |
| FIND-P230-02 | add_trade per-message full scan | **P2** |
| FIND-P230-03 | sizes list comprehension allocates every time | **P2** |
| FIND-P230-04 | paint path list(self._trades) extra cost | **P2** (R09) |
| FIND-P230-05 | maxlen 10k memory under deep sessions | **P3** |

---

## 8. Fix strategy sketch

1. **Throttle percentile refresh** to 100–250 ms or every N new trades; keep last med/p95.
2. **Ring buffer of float64 sizes** parallel to deque; `np.percentile` on view without list comp.
3. **Sample window** last 512–1024 trades for sizing (UX usually OK).
4. Prefer batch-only API from `_gui_tick` (already); avoid per-trade path on hot route.
5. Optional: exponential histogram for O(1) approx p95.

Do not recompute inside paint.

---

## 9. Dependencies

| Dep | Note |
|-----|------|
| **P2-26** | Stacked GUI costs |
| **P2-14** | Large trade batches per tick |
| **P2-32** | Bubbles also per-trade work |
| **P2-05** | Trade field mapping upstream |

---

## 10. Severity priors

| Item | Prior | Source |
|------|-------|--------|
| Percentile hitch | **P2** | R08-H19 LOW hitch |
| Elevate if measured >5 ms | **P1** | Perf SLA |
| Memory maxlen | **P3** | — |

**Confidence:** **Very high** that full scan runs each batch (code). **Medium** absolute cost — measure B1 before Phase-4.
