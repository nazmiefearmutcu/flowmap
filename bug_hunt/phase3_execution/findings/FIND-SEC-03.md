# FIND-SEC-03

| Field | Value |
|-------|-------|
| **ID** | FIND-SEC-03 |
| **Severity** | P1 |
| **Status** | CONFIRMED |
| **Title** | apply_bbo inserts zero-size top-of-book levels |
| **Theme / Zones** | Z11 · secondary expand of R03 H-R03-03 / H-R03-06 related |
| **Taxonomy** | correctness |
| **Location** | `flowmap/core/order_book.py:134–156` |
| **Sibling** | R03 H-R03-03; R03 invariant §2.5 #2 |
| **Wave** | W secondary |
| **Discovered by** | phase3-hunter-sec |

### Problem

Snapshot and update paths enforce non-positive size as remove (`size > 0` insert; `size <= 0` pop). **`apply_bbo` does not**:

```python
self._bids[bbo.bid] = bbo.bid_size   # writes even if bid_size == 0
self._asks[bbo.ask] = bbo.ask_size
```

Zero-size levels remain in SortedDict, inflate BBO cache (`_best_bid_size = 0` while price still “best”), and appear in `get_levels()` with `bid_size=0`/`ask_size=0`. Downstream heatmap/DOM can show empty top rows, wrong mid if only one side has positive size elsewhere, and `_max_*_size` still updates via `max(..., 0.0)` (harmless) while prune mid uses zero-size BBO prices.

Also: `apply_bbo` never calls `_recalc_bbo`, so zero tops are not cleaned by cross-repair.

### Repro

```python
from flowmap.core import BBO
from flowmap.core.order_book import OrderBook

ob = OrderBook("BTCUSDT")
ob.apply_bbo(BBO(
    timestamp=1.0, symbol="BTCUSDT",
    bid=99000.0, ask=99010.0,
    bid_size=0.0, ask_size=0.0,
))
assert 99000.0 in ob._bids and ob._bids[99000.0] == 0.0  # invariant break
assert 99010.0 in ob._asks and ob._asks[99010.0] == 0.0
levels = ob.get_levels()
assert any(lv.bid_size == 0 and lv.price == 99000.0 for lv in levels)
```

Happy-path tests in `tests/test_bbo_pipeline.py` only use positive sizes — gap not caught.

### Expected

`bid_size <= 0` → do not insert; pop existing bid at that price (or leave side empty). Same for ask. Align with snapshot/update.

### Actual

Zero sizes written into book dicts; best size fields set to 0 with price still advertised.

### Fix hint

```python
if bbo.bid > 0:
    if bbo.bid_size > 0:
        self._bids[bbo.bid] = bbo.bid_size
        ...
    else:
        self._bids.pop(bbo.bid, None)
    # then set best from remaining book or only if size>0
```

Add unit: `test_apply_bbo_zero_size_removes`.

### Evidence

- Direct code contrast: `apply_snapshot` lines 69–77 vs `apply_bbo` 136–151.  
- R03 §4.3 table “BBO | writes size even if 0”.  
- Production always applies last BBO after updates (`main_window.py:941–942`).
