# P2-10 — `tick_size` vs `render_tick_size` History Polylines

**Agent:** P2-10  
**Track:** A — Core correctness  
**Theme n:** 10  
**Finding ID prefix:** `FIND-P210-`  
**Severity prior:** **P0** (R17 H-T6, R08 H3, R20 #6 / P0-09 — mid/BBO history lines mis-scaled vs heatmap)

---

## 1. Scope & linked zones / sibling hyps

| Item | Value |
|------|-------|
| **Zones** | **Z03**, **Z01** |
| **Siblings** | R17 H-T6 / H-T3; R08 H3; R20 P0-09 |
| **Bug site** | `heatmap_widget.py` `_draw_historical_price_line` :1401–1430 especially **:1408, :1418** |
| **Correct reference** | `_price_to_screen_y` :297–305 uses `render_tick_size` |
| **Callers** | `_draw_bbo_history_lines` :1336–1398 |
| **Engine** | Live BBO pixels use `render_tick_size` :386–391 |

### The bug (hypothesized, high confidence from code read)

```python
# _draw_historical_price_line
tick_size = self._engine.tick_size          # RAW
p_ticks = np.round(prices_arr / tick_size)  # WRONG when ticks_per_row != 1

# _price_to_screen_y
p_ticks = round(price / engine.render_tick_size)  # CORRECT grid
```

When `ticks_per_row=100` (BTC path), history polyline Y is scaled ~100× wrong vs density cells and live BBO markers.

### Non-scope

- Tick detection quality → P2-09 (but wrong tick compounds this)  
- Trade overlay Y (already uses render_tick_size) — regression check only  
- Full paint perf → Track C  

---

## 2. Threat model

**Coordinate system:** Integer **render ticks** = price / (tick_size * ticks_per_row); center_price_ticks in that unit.

**Inconsistency classes:**

| Drawer | Tick unit | Risk |
|--------|-----------|------|
| Density buffer rows | render_tick_size | baseline truth |
| Live BBO in buffer | render_tick_size | OK |
| `_price_to_screen_y` | render_tick_size | OK |
| Historical polylines | **tick_size only** | **BUG** |
| Trade dots / bubbles | render via price_to_y | OK |
| Price axis labels | render_tick_size | OK |

**User symptom:** Mid/bid/ask history lines float away from heatmap structure after any `ticks_per_row ≠ 1` (price zoom or BTC default).

**Severity:** Visual correctness of primary price path — traders trust mid line — **P0**.

---

## 3. Concrete probes

### 3.1 Static (confirm before dynamic)

1. Read `_draw_historical_price_line` full.  
2. Diff all ` / tick_size` vs ` / render_tick_size` in heatmap_widget.  
3. Grep `engine.tick_size` usages in draw methods.

```bash
rg -n 'tick_size|render_tick_size' flowmap/ui/heatmap_widget.py
```

### 3.2 Unit — Y formula equivalence

Without full Qt paint: pure numpy function extract.

| Probe | price | tick | tpr | center | Formula A (raw) | Formula B (render) | Equal? |
|-------|-------|------|-----|--------|-----------------|--------------------|--------|
| Y1 | 100.0 | 0.1 | 1 | 1000 | … | … | yes |
| Y2 | 100.0 | 0.1 | 10 | … | … | … | **no** unless fixed |
| Y3 | 100.0 | 0.1 | 100 | … | … | … | **no** |
| Y4 | BBO bid/ask/mid series length n | | | | max |Y_a−Y_b| | >0.5 px equivalent |

Also compare to `_price_to_screen_y` closed form.

### 3.3 Widget / paint probe

| Probe | Steps |
|-------|-------|
| V1 | Headless Qt: HeatmapWidget, set ticks_per_row=100, feed flat mid history, paint or call draw helper, sample polyline Y vs `_price_to_screen_y(mid)` |
| V2 | tpr=1 control — lines align |
| V3 | price_zoom_in/out changes tpr — misalign grows |
| V4 | Live BBO badge Y vs history line end Y same price |

### 3.4 Regression matrix (must stay aligned after fix)

| Element | Mapping |
|---------|---------|
| Density | render |
| History lines | must render |
| Trades | render |
| Bubbles | render |
| Axis | render |

### 3.5 Anchors

| Topic | Line |
|-------|------|
| Bug | `heatmap_widget.py:1408, 1418` |
| Good Y | `heatmap_widget.py:297–305` |
| Call sites | `heatmap_widget.py:1360–1395` |
| Engine BBO | `density_engine.py:386–391` |
| center units | set via mid/render_tick_size in push/rebuild |

---

## 4. Pass / fail criteria

| | Criteria |
|--|----------|
| **PASS** | For tpr ∈ {1,2,10,100}, history line Y for price P equals `_price_to_screen_y(P)` within 1 px; V2 still works |
| **FAIL** | tpr>1 systematic offset (current code → expect FIND-P210-01) |

---

## 5. Fixtures

| Fixture | |
|---------|--|
| Synthetic `_history` bid/ask/mid arrays | constant and ramping prices |
| Engine with known tick_size, tpr, center_price_ticks, buffer shape | |
| Optional screenshot pair tpr=1 vs 100 | |

---

## 6. Phase-3 micro-tasks

### P2-10-H1 — Static confirmation + FIND draft  
Cite 1408/1418 vs 303; FIND-P210-01.

### P2-10-H2 — Numeric Y matrix Y1–Y4  
Unit test without GUI if formulas extracted; else minimal QWidget.

### P2-10-H3 — Paint/integration V1–V4  
Visual or geometric assert end of mid line vs live mid marker.

### P2-10-H4 — Audit other raw tick_size draw uses  
Any second bug site → FIND-P210-02+.

### P2-10-H5 — Fix verification  
After one-line switch to render_tick_size (and y_scale consistency with vis vs buf height — note helper uses `height()/bh` full buffer mapping, may differ from screen_row formula — **verify both bugs**):  
- Issue A: tick vs render  
- Issue B: y_scale = height/bh vs row_height * screen mapping  

H5 must check Issue B: `_draw_historical_price_line` uses full buffer height mapping (`y_scale = height()/bh`) while `_price_to_screen_y` uses **visible rows** and `row_height`. Possible **second systematic Y error** even after tick fix!

```text
_price_to_screen_y: screen_row = (vis_rows//2) - (p_ticks - center); y = screen_row * row_height + ...
_draw_historical_price_line: rows = half_bh - (p_ticks - center); ys = rows * (height/bh) + ...
```

If `bh = vis_rows * 5` (overscan), these differ — **FIND-P210-02** candidate independent of tick_size.

---

## 7. Finding ID prefix

`FIND-P210-`

| ID | Issue |
|----|-------|
| FIND-P210-01 | History line uses tick_size not render_tick_size |
| FIND-P210-02 | History line Y uses full buffer scale vs visible row_height mapping |
| FIND-P210-03 | Other overlay still on raw tick |
| FIND-P210-04 | Mid history source length desync (R08 H18) |

---

## 8. Fix strategy sketch

1. Use `render_tick_size` in `_draw_historical_price_line`.  
2. Prefer **reuse `_price_to_screen_y`** per point (or vectorized twin) for single source of truth.  
3. Drop half_bh buffer formula for overlays unless intentionally drawing in buffer pixel space then scale by same transform as QImage blit.  
4. Unit test matrix tpr × prices locked in CI.  
5. Coordinate with P2-09 so tick_size itself is correct.

---

## 9. Dependencies

| | |
|--|--|
| **Depends** | P2-09 for meaningful tick_size; engine center in render ticks |
| **Blocks** | Z01 visual signoff for price path |
| **Never drop** | R20 must-keep theme 10 |
| **Related** | P2-07 density rows same grid |

---

## 10. Severity priors

| Issue | Prior |
|-------|-------|
| tick vs render_tick on history lines | **P0** (R20 #6) |
| buffer vs visible Y scale | **P0/P1** if confirmed |
| H18 dual history sources | **P2** |

**Wave:** W2–W3 (Z03 then verify in Z01 paint).
