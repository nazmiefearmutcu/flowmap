# P2-24 — CCXT book identity stall (`is not last_ob`)

| Field | Value |
|-------|-------|
| **Agent** | P2-24 |
| **Theme n** | 24 |
| **Slug** | `ccxt_book_identity_stall` |
| **Zones** | **Z17** |
| **Sibling fuel** | **R06** H1 (Critical), H12 (dual BBO), H9; **R20** P0-12 / top#10 |
| **Primary module** | `/Users/nazmi/flowmap/flowmap/data/crypto.py` (`_WsWorker._sender_loop`) |
| **Secondary** | Downstream OrderBook apply rate; any UI using CryptoProvider WS |
| **Track** | B — Concurrency & data plane |
| **Wave** | **W1** (critical if CCXT used) |

---

## 1. Scope & linked zones / sibling hyps

### In scope

1. Order-book conflation gate: `if ob is not None and ob is not last_ob`.
2. Ticker conflation: `if ticker is not None and ticker is not last_ticker`.
3. ccxt.pro behavior: `watch_order_book` often returns **same dict object** mutated in place.
4. Effect: after first emit, identity check fails forever → **no further snapshots** → book stall; trades may still flow.
5. Dual BBO from OB-derived + ticker under same pattern.
6. Contrast with Crypcodile path (every record put — no identity gate).

### Out of scope

| Concern | Owner |
|---------|-------|
| REST polling freeze | **P2-23** |
| Trade list vs Trade signal mode | R06-H15 / P2-20 |
| Reconnect duplicate trades | R06-H11 (note only) |

### Sibling map

| ID | Claim | Sev |
|----|-------|-----|
| R06-H1 | OB conflation dead after first emit | **Critical** |
| R06-H12 | Dual BBO thrash | Medium |
| R20 P0-12 / top#10 | CCXT identity stall | **P0** if path used |

### Code anchors

```
crypto.py
  L204–251  _sender_loop
  L207–208  last_ob = None; last_ticker = None
  L225–235  ob = _orderbook_buffer; if ob is not None and ob is not last_ob: emit; last_ob = ob
  L238–246  ticker identity gate analogous
  L276–285  _watch_orderbook: self._orderbook_buffer = ob  # rebinds name; object may be same
  L298+     _watch_ticker similarly
```

**Semantics of `is`:** reference equality. If ccxt reuses one order book structure and only mutates bids/asks arrays, `ob is last_ob` is True on every subsequent iteration → **skip emit forever**.

---

## 2. Threat model

### Assets

| Asset | Failure |
|-------|---------|
| Live order book truth after t0 | Frozen book while market moves |
| BBO / mid for heatmap centering | Stuck mid; density wrong |
| User trust | “App connected but dead” |

### Scenarios

| # | Scenario | Result |
|---|----------|--------|
| S1 | Binance spot WS via ccxt.pro, default path | First snapshot OK; then stall (hypothesis) |
| S2 | Exchange that returns new dict each watch | Identity gate works by accident; still fragile |
| S3 | Trades continue (separate buffer) | UI shows trades on stale book — confusing |
| S4 | Ticker-only updates if ticker is new object | Mid flickers from ticker while book frozen |
| S5 | Ticker also same object mutated | Both BBO paths die after first |

### Severity rationale

Wrong frozen book is **P0 data correctness** when this transport is active. If CryptoProvider is currently unreachable from UI, still **P0 latent** for re-enable / alternate entrypoints.

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| ST-1 | Confirm no sequence id / nonce / content hash in gate |
| ST-2 | Confirm snapshot always full depth (no L2 delta path) |
| ST-3 | Compare Crypcodile live: no identity conflation |

### 3.2 Unit (deterministic)

| ID | Steps | Assert |
|----|-------|--------|
| U1 | Simulate buffer: same dict `ob`; mutate `ob['bids']`; run sender logic once per “tick” | Count emits: expect **1** with current code (bug) |
| U2 | New dict each time with same content | Emits every tick (control) |
| U3 | Dirty flag model: `_ob_dirty=True` on watch; sender clears | Emits every dirty (fix oracle) |
| U4 | Ticker same-object mutate | Same as U1 for BBO |

Implementation note: extract pure function `should_emit_ob(ob, last_ob) -> bool` for testing without asyncio if needed; or run `_sender_loop` with mocked sleep.

### 3.3 Dynamic (live network)

| ID | Steps | Metric |
|----|-------|--------|
| D1 | CryptoProvider WS BTC/USDT 30s | Count queue snapshots / sec; expect ~33 Hz if fixed; ~0 after first if bug |
| D2 | Log `id(ob)` each watch_order_book return | Constant id → proves identity theory |
| D3 | Log top-of-book price over time vs exchange | Stall detection |
| D4 | Multi-exchange sample (binance, bybit if available) | Portability of bug |

### 3.4 GUI

| ID | Fail look |
|----|-----------|
| G1 | Heatmap freezes after first paint; trades still blink |
| G2 | DOM ladder static while tape moves |

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF-1 | While market moves, snapshots continue at conflation rate (~33 Hz) or content-change rate | Zero snapshots after first for ≥5s with active WS |
| PF-2 | Top-of-book tracks exchange within conflation lag | Mid frozen >1s while trades print new prices |
| PF-3 | Conflation never uses pure identity of mutable singleton | `is not last_ob` remains sole gate |
| PF-4 | Unit U1 emits on mutation of same object | U1 emits only once |
| PF-5 | Trades + book both live | Trades-only liveliness |

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| Mutable singleton orderbook dict sequence | U1 |
| Fresh-dict sequence | U2 control |
| Instrumented `_sender_loop` with `asyncio.sleep` patched to no-op or short | Unit speed |
| Optional: recorded ccxt.pro watch return ids from real session | Evidence pack |
| Counter consumer on queue | D1 metrics |

---

## 6. Phase-3 micro-tasks

### MT-24-1 — Minimal repro unit (no network)
Implement U1/U2; commit as failing test (red) documenting bug.

### MT-24-2 — Live id(ob) trace
5-minute binance session; attach log of `id(ob)`, best bid/ask; classify H1 confirmed/refuted per exchange.

### MT-24-3 — Fix options bake-off (design only)
Compare: (a) always emit every sender tick if buffer non-None; (b) `_ob_dirty` flag set in `_watch_orderbook`; (c) content hash / nonce / `ob['nonce']` if present; (d) `copy.deepcopy` cost. Pick default for Phase-4.

### MT-24-4 — Ticker path same bug
Parallel test for `last_ticker`; dual BBO interaction FIND.

### MT-24-5 — Product exposure
Confirm SourceManager/DataManager reachability; label FIND sev P0 vs P0-latent.

---

## 7. Expected finding IDs

Format: **`FIND-P224-XX`**

| ID | Title | Sev prior |
|----|-------|-----------|
| FIND-P224-01 | `ob is not last_ob` stalls book after first emit | **P0** |
| FIND-P224-02 | `ticker is not last_ticker` stalls ticker BBO | **P0/P1** |
| FIND-P224-03 | Trades continue on frozen book (symptom compound) | **P1** UX |
| FIND-P224-04 | Dual BBO sources fight when one stalls | **P1** |
| FIND-P224-05 | No sequence-based conflation API | **P2** design |
| FIND-P224-06 | Missing receive_timestamp on WS sender emits | **P1** (R06-H5; note) |

---

## 8. Fix strategy sketch

**Recommended default:** In `_watch_orderbook`, set `self._ob_dirty = True` (and version += 1). In `_sender_loop`, if dirty: snapshot convert, put, clear dirty. Do **not** compare object identity.

**Alternatives:**
- Always process buffer every 33 Hz (simple; more CPU if convert heavy).
- Use `ob.get('nonce')` or timestamp if exchange provides monotonic updates.
- `last_sig = (best_bid, best_ask, len(bids), len(asks))` content gate (may drop size-only deep changes — careful).

**Avoid:** `deepcopy` every watch without need.

Same pattern for ticker.

---

## 9. Dependencies

| Dep | Note |
|-----|------|
| **P2-23** | Same module; orthogonal mode |
| **P2-20** | Signal vs queue emit of snapshot |
| **P2-01/02** | Downstream book apply assumes fresh snapshots |
| **P2-13** | If fix = always emit, watch queue pressure |

---

## 10. Severity priors

| Item | Prior | Source |
|------|-------|--------|
| Identity stall | **P0** | R06-H1 Critical, R20 top#10 / P0-12 |
| Exposure reduced by unused UI path | May reclassify **P0-latent** | R01 active path Crypcodile |
| Ticker twin | **P1** | R06-H12 |

**Confidence:** **High** on mechanism (Python `is` + known ccxt.pro mutability). **Medium-High** on “all exchanges always same object” — must measure D2.  
**Phase-3 rule:** Do not close theme without U1 unit proof + at least one live exchange id trace.
