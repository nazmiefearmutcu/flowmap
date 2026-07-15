# FIND-SEC-01

| Field | Value |
|-------|-------|
| **ID** | FIND-SEC-01 |
| **Severity** | P0 |
| **Status** | CONFIRMED |
| **Title** | Trade absorption double-subtracts liquidity already reduced by L2 deltas |
| **Theme / Zones** | Z11 (order book) · secondary expand of R03 H-R03-02 |
| **Taxonomy** | correctness |
| **Location** | `flowmap/core/order_book.py:166–205`, `213–263`; applied order `flowmap/ui/main_window.py:937–944` |
| **Sibling** | R03 H-R03-02; R17 H-F1 |
| **Wave** | W secondary |
| **Discovered by** | phase3-hunter-sec |

### Problem

`record_trade` / `record_trades` do not only accumulate session volume — they **mutate resting L2 size** on the opposite side (buy → asks, sell → bids). Live and replay feeds also emit `book_delta` / `Level2Update` that already reflect fill-driven size changes. GUI drain order is:

1. last snapshot  
2. all remaining updates  
3. last BBO  
4. **all trades** (`record_trades`)

So for the same fill, size is reduced once by L2, then again by trade absorption → understated (often zeroed) liquidity and false wall disappearances on the heatmap/DOM.

### Repro

```python
from flowmap.core import Level2Update, Trade, Side
from flowmap.core.order_book import OrderBook

ob = OrderBook("TEST")
ob._asks[100.0] = 10.0
ob._recalc_bbo()
# Exchange already reduced ask after buy fill of 5
ob.apply_update(Level2Update(1.0, "TEST", Side.ASK, 100.0, 5.0))
assert ob._asks[100.0] == 5.0
# Same fill applied again via trade path (GUI batch order)
ob.record_trade(Trade(1.0, "TEST", 100.0, 5.0, Side.BUY))
assert 100.0 not in ob._asks  # WRONG if L2 already absorbed the fill
# Expected if L2 is authoritative: remaining size 5.0
```

Integration path: start LIVE/REPLAY with queue; in one `_gui_tick` drain both an ask reduce and a matching buy trade; inspect `get_levels()` ask size vs exchange top-of-book.

### Expected

Either:

- L2 is sole authority for resting size (trades only accumulate CVD/heat), **or**
- Trade absorption runs only when no matching L2 reduce exists for that fill (idempotent / exchange-mirror mode).

### Actual

Every trade always subtracts from the book after updates in the same frame → systematic double absorption under crypcodile book+trade streams.

### Fix hint

Gate absorption: config `absorb_trades: bool = False` for live/replay where deltas include trades; or subtract only if post-update size is still ≥ pre-trade size and no concurrent delta at that price; unit matrix L2-only / trade-only / both.

### Evidence

- Code: `order_book.py` buy path deducts `self._asks[target_price] - trade.size` after exact/ε key match.  
- Apply order: `main_window._gui_tick` always `apply_updates` then `record_trades`.  
- Research: R03 §3.4–3.5, H-R03-02.  
- Providers enqueue both update and trade types when `queue` is set (`crypcodile_live.py:179–187`, `crypcodile_replay.py:513–521`).
