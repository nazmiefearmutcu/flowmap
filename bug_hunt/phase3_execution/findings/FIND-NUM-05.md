# FIND-NUM-05 — Unknown / unmapped trade side defaults to Side.BUY

| Field | Value |
|-------|-------|
| **ID** | FIND-NUM-05 |
| **Severity** | P1 |
| **Status** | CONFIRMED |
| **Theme / Source** | R17 S6, S7 / H-S2 |
| **Zones** | Z08, Z17 |
| **Taxonomy** | correctness |
| **Title** | Crypcodile + CCXT converters bias unknown side to BUY (bullish CVD) |
| **Location** | `flowmap/data/crypcodile_replay.py:76-83`; `flowmap/data/crypto.py:82` |
| **Sibling** | R17 S6, S7, H-S2; P2-03, P2-05 |
| **Discovered by** | Phase-3 NUM hunter (static) |
| **Wave** | W1 |
| **Created** | 2026-07-13 |

### Repro
1. Crypcodile path: `_get_flowmap_side(None)` → `Side.BUY`; unmapped string `"unknown"` → `_SIDE_MAP.get(..., Side.BUY)` → BUY.
2. CCXT path: `t.get("side", "buy")` defaults missing side to `"buy"`; unknown side string → `Side.BUY`.
3. Feed mixed book of trades with missing side → OrderBook `total_buy_volume` / CVD systematically **overstates buys**.
4. Liquidation path in `crypto.py:260` same default pattern.

### Expected
Unknown aggressor should be **neutral** (skip CVD delta, or explicit `Side` unknown / None rejected upstream with metric). Never silently BUY.

### Actual
```python
# crypcodile_replay.py
if cryp_side is None:
    return Side.BUY
return _SIDE_MAP.get(val, Side.BUY)

# crypto.py
side = _SIDE_MAP.get(t.get("side", "buy"), Side.BUY)
```
Systematic **bullish bias** on partial/malformed feeds and any venue using non buy/sell labels without mapping.

### Fix hint
Default to skip trade side contribution, or map only known labels and drop/log others. Align with `is_buy_side` consumers only after validated aggressor. Unit-test None / `"maker"` / `"\"\"`.

### Evidence
- Static: `crypcodile_replay.py:76-83`, `crypto.py:25,82,260`.
- R17 §5 S6, S7 / H-S2.
