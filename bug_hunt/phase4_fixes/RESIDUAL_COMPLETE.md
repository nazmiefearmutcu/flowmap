# Residual Plan Completion — Subagent-Driven Development

**Branch:** `fix/residual-bug-hunt`  
**Date:** 2026-07-13  
**Tests:** `75 OK` (`python -m unittest discover -s tests`)  
**Crypcodile:** 6 hist_bw tests OK  

## Task status

| Task | Finding | Status | Review |
|------|---------|--------|--------|
| 1 Replay OOM cap | P239-03 | **DONE** | Spec ✅ Quality ✅ |
| 2 Live channels | P217-07 | **DONE** | tests green |
| 3 Centering invariant | HIST-01/03/05 | **DONE** | tests green |
| 4 Progressive rebuild | P226-01 | **DONE** | scipy optional; tests green |
| 5 Snapshot max + NaN | P201-02, P202-05 | **DONE** | Spec ✅ Quality ✅ |
| 6 col_idx clear | P208-01, P207-05 | **DONE** | tests green |
| 7 Unknown side + L2 | NUM-05, P203-04 | **DONE** | tests green |
| 8 Embed hist bw | P236-01 | **DONE** | Crypcodile 6 tests |
| 9 Session + adaptive drain | P214, P222-02 | **DONE** | tests green |
| 10 Suite + docs | — | **DONE** | this file + FIX_STATUS update |

## New env flags

| Env | Effect |
|-----|--------|
| `FLOWMAP_REPLAY_MAX_RECORDS` | Cap materialize (default 2e6; 0=unlimited) |

## New test modules

- `tests/test_replay_cap.py`
- `tests/test_live_channels.py`
- `tests/test_density_col_clear.py`
- `tests/test_centering_invariant.py`
- `tests/test_rebuild_heatmap_progressive.py`
- `tests/test_gui_session_drain.py`
- (extended) `tests/test_order_book_fixes.py`

## Run

```bash
cd /Users/nazmi/flowmap
QT_QPA_PLATFORM=offscreen FLOWMAP_RENDERER=cpu \
  .venv/bin/python -m unittest discover -s tests -v
```
