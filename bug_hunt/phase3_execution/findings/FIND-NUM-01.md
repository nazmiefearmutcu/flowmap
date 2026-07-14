# FIND-NUM-01 — Trade absorption uses fixed absolute epsilon 5e-5

| Field | Value |
|-------|-------|
| **ID** | FIND-NUM-01 |
| **Severity** | P1 |
| **Status** | CONFIRMED |
| **Theme / Source** | R17 F1 / H-F1 |
| **Zones** | Z11 |
| **Taxonomy** | correctness |
| **Title** | Trade-to-book match epsilon is absolute 0.00005, not tick-relative |
| **Location** | `flowmap/core/order_book.py:184-185,199-200,235-236,250-251` |
| **Sibling** | R17 F1, H-F1; P2-02 (absorption) |
| **Discovered by** | Phase-3 NUM hunter (static) |
| **Wave** | W1 |
| **Created** | 2026-07-13 |

### Repro
1. Construct `OrderBook("TEST")` with an ask at `100.0` size `5.0`.
2. Record a buy trade at `100.0 + 1e-4` (offset larger than 5e-5) size `1.0`.
3. Observe ask size remains `5.0` (no absorption).
4. On a micro-tick symbol (tick `1e-8`), place asks at `p` and `p+1e-8`; trade at `p+4e-8` may match the wrong level if both fall under 5e-5 (or fail when float noise is larger than epsilon on coarse keys).

Unit sketch:
```python
from flowmap.core.order_book import OrderBook
from flowmap.core import Side, Trade, Level2Update
# after seeding ask @ 100.0, trade buy @ 100.0001 → no absorption
```

### Expected
Absorption uses a **tick-relative** epsilon (e.g. `0.5 * tick_size`) or exact exchange price key after canonical rounding, so float noise and sub-tick offsets behave consistently across BTC (tick 0.1/1) and micro-priced alts.

### Actual
Hard-coded `abs(k - price) < 0.00005` on all four match sites in `record_trade` / `record_trades`.  
- Coarse ticks / large offsets after replay price-align: trade misses book → **inflated resting liquidity**.  
- Fine ticks ≪ 5e-5: epsilon can span **multiple** levels → wrong-level absorption.

### Fix hint
Introduce `match_eps = max(tick_size * 0.5, 1e-12)` (or round trade/book prices to tick grid once). Prefer nearest-level within half-tick; reject multi-match ambiguity. Apply same helper in both `record_trade` and `record_trades`.

### Evidence
- Static: `order_book.py` L184, L199, L235, L250 identical literal `0.00005`.
- R17 §3 F1 / H-F1.
