# FIND-NUM-02 — Trade overlay stamps wall-clock, not Trade.timestamp

| Field | Value |
|-------|-------|
| **ID** | FIND-NUM-02 |
| **Severity** | P1 |
| **Status** | FIXED |
| **Theme / Source** | R17 TS1 / H-TS1 |
| **Zones** | Z04 |
| **Taxonomy** | correctness |
| **Title** | Heatmap add_trade stores time.time() instead of event timestamp |
| **Location** | `flowmap/ui/heatmap_widget.py:423-426` |
| **Sibling** | R17 TS1, H-TS1; P2-39 (time warp) |
| **Discovered by** | Phase-3 NUM hunter (static) |
| **Wave** | W2 |
| **Created** | 2026-07-13 |

### Repro
1. Replay historical trades with `Trade.timestamp` in the past (exchange/local_ts → seconds).
2. Call path that ends in `HeatmapWidget.add_trade(price, size, side, ...)`.
3. Inspect `self._trades[-1][3]` — equals **now wall-clock**, not `Trade.timestamp`.
4. Pause replay ~3s with bubbles `max_age≈2.5s` still ticking on wall clock → trades fade while market time is frozen.

### Expected
Trade overlay age / fade / any time-axis consumer uses **event time** (`Trade.timestamp` or receive_ts policy), consistent with tick_index X placement. Pause/scrub in replay should not expire overlays purely because wall clock advanced.

### Actual
```python
now_ts = time.time()
self._trades.append((price, size, side, now_ts, self._frame_count))
```
Event timestamp is discarded. Live path is “OK enough”; **replay scrubbing / pause ages bubbles incorrectly**. Latency and age semantics mix wall clock with historical event times elsewhere.

### Fix hint
Thread `event_ts` into `add_trade` (and liquidation append). Prefer `trade.timestamp` with optional receive wall-clock only for live latency metrics. Bubbles/pulse age should share the same clock domain.

### Evidence
- Static: `heatmap_widget.py:425-426`.
- Related: `bubbles.py` ages via `time.time() - self.timestamp`; `heatmap/heatmap_renderer.py:249` also stamps `time.time()`.
- R17 §4 TS1 / H-TS1.
