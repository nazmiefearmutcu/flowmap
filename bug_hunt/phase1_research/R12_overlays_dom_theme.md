# R12 — Overlays, DOM Ladder, Theme

**Agent:** R12  
**Scope:** enable/disable + math, volume-profile↔heatmap row alignment, DOM update rate / book sync, theme/CSS consistency  
**Date:** 2026-07-13  
**Files (primary):**
- `/Users/nazmi/flowmap/flowmap/ui/overlays/vwap.py`
- `/Users/nazmi/flowmap/flowmap/ui/overlays/cvd.py`
- `/Users/nazmi/flowmap/flowmap/ui/overlays/volume_profile.py`
- `/Users/nazmi/flowmap/flowmap/ui/dom/dom_ladder.py`
- `/Users/nazmi/flowmap/flowmap/ui/theme.py`

**Integration touchpoints:**
- `/Users/nazmi/flowmap/flowmap/ui/main_window.py` (VP toggles, GUI tick → DOM/VP, MarketPulse layout)
- `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py` (VWAP child overlay, `get_visible_prices` / `get_visible_trades`, `_price_to_screen_y`)
- `/Users/nazmi/flowmap/flowmap/ui/pulse.py` (**live** CVD UI; supersedes `CVDOverlay`)

---

## 1. Overlay enable/disable & math correctness

### 1.1 Enable / disable matrix

| Overlay | Widget class | Wired in UI? | Toggle | Data still feeds when hidden? |
|--------|--------------|--------------|--------|--------------------------------|
| VWAP | `VWAPOverlay` | Yes (child of `HeatmapWidget`) | **None** — always present | Always accumulates on every trade |
| CVD panel (live) | `MarketPulse` | Yes (`main_window` grid row 1) | No dedicated show/hide for pulse | Yes |
| CVD (legacy) | `CVDOverlay` | **No** — export only in `overlays/__init__.py` | N/A | Dead code path |
| Volume Profile | `VolumeProfileOverlay` | Yes (grid row0 col1) | Master + COB/CVP/SVP checkboxes | Yes — `add_trade(s)` still runs when panel hidden |
| DOM Ladder | `DomLadder` | Dock (default **hidden**) | View menu + Settings checkbox | `set_levels` still called every GUI tick; paint skipped if not visible |

**VP toggles** (`main_window.py` ~736–758):
- `Show Volume Profile` → `setVisible`
- Sub-flags `show_cob` / `show_cvp` / `show_svp` → paint-time column list
- When master off, sub-checkboxes disabled but flags not cleared (OK)

**Gaps:**
- No `show_vwap` / hide VWAP line
- No session-reset affordance for VWAP except heatmap `reset()`
- `CVDOverlay` still exported → risk of future dual-CVD confusion with `MarketPulse`

---

### 1.2 VWAP math & rendering

**Formula** (`vwap.py` `add_trade`):
```text
Σ(price * size) / Σ(size)
```
Session-style incremental VWAP — correct for continuous accumulation, **not** anchored day-session VWAP (no RTH/UTC day boundary).

| Risk | Severity | Detail |
|------|----------|--------|
| Always-on overlay | P3 | No toggle; always draws when `_current_vwap` set |
| No session boundary | P2 | Long live sessions: VWAP converges toward mean, loses “today’s VWAP” meaning |
| FP accumulation | P3 | Long double sums without Kahan / reset |
| Y mapping `int(parent._price_to_screen_y(...))` | P2 | Truncation + row-center formula can sit off heatmap row by ~0.5–1 px; at `row_height=2–4` looks wrong |
| Line width vs layout | P2 | Line ends at `w - price_column_width`; `price_column_width` synced to `price_axis_w` (62). Heatmap also has `right_margin_w=60` — line may under/over-shoot visual heatmap body |
| Fallback match `abs(price - vwap) < 0.001` | P2 | Misses when VWAP between ticks or tick ≪ 0.001; falls back to linear interpolate over visible levels only if in range |
| Fallback uses `row_height` discrete, primary path uses engine ticks | P2 | Two Y systems if parent method missing |
| Dual VWAP state | P3 | Plugin API also tracks VWAP separately (`plugin_api.py`) — can disagree with overlay |
| `update()` every trade | P3 | No paint throttle (DOM/Pulse have throttles) |

Parent geometry: `resizeEvent` sets `setGeometry(self.rect())` — good. Transparent for mouse — good.

---

### 1.3 CVD (`CVDOverlay` vs `MarketPulse`)

**Live path:** `MarketPulse` under heatmap. Theme-aware colors, 33 ms throttle, sweep detection, window=300.

**`CVDOverlay` (dead):**
- Hardcoded greens/reds **not** from `Colors.CVD_*`
- Window=200; **X axis = sample index**, not wall time (timestamps stored, unused for layout)
- Dense bursts compress; idle stretches — misread as “time series”
- Fill builder for zero-crossings builds multi-segment polys that can self-overlap when CVD oscillates
- `import time` inside `add_trade`
- `drawPolygon(*qpoints)` — fragile API use (prefer `QPolygonF`)

**Hypothesis H-CVD-DEAD:** `CVDOverlay` is obsolete; any work should target `MarketPulse` or delete/redirect export.

---

### 1.4 Volume profile math

| Feature | Behavior | Risk |
|---------|----------|------|
| SVP | `round(price, 6)` buckets; cumulative size | Tick-snapped heatmap prices vs raw trade prices → **bucket miss** (see alignment §2) |
| POC | Incremental max | Correct for pure adds; no recompute if data ever removed |
| Value Area 70% | Sort levels by volume desc, accumulate, then `min/max` of selected prices | **Not** classic POC-centered contiguous expansion; VA can span empty mid-range; still common approximation but can surprise traders |
| CVP | Rebuilt every `paintEvent` from `heatmap.get_visible_trades()` | Costly; empty if engine buffer missing; time filter by tick index |
| COB | From `heatmap._levels` or `order_book.get_levels()` | Bid wins if both bid+ask at same price (`elif ask`) — rare but wrong for locked/crossed books |
| `reset()` | Clears SVP/CVP, not COB (live book) | Docstring claims “Clear all COB, CVP, and SVP” — **COB not a store**, wording misleading |

**CVP `get_visible_trades`:**
- Uses bisect on tick index field (`t[4]` if len==5 else `t[3]`)
- Depends on `_engine.get_buffer()` width; if buffer `None` → CVP empty while SVP still grows
- Trades deque maxlen 10000 — deep history scroll can drop CVP volume

---

## 2. Volume profile row alignment with heatmap

### 2.1 Intended sync path

1. Heatmap emits `view_changed` / `row_height_changed`
2. `main_window._on_heatmap_view_changed` / `_on_row_height_changed`:
   - `prices = heatmap.get_visible_prices()`
   - `profile_levels = [SimpleNamespace(price=p) for p in prices]`
   - `volume_profile.set_levels` + `set_row_height`

`get_visible_prices()` (heatmap): top→bottom, engine tick center + `vis_rows = height // row_height`.

### 2.2 Paint geometry mismatch (HIGH)

**Heatmap rows:** fixed pixel rows  
`y = screen_row * row_height` (± center for overlays), leftover `height % row_height` pixels at **bottom unused**.

**Volume profile rows** (`volume_profile.py` ~328–333):
```python
y_start = int(i * h / bh)
y_end   = int((i + 1) * h / bh)
```
Distributes **full widget height** across `bh` levels.  
`self.row_height` is stored/updated but **ignored in paint**.

**Effect:** rows drift vs heatmap; worse as remainder grows or `row_height` changes. At small `row_height` (2–4), fractional pixel heights cause 1-px jitter and bar/heatmap desync.

### 2.3 Header / footer overlay (HIGH)

HUD header (20px) + footer (16px) drawn **on top of** row 0 / last rows without shifting coordinate origin. Top/bottom price rows are partially covered and not vertically offset relative to heatmap.

### 2.4 Price key / float alignment (HIGH)

- Trades → `round(price, 6)`
- Visible levels → `center_ticks * render_tick_size` (float)
- Lookup: `_cvp_volumes.get(price_key)` / `_svp_volumes.get(price_key)` exact key

If trade price is not identical after round-to-6 as displayed level (or tick size > 1e-6 and engine snaps differently), bars **vanish** for that row despite volume existing nearby.

Evidence of prior concern: `scratch/debug_vp.py` explicitly probes level-vs-volume key mismatch (file still references old `_volumes` / `_total_volume` attrs — script is **stale** vs current SVP/CVP API).

### 2.5 Sync emit gaps (MEDIUM)

`HeatmapWidget.push_snapshot`:
- `auto_follow=True` → `view_changed.emit()` → VP resyncs
- `auto_follow=False` branch only marks dirty / `update()` — **no** `view_changed` on every frame

Vertical pan/rebuild paths do emit `view_changed` in several places, but any code path that changes visible price set without emit leaves VP stale.

### 2.6 COB source vs visible rows (LOW–MEDIUM)

Paint normalizes COB using visible price list but size maps from full `heatmap._levels` / order book. Correct for sizes; if visible prices are tick-grid while book has coarser/finer prices, COB bars missing at grid rows (same key issue as SVP).

### 2.7 Layout stretch

Grid: heatmap + VP same row stretch; heights match widget-wise. Alignment bug is **coordinate mapping**, not Qt stretch.

---

## 3. DOM ladder — update rate & book sync

### 3.1 Pipeline

```text
_gui_timer 16ms (~60 Hz)
  → _gui_tick
  → order_book apply_*
  → levels = get_levels()  # ALL pruned levels, sorted ascending
  → _dom_ladder.set_levels(levels)
  → _dom_ladder.set_bbo(bbo)
```

### 3.2 Paint throttle

- `_update_interval_ms = 50` → max ~20 FPS
- Single-shot `QTimer` coalesces bursts
- `isVisible()` gate: no `update()` when dock hidden (good); **data still overwritten** each tick (good for show)

**Desync risk:** BBO and levels can be applied in separate `set_*` calls → up to one throttle window where paint sees new levels + old BBO (or vice versa). Prefer single `set_book(levels, bbo)`.

### 3.3 Windowing / centering (HIGH)

```python
visible_count = h // row_height + 2
display_levels = self._levels[-visible_count:]  # highest prices
display_levels.reverse()
```

- `_depth` is settable but **never used**
- Shows **top of sorted book (highest prices)**, not BBO-centered ladder
- Deep books: user mostly sees ask stack; bids below viewport are dropped
- Wheel handler accepts event but **does not scroll** (comment: “future”)

### 3.4 Hover / click index

Hover maps `actual_idx = total - 1 - display_row` — consistent with reverse of full list and with the “last N” slice for displayed rows. Empty region below last painted row can still map into non-displayed lower prices if `display_row` small enough… actually lower display rows map to lower prices within the high-price window. Hover outside painted rows may still emit prices from the high-price window incorrectly if `display_row` large but beyond `len(display_levels)`.

`mouseMoveEvent` always `self.update()` — bypasses 50 ms throttle → hover can fight data-driven paints.

### 3.5 Normalization & layout

- `max_bid` / `max_ask` from **entire** `_levels`, not visible window → bars tiny when large size outside viewport
- Column layout: `BAR_MIN_WIDTH=40` ×2 can force total width **>** widget width (e.g. min dock 300 vs fixed 238 + 80 bars) → clip
- BBO match `abs(price - bbo) < 0.001` — fails for very fine ticks or non-2dp symbols
- Price label always `f"{price:.2f}"` — wrong for BTC 0.1 / crypto 1e-8 style books
- Spread label draws below price text with height 12 inside `row_height` (default 20) — OK; tight if row_height reduced (no UI to shrink DOM rows from heatmap zoom)

### 3.6 Sync with heatmap zoom

DOM `row_height` independent of heatmap (default 20 vs heatmap 4). No `row_height_changed` hook → intentional for readability, but not “Bookmap-aligned” to heatmap rows.

---

## 4. Theme / CSS consistency

### 4.1 Central theme (`theme.py`)

- `Colors`: solid dark palette (BG_DEEP `#0A0B10`, BG_PANEL, accents green/red/blue/amber)
- `Fonts.MONO` = JetBrains Mono; `Fonts.SANS` = Inter (+ fallbacks)
- `MAIN_STYLESHEET`: QMainWindow, menus, toolbar, docks, scrollbars, buttons — hex mirrors `Colors`

### 4.2 Who uses theme vs hardcodes

| Component | Colors | Fonts |
|-----------|--------|-------|
| `DomLadder` | `Colors.*` for palette | Hardcoded **Menlo** / Helvetica Neue — ignores `Fonts.mono/sans` |
| `VolumeProfileOverlay` | Partial (`BG_PANEL`, `TEXT_SECONDARY`) | Mix Inter / Helvetica; bid/ask bars hardcoded QColor(16,185,129)/(239,68,68) ≈ accents |
| `VWAPOverlay` | Gold `#FFD700` — **not** in `Colors` | Menlo hardcoded; badge `QColor(18,18,22)` ≈ old panel, not `BG_PANEL` 18,19,26 |
| `CVDOverlay` | Fully hardcoded | Menlo / Helvetica |
| `MarketPulse` | Good: `Colors.CVD_*` | Uses theme fonts pattern |
| `main_window` central | `background: #000000` | Conflicts with `BG_DEEP` `#0A0B10` |
| Splitter | Local `#1F222F` | Matches `BORDER_SUBTLE` / stylesheet |
| Pulse spacer | `#0C0D14` | Matches `BG_STATUSBAR` / chart-ish |

### 4.3 Issues

1. **Dual truth:** QSS hex strings not generated from `Colors` — drift risk when palette changes  
2. **Central black `#000`** vs theme deep slate — visible seam around heatmap  
3. **Font family split:** Menlo (mac) vs JetBrains Mono (theme claim) — metrics/label widths differ across widgets  
4. **VWAP gold** outside palette; no amber `ACCENT_YELLOW` reuse  
5. **CVD fill alpha:** theme fill alpha 45 vs dead overlay 76 — inconsistent if both ever shown  
6. Local `setStyleSheet` on sidebar/groups **overrides** parts of `MAIN_STYLESHEET` — harder to reason about cascade  
7. DOM class-level `QColor(...)` evaluated at import from `Colors` — OK unless Colors mutated (they aren’t)

---

## 5. Bug hypotheses (actionable)

| ID | Sev | Area | Hypothesis | Repro sketch | Fix hint |
|----|-----|------|------------|--------------|----------|
| **R12-H01** | P1 | VP align | VP rows use `i*h/bh` while heatmap uses fixed `row_height` → systematic vertical misalignment | Zoom row_height 2→12; compare BBO row on heatmap vs COB bar | Paint with `y = i * row_height`; clip to `vis_rows * row_height`; ignore remainder |
| **R12-H02** | P1 | VP keys | `round(price,6)` trade buckets ≠ tick-snapped `get_visible_prices()` → empty SVP/CVP bars on visible rows | Instrument with raw trade prices vs level prices; or run updated debug_vp | Snap trades to `render_tick_size` / same key as engine |
| **R12-H03** | P1 | DOM window | Ladder shows highest N prices, not mid-around BBO | Deep book, open DOM — bids missing | Center slice on BBO index; use `_depth` |
| **R12-H04** | P2 | VP HUD | Header/footer cover first/last rows without y-offset | Inspect top price row under “COB/CVP/SVP” banner | Reserve top/bottom margins or draw HUD outside plot |
| **R12-H05** | P2 | VA math | 70% volume-ranked min/max is not contiguous VA-from-POC | Synthetic profile: two high-volume wings, empty center still “in VA” | Expand from POC alternately until 70% |
| **R12-H06** | P2 | VWAP UX | No disable; line width ignores `right_margin_w` | Visual: VWAP line into price axis / short of right margin | Toggle + use same geometry constants as heatmap paint |
| **R12-H07** | P2 | DOM throttle | Separate `set_levels`/`set_bbo` + 50ms throttle → transient wrong spread highlight | Burst updates; screenshot BBO lines | Atomic update API; single dirty flag |
| **R12-H08** | P2 | CVD dead | `CVDOverlay` unused; `MarketPulse` is real CVD | Grep: only export | Delete or thin-wrap; don’t fix dead fill bugs first |
| **R12-H09** | P2 | CVP empty | `get_visible_trades` returns [] when engine buffer None / wrong tick key | Early session before rebuild; assert CVP footer volume | Fallback to time window on `_trades` without buffer |
| **R12-H10** | P2 | Theme drift | Hardcoded fonts/colors vs `theme.py` | Side-by-side Menlo vs Inter labels | Mandate `Fonts.*` / `Colors.*` in overlays+DOM |
| **R12-H11** | P3 | DOM overflow | `BAR_MIN_WIDTH` forces width > dock min | Resize DOM dock narrow | Soft-min bars; scale fixed columns |
| **R12-H12** | P3 | DOM scroll | Wheel accepted, no offset | Wheel on long book | Implement `scroll_offset` or center lock |
| **R12-H13** | P3 | COB both sides | `if bid elif ask` hides ask when both sizes present | Locked market level | Draw dual mini-bars or net |
| **R12-H14** | P3 | view_changed | Non-auto-follow snapshot path may skip VP level refresh | Disable auto-follow, wait for ticks, compare VP prices | Always emit view_changed when visible price set changes |
| **R12-H15** | P3 | Price format | DOM/VWAP `.2f` wrong for many symbols | Non-2dp instrument | Format from tick size / symbol meta |

---

## 6. Severity summary

| Severity | Count (hypotheses) | Top concerns |
|----------|-------------------|--------------|
| P1 | 3 | VP row math, price bucket keys, DOM not BBO-centered |
| P2 | 7 | VA algorithm, VWAP geometry/toggle, DOM BBO race, dead CVD, CVP empty, theme, HUD |
| P3 | 5 | Overflow, scroll stub, dual bid/ask, view_changed gap, price decimals |

---

## 7. Recommended Phase-2 focus (this scope only)

1. **Unify vertical mapping** for heatmap, VWAP, and volume profile (single `price_to_y` / `row_index` helper from engine ticks).  
2. **Snap all profile volumes to render tick** before dict insert.  
3. **DOM:** BBO-centered window + use `_depth` + atomic `set_state(levels, bbo)`.  
4. **Cull or rewire `CVDOverlay`**; keep `MarketPulse` as single CVD.  
5. **Theme audit:** replace Menlo/gold/black hardcodes in overlays+DOM; generate QSS from `Colors` if feasible.  
6. Refresh `scratch/debug_vp.py` to current SVP/CVP API for automated alignment checks.

---

## 8. Code anchors (quick nav)

| Topic | Location |
|-------|----------|
| VWAP accum + paint | `overlays/vwap.py:54–166` |
| VWAP parent geometry | `heatmap_widget.py:2333–2336`, `_sync_vwap:921–927` |
| VP row y | `overlays/volume_profile.py:328–333` |
| VP VA | `volume_profile.py:168–255` |
| VP toggles | `main_window.py:264–283, 736–758` |
| VP + DOM feed | `main_window.py:949–970` |
| GUI 16ms | `main_window.py:714–715` |
| DOM throttle 50ms | `dom_ladder.py:90–126` |
| DOM windowing | `dom_ladder.py:191–196` |
| Theme | `theme.py` full file |
| Live CVD | `pulse.py` (`MarketPulse`) |
| Dead CVD | `overlays/cvd.py` |

---

*End R12 Phase-1 research.*
