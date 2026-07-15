# Phase-4 FIX — Live reconnect + order-book/density regressions

**Agent:** Phase-4 FIX (live reconnect + tests)  
**Date:** 2026-07-13  
**Repo:** `/Users/nazmi/flowmap`

---

## Findings addressed

| ID | Severity | Status | Summary |
|----|----------|--------|---------|
| **FIND-P217-05** | P0 | **FIXED** | Live connector: reconnect loop with backoff |
| **FIND-ERR-06** | P1 | **FIXED** | Twin of P217-05 (reconnect half; stop-await residual) |
| **FIND-ERR-01** | P0 | **FIXED** | Replay early return: `_running=False` + `sig_finished` |
| FIND-P201-01 | P0 | **FIXED** | `absorb=False` default (regression-locked) |
| FIND-P202-02 | P1 | **FIXED** | Zero-size BBO no empty levels (regression-locked) |
| FIND-P206-01 | P0 | already finite | NaN CVD locked by unit test |
| FIND-P202-01 | P0 | already iterative uncross | Crossed book keeps one side (test) |
| FIND-P207-01 | P0 | **FIXED** | Density paints by side, not mid half-plane (test) |

---

## Code changes

### 1. `flowmap/data/crypcodile_live.py` — FIND-P217-05

`_LiveWorker._run` no longer does a single `await connector.run()`.

While `_running`:

1. `make_connector(...)` + ensure `AiohttpWsTransport`
2. `sig_connected.emit()`
3. `await connector.run()`
4. On exception (or clean return while still running):
   - `sig_error.emit(...)`
   - increment attempt; stop after **max 5 retries**
   - sleep **2 / 4 / 8** seconds (capped at 8s)
   - close old transport, recreate connector on next loop
5. `sig_disconnected.emit()` in `finally`

Stop path unchanged: `stop()` sets `_running=False` and closes transport so the loop exits without another sleep wait if already past sleep.

### 2. `flowmap/data/crypcodile_replay.py` — FIND-ERR-01

Early exits now always clear state:

| Path | Before | After |
|------|--------|-------|
| Crypcodile unavailable | `sig_error` + `return` | + `_running=False` + `sig_finished` |
| `CrypcodileClient(...)` fails | `sig_error` + `return` | + `_running=False` + `sig_finished` |
| Invalid time range | already correct | unchanged |

Provider `_replaying` is cleared via existing `_on_replay_finished` wired to `sig_finished`.

### 3. Order book / density (pre-existing fixes, regression tests only)

- `OrderBook.get_volume_delta()` → `0.0` when `trade_count==0` (never NaN)
- `record_trade(..., absorb=False)` default
- `apply_bbo` skips inserting zero-size levels
- `_recalc_bbo` iterative uncross keeps one side
- `DensityEngine._draw_column` colors by `norm_bids` / `norm_asks` (no mid half-plane mask)

---

## New tests

| File | Coverage |
|------|----------|
| `tests/test_order_book_fixes.py` | NaN CVD, absorb default off, zero-size BBO, crossed book |
| `tests/test_density_midmask.py` | Bid above mid / ask below mid still paint; normal half-planes |

---

## Verification

```bash
cd /Users/nazmi/flowmap
/Users/nazmi/flowmap/.venv/bin/python -m pytest tests/ -q
# or without pytest:
/Users/nazmi/flowmap/.venv/bin/python tests/_run_phase4_live_reconnect.py
```

Expected: all tests pass (including `test_bbo_pipeline.py`).

---

## Status registry updates

- `bug_hunt/phase3_execution/findings/FIND-P217-05.md` → FIXED
- `bug_hunt/phase3_execution/findings/FIND-ERR-01.md` → FIXED
- `bug_hunt/phase3_execution/findings/FIND-P201-01.md` → FIXED
- `bug_hunt/phase3_execution/findings/FIND-P202-02.md` → FIXED
- `bug_hunt/phase3_execution/findings/FIND-P207-01.md` → FIXED
- `FINDINGS_REGISTRY.md` row for FIND-P217-05 annotated FIXED
- `FINDINGS.jsonl` append status_change events

---

## Residual / out of scope

- FIND-P217-07 (live channels omit book_ticker/liquidation) — not fixed here
- Live reconnect does not reset exponential backoff across long uptime success streaks (attempts only increment on failure; success breaks the loop only when `_running` is cleared or run returns while still running and retries)
- FIND-P202-06 (mid_price=0 after pure TOB cross wipes bids) — residual; uncross still prefers dropping crossed bids first
