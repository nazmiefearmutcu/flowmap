# R06 — Live Crypto Feeds Analysis

**Scope:** `/Users/nazmi/flowmap/flowmap/data/crypcodile_live.py`, `/Users/nazmi/flowmap/flowmap/data/crypto.py`  
**Related:** `_dispatch_record` in `crypcodile_replay.py`, queue consumer in `main_window.py`, wiring in `source_manager.py`  
**Date:** 2026-07-13

---

## 1. Architecture Overview

| Path | Library | Transport | Thread model | Primary UI path |
|------|---------|-----------|--------------|-----------------|
| **Crypcodile live** | crypcodile `make_connector` + `AiohttpWsTransport` | Exchange WS | `QThread` + dedicated `asyncio` loop | Prefer `queue.Queue` → `_gui_tick` drain |
| **CCXT** | `ccxt.pro` (WS) / `ccxt` (REST) | Exchange WS or REST | WS: same pattern; REST: `QTimer` on provider thread (usually main) | Queue or Qt signals |

```
[Exchange WS]
     │
     ▼
[_LiveWorker / _WsWorker]  ← asyncio in QThread
     │  queue.put(("snapshot"|"update"|"trade"|"bbo", obj))
     │  OR pyqtSignal.emit(...)
     ▼
[SourceManager._queue] ──► MainWindow._gui_tick (Qt main thread)
     │
     ▼
OrderBook + Heatmap + Pulse + VolumeProfile
```

UI live path (`source_manager._start_live`) always passes `queue=self._queue`, so **queue mode is the production path** for Crypcodile live. Signal paths remain for non-queue consumers / tests.

---

## 2. Crypcodile Live (`crypcodile_live.py`)

### 2.1 WebSocket / connection lifecycle

| Phase | Behavior | Location |
|-------|----------|----------|
| Import | Soft-fail if crypcodile missing | L25–39 |
| Connect | Create `_LiveWorker`, move to `QThread`, `started → start` | L222–251 |
| SSL | **Global monkeypatch**: `aiohttp.ClientSession.ws_connect` forces `ssl=False` | L100–108 |
| Connector | `make_connector(exchange, symbols, channels, out=sink, registry, **kwargs)` | L147–155 |
| Transport | If `connector.transport is None`, wrap `AiohttpWsTransport(connector.ws_url)` | L160–161 |
| Run | `await connector.run()` until error/cancel | L166–173 |
| Connected signal | Emitted **before** `connector.run()` — not after WS handshake | L164 |
| Disconnect | `stop()` → `_running=False` + `transport.close()` via `run_coroutine_threadsafe`; `thread.quit()` + `wait(2000)` | L125–133, L253–263 |
| Reconnect | **None** at FlowMap layer | — |
| Auth | No API keys; public channels only | — |

**Exchange kwargs:**

- binance: `market=self._market` (L140–141)
- bybit: `category="spot"` if spot else `"linear"` (L142–143)
- okx: `region="global"` only (L144–145) — no market type switch

**Subscribed channels (fixed):** `["trade", "book_snapshot", "book_delta"]` (L151)  
**Not subscribed:** `book_ticker`, `liquidation` (replay supports both).

### 2.2 Message parse path

```
connector → FlowMapLiveSink.put(record)  # L49–50
         → _LiveWorker._on_record       # L175–196
         → _dispatch_record(record)     # crypcodile_replay.py L174–208
         → queue or signals
```

`_dispatch_record` tag → type map:

| tag | Output |
|-----|--------|
| `trade` | `Trade` (uses `local_ts` ns → s; optional liquidation flag on trade) |
| `book_snapshot` | `Level2Snapshot` |
| `book_delta` | If `is_snapshot`: full `Level2Snapshot`; else N× `Level2Update` (one per level) |
| `book_ticker` | `BBO` — **never produced live** (channel not subscribed) |
| `liquidation` | `Trade(is_liquidation=True)` — **never produced live** |
| other | silently dropped |

**Side mapping caveats** (`crypcodile_replay.py` L56–68, L76–83): trade aggressor uses BUY/SELL; book delta maps cryp buy/sell → BID/ASK. Default on unknown is `Side.BUY` (can mis-tag).

**Timestamps:** all crypcodile conversions use `local_ts` only; **`receive_timestamp` always defaults to `0.0`** → latency UI in heatmap is wrong/zero for this feed.

### 2.3 Threading vs Qt main thread

- Worker lives in `QThread`; asyncio loop created in `start()` (L112–116).
- Queue puts are thread-safe; main thread drains in `_gui_tick` (`main_window.py` L895–926, limit 1000).
- Signals (if used) rely on Qt queued connections — OK.
- **`stop()` is invoked from main thread** while loop runs in worker thread — intentional via `run_coroutine_threadsafe`.
- Worker is **not** re-parented after `moveToThread`; only the thread gets `deleteLater` on `finished` (L250). Worker may leak until GC.
- `disconnect` wait is **2s** (L258); if loop does not exit, zombie thread + open sockets possible.
- Closing transport may not cancel `connector.run()` promptly depending on crypcodile internals (out of repo).

### 2.4 Failure modes

| Failure | Behavior | Risk |
|---------|----------|------|
| Import error | `on_error`, no connect | Handled |
| `make_connector` fails | `sig_error`, return | No reconnect |
| `connector.run()` raises | `sig_error` + `sig_disconnected` | **Feed dead until user restarts** |
| Network drop mid-run | Depends on crypcodile transport (not wrapped here) | No FlowMap-level backoff |
| Partial / unknown records | `_dispatch_record` returns `[]` | Silent data loss |
| Rate limits | Not handled in this file | Unknown / delegated |
| SSL off | MitM, cert bypass | Security + intermittent TLS edge cases |
| Unbounded queue | Producer never blocks | Memory growth under GUI stall |
| GUI drain cap 1000/tick | Backlog if burst > process rate | Latency spikes, eventual OOM |
| `subscribe` / `unsubscribe` | no-ops (L273–277) | Cannot change symbol without rebuild |

### 2.5 Connected-state race

`sig_connected` fires before WS is up (L164). UI may show connected while still connecting; if `run()` fails immediately, connected → disconnected flicker.

---

## 3. CCXT Provider (`crypto.py`)

### 3.1 WebSocket / connection lifecycle

| Phase | Behavior | Location |
|-------|----------|----------|
| Connect | Prefer WS unless `force_rest`; ImportError → REST | L387–400 |
| WS start | `_WsWorker` in `QThread`, asyncio loop | L423–450 |
| Exchange | `ccxt.pro.<exchange_id>(config)` | L179–187 |
| Connected | Emitted **before** any `watch_*` succeeds | L189 |
| Tasks | orderbook, trades, ticker, liquidations, sender_loop | L191–197 |
| Stop | `_running=False` + `exchange.close()` | L168–175, L452–459 |
| Disconnect wait | `wait(5000)` | L457 |
| Reconnect | Per-watcher `while self._running` + sleep 5s on error (liq: 10s) | L276–307, L253–274 |
| Auth | Optional `apiKey`/`secret`; `enableRateLimit: True`; `defaultType: spot` | L358–366 |
| Disconnected signal | **`sig_disconnected` never emitted** by `_WsWorker` | L128 defined, no emit |

REST mode: `QTimer` on provider (main thread), blocking `fetch_*` inside `_poll_tick` (L496–534).

### 3.2 Message parse paths

**Converters (L28–109):**

- `_ccxt_ts`: ms → s; missing → `time.time()`
- `_snapshot_from_ccxt`: depth-truncated bids/asks; skips falsy prices; sizes `is not None`
- `_bbo_from_ccxt`: top of book; empty → zeros
- `_trades_from_ccxt`: side map buy/sell; default buy
- `_bbo_from_ticker`: needs bid+ask; volumes from `bidVolume`/`askVolume` (often missing → 0)

**WS ingestion:**

1. `_watch_orderbook` → `_orderbook_buffer = ob` (latest only)
2. `_watch_trades` → `_trade_buffer.extend(...)`
3. `_watch_ticker` → `_ticker_buffer = ticker`
4. `_watch_liquidations` → trades with `is_liquidation=True` into trade buffer
5. `_sender_loop` every **0.03s (~33 Hz)** flushes trades + conflates OB/ticker (L204–251)

**No Level2Update path** — CCXT always full snapshots (depth N). Incremental L2 is Crypcodile-only.

**REST:** snapshot + bbo + last 20 trades per poll; network/rate errors → `on_error` (L530–534). Trades fetch failure swallowed (L517–518).

### 3.3 Threading vs Qt main thread

| Mode | Where work runs | UI hazard |
|------|-----------------|-----------|
| WS | Background QThread + asyncio | Safe if queue; signals auto-queued |
| REST | **`_poll_tick` on Qt timer thread (main)** | **Blocking HTTP freezes UI** |

Sender loop mutates buffers only inside the asyncio loop → no lock needed for single-thread asyncio. Cross-thread `stop()` uses `run_coroutine_threadsafe` like Crypcodile.

### 3.4 Failure modes

| Failure | Behavior | Risk |
|---------|----------|------|
| Unknown exchange | error emit, return | OK |
| watch_* exception | error + sleep 5s; loop continues | Soft reconnect; no exponential backoff |
| liquidations missing | early return if no capability | OK |
| liquidations error | bare `except`, sleep 10, **no error signal** | Silent |
| Rate limit | REST: caught; WS: depends on ccxt (enableRateLimit) | Possible storm after errors |
| Trade history replay on reconnect | ccxt.pro may redeliver recent trades | **Duplicate trades** |
| OB/ticker conflation by identity | see §5 | **Stale book after first emit** |
| Dual BBO sources | OB-derived + ticker both emit BBO | Flicker / thrash |
| WS receive_timestamp | **not set** in sender_loop | Latency always 0 for WS |
| Unbounded queue / drain 1000 | same as Crypcodile | Backlog |
| `subscribe` after connect | mutates `_symbols` list only; worker already started with snapshot of symbols | **Hot subscribe ineffective** |
| Multi-symbol | Only `_symbols[0]` watched | Extra symbols ignored |

### 3.5 CCXT / exchange-specific risks

1. **`defaultType: "spot"` hard-coded** — futures/perps wrong market for many exchanges.
2. **Symbol format** — `subscribe` normalizes `-` → `/` and uppercases; Crypcodile live uses raw exchange symbols (`SOLUSDT`). Switching sources without remapping breaks.
3. **Depth** — REST uses `fetch_order_book(symbol, depth)`; WS `watch_order_book(symbol)` **no limit** → may pull full book, more CPU/bandwidth.
4. **Kraken depth** config default 10 vs others 20 (`config.py`) — only applied via DataManager + CryptoProvider depth arg.
5. **Liquidations** not universal; implementation assumes list of dicts with trade-like fields.
6. **Coinbase/Kraken** symbol and rate profiles differ; no exchange-specific options beyond id.
7. **API keys** unused for public streams but stored in process memory if provided.
8. **`ccxt.pro` vs `ccxt.async_support`** naming/version drift can break import path.

---

## 4. Downstream coupling (queue consumer)

`main_window._gui_tick` (L895–959):

- Drains up to 1000 msgs/tick.
- Snapshot clears pending updates/bbos in the batch (L916–917).
- Trades batched via `record_trades` + `heatmap.add_trades`.
- Expects **single Trade objects** in queue (not lists).

**Implication for crypto WS queue mode:** sender puts trades one-by-one (L219–220) — OK.  
**Signal mode (no queue):** `sig_trade.emit(trades_to_emit)` emits a **list** (L222). `source_manager._on_provider_trade` handles list|Trade (L334–339). Any consumer that assumes always-`Trade` (e.g. raw DataManager proxy) can break.

---

## 5. Bug Hypotheses (prioritized)

### Critical / High

| ID | Hypothesis | Evidence | Severity |
|----|------------|----------|----------|
| **H1** | **CCXT orderbook conflation dead after first emit** — ccxt.pro mutates one order-book dict in place; `ob is not last_ob` fails after first assignment | `crypto.py` L224–235; same for ticker L238–246 | **Critical** — UI freezes on first book |
| **H2** | **No reconnect on Crypcodile live disconnect** — single `await connector.run()`; any failure ends session | `crypcodile_live.py` L166–173 | **High** — live feed dies permanently |
| **H3** | **REST polling blocks Qt main thread** | `crypto.py` L496–528 on QTimer | **High** — UI freezes under network latency |
| **H4** | **SSL verification disabled globally for all aiohttp WS** | `crypcodile_live.py` L100–108 | **High** (security + shared-process side effects) |
| **H5** | **`receive_timestamp` missing on live WS paths** — latency and time-aligned UI wrong | Crypcodile converters never set it; crypto sender_loop L227–245 omit it; only REST sets it L506–508 | **High** for latency features |

### Medium

| ID | Hypothesis | Evidence | Severity |
|----|------------|----------|----------|
| **H6** | **Live never emits BBO objects** — no `book_ticker` channel; BBO only if OrderBook derives from snapshots/deltas | `crypcodile_live.py` L151 vs `_dispatch_record` book_ticker | Medium |
| **H7** | **Live never marks liquidations** — channel not subscribed | L151 | Medium |
| **H8** | **False “connected” before sockets up** | crypcodile L164; crypto L189 | Medium — bad status UX / race |
| **H9** | **CCXT `sig_disconnected` never fired** — UI may stay “connected” after worker death | L128, gather ends without emit | Medium |
| **H10** | **Disconnect may leave zombie threads** — wait 2s/5s; no force-cancel of asyncio tasks; worker not `deleteLater` | crypcodile L253–260; crypto L452–459 | Medium — leak / double-start issues |
| **H11** | **Trade duplicates after CCXT WS reconnect** | watch_trades without since/id dedupe | Medium |
| **H12** | **Dual BBO (orderbook + ticker) thrash** | sender_loop L224–246 | Medium — jittery mid/spread |
| **H13** | **Unbounded queue growth** | producers never block; GUI cap 1000/tick | Medium under load |
| **H14** | **Hot symbol change no-op on live** | subscribe empty; WS symbols fixed at start | Medium |

### Lower

| ID | Hypothesis | Evidence | Severity |
|----|------------|----------|----------|
| **H15** | Signal-mode trade **list** vs **Trade** inconsistency | crypto L222 vs REST L528 vs crypcodile single Trade | Low if queue always used |
| **H16** | Default side BUY on missing/unknown side | `_SIDE_MAP.get(..., Side.BUY)` both files | Low — wrong CVD |
| **H17** | Snapshot filters `if p and s is not None` drops price `0` (unlikely) | crypto L41–42 | Low |
| **H18** | OKX market type not parameterized | only `region="global"` | Low–Med for non-spot |
| **H19** | `force_rest` fallback only on ImportError, not WS runtime failure | crypto L394–400 | Low–Med |
| **H20** | Worker `_running` unused in Crypcodile `_run` after connect | stop only closes transport | Low–Med graceful shutdown |
| **H21** | Liquidation bare except hides bugs | crypto L273–274 | Low |
| **H22** | No Level2Update from CCXT — full resnapshot only | by design | Info; denser apply_snapshot cost |

---

## 6. Lifecycle diagrams

### Crypcodile live

```
connect()
  → QThread.start → _LiveWorker.start
      → patch aiohttp ssl=False (once, process-global)
      → new_event_loop
      → make_connector + AiohttpWsTransport
      → sig_connected  ⚠️ early
      → await connector.run()
           ├ success forever until remote close/error
           └ except → sig_error → finally sig_disconnected
disconnect()
  → stop(): transport.close() (threadsafe)
  → thread.quit(); wait(2000)
  → clear refs; on_disconnected if was connected
```

### CCXT WS

```
connect()
  → _start_websocket
  → QThread → _WsWorker.start
      → ccxt.pro exchange
      → sig_connected  ⚠️ early
      → gather(watch_ob, watch_trades, watch_ticker, watch_liq, sender_loop)
           each watch_*: retry sleep 5s (liq 10s) while _running
disconnect()
  → stop(): exchange.close()
  → wait(5000)
  → ⚠️ never emits sig_disconnected from worker
```

---

## 7. Comparison matrix

| Concern | Crypcodile live | CCXT WS | CCXT REST |
|---------|-----------------|---------|-----------|
| Incremental L2 | Yes (`book_delta`) | No (full snap) | No |
| BBO channel | No (missing ticker sub) | Yes (ticker + derived) | Derived |
| Liquidations | No | Best-effort | No |
| Reconnect | No | Soft per-stream | Next poll |
| Rate limit aware | No (external) | enableRateLimit | Catch RateLimitExceeded |
| Auth | Public | Optional keys | Optional keys |
| UI thread safety | Queue preferred | Queue preferred | **Blocks main** |
| Conflation | None (every record) | 33 Hz + identity bug | Poll interval |
| receive_timestamp | Always 0 | Always 0 (WS) | Set |
| SSL | Disabled | Exchange/default | Default |

---

## 8. Recommended fix directions (for Phase 2+, not implementing here)

1. **H1:** Conflate by sequence/content or always treat buffer as dirty (`last_ob_seq` / copy snapshot / flag `_ob_dirty = True` on each watch).
2. **H2:** Wrap `connector.run()` in reconnect loop with backoff; emit disconnected only when giving up or on stop.
3. **H3:** Move REST fetches off main thread (reuse worker pattern).
4. **H4:** Remove global ssl=False; fix certs or per-connector SSL context with explicit opt-in.
5. **H5:** Set `receive_timestamp=time.time()` at ingress (`_on_record` / sender_loop / converters).
6. **H6/H7:** Add `book_ticker` + `liquidation` to live channels.
7. **H9:** Emit `sig_disconnected` in `_run` finally; cancel tasks on stop.
8. **H11:** Dedupe trades by `(id, symbol)` or use `newUpdates` / since filters if exchange supports.
9. **H12:** Prefer one BBO source (order book primary; ticker fallback only if no OB).
10. **H13:** Bound queue or drop conflate-friendly messages (keep last snapshot).

---

## 9. File:line index (quick reference)

### `crypcodile_live.py`
- L25–39 optional import  
- L42–56 `FlowMapLiveSink`  
- L62–196 `_LiveWorker` (signals, start/stop, run, on_record)  
- L100–108 SSL monkeypatch  
- L135–173 connector lifecycle  
- L175–196 parse/dispatch  
- L199–277 `CrypcodileLiveProvider`  

### `crypto.py`
- L28–109 converters  
- L117–307 `_WsWorker`  
- L204–251 sender/conflation (**H1**)  
- L253–307 watch loops  
- L315–534 `CryptoProvider`  
- L387–400 connect + fallback  
- L423–467 WS lifecycle  
- L471–534 REST polling (**H3**)  

### Shared parse
- `crypcodile_replay.py` L174–208 `_dispatch_record`  
- `crypcodile_replay.py` L86–171 type converters  

### Consumers
- `source_manager.py` L81–82 queue create; L278–322 live start; L334–339 trade list handling  
- `main_window.py` L895–959 queue drain  

---

## 10. Residual unknowns (need runtime / crypcodile source)

1. Does crypcodile `connector.run()` auto-reconnect internally?
2. Does `transport.close()` reliably unblock `run()`?
3. Exact in-place mutation guarantees per exchange in current ccxt.pro version (validate H1 with a live watch).
4. Whether `book_snapshot` arrives often enough live without `book_ticker` for usable BBO.
5. Production path: is CryptoProvider still used in UI, or only Crypcodile live? (`source_manager` DataSource enum only has REPLAY + LIVE; CryptoProvider imported but may be legacy via DataManager).

---

*End of R06 report.*
