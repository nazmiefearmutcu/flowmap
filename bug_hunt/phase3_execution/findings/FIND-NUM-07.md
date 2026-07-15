# FIND-NUM-07 — Pulse/CVD treat only Side.BUY as buy; BID→sell, unknown→sell

| Field | Value |
|-------|-------|
| **ID** | FIND-NUM-07 |
| **Severity** | P1 |
| **Status** | FIXED |
| **Theme / Source** | R17 S1, S2, S10 / H-S1 |
| **Zones** | Z04, Z05 |
| **Taxonomy** | correctness |
| **Title** | UI CVD uses side==BUY only; diverges from OrderBook is_buy_side |
| **Location** | `flowmap/ui/pulse.py:219,238`; `flowmap/ui/overlays/cvd.py:80` |
| **Sibling** | R17 S1, S2, S10, H-S1; P2-03, P2-06 |
| **Discovered by** | Phase-3 NUM hunter (static) |
| **Wave** | W1 |
| **Created** | 2026-07-13 |

### Repro
1. Emit trades with `side=Side.BID` (or ASK) as some feeds tag book-side/maker.
2. `OrderBook.record_trade` uses `is_buy_side` → BID counts as buy volume.
3. `PulseWidget.add_trade` / `CVDOverlay`: `delta = size if side == Side.BUY else -size` → BID becomes **negative** (sell).
4. Status CVD from book vs pulse/overlay **diverge**.
5. Bubbles (`bubbles.py:111-125`): non-BUY/SELL create path can zero sizes; merge path dumps non-BUY into sell_size.

### Expected
All CVD consumers use `is_buy_side` / `is_sell_side` with the same aggressor contract as core. BID/ASK on trades either normalized at ingest to BUY/SELL or handled identically everywhere.

### Actual
Strict enum equality on BUY only in pulse and CVD overlay. Unknown / ASK / BID → treated as sell in those UIs. Dual CVD sources (book net vs overlay) disagree (S10).

### Fix hint
```python
delta = size if is_buy_side(side) else -size
```
Normalize at converter boundary to BUY/SELL aggressor only. Extend unit matrix Side ∈ {BUY,SELL,BID,ASK,None}.

### Evidence
- Static: `pulse.py:219,238`, `cvd.py:80`; contrast `order_book.py:176` `is_buy_side`.
- R17 §5 S1–S3, S10 / H-S1.
