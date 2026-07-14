# P2-33 — DOM refresh vs paint throttle

| Field | Value |
|-------|-------|
| **Agent** | P2-33 |
| **Theme** | DOM refresh rate vs paint throttle / lag |
| **Zones** | Z14 (+ Z14b DOM) |
| **Sibling hyps** | R12-H03,H07,H11,H12,H15; R10 gui_tick 16ms; R20 DOM MED |
| **Severity prior** | **P1** windowing/BBO center; **P2** throttle desync & lag feel |
| **Primary files** | `/Users/nazmi/flowmap/flowmap/ui/dom/dom_ladder.py`, `/Users/nazmi/flowmap/flowmap/ui/main_window.py` (`_gui_tick` → `set_levels`/`set_bbo`) |

---

## 1. Scope & linked zones/sibling hyps

### In scope
- Data path: `_gui_tick` @ ~16ms → `order_book.get_levels()` → `DomLadder.set_levels` + `set_bbo` separately
- Paint throttle: `_update_interval_ms = 50` (~20 FPS) via single-shot QTimer coalesce
- Visibility gate: no paint when dock hidden; data still assigned
- Windowing: `display_levels = self._levels[-visible_count:]` — **highest prices only**, not BBO-centered
- `_depth` settable but **unused** in paint
- Transient BBO/levels skew within one throttle window
- Hover `mouseMoveEvent` forces `update()` bypassing throttle
- Wheel accepts event but no scroll
- Bar normalization uses full book max, not visible window
- Price format `.2f`; BBO match `abs < 0.001`

### Out of scope
- Volume profile Y (P2-34) except shared `row_height` philosophy
- Order book prune correctness (Z11) except as input depth
- Theme Menlo vs Fonts (note only)

---

## 2. Threat model

| Threat | Effect |
|--------|--------|
| 16ms data / 50ms paint | Up to ~50ms visual lag; acceptable if consistent; fails if BBO highlight from different tick than levels |
| Split set_levels/set_bbo | Paint can show new levels + old BBO (or reverse) → wrong spread highlight |
| Highest-N window | Deep crypto books → user sees only far ask stack; bids “missing” (product-breaking for ladder traders) |
| Hidden dock still copies levels each tick | Minor CPU; not lag unless get_levels expensive |
| Hover fights throttle | Paint storm while mouse moves |
| `_depth` ignored | API lie; settings no-ops |

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| S1 | Read `set_levels`/`set_bbo`/`_trigger_throttled_update` (~100–126) |
| S2 | Confirm `_depth` unused in `paintEvent` |
| S3 | `rg 'set_levels|set_bbo|_dom_ladder' main_window.py` call order |
| S4 | Wheel handler stub |
| S5 | BBO epsilon and price format hardcodes |

### 3.2 Unit / timing

| ID | Steps | Assert |
|----|-------|--------|
| U1 | Mock time: two set_levels within 10ms | single scheduled paint |
| U2 | set_levels then set_bbo before paint | paint sees **last** assigned both (or document race) |
| U3 | Instrument paint with levels mid M, bbo from older tick | detect mismatch frames |
| U4 | isVisible False | no update scheduled; levels still stored |
| U5 | showEvent | immediate paint with latest data |
| U6 | visible_count math | `h//row_height+2` levels displayed |
| U7 | Sorted levels ascending; slice `[-n:]` | equals highest n prices |

### 3.3 Dynamic / lag model

| ID | Steps | Measure |
|----|-------|---------|
| D1 | Synthetic book updates @ 60Hz | paint events/sec ≤ 20 |
| D2 | BBO flip every 5ms | highlight lag vs true BBO |
| D3 | Burst 1000 levels updates | GUI thread time in set_* |
| D4 | Compare DOM paint rate to heatmap (~60) | perceived desync |

### 3.4 GUI product probes

| ID | Steps | Expected bug signal |
|----|-------|---------------------|
| G1 | Open DOM dock on deep BTC book | Mostly asks at top; bids off-screen |
| G2 | Compare DOM center price to heatmap mid | Systematic offset |
| G3 | Wheel over DOM | No scroll (R12-H12) |
| G4 | Narrow dock | Bar min width overflow |
| G5 | Hover rapidly | FPS drop / unthrottled paints |
| G6 | Toggle dock hide/show mid-session | Fresh paint; no stale empty |

---

## 4. Pass/fail criteria

| Criterion | Pass | Fail |
|-----------|------|------|
| Coherence | levels+BBO atomic for any paint | Cross-tick BBO highlight |
| Center | Display window includes BBO ± depth | Highest-N only |
| `_depth` | Affects visible count | No-op |
| Throttle | ≤ configured FPS under burst | Unbounded paints (hover) |
| Lag UX | Documented max staleness ≤ interval | Multi-interval backlog (shouldn’t with coalesce) |
| Format | Tick-aware decimals | Always `.2f` on microprice books |
| Hidden | Near-zero paint cost | Full paint while hidden |

---

## 5. Fixtures needed

| Fixture | Description |
|---------|-------------|
| `book_deep_asks.json` | 500 asks above mid, 500 bids below |
| `book_bbo_flip.jsonl` | Alternating BBO |
| `book_locked_market.json` | bid=ask price |
| Qt offscreen `DomLadder` harness with fake clock for throttle |
| Screenshot golden: BBO-centered ladder (after fix) |

---

## 6. Phase-3 agent micro-tasks

### Hunt A — Throttle correctness
Unit U1–U5 with freezegun/perf_counter mock. **FIND-P233-01**

### Hunt B — Split update race
Interleave set_levels/set_bbo; capture paint snapshots of spread highlight. **FIND-P233-02**

### Hunt C — Windowing vs BBO
G1–G2 with deep book; measure index of BBO in display_levels. **FIND-P233-03**

### Hunt D — Hover/wheel contract
Document unthrottled hover + dead wheel. **FIND-P233-04**

### Hunt E — Normalization/format
max from full book vs visible; `.2f` on 1e-8 tick. **FIND-P233-05..06**

---

## 7. Expected finding IDs

Format: **`FIND-P233-XX`**

| ID | Title | Sev |
|----|-------|-----|
| FIND-P233-01 | 50ms throttle vs 16ms feed lag | P2 (often OK) |
| FIND-P233-02 | Non-atomic levels/BBO | P2 |
| FIND-P233-03 | Highest-N not BBO-centered | **P1** |
| FIND-P233-04 | `_depth` unused | P2 |
| FIND-P233-05 | Hover bypasses throttle | P2–P3 |
| FIND-P233-06 | Wheel no-op | P3 |
| FIND-P233-07 | Norm uses full book max | P2 |
| FIND-P233-08 | Price `.2f` / BBO eps 0.001 | P2–P3 |

---

## 8. Fix strategy sketch

1. **Atomic API:** `set_book(levels, bbo)` single call from `_gui_tick`.
2. **BBO-centered slice:** find BBO index; take `[idx-depth, idx+depth]` clamped; use `_depth`.
3. Hover: mark dirty, respect throttle; or throttle hover repaints.
4. Implement scroll_offset for wheel OR lock center and document.
5. Visible-window max for bar scale option.
6. Format prices from `tick_size` / symbol meta.
7. Optional: match heatmap paint rate when dock visible and user enables “sync FPS”.

---

## 9. Dependencies

| Theme | Relation |
|-------|----------|
| P2-14 drain | Stale books if drain starves → DOM lag root elsewhere |
| P2-15 snapshot batch | Order of apply before set_levels |
| P2-34 VP Y | Shared alignment philosophy with heatmap |
| P2-02 crossed book | BBO highlight wrong if book crossed |
| P2-43 navigation | No DOM↔heatmap linked scroll yet |

---

## 10. Severity priors from phase1

| Source | Prior |
|--------|-------|
| R12-H03 DOM not BBO-centered | **P1** |
| R12-H07 throttle split | P2 |
| R12-H12 wheel | P3 |
| R20 DOM risk 9 | MEDIUM |
| GUI tick 16ms | R10 |

**Verdict:** Product correctness of windowing outranks FPS tuning; still quantify throttle race with instrumentation.
