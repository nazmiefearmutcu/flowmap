# FIND-SEC-04

| Field | Value |
|-------|-------|
| **ID** | FIND-SEC-04 |
| **Severity** | P1 |
| **Status** | CONFIRMED |
| **Title** | apply_bbo skips _recalc_bbo; crossed book can persist |
| **Theme / Zones** | Z11 · secondary expand of R03 H-R03-19 |
| **Taxonomy** | correctness |
| **Location** | `flowmap/core/order_book.py:134–164` vs `_recalc_bbo` 358–418 |
| **Sibling** | R03 H-R03-19; R03 H-R03-01 (related cross wipe) |
| **Wave** | W secondary |
| **Discovered by** | phase3-hunter-sec |

### Problem

`apply_bbo` sets `_best_bid`/`_best_ask` directly and only prunes:

- bids with `p > bbo.bid`  
- asks with `p < bbo.ask`

It does **not** call `_recalc_bbo()`, which is the only path that detects `best_bid >= best_ask` and runs crossed-book repair.

Therefore:

1. A ticker BBO with `bid >= ask` (stale ticker, partial one-sided update, feed glitch) is accepted into cache.  
2. Opposite-side levels **at** the crossed price can remain (prunes are strict `>` / `<`, not `>=` / `<=` against the opposite best).  
3. Until a later snapshot/update/trade triggers `_recalc_bbo`, heatmap mid/spread/imbalance use an invalid crossed BBO.  
4. GUI uses **only the last BBO** in a batch after updates — a late crossed ticker overrides a good L2-derived book without uncross.

### Repro

```python
from flowmap.core import BBO
from flowmap.core.order_book import OrderBook

ob = OrderBook("X")
ob._bids[100.0] = 5.0
ob._asks[101.0] = 5.0
ob._recalc_bbo()
# Crossed ticker
ob.apply_bbo(BBO(1.0, "X", bid=101.5, ask=100.5, bid_size=1.0, ask_size=1.0))
assert ob._best_bid >= ob._best_ask  # crossed cache accepted
# No _recalc_bbo → no dual-side wipe / repair on this path
```

### Expected

After BBO apply, book invariants match post-`_recalc_bbo`: uncrossed bests, no zero/invalid tops (with FIND-SEC-03 size guard).

### Actual

BBO path is a partial write + one-sided stale prune only; cross can stick until another mutator.

### Fix hint

End of `apply_bbo`: call `_recalc_bbo()` (and avoid double `on_bbo` by either suppressing callback inside recalc or not calling `on_bbo(bbo)` when recalc will fire). Or re-read bests from dicts after insert/prune instead of trusting ticker sizes blindly.

### Evidence

- Method body has no `_recalc_bbo` call (lines 134–164).  
- R03 §3.3 and H-R03-19.  
- Batch order places BBO after L2, before trades (`main_window.py:937–944`).
