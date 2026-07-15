# R18 — UX / Keyboard / Mouse / GUI Control Surface Inventory

**Agent:** R18  
**Phase:** 1 — Research  
**Date:** 2026-07-13  
**Scope:** Standalone FlowMap (`/Users/nazmi/flowmap`)  
**Primary sources:**
- `flowmap/ui/main_window.py`
- `flowmap/ui/toolbar_manager.py`
- `flowmap/ui/source_manager.py`
- `flowmap/ui/heatmap_widget.py`
- `flowmap/ui/panels/features_dialog.py`
- `flowmap/ui/pulse.py` (context menu)
- `README.md` (Controls section)
- Entry: `run_flowmap.py` → `flowmap/main.py` → `MainWindow`

**Purpose:** Inventory every user-facing control and shortcut for Phase 3 computer-use (CUA) automation. Document expected behavior, app states, dropdown/source options, CUA scenarios, and likely UX bugs.

---

## 1. Window chrome & layout surface

| Region | Widget / ID | Default visibility | Notes |
|--------|-------------|--------------------|-------|
| Main window | `MainWindow` title `"FlowMap"` | Shown | Size 1500×950, min 900×600, moved to (100,100) |
| Toolbar | `QToolBar` via `ToolbarManager.create_toolbar()` | Always | Non-movable; dark theme |
| Status bar | `QStatusBar` `_status` | Always | Bid/Ask/Vol/CVD when running; help text when idle |
| Menu bar | `&View` only | Always | Checkable dock toggles |
| Left visualizer | Heatmap + Volume Profile + Market Pulse (CVD) grid | Always (pulse hideable) | Splitter left pane |
| Right sidebar | `sidebar` `QFrame#sidebarPanel` | Visible | Min width 320; tabs VISUALS / INDICATORS / SETTINGS |
| Docks | DOM Ladder, Significant Icebergs, Large Lot Tracker | Iceberg+LLT shown; DOM hidden | Right dock area |
| Features dialog | `FeaturesDetailDialog` | **Never opened** | Imported in `main_window` but no menu/button wires it |

**Auto-start behavior (important for CUA):**
```python
# main_window.__init__
self._source.switch_to(self._source.data_source)  # default CRYPCODILE_LIVE
QTimer.singleShot(500, self._source.toggle_simulation)  # auto Start after 500ms
```
App does **not** remain idle after launch; it attempts live connect automatically.

---

## 2. Full control inventory (user-facing)

### 2.1 Toolbar (`ToolbarManager.create_toolbar`)

| Control | Type | Object / Label | Default | Action | Expected behavior |
|---------|------|----------------|---------|--------|-------------------|
| Symbol | `QLineEdit` | Label `" Symbol: "`, placeholder `binance-spot:SOLUSDT` | `binance-spot:SOLUSDT` (from source) | `editingFinished` → `SourceManager.on_symbol_changed` | On valid change: stop provider if any, reset book/heatmap/VP/pulse/chart, re-init provider for current source, optionally resume if was running. Empty string reverts to previous symbol. |
| Start/Stop | `QPushButton` | `"▶ Start"` / `"■ Stop"`; objectName `startBtn` / `stopBtn` | Start (green) | `clicked` → `SourceManager.toggle_simulation` | Toggles replay or live depending on `DataSource`. Visual polish via unpolish/polish. |
| Sidebar | `QPushButton` checkable | `"Sidebar"`, objectName `sidebarBtn` | Checked | `clicked` → `_on_sidebar_toggled` | Shows/hides `window.sidebar`; syncs `show_sidebar_cb` (signals blocked). |

**Declared but NOT built in toolbar UI (dead references):**
| Field | Status | Impact |
|-------|--------|--------|
| `_source_combo` | `Optional[QComboBox] = None`, never `addWidget` | No toolbar source dropdown despite README & `_on_source_changed` |
| `_replay_speed_spinner` | Always `None` | `setEnabled` calls in `SourceManager.switch_to` are no-ops |
| `update_visibility` / `set_connected_state` | `pass` stubs | No connected/disconnected chrome updates |

### 2.2 Menu — View

| Action | Checkable | Default | Effect |
|--------|-----------|---------|--------|
| DOM Ladder (DOM Pro) | Yes | Unchecked | `_dom_ladder_dock.setVisible` bi-synced with dock `visibilityChanged` |
| Significant Icebergs | Yes | Checked | Iceberg dock |
| Large Lot Tracker | Yes | Checked | LLT dock |
| Market Pulse (CVD) | Yes | Checked | `set_cvd_visible` → `_pulse` + `pulse_right_spacer` |

**Desync risk:** View → Market Pulse is **not** synced with INDICATORS tab `"Market Pulse Overlay"` checkbox (`heatmap.pulse_enabled` only). CVD panel hide ≠ pulse overlay markers.

### 2.3 Sidebar — VISUALS tab

| Control | Default | Callback | Expected |
|---------|---------|----------|----------|
| Show Order Heatmap | ON | `_on_show_heatmap_toggled` | `heatmap.show_heatmap`; repaint |
| Show BBO Lines | ON | `_on_show_bbo_toggled` | `heatmap.show_bbo`; repaint |
| Show Trades | ON | `_on_show_trades_toggled` | `heatmap.show_trades`; repaint |
| Show Volume Profile | ON | `_on_show_vp_toggled` | `volume_profile.setVisible`; enables/disables COB/CVP/SVP children |
| Show COB (Book Depth) | ON | `_on_show_cob_toggled` | `volume_profile.show_cob` |
| Show CVP (Chart Vol) | ON | `_on_show_cvp_toggled` | `volume_profile.show_cvp` |
| Show SVP (Session Vol) | ON | `_on_show_svp_toggled` | `volume_profile.show_svp` |

### 2.4 Sidebar — INDICATORS tab

| Control | Default | Range / unit | Expected |
|---------|---------|--------------|----------|
| Large Lot Tracker (LLT) | ON | — | `heatmap.llt_enabled` |
| LLT Threshold | `heatmap.llt_threshold` (15.0 default; symbol-dependent after source init) | 1–50000 Qty | Sets threshold; syncs dock `_min_llt_size_spin` |
| Iceberg Tracker | ON | — | `heatmap.iceberg_enabled` |
| Stops Tracker | ON | — | `heatmap.stops_enabled` |
| Stops Threshold | `heatmap.stop_threshold` (10.0) | 1–50000 Qty | `heatmap.stop_threshold` |
| Market Pulse Overlay | ON | — | `heatmap.pulse_enabled` (overlay on heatmap, **not** CVD panel visibility) |

**Symbol-driven threshold defaults** (`SourceManager.update_thresholds_for_symbol`):

| Symbol substring | LLT thresh | Stops thresh | `ticks_per_row` | bid/ask ref |
|------------------|------------|--------------|-----------------|-------------|
| SOLUSDT | 5000 | 100 | 2 | 3000 |
| ETHUSDT | 250 | 20 | 10 | 100 |
| else (BTC path) | 15 | 10 | 100 | 5 |

### 2.5 Sidebar — SETTINGS tab

| Control | Default | Range | Expected |
|---------|---------|-------|----------|
| Main Sidebar Panel | ON | — | Hide/show sidebar; sync toolbar Sidebar button |
| Significant Icebergs | ON | — | Dock visibility (`state == 2`) |
| Large Lot Tracker | ON | — | Dock visibility |
| DOM Ladder | OFF | — | Dock visibility |
| Enable Replay Mode | OFF if source is LIVE (startup default) | checkbox | Checked → `CRYPCODILE_REPLAY`; unchecked → `CRYPCODILE_LIVE`. Shows/hides speed container. |
| Speed | 20.0x | 0.1–20.0 step 0.1 | `source.replay_speed` → provider `set_speed` if present |
| Centering Mode | Smooth Deadband (index 3) | Immediate / Deadband / EMA / Smooth Deadband | `heatmap._engine.centering_mode` strings: `immediate`, `deadband`, `ema`, `smooth_deadband` |
| Min Order Size Filter | 0.0 Qty | 0–100000 | `heatmap.set_min_order_size` (Tradermap Pro style filter) |
| Decay slider | 92 → label 0.92 | 70–99 | `heatmap.set_decay(val/100)` |
| Smooth slider | 10 → 1.0 | 0–30 | `heatmap.set_vertical_smoothing(val/10)` |
| Sensitivity slider | 3000 | 100–10000 | Overwrites normalizer `global_ref` bid+ask |
| Bubbles Size slider | 10 → 1.0x | 1–50 | `heatmap.bubbles_size_multiplier = val/10` |

**Dead slider hooks (code paths exist, UI not created):**
- `_on_zoom_changed` / `zoom_slider` / `zoom_label` — updated from heatmap signals if present, never constructed
- `_on_timeframe_changed` / `tf_slider` / `tf_label` — same

### 2.6 Docks

#### DOM Ladder (DOM Pro)
- Dock title: `"DOM Ladder (DOM Pro)"`
- Default: **hidden**
- Fed each GUI tick with levels + BBO when visible path runs
- Own mouse move/press; wheel currently no-ops (comment: future scroll_offset)

#### Significant Icebergs
- Table columns: Time, Side, Price, Size, Hidden
- Min Size spin: 0.01–100000, default 1.0 Qty (filter only on insert)
- Clear button → `setRowCount(0)`
- Cap 100 rows
- Filled via `heatmap.iceberg_detected` signal

#### Large Lot Tracker
- Table: Side, Price, Size
- Min Size spin synced one-way from INDICATORS LLT spinner (dock → heatmap only; reverse sync from dock spin does **not** update sidebar spinner)
- Rebuilt every GUI tick from book levels ≥ threshold (max 50 rows)

### 2.7 Heatmap interactive surface (`HeatmapWidget`)

| Input | Region | Behavior |
|-------|--------|----------|
| Mouse move | Anywhere | Updates hover price; status via `price_hovered`; drag pans if active |
| LMB press | "↩ Go Live" btn when `!auto_follow` | Re-enable auto-follow, scroll_offset=0, rebuild |
| LMB drag | Price axis (x ≥ width − price_axis_w) | Vertical pan only; disables auto_follow |
| LMB drag | Main timeline | Horizontal history scroll; auto_follow true iff scroll_offset==0 |
| LMB release | After drag | Rebuild if view changed; re-enable follow if offset 0 |
| LMB release | Click (no drag) | `price_clicked` emit if hover price set |
| LMB double-click | Price axis | Recenter to BBO mid |
| LMB double-click | Main area | Go live + recenter mid |
| Wheel | Horizontal delta | `scroll_time` |
| Wheel (no Ctrl) | Price axis | Vertical zoom centered on cursor (`row_height` 2–24) |
| Wheel + Ctrl | Price axis | Vertical price scroll (`scroll_price`) |
| Wheel (no Ctrl) | Main area | Timeframe zoom in/out centered (`COLUMN_WIDTH_LEVELS`) |
| Wheel + Ctrl | Main area | Time horizontal pan |
| Leave | — | Clear hover |

**Overlay button when scrolled back:** `"↩ Go Live"` bottom-right of timeline (~100×30 px).

### 2.8 Market Pulse (CVD) panel
- Right-click context menu: Color Vision Deficiency modes (`ColorVisionMode` enum values as checkable actions)
- View menu hide removes panel + spacer

### 2.9 Features dialog (`FeaturesDetailDialog`)
- Window title: `"FlowMap — Details About Features"`
- Close button
- 9 informational cards (Liquidity Heatmap, Volume Bubbles, BBO, DOM, Nanosecond Zoom, Stops & Iceberg, Tradermap Pro, DOM Pro, Market Pulse)
- **No opener in UI** → unreachable without code

---

## 3. Keyboard shortcuts

### 3.1 MainWindow (`keyPressEvent`) — focus on main window / non-heatmap

| Key | Expected (code) | Status bar feedback |
|-----|-----------------|---------------------|
| `Space` | `toggle_simulation` (Start/Stop) | Via source status updates |
| `F` | Toggle `heatmap.auto_follow` | `"Auto-follow: ON/OFF"` |
| `+` or `=` | `heatmap.zoom_in()` (row_height +1) | — |
| `-` | `heatmap.zoom_out()` | — |
| `R` | `heatmap.reset_view()` (rh=4, col_w=1.0, auto_follow ON) | `"View Reset: auto-follow ON, default zoom"` |
| `D` | Cycle decay slider through **[80, 85, 90, 95]** only | If current not in list → sets 88 |

**Idle help string** (when not running or no BBO):
`F=follow  Space=toggle  +/−=zoom  R=reset  D=decay`

### 3.2 HeatmapWidget (`keyPressEvent`) — requires heatmap focus (StrongFocus)

| Key | Modifiers | Expected |
|-----|-----------|----------|
| `+` / `=` | none | `price_zoom_in` (decrease `ticks_per_row` along [1,2,5,10,20,50,100,200,500]) |
| `+` / `=` | Ctrl | `zoom_in` (row height +1) |
| `+` / `=` | Shift | `timeframe_zoom_in` |
| `-` | none | `price_zoom_out` |
| `-` | Ctrl | `zoom_out` |
| `-` | Shift | `timeframe_zoom_out` |
| `←` | — | `scroll_time(+50)` (look further back) |
| `→` | — | `scroll_time(-50)` (toward live) |
| `R` | — | `reset_view` |
| `L` or `Esc` | — | Force go-live (auto_follow, scroll=0, rebuild) |

**Critical UX conflict:** Same physical keys `+`/`-`/`R` mean **different things** depending on whether MainWindow or Heatmap has focus. MainWindow treats plain `+` as row-height zoom; Heatmap treats plain `+` as price-scale (`ticks_per_row`) zoom.

No `QShortcut` objects exist — all handling is `keyPressEvent` only (focus-sensitive).

---

## 4. README vs implementation (controls section)

README (lines 97–98):
> Choose **Simulator** or **Crypcodile Replay** from the toolbar source dropdown.  
> Press **Start**. Use `+`/`-` or mouse scroll with **Ctrl** held to adjust vertical line zoom. Use **Space** to toggle auto-follow BBO centering.

| README claim | Code reality |
|--------------|--------------|
| Source dropdown Simulator / Replay | **No toolbar dropdown.** Sources are LIVE / REPLAY via SETTINGS checkbox only. Simulator not in `DataSource` enum. |
| Ctrl+scroll = vertical zoom | Default wheel = zoom; **Ctrl+scroll = pan/scroll** (inverted vs README) |
| Space = auto-follow | Space = **Start/Stop**; **F** = auto-follow |
| Simulator as first-class source | `MarketSimulator` exists in data layer; not wired in UI `SourceManager` |

---

## 5. Dropdown / source options

### 5.1 Actual `DataSource` enum (`source_manager.py`)

| Enum member | How selected in UI | Start behavior |
|-------------|--------------------|----------------|
| `CRYPCODILE_LIVE` | Default; SETTINGS **Enable Replay Mode** unchecked | `connect()` on Start; running set true on `on_connected` |
| `CRYPCODILE_REPLAY` | SETTINGS **Enable Replay Mode** checked | `start_replay(symbol, start_ns, end_ns, speed)` |

**Intended (code comments / dead handlers) but missing from UI:**
- Toolbar combo index 0 → REPLAY, index 1 → LIVE (`ToolbarManager._on_source_changed`)
- Docstring: "Simulator | Crypcodile Replay | CCXT Live"
- `data/manager.py` still knows `"simulator"` and exchange IDs

### 5.2 Other dropdowns

| Combo | Options | Default |
|-------|---------|---------|
| Centering Mode | Immediate, Deadband, EMA, Smooth Deadband | Smooth Deadband |
| CVD color vision (context menu, not QComboBox) | `ColorVisionMode` values | NORMAL |

### 5.3 Symbol free-text conventions

- Live format: `exchange-market:SYMBOL` e.g. `binance-spot:SOLUSDT`
- Parsed as `prefix-market:raw` → exchange, market, symbol_raw
- Replay: free-matched against `CrypcodileReplayProvider.load_symbols(data_dir)`; fallback to first available or first symbol in data dir search path (`/Users/nazmi/data`, `~/data`, `.`)

---

## 6. Application states (for CUA assertions)

| State ID | How entered | `source.running` | Start button | Status bar pattern | GUI tick data |
|----------|-------------|------------------|--------------|--------------------|---------------|
| **S0 Idle / Ready** | After `switch_to` without start; or after Stop | `False` | `▶ Start` (startBtn) | `[LIVE\|REPLAY] symbol \| Ready\|No data dir \| F=follow...` | Queue drained **only if running** — stalled when False |
| **S1 Connecting (Live)** | Start while LIVE | Often still False until signal | Still Start until connected | `"Connecting to live stream..."` | Not yet |
| **S2 Running Live** | `_on_provider_connected` or successful path | `True` | `■ Stop` | `[LIVE] symbol \| Bid/Ask/Spread/Vol/CVD [Latency]` | Active 16ms timer |
| **S3 Running Replay** | `start_replay` success | `True` | `■ Stop` | Same BBO line; intermittent `"Replay progress: N%"` every 30 frames | Active |
| **S4 Stopped** | Stop from S2/S3 | `False` | `▶ Start` | `"Live stopped"` / `"Replay stopped"` then idle help | No drain |
| **S5 Error** | Provider `on_error`, init exceptions | May stay False or prior | Depends | `"Error: {msg}"` / `"Replay init error"` / `"Live init error"` / missing provider messages | Unreliable |
| **S6 Auto-start race** | First 0–500ms after show | Transitions LIVE → connect | Flips Start→Stop on connect | Changing | Race for CUA snapshot timing |
| **S7 Scrolled history** | Drag/scroll time while running | True | Stop | BBO status; heatmap shows Go Live | Follow off |

**Notes:**
- `_gui_tick` early-returns if `not self._source.running` — so **stopped = frozen heatmap**, even if queue has residual (queue drained on `stop_current`).
- Live Start does **not** set `_running=True` immediately; waits for connected signal. Replay sets True immediately after `start_replay`.
- `enable_replay_cb` initial state uses `data_source == REPLAY` at widget build time; default LIVE → unchecked. Switching source via checkbox calls full `switch_to` (reset + re-init).

---

## 7. Potential UX bugs (Phase 3 hunt seeds)

| ID | Severity hint | Symptom | Root clue |
|----|---------------|---------|-----------|
| UX-01 | P1 | README controls wrong (Space, Ctrl+scroll, Simulator dropdown) | README vs code |
| UX-02 | P1 | No source dropdown; only Replay Mode checkbox buried in SETTINGS | toolbar never builds combo |
| UX-03 | P1 | `+`/`-` semantics differ MainWindow vs Heatmap focus | Dual keyPressEvent |
| UX-04 | P2 | Features dialog dead code / unreachable | Import only |
| UX-05 | P2 | Replay speed only in SETTINGS; toolbar spinner dead | `_replay_speed_spinner is None` |
| UX-06 | P2 | View→Market Pulse ≠ INDICATORS Market Pulse Overlay | Different targets |
| UX-07 | P2 | LLT dock min-size spin doesn't reverse-sync sidebar spinner | `_on_llt_thresh_spin_changed` one-way |
| UX-08 | P2 | `D` decay cycle ignores default 92 (not in [80,85,90,95]) → jumps to 88 | keyPressEvent |
| UX-09 | P1 | Auto-start 500ms surprises CUA/idle assumptions | `QTimer.singleShot` |
| UX-10 | P2 | `enable_replay_cb` not updated when source changed programmatically (only init) | No reverse bind from SourceManager |
| UX-11 | P2 | Sidebar hidden → SETTINGS controls unreachable without toolbar Sidebar (OK) but SETTINGS "Main Sidebar Panel" also hidden (can't re-enable from settings) | Must use toolbar |
| UX-12 | P3 | Zoom/timeframe sliders referenced but never created | dead attributes |
| UX-13 | P2 | `update_visibility` / `set_connected_state` no-ops | toolbar stubs |
| UX-14 | P1 | Live connect failure: button may stay Start while status says Connecting forever | No timeout UX |
| UX-15 | P2 | Symbol change while running stops then restarts; text field can fight auto-rewrite from replay symbol match | `setText` in `_start_replay` |
| UX-16 | P2 | `on_source_combo_changed` is `pass` | Dead API |
| UX-17 | P3 | Iceberg min filter not applied to existing table rows when changed | filter on insert only |
| UX-18 | P2 | Status help claims Space=toggle (ok for start/stop) but not auto-follow; users following README fail | Help vs README |
| UX-19 | P1 | Simulator advertised in README but no UI path | DataSource missing SIMULATOR |
| UX-20 | P2 | Sensitivity slider overwrites symbol-specific refs set by `update_thresholds_for_symbol` | Last writer wins |
| UX-21 | P2 | Go Live button hit-test uses fixed geometry; may miss under HiDPI/scale | paint vs press rect |
| UX-22 | P3 | DOM dock title says "DOM Pro" (premium branding) for basic ladder | Label accuracy |
| UX-23 | P2 | Hardcoded replay data dir `/Users/nazmi/data` | Portability / empty dir → "No data dir" |
| UX-24 | P1 | Keyboard shortcuts don't work when focus in QLineEdit/spinbox (expected Qt) but no global QShortcut | Focus trap |

---

## 8. CUA (computer-use) test matrix — Phase 3 ready

Scenarios are numbered for automation. Each has preconditions, steps, and assertable outcomes (status text, button label, dock visibility, visual region).

### Setup (all scenarios unless noted)
1. Launch: `python /Users/nazmi/flowmap/run_flowmap.py` (or `dist/FlowMap.app`).
2. Wait **≥1.0s** after window visible (past 500ms auto-start).
3. Window title contains `FlowMap`.
4. Prefer screenshot + OCR / accessibility labels: Symbol field, Start/Stop text, Sidebar, tab names.

---

### CUA-01 — Cold launch auto-start (Live)
**State under test:** S6 → S1/S2 or S5  
**Steps:** Launch app; wait 2s; screenshot.  
**Expect:** Start button becomes Stop if live connect succeeds; status contains `[LIVE]` and Bid/Ask OR Connecting/Error.  
**Fail if:** Stuck on Start with empty heatmap and no status change after 10s (UX-14).

### CUA-02 — Start/Stop toggle via button
**Steps:** Ensure running (Stop visible) → click Stop → assert Start label + "Live stopped" or "Replay stopped" → click Start → assert Connecting or BBO.  
**Expect:** Button objectName/style flips green↔red; `running` freezes heatmap updates when stopped.

### CUA-03 — Spacebar Start/Stop (main window focus)
**Steps:** Click empty status bar or title bar to clear focus from line edits → press Space.  
**Expect:** Same as CUA-02.  
**Fail if:** Space does nothing while Symbol field focused (document as UX-24).

### CUA-04 — Symbol edit commit (editingFinished)
**Steps:** Click Symbol field → select all → type `binance-spot:BTCUSDT` → Tab or click heatmap.  
**Expect:** Status symbol updates; thresholds jump to BTC path (LLT 15 if spinners visible); book reset; reconnect attempt if was running.  
**Fail if:** Empty symbol leaves field blank.

### CUA-05 — Empty symbol revert
**Steps:** Clear symbol → Tab.  
**Expect:** Previous symbol restored.

### CUA-06 — Enable Replay Mode
**Steps:** Sidebar visible → SETTINGS tab → check **Enable Replay Mode**.  
**Expect:** Speed spinner appears; status `[REPLAY]`; if no data, "No data dir" or init error; heatmap reset.  
**Note:** Auto-start may already be LIVE; checkbox forces full switch_to REPLAY (stop + reinit).

### CUA-07 — Replay Start with data
**Precond:** Data at `/Users/nazmi/data` (or configured dir) with symbols.  
**Steps:** Enable Replay → Start.  
**Expect:** Stop button; status BBO; occasional Replay progress; heatmap columns advance.

### CUA-08 — Replay speed change
**Steps:** While replay running, SETTINGS → Speed to `1.0x` then `20.0x`.  
**Expect:** Animation rate changes (visual FPS of column advance); no crash.  
**Note:** Cannot use toolbar spinner (does not exist).

### CUA-09 — Disable Replay Mode (back to Live)
**Steps:** Uncheck Enable Replay Mode.  
**Expect:** Switch to LIVE; stop; re-init live provider; settings speed container hidden.

### CUA-10 — Sidebar toolbar toggle
**Steps:** Click toolbar **Sidebar** (checked → unchecked).  
**Expect:** Right panel disappears; button unchecked. Click again → reappears.  
**Assert:** SETTINGS checkbox Main Sidebar Panel stays in sync.

### CUA-11 — Sidebar hide trap
**Steps:** Hide sidebar via toolbar → try to re-enable via SETTINGS (impossible) → use toolbar only.  
**Expect:** Toolbar always recovers (document UX-11).

### CUA-12 — VISUALS: hide heatmap layers
**Steps:** Uncheck Show Order Heatmap, BBO, Trades one by one with screenshots.  
**Expect:** Density vanishes, BBO lines vanish, trade bubbles vanish independently; re-check restores.

### CUA-13 — VISUALS: Volume Profile master + children
**Steps:** Uncheck Show Volume Profile → assert COB/CVP/SVP disabled (grayed). Re-check → enabled. Toggle COB only.  
**Expect:** Profile strip hides; child toggles affect overlay modes.

### CUA-14 — INDICATORS: LLT toggle + threshold
**Steps:** INDICATORS → uncheck LLT → assert table empty-ish / no large-lot highlights. Set threshold very high (50000) → few rows. Set low (1) → many rows.  
**Expect:** Dock table row count responds within a few GUI ticks while running.

### CUA-15 — LLT spinner dual control desync
**Steps:** Change INDICATORS LLT Threshold → assert dock Min Size matches. Then change dock Min Size → assert INDICATORS spinner **does not** match (UX-07 repro).

### CUA-16 — Iceberg Clear + filter
**Steps:** Ensure Iceberg dock visible; if rows exist, click Clear → 0 rows. Change Min Size high, generate icebergs (or wait) → fewer inserts.

### CUA-17 — View menu dock toggles
**Steps:** Menu View → toggle DOM Ladder ON → dock appears. Toggle Icebergs OFF → dock hides; SETTINGS checkbox follows.  
**Expect:** Bi-directional sync for three docks.

### CUA-18 — View Market Pulse vs INDICATORS pulse
**Steps:** View → uncheck Market Pulse (CVD) → bottom CVD panel gone. INDICATORS Market Pulse Overlay still ON — heatmap pulse markers may remain (UX-06). Reverse.

### CUA-19 — F auto-follow toggle
**Steps:** Focus main window → press F twice.  
**Expect:** Status `Auto-follow: OFF` then `ON`. When OFF and data runs, may drift or show Go Live after manual scroll.

### CUA-20 — Drag timeline to history + Go Live button
**Steps:** LMB drag heatmap main area left/right until scrolled.  
**Expect:** `↩ Go Live` button appears; auto_follow off. Click button → returns live edge; button disappears.

### CUA-21 — Double-click recenter
**Steps:** Double-click price axis → recenter mid. Double-click main area → go live + mid.

### CUA-22 — Wheel zoom price axis
**Steps:** Hover price axis, wheel up/down **without** Ctrl.  
**Expect:** Row thickness changes (vertical zoom). With Ctrl: price pans without thickness change.

### CUA-23 — Wheel zoom timeframe (main area)
**Steps:** Hover main heatmap, wheel.  
**Expect:** Column width steps through discrete levels (time compression/expansion). Ctrl+wheel pans time.

### CUA-24 — README Ctrl+zoom myth (negative test)
**Steps:** Follow README: Ctrl+scroll expecting zoom.  
**Expect:** **Pans** instead (documents UX-01). Without Ctrl, zooms.

### CUA-25 — Keyboard +/− without heatmap focus
**Steps:** Click status bar → `+` several times → `-`.  
**Expect:** row_height zoom (MainWindow path).

### CUA-26 — Keyboard +/− with heatmap focus
**Steps:** Click heatmap center → `+` / `-`.  
**Expect:** ticks_per_row price scale changes (different from CUA-25) — UX-03.

### CUA-27 — Heatmap Ctrl+/− and Shift+/−
**Steps:** Heatmap focus → Ctrl+`+` (row height), Shift+`+` (timeframe).  
**Expect:** Distinct zoom axes.

### CUA-28 — Arrow keys history scrub
**Steps:** Heatmap focus → hold Left → history; Right toward live; Esc or L go live.

### CUA-29 — R reset view
**Steps:** Zoom and scroll away → press R (main or heatmap).  
**Expect:** rh=4, col_w=1.0, auto_follow ON; status reset message if MainWindow handled.

### CUA-30 — D decay cycle
**Steps:** Note Decay label (0.92) → press D.  
**Expect:** Jumps to 0.88 (UX-08) then cycles 0.80→0.85→0.90→0.95.

### CUA-31 — SETTINGS sliders smoke
**Steps:** Move Decay, Smooth, Sensitivity, Bubbles Size end-to-end.  
**Expect:** Labels update; no crash; visual change (bubbles size obvious; decay over time).

### CUA-32 — Centering mode combo
**Steps:** Cycle Immediate → Deadband → EMA → Smooth Deadband while live BBO moves.  
**Expect:** Different recentering feel; no exception.

### CUA-33 — Min order size filter
**Steps:** Set Min Order Size Filter to large value while running.  
**Expect:** Heatmap thins (small book levels filtered); set 0 restores.

### CUA-34 — DOM ladder open performance
**Steps:** View → DOM Ladder ON while running.  
**Expect:** Ladder populates with levels; no freeze >2s.

### CUA-35 — Rapid Start/Stop spam
**Steps:** Click Start/Stop 10× in 3s.  
**Expect:** No crash; final button state matches final status; no zombie dual providers.

### CUA-36 — Symbol spam while running
**Steps:** Alternate SOL/ETH/BTC symbols rapidly (commit each).  
**Expect:** Thresholds update; no crash; eventual consistent symbol in status and field.

### CUA-37 — Splitter drag
**Steps:** Drag main vertical splitter between chart and sidebar.  
**Expect:** Layout resizes; heatmap still paints.

### CUA-38 — Resize window min/max
**Steps:** Shrink toward 900×600; expand fullscreen.  
**Expect:** No blank heatmap; rebuild on resize.

### CUA-39 — CVD color vision context menu
**Steps:** Right-click Market Pulse panel → select alternate CVD mode.  
**Expect:** Colors change; checkmark moves.

### CUA-40 — Features dialog absence
**Steps:** Search menus/toolbar for Features / Details.  
**Expect:** **Not found** (UX-04). Document gap vs panels module.

### CUA-41 — Source dropdown absence (README gap)
**Steps:** Scan toolbar for Simulator/Replay combo.  
**Expect:** **Not present** (UX-02 / UX-19).

### CUA-42 — Replay without data dir
**Steps:** Run with empty/missing data path (or rename data dir temporarily in test env). Enable Replay → Start.  
**Expect:** Status shows init error / No data dir / No replay provider; button recoverable.

### CUA-43 — Live disconnect mid-session
**Steps:** Start live → stop network or kill provider externally if possible → observe.  
**Expect:** `_on_provider_disconnected` → running false, Start button.  
**Fail if:** Stop button stuck while no data (state desync).

### CUA-44 — Hover price status
**Steps:** Move mouse over heatmap rows.  
**Expect:** Status shows `Price: X.XX` while hovering (may be overwritten every 30 frames by BBO status — race to document).

### CUA-45 — Iceberg dock Close [x] vs checkbox
**Steps:** Close dock via title bar X.  
**Expect:** View menu and SETTINGS checkbox uncheck (visibilityChanged chain).

### CUA-46 — Multi-tab sidebar navigation
**Steps:** Click VISUALS → INDICATORS → SETTINGS → VISUALS.  
**Expect:** Tab selection highlight blue; controls accessible.

### CUA-47 — App quit clean
**Steps:** Close window while running.  
**Expect:** `stop_current` + timer stop; process exits without hang.

### CUA-48 — Concurrent keyboard + drag
**Steps:** While dragging timeline, press Space (stop).  
**Expect:** No crash; drag ends cleanly; running false.

### CUA-49 — Sensitivity vs symbol thresholds
**Steps:** Load SOL (ref 3000) → move Sensitivity to 100 → switch symbol to ETH.  
**Expect:** Document whether symbol switch overwrites sensitivity (update_thresholds) or not — consistency check UX-20.

### CUA-50 — Full regression smoke (suite)
**Steps:** CUA-01, 02, 06, 07, 10, 12, 17, 20, 22, 25, 29, 47 in sequence.  
**Expect:** All pass; capture screenshots for baseline.

---

## 9. Automation selector cheatsheet (CUA / accessibility)

| Target | How to find |
|--------|-------------|
| Symbol field | Label adjacent "Symbol:"; value like `binance-spot:SOLUSDT` |
| Start/Stop | Button text `▶ Start` or `■ Stop` (unicode play/stop) |
| Sidebar toggle | Button text `Sidebar` |
| Tabs | `VISUALS`, `INDICATORS`, `SETTINGS` |
| Replay mode | Checkbox `Enable Replay Mode` under SETTINGS |
| Speed | Spinbox suffix `x` near label `Speed:` |
| Go Live | On-canvas text `↩ Go Live` (not a QWidget — image hit-test) |
| Status | Bottom bar strings `[LIVE]`, `[REPLAY]`, `Bid:`, `Error:` |
| Docks | Titles `DOM Ladder (DOM Pro)`, `Significant Icebergs`, `Large Lot Tracker` |
| View menu | Menu bar `View` |

**On-canvas only (no Qt widget):** heatmap, trade bubbles, Go Live button, price axis labels, BBO tags — require screenshot/pixel or coordinate clicks.

---

## 10. State × control enablement matrix

| Control | S0 Idle | S2 Live | S3 Replay | S4 Stopped | S5 Error |
|---------|---------|---------|-----------|------------|----------|
| Start/Stop | Start | Stop | Stop | Start | Start (usually) |
| Symbol edit | OK | OK (restarts) | OK (restarts) | OK | OK |
| Enable Replay | OK | Forces stop+switch | OK | OK | OK |
| Speed spin | Visible only if replay mode checked | N/A unless switched | OK live apply | OK | OK |
| Visual toggles | OK (no data) | OK | OK | OK (frozen frame) | OK |
| Heatmap drag/zoom | OK | OK | OK | OK on last frame | OK |
| Space | Start→connect | Stop | Stop | Start | Start |
| F / R / D / + / - | OK | OK | OK | OK | OK |
| Auto-start timer | Fires once at boot | — | — | — | — |

---

## 11. File → responsibility map

| File | UX role |
|------|---------|
| `main_window.py` | Layout, sidebar tabs, docks, menus, status, global keys, GUI tick |
| `toolbar_manager.py` | Symbol, Start/Stop, Sidebar; **missing** source combo & speed |
| `source_manager.py` | LIVE/REPLAY lifecycle, symbol, thresholds, toggle start/stop |
| `heatmap_widget.py` | Mouse/wheel/keys, Go Live, zoom/scroll/follow |
| `features_dialog.py` | Orphan features browser |
| `pulse.py` | CVD panel + CVD color mode context menu |
| `dom/dom_ladder.py` | DOM visualization dock |
| `README.md` | Out-of-date controls documentation |

---

## 12. Phase 3 priority ranking (recommended execution order)

1. **P0 smoke:** CUA-01, 02, 47 (launch/stop/quit)  
2. **Source paths:** CUA-06, 07, 08, 09, 42  
3. **Input correctness:** CUA-19–30 (keyboard/mouse matrix)  
4. **README lies:** CUA-24, 41 (documentation bugs)  
5. **State desync:** CUA-15, 18, 35, 43, 44  
6. **Visual toggles:** CUA-12–14, 17, 31–34  
7. **Edge:** CUA-36, 38, 48–50  

---

## 13. Summary for planning agents

- **Real control surface is toolbar (3 widgets) + 3-tab sidebar + View menu + 3 docks + heatmap gestures.**  
- **There is no working source dropdown** despite README and leftover combo handlers.  
- **Only two sources:** Crypcodile Live (default, auto-starts) and Crypcodile Replay (SETTINGS checkbox).  
- **Keyboard is dual-layer** (MainWindow vs Heatmap) with conflicting `+`/`-`.  
- **README Space/Ctrl+scroll/Simulator claims are false** relative to current code.  
- **50 numbered CUA scenarios** above are ready for Phase 3 automation with cua-driver / mac-computer-use.

---

*End of R18 report.*
