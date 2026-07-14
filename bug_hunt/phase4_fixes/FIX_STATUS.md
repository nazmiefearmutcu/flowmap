# Phase 4 — Fix Status Matrix

**Date:** 2026-07-13  
**Method:** Cross-check every Phase-3 finding file under `bug_hunt/phase3_execution/findings/` against **current source** (not finding.md claims alone).  
**Trees:** `/Users/nazmi/flowmap/flowmap/**`, `/Users/nazmi/flowmap/FlowMap.spec`, `/Users/nazmi/Crypcodile/src/crypcodile/gui/flowmap_window.py`  
**Git note:** Working tree has **uncommitted** Phase-4-era edits vs last commit; status is from on-disk code, not commit history. `phase4_fixes/` previously empty — this document is the first formal fix ledger.

**Legend**

| Status | Meaning |
|--------|---------|
| **FIXED** | Defect no longer present under default / production paths; code evidence cited |
| **PARTIAL** | Mitigated or opt-in/guarded; residual risk remains |
| **OPEN** | Still present as described (or only cosmetically changed) |
| **REFUTED** | Original claim false against current (or already-correct) behavior — no fix required |
| **LATENT** | Code path exists but not wired / not hit in default UI |

**Evidence key:** path anchors are absolute under `/Users/nazmi/flowmap` unless marked Crypcodile.

---

## Summary counts (128 FIND-*.md)

| Status | Count (approx) | Notes |
|--------|----------------|-------|
| FIXED | 28 | Includes code fixes landed after Phase-3 reports were filed |
| PARTIAL | 12 | Mitigations; residual work listed in evidence |
| REFUTED | 6 | Book wipe / NaN CVD hypotheses |
| LATENT | 4 | Plugins, REST path, dual emit |
| OPEN | 78 | Still ship-risk or UX/perf debt |

> Phase-3 FIND files often still say `CONFIRMED` even when code was later fixed. **This table supersedes those Status fields.**

---

## A. FIXED (code-verified)

| Finding | Sev | Title (short) | Evidence |
|---------|-----|---------------|----------|
| FIND-P224-01 | P0 | CCXT order-book identity stall | `flowmap/data/crypto.py` `_orderbook_nonce` / emit when `ob_nonce != last_ob_nonce` (≈147–259, 295, 318) |
| FIND-P201-01 | P0 | Trade+L2 double absorption | `order_book.record_trade(..., absorb=False)` default; GUI `record_trades(trades)` without absorb (`order_book.py:177–183`, `main_window.py:955`) |
| FIND-SEC-01 | P0 | Same as P201-01 (secondary report) | Same absorb=False path |
| FIND-P207-01 | P0 | Mid-mask drops opposite-side liquidity | Color by bid/ask arrays, not mid half-planes (`density_engine.py:362–379`) |
| FIND-P210-01 | P0 | History polyline wrong tick unit | `_draw_historical_price_line` uses `_price_to_screen_y` (`heatmap_widget.py:1409–1423`) |
| FIND-P210-02 | P0 | History Y full-buffer scale | Same helper; comment references FIND-P210-01/02 |
| FIND-P247-01 | P0 | Hardcoded `/Users/nazmi/data` | `FLOWMAP_DATA_DIR` → `~/data` if dir → `.` (`main_window.py:34–40`, `source_manager.py:117–120`) |
| FIND-P235-01 | P0 | Hardcoded `/Users/nazmi/flowmap` sys.path | Crypcodile `flowmap_window.py:_resolve_flowmap_path` + `FLOWMAP_HOME` (lines 6–28) |
| FIND-P248-01 | P0 | `console=False` silent crash | `FlowMap.spec:44` `console=True` |
| FIND-P240-01 | P0 | Dynamic BBO price rewrite always on | Rewrite only if `FLOWMAP_REPLAY_REWRITE_PRICES=1`; else shifts cleared (`crypcodile_replay.py:492–517`) |
| FIND-P240-02 | P0 | Static AVG price shift always on | Static shift only with `FLOWMAP_REPLAY_STATIC_SHIFT=1` (same block) |
| FIND-P240-03 | P0 | Compound warp+rewrite fiction | Price rewrite half default-off; time-warp still open (see PARTIAL/OPEN) |
| FIND-P219-03 | P0 | Empty auto-loop CPU spin | Empty window `time.sleep(2.0)` (`crypcodile_replay.py:582–586`) |
| FIND-P217-05 | P0 | Live no reconnect | Backoff loop max 5, 2/4/8s (`crypcodile_live.py:143–219`) |
| FIND-ERR-06 | P1 | Live no reconnect (error-wave twin) | Same `_run` reconnect loop |
| FIND-ERR-01 | P0 | Replay early-return stuck `_running` | Client-open / invalid-range / unavailable emit `sig_finished` + `_running=False` (`crypcodile_replay.py:274–307`) |
| FIND-P213-01 | P0 | Unbounded queue | `DropOldestQueue(maxsize=50_000)` (`source_manager.py:33–59,111`) |
| FIND-P202-02 | P1 | Zero-size TOB insert | `apply_bbo` only inserts if `bid_size/ask_size > 0` (`order_book.py:134–172`) |
| FIND-SEC-03 | P1 | Zero-size TOB (twin) | Same |
| FIND-P202-03 | P1 | apply_bbo skipped uncross | Now calls `_recalc_bbo()` + prune (`order_book.py:171–172`) |
| FIND-SEC-04 | P1 | apply_bbo skipped uncross (twin) | Same |
| FIND-P216-01 | P1 | `on_trade=None` without finally | `try/finally` restores `prev_on_trade` (`main_window.py:943–957`) |
| FIND-P222-01 | P1 | Stop leaves queue undrained | Drain loop on replay stop (`source_manager.py:467–472`) |
| FIND-P243-01 | P1 | F/set_auto_follow flag-only | `set_auto_follow(True)` zeros `_scroll_offset` + rebuild (`heatmap_widget.py:1034–1043`) |
| FIND-P203-01 | P1 | BID trade CVD split book vs UI | Unified `is_buy_side` in order_book / pulse / cvd / bubbles |
| FIND-NUM-07 | P1 | Pulse/CVD BUY-only | `is_buy_side` (`pulse.py:219–240`, `cvd.py:17,80`) |
| FIND-P232-01 | P1 | Bubbles BUY-only / BID→sell | `is_buy_side` / `is_sell_side` (`bubbles.py:111–127`) |
| FIND-P206-01 | P0 | get_volume_delta NaN | **REFUTED→FIXED semantics:** returns `0.0` when `trade_count==0` (`order_book.py:333–341`) |
| FIND-P206-02 | P0 | Status bar NaN CVD | Same API; format safe |
| FIND-P206-04 | P1 | reset re-NaNs CVD | reset zeros volumes; API stays finite |
| FIND-P201-06 | P0 | Snapshot residual levels | **REFUTED:** `apply_snapshot` clears then repopulates |
| FIND-P202-01 | P0 | Dual-prune wipes both sides | **REFUTED:** iterative uncross (`order_book.py:365–408`) |
| FIND-NUM-01 | P1 | Abs epsilon 5e-5 | Tick-relative `eps` when `absorb=True` (`order_book.py:198–200`) |
| FIND-P201-05 | P2 | Same epsilon (twin) | Same |
| FIND-SEC-02 | P2 | Same epsilon + first-match | Same (first-match residual → OPEN residual risk only if absorb=True) |
| FIND-P218-01 | P0 | Global SSL always off | SSL bypass only if `FLOWMAP_INSECURE_SSL=1` (`crypcodile_live.py:99–115`) |
| FIND-P247-05 | P1 | No env data_dir override | `FLOWMAP_DATA_DIR` honored in MainWindow + SourceManager |

---

## B. PARTIAL

| Finding | Sev | Title (short) | What’s done | Residual |
|---------|-----|---------------|-------------|----------|
| FIND-P241-01 | P1 | SQL f-string injection | `_sql_str()` rejects `; -- /*` and escapes quotes (`crypcodile_replay.py:214–222`); most queries use it | Still string concat; some catalog queries still use f-strings with date (`≈992–1001`); not true bind params |
| FIND-P248-02 | P1 | Spec UPX / hiddenimports / version | `upx=False`; non-empty `hiddenimports`; `bundle_identifier` set | `datas=[]`; app version not synced to `setup.py` 0.1.0; heavy transitive bloat unaddressed |
| FIND-P218-02 | — | SSL patch irreversible | Not applied by default | When env set, still patches `ClientSession.ws_connect` process-wide |
| FIND-P222-02 | P1 | No session epoch | Drain on stop helps | No epoch token; late worker `put` can still race after stop before join |
| FIND-P235-04 | P1 | `sys.path.insert(0)` shadows site | Path resolution portable | Still `insert(0)` → shadows installed `flowmap` package |
| FIND-P240-09 | P1 | Bootstrap pollutes LocalBookTracker | Harmless when rewrite OFF (default) | Full bootstrap+rewrite path still present if env ON |
| FIND-P239-01 | P0 | Trade time-warp always on | — | **Still always maps trade timestamps into book span** (`scale_factor` ≈397–401). Price rewrite only was gated |
| FIND-P219-02 | P1 | Empty range auto-loop | 2s sleep mitigates spin | Still loops forever while `_running` |
| FIND-P203-02 | P1 | ASK bubbles / plugin ignore | Bubbles fixed via `is_sell_side` | `plugin_api.py:280` still `Side.BUY` only (latent plugin path) |
| FIND-P216-02 | — | Restore clobbers plugin chain | Restores `prev_on_trade` (better than hard-coded self) | If plugins wrap `on_trade`, batch path still temporarily disables |
| FIND-P214-01 | P0 | Drain ≤1000 / 16ms | Bound queue reduces pressure | `limit = 1000` still hard-coded (`main_window.py:917`) |
| FIND-P214-02 | P1 | FIFO starve snaps | Snapshot still clears updates/bbos in batch | No priority dequeue for snapshots under flood |

---

## C. REFUTED (no code change required)

| Finding | Sev | Notes |
|---------|-----|-------|
| FIND-P201-06 | P0 | Snapshot clears `_bids`/`_asks` before apply |
| FIND-P202-01 | P0 | Iterative uncross; does not wipe both sides blindly |
| FIND-P206-01 | P0 | `get_volume_delta` → 0.0 not NaN |
| FIND-P206-02 | P0 | Status formats finite CVD |
| FIND-P206-04 | P1 | reset + get_volume_delta finite |
| (counts also listed under FIXED where semantics matter for ship) | | |

---

## D. LATENT

| Finding | Sev | Why latent |
|---------|-----|------------|
| FIND-P246-01 | P0 | Plugin `exec_module` RCE if loader wired into UI — not default-started |
| FIND-P246-03 | P1 | Plugin `sys.path` + mutable OrderBook if wired |
| FIND-P223-01 | P1 | REST `_poll_tick` on GUI thread — CCXT REST fallback / force_rest only |
| FIND-P223-05 | P1 | No CCXT REST timeout in config — same latent path |
| FIND-P220-01 | P1 | Dual queue XOR signals — production uses queue; signal handlers dead/latent |
| FIND-P224-04 | P1 | Dual BBO OB+ticker — CCXT path only |

---

## E. OPEN — must remain tracked (by area)

### E1. Order book / sides / snapshots

| Finding | Sev | Evidence still true |
|---------|-----|---------------------|
| FIND-P201-02 | P1 | `apply_snapshot` does not reset `_max_bid_size/_max_ask_size` (only `reset()` does) |
| FIND-P202-04 | P2 | ±15% mid prune hard-coded (`order_book._prune_book`) |
| FIND-P202-05 | P2 | No NaN/Inf price entry guard on apply_update |
| FIND-P202-06 | P1 | Fully crossed TOB can empty a side → mid=0 residual |
| FIND-P203-03 / FIND-NUM-05 | P2/P1 | Unknown trade side defaults `Side.BUY` (`crypcodile_replay.py:76–83`, `crypto.py:82`) |
| FIND-P203-04 | P1 | L2 `Side` not BID → asks (`order_book.py:86`) — BUY/SELL mis-map if sent as L2 side |
| FIND-P204-01 | P0 | Delta-only stream on empty book incomplete |
| FIND-P204-02 | P0 | False/`is_snapshot` handling leaves stale levels (mapping path) |
| FIND-SEC-01 residual | — | Only if callers pass `absorb=True` |

### E2. Density / tick / color / history visual

| Finding | Sev | Evidence |
|---------|-----|----------|
| FIND-P207-02 | P0 | Still `np.maximum.at` not sum (`density_engine.py:318,326`) |
| FIND-P207-03 | P2 | Live vs rebuild side-mask inequality residual risk |
| FIND-P207-04 | P2 | BBO row overwrite paints over TOB density |
| FIND-P207-05 | P1 | Decay dead: docstring claims accumulate; code “store sizes directly” (L133) |
| FIND-P208-01 | P1 | `col_idx` path no column clear before draw (L183–187 vs live clear L264–266) |
| FIND-P209-01 / FIND-NUM-06 | P0/P1 | One-shot tick lock; refine branch dead (`density_engine.py:119–131`) |
| FIND-P209-02 / FIND-NUM-03 | P1 | Symbol substring tpr/ref heuristics (`source_manager.py:406–440`) |
| FIND-P211-01 | P1 | Live sequential norm ≠ rebuild batch p98 |
| FIND-P211-02 | P1 | Rebuild resets `global_ref`; live scale freeze |
| FIND-P211-03 | P2 | Normalizer docs vs adaptive **2.5 code |
| FIND-P212-01 | P2 | Dual LUT systems; live BOOKMAP only |
| FIND-P212-02 | P3 | Gamma/alpha docs describe unused path |
| FIND-HIST-01 | P0 | BBO/center/visible desync (gui_diag.log + centering path) |
| FIND-HIST-02 | P0 | Near-empty heatmap / max-not-sum + tick grid |
| FIND-HIST-03 | P1 | smooth_deadband row-tick thresholds lag on BTC tpr |
| FIND-HIST-04 | P1 | auto_follow=False freezes engine push/center path |
| FIND-HIST-05 | P1 | tpr change scale-poisons center; no H-01 regression test |

### E3. Concurrency / lifecycle / queue

| Finding | Sev | Evidence |
|---------|-----|----------|
| FIND-P213-02 | P1 | book_delta fan-out still multiplies messages |
| FIND-P215-01 | P1 | Snapshot clears updates/bbos but not trades same batch |
| FIND-P215-02 | P1 | Batch order snap→upd→bbo→trades ≠ event-time order |
| FIND-P217-01 | P0 | Live wait then null refs / orphan thread residual |
| FIND-P217-02 | P1 | QThread.quit while run_until_complete residual |
| FIND-P217-07 | P1 | Live channels still `trade, book_snapshot, book_delta` only — no book_ticker/liquidation (`crypcodile_live.py:171`) |
| FIND-P219-01 | P1 | `list(iter)` materialize uncancellable |
| FIND-P221-01 | — | Toggle stop incomplete vs stop_current (partial overlap with drain fix) |

### E4. Replay fidelity / memory

| Finding | Sev | Evidence |
|---------|-----|----------|
| FIND-P239-01 | P0 | Global trade time-warp still on (see PARTIAL table) |
| FIND-P239-03 | P0 | Full-history `list(book_iter)` / trade materialize OOM |
| FIND-P239-08 | P2 | Sleep cap 5s secondary distortion |
| FIND-P240-09 | P1 | Bootstrap pollution if rewrite env on |

### E5. Render / UX / overlays

| Finding | Sev | Evidence |
|---------|-----|----------|
| FIND-P225-01 | P2 | OpenGL surface-only; no paintGL |
| FIND-P226-01 | P0 | rebuild_heatmap sync GUI O(history) |
| FIND-P226-02 | P2 | rebuild success omits view_changed |
| FIND-P227-01 | P2 | throttled rebuild singleShot races |
| FIND-P228-01 | P1 | QImage wraps buffer without copy |
| FIND-P229-01 | P0 | resize blanks history / blocks rebuild |
| FIND-P229-02 | P2 | `_needs_rebuild` never consumed |
| FIND-P230-01 | P2 | Trade percentile full scan every batch |
| FIND-P232-02 | — | Pulse scroll desync |
| FIND-P232-03 | P1 | Trades stamped before frame++ → 1-col lag |
| FIND-P233-01 | P1 | DOM not BBO-centered |
| FIND-P233-02 | P2 | DOM wheel no-op |
| FIND-P234-01 | P1 | VP Y stretch vs row_height |
| FIND-P243-02 | P2 | reset_view may leave scroll residual (follow path fixed; reset_view check residual) |
| FIND-P244-01 | — | Wheel/ctrl scroll contract |
| FIND-P244-02 | P1 | Dual +/- keys (row_height vs tpr) |
| FIND-NUM-02 | — | Trade overlay wall-clock not Trade.timestamp (`heatmap_widget.add_trade` uses `time.time()`) |
| FIND-NUM-04 | P1 | VP `round(price, 6)` bin collapse |
| FIND-NUM-08 | P2 | DOM BBO ε=0.001 fixed |

### E6. Embed (Crypcodile hist) / packaging / dead UI

| Finding | Sev | Evidence |
|---------|-----|----------|
| FIND-P235-04 | P1 | insert(0) shadow (PARTIAL above) |
| FIND-P236-01 | P0 | Hist bw from undersized buffer pre-show (embed) |
| FIND-P236-02 | P1 | Equal-time bins drop intra-bin L2 |
| FIND-P237-01 | P1 | Gap ≥ bw full hist wipe |
| FIND-P238-02 | P1 | Hist no snapshot bootstrap gate |
| FIND-P238-03 | P1 | Empty catalog silent return |
| FIND-P242-01 | P1 | Dual converters embed ≠ `_dispatch_record` |
| FIND-P242-03 | P1 | Hist races 500ms auto-live (`main_window.py:71`) |
| FIND-P246-01/03 | P0/P1 | LATENT plugins |
| FIND-SEC-05 | P3 | EventBus dead + swallows exceptions |
| FIND-SEC-06 | P3 | FeaturesDetailDialog never opened |
| FIND-SEC-07 | P3 | PriceChart orphaned |
| FIND-SEC-08 | P2 | DataManager unused; dual orchestration |

### E7. Error-handling wave (mostly OPEN)

| Finding | Sev | Notes |
|---------|-----|-------|
| FIND-ERR-02 | P1 | EventBus bare `pass` on handler errors |
| FIND-ERR-03 | P1 | stop_current swallows disconnect / aborts drain |
| FIND-ERR-04 | P2 | Replay catalog/time-range silent fail |
| FIND-ERR-05 | P2 | CCXT liquidation errors silent |
| FIND-ERR-07 | P1 | GUI drain→book→heatmap no defensive try |
| FIND-ERR-08 | P2 | Replay trade-load errors print-only |

---

## F. Modified / hot files (Phase-4 era code evidence)

These modules contain FIND-* comments or clear remediation relative to Phase-3 reports:

| File | Related findings |
|------|------------------|
| `/Users/nazmi/flowmap/flowmap/core/order_book.py` | P201-01, P202-02/03, P206-*, NUM-01, absorb API |
| `/Users/nazmi/flowmap/flowmap/core/__init__.py` | `is_buy_side` / `is_sell_side` (P203/NUM-07/P232) |
| `/Users/nazmi/flowmap/flowmap/engine/density_engine.py` | P207-01 mid-mask removal |
| `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py` | P210-01/02, P243-01 |
| `/Users/nazmi/flowmap/flowmap/ui/main_window.py` | P216-01, P247, drain 1000 (still open P214) |
| `/Users/nazmi/flowmap/flowmap/ui/source_manager.py` | P213-01 DropOldestQueue, P222-01 drain, P247 |
| `/Users/nazmi/flowmap/flowmap/ui/bubbles.py` / `pulse.py` / `overlays/cvd.py` | side unification |
| `/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py` | P240 env gates, P241 `_sql_str`, P219-03, ERR-01 |
| `/Users/nazmi/flowmap/flowmap/data/crypcodile_live.py` | P218 env SSL, P217-05 reconnect |
| `/Users/nazmi/flowmap/flowmap/data/crypto.py` | P224-01 nonce |
| `/Users/nazmi/flowmap/FlowMap.spec` | P248-01/02 partial |
| `/Users/nazmi/Crypcodile/.../flowmap_window.py` | P235-01 portable path |

**Still largely untouched relative to OPEN findings:** full rebuild path in `heatmap_widget.py`, VP/DOM modules, plugin loader, normalizer, most of replay materialize/time-warp core, embed hist binning in Crypcodile.

---

## G. Recommended next fix tranche (priority)

1. **P239-01** — gate or remove trade time-warp (mirror price-rewrite env design).  
2. **P239-03** — stream replay; never `list(full_iter)`.  
3. **HIST-01 / P209-01 / P207-02** — tick lock + max→sum + center regression test.  
4. **P229-01 / P226-01** — resize rebuild + off-GUI rebuild budget.  
5. **P214-01** — adaptive drain / priority snapshots.  
6. **P204-*** — snapshot bootstrap gate before delta apply.  
7. **P241** — true DuckDB parameters for remaining f-strings.  
8. **P217-07** — add book_ticker + liquidation channels if exchange supports.

---

## H. Verification commands (for re-audit)

```bash
# Unit (stdlib)
cd /Users/nazmi/flowmap && python -m unittest tests.test_bbo_pipeline -v

# Static probes from Phase-3
python bug_hunt/phase3_execution/W1/probe_order_book_wave1_stdlib.py

# Grep fix markers still present
rg -n "FIND-P|DropOldestQueue|FLOWMAP_REPLAY_REWRITE|FLOWMAP_DATA_DIR|absorb=False" flowmap/
```

*End of FIX_STATUS.md*


## Post-pass updates (orchestrator)
- Time-warp default OFF (`FLOWMAP_REPLAY_TIME_WARP`)
- Density `np.add.at` (sum rows)
- All `tests/_run_phase4_live_reconnect.py` → **12 OK**

---

## G. Residual SDD pass (2026-07-13) — CLOSED

| Finding | Status | Evidence |
|---------|--------|----------|
| FIND-P239-03 | FIXED | `_consume_iter_capped` + `FLOWMAP_REPLAY_MAX_RECORDS` |
| FIND-P239-01 | FIXED | `FLOWMAP_REPLAY_TIME_WARP` default off (prior) |
| FIND-P207-02 | FIXED | `np.add.at` (prior residual pass) |
| FIND-P217-07 | FIXED | `LIVE_CHANNELS` includes book_ticker + liquidation |
| FIND-HIST-01/03/05 | FIXED | hard snap 0.35*vis + tpr rescale |
| FIND-P226-01 | FIXED | progressive rebuild chunked QTimer |
| FIND-P201-02 | FIXED | snapshot resets max sizes |
| FIND-P202-05 | FIXED | finite price guards |
| FIND-P208-01 | FIXED | col_idx BG clear |
| FIND-P207-05 | FIXED | decay docs honesty |
| FIND-NUM-05 | FIXED | Side.UNKNOWN neutral CVD |
| FIND-P203-04 | FIXED | l2_book_side BUY→BID SELL→ASK |
| FIND-P236-01 | FIXED | Crypcodile hist target_bw ≥ 64 |
| FIND-P214-01 residual | FIXED | adaptive drain 1000–5000 |
| FIND-P222-02 | FIXED | session epoch + stamped queue |

**Full unittest suite: 75 passed.**

