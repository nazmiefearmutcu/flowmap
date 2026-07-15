# R08 — HeatmapWidget Structure / API Analysis

**Phase:** Bug-hunt Phase 1  
**Primary file:** `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py` (~2349 LOC)  
**Related:**  
- `/Users/nazmi/flowmap/flowmap/ui/heatmap/heatmap_renderer.py` (legacy `BookmapHeatmap`, **not live path**)  
- `/Users/nazmi/flowmap/flowmap/ui/heatmap/color_schemes.py` (legacy LUTs; **not used by live path**)  
- `/Users/nazmi/flowmap/flowmap/ui/heatmap/__init__.py` re-exports `HeatmapWidget` as `BookmapHeatmap` / `HeatmapRenderer`  
- Live engine: `/Users/nazmi/flowmap/flowmap/engine/density_engine.py` + `color_system.py`  
- Driver: `/Users/nazmi/flowmap/flowmap/ui/main_window.py` (`_gui_timer` @ 16ms)

---

## 1. Executive summary

`HeatmapWidget` is a **god-object QWidget** that owns:

1. Order-book history storage (`_history` deque, maxlen 10k)  
2. DensityEngine orchestration (incremental column push + full rebuild)  
3. Paint pipeline (static QPixmap cache + dynamic crosshair)  
4. All mouse/keyboard navigation (zoom/pan/time/price)  
5. Trade/liquidation/iceberg/stops/LLT/pulse overlay drawing  
6. VolumeBubbles + child VWAPOverlay  

There is **no dedicated animation timer inside the widget**. Updates are **push-driven** from `MainWindow._gui_tick` → `push_snapshot` / `add_trades`, plus `update()` from user interaction and throttled rebuilds via `QTimer.singleShot(50, ...)`.

`heatmap/heatmap_renderer.py` and `heatmap/color_schemes.py` are **legacy / parallel implementations**. Production imports go through `heatmap_widget.HeatmapWidget` and engine `ColorSystem` LUTs.

---

## 2. Class structure

### 2.1 Backend selection (module import time, lines 31–52)

```
FLOWMAP_RENDERER=opengl  → force QOpenGLWidget
FLOWMAP_RENDERER=cpu     → force QWidget
else:
  argv contains test|verify|benchmark|profile → QWidget
  else → try QOpenGLWidget, fallback QWidget
```

**Critical:** OpenGL path only changes **base class surface** (`QOpenGLWidget` vs `QWidget`). There is **no custom GL shader/paintGL path**. Both backends use the same `paintEvent` → `QPainter` + `QImage` from a NumPy RGBA buffer. OpenGL mainly affects grab/render/compositing quirks (see `render()` fallback with `grabFramebuffer`).

```python
BaseHeatmapWidget = QWidget
if use_opengl:
    from PyQt6.QtOpenGLWidgets import QOpenGLWidget
    BaseHeatmapWidget = QOpenGLWidget

class HeatmapWidget(BaseHeatmapWidget):
    ...
```

### 2.2 Signals (lines 63–68)

| Signal | Payload | Purpose |
|--------|---------|---------|
| `price_hovered` | `float` | Cursor price |
| `price_clicked` | `float` | Click without drag |
| `row_height_changed` | `int` | Vertical zoom (px/row) |
| `column_width_changed` | `float` | Horizontal zoom (px/col) |
| `view_changed` | — | Center/scroll/size changed (pulse/VP sync) |
| `iceberg_detected` | `dict` | Iceberg event to main window |

### 2.3 Instance state groups (`__init__` ~70–164)

| Group | Fields | Notes |
|-------|--------|-------|
| Engine | `_engine: DensityEngine(max_levels=100, history_width=10000, decay=0.92)` | Core density buffer |
| Book state | `_bbo`, `_levels`, `_history`, `_all_prices` | Widget keeps full history independently of engine |
| Trades | `_trades`, `_trade_med_size`, `_trade_p95_size`, `_liquidations` | Overlay dots / liqs |
| Overlays | `_bubbles`, `_vwap_overlay` | Bubbles drawn in paint; VWAP is child QWidget |
| Geometry | `row_height`, `column_width`, `COLUMN_WIDTH_LEVELS`, `price_axis_w=62`, `right_margin_w=60` | Layout constants |
| Time scroll | `_scroll_offset`, `_drag_start_scroll_offset`, `auto_follow` | History scrubbing |
| Drag | `_drag_active`, `_drag_start_*`, `_drag_occurred` | Price-axis vs timeline split |
| Cache | `_static_cache: QPixmap`, `_cache_dirty` | Static layer cache |
| Trackers | LLT / iceberg / stops / pulse flags + marker lists | Feature toggles |
| Throttle | `_last_rebuild_time`, `_rebuild_pending` | Max ~20 FPS full rebuild |
| Latency | `_last_receive_timestamp`, `_latency_history`, `last_latency_ms` | HUD in paint |

---

## 3. Method index (approx. line numbers)

### Properties / geometry helpers

| Lines | Method | Visibility | Role |
|------:|--------|------------|------|
| 167–173 | `_buffer` | prop | Compat: visible slice of engine buffer |
| 176–273 | `show_*`, `llt_*`, `iceberg_*`, `stops_*`, `pulse_*`, `bubbles_size_multiplier` | public props | Feature toggles → `_cache_dirty` |
| 275–277 | `_visible_rows` | private | `height // row_height` |
| 280–296 | `_price_min` / `_price_max` | prop | Visible price range from center ticks |
| 298–306 | `_price_to_screen_y` | private | **Canonical** price→Y mapping |
| 308–316 | `get_visible_prices` | public | Row prices top→bottom |
| 318–341 | `get_visible_trades` | public | Trades in visible tick window (bisect) |

### Data ingest / rebuild

| Lines | Method | Visibility | Role |
|------:|--------|------------|------|
| 345–405 | `push_snapshot` | public | Main tick entry from `_gui_tick` |
| 407–409 | `set_levels` | public | Compat → `push_snapshot` |
| 411–421 | `set_bbo` | public | Patch last history BBO |
| 423–495 | `add_trade` | public | Trade + iceberg + stops + bubbles + VWAP |
| 497–572 | `add_trades` | public | Batch version of above |
| 574–585 | `_update_trade_size_percentiles` | private | Median / p95 for trade dots |
| 587–876 | `rebuild_heatmap` | public | **Full O(history) re-render** |
| 877–901 | `_render_single_history_column` | private | Incremental column fill during time-drag |
| 903–913 | `request_rebuild_throttled` | public | 50ms throttle |
| 915–919 | `_deferred_rebuild` | private | `QTimer.singleShot` target |
| 921–927 | `_sync_vwap` | private | Sync VWAP overlay rows/geometry |
| 929–946 | `reset` | public | Clear session + engine + rebuild |

### Zoom / pan / view API

| Lines | Method | Visibility | Role |
|------:|--------|------------|------|
| 948–949 | `set_row_height` | public | → `zoom_to_height` |
| 951–969 | `zoom_to_height` | public | Clamp row_height 2–24, throttled rebuild |
| 971–978 | `set_column_width` | public | Snap to `COLUMN_WIDTH_LEVELS` |
| 980–1002 | `timeframe_zoom_in/out` | public | Step column width |
| 1004–1019 | `scroll_time` | public | Horizontal history scroll |
| 1021–1022 | `set_decay` | public | Engine decay |
| 1024–1027 | `set_min_order_size` | public | Filter + full rebuild |
| 1029–1032 | `set_vertical_smoothing` | public | Engine smooth (cache dirty only!) |
| 1034–1035 | `set_auto_follow` | public | Flag only (no rebuild) |
| 1037–1041 | `zoom_in` / `zoom_out` | public | ±1 row height |
| 1043–1067 | `price_zoom_in/out` | public | Change `ticks_per_row` levels |
| 1069–1073 | `reset_view` | public | rh=4, cw=1, auto_follow, rebuild |
| 1075–1101 | `scroll_price` | public | Vertical pan via `np.roll` buffer |
| 1103–1125 | `render` | public | QWidget/OpenGL grab compatibility |

### Paint / draw stack

| Lines | Method | Visibility | Role |
|------:|--------|------------|------|
| 1129–1334 | `paintEvent` | event | Cache rebuild + crosshair + Go Live btn |
| 1336–1398 | `_draw_bbo_history_lines` | private | Mid/bid/ask history polylines |
| 1401–1438 | `_draw_historical_price_line` | private | Vectorized polyline helper |
| 1440–1557 | `_draw_bbo_lines` | private | Current BBO lines + price-axis badges |
| 1559–1633 | `_draw_trades` | private | Trade dots (size by p95) |
| 1635–1705 | `_draw_liquidations` | private | Liq bubbles + track lines |
| 1707–1742 | `_draw_llt_lines` | private | Large lot dashed lines |
| 1744–1798 | `_draw_icebergs` | private | Circular I: badges (10s TTL) |
| 1800–1858 | `_draw_stops` | private | Diamond S: badges (10s TTL) |
| 1860–1943 | `_draw_pulse_boxes` | private | Market pulse CVD panels |
| 1945–1985 | `_draw_price_axis` | private | Right price labels |

### Input events

| Lines | Method | Visibility | Role |
|------:|--------|------------|------|
| 1989–2081 | `mouseMoveEvent` | event | Drag pan + hover price |
| 2083–2086 | `leaveEvent` | event | Clear hover |
| 2088–2113 | `mousePressEvent` | event | Go Live click / start drag |
| 2115–2131 | `mouseReleaseEvent` | event | Finish drag → rebuild / click |
| 2133–2164 | `mouseDoubleClickEvent` | event | Recenter / go live |
| 2166–2198 | `zoom_to_height_centered` | public | Wheel zoom keep cursor price |
| 2200–2222 | `timeframe_zoom_*_centered` | public | Wheel time zoom keep X |
| 2224–2249 | `set_column_width_centered` | public | Adjust scroll for X-stationary zoom |
| 2251–2301 | `wheelEvent` | event | Zoom vs Ctrl-scroll (see §4) |
| 2303–2331 | `keyPressEvent` | event | Widget-local shortcuts |
| 2333–2349 | `resizeEvent` | event | Resize engine buffer + partial push |

---

## 4. Navigation model (zoom / pan / auto-center / ctrl-scroll)

### 4.1 Coordinate system

- **Y:** price ↑ at top. `center_price_ticks` is middle row; row index from top:  
  `screen_row = (vis_rows//2) - (p_ticks - center)`  
- **X:** time → right is newest (live edge). History columns map left→older.  
- **Margins:** heatmap left of `price_axis_w` (right strip) and `right_margin_w` “live margin”.  
  `timeline_w = width - price_axis_w - right_margin_w`  
  `target_bw = timeline_w / column_width` (engine column count)

### 4.2 Auto-follow / “go live”

| Control | Where | Behavior |
|---------|-------|----------|
| `auto_follow=True` | default | `_scroll_offset=0` every `push_snapshot`; engine recenters mid |
| `auto_follow=False` | drag/scroll | Offset freezes history view; **engine not updated** on new ticks (only dirty+paint) |
| **Go Live button** | paint overlay bottom-right when not following | Click → follow + rebuild |
| Double-click main area | `mouseDoubleClickEvent` | Go live + recenter mid |
| Double-click price axis | same | Recenter mid only |
| Keys **L / Escape** | HeatmapWidget | Go live + rebuild |
| Key **F** | **MainWindow** | Toggle `auto_follow` only (no rebuild!) |
| Key **Space** | **MainWindow** | **Toggles simulation/replay play-pause** — NOT auto-center |
| Status bar text | MainWindow | Claims `F=follow  Space=toggle` |

**Note for bug hunt:** Space ≠ auto-center. Auto-center/live is L/Esc/double-click/Go Live/F. If product docs say “Space = center”, that is wrong relative to code.

### 4.3 Wheel / Ctrl-scroll (lines 2251–2301)

| Region | Wheel alone | Ctrl+Wheel |
|--------|-------------|------------|
| **Price axis** (x ≥ width − price_axis_w) | Vertical **zoom** (`zoom_to_height_centered`) | Vertical **pan** (`scroll_price`) |
| **Main timeline** | Horizontal **time zoom** (column width, cursor-X centered) | Horizontal **time pan** (`scroll_time`) |
| Horizontal wheel / trackpad dx | Always `scroll_time` | — |

**Design inversion vs many apps:** default wheel = zoom; Ctrl = scroll/pan. Easy to mis-document or mis-test.

### 4.4 Mouse drag (lines 1989–2071)

| Drag start | Axis | Action |
|------------|------|--------|
| On price axis | Vertical only | `np.roll` buffer, update center, throttled rebuild |
| On main area | Horizontal only | Scroll history; incremental column re-render via `_render_single_history_column` |

Dead zone: 8px before drag counts. On release with view change → full `rebuild_heatmap`.

### 4.5 Keyboard (widget vs window)

**HeatmapWidget** (needs focus):

| Key | Action |
|-----|--------|
| `+` / `=` | `price_zoom_in` (ticks_per_row finer) |
| Ctrl+`+` | row height zoom in |
| Shift+`+` | timeframe zoom in |
| `-` / Ctrl/Shift variants | corresponding zoom out |
| Left / Right | scroll_time ±50 cols |
| R | `reset_view` |
| L / Esc | go live |

**MainWindow** (if it receives keys first): Space=sim toggle, F=follow toggle, +/−=row zoom, R=reset. **Potential conflict** if both handle +/−/R depending on focus.

---

## 5. Timer / update loop

```
MainWindow._gui_timer  ──16ms──►  _gui_tick()
                                    │ drain queue (≤1000 msgs)
                                    │ apply order book
                                    │ heatmap.add_trades(...)
                                    └ heatmap.push_snapshot(levels, bbo, ts, cvd)

HeatmapWidget.push_snapshot
  ├ if size changed → rebuild_heatmap()          # full
  ├ elif auto_follow → engine.push_snapshot()    # incremental 1 col
  │                     _cache_dirty; update(); view_changed
  └ else (history scrub) → _cache_dirty; update() only  # NO engine push

User drag/zoom → request_rebuild_throttled()
                    ├ immediate rebuild if >50ms since last
                    └ else QTimer.singleShot(50, _deferred_rebuild)

paintEvent → if _cache_dirty: rebuild QPixmap static layers
           → always draw crosshair + Go Live on top
```

**No internal QTimer for continuous repaint** except deferred rebuild singleshot. Latency HUD is computed inside `paintEvent` from `_last_receive_timestamp`.

**Implication:** If data stops and `_cache_dirty` is false, UI freezes visually (expected). Crosshair still moves on mouse because `mouseMoveEvent` → `update()`.

---

## 6. OpenGL vs QWidget paint path

| Aspect | QWidget | QOpenGLWidget |
|--------|---------|---------------|
| Selection | tests / `FLOWMAP_RENDERER=cpu` | default app if import OK |
| paintEvent | identical | identical |
| Buffer → image | `QImage(buf.data, bw, bh, RGBA8888)` | same |
| Static cache | `QPixmap` | same |
| Special | — | `render()` tries `grabFramebuffer` on failure |

**Risk:** Using `QImage` wrapping **NumPy buffer memory** without copy — if engine reallocates `_buffer` (`np.roll` reassigns array, `resize` allocates new), a cached QImage or concurrent paint could **use dangling memory** (crash/corruption). `_static_cache` holds a painted pixmap (safe once painted), but mid-paint buffer swap is still a hazard if paint and push interleave on GUI thread (usually same thread → lower risk unless re-entrancy).

`np.roll` **rebinds** `engine._buffer` (returns new array) — important for QImage lifetime assumptions.

---

## 7. Coupling with DensityEngine and overlays

### 7.1 DensityEngine

| Direction | What |
|-----------|------|
| Widget → Engine | `push_snapshot`, `resize`, `reset`, `set_decay`, `set_vertical_smoothing`, direct mutation of `center_price_ticks`, `_buffer`, `ticks_per_row`, `min_order_size`, dens maps, normalizers, histories |
| Engine → Widget | `get_buffer()`, `get_price_history()`, `render_tick_size`, `center_price_ticks`, LUT writes via ColorSystem |
| Dual ownership of history | Widget `_history` (full entries + pre-parsed arrays) **and** engine `_price_history` / `_bbo_history` / dens maps |
| Dual render paths | Live: `engine.push_snapshot` → `_draw_column`  
  Rebuild: widget builds `bid_grid`/`ask_grid`, scipy smooth, normalizer, writes `engine._buffer` **bypassing** engine draw API |
| Drag scroll | Widget `np.roll`s `engine._buffer` then fills holes via `_render_single_history_column` → `engine.push_snapshot(..., col_idx=)` |

**Tight coupling smell:** `rebuild_heatmap` reaches into private engine fields (`_bid_density`, `_bid_normalizer`, `_buffer`, centering internals). Engine is not a black box.

### 7.2 Color systems (two worlds)

| Path | Colors |
|------|--------|
| Live HeatmapWidget / DensityEngine | `flowmap.engine.color_system.ColorSystem` (`BOOKMAP_BID_LUT` / `ASK_LUT`, `BG_COLOR`) |
| Legacy `heatmap_renderer.py` | Local `_bid_color` / `_ask_color` + `color_schemes.py` constants |
| Overlay UI chrome | `flowmap.ui.theme.Colors` / `Fonts` |

`color_schemes.py` is **not imported** by `heatmap_widget.py`. Safe to treat as dead for live path unless tests import it.

### 7.3 Overlays

| Overlay | Coupling |
|---------|----------|
| **VolumeBubbles** | Owned object; `add_trade` / `draw` in paint with `price_to_y`, `visible_end_frame`, `bw` |
| **VWAPOverlay** | Child QWidget, transparent mouse; `add_trade`, `sync_visible_levels`, geometry in `resizeEvent` |
| **Pulse** (separate widget `pulse.py`) | Reads `_engine`, `auto_follow`, `_scroll_offset`, `price_axis_w`; listens `view_changed` via main window |
| **Volume profile / DOM** | Main window syncs on `view_changed` / gui tick — not drawn inside heatmap paint |
| **Iceberg / Stops / LLT / Pulse boxes** | Inline draw methods; marker state owned by widget |

### 7.4 MainWindow data plane

```
_gui_tick → add_trades + push_snapshot every batch with updates
_on_trade  → add_trade (also when callback path used)
view_changed → _on_heatmap_view_changed → volume profile level sync
```

---

## 8. Logical subsystems (for later bug hunting)

Recommend treating Phase 2 findings under these slices (still one file, but mental modules):

| ID | Subsystem | Lines (approx) | Priority risks |
|----|-----------|----------------|----------------|
| **S1** | Backend / lifecycle | 31–52, 70–164, 929–946, 2333–2349 | OpenGL/CPU divergence, reset races |
| **S2** | Ingest path | 345–585 | Auto-follow vs scrub, history growth, trade frame index |
| **S3** | Full rebuild | 587–876, 903–919 | Freezes, scipy cost, tick detect, centering replay |
| **S4** | Incremental engine draw | engine + push_snapshot branch | Buffer roll, normalizer drift vs rebuild |
| **S5** | Geometry / mapping | 275–316, 298–306, 1945–1985 | Y inconsistency, ticks vs render_tick_size |
| **S6** | Navigation | 948–1101, 1989–2331 | Ctrl-scroll, focus, F without rebuild, dual key handlers |
| **S7** | Paint / cache | 1129–1334 | Stale cache, QImage lifetime, cost of full static redraw |
| **S8** | Trade/Liq overlays | 1559–1705 | Tick alignment, scroll offset math |
| **S9** | Tracker overlays | 1707–1943 | Marker growth, prune during paint, false icebergs |
| **S10** | Child overlays | bubbles, vwap | Z-order, geometry, transparent events |

Suggested Phase 2 order: **S3 → S5 → S6 → S7 → S2** (freeze + visual + interaction).

---

## 9. Data-flow diagrams

### 9.1 Live auto-follow frame

```
OrderBook snapshot
      │
      ▼
push_snapshot
  history.append(levels, bbo, bid/ask arrays, cvd, ts)
  frame_count++
  scroll_offset = 0
      │
      ▼
engine.push_snapshot(auto_follow=True)
  scroll buffer left, recenter, draw rightmost col
      │
      ▼
_cache_dirty = True; update(); view_changed
      │
      ▼
paintEvent → rebuild static pixmap from buffer + overlays
```

### 9.2 History scrub (auto_follow False)

```
push_snapshot
  scroll_offset += 1   # freeze view relative to growing history
  NO engine.push_snapshot
  update()             # overlays/latency may refresh; heatmap buffer STALE for live edge
```

New live data is stored in `_history` but **not painted** until next full rebuild (Go Live / zoom / release drag).

### 9.3 Drag time scrub

```
mouseMove drag on timeline
  roll buffer horizontally
  fill exposed cols via _render_single_history_column
  update()
mouseRelease
  full rebuild_heatmap (canonical consistency)
```

---

## 10. Bug / freeze / visual hypotheses

### H1 — Full rebuild freezes UI (HIGH)
`rebuild_heatmap` walks up to `target_bw` history columns, builds dense 2D grids, optional `scipy.ndimage.gaussian_filter1d`, LUT map. On large `history` / tall windows this is **main-thread blocking**. Throttle is 50ms between *starts*, not a cap on duration. Rapid resize/zoom/drag → stacked work.

### H2 — `set_vertical_smoothing` does not rebuild (MED)
`set_vertical_smoothing` only dirties cache; smoothing applied in rebuild path, **not** in live `engine.push_snapshot` column path. Changing smooth may appear no-op until next full rebuild.

### H3 — Tick size mismatch in history lines (MED–HIGH visual)
`_draw_historical_price_line` uses `engine.tick_size` for `p_ticks`, while `_price_to_screen_y` / trades use `engine.render_tick_size` (= tick_size * ticks_per_row). After price zoom (`ticks_per_row` ≠ 1), **mid/BBO history polylines can misalign** vs heatmap/trades.

### H4 — Auto-follow off drops live engine updates (MED functional)
When scrolled back, `push_snapshot` does not call engine. Going live always rebuilds — OK. But **F toggle** (`set_auto_follow`) does **not** rebuild or reset `_scroll_offset`. Can leave `auto_follow=True` while `_scroll_offset>0` or vice versa → inconsistent “live” state until next snapshot forces offset=0 only when already following.

### H5 — `set_auto_follow(True)` without scroll reset (MED)
MainWindow **F** only sets flag. If `_scroll_offset > 0`, next `push_snapshot` with auto_follow True **forces offset=0** and may size-check rebuild — but between F press and next tick, UI still shows history. Also if sizes match and follow was false, turning follow on only takes effect next tick.

### H6 — QImage zero-copy + buffer rebind (MED crash)
`QImage(buf.data, ...)` during cache paint. Engine methods reassign `_buffer` via `np.roll` / `resize`. Same-thread usually sequential; if paint re-enters (rare Qt nested events) → crash. OpenGL grab path also sensitive.

### H7 — Incremental drag column vs full rebuild divergence (MED visual)
Time-drag uses `engine.push_snapshot(col_idx=...)` which uses live density/normalizer path; full rebuild rebuilds grids with different logic (no decay accumulation in engine dens dicts — rebuild clears dens). After drag, interim look ≠ post-release rebuild.

### H8 — Scroll price / vertical drag without full recolor (MED visual)
`scroll_price` and vertical drag `np.roll` and paint empty BG into exposed rows; full recolor deferred to throttled rebuild. During drag, **empty bands** at edges expected; if rebuild fails/throttled forever under load → permanent blank strips.

### H9 — History / memory growth (MED freeze long-run)
`_history` maxlen 10000 of full level lists + numpy arrays. `engine` history_width 10000. Large books (depth 3000) → huge RAM and rebuild cost.

### H10 — Iceberg false positives / marker list cost (LOW–MED)
Iceberg: trade volume vs last visible size at price, 3s window, merge 15 ticks. Paint prunes by 10s. Under high trade rate, list/loop in paint can hitch. Logic not exchange-true icebergs.

### H11 — Trade tick index vs frame_count when auto_follow false (MED visual)
Trades store `_frame_count` at arrival. Visible window uses `visible_end_frame = frame_count - scroll_offset`. Math is consistent **if** buffer width matches history slice; after column_width zoom without rebuild completion, misalignment possible.

### H12 — Dual keyboard handlers (LOW–MED UX)
Widget and MainWindow both handle +/−/R. Focus on heatmap → widget `price_zoom` vs window `zoom_in` (row height) differ. Confusing “zoom does wrong axis”.

### H13 — Space not auto-center (LOW docs/UX)
Status bar: `Space=toggle` (sim). Widget has no Space handler. If users expect Space=center (common in trading UIs), reported as “broken center”.

### H14 — `rebuild_heatmap` missing `view_changed` on success path (LOW sync)
Early exit (~735–742) emits `view_changed`; successful path ends at 872–876 with only `update()` — **no `view_changed`**. Pulse/volume profile may stay desynced after zoom/rebuild until next live push emits it.

### H15 — `resizeEvent` partial push may not fill buffer (MED visual)
Resize only `engine.resize` + single `push_snapshot` of current levels (one column), not full history rebuild unless later size-mismatch in push triggers rebuild. **Blank history after resize** until auto_follow push triggers size-check rebuild (only if vr/bw changed — already updated `_last_*` so **may skip full rebuild**!).

> **H15 detail:** `resizeEvent` sets `_last_vis_rows` / `_last_hm_w` after resize, then one-column push. Next `push_snapshot` sees matching sizes → **incremental only**, not full history repaint. **Likely blank/garbled history after window resize** until something calls `rebuild_heatmap` (zoom, go live, etc.).

### H16 — OpenGL vs CPU test gap (MED)
Tests force CPU; production OpenGL. Bugs only on GL (grab, `render`, transparency, retina scaling) may escape CI.

### H17 — Legacy files confuse readers (LOW)
`heatmap_renderer.py` still has full widget; package `__init__` aliases to new widget. Editing legacy file has no effect on app.

### H18 — `_draw_bbo_history_lines` uses widget `_history` bid/ask but mid from engine history (LOW visual)
Different sources / lengths if histories diverge after partial updates → bid/ask vs mid desync.

### H19 — Percentiles over all trades deque (LOW hitch)
`_update_trade_size_percentiles` runs on every trade batch over up to 10k sizes (`np.median`/`percentile`) — can hitch under burst trades.

### H20 — `paintEvent` latency mutation (LOW purity)
Paint mutates `_latency_history` — pure paint side effects complicate testing and can skew if paint rate ≠ data rate.

---

## 11. Legacy companion files

### `heatmap/heatmap_renderer.py` (~380 LOC)
Standalone older `BookmapHeatmap(QWidget)` with internal buffer, simpler paint, limited overlays. **Not imported by main app** (`main_window` imports `heatmap_widget`). Kept for tests that import `flowmap.ui.heatmap.BookmapHeatmap` which now **aliases to HeatmapWidget** — so even tests using the name get the new widget.

### `heatmap/color_schemes.py`
LUT builders (`make_lut`, bookmap_bid/ask, matplotlib cmaps). Used by legacy renderer / possibly experiments; **live engine uses `ColorSystem`**.

---

## 12. Public API surface (consumers)

| Consumer | Usage |
|----------|--------|
| `MainWindow` | Construct, connect signals, gui_tick push, settings sliders, keys |
| `SourceManager` | `heatmap.reset()`, touch `_engine` for config |
| `pulse.py` | Read geometry/engine/follow state |
| Tests / verify scripts | `BookmapHeatmap` alias |

**External public methods most used:**  
`push_snapshot`, `add_trade(s)`, `reset`, `set_row_height`, `set_column_width`, `set_decay`, `set_min_order_size`, `set_vertical_smoothing`, `set_auto_follow`, `rebuild_heatmap` (indirect), feature property setters.

---

## 13. Suggested Phase 2 probes

1. **Resize blank history (H15):** resize window with long history; assert buffer not all BG.  
2. **ticks_per_row polyline (H3):** set ticks_per_row=10; compare mid line Y vs `_price_to_screen_y(mid)`.  
3. **F key state machine (H4/H5):** scroll back, press F, check `_scroll_offset` vs `auto_follow`.  
4. **Rebuild timing (H1):** instrument `rebuild_heatmap` wall time at history=5k, vr=400.  
5. **Smoothing (H2):** change smooth live; confirm need rebuild.  
6. **view_changed emit (H14):** zoom; check pulse VP sync without waiting for tick.  
7. **Ctrl-wheel matrix:** document actual vs expected for all 4 combos.  
8. **OpenGL grab:** screenshot/export on both backends.

---

## 14. File map (quick)

```
heatmap_widget.py          ← LIVE god widget (this report)
heatmap/__init__.py        ← re-export / aliases
heatmap/heatmap_renderer.py← DEAD legacy widget implementation
heatmap/color_schemes.py   ← DEAD for live path (legacy LUTs)
engine/density_engine.py   ← LIVE density + buffer
engine/color_system.py     ← LIVE LUTs
ui/bubbles.py              ← volume bubbles
ui/overlays/vwap.py        ← VWAP child widget
ui/main_window.py          ← 16ms driver + Space/F keys
ui/pulse.py                ← sibling consumer of view state
```

---

## 15. Method index cheat-sheet (line-ordered)

```
  60  class HeatmapWidget
  70  __init__
 167  _buffer (property)
 176–273  feature properties
 275  _visible_rows
 280  _price_min / _price_max
 298  _price_to_screen_y
 308  get_visible_prices
 318  get_visible_trades
 345  push_snapshot
 407  set_levels
 411  set_bbo
 423  add_trade
 497  add_trades
 574  _update_trade_size_percentiles
 587  rebuild_heatmap
 877  _render_single_history_column
 903  request_rebuild_throttled
 915  _deferred_rebuild
 921  _sync_vwap
 929  reset
 948  set_row_height / zoom_to_height
 971  set_column_width
 980  timeframe_zoom_in/out
1004  scroll_time
1021  set_decay / set_min_order_size / set_vertical_smoothing
1034  set_auto_follow
1037  zoom_in / zoom_out
1043  price_zoom_in/out
1069  reset_view
1075  scroll_price
1103  render
1129  paintEvent
1336  _draw_bbo_history_lines
1401  _draw_historical_price_line
1440  _draw_bbo_lines
1559  _draw_trades
1635  _draw_liquidations
1707  _draw_llt_lines
1744  _draw_icebergs
1800  _draw_stops
1860  _draw_pulse_boxes
1945  _draw_price_axis
1989  mouseMoveEvent
2083  leaveEvent
2088  mousePressEvent
2115  mouseReleaseEvent
2133  mouseDoubleClickEvent
2166  zoom_to_height_centered
2200  timeframe_zoom_*_centered / set_column_width_centered
2251  wheelEvent
2303  keyPressEvent
2333  resizeEvent
```

---

*End of R08 Phase 1 research.*
