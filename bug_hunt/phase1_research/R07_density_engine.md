# R07 — Density Engine + Normalizer + Color System

**Scope:** `/Users/nazmi/flowmap/flowmap/engine/`
- `density_engine.py`, `normalizer.py`, `color_system.py`, `config.py`
- Call-site context (read-only): `ui/heatmap_widget.py`, `ui/source_manager.py`

**Date:** 2026-07-13  
**Mode:** Phase 1 research (no fixes)

---

## Executive summary

The live heatmap pipeline is **CPU-only pure NumPy**: snapshot liquidity is projected onto a **linear tick grid** → optional vertical Gaussian blend → **EMA(p98) adaptive normalization** → **BOOKMAP bid/ask LUTs** written into a rolling RGBA buffer.

Several **docs/comments are stale** relative to code:

| Claim in docs/comments | Actual code |
|---|---|
| Accumulated density `*= decay` then `+= size` | Snapshot overwrite only; **decay unused in draw path** |
| Fixed-ref normalizer, linear ratio, ref=8000 | `AdaptiveNormalizer`: EMA p98 + **ratio^2.5** |
| Alpha `t^1.5` | LUT alpha is **`t^0.6`** (legacy `build_lut`) / piecewise in Bookmap LUTs |
| GPU density engine | Engine is CPU; GPU is **UI paint backend only** |

Highest-impact visual risks: **mid-based side mask drops opposite-side liquidity**, **ticks_per_row collapses with max-not-sum**, **tick size freezes after first detect**, **live vs rebuild normalization diverge**, **ref defaults inconsistent (3000 vs 20000 vs symbol overrides)**.

---

## 1. How liquidity is projected into rows/columns

### 1.1 Data path (live)

`HeatmapWidget.push_snapshot` → `DensityEngine.push_snapshot` (when `auto_follow` and no resize):

1. **History column (X):** buffer scrolls left one column; rightmost column cleared to `BG_COLOR`, then drawn.
2. **Price row (Y):** linear tick mapping (not “one book level = one row”):

```text
render_tick_size = tick_size * ticks_per_row

row = (buf_h // 2) - round(price / render_tick_size) + center_price_ticks
```

- High price → smaller row index (top of image).
- `buf_h = vis_rows * 5` (5× vertical overscan for recenter roll).
- Visible viewport conceptually centered at `buf_h // 2` aligned to `center_price_ticks`.

### 1.2 Bid/ask bins

Per column, two float64 vectors of length `buf_h`:

- `bid_arr[row]`, `ask_arr[row]` start at 0.
- Vectorized map of `_curr_bid_prices/_values` and ask equivalents.
- **Collision rule:** `np.maximum.at(arr, rows, values)` — multiple prices mapping to the same row keep the **max size, not sum**.
- Optional `min_order_size`: sizes below threshold zeroed before map.

### 1.3 Snapshot storage vs accumulation

When `col_idx is None`:

```python
self._bid_density = {lv.price: lv.bid_size for lv in levels if lv.bid_size > 0}
self._ask_density = {lv.price: lv.ask_size for lv in levels if lv.ask_size > 0}
```

Comment explicitly: *“Store the current snapshot sizes directly (no accumulation or decay)”*.

Draw path uses `_curr_bid_prices/values` arrays (or rebuild grids in the widget), **not** a decaying accumulator.

### 1.4 Side coloring (not side storage)

Liquidity is stored **by book side** into bid/ask arrays, but **pixel side** is decided by mid:

```python
prices_row = (center_price_ticks + (buf_h//2 - arange(buf_h))) * render_tick_size
is_bid = prices <= mid_price
active_bids = is_bid & (norm_bids > 0.0005)
active_asks = (~is_bid) & (norm_asks > 0.0005)
```

Implications:

- Bid size at a price **above mid** is drawn only if that row is classified bid — rows above mid are ask-classified → **bid size on ask side of mid is dropped** (and vice versa).
- Fallback when no BBO mid: `is_bid = bid_arr > ask_arr` (live) / `>=` (rebuild) — **inconsistency**.

### 1.5 BBO overlay

After density, BBO bid/ask rows are painted with fixed RGBA `[100,255,120,180]` / `[255,100,90,180]`, **overwriting** density on those rows.

### 1.6 Rebuild path (widget, not engine)

On resize/scroll rebuild, widget builds full `bid_grid`/`ask_grid` `(buf_h, width)` with the **same row formula**, SciPy vertical smooth, batch normalize, then writes all columns. Engine’s `col_idx`/`_render_single_history_column` path exists but rebuild no longer primarily uses per-column engine draws for density.

---

## 2. Normalization, decay, flicker-free claims

### 2.1 `AdaptiveNormalizer` (actual strategy)

File module docstring still describes **fixed ref=8000 linear**; class implements:

| Step | Behavior |
|---|---|
| Init | `_global_ref = fixed_ref` (from config/symbol) |
| `update(column_values)` | `p98 = percentile(values, 98)`; if `p98 > 0.01`: first hit sets ref = p98, else **EMA α=0.05** toward p98; floor `max(ref, 0.1)` |
| `normalize(values)` | `nan_to_num` → `clip(v/ref, 0, 1)` → **`ratio ** 2.5`** |
| Flicker mitigation | Slow EMA (0.05) on reference only |

**Not fixed-reference.** Ref drifts with book size distribution.  
**Power 2.5** strongly compresses midrange:  
- ratio 0.5 → ~0.177 norm  
- ratio 0.25 → ~0.031  
- visibility gate `norm > 0.0005` ≈ ratio ≳ **0.055** (sizes below ~5.5% of ref may vanish)

### 2.2 Decay

- Config/default/setter: `decay ∈ [0.5, 0.99]`, default **0.92**.
- **Never applied** to density arrays or buffer in current `push_snapshot` / `_draw_column`.
- Historical “glow accumulation” diagnostics (`diagnose_density.py`) assume old decay math — **stale**.

### 2.3 Flicker-free / zero-flicker claims

| Mechanism | Effect |
|---|---|
| Clear rightmost column before draw | Avoids leftover pixels when level vanishes |
| Left-scroll historical columns | Old RGBA frozen (no per-frame recolor of history on live path) |
| EMA normalizer α=0.05 | Softens frame-to-frame scale jumps |
| Widget `WA_OpaquePaintEvent` / no sys bg | Paint-level flicker reduction |
| Rebuild precomputes final center then paints once | Avoids mid-rebuild vertical roll flicker |

**Residual flicker / temporal inconsistency:**

1. **Live path freezes old columns** at past LUT indices, while **ref continues adapting** → same absolute size looks brighter/darker on new columns than older ones (scale drift).
2. **Rebuild re-normalizes entire visible history** with one updated ref → colors **jump** on resize, zoom (`ticks_per_row`), drag, or throttled rebuild vs live stream.
3. **Vertical recenter** `np.roll` + BG fill creates hard black bands at edges.
4. **BBO lines** rewrite density every tick on those rows → twinkle on top of walls.

### 2.4 Config ref defaults vs call sites

| Source | bid_ref / ask_ref |
|---|---|
| `EngineConfig` dataclass defaults | **20000** |
| `DensityEngine.__init__` without `config=` | builds config with **3000** |
| `HeatmapWidget` | `DensityEngine(..., decay=0.92)` → **3000** path |
| Symbol override (`source_manager`) | SOL 3000, ETH 100, BTC **5** |
| Adaptive first p98 | Overwrites init ref on first non-empty update |

BTC `bid_ref=5` + power 2.5 means almost any normal order saturates toward bright end until p98 adapts.

---

## 3. Tick size / price grid freezing (anti-jitter)

### 3.1 Detection

In `push_snapshot`:

- Only while `_tick_size_detected` is False.
- Sorted level prices → `np.diff` → min positive `> 1e-6` → `round(..., 6)`.
- Sets `tick_size` and `_tick_size_detected = True`.

**Dead branch:** inner `else: tick_size = min(tick_size, obs_min)` is unreachable once flag is set (outer `if not detected` fails). Comment about “running minimum” is **aspirational**.

`detect_tick_size` **parameter is ignored** (never read).

Rebuild path: min positive diff over first usable history snapshot, force `_tick_size_detected = True`.

### 3.2 Render grid

```text
render_tick_size = tick_size * ticks_per_row
```

- Default `ticks_per_row=1`; symbol: SOL=2, ETH=10, BTC=100.
- Price→row uses `np.round(price / render_tick_size).astype(int32)`.
- Center: integer `center_price_ticks` with modes `immediate | deadband | ema | smooth_deadband` (default config **smooth_deadband**).

### 3.3 Anti-jitter design intent

| Control | Intent |
|---|---|
| Freeze tick size after first detection | Prevent vertical rescale jumps mid-session |
| Integer center ticks + deadband/EMA | Avoid 1-row thrash on mid noise |
| `round` to tick grid | Snap float prices to discrete rows |

### 3.4 Residual jitter / freeze bugs

1. **First-snapshot tick poison:** first book with missing levels / aggregation can lock wrong tick (e.g. 2× true tick) for the whole session until reset/rebuild redetect (rebuild uses history min, may still be wrong).
2. **Float price keys / keys as floats** in `_bid_density` — not used for drawing if arrays passed, but diagnostics may double-count near-equal floats.
3. **`round` half-even / float division:** prices like `BTC / (tick*100)` can sit on `.5` boundaries and flip rows when mid/center drifts by epsilon.
4. **ticks_per_row change without full rebuild** (if any path) would misalign historical buffer vs new grid; rebuild does realign center but **historical RGBA from live era was painted under old scale** until rebuild.
5. **Center EMA on float, paint on int(round(...))** — sub-tick drift until integer steps.

---

## 4. Numerical stability

| Area | Behavior | Risk |
|---|---|---|
| Arrays | `float64` for sizes/prices; buffer `uint8` RGBA | Generally safe |
| Division | `safe / _global_ref` with ref ≥ 1e-9 / 0.1 | No div-by-zero |
| Non-finite | `nan_to_num(nan=0, posinf=ref, neginf=0)` | Inf → full intensity |
| Percentile | `np.percentile` on active only | Empty skipped |
| Overflow to uint8 | `clip(norm*255, 0, 255).astype(int32)` then LUT | Safe |
| Row indices | `int32`; mask to `[0, buf_h)` | Out-of-view dropped |
| `np.roll` recenter | Full buffer roll | Large `|delta| ≥ buf_h` clears all |
| Smooth kernel | Gaussian σ, radius 3σ, edge pad with endpoint values | Edge mass inflation possible |
| Dict float keys | Snapshot density only | Key identity fragility |
| Mid = (bid+ask)/2 | If bid/ask huge (bad data) | Row projection extreme; mask clips |

No explicit overflow guards on **accumulated** sizes (N/A — no accumulate).  
No `float32` path (would matter only for GPU/memory).

**Power curve + small ref:** with BTC ref init 5.0, large sizes clip to 1.0 immediately — not overflow, but **dynamic range collapse**.

---

## 5. GPU vs CPU paths

### Engine (`flowmap/engine/*`)

- **CPU only:** NumPy (+ SciPy in widget rebuild for `gaussian_filter1d`).
- No CUDA/CuPy/Numba/OpenCL in engine.
- Preallocated column workspaces to reduce GC under tick bursts.

### UI (outside engine, relevant)

- `heatmap_widget.py`: CPU buffer → QImage / optional **QOpenGLWidget** paint backend.
- `benchmark_heatmap_gpu.py`: measures paint FPS, not density math.
- Density math is identical regardless of GPU paint.

**Conclusion:** Visual correctness bugs in projection/normalize/color are **CPU engine/widget logic**, not GPU shaders.

---

## 6. Color system

### 6.1 LUTs

| LUT | Usage in engine draw |
|---|---|
| `BOOKMAP_BID_LUT` / `BOOKMAP_ASK_LUT` | **Active** (`_draw_column` + rebuild) |
| `BID_LUT` / `ASK_LUT` (`build_lut`) | Only via unused/legacy `apply_color_lut` |
| `HEATMAP_LUT` (white→red bookmap mono) | Not used by DensityEngine draw |

Bookmap bid: cool teal/emerald piecewise.  
Bookmap ask: warm red→amber→gold piecewise.  
BG: pure black `(0,0,0,255)`.

### 6.2 Index mapping

```python
idx = clip(norm * 255, 0, 255)  # after ratio**2.5
```

Double nonlinearity: **normalize power 2.5** then **LUT spatial curve** → sparse low-end, rapid high-end (bid/ask bookmap ramps).

### 6.3 Doc drift

- Class docstring: alpha `t^1.5`; `build_lut` uses `t**0.6`; Bookmap LUTs use control-point alphas.
- Module header gamma notes apply to legacy green/red LUTs, not active Bookmap LUTs.

---

## 7. Buffer / geometry

```text
buffer shape: (vis_rows * 5, hm_width, 4) uint8
scroll: buffer[:, :-1] = buffer[:, 1:]; buffer[:, -1] = BG
recenter: roll axis=0 by delta_ticks; fill exposed edge with BG
```

`resize`: copies overlapping vertical window shifted by center delta; right-aligns historical width (`-copy_w:`).

`selected_prices` set to sorted level prices each draw (UI labels); `spacing=1`, `pad_top=0` always — legacy level-spacing path appears **retired**.

---

## 8. Bug hypotheses (visual correctness)

Priority: **P0** user-visible wrong structure; **P1** intensity/scale; **P2** edge/consistency/doc.

### P0 — Structure / wrong pixels

| ID | Hypothesis | Evidence | Symptom |
|---|---|---|---|
| **H1** | Mid-side mask drops opposite-side liquidity across mid | `active_bids = is_bid & norm_bids`; bid sizes above mid never painted | Missing walls; “single color half-book” |
| **H2** | `np.maximum.at` under `ticks_per_row>1` understates stacked liquidity | Max not sum when many ticks share a row (BTC×100) | Thin heatmap vs real depth |
| **H3** | Tick size freezes on first (possibly wrong) min diff | `_tick_size_detected` one-shot; dead min-update branch | Vertical stretch/compress, permanent mis-grid |
| **H4** | Live path paints density; rebuild uses same formula but **batch norm + SciPy smooth** vs engine 1D convolve | Two implementations | Color/smoothness jump on resize/drag |

### P1 — Intensity / flicker / scale

| ID | Hypothesis | Evidence | Symptom |
|---|---|---|---|
| **H5** | Adaptive ref + frozen history columns → temporal scale mismatch | Live never recolors past columns | “Recent column brighter/dimmer than history for same size” |
| **H6** | `ratio**2.5` + gate 0.0005 hides small/medium sizes | normalize + active_indices | Empty-looking book except large walls |
| **H7** | Symbol `bid_ref=5` (BTC) until p98 warms up | source_manager overrides | Flash-saturate then dim as ref rises |
| **H8** | Decay exposed in UI/config but no-op | setter only writes config | User “decay” control does nothing |
| **H9** | Normalizer update on rebuild uses **all** active cells of entire grid as one vector | one `update(bid_grid[mask])` | p98 dominated by dense history cluster; differs from per-column live updates |

### P2 — Precision / API / dead code

| ID | Hypothesis | Evidence | Symptom |
|---|---|---|---|
| **H10** | `detect_tick_size` arg ignored | unused param | Callers cannot force redetect |
| **H11** | Live `bid_arr > ask_arr` vs rebuild `>=` for no-mid | code diverge | Rare mid-less frames differ |
| **H12** | BBO overwrite removes density at top-of-book rows | fixed RGBA write | TOB wall “hole” or solid line only |
| **H13** | Vertical smooth bleeds size to empty ticks | Gaussian + blend | Ghost bands between levels |
| **H14** | EngineConfig 20000 vs ctor 3000 inconsistency | two defaults | Tests vs app differ |
| **H15** | Docstrings claim accumulation/decay/fixed-ref/linear | stale headers | Misleading bug triage |
| **H16** | `apply_color_lut` / green-red LUTs unused in engine | dead path | Dual color system confusion |
| **H17** | `col_idx` path skips density dict replace but still draws | branch | If used with stale `_curr_*`, wrong column content |
| **H18** | Float mid/center with large BTC prices | double OK, but tick*100 aggregation | Boundary row flip |

---

## 9. Data-flow diagram (current truth)

```text
BookLevel[] + BBO
    │
    ├─ tick_size (once) ──► render_tick_size = tick_size * ticks_per_row
    ├─ center_price_ticks (smooth_deadband / ema / …)
    │
    ├─ bid_prices/values ──► row = buf_h/2 - round(p/rts) + center
    │                         bid_arr[row] = max(…)
    ├─ ask_prices/values ──► ask_arr similarly
    │
    ├─ optional vertical Gaussian blend (σ = vertical_smoothing)
    ├─ AdaptiveNormalizer.update(p98 EMA) per side
    ├─ norm = (size/ref)^2.5
    ├─ is_bid = (price_at_row <= mid)
    ├─ BOOKMAP_*_LUT[norm*255]
    └─ BBO pixels overwrite
         │
         ▼
    uint8 buffer (CPU) ──► HeatmapWidget paint (CPU QImage or GPU widget)
```

---

## 10. Key file/line anchors

| Topic | Location |
|---|---|
| Snapshot replace (no decay) | `density_engine.py` ~133–136 |
| Scroll + clear right column | ~250–255 |
| Price→row + maximum.at | ~300–315 |
| Vertical smooth + blend | ~317–330, `_smooth_column` ~555–586 |
| Adaptive update/normalize | ~338–355; `normalizer.py` 33–51 |
| Mid side mask + LUT write | ~362–382 |
| Tick detect freeze | ~119–131 |
| render_tick_size | ~533–535 |
| Config defaults | `config.py` 13–25 |
| Bookmap LUTs | `color_system.py` 94–156, 172–173 |
| Widget rebuild grids | `heatmap_widget.py` ~745–870 |
| Symbol ticks/ref | `source_manager.py` ~383–403 |

---

## 11. Suggested Phase 2 probes (not executed)

1. Unit matrix: same size at mid±1 tick → assert both sides paint (H1).
2. Two prices mapping one row with sizes (10, 100) → expect max vs desired sum (H2).
3. Feed incomplete first book then full book → tick_size stuck (H3).
4. Compare live 100 columns vs rebuild same history → pixel/norm histogram delta (H4/H5/H9).
5. Toggle `decay` over long run → assert buffer identical (H8).
6. Sweep `ratio**2.5` vs linear for size ladder screenshots (H6).

---

## 12. Bottom line

The density stack is a **snapshot-to-grid rasterizer with adaptive contrast**, not a decaying accumulation engine. Visual correctness is dominated by **(a)** mid-halfplane coloring, **(b)** max-aggregation on coarse `ticks_per_row` grids, **(c)** one-shot tick freeze, and **(d)** dual live/rebuild normalize pipelines. GPU is irrelevant to these bugs; fix focus should stay on **row mapping, side mask, aggregation, and normalizer temporal policy**.
