# P2-44 — Wheel / Ctrl-Scroll UX Contract

| Field | Value |
|-------|-------|
| **Agent** | P2-44 |
| **Theme n** | 44 |
| **Track** | E — UX |
| **Zones** | **Z16** |
| **Siblings** | R08, R18 UX-01, UX-03, README §Controls |
| **Severity prior** | **P1** (README inverted; dual +/− semantics) |
| **Focus** | README vs code wheel/Ctrl; MainWindow vs Heatmap key conflict |

---

## 1. Scope & linked zones / sibling hyps

### Truth table from R18 (code)

#### Wheel on **price axis**
| Input | Behavior |
|-------|----------|
| Wheel no Ctrl | Vertical zoom (`row_height` 2–24) |
| Wheel + Ctrl | Vertical price pan (`scroll_price`) |

#### Wheel on **main timeline**
| Input | Behavior |
|-------|----------|
| Wheel no Ctrl | Timeframe zoom (`COLUMN_WIDTH_LEVELS`) |
| Wheel + Ctrl | Time horizontal pan |

#### Keyboard

| Focus | Key | Behavior |
|-------|-----|----------|
| MainWindow | `+`/`-` | `zoom_in`/`zoom_out` **row_height** |
| Heatmap | `+`/`-` | **ticks_per_row** price scale |
| Heatmap | Ctrl+`+`/`-` | row_height |
| Heatmap | Shift+`+`/`-` | timeframe zoom |

#### README claims (false)
- Ctrl+scroll = vertical line zoom → **actually pan**
- Space = auto-follow → **actually Start/Stop**
- Source dropdown Simulator/Replay → **missing**

### Sibling
- R18 UX-01 README wrong
- R18 UX-03 dual +/− 
- R08 wheel/key hunts
- CUA-22, 23, 24, 25, 26, 27

---

## 2. Threat model

| User model | Reality | Damage |
|------------|---------|--------|
| README-trained | Inverted Ctrl | Frustrated pan vs zoom; wrong screenshots in support |
| Focus-unaware | + means different things | Accidental ticks_per_row collapse (coord P2-09) |
| Trackpad pinch / smooth wheel | High-res deltas | Overshoot zoom levels |
| DOM ladder wheel | Currently no-op | Expected scroll missing |

---

## 3. Concrete probes

### 3.1 Contract document (deliverable)

Produce **UX Contract v1** table:

| Region | Input | Expected (product decision) | Current code | Match? |
|--------|-------|-----------------------------|--------------|--------|
| ... | ... | **Decide: README or code wins** | ... | |

**Phase-3 rule:** Finding is either:
- **Code bug** if product chooses README, or
- **Docs bug** if product chooses code (still FIND-P244 for docs).

**Recommendation (planning):** **Code is source of truth**; fix README + status help string. Dual +/− is still a product bug — prefer QShortcut global with documented map.

### 3.2 Instrumented wheel tests

```python
# Inject QWheelEvent at axis vs main, with/without Ctrl
# Assert row_height, ticks_per_row, column width, scroll_offset deltas
```

### 3.3 Keyboard focus matrix

| Step | Focus target | Key | Assert metric changed |
|------|--------------|-----|------------------------|
| 1 | Status bar | `+` | row_height |
| 2 | Heatmap | `+` | ticks_per_row (not row_height alone) |
| 3 | Symbol QLineEdit | `+` | no zoom (types character) |
| 4 | Heatmap | Ctrl+`+` | row_height |

### 3.4 CUA

CUA-22, 23, 24 (negative README), 25, 26, 27.

### 3.5 Trackpad / pixel deltas

If `angleDelta` vs `pixelDelta` path exists, fuzz both; fail if unbounded zoom loop.

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| WHL-P1 | README matches code for Ctrl+scroll | Inconsistency remains |
| WHL-P2 | Status help string matches keys | Space claimed as follow |
| WHL-P3 | Documented single +/− policy OR focus indicator | Silent dual semantics |
| WHL-P4 | Wheel axis regions match hit geometry | Axis/main swap near boundary |
| WHL-P5 | Zoom clamps hold (row_height 2–24, ticks list) | Unclamped crash |

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| Offscreen HeatmapWidget with known size | Synthetic wheel |
| Baseline screenshots pre/post zoom | Visual |
| README Controls section excerpt | Doc diff |
| Focus harness | click targets |

---

## 6. Phase-3 micro-tasks

| Hunt | Work |
|------|------|
| **H-44A** | Instrument every wheel/key branch; dump metrics table |
| **H-44B** | README + help string inconsistency findings (UX-01, UX-18) |
| **H-44C** | Dual +/− CUA-25/26 + product recommendation |
| **H-44D** | Axis boundary hit-test (x ≥ width − price_axis_w) |
| **H-44E** | DOM wheel no-op documentation / bug |

---

## 7. Expected finding IDs — `FIND-P244-XX`

| ID | Sev | Title |
|----|-----|-------|
| FIND-P244-01 | P1 | README Ctrl+scroll inverted vs code |
| FIND-P244-02 | P1 | README Space = auto-follow false |
| FIND-P244-03 | P1 | Dual +/− MainWindow vs Heatmap |
| FIND-P244-04 | P2 | Status help incomplete / misleading |
| FIND-P244-05 | P2 | Trackpad overshoot |
| FIND-P244-06 | P3 | DOM wheel no-op |
| FIND-P244-07 | P2 | Dead zoom/timeframe sliders referenced |

---

## 8. Fix strategy sketch

1. Rewrite README Controls to match R18 truth table.
2. Update idle help: `F=follow Space=start/stop +/−=zoom(focus-dep) R=reset D=decay`.
3. Optionally unify keys via `QShortcut` with context `WindowShortcut` and remove dual handlers.
4. Visual focus ring on heatmap when it owns price-scale keys.
5. Align DOM wheel later (feature, not hunt-critical).

---

## 9. Dependencies

| Theme | Link |
|-------|------|
| P2-43 | scroll/pan shared state |
| P2-09 | ticks_per_row danger from accidental + |
| P2-50 | CUA execution |
| P2-10 | tick vs render_tick after price zoom |

---

## 10. Severity priors

README/control lies: **P1** (R18 UX-01). Dual key semantics: **P1** (UX-03). DOM no-op: **P3**.
