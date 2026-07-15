# P2-34 — VP row Y vs heatmap row_height

| Field | Value |
|-------|-------|
| **Agent** | P2-34 |
| **Theme** | Volume profile row Y systematic skew vs heatmap |
| **Zones** | Z14 |
| **Sibling hyps** | R12-H01,H02,H04,H05,H09,H14; R17 H-F2; R20 P1-04/P1-05 |
| **Severity prior** | **P1** (systematic misalignment; trader trust) |
| **Primary files** | `/Users/nazmi/flowmap/flowmap/ui/overlays/volume_profile.py`, `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py` (`get_visible_prices`, `_price_to_screen_y`, `row_height`), `/Users/nazmi/flowmap/flowmap/ui/main_window.py` (`_on_heatmap_view_changed`, `_on_row_height_changed`) |

---

## 1. Scope & linked zones/sibling hyps

### In scope
- VP paint Y: `y_start = int(i * h / bh)` distributing **full height** across `bh` levels
- Heatmap: fixed `row_height` pixels; `vis_rows = height // row_height`; remainder unused at bottom
- `VolumeProfileOverlay.row_height` stored via `set_row_height` but **ignored in paint**
- Sync path: `view_changed` / `row_height_changed` → `get_visible_prices()` → `set_levels`
- Price keys: `round(price, 6)` for SVP/CVP/COB vs tick-grid visible prices
- HUD header/footer covering first/last rows without y-offset
- VA 70% non-contiguous algorithm (secondary)
- CVP from `get_visible_trades` / buffer dependency
- `auto_follow=False` may skip `view_changed` (R12-H14)

### Out of scope
- DOM ladder (P2-33) except shared “align to heatmap rows” design
- VWAP line geometry (mention for shared `price_to_y`)
- Theme colors

---

## 2. Threat model

**Core defect class:** two different vertical discretizations side-by-side.

```
Heatmap row i:  y = i * row_height          # fixed pitch
VP row i:       y = i * h / bh              # stretch-to-fill
When h % row_height != 0 or bh != vis_rows: systematic skew grows with i
```

| Threat | Impact |
|--------|--------|
| Y skew | COB/CVP/SVP bars not on same price as heatmap row |
| Key mismatch | Volume “exists” but bar missing on row |
| HUD cover | Top/bottom prices unreadable / half-covered |
| Stale levels | After pan without view_changed, wrong price list |
| Small row_height (2–4) | 1px jitter dominates; looks broken |

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| S1 | VP paint ~328–333 vs heatmap `_price_to_screen_y` |
| S2 | Confirm `self.row_height` unused in paint loop |
| S3 | `get_visible_prices` formula vs engine center ticks |
| S4 | `round(price, 6)` all insert/lookup sites |
| S5 | Header/footer pixel constants vs first row y |

### 3.2 Unit — geometry

| ID | Setup | Assert |
|----|-------|--------|
| U1 | h=400, row_height=4 → vis_rows=100; bh=100 | heatmap y_i = 4i; VP y_i = 4i **equal** |
| U2 | h=405, row_height=4 → vis_rows=101, remainder 1 | heatmap last used y=404; VP uses full 405 → **last rows drift** |
| U3 | h=400, row_height=4, bh=100 | measure max \|y_hm - y_vp\| over i |
| U4 | Change row_height 4→8 without set_row_height path | stale |
| U5 | After set_row_height, paint still uses h/bh | **fail** if expects row_height pitch |

Define metric: `skew(i) = y_vp_center(i) - y_hm_center(i)`; pass if max|skew| < 0.5 px for all i when heights match.

### 3.3 Unit — keys

| ID | Steps | Assert |
|----|-------|--------|
| K1 | Trade at price not equal to tick center | SVP key vs visible level key |
| K2 | BTC tick 0.1, round(,6) | OK |
| K3 | Synthetic price 100.0000004 vs 100.0 | miss |
| K4 | Snap trade to `render_tick_size` before insert | hit |

### 3.4 Integration / GUI

| ID | Steps |
|----|-------|
| G1 | Side-by-side: mark heatmap mid row; check VP bar for same price |
| G2 | Zoom row_height 2→12; resync; remeasure skew |
| G3 | Vertical pan; confirm view_changed refreshes VP levels |
| G4 | auto_follow off + live ticks; VP price list stale? |
| G5 | Toggle COB/CVP/SVP; alignment same for all columns |
| G6 | Screenshot HUD overlap on top price |

### 3.5 CVP/SVP data path

| ID | Probe |
|----|-------|
| C1 | engine buffer None → CVP empty |
| C2 | scroll deep history beyond trade deque → CVP undercount |
| C3 | VA algorithm with bimodal wings | empty center still in VA |

---

## 4. Pass/fail criteria

| Criterion | Pass | Fail |
|-----------|------|------|
| Y map | Same helper as heatmap (`i * row_height` or shared `price_to_y`) | `i*h/bh` stretch |
| Remainder | Unused bottom strip matches heatmap | VP stretches into remainder |
| row_height field | Used in paint | Stored only |
| Keys | Trade volumes appear on corresponding visible row | Empty bar with volume nearby |
| Sync | Any visible price set change refreshes VP | Stale after pan |
| HUD | Plot origin below header | Covers row 0 |

**Quant pass:** max pixel skew < 1px for all visible rows at row_height∈{2,4,8,12}.

---

## 5. Fixtures needed

| Fixture | Description |
|---------|-------------|
| Synthetic levels list with known prices | mid ± k*tick |
| Trades exactly on / off tick centers | key tests |
| `scratch/debug_vp.py` refresh to current API | automation |
| Widget sizes: 400×800, 401×800, 1080p remainder cases |
| Golden screenshots with crosshair at shared price |

---

## 6. Phase-3 agent micro-tasks

### Hunt A — Skew quantification
Automated loop over heights/row_heights; table max skew. **FIND-P234-01**

### Hunt B — Key mismatch matrix
Trade prices vs `get_visible_prices` keys. **FIND-P234-02**

### Hunt C — Sync emit gaps
auto_follow off; pan paths; list view_changed emitters. **FIND-P234-03**

### Hunt D — HUD geometry
Measure covered pixels vs row_height. **FIND-P234-04**

### Hunt E — VA algorithm audit
Synthetic bimodal; document vs classic POC expansion. **FIND-P234-05**

---

## 7. Expected finding IDs

Format: **`FIND-P234-XX`**

| ID | Title | Sev |
|----|-------|-----|
| FIND-P234-01 | VP `i*h/bh` vs heatmap fixed pitch | **P1** |
| FIND-P234-02 | `row_height` ignored in paint | **P1** |
| FIND-P234-03 | `round(price,6)` key misses | **P1** |
| FIND-P234-04 | HUD covers edge rows | P2 |
| FIND-P234-05 | view_changed gaps under !auto_follow | P2–P3 |
| FIND-P234-06 | VA non-contiguous | P2 |
| FIND-P234-07 | CVP empty without buffer | P2 |
| FIND-P234-08 | Remainder pixel desync | P1 (subset of 01) |

---

## 8. Fix strategy sketch

1. **Single vertical mapping module** used by heatmap, VP, VWAP, bubbles:
   - `row_index_to_y(i) = i * row_height`
   - `price_to_y` from engine ticks
2. VP paint: clip to `vis_rows * row_height`; leave bottom remainder blank (match heatmap).
3. Snap all profile buckets to `render_tick_size` (or integer tick keys).
4. Reserve header/footer margins; shift plot origin.
5. Always emit `view_changed` when visible price vector changes.
6. Refresh `debug_vp.py` as regression harness.

---

## 9. Dependencies

| Theme | Relation |
|-------|----------|
| P2-10 tick vs render_tick | Shared Y truth |
| P2-09 ticks_per_row | Changes grid |
| P2-32 bubbles | Same price_to_y |
| P2-33 DOM | Independent row_height (document) |
| P2-29 resize | Triggers resync |
| P2-07 density mid | COB dual sides rare |

---

## 10. Severity priors from phase1

| Source | Prior |
|--------|-------|
| R12-H01 | **P1** |
| R12-H02 | **P1** |
| R20 P1-04 | P1 |
| R17 H-F2 | P1 keys |
| Module risk VP 16 | HIGH |

**Verdict:** Highest-confidence visual P1 in Track C tail; Phase-3 should produce pixel-diff evidence early.
