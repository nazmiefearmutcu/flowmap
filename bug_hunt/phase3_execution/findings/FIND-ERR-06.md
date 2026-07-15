# FIND-ERR-06

| Field | Value |
|-------|-------|
| **ID** | FIND-ERR-06 |
| **Severity** | P1 |
| **Status** | FIXED |
| **Title** | Crypcodile live: no reconnect after connector failure; stop does not await transport close |
| **Location** | flowmap/data/crypcodile_live.py:125-173, 147-158 |
| **Taxonomy** | data_source, concurrency |
| **Sibling** | R19 H8 |
| **Wave** | W3 |
| **Discovered by** | H-ERR (R19 Phase-3 hunter) |

### Repro
1. Start Crypcodile Live source against a real exchange.
2. Drop network or force `connector.run()` to raise mid-session.
3. Worker emits `sig_error` + `sig_disconnected` in `finally` of `_run` — but there is **no retry/reconnect loop**.
4. User must manually stop/start source; no "reconnecting…" UX.
5. On Stop: `stop()` schedules `transport.close()` via `run_coroutine_threadsafe` without awaiting Future; disconnect may `thread.wait(2000)` then abandon loop.

### Expected
- Outer retry with backoff for transient WS failures; status "reconnecting…".
- Graceful stop awaits close with timeout, then cancels loop.
- Connector create failure already emits error (OK) but should still ensure clean thread exit.

### Actual
```python
try:
    await connector.run()
except asyncio.CancelledError:
    raise
except Exception as e:
    self.sig_error.emit(f"Connector run error: {e}")
finally:
    self.sig_disconnected.emit()
# no retry
```
```python
def stop(self):
    self._running = False
    if self._loop and self._loop.is_running():
        if self._connector and self._connector.transport:
            asyncio.run_coroutine_threadsafe(
                self._connector.transport.close(), self._loop
            )  # fire-and-forget
```
Compare CCXT path which at least retries individual watch loops after sleep.

### Fix hint
Wrap `connector.run()` in `while self._running` with exponential backoff; surface reconnect state. In `stop()`, await the close Future with timeout then stop the loop. Close transport/connector in `start()` `finally`.

### Evidence
- Static: single `await connector.run()` with no outer loop
- Static: non-awaited `run_coroutine_threadsafe` in `stop()`
- Note: SSL global monkeypatch same file tracked separately as FIND-P218-01
