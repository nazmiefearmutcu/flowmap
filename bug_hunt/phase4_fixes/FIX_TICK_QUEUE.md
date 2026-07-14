# Phase-4 FIX — Tick detect + bounded queue + drain batch safety

**Date:** 2026-07-13  
**Agent:** Phase-4 FIX (tick/queue)  
**Findings:** FIND-P209-01, FIND-NUM-06, FIND-P213-01, FIND-P215-01, FIND-P216-01 → **FIXED**

---

## Summary

| ID | Severity | Fix | Primary file |
|----|----------|-----|--------------|
| FIND-P209-01 | P0 | Multi-sample min refine + honor `detect_tick_size` | `flowmap/engine/density_engine.py` |
| FIND-NUM-06 | P0 | Same as P209-01 (sibling) | `flowmap/engine/density_engine.py` |
| FIND-P213-01 | P0 | Bounded `DropOldestQueue(maxsize=50000)` | `flowmap/ui/source_manager.py` |
| FIND-P215-01 | P1 | Clear trades on snapshot in drain batch | `flowmap/ui/main_window.py` |
| FIND-P216-01 | P1 | `try/finally` restore `on_trade` | `flowmap/ui/main_window.py` |

---

## 1. FIND-P209-01 / FIND-NUM-06 — One-shot tick detect

### Problem
- Outer `if not _tick_size_detected` + inner set-True made the `else: min(...)` **dead**.
- First sparse L2 min-gap locked forever (e.g. gap 1.0 while true tick 0.1).
- `detect_tick_size: bool` parameter was never read.

### Fix
In `DensityEngine.push_snapshot`:

1. **Gate on `detect_tick_size`** — if `False`, skip detection entirely (rebuild callers work).
2. **Running min for first N samples** (`_tick_detect_max_samples = 20`):
   - Sample 0: set `tick_size = obs_min`
   - Samples 1..N-1: `tick_size = min(tick_size, obs_min)`
   - At N: set `_tick_size_detected = True` (freeze)
3. Reset path clears `_tick_size_sample_count` and `_tick_size_detected`.

### Expected post-fix behavior (unit sketch)

```python
e = DensityEngine(); e.resize(20, 8)
bbo = BBO(0, "T", 100.0, 100.1, 1, 1)
# sparse first book
e.push_snapshot([BookLevel(100.0, 1), BookLevel(101.0, 1)], bbo)
assert e.tick_size == 1.0 and not e._tick_size_detected  # not frozen yet
# denser second snap refines
e.push_snapshot([BookLevel(p, 1) for p in (100.0, 100.1, 100.2, 101.0)], bbo)
assert e.tick_size == 0.1
# detect_tick_size=False ignored no longer
e2 = DensityEngine(); e2.resize(20, 8)
e2.push_snapshot([BookLevel(50.0, 1), BookLevel(50.5, 1)], bbo, detect_tick_size=False)
assert e2.tick_size == 0.05 and e2._tick_size_sample_count == 0
```

### Residual risk
- After 20 samples freeze still wrong if book never shows true tick occupancy (exchange meta still preferred long-term).
- Rebuild path in `heatmap_widget.py` still one-shots from history first multi-level entry (out of scope for this ticket).

---

## 2. FIND-P213-01 — Unbounded queue

### Problem
`SourceManager._queue = queue.Queue()` had no `maxsize`. Replay/live workers blocked only on unbounded growth → RSS climb / OOM under max-speed replay or GUI stall.

### Fix
- `QUEUE_MAXSIZE = 50_000`
- `DropOldestQueue(queue.Queue)` subclass:
  - `put()` always non-blocking (`super().put(..., block=False)`)
  - On `Full`: drop one oldest via `get(block=False)`, then retry put
  - If still full (concurrent producers): drop the new item
- Workers keep calling `_queue.put(...)` — no per-site rewrite required; policy is in the queue type.

### Residual risk
- Drop-oldest can discard a recent snapshot under extreme pressure; acceptable vs OOM.
- Drain limit 1000/tick (FIND-P214) still applies — bounded queue caps mem, not lag under sustained oversupply.

---

## 3. FIND-P215-01 — Snapshot clears trades in batch

### Problem
On `"snapshot"` in `_gui_tick` drain: `updates` and `bbos` cleared, **trades kept**. Order: `apply_snapshot(S)` then `record_trades([T1_pre, T2_post])` re-absorbed pre-snap trades already in S.

### Fix + policy (documented)

```text
Drain batch policy:
  snapshot → clear updates, bbos, AND trades
  Then keep only messages after the last snapshot in this batch.
  Apply: last snapshot → updates → last bbo → remaining trades
```

Rationale: L2 snapshot is absolute book state; trades collected before it in the same FIFO drain would double-hit residual size if reapplied after `apply_snapshot`.

---

## 4. FIND-P216-01 — `on_trade` restore via finally

### Problem
`on_trade = None` before batch apply; restore only if apply completed → exception left callbacks disabled permanently.

### Fix
```python
prev_on_trade = self._order_book.on_trade
self._order_book.on_trade = None
try:
    # apply snapshot / updates / bbo / record_trades
finally:
    self._order_book.on_trade = prev_on_trade
```

---

## Files touched

| File | Change |
|------|--------|
| `flowmap/engine/density_engine.py` | Multi-sample tick refine; honor `detect_tick_size` |
| `flowmap/ui/source_manager.py` | `DropOldestQueue`, `QUEUE_MAXSIZE=50000` |
| `flowmap/ui/main_window.py` | trades.clear on snap; try/finally on_trade |
| `bug_hunt/phase3_execution/findings/FIND-P209-01.md` | Status FIXED |
| `bug_hunt/phase3_execution/findings/FIND-NUM-06.md` | Status FIXED |
| `bug_hunt/phase3_execution/findings/FIND-P213-01.md` | Status FIXED |
| `bug_hunt/phase3_execution/findings/FIND-P215-01.md` | Status FIXED |
| `bug_hunt/phase3_execution/findings/FIND-P216-01.md` | Status FIXED |
| `bug_hunt/phase3_execution/FINDINGS_REGISTRY.md` | FIND-P209-01 → FIXED |

---

## Verification checklist

- [ ] Sparse-then-dense books refine `tick_size` before freeze
- [ ] `detect_tick_size=False` leaves default tick unchanged
- [ ] Queue `qsize()` ≤ 50000 under max-speed replay / GUI stall
- [ ] Exception in `apply_snapshot` still restores `on_trade`
- [ ] Trade before snap in same drain does not punch L2 after snap
