# FIND-SEC-02

| Field | Value |
|-------|-------|
| **ID** | FIND-SEC-02 |
| **Severity** | P2 |
| **Status** | CONFIRMED |
| **Title** | Trade absorption uses fixed abs(ε)=5e-5 and first-match scan |
| **Theme / Zones** | Z11 · secondary expand of R03 H-R03-07 / R17 F1 |
| **Taxonomy** | correctness |
| **Location** | `flowmap/core/order_book.py:183–186`, `198–201`, `234–237`, `249–252` |
| **Sibling** | R03 H-R03-07; R17 F1 |
| **Wave** | W secondary |
| **Discovered by** | phase3-hunter-sec |

### Problem

When trade price is not an exact float key in `_asks`/`_bids`, absorption scans keys in SortedDict order and takes the **first** level with `abs(k - price) < 0.00005`.

Issues:

1. **Absolute ε** is not tick-relative — for tick ≥ 1e-4 it rarely helps; for tick ≪ 5e-5 (some alts) it can match the **wrong adjacent** level.  
2. **First match ≠ nearest** — ascending scan may bind a farther level if an earlier key falls inside ε.  
3. **O(n levels)** per trade under miss-exact path → cost under deep books (`depth=3000` prune band).  
4. Trade volume keys still use **exact** `trade.price` in `_trade_volume` while absorption may hit a different book key → split heat vs wall at “same” price.

### Repro

```python
from flowmap.core import Trade, Side
from flowmap.core.order_book import OrderBook

ob = OrderBook("ALT")
# Adjacent levels closer than 5e-5
ob._asks[0.00010] = 100.0
ob._asks[0.00014] = 100.0
# Trade near second level but ε hits first first
ob.record_trade(Trade(1.0, "ALT", 0.00013, 10.0, Side.BUY))
# Inspect which key shrank — first-in-range wins, not nearest
```

Also: BTC-style float noise `|k-p| > 5e-5` → absorption miss while L2 holds size (under-absorb when dual path disabled).

### Expected

Match by instrument tick (or round to tick grid); prefer exact key else **nearest** within 0.5 tick; accumulate trade stats on the same matched key as absorption.

### Actual

Hard-coded `0.00005`, linear first-hit scan, trade maps keyed by raw price.

### Fix hint

`match_price(book, price, tick)` → exact then `min(keys, key=abs) if abs < 0.5*tick`; store trade volume under matched key; share helper between `record_trade` and `record_trades` (currently duplicated).

### Evidence

- Static: four identical ε loops in `order_book.py`.  
- R03 §4.6; R17 F1 table.  
- No unit coverage for near-miss absorption (only `tests/test_bbo_pipeline.py`).
