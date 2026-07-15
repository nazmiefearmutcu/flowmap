# FIND-NUM-04 — Volume profile bins via round(price, 6)

| Field | Value |
|-------|-------|
| **ID** | FIND-NUM-04 |
| **Severity** | P1 |
| **Status** | CONFIRMED |
| **Theme / Source** | R17 F3 / H-F2 |
| **Zones** | Z14 |
| **Taxonomy** | correctness |
| **Title** | SVP/CVP/COB price keys use round(..., 6), collapsing fine ticks |
| **Location** | `flowmap/ui/overlays/volume_profile.py:95,117,224,305` (+ POC match L370,408) |
| **Sibling** | R17 F3, F4, H-F2; P2-34 |
| **Discovered by** | Phase-3 NUM hunter (static) |
| **Wave** | W3 |
| **Created** | 2026-07-13 |

### Repro
1. Feed SVP trades at prices needing >6 decimal places, e.g. `0.0000123` and `0.0000124` (distinct ticks on SHIB-class books).
2. `add_trade` / `add_trades` → both map to `round(p, 6)` → **same key** `0.000012`.
3. POC/VA computed on merged bins → wrong profile shape vs true tick ladder.
4. COB column uses same keying (`L305`); POC highlight uses `abs(...) < 0.000001` (F4) inconsistent with 6-dp keys.

### Expected
Bin at **exchange tick** or `render_tick_size` grid (same Y mapping as heatmap rows), not fixed 6 decimal places. POC equality should use the same key domain.

### Actual
```python
price_key = round(price, 6)
```
on SVP add, batch add, CVP rebuild, and COB map. Symbols with tick ≪ 1e-6 merge distinct levels; symbols with coarse ticks waste precision but usually OK. POC tests `abs(diff) < 1e-6` instead of key equality.

### Fix hint
`price_key = round(price / tick) * tick` (or integer tick index). Share helper with heatmap row mapping. Use key equality for POC.

### Evidence
- Static multi-site: L95, L117, L224, L305; POC L370, L408.
- R17 §3 F3 / F4 / H-F2.
