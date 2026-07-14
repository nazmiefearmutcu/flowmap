# FIND-ERR-03

| Field | Value |
|-------|-------|
| **ID** | FIND-ERR-03 |
| **Severity** | P1 |
| **Status** | CONFIRMED |
| **Title** | `SourceManager.stop_current` swallows disconnect failures and aborts queue drain on any exception |
| **Location** | flowmap/ui/source_manager.py:183-203 |
| **Taxonomy** | concurrency, data_source |
| **Sibling** | R19 H2 |
| **Wave** | W3 |
| **Discovered by** | H-ERR (R19 Phase-3 hunter) |

### Repro
1. Start any live/replay/sim provider so `_provider` is non-None and queue may hold messages.
2. Force `disconnect()` / `stop_replay()` to raise (broken thread state, already-deleted QObject, etc.) — or inject a raising mock.
3. Call `stop_current()` (source switch or Stop).
4. Exception is discarded; UI flips to stopped (`_running = False`) while teardown may be incomplete.

Queue-drain path:
1. If `task_done()` is called more times than `get`s, or any unexpected error occurs in drain loop.
2. Broad `except Exception: break` aborts remaining drain → stale messages may later apply after "stop".

### Expected
- Disconnect/stop failures logged and preferably surfaced once on status bar.
- `_provider` nulled in `finally` regardless (currently null only after try; if assignment before raise were reordered this would matter — today null is after try, so OK if no raise between).
- Queue drain should only break on empty-queue semantics, not arbitrary exceptions.

### Actual
```python
try:
    _disconnect_provider_signals(...)
    if hasattr(self._provider, 'stop_replay'):
        self._provider.stop_replay()
    self._provider.disconnect()
except Exception:
    pass
self._provider = None
# ...
while not self._queue.empty():
    try:
        self._queue.get_nowait()
        self._queue.task_done()
    except Exception:
        break
```
No log, no status message. Thread/WS cleanup failures are invisible → zombie providers after source switch.

### Fix hint
Log with `logger.exception` in disconnect `except`. Catch `queue.Empty` specifically in drain; log unexpected errors and continue or force `queue = Queue()` replacement. Always force-quit QThread with timeout metrics after failed disconnect.

### Evidence
- Static: L190-191 bare pass; L199-200 break-on-any-exception
