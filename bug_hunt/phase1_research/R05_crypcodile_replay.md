# R05 — Crypcodile Replay Data Source (Deep Analysis)

**Agent:** R05  
**Hotspot:** `/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py` (~961 LOC)  
**Related:** `flowmap/data/base.py`, `flowmap/data/config.py` (exchange fees only — **not** lake paths), `flowmap/ui/source_manager.py`, Crypcodile `Catalog` / `ParquetSink` / schema  
**Date:** 2026-07-13  
**Scope:** Phase 1 research only (no code changes)

---

## 1. Executive summary

`CrypcodileReplayProvider` bridges Crypcodile’s hive-partitioned Parquet lake (DuckDB views) into FlowMap’s `DataProvider` signal API. It is **not** a pure chronological replay of a single time window:

1. Books are loaded for `[start_ns, end_ns]`.
2. **All trades** for the symbol (global `MIN/MAX(local_ts)`) are loaded, **time-warped** onto the book window, then **price-rewritten** to sit on live book BBO/mid.
3. The full record list is **materialized in RAM** (`list(iter)`), sorted, emitted with speed sleeps, then **auto-looped forever**.

This design is the root of most severity-high bugs: memory, dual timelines, silent data distortion, empty-range spin, and fragile thread lifecycle.

`flowmap/data/config.py` only holds CCXT-style exchange fee/depth defaults; **replay paths and schema live entirely in crypcodile_replay + Crypcodile client**.

---

## 2. Expected directory layout (data lake)

Canonical hive layout (Crypcodile `ParquetSink` / `Catalog`):

```text
{data_dir}/
  exchange={EXCHANGE}/          # e.g. binance-spot, deribit
    channel={CHANNEL}/          # trade | book_snapshot | book_delta | book_ticker | liquidation | ...
      date=YYYY-MM-DD/          # UTC date derived from local_ts (ns → day)
        bucket={0..127}/
          part-{uuid}.parquet
```

**Observed local lake** (`/Users/nazmi/data` — default in `source_manager`):

```text
/Users/nazmi/data/
  exchange=binance-spot/
    channel=book_delta/date=2026-06-16/bucket={6,17}/part-*.parquet
    channel=trade/date=2026-06-16/bucket={6,17}/part-*.parquet
```

**Implications of this real layout:**

| Channel | Present? | Replay impact |
|---------|----------|---------------|
| `book_delta` | Yes | Primary book feed |
| `trade` | Yes | Trades (then time-warped) |
| `book_snapshot` | **No** | Depends entirely on `book_delta.is_snapshot` for bootstrap |
| `book_ticker` | **No** | Harmless empty channel |
| `liquidation` | **No** | Harmless empty channel |

**Default path wiring** (`source_manager.py`):

- Hardcoded default: `/Users/nazmi/data`
- Fallbacks: `~/data`, `.`
- Discovery: first dir with non-empty `load_symbols()` wins

---

## 3. Pipeline: discovery → query → event emission

```text
UI SourceManager
  │
  ├─ load_symbols(data_dir)          # static helper, DuckDB DISTINCT symbol
  ├─ get_time_range(data_dir, sym)   # static helper, per-date MIN/MAX local_ts
  │
  └─ CrypcodileReplayProvider.start_replay(symbol, start_ns, end_ns, speed)
        │
        └─ QThread + _ReplayWorker.start_replay
              │
              ├─ CrypcodileClient(data_dir)
              ├─ SQL: MIN/MAX(local_ts) FROM trade WHERE symbol=...
              ├─ SQL: AVG trade price vs AVG unnested book_delta bid prices → static price_shift
              │
              └─ while running:   # AUTO-LOOP
                    ├─ client.replay(book_snapshot|book_delta|book_ticker, [sym], start_ns, end_ns)
                    │     → list(book_iter)          # FULL MATERIALIZE
                    ├─ client.replay(trade|liquidation, [sym], trade_min, trade_max)
                    │     → list(trade_iter)         # FULL MATERIALIZE (often entire history)
                    ├─ remap trade timestamps into [start_ns, end_ns]
                    ├─ wrap trades in MappedRecord (+ price_shift)
                    ├─ sort by local_ts
                    ├─ LocalBookTracker pass: rewrite each trade price onto BBO/mid
                    └─ for each record:
                          sleep(Δt / speed)  # capped
                          _dispatch_record → Level2Snapshot | Level2Update | Trade | BBO
                          queue.put OR pyqtSignal emit
                          sig_progress
```

### 3.1 Discovery

| API | Behavior | Risk |
|-----|----------|------|
| `load_symbols` | `SHOW TABLES` → for each channel, glob `exchange=*/channel={c}/date=*`, take **latest date only**, `SELECT DISTINCT symbol … LIMIT 1000` | Symbols only on older partitions missed if latest date has *some* other symbols; silent `except: pass` |
| `get_time_range` | Prefer book tables for **min**; trade/book for **max**; walk earliest/latest date partitions | Partial coverage; empty partitions skipped by exception swallow; no continuity check |

### 3.2 Query layer

Uses two Crypcodile APIs:

1. **`client.query(sql)`** — raw SQL string interpolation for symbol (no parameters).
2. **`client.replay(...)`** — catalog `scan` with parameterized symbol + `local_ts` range, then k-way merge of Records.

`Catalog.scan` prunes by date partitions from ns range; hive paths:

```text
exchange=*/channel={channel}/date={YYYY-MM-DD}/bucket=*/part-*.parquet
```

**Note:** `client.replay` already materializes per-channel DataFrames internally (`scan` → Polars DF → record iterator). The worker then does `list(iter)` **again**, holding everything in a Python list.

### 3.3 Conversion / emission (`_dispatch_record`)

Tag resolution:

```python
channel = getattr(rec, "__struct_config__", None)
tag = channel.tag if channel else getattr(type(rec), "channel", None)
```

| Tag | Output |
|-----|--------|
| `trade` | `Trade` (`local_ts` ns → float seconds; `amount`→`size`) |
| `liquidation` | `Trade` with `is_liquidation=True` |
| `book_snapshot` | `Level2Snapshot` (drops levels with `size <= 0`) |
| `book_delta` + `is_snapshot` | Forced `Level2Snapshot` |
| `book_delta` | N× `Level2Update` (one per bid/ask level; size 0 = remove) |
| `book_ticker` | `BBO` |
| other | `[]` silent skip |

Emission path:

- If `queue` provided: `queue.put(("snapshot"|"update"|"trade"|"bbo", obj))` — **signals still wired** in provider but worker skips signal emit when queue is set.
- Else: Qt signals `sig_*` → main thread `on_*`.

---

## 4. Time travel / speed / seek

| Feature | Status | Implementation notes |
|---------|--------|----------------------|
| Window select | Partial | Only via initial `start_ns`/`end_ns` from `get_time_range` (or wall-clock fallback) |
| Seek / scrub | **Missing** | No API to jump mid-replay |
| Speed | Yes | `_speed` float; sleep = `(Δns/1e9)/speed`; chunks of 0.1s for pause/stop |
| Speed = 0 | “Max speed” | Docstring: as-fast-as-possible; guarded by `if self._speed > 0` |
| Speed cap on gaps | Yes | `sleep_sec = min(..., 5.0)` — **distorts long gaps** (compresses multi-minute holes to 5s wall time) |
| Pause / resume | Yes | `threading.Event` (`_pause_event`) |
| Stop | Partial | Sets `_running=False` + unblocks pause; **thread quit is broken** (see §7) |
| Auto-loop | Always on | After each full pass: reload + restart; no user toggle |
| Dual timeline | Always on | Trades remapped from global trade span → book window (see H1) |

**Progress:** `(current_ns - start_ns) / (end_ns - start_ns)` clamped to [0,1]. Remapped trade timestamps fall inside the book span, so progress stays coherent within a pass; auto-loop restarts from 0 without a discrete “loop count” signal.

**UI fallback when range missing** (`source_manager._toggle_replay`):

```python
now_ns = int(time.time() * 1e9)
start_ns, end_ns = now_ns - 1h, now_ns
```

If discovery fails, replay targets **wall-clock last hour**, which will **not** match historical lake data (e.g. `2026-06-16` partitions) → empty books + busy auto-loop.

---

## 5. Path handling & schema assumptions

### 5.1 Paths

| Assumption | Reality |
|------------|---------|
| `data_dir` is lake root containing `exchange=*` | Correct for Crypcodile |
| Paths portable | **False** — UI default `/Users/nazmi/data` is machine-specific |
| All channels present | **False** — production lake may only have `book_delta` + `trade` |
| Hive date = UTC from `local_ts` | Correct (Crypcodile `_date_from_ns`) |
| Symbol form | Canonical `exchange:SYMBOL` e.g. `binance-spot:BTCUSDT` |

`config.py` does **not** define `data_dir`, channel list, or partition rules.

### 5.2 Schema assumptions (must match Crypcodile msgspec records)

| Field / concept | Assumed | Risk if violated |
|-----------------|---------|------------------|
| Timestamps | `local_ts` int64 **nanoseconds UTC** | Entire speed + progress wrong if ms/µs |
| Trade side | `"buy"`/`"sell"` (StrEnum) | Unknown → defaults `Side.BUY` |
| Book levels | `(price, amount)` tuples / list of structs with `.price` | AVG unnest SQL uses `b.price` |
| Delta remove | `amount == 0` (or ≤ 1e-6 in tracker) | Orphan levels |
| Snapshot bootstrap | `book_snapshot` **or** `book_delta.is_snapshot` | Without either → empty/corrupt book |
| Trade id | hashable, unique for EMA map | Duplicate ids overwrite trends; None keys collide |
| Symbol match | exact string in SQL / scan | Case/format mismatch → empty |

### 5.3 Side mapping quirks

```python
_SIDE_MAP = {"buy": BUY, "sell": SELL, "bid": BID, "ask": ASK}
_CRYP_SIDE_TO_FLOWMAP_SIDE = {"buy": BID, "sell": ASK}  # DEFINED BUT NEVER USED
```

Trades correctly map aggressor buy/sell. Book deltas hardcode `Side.BID`/`Side.ASK` from bid/ask arrays (correct). Dead code suggests earlier confusion about side semantics.

Dynamic alignment uses:

```python
side_str = getattr(rec._record, "side", "").lower()
if "buy" in side_str: ...
```

Works for Crypcodile `Side` StrEnum; would break if side were a non-str enum without `__str__` containing buy/sell.

---

## 6. Memory usage patterns

**Verdict: load-all, not stream.**

| Stage | Behavior | Scale risk |
|-------|----------|------------|
| `list(book_iter)` | Entire book window in Python list of Record objects | High for multi-hour book_delta |
| `list(trade_iter)` over **global** trade min→max | Entire trade history for symbol | **Critical** as lake grows |
| Auto-loop | Re-runs both fetches every pass | Peak memory + DuckDB IO thrash |
| AVG queries | Full-table aggregates over trade + unnested book bids | Full scan before replay starts |
| `LocalBookTracker` | Dicts of price→size for whole session | Moderate |
| Emission | One object at a time | Fine once list built |
| Queue path | Unbounded `queue.Queue` if consumer lags | Backpressure risk (UI owns queue) |

**Streaming gap:** Crypcodile `replay()` is already an iterator, but the worker deliberately exhausts it for sort/merge/alignment. A correct stream would merge book+trade iterators by `local_ts` without full materialization and without global trade time warp.

GIL yield: `time.sleep(0.001)` every 100 records — helps UI slightly, does not reduce peak RAM.

---

## 7. Error handling gaps

| Location | Handling | Gap |
|----------|----------|-----|
| Optional import | Soft fail, `_CRYPCODILE_AVAILABLE` | Good |
| Client open | `sig_error` | Good |
| Invalid range `end <= start` | error + finished | Good |
| Trade min/max query | `print` only | Silent degrade to book-only |
| Price AVG alignment | `print` only | Silent zero shift |
| Book replay fail | `sig_error` + break outer loop | Good |
| Trade load fail | `print` only | Continues book-only |
| Empty result set | No error | **Busy auto-loop** (H3) |
| `load_symbols` / `get_time_range` | bare `except: pass` | Returns empty/None; UI may fall back to wall clock |
| SQL symbol interpolation | No validation | Injection / syntax break on `'` in symbol |
| Thread stop | `quit()` + `wait(5000)` | **Blocking slot never re-enters event loop** → quit ineffective; zombie threads (H4) |
| `start_replay` while running | `stop_replay` then new thread | Race with incomplete stop |
| Worker lifetime | `_worker = None` without `deleteLater` | Leaks QObject in dead threads |
| `_on_replay_finished` | sets flags + `disconnect()` | Fine for natural end; auto-loop rarely finishes |
| `connect()` | No real catalog open | “Connected” even if data_dir missing |
| Schema / conversion errors | Uncaught in dispatch → outer `Replay error` | One bad record aborts whole run |
| MappedRecord + frozen msgspec | Works via `__getattr__` | Fragile if dispatch relies on type identity |

---

## 8. Bug hypotheses (ranked)

### H1 — Dual timeline: trades time-warped independent of book window (HIGH)

**Where:** `_ReplayWorker.start_replay` trade load uses `trade_min/max` from full table; books use `start_ns/end_ns`.

**Effect:** All historical trades are linearly stretched/compressed into the book interval. Trade–book causality is destroyed. Liquidations included. Progress bar looks fine while data is fiction.

**Trigger:** Any multi-window lake; even same-day if trade span ≠ selected book span.

**Fix direction:** Use same `frm/to` for trades as books; drop global remap (or make explicit “demo mode”).

---

### H2 — Dynamic + static price rewriting (HIGH — data integrity)

**Where:** AVG shift + `LocalBookTracker` overwrites `MappedRecord.price_shift` so every trade sits on best ask/bid/mid.

**Effect:** Heatmap/trade markers lose true prices; debug jumps may be *created or hidden*; not “replay” but synthesis.

**Trigger:** Always when trades load successfully.

**Intent suspicion:** Workaround for prior trade/book misalignment (timezone or wrong series), not production-safe.

---

### H3 — Empty partition / empty window → CPU spin auto-loop (HIGH)

**Where:** `while self._running:` after empty `records`, no sleep before next fetch.

**Effect:** Tight loop of DuckDB scans + “auto-looping” logs; UI freezes or fans spin.

**Trigger:** Wrong symbol; wall-clock fallback window; missing channel files; empty date partition.

---

### H4 — `QThread.quit()` cannot stop blocking `run_replay` (HIGH)

**Where:** `stop_replay` → `thread.quit(); wait(5000)`.

**Effect:** Worker runs as long-blocking slot; event loop never processes quit. After 5s timeout, provider nulls refs while worker may still emit into deleted/queued receivers or keep reading disk.

**Trigger:** User hits Stop, switches source, or restarts replay mid-run.

---

### H5 — No initial snapshot when only `book_delta` without `is_snapshot` (HIGH)

**Where:** Real lake has `book_delta` only; `_dispatch_record` needs snapshot or `is_snapshot` deltas.

**Effect:** Order book applies pure increments on empty book → empty/wrong depth, mid NaN, heatmap blank or jumps when first mid appears.

**Trigger:** Binance feed starts mid-stream; first rows `is_snapshot=False`; gaps after reconnect without snapshot flag.

---

### H6 — Full materialization OOM / multi-GB RAM (HIGH as data grows)

**Where:** `list(book_iter)` + `list(trade_iter)` + auto-loop refetch.

**Trigger:** Multi-day lakes; default speed 20× still holds full list.

---

### H7 — SQL injection / fragile string SQL (MEDIUM)

**Where:**

```python
f"SELECT MIN(local_ts)... WHERE symbol = '{symbol}'"
f"SELECT AVG(price) FROM trade WHERE symbol = '{symbol}'"
# get_time_range / load_symbols similar
```

**Effect:** Symbol with `'` breaks query; malicious symbol could inject (local DuckDB — limited blast radius but still wrong).

**Contrast:** `Catalog.scan` correctly parameterizes symbol.

---

### H8 — `get_time_range` / `load_symbols` incomplete discovery (MEDIUM)

- Latest-date-only symbols can miss assets.
- Min prefers book; if book starts later than trades, UI range excludes early trades (then H1 reintroduces them warped).
- Exceptions swallowed → `(None,None)` → wall-clock fallback (H3).

---

### H9 — Sleep cap 5s compresses real time gaps (MEDIUM)

Long quiet periods play as 5s; speed perception and “real-time” mode incorrect.

---

### H10 — Timezone / unit assumptions (MEDIUM)

- Code assumes ns UTC throughout; no conversion.
- FlowMap `Trade.timestamp` is **float seconds** — consumers must not treat as ns.
- UI wall-clock fallback is local machine “now”, not lake epoch.
- `exchange_ts` ignored entirely (only `local_ts`) — clock skew between exchange and collector not modeled.

---

### H11 — Auto-loop reloads + resets consumer state unpredictably (MEDIUM)

Worker restarts data from beginning without a dedicated “loop” signal; heatmap/order book may accumulate stale state unless UI resets on progress wrap.

---

### H12 — Dead code / unused side map (LOW)

`_CRYP_SIDE_TO_FLOWMAP_SIDE` unused; confuses maintainers.

---

### H13 — `connect()` is a no-op success (LOW)

Reports connected without validating `data_dir` existence or opening client.

---

### H14 — Queue vs signal dual path (LOW–MEDIUM)

When `queue` is set, signals from worker are not emitted for market data (only progress/error/finished still use signals). Consumers that only connect to `on_trade` without draining queue see silence — integration footgun.

---

### H15 — Trade EMA / id map side effects (LOW)

`trade_trends[rec.id] = ema` then only stored on MappedRecord as `original_trend` — **never used** after construction. Dead computation cost on every trade load.

---

### H16 — Schema mismatch on bids unnest for AVG (MEDIUM)

```sql
SELECT AVG(b.price) FROM (SELECT unnest(bids) as b FROM book_delta WHERE symbol = '...')
```

Depends on DuckDB/Polars struct field name `price`. Empty `book_delta` or different level encoding → exception swallowed → `price_shift=0`. Combined with H2 dynamic pass may still overwrite.

---

## 9. Threading & lifecycle detail

```text
Main thread                          Worker QThread
─────────────                        ──────────────
start_replay()
  create worker, moveToThread
  thread.started → run_replay
  thread.start()  ─────────────────► start_replay() [blocks for hours]
                                       emit signals / queue.put
stop_replay()
  worker.stop()  ──────────────────► _running=False (checked between records)
  thread.quit()  ──────────────────► NO EFFECT until slot returns
  wait(5s)                           may still be sleeping/loading
  _worker=None, _thread=None         orphan still running
```

`set_speed` uses `sig_set_speed` queued to worker — works **only if** worker event loop processes events. During long `time.sleep` chunks and blocking SQL, **speed changes are delayed** until sleep ends and control returns… but the slot never returns to the event loop until the whole `start_replay` finishes. **Queued slots (`set_speed`, `pause`, `resume`) may not run** unless Qt processes events on that thread.

Actually: `pause`/`stop` use **threading.Event** and a shared `_running` flag mutated from main thread — those work without the event loop. But `set_speed` is a `@pyqtSlot` connected via signal — **it requires the worker event loop**. During `run_replay`, the event loop is blocked → **dynamic speed via `sig_set_speed` may never apply** until the blocking call ends (i.e. effectively broken during active replay).

**Severity: HIGH for speed slider UX.** Pause/stop partially work via flags/Event; speed update is the broken path.

Wait — are pause/resume also slots only?

```python
def pause(self): self._worker.pause()  # direct call from main thread!
def resume(self): self._worker.resume()
def stop_replay: self._worker.stop()  # direct cross-thread call
```

Direct method calls from main → worker object (living in other thread) mutate `_pause_event` / `_running` / `_speed` without queued connection for pause/stop/speed-via-direct... 

`set_speed` uses signal:

```python
def set_speed(self, speed): self.sig_set_speed.emit(speed)
```

But `source_manager` calls `set_speed` which emits to worker slot — **blocked**.

If something called `worker._speed = x` directly it would work (atomic float assign in CPython mostly OK). The signal path is the bug.

---

## 10. Interaction with UI (`source_manager`)

| Concern | Detail |
|---------|--------|
| Default speed | `20.0` — far from real-time; amplifies sleep-cap distortion |
| Default data_dir | `/Users/nazmi/data` |
| Symbol fuzzy match | strips `/:-`, casefold against lake symbols |
| Start flow | connect → get_time_range → start_replay |
| Stop flow | stop_replay + disconnect |
| Progress | optional `replay_progress` hook |

---

## 11. What `config.py` is *not*

`EXCHANGE_CONFIG` = ws/rate_limit/depth/fees for live CCXT-style providers.  
**No** replay lake path, channel list, DuckDB settings, or partition schema.  
Replay configuration is scattered: hardcoded UI paths + worker channel lists + Crypcodile package.

---

## 12. Recommended fix themes (for later phases)

1. **Single timeline:** `frm/to` identical for all channels; delete time warp.
2. **No silent price rewrite** (or gate behind explicit debug flag).
3. **Stream merge** instead of `list(iter)`; optional windowing by date partition.
4. **Stop/speed:** run replay loop in plain `threading.Thread` *or* pump `QEventLoop.processEvents` / use timers; never block Qt slot for hours.
5. **Empty data:** emit error, set finished, **do not** auto-loop without delay/backoff; disable auto-loop by default.
6. **Bootstrap:** require snapshot or first `is_snapshot` delta; else error with clear message.
7. **Parameterized SQL** everywhere symbols appear.
8. **Portable data_dir** config (env / settings), not `/Users/nazmi/data`.
9. **Seek:** rebuild iterator from new `frm` with order-book rebuild from last snapshot ≤ seek point.

---

## 13. File map

| Path | Role |
|------|------|
| `/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py` | Provider + worker + converters + discovery |
| `/Users/nazmi/flowmap/flowmap/data/base.py` | `DataProvider` signal contract |
| `/Users/nazmi/flowmap/flowmap/data/config.py` | Unrelated exchange fee config |
| `/Users/nazmi/flowmap/flowmap/ui/source_manager.py` | data_dir defaults, start/stop, range fallback |
| `/Users/nazmi/Crypcodile/src/crypcodile/client/client.py` | `query` / `replay` |
| `/Users/nazmi/Crypcodile/src/crypcodile/store/catalog.py` | DuckDB hive views + scan |
| `/Users/nazmi/Crypcodile/src/crypcodile/store/parquet_sink.py` | Partition layout + schemas |
| `/Users/nazmi/Crypcodile/src/crypcodile/schema/records.py` | Record types / tags |

---

## 14. Confidence notes

- Analysis based on full read of `crypcodile_replay.py` (961 LOC), Crypcodile client/catalog/schema, live lake listing under `/Users/nazmi/data`, and UI start path.
- Qt event-loop blocking of `set_speed` slot is a strong inference from architecture; worth validating with a runtime probe in Phase 2.
- Whether production `book_delta` rows set `is_snapshot=True` on first message is **data-dependent** (H5); needs a sample parquet row check next.

---

*End of R05*
