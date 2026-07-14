# Residual Bug Fix Plan (Subagent-Driven)

**Repo:** `/Users/nazmi/flowmap` (+ Crypcodile embed where noted)  
**Branch:** `fix/residual-bug-hunt`  
**Baseline:** Phase-4 closed ~30+ findings; residual OPEN P0/P1 below.

## Goals
Close remaining ship-risk bugs with TDD, one task at a time, review after each.

---

## Task 1 — Replay materialize OOM bound (FIND-P239-03)
**Files:** `flowmap/data/crypcodile_replay.py`  
**Spec:**
- Do not unbounded `list(book_iter)` / `list(trade_iter)` for multi-hour windows without a cap.
- Add `max_records` (default 2_000_000) env `FLOWMAP_REPLAY_MAX_RECORDS`.
- When cap hit: stop fetch, emit warning via `sig_error` or log once, still play what was loaded.
- Prefer streaming into fixed-size deque when possible; minimum is hard cap + warning.
- Tests: unit test that mock iterator longer than cap is truncated.

## Task 2 — Live channel parity (FIND-P217-07)
**Files:** `flowmap/data/crypcodile_live.py`  
**Spec:**
- Subscribe/include `book_ticker` and `liquidation` channels alongside trade/snapshot/delta.
- Map book_ticker → BBO, liquidation → Trade(is_liquidation=True) if converters exist; else no-op safe.
- Tests: channel list contains both; converter smoke if pure functions.

## Task 3 — Centering hard invariant (FIND-HIST-01/02/03)
**Files:** `flowmap/engine/density_engine.py`, `flowmap/ui/heatmap_widget.py`, tests  
**Spec:**
- When `auto_follow=True`, after each center update mid must lie within visible price range (approx 15–85% of vis rows).
- Reduce smooth_deadband hold so BTC tpr=100 cannot leave mid off-screen for >1s of updates (snap if |delta| > vis_rows*0.35).
- When `ticks_per_row` changes, rescale `center_price_ticks` so mid maps to same screen row.
- Tests: synthetic mid drift + tpr change.

## Task 4 — rebuild_heatmap freeze mitigation (FIND-P226-01)
**Files:** `flowmap/ui/heatmap_widget.py`  
**Spec:**
- Full rebuild must not block UI >~50ms for large histories without yielding.
- Acceptable approaches: (a) chunked rebuild with processEvents every N cols, or (b) max columns processed per frame with continuation QTimer.
- Prefer (b) progressive rebuild with `_rebuild_in_progress` flag.
- Keep visual correctness (final buffer matches full rebuild).
- Test: call rebuild with large synthetic history doesn't raise; progressive path completes.

## Task 5 — Order book snapshot max reset + NaN guard (FIND-P201-02, P202-05)
**Files:** `flowmap/core/order_book.py`, tests  
**Spec:**
- `apply_snapshot` resets `_max_bid_size` / `_max_ask_size` from new levels.
- Reject NaN/Inf prices in apply_update/apply_snapshot/apply_bbo (skip level).
- Tests cover both.

## Task 6 — Density col_idx clear + decay honesty (FIND-P208-01, P207-05)
**Files:** `flowmap/engine/density_engine.py`  
**Spec:**
- When `col_idx` path writes a column, clear that column to BG first (like live edge).
- Decay: either no-op documented only (already UI disabled) or ensure engine docs match instant overwrite.
- Test: col_idx push doesn't leave ghost from prior frame at same col.

## Task 7 — Unknown side + L2 side mapping (FIND-NUM-05, P203-04)
**Files:** `flowmap/data/crypcodile_replay.py`, `flowmap/data/crypto.py`, `order_book.py`  
**Spec:**
- Unknown trade side must not silently become BUY; prefer Side.SELL only if string sell/ask, else default with explicit heuristic: if price >= mid ask treat buy else sell when mid known; if unknown keep Side.BUY but count as neutral CVD (or skip CVD). Simplest safe: map unknown → no CVD contribution (size to neither buy nor sell totals) — requires Side or flag.
- Minimal ship fix: unknown → Side.SELL only for "sell"/"ask"; empty/unknown → Side.BUY with comment + log once; better: treat non-is_buy_side and non-is_sell_side as sell-side for safety?  
- **Chosen:** empty/unknown side → `Side.SELL` for aggressor? No — industry often leaves unknown.  
- **Ship:** unknown side does not increment buy or sell volume (record trade volume only); `is_buy_side` false and `is_sell_side` false → skip CVD sides.
- L2 update: if side is BUY/SELL map to ASK/BID correctly for book updates.

## Task 8 — Crypcodile embed hist bw (FIND-P236-01)
**Files:** `/Users/nazmi/Crypcodile/src/crypcodile/gui/flowmap_window.py`  
**Spec:**
- Before equal-time binning / hist push, compute target_bw from intended widget geometry (default 1500×950 or call resize engine with vis_rows≥100, hm_w≥800).
- Never bin with buffer width 1.
- Test or assert bw >= 64 after preload setup.

## Task 9 — GUI drain adaptive + session epoch (FIND-P214 residual, P222-02)
**Files:** `main_window.py`, `source_manager.py`  
**Spec:**
- Drain limit adaptive: min(5000, max(1000, qsize)) per tick or always drain until empty with max 5000/tick.
- On stop/switch, bump `session_id`; workers stamp messages; GUI ignores stale session_id.
- Tests for session discard.

## Task 10 — Regression suite + FIX_STATUS refresh
**Files:** `tests/*`, `bug_hunt/phase4_fixes/FIX_STATUS.md`  
**Spec:**
- All new tests pass via `python tests/_run_phase4_live_reconnect.py` expanded runner or unittest discover.
- Update FIX_STATUS OPEN→FIXED for closed items.
- Final report residual section updated.

---

## Execution order
1 → 5 → 6 → 3 → 2 → 7 → 4 → 8 → 9 → 10

## Non-goals
- Full plugin sandbox
- OpenGL paintGL rewrite
- Perfect equal-time bin fidelity rewrite (P236-02) unless quick
