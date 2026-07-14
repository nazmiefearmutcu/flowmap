# Phase-4 Fix Report — UX / Timestamp / README / Packaging

| Field | Value |
|-------|-------|
| **Agent** | Phase-4 FIX (UX_TIMESTAMP_README) |
| **Date** | 2026-07-13 |
| **Repo** | `/Users/nazmi/flowmap` |
| **Report** | `bug_hunt/phase4_fixes/FIX_UX_TIMESTAMP_README.md` |

## Summary

| Finding | Severity | Status | Fix approach |
|---------|----------|--------|--------------|
| FIND-NUM-02 | P1 | **FIXED** | Trade overlay uses `Trade.timestamp` + event-domain clock |
| FIND-P244-01 | P1 | **FIXED** | README + status bar match code contract |
| FIND-P207-05 | P1 | **FIXED** | Decay slider disabled + tooltip; docs aligned |
| FIND-P248-01 | P0 | **FIXED** | Verified `console=True` (prior partial fix) |
| FIND-P248-02 | P1 | **FIXED** | Verified UPX off / hiddenimports; version `0.1.0` |

---

## FIND-NUM-02 — Trade overlay stamps wall-clock, not Trade.timestamp

### Problem
`HeatmapWidget.add_trade` / `add_trades` always stored `time.time()`, discarding market event time. Replay pause advanced bubble/marker age while market time was frozen.

### Fix
1. **`flowmap/ui/heatmap_widget.py`**
   - Added `_event_clock` and `_resolve_trade_ts(timestamp)` — prefers `timestamp > 0`, else wall clock; advances event clock.
   - `add_trade(..., timestamp=None)` stores event ts in `_trades` and iceberg/stop markers.
   - `add_trades` uses `trade.timestamp` per trade.
   - Iceberg/stop prune and pulse-box 10s window use `_event_clock` (not wall clock).
2. **`flowmap/ui/bubbles.py`**
   - `add_trade(..., timestamp=None)` accepts event time; tracks `_event_clock`.
   - `Bubble.age` / `current_radius` accept optional `now` for event-domain age.
3. **`flowmap/ui/main_window.py`**
   - `_on_trade` passes `timestamp=trade.timestamp`.

### Files touched
- `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py`
- `/Users/nazmi/flowmap/flowmap/ui/bubbles.py`
- `/Users/nazmi/flowmap/flowmap/ui/main_window.py`

### Residual
- Pulse / CVD still use wall clock for some paths (out of scope).
- Live latency metrics continue to use receive/wall domain where appropriate.

---

## FIND-P244-01 — README Ctrl+scroll / Space contradict code

### Problem
README claimed Ctrl+wheel = zoom and Space = auto-follow. Code: wheel = zoom, Ctrl+wheel = pan, Space = start/stop, F = follow.

### Fix
1. **`README.md`** — controls section rewritten to match code SoT:
   - Space = start/stop
   - F = auto-follow
   - wheel = zoom
   - Ctrl+wheel = pan
   - R = reset
2. **`main_window.py`** idle status bar:
   - `F=follow  Space=start/stop  wheel=zoom  Ctrl+wheel=pan  +/−=zoom  R=reset`

### Files touched
- `/Users/nazmi/flowmap/README.md`
- `/Users/nazmi/flowmap/flowmap/ui/main_window.py`

---

## FIND-P207-05 — Decay slider unused (docs + UI lie)

### Problem
`DensityEngine` stores `decay` but paint path is snapshot-only (`no accumulation or decay`). UI Decay slider + `D` hotkey mutated a no-op float.

### Fix (disable path — preferred over incomplete accumulation)
1. **`main_window.py`**
   - Decay slider `setEnabled(False)`.
   - Tooltip: `"Not implemented — density uses instant snapshot (no accumulation/decay)"`.
   - Label shows `n/a`.
   - `D` key shows status message when disabled (no silent cycle).
2. **`density_engine.py`** class docstring corrected: snapshot rasterization; decay reserved/API-only.

### Files touched
- `/Users/nazmi/flowmap/flowmap/ui/main_window.py`
- `/Users/nazmi/flowmap/flowmap/engine/density_engine.py`

### Residual
Full Bookmap-style density accumulation remains a feature request, not a hidden control.

---

## FIND-P248-01 / FIND-P248-02 — FlowMap.spec packaging (verify + complete)

### Verification (pre-existing partial fix)
| Item | Before (finding) | Current |
|------|------------------|---------|
| `console` | `False` | **`True`** (+ comment FIND-P248-01) |
| `upx` (EXE/COLLECT) | `True` | **`False`** |
| `hiddenimports` | `[]` | **Populated** (PyQt6, numpy, flowmap modules, duckdb, …) |
| `bundle_identifier` | `None` | **`com.flowmap.app`** |
| Version | `0.0.0` (default) | **`0.1.0`** via `info_plist` (this pass) |

### Additional this pass
- `BUNDLE` `info_plist`: `CFBundleShortVersionString` / `CFBundleVersion` = `0.1.0` (matches `setup.py`).

### Files touched
- `/Users/nazmi/flowmap/FlowMap.spec`

### Residual (non-blocking)
- No always-on log file / `sys.excepthook` for windowed release (console=True mitigates startup silence).
- Aggressive `excludes` for unused eth/web3 not applied (optional bloat reduction).

---

## Registry / finding status

Updated to **FIXED**:
- `bug_hunt/phase3_execution/findings/FIND-NUM-02.md`
- `bug_hunt/phase3_execution/findings/FIND-P244-01.md`
- `bug_hunt/phase3_execution/findings/FIND-P207-05.md`
- `bug_hunt/phase3_execution/findings/FIND-P248-01.md`
- `bug_hunt/phase3_execution/findings/FIND-P248-02.md`
- `bug_hunt/phase3_execution/FINDINGS_REGISTRY.md` (P248 rows + P207-05 + P244-01 index)

---

## Quick validation

```text
# Event ts path
HeatmapWidget.add_trades([Trade(timestamp=1_700_000_000.0, ...)])
→ _trades[-1][3] == 1_700_000_000.0
→ _event_clock >= that value

# Wall fallback
add_trade(price, size, side)  # no timestamp
→ _trades[-1][3] ≈ time.time()

# Decay UI
decay_slider.isEnabled() == False
tooltip mentions "Not implemented"

# Spec
console=True, upx=False, bundle_identifier set, version 0.1.0
```
