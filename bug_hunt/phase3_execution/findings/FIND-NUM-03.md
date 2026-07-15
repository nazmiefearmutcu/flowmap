# FIND-NUM-03 — Symbol→ticks_per_row / ref heuristics are substring hardcodes

| Field | Value |
|-------|-------|
| **ID** | FIND-NUM-03 |
| **Severity** | P1 |
| **Status** | CONFIRMED |
| **Theme / Source** | R17 T5 / H-T5 / V3 |
| **Zones** | Z03, Z10 |
| **Taxonomy** | correctness |
| **Title** | ticks_per_row and bid/ask refs chosen by SOLUSDT/ETHUSDT/else-BTC substring |
| **Location** | `flowmap/ui/source_manager.py:369-403` |
| **Sibling** | R17 T5, H-T5, V3; P2-09 |
| **Discovered by** | Phase-3 NUM hunter (static) |
| **Wave** | W2 |
| **Created** | 2026-07-13 |

### Repro
1. Set symbol to `BTC/USDT`, `BTC-PERP`, `btcusdt`, or any non-SOL/ETH string → falls into **else** branch: `ticks_per_row=100`, `bid_ref=ask_ref=5.0`.
2. Set symbol to `MYETHUSDT` or `ETHUSDT-26JUN` → `"ETHUSDT" in symbol` true → ETH settings (10 / 100) even if instrument differs.
3. Set `SOLUSDT` vs `SOL/USDT` — only exact substring match gets SOL path (2 / 3000).
4. Observe vertical zoom and color normalization wrong for first frames (and sticky until adaptive normalizer recovers refs).

### Expected
`ticks_per_row` and size refs derive from **exchange tick size + mid scale** (or explicit per-instrument table with normalized symbol keys: upper, strip separators). Unknown symbols should not silently inherit BTC 100× binning.

### Actual
```python
if "SOLUSDT" in self._symbol:   # tpr=2, ref=3000
elif "ETHUSDT" in self._symbol: # tpr=10, ref=100
else:                           # assumed BTC: tpr=100, ref=5
```
Fragile substring rules; wrong family → washed-out/clipped heatmap colors and collapsed/expanded Y scale. LLT/stops spinner defaults also hard-coded in the same method.

### Fix hint
Normalize symbol (`replace("/","").replace("-","").upper()`), map known bases, else compute `ticks_per_row` from detected tick vs target row height in price space. Seed refs from first-snapshot p98 sizes (normalizer already exists).

### Evidence
- Static: `source_manager.py:373-397`.
- R17 §2 T5 / H-T2 / H-T5; §6 V3.
