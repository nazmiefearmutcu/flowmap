# R03 — Core Order Book & Events (Phase 1 Deep Analysis)

**Agent:** R03  
**Date:** 2026-07-13  
**Scope:** `/Users/nazmi/flowmap/flowmap/core/{order_book,events,config,__init__}.py`  
**Related consumers (read for context only):** `ui/main_window.py`, `ui/source_manager.py`, `data/crypcodile_{live,replay}.py`, `plugins/plugin_api.py`

---

## 1. Module map

| File | Role |
|------|------|
| `__init__.py` | Market-data primitives (`Side`, `Level2Snapshot`, `Level2Update`, `Trade`, `BBO`, `BookLevel`, helpers) + re-exports `OrderBook`, `EventBus`, `AppConfig` |
| `order_book.py` | Mutable L2 book state machine (`SortedDict` bids/asks) |
| `events.py` | App-level pub/sub (`EventBus`) — **orthogonal to market-data types**; unused by live pipeline |
| `config.py` | `AppConfig` UI/engine knobs; **not consulted by OrderBook** (`depth` comes from ctor only) |

Package import cycle is intentional: `__init__.py` defines types first, then imports `OrderBook` which does `from . import Level2Snapshot, ...`.

---

## 2. OrderBook API

### 2.1 Construction

```python
OrderBook(symbol: str, depth: int = 20)
```

- `MainWindow` constructs with `depth=3000` (`main_window.py:39`).
- `depth` is **not** a hard L2 depth cap for storage of live levels. It only bounds **count-based** pruning fallback when BBO mid is unavailable: `max_keep = depth * 5` (`order_book.py:454`).
- With mid available, pruning is **±15% of mid** (`order_book.py:442–451`).

### 2.2 State fields

| Field | Meaning |
|-------|---------|
| `_bids` / `_asks` | `SortedDict` price → size (ascending keys; best bid = last key, best ask = first key) |
| `_trade_volume` / `_trade_count` / `_last_trade_side` | Per-price trade accumulation (session-scoped) |
| `_max_bid_size` / `_max_ask_size` | Historical peaks for heatmap normalization (monotonic non-decreasing until `reset`) |
| `_best_*` | Cached BBO |
| `total_volume`, `total_buy_volume`, `total_sell_volume`, `trade_count` | Session CVD inputs |
| `on_update` / `on_trade` / `on_bbo` | Optional single-slot callables (not lists) |
| `_last_update_time` | Last market event timestamp applied (book/L2/BBO) |
| `last_receive_timestamp` | Last receive clock (latency path) |

### 2.3 Mutators (update paths)

| Method | Effect on book | BBO recalc | Callbacks | Prune |
|--------|----------------|------------|-----------|-------|
| `apply_snapshot(snap)` | Clear bids/asks; insert `size > 0` levels | Yes | `on_bbo` only if BBO changed (via `_recalc_bbo`); **no `on_update`** | Yes |
| `apply_update(u)` | Set/remove one level (`size <= 0` → pop) | Yes | `on_update(u)`; maybe `on_bbo` | Yes |
| `apply_updates(list)` | Same loop; single recalc/prune | Once | `on_update` **per** update after prune | Once |
| `apply_bbo(bbo)` | Write top bid/ask sizes into dicts; drop bids `> bid`, asks `< ask` | **No** `_recalc_bbo` (sets `_best_*` directly) | `on_bbo(bbo)` always if set | Yes |
| `record_trade(t)` | Accumulate volume; **also absorb** resting size on opposite side | Yes | `on_trade`; maybe `on_bbo` | No explicit (only via size→0) |
| `record_trades(list)` | Batch of above; single BBO recalc | Once | `on_trade` per trade at end | No |
| `reset()` | Clears book + trade maps + session totals | N/A | None | N/A |

### 2.4 Queries

| API | Notes |
|-----|-------|
| `get_levels(depth=None)` | Builds `BookLevel` list sorted by price; optional top-N per side |
| `bbo` property | Synthetic `BBO` from cache + `last_receive_timestamp` |
| `mid_price` / `spread` | 0 if either side missing |
| `imbalance` | `(Σbid − Σask) / (Σbid + Σask)` over **all stored** levels |
| `get_volume_delta()` | `buy − sell`; **`math.nan` if `trade_count == 0`** |

### 2.5 Intended invariants

1. **Bid prices ≤ best bid ≤ best ask ≤ ask prices** after `_recalc_bbo` crossed-book handling (when both sides present).
2. **No zero/negative sizes** in `_bids`/`_asks` via snapshot/update paths (`size > 0` insert; `size <= 0` remove). **Broken by `apply_bbo` if size is 0** (see H-R03-06).
3. **Best bid = max bid key; best ask = min ask key** after `_recalc_bbo`.
4. **Levels outside ±15% mid** eventually dropped when both BBOs exist.
5. **Session trade maps outlive book snapshots** (snapshot does not clear trades) — by design for CVD/heatmap trade density, not a pure L2 mirror.

**Not enforced (and no validation layer):**

- Sequence numbers / exchange update IDs  
- Symbol match on inbound events  
- Monotonic timestamps  
- Finite prices/sizes  
- Crossed book rejection vs. silent repair  
- Single writer / lock

---

## 3. Update path detail

### 3.1 Snapshot

```
clear bids/asks
for each (p,s) in snap.bids/asks: if s>0 store; bump max_*
_recalc_bbo()  # may fire on_bbo
_last_update_time = snap.timestamp
last_receive_timestamp = snap.receive_timestamp (getattr)
_prune_book()
```

Does **not** reset: trade maps, session volumes, `_max_*_size`, callbacks.

### 3.2 Incremental delta

```
book = bids if side==BID else asks
if size<=0: pop else set + maybe bump max
_recalc_bbo(); timestamps; prune; on_update
```

`Side` for updates is **BID/ASK** (book side), not BUY/SELL. Providers map exchange “buy/sell book side” correctly in `_CRYP_SIDE_TO_FLOWMAP_SIDE` / explicit `Side.BID`/`Side.ASK` (`crypcodile_replay.py:141–157`).

### 3.3 BBO (`apply_bbo`)

Partial updates allowed (`bid > 0` / `ask > 0` independently). Stale better-than-BBO levels pruned. Does not call `_recalc_bbo`, so **cross-repair logic in `_recalc_bbo` is skipped** on pure BBO path (only its own stale prunes).

### 3.4 Trade absorption (`record_trade`)

1. Accumulate per-price trade stats + session CVD counters.  
2. If aggressor is buy (`is_buy_side`): subtract size from **asks** at trade price (exact key, else first key with `|k-price| < 5e-5`).  
3. Else: same for **bids**.  
4. Drop level if size ≤ `1e-6`.  
5. `_recalc_bbo()`; `on_trade`.

This **mutates the L2 book from the trade feed**, not only from book deltas.

### 3.5 Production apply order (GUI drain)

`MainWindow._gui_tick` (`main_window.py:899–944`):

1. Drain queue (cap 1000): partition into snapshots / updates / trades / bbos.  
2. On snapshot: **clear prior updates+bbos in the same batch** (not trades).  
3. Apply: **last snapshot → all remaining updates → last BBO → all trades**.  
4. Temporarily null `on_trade` during book apply; UI gets trades via `heatmap.add_trades` separately.

Providers with `queue=` put to queue and **do not** emit data signals (`crypcodile_live.py:179–196`). Signal-side handlers in `SourceManager` that call `apply_*` are therefore **dead when queue is set**, but still wired.

---

## 4. Edge cases

### 4.1 Empty book

- `_recalc_bbo` → best bid/ask = 0, sizes 0.  
- `mid_price`/`spread` = 0.  
- `_prune_book` mid is `None` → count-based prune.  
- `get_levels` → `[]`.  
- `get_volume_delta` still works from trade counters independent of book.

### 4.2 Crossed book (`best_bid >= best_ask`)

`_recalc_bbo` (`order_book.py:378–408`):

- Collects **all bids ≥ best_ask** and **all asks ≤ best_bid**, removes both, then re-reads BBO.  
- For a two-level full cross (e.g. bid 100 vs ask 99), **both sides can be wiped entirely** in one pass.  
- Legitimate momentary cross (exchange race / snapshot merge) is treated as “delete conflicting levels,” not “keep last authoritative update.”

### 4.3 Zero / negative size

| Path | Behavior |
|------|----------|
| Snapshot | `size > 0` only — zeros ignored (level not inserted; existing cleared by full replace) |
| Update | `size <= 0` removes level |
| BBO | **writes size even if 0** into dict |
| Trade absorb | `max(0, size - trade)`; pop if ≤ 1e-6 |

### 4.4 Out-of-order updates

- No sequence / timestamp gate.  
- GUI reorders within a frame: all updates then BBO then trades, regardless of enqueue order.  
- Stale deltas after a snapshot still apply if they arrive after the snapshot in the queue (snapshot only clears **already-drained** earlier updates in the same batch).  
- Trades drained before a snapshot in the same batch still apply **after** the new snapshot → absorption against a book that never saw those trades’ native L2 effects.

### 4.5 NaN / Inf prices & sizes

- No validation.  
- `SortedDict` with `NaN` keys: comparisons are broken → undefined sort / possible exceptions on insert or prune loops.  
- `Inf` prices survive and dominate BBO.  
- `get_volume_delta` intentionally returns `nan` with no trades — downstream must tolerate NaN CVD (`heatmap.push_snapshot(..., cvd=cvd)`).

### 4.6 Float price identity

- Exact float keys; trade path has only a **fixed absolute epsilon 5e-5** for nearest-level match (`order_book.py:184`).  
- Unsuitable as relative tolerance for high-priced assets if float noise exceeds 5e-5, and scans **first** matching key not closest.  
- Linear scan over all ask/bid keys per trade → O(levels) per trade.

### 4.7 One-sided BBO / mid

- Mid/spread require both sides > 0.  
- `_prune_book` without mid falls back to keeping `depth*5` extreme levels only.

### 4.8 Max-size drift

- `_max_bid_size` / `_max_ask_size` only increase on larger sizes; never recomputed from current book.  
- Snapshot replace does not reset peaks → heatmap normalization can stay “washed out” after liquidity drops until `reset()`.

---

## 5. Thread-safety notes

| Component | Safety |
|-----------|--------|
| `OrderBook` | **Not thread-safe.** No locks. Concurrent mutation + `get_levels` races. |
| Design intent | Single writer on GUI thread via queue drain (`_gui_tick` @ ~16ms). |
| Risk path | `SourceManager._on_provider_*` still does direct `apply_*` if signals fire (queue `None` path or future provider that dual-emits). |
| Callbacks | `on_*` run synchronously on mutator thread; exceptions not swallowed (unlike `EventBus`). Re-entrancy possible if callback mutates book. |
| Plugin wrap | `PluginAPI` replaces `on_trade`/`on_bbo` with wrappers (`plugin_api.py:447–461`); composes with main window. |
| `EventBus` | `RLock` around subscriber list copy; publish iterates outside lock. Qt main-thread dispatch via `pyqtSignal` when available. |
| Queue | `queue.Queue` is thread-safe; book mutation still single-threaded **only if** all writers go through one drain. |

**Conclusion:** Correctness of the book assumes “only `_gui_tick` mutates after start.” Signal handlers + plugin callbacks are latent multi-writer bugs if reactivated.

---

## 6. Event model & consumers

### 6.1 Two separate “event” systems

1. **Market-data callbacks on `OrderBook`** (`on_update` / `on_trade` / `on_bbo`) — local, untyped, single slot.  
2. **`EventBus` in `events.py`** — app lifecycle pub/sub (`SOURCE_CHANGED`, `SIMULATION_*`, `SYMBOL_CHANGED`, `DECAY_CHANGED`, `ZOOM_CHANGED`, `PROVIDER_*`, `ERROR`).

### 6.2 `Event` / `EventType`

```python
@dataclass
class Event:
    type: EventType
    data: dict = field(default_factory=dict)
```

No schema validation on `data`.

### 6.3 `EventBus` behavior

- `subscribe(type, handler, main_thread=None)` — default `main_thread=True` if subscriber is on main thread.  
- `publish`: copies handler list under lock; invokes each; **all exceptions swallowed** (`except Exception: pass`).  
- Cross-thread GUI handlers: `MainThreadDispatcher.dispatch_signal.emit(lambda h=handler, e=event: h(e))`.  
- Dispatcher created only when `EventBus` is constructed / `_get_dispatcher` runs **on main thread**. Worker-constructed bus → dispatcher stays `None` → `main_thread=True` handlers run on publisher thread (fallback).  
- Global singleton: `bus = EventBus()` at import time (usually main).

### 6.4 Consumers (repo search)

- **`bus.publish` / `bus.subscribe`:** only documented examples inside `events.py` itself — **no production consumer** in `flowmap/` application code as of this research.  
- Market pipeline uses **PyQt signals on providers** + **queue** + **OrderBook callbacks**, not `EventBus`.

### 6.5 Actual OrderBook consumers

| Consumer | Usage |
|----------|--------|
| `MainWindow` | Owns book; batch apply; `on_trade` → heatmap/pulse/VP; `get_levels`/`bbo`/CVD each tick |
| `SourceManager` | `reset()` on source switch; optional direct apply via signals (inactive with queue) |
| `PluginAPI` | Shared book ref; wraps `on_trade`/`on_bbo`; `get_levels` for addons |
| `VolumeProfile` / `DOMLadder` | Read `get_levels` / BBO from UI tick |
| Tests | `tests/test_bbo_pipeline.py` only covers `apply_bbo` happy path |

---

## 7. Config interaction

`AppConfig` (`config.py`) holds `max_levels`, `depth_levels`, `bid_ref`, `ask_ref`, etc., used by engine/UI — **OrderBook never reads `AppConfig`**. Depth mismatch risk: engine `max_levels=100` vs book `depth=3000` vs prune band ±15%.

---

## 8. Hypotheses (correctness / reliability)

Format: `H-ID | severity | location | description | why suspicious`

| H-ID | Severity | Location | Description | Why suspicious |
|------|----------|----------|-------------|----------------|
| H-R03-01 | P0 | `order_book.py:378–391` | Crossed-book repair deletes **both** sides’ conflicting levels using pre-prune BBO, can empty the book on a simple two-sided cross. | Algorithm removes all `bid ≥ best_ask` **and** all `ask ≤ best_bid` simultaneously; classic full-cross example wipes both tops. |
| H-R03-02 | P0 | `order_book.py:166–205` + `main_window.py:937–944` | Trade absorption **double-subtracts** liquidity when exchange already sends L2 deltas for the same fill. | `record_trade` mutates resting size; live/replay also apply `book_delta`. Batch applies updates then trades → second subtract. |
| H-R03-03 | P1 | `order_book.py:134–161` | `apply_bbo` can insert **zero-size** top-of-book levels and never calls `_recalc_bbo` cross repair. | `self._bids[bbo.bid] = bbo.bid_size` with no `size > 0` guard; inconsistent with update/snapshot. |
| H-R03-04 | P1 | `main_window.py:914–944` | Intra-frame **reordering** (snapshot/updates/BBO before all trades; only last BBO; trades spanning pre-snapshot retained) produces temporally wrong books under burst load. | Drain deliberately regroups message types; trades not cleared on snapshot. |
| H-R03-05 | P1 | `order_book.py` (global) | No NaN/Inf/negative price guards → SortedDict corruption or absurd BBO. | Zero validation on any mutator input. |
| H-R03-06 | P1 | `order_book.py:64–82` | Snapshot does not reset `_max_*_size` or trade maps → stale normalization and trade density after reconnect/resnapshot. | Only `reset()` clears peaks; source switch calls `reset`, mid-session snapshots do not. |
| H-R03-07 | P2 | `order_book.py:183–186,234–237` | Absolute epsilon `0.00005` price match is wrong for many symbols and picks first match not nearest. | Hard-coded; O(n) scan; float keys from different feeds may not match exactly. |
| H-R03-08 | P2 | `order_book.py` (class) | No locks; multi-writer if signal path + queue path ever both active. | `SourceManager` still connects direct apply handlers; safety relies on queue XOR signal. |
| H-R03-09 | P2 | `order_book.py:49–51`, `plugin_api.py:447–461` | Single callback slot; plugin install can race with `_gui_tick` nulling/restoring `on_trade`. | `_gui_tick` sets `on_trade = None` then restores `self._on_trade`, **dropping plugin wrapper**. |
| H-R03-10 | P2 | `main_window.py:934–947` | Restoring `on_trade = self._on_trade` after batch **clobbers** plugin-wrapped callback installed on the book. | Explicit assignment to window method, not previous value. |
| H-R03-11 | P2 | `order_book.py:420–436` | `reset()` omits `_last_update_time` and `last_receive_timestamp` → stale latency/BBO timestamp after symbol switch. | Fields not cleared; only set on subsequent events. |
| H-R03-12 | P2 | `order_book.py:349–354` | `get_volume_delta` returns NaN with no trades; UI may propagate NaN into density engine / status. | Explicit `math.nan`; no finite check at call sites in `_gui_tick`. |
| H-R03-13 | P2 | `__init__.py:19–28` + trade path | `is_buy_side` treats `Side.BID` as buy; mis-tagged trade sides flip absorption and CVD. | BID≡buy, ASK≡sell in helper; trade aggressor should be BUY/SELL only. |
| H-R03-14 | P3 | `order_book.py:146–147` | Docstring for `now()` claims “monotonic” but uses `time.time()` wall clock. | Misleading for latency math; clock steps possible. (`now` in `__init__.py:146–148`) |
| H-R03-15 | P3 | `events.py:44–47,124–125` | EventBus **swallows all handler exceptions**; failures invisible. | Bare `except Exception: pass` in dispatcher and publish. |
| H-R03-16 | P3 | `events.py` + whole app | EventBus is **dead infrastructure** — app never publishes; dual event models confuse future wiring. | Grep shows no production `bus.publish/subscribe`. |
| H-R03-17 | P2 | `order_book.py:107–132` vs `84–105` | Batch `apply_updates` fires `on_update` **after** prune/BBO for each update, so handlers observe final book not intermediate. | Same for trades; may surprise incremental UI if re-enabled. |
| H-R03-18 | P2 | `order_book.py:438–451` | ±15% mid prune can drop deep book levels that still matter for heatmap/DOM when zoomed out. | Fixed band independent of `depth` and UI zoom. |
| H-R03-19 | P1 | `order_book.py:378–391` + `apply_bbo` | Crossed book after `apply_bbo` may persist until a later `_recalc_bbo` path; BBO cache can claim bid≥ask briefly. | `apply_bbo` sets bests without cross check; only prunes strictly above/below, not equal-cross on opposite side fully consistently. |
| H-R03-20 | P3 | `config.py` vs `order_book.py:25–27` | `AppConfig.depth_levels` / `max_levels` unused by OrderBook → config changes don’t affect book retention. | Split sources of truth. |

---

## 9. Suggested Phase-2 probes (not executed here)

1. Unit: construct fully crossed book → assert post-`_recalc_bbo` not empty when one side should survive.  
2. Unit: apply L2 reduce + matching trade → sizes should not go negative/zero early.  
3. Unit: `apply_bbo(..., bid_size=0)` → level must not remain.  
4. Integration: `_gui_tick` with plugin `on_trade` wrapper still installed after one frame.  
5. Fuzz: NaN/Inf prices through all mutators.  
6. Confirm live feeds: does crypcodile book_delta already reflect trades before FlowMap absorption?

---

## 10. File reference summary

| Path | Lines (approx) | Notes |
|------|----------------|-------|
| `/Users/nazmi/flowmap/flowmap/core/order_book.py` | 1–469 | Core L2 state machine |
| `/Users/nazmi/flowmap/flowmap/core/__init__.py` | 1–153 | Types + re-exports |
| `/Users/nazmi/flowmap/flowmap/core/events.py` | 1–134 | Unused EventBus |
| `/Users/nazmi/flowmap/flowmap/core/config.py` | 1–52 | Unrelated to book logic |
| `/Users/nazmi/flowmap/flowmap/ui/main_window.py` | 895–970 | Production apply batch |
| `/Users/nazmi/flowmap/flowmap/ui/source_manager.py` | 154–342 | Reset + signal wiring |
| `/Users/nazmi/flowmap/tests/test_bbo_pipeline.py` | full | Only BBO apply tests |

---

## 11. Executive takeaway

`OrderBook` is a pragmatic visualization-oriented L2 cache (prune band, trade accumulation, aggressive uncross, trade absorption), **not** a strict exchange-mirror matching engine. Highest-risk correctness issues are **(1) crossed-book double-sided wipe**, **(2) trade+L2 double absorption**, **(3) GUI batch reordering + callback clobber**, and **(4) lack of numeric validation**. `EventBus` is effectively unused; real coupling is Qt signals + queue + `OrderBook` single-slot callbacks.
