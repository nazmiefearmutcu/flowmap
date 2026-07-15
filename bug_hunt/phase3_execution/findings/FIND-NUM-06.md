# FIND-NUM-06 — One-shot min-gap tick detection locks inflated tick_size

| Field | Value |
|-------|-------|
| **ID** | FIND-NUM-06 |
| **Severity** | P0 |
| **Status** | FIXED |
| **Theme / Source** | R17 T1–T3 / H-T1 |
| **Zones** | Z03, Z02 |
| **Taxonomy** | correctness |
| **Title** | tick_size = min positive L2 gap once; detect_tick_size unused; refine branch dead |
| **Location** | `flowmap/engine/density_engine.py:114-131` |
| **Sibling** | R17 T1, T2, T3, H-T1; P2-09, P2-10 |
| **Discovered by** | Phase-3 NUM hunter (static) |
| **Wave** | W2 |
| **Created** | 2026-07-13 |

### Repro
1. Push sparse L2 levels e.g. prices `{100.0, 100.5, 101.0}` while true exchange tick is `0.1`.
2. First `push_snapshot` sets `tick_size = 0.5`, `_tick_size_detected = True`.
3. Later dense snapshot with 0.1 gaps never refines (outer `if not _tick_size_detected` + dead `else: min(...)`).
4. `detect_tick_size=False` caller intent ignored — param **never read**.
5. Heatmap rows / `render_tick_size = tick_size * ticks_per_row` permanently distorted until engine reset.

### Expected
Tick from exchange metadata when available; else refine running **minimum** positive gap across snapshots; honor `detect_tick_size` flag. Do not treat sparse occupancy gap as tick forever.

### Actual
```python
if not getattr(self, '_tick_size_detected', False):
    ...
    obs_min = round(float(np.min(valid_diffs)), 6)
    if not getattr(self, '_tick_size_detected', False):  # always true here
        self.tick_size = obs_min
        self._tick_size_detected = True
    else:
        self.tick_size = min(self.tick_size, obs_min)  # DEAD
```
Default pre-detect `tick_size=0.05` (NIFTY-ish) wrong for BTC/ETH early frames (T4).

### Fix hint
Remove double-guard; keep running min while `detect_tick_size`; optional GCD of rounded diffs; wire exchange tick from catalog/symbol rules. Clamp absurd jumps.

### Evidence
- Static dead branch L127–131; unused param L114.
- R17 §2 T1–T4 / H-T1.

### Fix (2026-07-13)
Phase-4: multi-sample min refine (N=20) + honor `detect_tick_size`. See `bug_hunt/phase4_fixes/FIX_TICK_QUEUE.md`.
