# P2-16 — Callback disable `on_trade=None`

| Field | Value |
|-------|-------|
| **Agent ID** | P2-16 |
| **Theme** | Callback disable on_trade None |
| **Zones** | Z05 |
| **Siblings** | R10 §3.D, R16 H11, R03 (order book callbacks) |
| **Finding prefix** | `FIND-P216-XX` |
| **Severity prior** | **P1–P2** (double UI updates / missed updates / plugin clobber) |
| **Primary files** | `ui/main_window.py`, `core/order_book.py` |

---

## 1. Scope & linked zones / sibling hyps

### Mechanism

```python
# main_window.py:934-947
self._order_book.on_trade = None
# ... apply snapshot/updates/bbo/trades ...
self._order_book.on_trade = self._on_trade
```

Intent: `record_trades` would invoke `on_trade` per trade (`order_book.py:261-263`), which calls:

```python
# main_window.py:889-893
heatmap.add_trade(...); pulse.add_trade(...); volume_profile.add_trade(...)
```

After restore, bulk path uses:

```python
# :949-953
heatmap.add_trades(trades); pulse.add_trades(trades); volume_profile.add_trades(trades)
```

### Risks

1. **Exception between None and restore** → `on_trade` stays None forever (missed live path trades from other callers).  
2. **Double fire** if restore before bulk and record_trades still had callback — currently order is correct; regression risk.  
3. **Plugin wrapper clobber:** any code that wraps `on_trade` (chain) gets replaced by bare `self._on_trade` on restore — **not** previous wrapper.  
4. **`on_bbo` not disabled** during `apply_bbo` — asymmetric; `_on_bbo` is `pass` so low impact today.  
5. **SourceManager signal path** `_on_provider_trade` → `record_trade` with callback live — dead under queue mode (P2-20) but if enabled → double with gui_tick.  
6. **Re-entrancy:** if `on_trade` handler called something that re-entered `_gui_tick` — currently None so safe during batch.  
7. **record_trade vs record_trades:** single path still fires callback when on_trade set.

### Sibling

| ID | Note |
|----|------|
| R16 H11 | Partial disable; low concurrency severity |
| R10 | Documents temporary null for batch |

---

## 2. Threat model

| Actor | Action | Impact |
|-------|--------|--------|
| Exception in apply_snapshot | Leaves on_trade None | Silent loss of trade overlays until restart |
| Future plugin sets on_trade | Restored to MainWindow only | Plugin disconnected |
| Developer enables signal path + queue | Double add_trade | Duplicate bubbles |
| apply_bbo with non-pass handler later | Extra UI work per batch | Perf |

---

## 3. Concrete probes

### 3.1 Static

| Check | Location |
|-------|----------|
| Wire at init | `main_window.py:717-719` |
| Null + restore | `:934-947` |
| Bulk UI | `:949-953` |
| record_trades callback | `order_book.py:261-263` |
| record_trade callback | `order_book.py:210-211` |
| try/finally? | **Absent** around null/restore |

### 3.2 Unit probes

**U1 — No double UI**

```text
Monkeypatch heatmap.add_trade / add_trades counters
Run _gui_tick with 5 trades in queue
Expect: add_trades call count == 1 (batch), add_trade == 0
```

**U2 — Exception safety**

```text
Monkeypatch apply_snapshot to raise
Call _gui_tick
Assert on_trade is still self._on_trade (or document FAIL if None)
```

**U3 — Plugin clobber**

```text
order_book.on_trade = wrapper
Run successful _gui_tick
Assert on_trade is self._on_trade not wrapper  # FIND if product needs chaining
```

**U4 — Empty batch early return**

```text
has_updates False returns before nulling — on_trade untouched
```

**U5 — Signal path double (if forced)**

```text
Connect provider trade signal AND queue put same trade
Expect double book+UI if both live — documents P2-20 risk
```

### 3.3 Dynamic

- Live session: visually bubbles count ≈ trade messages (manual).  
- Force exception in apply (dev): restart overlays stop updating.

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF1 | Exactly one UI ingestion path per trade in gui_tick | Double or zero |
| PF2 | `on_trade` restored after exception | Stuck None |
| PF3 | Documented policy for external wrappers | Silent clobber |
| PF4 | No trade UI during book apply via callback | Callback fires mid-apply |
| PF5 | on_bbo policy explicit | Surprise side effects later |

---

## 5. Fixtures

- Mock HeatmapWidget / Pulse with call counters  
- List of 10 Trade objects  
- Optional pytest monkeypatch on OrderBook methods  

---

## 6. Phase-3 micro-tasks

1. **P3-16a** — U1–U4 tests.  
2. **P3-16b** — Wrap null/restore in `try/finally`.  
3. **P3-16c** — Alternative design: `record_trades(..., emit_callback=False)` flag instead of mutating attribute.  
4. **P3-16d** — If plugins planned (P2-46), define callback chain API.  
5. **P3-16e** — Audit other temporary mutations of OrderBook callbacks.

---

## 7. Finding ID format

`FIND-P216-XX`

| Seed | Title | Sev |
|------|-------|-----|
| FIND-P216-01 | Missing try/finally around on_trade=None | P1 |
| FIND-P216-02 | Restore clobbers external wrappers | P2 |
| FIND-P216-03 | on_bbo not symmetrically disabled | P3 |
| FIND-P216-04 | Dual path double-fire if signals enabled | P1 (with P2-20) |

---

## 8. Fix strategy sketch

**Best:** 

```python
def record_trades(self, trades, *, notify=True):
    ...
    if notify and self.on_trade:
        for t in trades: self.on_trade(t)
```

`_gui_tick` calls `record_trades(trades, notify=False)` then bulk UI.

**Also:** `try/finally` if keeping attribute swap.

**Plugin-safe restore:**

```python
prev = self._order_book.on_trade
try:
    self._order_book.on_trade = None
    ...
finally:
    self._order_book.on_trade = prev
```

---

## 9. Dependencies

| Theme | Rel |
|-------|-----|
| **P2-15** | Same apply block |
| **P2-20** | Signal vs queue double path |
| **P2-05** | Trade objects validity |
| **P2-46** | Plugins may set callbacks |

---

## 10. Severity priors

| Source | Sev |
|--------|-----|
| R16 H11 | Low concurrency / P2 |
| Exception stuck None | **P1** practical |
| R10 | Documented intentional pattern |

---

## 11. Code anchors

```889:953:/Users/nazmi/flowmap/flowmap/ui/main_window.py
    def _on_trade(self, trade: Trade) -> None:
        self.heatmap.add_trade(...)
        ...
        self._order_book.on_trade = None
        ...
        if trades:
            self._order_book.record_trades(trades)
        self._order_book.on_trade = self._on_trade
        if trades:
            self.heatmap.add_trades(trades)
```

```261:263:/Users/nazmi/flowmap/flowmap/core/order_book.py
        if self.on_trade:
            for trade in trades:
                self.on_trade(trade)
```
