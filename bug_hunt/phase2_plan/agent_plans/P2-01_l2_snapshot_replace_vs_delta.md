# P2-01 — L2 Snapshot Replace vs Delta Matrix

**Agent:** P2-01  
**Track:** A — Core correctness  
**Theme n:** 1  
**Finding ID prefix:** `FIND-P201-`  
**Severity prior:** **P0** (wrong book state propagates to density, DOM, VP, CVD absorption)

---

## 1. Scope & linked zones / sibling hyps

| Item | Value |
|------|-------|
| **Zones** | **Z11** (OrderBook math) |
| **Sibling research** | R03 (§2–4, H-R03-02/04/06), R20 P0 cluster / Z11 |
| **Primary files** | `/Users/nazmi/flowmap/flowmap/core/order_book.py` |
| **Types** | `/Users/nazmi/flowmap/flowmap/core/__init__.py` (`Level2Snapshot`, `Level2Update`, `BookLevel`) |
| **Producer converters** | `data/crypcodile_replay.py` `_dispatch_record`, `_cryp_book_snapshot_to_flowmap`, `_cryp_book_delta_to_flowmap_updates`; `data/crypcodile_live.py`; `data/crypto.py` `_snapshot_from_ccxt` |
| **Consumer batch** | `ui/main_window.py` `_gui_tick` ~899–959 |
| **Sibling themes** | P2-02 (cross/prune), P2-04 (is_snapshot), P2-05 (trade mapping), P2-11 not in Track A10 |

### Linked hypotheses

| ID | Claim |
|----|-------|
| H-R03-02 | Trade absorption double-subtracts after L2 deltas already applied |
| H-R03-04 | Intra-frame reordering: last snapshot → remaining updates → last BBO → all trades |
| H-R03-06 | Snapshot does not reset `_max_*_size` / trade maps |
| R03 §3.1 | Snapshot clears bids/asks then inserts `size > 0` only; no `on_update` |

### Explicit non-scope

- Crossed-book wipe algorithm details → P2-02  
- Crypcodile `is_snapshot` flag semantics → P2-04  
- Trade field mapping correctness → P2-05  

---

## 2. Threat model

**Asset:** In-memory L2 as single source of truth for `get_levels()`, BBO, density projection, DOM.

**Attacker / failure modes (data plane, not security):**

1. **Lost levels after snapshot:** delta after snapshot re-introduces stale prices from pre-snapshot world if batch ordering wrong.  
2. **Ghost levels after delta:** `size <= 0` fails to remove; exact float key mismatch leaves orphans.  
3. **Partial replace:** snapshot filters `size > 0` only — zero-size levels in snapshot payload never remove (because book is cleared first — OK for full replace; bad if someone treats snapshot as patch).  
4. **Batch window corruption:** `_gui_tick` clears `updates`/`bbos` on each new snapshot in the drain window, but **keeps trades**; last snapshot wins; intermediate snapshots discarded except last.  
5. **Stale peaks:** `_max_bid_size` / `_max_ask_size` survive snapshot → washed-out heatmap normalization after thin book.  
6. **Double absorption:** updates reduce size then `record_trades` reduces again → understated walls (H-R03-02).  

**Trust boundary:** Providers put typed objects on `queue.Queue`; only GUI thread mutates `OrderBook`. Correctness assumes XOR of signal-apply vs queue-apply (R03/R16).

---

## 3. Concrete probes

### 3.1 Static

1. Read `apply_snapshot` (order_book.py:64–82) — confirm clear-then-insert; no trade map clear.  
2. Read `apply_update` / `apply_updates` (84–132) — size≤0 pop semantics.  
3. Read `_gui_tick` (main_window.py:908–944) — snapshot clears updates/bbos; apply order.  
4. Grep all `apply_snapshot` / `apply_update` call sites outside `_gui_tick`.  
5. Confirm `Level2Snapshot` has no sequence/id field → no gap detection possible.

### 3.2 Unit (pytest, headless)

Target module: new `tests/test_order_book_snapshot_delta.py` (or extend `tests/test_bbo_pipeline.py`).

| Probe ID | Steps | Expected (contract to assert) |
|----------|-------|-------------------------------|
| U1 | Empty book → snap with 3 bids/3 asks → assert keys/sizes exact | Full replace |
| U2 | Book with levels A → snap with levels B (disjoint) → assert no A remains | Replace not merge |
| U3 | Snap + delta set size=0 on one level → level gone | Delete works |
| U4 | Delta set size=0 on missing price → no crash, no insert | Idempotent delete |
| U5 | Delta set positive size new price → appears | Insert via delta |
| U6 | Snap size=0 level in payload → not inserted (filter) | `size > 0` only |
| U7 | After snap, `_max_bid_size` still old peak if new book smaller | **Document actual** (likely bug) |
| U8 | Snap does not clear `total_buy_volume` / trade maps | Session CVD survives (by design?) |
| U9 | Matrix: sequences `S`, `S→D*`, `D*→S`, `S→D→S→D` with golden final dict | Deterministic final state |
| U10 | Simulate batch: `[snap1, upd_from_snap1, snap2, upd_for_snap2]` as `_gui_tick` would: only snap2 + remaining updates after clear | Matches R03 §3.5 |
| U11 | Snap + matching trade absorption without prior delta reduce | Size decreases once |
| U12 | Snap + L2 reduce of fill size + same trade absorb | **Detect double-subtract** (FIND candidate) |

### 3.3 Dynamic / integration

1. Simulator: force snapshot-heavy path (`data/simulator.py` snapshot emit) → drain via fake queue into `OrderBook` with same apply order as `_gui_tick`.  
2. Replay fixture: parquet segment with book_snapshot + book_delta stream → compare `OrderBook.get_levels()` at T after full apply vs independent pure-Python book replaying only snapshots+deltas **without** trade absorption.  
3. Log size of `_bids`/`_asks` before/after each snap in a 30s live window — watch for unexpected jumps to 0 (interaction with P2-02).

### 3.4 Target file:line anchors

| Behavior | Anchor |
|----------|--------|
| Snapshot replace | `order_book.py:64–82` |
| Single delta | `order_book.py:84–105` |
| Batch delta | `order_book.py:107–132` |
| GUI apply order | `main_window.py:914–944` |
| Trade absorb | `order_book.py:166–205` |
| Max size peaks | set in snap/update; only cleared in `reset` `:420–436` |

---

## 4. Pass / fail criteria

| Result | Criteria |
|--------|----------|
| **PASS theme** | Unit matrix U1–U6, U9–U10 green; documented contract for session fields post-snap; double-absorb either proven absent or filed as FIND with severity |
| **FAIL (must FIND)** | Any residual level from pre-snap after snap; delta delete no-op for exact keys; GUI batch leaves updates from pre-last-snap |
| **CONDITIONAL** | U7 max peaks, U8 trade maps — if product requires pure L2 mirror, P0; if visualization session stats intentional, P2 + doc |

---

## 5. Fixtures needed

| Fixture | Description |
|---------|-------------|
| `fixtures/books/simple_l2.json` | 5 bids / 5 asks around mid 100 |
| `fixtures/books/snap_then_delta_seq.json` | Ordered events for U9 |
| `fixtures/books/sparse_after_dense.json` | Dense → thin snap for max-size drift |
| Optional parquet slice | 1–2 min BTC book_snapshot + book_delta only (no trades) for oracle |

Synthetic builders preferred over live for CI.

---

## 6. Phase-3 micro-tasks (executable hunts)

### Hunt P2-01-H1 — Snapshot full replace unit matrix  
**Agent:** general-purpose / code  
**Work:** Implement U1–U6, U9; file FINDs on any residual.  
**Exit:** Test file green or FIND-P201-01..

### Hunt P2-01-H2 — GUI batch ordering fidelity  
**Agent:** general-purpose  
**Work:** Extract apply-order pure function or simulate `_gui_tick` drain partitions without Qt; U10 + mixed trade retention.  
**Exit:** Document exact semantics; FIND if intermediate snap updates leak.

### Hunt P2-01-H3 — Trade + L2 double absorption  
**Agent:** general-purpose  
**Work:** U11–U12; compare live feed semantics (does crypcodile book_delta already include fill?).  
**Exit:** FIND-P201-XX if double-subtract confirmed; else NOTABUG with evidence.

### Hunt P2-01-H4 — Session state survival across snap  
**Agent:** Explore + unit  
**Work:** U7–U8; heatmap peak impact (`_max_*` if still used); CVD continuity.  
**Exit:** Severity classification + fix sketch if wrong.

### Hunt P2-01-H5 — Provider converter → OrderBook end-to-end  
**Agent:** integration  
**Work:** Feed synthetic crypcodile-like BookSnapshot/BookDelta through `_dispatch_record` → apply; assert parity with direct Level2 types.  
**Exit:** FIND if converter drops levels (size filter mismatch).

---

## 7. Expected finding ID prefix

`FIND-P201-01`, `FIND-P201-02`, …  

Suggested first IDs:

| ID | Likely issue |
|----|--------------|
| FIND-P201-01 | Double absorption trade+L2 |
| FIND-P201-02 | Max size not reset on snapshot |
| FIND-P201-03 | Batch keeps pre-snapshot trades against post-snap book |
| FIND-P201-04 | Converter filters differ from OrderBook insert rules |

---

## 8. Fix strategy sketch (no code yet)

1. **Document contract:** OrderBook is visualization cache, not strict exchange mirror.  
2. **Double absorb:** Gate trade absorption behind config flag, or only absorb when no concurrent L2 path, or absorb only residual after delta.  
3. **Batch trades vs snap:** On snapshot in drain, either clear trades before snap timestamp or apply trades only if `trade.ts >= snap.ts`.  
4. **Peaks:** Optionally recompute `_max_*` from book after snap, or decay peaks.  
5. Add sequence/id later only if feeds provide it (out of scope for pure book unit).

---

## 9. Dependencies

| Depends on | Why |
|------------|-----|
| None for unit matrix | Pure `OrderBook` |
| P2-04 | is_snapshot path produces Level2Snapshot — same apply_snapshot |
| P2-05 | Trade objects quality affects absorb tests |
| P2-02 | Cross repair may empty book after snap — isolate tests |

**Blocks:** Density/paint themes rely on truthful levels; Z05 hunts assume book apply order known.

---

## 10. Severity priors (from Phase 1)

| Issue class | Prior |
|-------------|-------|
| Residual / missing levels after snap | **P0** |
| Double absorption | **P0** (R03 H-R03-02) |
| Batch reorder temporal wrongness | **P1** (H-R03-04) |
| Max peaks / trade maps survive | **P1–P2** (H-R03-06) |
| No sequence validation | **P2** (by design) |

**Wave:** W1 (with Z11).
