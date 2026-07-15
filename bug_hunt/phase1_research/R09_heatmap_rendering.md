# R09 — Heatmap Rendering Pipeline Deep Dive

**Agent:** R09  
**Date:** 2026-07-13  
**Scope:** `heatmap_widget.py`, `ui/heatmap/heatmap_renderer.py`, `ui/heatmap/color_schemes.py`, `engine/density_engine.py`, `engine/color_system.py`, `benchmark_rendering.py`, `diagnose_rendering.py`  
**Role:** Production path is **HeatmapWidget + DensityEngine + ColorSystem**. Legacy `BookmapHeatmap` in `heatmap_renderer.py` is still in-tree but **not** what `ui/heatmap/__init__.py` exports (alias → HeatmapWidget).

---

## 1. Frame pipeline: data → buffer → paint → screen

```
Market tick / MainWindow timer
        │
        ▼
HeatmapWidget.push_snapshot(levels, bbo, ts, cvd)
  • parse bid/ask price+size arrays
  • append to _history deque (maxlen=10000)
  • _frame_count++, scroll offset
  • if size change → rebuild_heatmap()
  • elif auto_follow → DensityEngine.push_snapshot(...)
  • else (paused scroll) → dirty cache only
        │
        ▼
DensityEngine.push_snapshot / _draw_column  (incremental, live)
  OR HeatmapWidget.rebuild_heatmap()       (full history re-raster)
        │
        ▼
engine._buffer  uint8[H, W, 4]  RGBA
  H = vis_rows * 5   (overscan for vertical recentering)
  W = timeline_w / column_width
  BG_COLOR = (0,0,0,255)
  active cells ← BOOKMAP_BID_LUT / BOOKMAP_ASK_LUT
  optional: BBO bid/ask row stamped into column pixels
        │
        ▼
HeatmapWidget.update() → Qt paint
        │
        ▼
paintEvent
  if _cache_dirty or size mismatch:
      rebuild QPixmap _static_cache:
        fill Colors.BG_DEEP
        QImage(buf.data, W, H, Format_RGBA8888)  # zero-copy wrap
        drawImage(viewport, qimg, center slice of buffer)
        overlays: BBO history, trades, liqs, LLT, stops, icebergs,
                  bubbles, pulse, price axis, current BBO lines
      _cache_dirty = False
  QPainter(self).drawPixmap(0,0,_static_cache)
  dynamic: crosshair + "Go Live" button
        │
        ▼
screen (QWidget or QOpenGLWidget depending on FLOWMAP_RENDERER / test argv)
```

### Live (auto_follow) column write path

1. Center mid-price in tick space (`centering_mode`: immediate / deadband / ema / smooth_deadband).
2. Vertical `np.roll` if center ticks moved; clear exposed rows with `BG_COLOR`.
3. Horizontal scroll: `buffer[:, :-1] = buffer[:, 1:]`, clear col `-1`.
4. `_draw_column`: map prices → rows, normalize, LUT index, write RGBA.

### Full rebuild path (`rebuild_heatmap`)

1. Clear density dicts + histories; reset normalizer refs.
2. Slice `_history` by `_scroll_offset` and `target_bw`.
3. Detect tick size from min positive price delta.
4. Precompute final center (simulate centering over slice).
5. `engine.resize(vis_rows, target_bw)` → buffer height `vis_rows*5`.
6. Build full `bid_grid` / `ask_grid` float64; optional SciPy vertical Gaussian.
7. Batch-normalize → write entire buffer via BOOKMAP LUTs.

### Coordinate conventions

| Axis | Mapping |
|------|---------|
| Y | High price = top. `row = buf_h//2 - (price_ticks - center_ticks)` |
| X | Time left→right historical; newest column at right edge |
| Price tick | `render_tick_size = tick_size * ticks_per_row` |
| Screen Y | `_price_to_screen_y` uses `vis_rows` from widget height // `row_height` |

---

## 2. Buffer / double-buffering / swap issues

### What exists

| Mechanism | Purpose | Notes |
|-----------|---------|-------|
| `engine._buffer` | Authoritative RGBA history | Single buffer; scrolled in-place |
| `_static_cache` QPixmap | Widget-side “static” layer | Rebuilt whenever `_cache_dirty` |
| QOpenGLWidget base | Optional GPU widget | Still QPainter path; not a GL texture pipeline |
| `_buf_swapped` / `_buf_swapped_mv` | **Declared, never used** | Dead R/B swap scaffolding |
| Docstring “np.repeat upscale” | **Stale** | Actual path uses `drawImage` scale of center slice |

### Risks / bugs

| ID | Severity | Issue |
|----|----------|-------|
| R09-B01 | P1 | **Cache is not static.** Every live `push_snapshot` sets `_cache_dirty=True` → full pixmap rebuild + all overlays every tick. Name implies amortization that does not exist. |
| R09-B02 | P2 | **QImage wraps `buf.data` without ownership.** If `np.roll` / `resize` rebinds `_buffer` while a QImage still exists mid-paint (or across threads), UB / wrong image. Today paint is main-thread and wrap is short-lived; still fragile. |
| R09-B03 | P2 | **Horizontal scroll is a full-width copy** every tick: `[:, :-1] = [:, 1:]`. Cost O(H×W×4). No ring buffer / write-head index. |
| R09-B04 | P2 | **`np.roll` on vertical recenter** allocates a new array (or large temp) then clears a band. Under fast mid moves → GC + bandwidth spikes. |
| R09-B05 | P3 | **No true double-buffer for engine.** Mid-frame partial column possible only if another reader peeks during write; single-threaded Qt mostly OK. |
| R09-B06 | P3 | **`resize` keeps partial old pixels** then rebuild usually overwrites; if a code path resizes without rebuild, ghost history possible. |
| R09-B07 | P2 | **Alpha in LUTs vs opaque BG.** `BOOKMAP_*_LUT` low-intensity entries have low alpha; `drawImage` composits onto `BG_DEEP` (not pure black). Can wash colors / look gray-purple under some viewers — same class of artifact `diagnose_rendering.py` hunted. |
| R09-B08 | P1 | **Legacy path** `heatmap_renderer.BookmapHeatmap._refresh_qimg` uses `tobytes()` every frame (full copy) + **debug `print` in paintEvent** — if ever wired again, kills FPS and floods logs. |

---

## 3. Color LUT application

### Two parallel color systems (divergence risk)

| Module | Used by production? | Content |
|--------|---------------------|---------|
| `engine/color_system.py` | **Yes** | `BID_LUT`/`ASK_LUT` (gamma 0.35), `HEATMAP_LUT` (mono→white→red), **`BOOKMAP_BID_LUT` / `BOOKMAP_ASK_LUT`** (teal / amber) |
| `ui/heatmap/color_schemes.py` | **Legacy only** (`heatmap_renderer.py`) | Piecewise Bookmap green/red, matplotlib maps, `make_lut()` |

### Production write path (engine + rebuild)

```python
# density_engine._draw_column & rebuild_heatmap
active_bids = is_bid & (norm_bids > 0.0005)
active_asks = (~is_bid) & (norm_asks > 0.0005)
bid_idx = clip(norm * 255, 0, 255)
buffer[...] = ColorSystem.BOOKMAP_BID_LUT[bid_idx]   # NOT BID_LUT
buffer[...] = ColorSystem.BOOKMAP_ASK_LUT[ask_idx]
```

Side selection:

- Prefer **price vs mid**: rows with `price <= mid` → bid side coloring (even if ask size present).
- Fallback without mid: `bid_arr > ask_arr`.
- **No RGB blend** of bid+ask on one pixel (dominant side / mid split only).

Normalization (`AdaptiveNormalizer`):

- EMA of column 98th percentile (`alpha=0.05`).
- `normalize`: `(value/ref).clip(0,1) ** 2.5` — strong contrast compression.

`apply_color_lut()` still maps **`BID_LUT`/`ASK_LUT`**, not BOOKMAP LUTs — **dead / inconsistent helper** if anything calls it.

### LUT shape

- 256×4 uint8 RGBA.
- BOOKMAP bid: cool teal→mint; ask: warm red→amber→gold; both start `(0,0,0,0)`.
- Baked BBO pixels in column: hard-coded `[100,255,120,180]` / `[255,100,90,180]` — **outside LUT**, will show as “NO LUT MATCH” if diagnose scans for orphans.

---

## 4. BBO tags, grid lines, labels

### Production HeatmapWidget

| Layer | Where | Behavior |
|-------|-------|----------|
| BBO in buffer | `_draw_column` last steps | Stamps bid/ask rows into **every new column** (history trail baked into pixels) |
| BBO history polyline | `_draw_bbo_history_lines` | Mid (magenta glow+line) + bid/ask from `list(self._history)[-bw:]` |
| Current BBO | `_draw_bbo_lines` | Full-width solid bid/ask, dashed magenta mid, **right-axis badges** with price text; min 3px separation; badge anti-overlap |
| Price axis | `_draw_price_axis` | Right panel `price_axis_w=62`, labels every ~40 px, tick marks |
| Timeline separator | paint cache | Vertical line at `timeline_w` |
| Grid lines | **None** in production widget | Only in legacy `heatmap_renderer` (every 5 rows, `GRID_COLOR`) |
| Trades | `_draw_trades` | Size-scaled ellipses via med/p95 |
| Liquidations / icebergs / stops / LLT / pulse / bubbles | respective `_draw_*` | Overlay on cache |

### Critical coordinate bug (history lines)

```text
_price_to_screen_y / buffer mapping → render_tick_size
_draw_historical_price_line → uses engine.tick_size only  # BUG
```

When `ticks_per_row != 1`, mid/BBO **history polylines misalign** vertically vs heatmap cells and current BBO lines.

| ID | Severity | Finding |
|----|----------|---------|
| R09-B09 | **P0/P1** | `_draw_historical_price_line` (heatmap_widget ~1408–1418): `p_ticks = prices / tick_size` but `center_price_ticks` is in **render** ticks. Y offset by factor `ticks_per_row`. |

### Duplicate BBO representation

Buffer-stamped BBO + polyline history + current overlay can **triple-draw** the same levels → thicker/brighter lines, harder debugging of “wrong color at BBO row”.

### Legacy grid/labels

`heatmap_renderer.paintEvent`: grid every 5 rows; price labels every 3rd level — but also a **double-draw bug** on every price (draws every real price, not only `% 3 == 0` due to indentation / fall-through at lines ~328–334).

---

## 5. Performance risks (alloc in paint, Python loops)

### Hot path costs (production)

| Cost | When | Detail |
|------|------|--------|
| Full QPixmap rebuild | Every tick (`_cache_dirty`) | Entire frame of overlays re-executed |
| QImage + scaled drawImage | Every cache rebuild | Qt scales H×W → timeline×height (nearest) |
| `list(self._trades)` + bisect | Trades overlay | Allocates full trade list each cache rebuild |
| `list(self._history)[-bw:]` | BBO history | Full history list copy then slice |
| Python `for` over visible trades | Per cache rebuild | Ellipse per trade |
| LLT: loop all `_levels` | Per cache rebuild | |
| Iceberg/stop prune + draw | Mutates lists during paint path | |
| Pulse: reverse-scan trades 10s | Per cache rebuild | |
| `rebuild_heatmap` | Resize / scroll / zoom | Two float64 grids `H×W`, SciPy filter1d×2, full LUT write |
| `push_snapshot` parse | Every tick | New numpy arrays for bids/asks even if engine could reuse |
| Horizontal memmove | Every live tick | O(buffer) |

### Doc vs reality

- Design rule promised: **np.repeat upscale then native drawImage** (cheap integer upsample).
- Implemented: **QPainter drawImage with QRect scale** (still nearest-neighbor via SmoothPixmapTransform off) — more flexible, slightly heavier than pure np.repeat.

### Benchmark / diagnose tooling

- `benchmark_rendering.py`: instruments `paintEvent` wall time + process `%cpu` at 800×600 / 1920×1080; forces offscreen Qt; useful FPS baselines.
- Does **not** break out engine `_draw_column` vs overlay cost.
- `benchmark_heatmap_gpu.py`: CPU vs QOpenGLWidget class variants.

### Python-loop hotspots (priority)

1. Cache rebuild overlays (trades, markers, history polylines building `list[QPointF]`).
2. `rebuild_heatmap` Python enumerate of history (numpy mapping inside is fine; outer loop + optional re-parse is heavy).
3. Legacy `_rebuild` in `heatmap_renderer`: nested Python loops over columns × prices × snapshot keys — catastrophic if used.

---

## 6. Known issues from diagnose / related scripts

### `diagnose_rendering.py` (stale vs current code)

Script still assumes:

- Pixels come from **`BID_LUT` / `ASK_LUT`**
- `_draw_column` “dominant side by norm comparison” description matching older code comments

**Current production uses `BOOKMAP_BID_LUT` / `BOOKMAP_ASK_LUT` and mid-based side mask.**

Implications:

| Diagnosis claim | Status today |
|-----------------|--------------|
| “No purple from blend of bid+ask” | Still true for side selection (no average of green+red) |
| “All non-BG pixels match BID/ASK_LUT” | **False** — BOOKMAP LUTs differ; BBO stamps differ; low-alpha + composite differs |
| Purple R≈124 G≈114 B≈151 hunt | More likely **alpha over BG_DEEP / panel**, bubbles, or wrong LUT expectations than mid-blend |
| Orphan pixels | Expected for BBO stamps `[100,255,120,180]` etc. |

### Other related notes

- `headless_render.py`: purple/gray anomaly checks on scaled buffer.
- `profile_heatmap_tmp.py`: experimental optimized paint monkey-patches — signals known pain around BBO history / paint.
- `test_bgra.py`: historical investigation of channel order (RGBA vs BGRA); production settled on `Format_RGBA8888` + unused swap buffers.
- Normalizer docstring still mentions fixed ref=8000; code defaults **3000** and **adapts** — docs drift.

---

## 7. Bug hypotheses (prioritized)

| ID | Sev | Area | Hypothesis | Repro hint | Fix hint |
|----|-----|------|------------|------------|----------|
| R09-B09 | P0 | Correctness | History mid/bid/ask **Y misaligned** when `ticks_per_row>1` (`tick_size` vs `render_tick_size`) | Set ticks_per_row=5; compare polyline to cells | Use `render_tick_size` in `_draw_historical_price_line` |
| R09-B01 | P1 | Perf | Every tick full cache+overlay rebuild → low FPS at 1080p | benchmark_rendering uncapped | Split static heatmap QImage (dirty only on buffer change) vs dynamic overlays; or update only dirty rects |
| R09-B10 | P1 | Correctness | **Diagnose/tests assert wrong LUTs** → false green/fail | Run diagnose_rendering after BOOKMAP switch | Update to BOOKMAP_* + accept BBO orphans |
| R09-B11 | P1 | Artifacts | Semi-transparent LUT alphas over non-black `BG_DEEP` → muddy/gray “liquidity” | Compare buffer raw RGB vs on-screen grab | Premultiply, or force opaque LUT over pure black fill under heatmap only |
| R09-B12 | P1 | Correctness | BBO **triple-drawn** (buffer stamp + history + current) confuses brightness/position | Toggle show_bbo; inspect column pixels at BBO rows | Single source of truth for BBO (prefer overlay only) |
| R09-B03 | P2 | Perf | Full horizontal shift O(HW) | Long sessions wide buffer | Circular column index / ring buffer |
| R09-B13 | P2 | Correctness | `rebuild_heatmap` success path **omits `view_changed.emit()`** (early-return path emits) | Scroll-linked charts may desync after rebuild | Emit at end of rebuild |
| R09-B14 | P2 | Correctness | When **not** auto_follow, `push_snapshot` does **not** draw new columns — only dirty UI; history advances but buffer may stale until rebuild | Pause follow, wait ticks, pan | Either incremental write at scroll-adjusted col or force rebuild |
| R09-B15 | P2 | Memory | `_history` maxlen 10000 holds full level lists + arrays; rebuild walks large slices | Long run | Cap width to `target_bw`; store compact columns only |
| R09-B02 | P2 | Stability | QImage over live numpy without `.copy()` | Stress resize during paint | `QImage(...).copy()` or keep stable buffer + dirty flag |
| R09-B16 | P2 | Dual-codebase | `color_schemes` / `heatmap_renderer` vs engine LUTs diverge; `__init__` aliases hide dead code | Import BookmapHeatmap from wrong path | Delete or quarantine legacy renderer; single color module |
| R09-B17 | P2 | UX | No row grid in production; labels only on axis | Visual compare to Bookmap | Optional grid using `ROW_DIVIDER_COLOR` from schemes |
| R09-B18 | P3 | Dead code | `_buf_swapped`, docstring np.repeat, `_render_single_history_column` partially orphaned | Static analysis | Clean up |
| R09-B08 | P2 | Perf | Legacy paint `print` + `tobytes` | Call legacy class | Remove debug prints; wrap buffer without tobytes |
| R09-B19 | P3 | Legacy | Price label double-draw in heatmap_renderer | Open legacy paint | Fix indentation so only every 3rd label draws |
| R09-B20 | P2 | Correctness | Mid-based side paint can color **ask size as green** above mid if only ask rests above mid (and vice versa) | Wall above mid with ask only | Side by resting side bit, not geometric mid, for pure book walls |
| R09-B21 | P3 | Perf | SciPy import inside rebuild when smoothing on | First rebuild after zoom | Import once at module level |
| R09-B22 | P2 | Race (soft) | Iceberg/stop list prune **during** paint mutates shared lists | Concurrent add_trade + paint | Copy-on-draw or prune on data path only |

---

## 8. Architecture summary diagram

```
┌─────────────────────────────────────────────────────────────┐
│ HeatmapWidget (QWidget | QOpenGLWidget)                     │
│  _history ──► rebuild_heatmap ──┐                           │
│  push_snapshot ──► DensityEngine.push_snapshot ─┐           │
│                                                 ▼           │
│                              engine._buffer RGBA HxW        │
│                              (H=5*vis_rows overscan)        │
│                                                 │           │
│  paintEvent ◄── _cache_dirty ◄── push/rebuild   │           │
│     └─ QPixmap cache: QImage(buf) + overlays ◄──┘           │
│     └─ live: crosshair, Go Live                             │
└─────────────────────────────────────────────────────────────┘
         LUT source: engine.color_system.BOOKMAP_{BID,ASK}_LUT
         (ui/heatmap/color_schemes.py = legacy BookmapHeatmap only)
```

---

## 9. Files / line anchors (absolute)

| Path | Role |
|------|------|
| `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py` | Production widget, paint, overlays, rebuild |
| `/Users/nazmi/flowmap/flowmap/ui/heatmap/heatmap_renderer.py` | Legacy BookmapHeatmap (not exported) |
| `/Users/nazmi/flowmap/flowmap/ui/heatmap/color_schemes.py` | Legacy LUTs/helpers |
| `/Users/nazmi/flowmap/flowmap/ui/heatmap/__init__.py` | `BookmapHeatmap = HeatmapWidget` |
| `/Users/nazmi/flowmap/flowmap/engine/density_engine.py` | Buffer, scroll, `_draw_column` |
| `/Users/nazmi/flowmap/flowmap/engine/color_system.py` | Production LUTs |
| `/Users/nazmi/flowmap/flowmap/engine/normalizer.py` | Adaptive ref + `**2.5` |
| `/Users/nazmi/flowmap/benchmark_rendering.py` | FPS/paint timing |
| `/Users/nazmi/flowmap/diagnose_rendering.py` | Buffer/LUT diagnostics (**partially stale**) |

Key line anchors in production:

- paint + QImage wrap: `heatmap_widget.py` ~1129–1184  
- cache flag every tick: ~400  
- rebuild grids + BOOKMAP LUT: ~745–870  
- history line tick bug: ~1401–1418  
- BBO buffer stamp: `density_engine.py` ~384–394  
- LUT write: `density_engine.py` ~372–382  
- buffer height `vis_rows*5`: `density_engine.resize` ~401  

---

## 10. Recommended phase-2 focus (rendering only)

1. Fix **R09-B09** (render_tick_size) — correctness, high confidence.  
2. Align **diagnose/tests** with BOOKMAP LUTs (R09-B10).  
3. Profile paint split: heatmap blit vs overlay stack (R09-B01).  
4. Decide BBO single-path (R09-B12).  
5. Alpha/BG compositing policy (R09-B11).  
6. Quarantine or delete legacy `heatmap_renderer.py` to avoid dual pipelines (R09-B16).  

---

## 11. Confidence

| Claim | Confidence |
|-------|------------|
| Production path is HeatmapWidget+DensityEngine+BOOKMAP LUTs | High (code + `__init__` alias) |
| diagnose_rendering.py stale | High |
| History line tick mismatch | High (code read) |
| Cache rebuilt every tick | High |
| Purple from bid/ask blend | Low (engine does not blend); medium for alpha×BG |
| OpenGL path improves throughput | Unknown without re-running GPU benchmark |

**End R09.**
