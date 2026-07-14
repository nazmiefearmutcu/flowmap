# FIND-NUM-08 — DOM BBO highlight epsilon fixed at 0.001

| Field | Value |
|-------|-------|
| **ID** | FIND-NUM-08 |
| **Severity** | P2 |
| **Status** | CONFIRMED |
| **Theme / Source** | R17 F2 / H-F3 |
| **Zones** | Z14 |
| **Taxonomy** | rendering |
| **Title** | DOM ladder marks BBO with abs(price-bbo)<0.001, not tick-relative |
| **Location** | `flowmap/ui/dom/dom_ladder.py:226-227` |
| **Sibling** | R17 F2, H-F3; P2-33 |
| **Discovered by** | Phase-3 NUM hunter (static) |
| **Wave** | W3 |
| **Created** | 2026-07-13 |

### Repro
1. Micro-tick asset (tick ≪ 0.001): multiple ladder rows within 0.001 of best bid/ask → **several rows highlighted** as BBO.
2. Coarse-tick asset (tick ≥ 0.1) with float-noisy BBO vs level price differing by ~1e-4 usually still matches; if levels keyed after round(6) and BBO raw, edge cases may miss highlight when combined with other keying bugs.
3. Compare with VWAP overlay fallback `abs(level.price - vwap) < 0.001` (`vwap.py:109`) — same absolute-epsilon class (F5).

### Expected
BBO row identity uses tick grid equality: `round(price/tick)==round(bbo/tick)` or half-tick epsilon. Exactly one bid row and one ask row highlighted when book is non-empty.

### Actual
```python
is_bbo_bid = bbo_bid is not None and abs(price - bbo_bid) < 0.001
is_bbo_ask = bbo_ask is not None and abs(price - bbo_ask) < 0.001
```
Not symbol-aware; breaks R17 multi-symbol numeric matrix.

### Fix hint
Pass `tick_size` / `render_tick` into DOM; match with `abs(p-bbo) <= tick*0.5` or integer tick indices from shared mapper.

### Evidence
- Static: `dom_ladder.py:226-227`.
- Related absolute eps: `vwap.py:109` (0.001), `bubbles.py:109` (1e-6 merge).
- R17 §3 F2 / H-F3.
