# R19 — Error Handling & Resilience Audit

**Scope:** `/Users/nazmi/flowmap/flowmap`  
**Date:** 2026-07-13  
**Agent:** R19 (Phase 1 research)

---

## Summary

FlowMap has **partial** error plumbing: data providers generally emit `on_error` / `sig_error` strings, and `SourceManager._on_provider_error` surfaces them as a status-bar message. However:

| Area | Status |
|------|--------|
| Bare `except:` | **None found** (good) |
| Broad `except Exception` | **~42 sites** — many silent or print-only |
| Structured logging | **Almost none** (`logging` only in `crypcodile_live.py`) |
| User-facing errors | Status bar only; no dialog / no `EventType.ERROR` usage |
| Network recovery | CCXT watch loops retry; Crypcodile **live has no reconnect** |
| Resource cleanup on error | Gaps: DuckDB clients, WS gather cancel, live transport |
| Production `assert` | **None found** (good) |
| Top-level crash handler | **None** in `main.py` |

---

## Inventory

### Exception handling by module

| File | try/except count (approx) | Pattern |
|------|---------------------------|---------|
| `data/crypcodile_replay.py` | 14+ | Mixed: `sig_error` vs `print` vs bare `pass` |
| `data/crypto.py` | 12+ | Good: `sig_error` + sleep retry; liquidations silent |
| `data/crypcodile_live.py` | 6 | Good emit; **no retry**; SSL monkeypatch |
| `core/events.py` | 5 | **All swallowed with `pass`** |
| `plugins/loader.py` | 2 | stderr + traceback (good isolation) |
| `plugins/plugin_api.py` | 5 | Rate-limited stderr log (good) |
| `ui/source_manager.py` | 6 | Init → status bar; stop → **silent swallow** |
| `ui/heatmap_widget.py` | 2 | render fallback then re-raise |
| `ui/main_window.py` | 3 | `queue.Empty`, `ValueError` only |
| `engine/*` | 0 | No defensive handling |
| `core/order_book.py` | 0 | Assumes valid inputs |
| `core/config.py` | 0 | File I/O unguarded |
| `main.py` | 0 | No global hook |

### Bare except
- **None.** All catches name at least `Exception` or a specific type.

### Logging vs print
- **`logging`:** only `crypcodile_live.py` (`log = logging.getLogger(__name__)`).
- **`print` / stderr:** plugins, replay worker, source_manager DEBUG, heatmap backend choice, heatmap_renderer debug paint.
- No app-wide log config, levels, or file sink.

### `raise` usage
- `data/base.py` — `NotImplementedError` on abstract API (expected).
- `crypcodile_live.py:169` — re-raises `CancelledError` (correct).
- `heatmap_widget.py:1125` — re-raises after failed OpenGL grab fallback.

### `assert` in production code
- **None** under `flowmap/`.

---

## 1. Swallowed exceptions

### H1 — EventBus silently drops all handler failures (P1)

**File:** `core/events.py`  
**Lines:** 44–47, 67–70, 76–79, 124–125

```python
except Exception:
    pass  # Don't let one broken handler crash others
```

- `_handle_dispatch`, dispatcher init, and `publish()` all swallow every exception with **no log**.
- A broken subscriber (e.g. GUI update) fails **invisibly**; other handlers continue, so the app looks “alive” while UI/state is wrong.
- `EventType.ERROR` exists but is **never published or subscribed** anywhere in the package.

**Impact:** Silent correctness bugs; undebuggable production failures.  
**Fix hint:** Log + optional `EventType.ERROR` publish; never bare-pass without at least `logging.exception`.

---

### H2 — `SourceManager.stop_current` swallows disconnect failures (P1)

**File:** `ui/source_manager.py`  
**Lines:** 185–191

```python
try:
    _disconnect_provider_signals(...)
    ...
    self._provider.disconnect()
except Exception:
    pass
```

- Thread/WS/file cleanup failures disappear.
- Queue drain also uses broad `except Exception: break` (196–200) — any unexpected error aborts drain and may leave stale messages.

**Impact:** Stuck threads, half-open WS, zombie providers after source switch.  
**Fix hint:** Log exception; always null `_provider` in `finally`; consider force-quit thread with timeout metrics.

---

### H3 — Replay catalog/time-range queries: silent `pass` (P2)

**File:** `data/crypcodile_replay.py`  
**Lines:** 778–820, 844–845, 874–875, 903–910, 949–950

- `load_time_range` / `load_symbols`: client open failure → `(None, None)` / `[]`.
- Per-table DuckDB/query failures → `pass`.
- No `sig_error`, no log — UI may show empty symbol list or “no range” with no explanation.

**Impact:** User thinks “no data” when the real issue is corrupt lake, missing tables, or query error.  
**Fix hint:** Aggregate last error; surface once via `on_error` or status message.

---

### H4 — Liquidation stream errors fully silent (P2)

**File:** `data/crypto.py`  
**Lines:** 273–274

```python
except Exception:
    await asyncio.sleep(10)
```

- Order book / trades / ticker emit `sig_error` on failure; liquidations do **not**.
- Feature can die for minutes with no UX.

---

### H5 — REST trade fetch failure ignored (P3)

**File:** `data/crypto.py`  
**Lines:** 513–517

- `fetch_trades` failure → `pass`; book still updates.
- Acceptable degradation, but no log → hard to diagnose “heatmap moves, no bubbles”.

---

### H6 — Trade-range / price-alignment errors print-only (P2)

**File:** `data/crypcodile_replay.py`  
**Lines:** 300–301, 328–329, 384–385

- Failures use `print(f"[REPLAY_WORKER] ...")` not `sig_error`.
- Replay continues with wrong/missing alignment; user sees bad trade prices, no error UX.

---

## 2. Bare excepts

**Finding:** No bare `except:` clauses.  
Broad `except Exception` is the dominant anti-pattern instead (see above).

---

## 3. Error UX — informed vs silent fail

### What works
| Path | UX |
|------|-----|
| Provider `on_error` → `SourceManager._on_provider_error` | Status bar: `Error: {msg}` (`source_manager.py:357–358`) |
| Replay/live init exceptions | Status bar + `traceback.print_exc()` |
| Missing Crypcodile package | `on_error` with install hint |
| Plugin load/register failure | stderr + traceback (not GUI) |
| Plugin runtime callbacks | Rate-limited stderr (`plugin_api._log_plugin_error`) |
| ccxt.pro missing | `on_error` + REST fallback |

### Gaps
| Path | UX gap |
|------|--------|
| EventBus handler errors | **Silent** |
| `stop_current` cleanup | **Silent** |
| Replay query failures | **Silent** or console-only |
| Live disconnect after crash | Status may show error once; **no reconnect UI** |
| Engine/paint/order_book crashes | **Propagate to Qt** → possible hard crash |
| `main.py` uncaught | Default Python traceback only |
| Plugin failures | stderr only if user launched from terminal |
| `EventType.ERROR` | Defined, **unused** |

**Severity pattern:** Errors on **background provider threads** often reach status bar; errors on **main-thread GUI/engine** paths and **event bus** often do not.

---

## 4. Resource cleanup on except paths

### H7 — Replay worker early return skips `sig_finished` / leaves `_running` (P0/P1)

**File:** `data/crypcodile_replay.py`  
**Lines:** 271–279 vs 543–547

```python
self._running = True
try:
    self._client = CrypcodileClient(...)
except Exception as exc:
    self.sig_error.emit(...)
    return   # ← no sig_finished, _running stays True
```

- Outer `finally` that clears `_running` and emits `sig_finished` is only around the main loop (from ~331).
- Client open failure path does **not** enter that `finally`.
- Provider `_replaying` is set `True` **before** worker starts (`start_replay` ~693) and cleared on `_on_replay_finished` — if `sig_finished` never fires, **replay state stuck**, further `start_replay` may call `stop_replay` awkwardly.

**Also:** `_client` is never explicitly closed on any path (no `client.close()` / context manager). Depends on GC / DuckDB handle release → possible FD/handle leak under repeated replays.

---

### H8 — Live worker: incomplete teardown (P1)

**File:** `data/crypcodile_live.py`

| Path | Issue |
|------|--------|
| `start()` finally | Closes event loop; does **not** always close connector/transport |
| `stop()` | Schedules `transport.close()` via `run_coroutine_threadsafe` but **does not await** or check result |
| `disconnect()` | `thread.wait(2000)` then nulls refs — may abandon running loop after 2s |
| Connector create fail | Returns after `sig_error`; OK for connected flag (never set) |
| `connector.run()` error | Emits error + `sig_disconnected`; **no reconnect** |

**SSL monkeypatch (99–110):** Global patch `aiohttp.ClientSession.ws_connect` with `ssl=False`. Failure is logged (good). Success weakens TLS for **all** aiohttp in process (security + hard-to-debug side effects).

---

### H9 — CCXT WS stop / gather cleanup incomplete (P2)

**File:** `data/crypto.py`  
**Lines:** 198–202, 452–459

- `_run` cancels tasks only on `CancelledError` from `gather`; individual watchers self-loop on errors (good).
- `stop()` fires `exchange.close()` without waiting for completion.
- `_stop_websocket`: `wait(5000)` then drops thread refs — same abandon risk as live.
- `sig_disconnected` is defined on worker but **never emitted** from `_WsWorker.start` failure path (only crash message via `sig_error`). Provider may stay `_connected=True` until external disconnect.

---

### H10 — Config I/O unguarded (P3)

**File:** `core/config.py`  
**Lines:** 40–48

- `from_json`: no `OSError` / `JSONDecodeError` handling → crash on bad path/JSON.
- `to_json`: partial `makedirs`; write errors propagate.

---

## 5. Network / file error recovery

### CCXT (`crypto.py`) — **partial recovery**
- Watch loops: emit error → `await asyncio.sleep(5)` → retry while `_running`.
- Liquidations: silent sleep 10s.
- REST poll: emit `on_error`, timer continues → implicit retry each tick.
- No exponential backoff, no max-retry, no circuit breaker.
- No automatic WS→REST failover if WS dies mid-session (only at connect if import fails).

### Crypcodile Live — **no recovery**
- Single `await connector.run()`; any exception → error signal + disconnect emit.
- No retry loop, no backoff.
- Live UX depends entirely on user restarting source.

### Crypcodile Replay — **fail then stop / or soft-degrade**
- Book replay start fail → `sig_error` + `break` out of while → `finally` finished (good).
- Trade load fail → print, continue without trades (soft degrade).
- Auto-loop on natural end (while `_running`) — resilience for demo, can surprise if data corrupt.

### File / data lake
- Missing data dir → empty symbols / None range, often **silent**.
- SQL built with f-string symbol (`WHERE symbol = '{symbol}'`) — not classic exception handling, but bad input can break queries → caught as empty/pass (H3).

---

## 6. Crash-prone paths

### H11 — Unprotected hot path: GUI queue drain → order book / heatmap (P1)

**File:** `ui/main_window.py` ~910–970  
**Engine:** `engine/density_engine.py` (no try/except)

- `_process_queue` only catches `queue.Empty`.
- Malformed records, unexpected types, or engine bugs in `apply_snapshot` / `push_snapshot` / paint **crash the Qt timer callback** → freezes or hard abort.
- `order_book.py` and density engine assume well-formed tuples/arrays; no validation on `price`/`size`.

### H12 — CCXT trade conversion KeyError (P2)

**File:** `data/crypto.py`  
**Lines:** 83–87

```python
price=float(t["price"]),  # KeyError if missing
```

- Called inside watch loop’s broad `except Exception` → reconnect after 5s, but emits stream error; still noisy.
- Polling path: trade list built after silent fetch fail is empty — OK.

### H13 — Heatmap `render()` re-raises after fallback (P2)

**File:** `ui/heatmap_widget.py`  
**Lines:** 1103–1125

- Tries OpenGL grab fallback; on failure `raise e`.
- Can crash export/screenshot paths; paintEvent itself is not wrapped.

### H14 — Color system empty control points (P3)

**File:** `engine/color_system.py`  
**Lines:** 78–81 etc.

- Uses `control_points[0]` / `[-1]` without empty-list guard.
- Safe if schemes always non-empty; plugin/custom scheme could IndexError.

### H15 — No global excepthook / Qt message handler (P2)

**File:** `main.py`

- Uncaught exceptions in slots may kill app or print only.
- No user dialog, no log file for post-mortem.

### H16 — Debug noise in production paths (P3)

**Files:** `ui/source_manager.py` (print stack on every `_running` set), `heatmap/heatmap_renderer.py` debug paint prints, replay prints.

- Not crash bugs, but can hide real errors and hurt performance; stderr flood under load.

---

## Hypotheses ranked by severity

| Rank | ID | Severity | Title | Location |
|------|-----|----------|-------|----------|
| 1 | H7 | **P0–P1** | Replay client-open failure: no `sig_finished`, `_running` stuck; possible permanent “replaying” | `crypcodile_replay.py:271–279` |
| 2 | H8 | **P1** | Live feed: no reconnect; stop/disconnect may abandon threads; global SSL disable | `crypcodile_live.py` |
| 3 | H1 | **P1** | EventBus swallows all subscriber exceptions without log | `events.py:46,69,78,124` |
| 4 | H2 | **P1** | `stop_current` swallows provider disconnect errors | `source_manager.py:185–191` |
| 5 | H11 | **P1** | Queue→order book→heatmap path has no defensive catch | `main_window.py`, `order_book.py`, `density_engine.py` |
| 6 | H9 | **P2** | WS worker disconnect signal / close wait incomplete | `crypto.py` |
| 7 | H3 | **P2** | Silent catalog/query failures → empty UX | `crypcodile_replay.py` load_* |
| 8 | H6 | **P2** | Replay alignment errors console-only → wrong trade prices | `crypcodile_replay.py:300–385` |
| 9 | H4 | **P2** | Liquidation stream silent fail | `crypto.py:273–274` |
| 10 | H15 | **P2** | No process-level exception / logging strategy | `main.py`, package-wide |
| 11 | H12 | **P2** | Fragile CCXT trade key access | `crypto.py:86` |
| 12 | H13 | **P2** | Heatmap render re-raise | `heatmap_widget.py:1125` |
| 13 | H10 | **P3** | Config JSON I/O unguarded | `config.py` |
| 14 | H5 | **P3** | REST trades fail silent | `crypto.py:516–517` |
| 15 | H14 | **P3** | Color map empty-list IndexError risk | `color_system.py` |
| 16 | H16 | **P3** | Debug prints / stack dumps in hot paths | `source_manager.py`, renderer |

---

## Positive patterns (keep / extend)

1. **Provider signal contract** (`on_error: pyqtSignal(str)`) is consistent across base/manager/crypto/live/replay.
2. **Plugin isolation** — load and per-callback try/except with rate-limited traceback (`plugin_api.py`, `loader.py`).
3. **CCXT stream loops** retry after sleep rather than dying (except liquidations).
4. **Import soft-deps** — Crypcodile / QOpenGLWidget / ccxt.pro degraded with messages.
5. **No bare except, no production asserts.**
6. **Queue drain on stop** intent is correct (implementation should not swallow all exceptions).

---

## Recommended fix themes (for Phase 2+)

1. **Central logging** — `logging` config in `main.py`; replace silent `pass` and most `print` with `logger.exception` / `warning`.
2. **Finish contracts** — every worker path that sets “running/replaying” must clear it in `finally` and emit finished/disconnected.
3. **Live reconnect policy** — outer retry loop with backoff; surface “reconnecting…” in status bar.
4. **Never swallow without log** — EventBus, `stop_current`, replay catalog queries.
5. **GUI hot-path guard** — try/except around `_process_queue` body; emit status/error, skip bad message, don’t kill timer.
6. **Resource context managers** — close CrypcodileClient / exchange / transport in `finally`; await close with timeout.
7. **Wire `EventType.ERROR`** or drop dead enum member.
8. **Remove or gate** SSL global monkeypatch; use per-session SSL context.
9. **Strip DEBUG** stack prints from `_running` setter before release builds.

---

## File path index (absolute)

- `/Users/nazmi/flowmap/flowmap/core/events.py`
- `/Users/nazmi/flowmap/flowmap/core/config.py`
- `/Users/nazmi/flowmap/flowmap/core/order_book.py`
- `/Users/nazmi/flowmap/flowmap/data/crypto.py`
- `/Users/nazmi/flowmap/flowmap/data/crypcodile_live.py`
- `/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py`
- `/Users/nazmi/flowmap/flowmap/data/manager.py`
- `/Users/nazmi/flowmap/flowmap/data/base.py`
- `/Users/nazmi/flowmap/flowmap/plugins/loader.py`
- `/Users/nazmi/flowmap/flowmap/plugins/plugin_api.py`
- `/Users/nazmi/flowmap/flowmap/ui/source_manager.py`
- `/Users/nazmi/flowmap/flowmap/ui/main_window.py`
- `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py`
- `/Users/nazmi/flowmap/flowmap/engine/density_engine.py`
- `/Users/nazmi/flowmap/flowmap/engine/color_system.py`
- `/Users/nazmi/flowmap/flowmap/main.py`

---

## Methodology

- ripgrep over `flowmap/**/*.py` for: `try`/`except`/`raise`/`assert`/`logging`/`print(`/`pass`/`finally`/`on_error`/`reconnect`
- Manual read of all exception-dense modules (events, crypto, live, replay, source_manager, plugin_*, main_window queue path)
- Cross-check UX path: `sig_error` → `on_error` → `_on_provider_error` → status bar only
- No runtime execution in this phase
