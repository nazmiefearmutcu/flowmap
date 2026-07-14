# R11 — Trade Bubbles, Price Chart, Pulse (CVD) UI

**Agent:** R11  
**Date:** 2026-07-13  
**Scope:** trade bubbles overlay, mid-price chart, Market Pulse (CVD) panel  
**Primary files:**
- `/Users/nazmi/flowmap/flowmap/ui/bubbles.py`
- `/Users/nazmi/flowmap/flowmap/ui/price_chart.py`
- `/Users/nazmi/flowmap/flowmap/ui/pulse.py`
- Integration: `heatmap_widget.py`, `main_window.py`, `engine/density_engine.py`, `core/order_book.py`
- Related: `ui/overlays/cvd.py` (legacy overlay; not wired in main layout)
- `ui/bubbles/` directory exists but is **empty** (no package implementation)

---

## 1. Architecture overview

```
GUI tick (_gui_tick)
  ├─ order_book.record_trades(trades)
  ├─ heatmap.add_trades(trades)     → VolumeBubbles + trade dots
  ├─ _pulse.add_trades(trades)      → local CVD + sweeps (display mostly ignores local)
  ├─ cvd = order_book.get_volume_delta()   # session buy - sell
  └─ heatmap.push_snapshot(..., cvd=cvd)   # engine._cvd_history append

Paint heatmap
  └─ _bubbles.draw(..., visible_end_frame, bw, row_height, ticks_per_row)

Paint pulse
  └─ reads engine._cvd_history / _timestamp_history (last bw samples)
```

| Component | Role in UI | Live wiring |
|-----------|------------|-------------|
| `VolumeBubbles` | Aggregated buy/sell pie bubbles on heatmap | Yes — owned by `HeatmapWidget` |
| `PriceChart` | Mid-price line above heatmap | **No** — not instantiated in `MainWindow._setup_ui` |
| `MarketPulse` | Bottom CVD area chart + sweeps | Yes — grid row under heatmap |
| `CVDOverlay` | Older standalone CVD widget | Legacy; not main layout |

---

## 2. How trades are plotted / scaled (bubbles)

### 2.1 Ingest & aggregation (`VolumeBubbles.add_trade`)

- Each trade stamped with **heatmap `_frame_count`** (integer column index), not exchange timestamp.
- Merge rule: walk deque **reverse**, same price (`abs < 1e-6`) and `|tick_index - tick| <= 2`.
- On merge: accumulate `buy_size` / `sell_size`, `timestamp = max(ts, now-0.2)`, `tick_index = max(...)`.
- Cap: `deque(maxlen=10000)`.
- `max_age` default 2.5s exists on `Bubble` (`is_alive`, `alpha`) but **draw does not cull by age**.

### 2.2 Radius scaling (`Bubble.current_radius`)

```
raw_rad = min_rad + log2(1 + total_size) * (max_rad - min_rad) / 8
bubble_max_rad *= sqrt(row_height/4) * (1/sqrt(ticks_per_row)) * size_multiplier
clamp [1.5, 120]
grow-in: first 150ms ease (1-(1-t)^2)
```

Defaults: `min_radius=2.5`, `max_radius=18.0`, toolbar `size_multiplier` (sidebar 1–50 → scaled in main_window).

**Insight:** Volume→radius is log2 over a fixed divisor of 8 (not adaptive to market unit size). BTC contracts vs altcoin coins will look very different; large sizes saturate quickly toward max.

### 2.3 Screen position (`VolumeBubbles.draw`)

```python
# X — same formula as trade dots
col = bw - 1 - frame_count + bubble.tick_index
x = col * heatmap_width / bw

# Y — unified heatmap mapping
y = price_to_y(bubble.price)  # HeatmapWidget._price_to_screen_y
```

`_price_to_screen_y`:
```python
p_ticks = round(price / render_tick_size)
screen_row = (vis_rows // 2) - (p_ticks - center_price_ticks)
return screen_row * row_height + row_height / 2
```

- Uses **rounded tick rows** → bubbles snap to heatmap row centers (good alignment with density cells).
- Does **not** clamp Y to widget; off-screen bubbles still draw (clipped by painter only if parent clips).

### 2.4 Color / pie

- Pure buy ≥99% green, pure sell ≥99% red, else `drawPie` sectors (buy from 12 o’clock).
- Alpha **hardcoded 180** (fade helpers dead code).

### 2.5 Parallel trade-dot path

`HeatmapWidget._draw_trades` uses same tick→col formula but **percentile-based** radius (median/p95), not log2. Two overlays can disagree on size for the same trade.

---

## 3. Shared time axis with heatmap

### 3.1 Column model (heatmap / bubbles / trade dots)

| Symbol | Meaning |
|--------|---------|
| `bw` | Visible buffer width = columns ≈ `timeline_w / column_width` |
| `_frame_count` | Number of `push_snapshot` calls |
| `_scroll_offset` | Columns scrolled back from live edge |
| `visible_end_frame` | `_frame_count - _scroll_offset` |
| `timeline_w` | `width - price_axis_w - right_margin_w` |

Bubbles receive `heatmap_width=timeline_w` and `frame_count=visible_end_frame` — **scroll is respected** for bubbles/dots.

### 3.2 Off-by-one lag (correctness)

In `_gui_tick` order:

1. `heatmap.add_trades(trades)` stamps `tick_index = self._frame_count` (**pre-increment**)
2. `heatmap.push_snapshot(...)` does `self._frame_count += 1`

After tick N:
- New heatmap column corresponds to frame index **N** (count after push).
- Trades stamped **N−1**.
- `col = bw - 1 - visible_end + tick` → latest trades land on **`bw-2`**, not the live rightmost column (`bw-1`).

**Expected:** trades in the same GUI frame as a snapshot share that snapshot’s column.  
**Actual:** consistently **one column left** of the live edge.

Same formula in `_draw_trades` → dots and bubbles share the lag (internally consistent with each other, wrong vs heatmap columns).

### 3.3 Pulse time axis (partially shared)

When `self._heatmap` is set, pulse paints from:

```python
bw = engine.get_buffer().shape[1]
slice_start = max(0, history_len - bw)
cvd_values = engine._cvd_history[slice_start:]
x_scale = plot_w / bw
col_offset = bw - n
x = (col_offset + index) * x_scale
```

- Samples are **per snapshot** (engine history), not per trade.
- Uses **last `bw` history points only** — **ignores `_scroll_offset`**.
- Horizontal plot: `plot_left=0` … `plot_right = w - price_axis_w`.
- Heatmap timeline is only `timeline_w = w - price_axis_w - right_margin_w` (right margin ~60px for badges).

**Misalignments:**
1. **Scroll:** heatmap scrolls history; CVD stays locked to live tip.
2. **Right margin:** pulse uses full chart width to price axis; heatmap shortens by `right_margin_w` → column X scale differs.
3. **Sample domain:** CVD one value per book frame; trades many-to-one per frame.

Pulse is refreshed on `view_changed` (`_on_heatmap_view_changed` → `_pulse.update()`), but paint still does not re-window history by scroll.

### 3.4 PriceChart time axis (orphaned)

`PriceChart` uses private `(tick_count, price)` deque (`maxlen=600`), X = linear map over **its own** min/max tick range across `cw = width - price_axis_w` — **no** `bw`, `frame_count`, or scroll.

**Not mounted** in current `MainWindow` layout (docstring still claims top price chart). `source_manager` still calls `price_chart.reset()` if attribute exists (dead branch).

---

## 4. CVD computation and reset semantics

### 4.1 Three CVD accumulators

| Source | Formula | Sampling | Used by |
|--------|---------|----------|---------|
| `OrderBook.get_volume_delta()` | `total_buy_volume - total_sell_volume`; `nan` if no trades | Session totals | Engine history via `push_snapshot(cvd=...)` |
| `DensityEngine._cvd_history` | Appended each `push_snapshot` | 1 point / heatmap frame | **MarketPulse paint** (primary) |
| `MarketPulse._current_cvd` / `_cvd_values` | `+= size` buy / `-= size` sell per trade | 1 point / trade | Fallback paint only; still feeds **sweep buffer** |

Display CVD (with heatmap) is **session volume delta sampled once per GUI snapshot**, not the pulse-local per-trade series.

Implications:
- Flat segments between trades that share a frame (good).
- If multiple trades in one frame, local series has multiple points; chart shows one session total after frame — **local and engine diverge in shape**.
- `nan` early session: pulse filters `math.isnan`, draws “Waiting for trades…” until ≥2 valid points.

### 4.2 Reset paths

| Action | Bubbles | Pulse local | Engine CVD | PriceChart |
|--------|---------|-------------|------------|------------|
| `HeatmapWidget.reset()` | `clear()` | — | `engine.reset()` clears histories | — |
| `MarketPulse.reset()` | — | clear + bootstrap 0 | — | — |
| `source_manager` source switch | via heatmap reset | `_pulse.reset()` | via heatmap | `price_chart.reset()` if present |
| `PriceChart.reset()` | — | — | — | clear ticks |

Risk: pulse local reset and engine CVD reset are separate. After partial reset ordering bugs, badge/local property `pulse.cvd` can disagree with painted engine history until both cleared.

### 4.3 Sweep detection

- Buffer last 30 trades `(price, size, side, wall_clock)`.
- Window 0.3s, min 3 same-side trades, total size ≥ `0.5 * count`.
- Markers live 3s; X via `bisect` on **engine `_timestamp_history`** (snapshot times), not trade times.
- Mismatch risk: trade `time.time()` vs replay `receive_timestamp` in history → `min_diff < 1.5s` fails → fallback right-edge marker only if live.

### 4.4 Color-vision modes

Right-click menu remaps line/fill/sweep colors (deuteranopia / protanopia / tritanopia). Naming collision: “CVD” = cumulative volume delta **and** color vision deficiency mode enum — easy for future confusers.

---

## 5. Alignment bugs risk with heatmap rows / columns

| ID | Risk | Mechanism |
|----|------|-----------|
| A1 | **Column off-by-one** | Trades stamped before `_frame_count++` |
| A2 | **Pulse ignores scroll** | Always last `bw` of `_cvd_history` |
| A3 | **Pulse vs heatmap width** | Pulse omits `right_margin_w` |
| A4 | **Y snap vs raw price** | `round(price/render_tick_size)` — fine for grid, wrong if tick_size wrong |
| A5 | **ticks_per_row change** | Bubbles re-Y via `render_tick_size`; historical prices may sit on coarser grid |
| A6 | **Vertical pan/recenter** | Y recomputed each paint from `center_price_ticks` — OK; no sticky wrong Y |
| A7 | **Bisect order broken after merge** | Merge can raise older bubble’s `tick_index` without reordering deque → bisect assumes sorted |
| A8 | **Batch same tick** | All trades in a batch share one `frame_count` (intended) but amplify A1 |
| A9 | **Double-feed path** | `_gui_tick` nulls `on_trade` then `add_trades`; if path re-enables early, double bubbles/CVD |

**A7 detail:** After merge, tick order in deque can become non-monotonic. `bisect_left/right` on `tick_index` then **drops or mis-includes** bubbles in the visible window.

`adjust_tick_indices(delta)` exists but is **never called** — no compensation when frame indices are rewritten.

---

## 6. Performance of many bubbles

| Cost | Notes |
|------|-------|
| Merge `add_trade` | O(n) reverse scan per trade; n ≤ 10k |
| Draw | `list(deque)` + bisect + per-bubble Qt ellipses/pies |
| Pie path | `drawPie` ×2 for mixed bubbles — expensive vs solid ellipse |
| Antialiasing | Forced on only for bubble pass in cache paint |
| Cap | 10k maxlen; **no age eviction** — full history until deque overflow |
| Paint frequency | Tied to heatmap static cache rebuild (`_cache_dirty`) |
| Pulse | Downsamples CVD to ~`plot_w` points; throttle 33ms; OK |
| Pulse history copy | `list(islice(...))` every paint — history_width up to 10k |

**Hot path worst case:** high-frequency tape + full 10k bubbles + many mixed pie slices + cache rebuild each frame → UI FPS drop. Trade dots also convert full deque to list and percentile over **all** trades on every `add_trades` (`np.median` / `percentile` on up to 10k sizes).

Dead work:
- `Bubble.alpha` / `is_alive` unused in draw
- `import math` / `import bisect` inside methods repeatedly
- Dual overlays (dots + bubbles) for same trades

---

## 7. PriceChart specifics (orphan module)

- Own Y padding (`±0.05%` + min 0.5% range), own X over private ticks.
- `push_price` never called from current main pipeline (`_price_history` lives on engine instead).
- Docstring / comments in `main_window` still describe “PriceChart top 22%” — **stale**.
- If re-enabled without shared axis, will **not** align with heatmap columns.

---

## 8. Bug hypotheses (ranked)

### P0 / P1 — Correctness / alignment

1. **BH-R11-01 — Trade/bubble column lag (off-by-one)**  
   - **Sev:** P1  
   - **Where:** `heatmap_widget.add_trade(s)` uses pre-increment `_frame_count`; `push_snapshot` increments after.  
   - **Repro:** Single trade on quiet book; compare bubble X to newest heatmap column.  
   - **Expected:** Same column as new density column.  
   - **Actual:** One column left.  
   - **Fix hint:** Stamp with `_frame_count + 1` when trades precede the snapshot that will open the new column, or increment frame before stamping, or stamp after push with same index.

2. **BH-R11-02 — Pulse CVD does not follow heatmap scroll**  
   - **Sev:** P1  
   - **Where:** `pulse.py` paint uses `history_len - bw` only; no `_scroll_offset`.  
   - **Repro:** Scroll heatmap left; CVD curve stays on live window.  
   - **Fix hint:** `end = history_len - scroll_offset`; slice `[end-bw:end]` aligned with rebuild window.

3. **BH-R11-03 — Pulse X scale ignores `right_margin_w`**  
   - **Sev:** P2  
   - **Where:** pulse `plot_w = w - price_axis_w` vs heatmap `timeline_w`.  
   - **Fix hint:** Match heatmap geometry (`right_margin_w` + same `timeline_w`).

### P1 / P2 — Aggregation / index integrity

4. **BH-R11-04 — Merge breaks tick_index sort → bisect wrong**  
   - **Sev:** P1–P2  
   - **Where:** `VolumeBubbles.add_trade` updates older bubble tick without reorder.  
   - **Repro:** Two prices A then B; later trade merges into A with newer tick; A now before B with higher tick.  
   - **Fix hint:** On merge, move bubble to end; or maintain sorted structure; or linear filter visible set.

5. **BH-R11-05 — Dual CVD series diverge**  
   - **Sev:** P2  
   - **Where:** per-trade local vs session-sampled engine history.  
   - **Symptom:** `MarketPulse.cvd` property ≠ chart tip; sweeps keyed on wall clock vs snapshot timestamps.  
   - **Fix hint:** Single source of truth; sample CVD only from engine, or store per-frame delta for pulse.

### P2 — Fade / lifecycle

6. **BH-R11-06 — Age fade dead; bubbles never dim**  
   - **Sev:** P3 (product) / P2 if intended Bookmap-like fade  
   - **Where:** `alpha = 180` hardcoded; `max_age` only affects grow-in.  
   - **Effect:** Full-opacity bubbles for entire scrolled history (up to 10k).

7. **BH-R11-07 — `adjust_tick_indices` dead code**  
   - **Sev:** P3  
   - If frame reindexing is ever needed without clear, indices silently wrong.

### P2 — Performance

8. **BH-R11-08 — O(n) merge + 10k pie draws**  
   - **Sev:** P2  
   - **Fix hint:** Hash map `(price_bucket, tick//3) → Bubble`; solid ellipse for pure side; age/count cull; avoid `list(deque)` every paint if possible.

9. **BH-R11-09 — Percentiles on full trade history every batch**  
   - **Sev:** P2  
   - **Where:** `_update_trade_size_percentiles`  
   - **Fix hint:** Running / reservoir stats.

### P3 — Product / dead UI

10. **BH-R11-10 — PriceChart not in layout**  
    - Dead module; misleading docs; reset hooks noop.

11. **BH-R11-11 — Empty `ui/bubbles/` package dir**  
    - Confusion vs `bubbles.py`.

12. **BH-R11-12 — `Trade` type in `add_trades` not imported**  
    - Safe under `from __future__ import annotations`; static checkers may flag.

13. **BH-R11-13 — Sweep false negatives on replay**  
    - Wall-clock sweep buffer vs `receive_timestamp` history.

14. **BH-R11-14 — log2 radius not market-normalized**  
    - Visual inconsistency across symbols / size units.

---

## 9. Suggested verification tests (Phase 2+)

1. **Column align unit:** mock frame_count + one trade + one push; assert `col == bw-1` for that trade.  
2. **Scroll CVD:** push 100 frames, set `scroll_offset=20`, assert pulse window end index matches heatmap.  
3. **Merge sort:** sequence that reorders ticks; assert all merged bubbles still drawn.  
4. **Reset:** source switch → bubbles empty, pulse bootstrap 0, engine cvd history empty, no residual badge.  
5. **Geometry:** pulse last-point X vs heatmap last-column X within 1px when scroll=0 (after margin fix).  
6. **Perf smoke:** 10k bubbles + 1k trades/batch; frame budget.

---

## 10. File reference map

| Concern | Location |
|---------|----------|
| Bubble model / draw | `flowmap/ui/bubbles.py` L22–241 |
| Stamp trades | `heatmap_widget.py` `add_trade` / `add_trades` ~423–572 |
| Draw bubbles | `heatmap_widget.py` ~1205–1210 |
| price→Y | `heatmap_widget.py` `_price_to_screen_y` ~297–305 |
| Frame/scroll | `heatmap_widget.py` `push_snapshot` ~345–405 |
| Session CVD | `core/order_book.py` `get_volume_delta` ~349–354 |
| Engine CVD history | `engine/density_engine.py` ~63–64, 169–170, 94–103 |
| GUI fan-out | `main_window.py` `_gui_tick` ~895–959, `_on_trade` ~889–893 |
| Pulse paint / scroll gap | `flowmap/ui/pulse.py` ~339–456, 517–558 |
| Price chart (orphan) | `flowmap/ui/price_chart.py` |
| Layout (no PriceChart) | `main_window.py` `_setup_ui` ~91–116 |

---

## 11. Summary

- **Bubbles** share heatmap tick/column math and row-centered Y mapping; scaling is log2×row×zoom×user.  
- **Shared time axis is incomplete:** bubbles/dots respect scroll; **pulse does not**, and **right margin differs**.  
- **Likely real bug:** trades stamped **one frame behind** the column written by `push_snapshot`.  
- **CVD display** is engine session delta per snapshot; pulse’s own per-trade series is largely dead for drawing but still drives sweeps.  
- **PriceChart** is currently disconnected.  
- **Performance risk** grows with uncapped historical bubbles (opacity never fades) and O(n) merge/draw paths.

**Highest priority for Phase 2:** BH-R11-01 (column lag), BH-R11-02 (pulse scroll), BH-R11-04 (bisect/merge order), BH-R11-03 (geometry).
