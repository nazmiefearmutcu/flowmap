# FIND-ERR-01

| Field | Value |
|-------|-------|
| **ID** | FIND-ERR-01 |
| **Severity** | P0 |
| **Status** | FIXED |
| **Title** | Replay client-open / early-return leaves `_running` True and never emits `sig_finished` |
| **Location** | flowmap/data/crypcodile_replay.py:261-279, 693-705, 956-958 |
| **Taxonomy** | concurrency, data_source |
| **Sibling** | R19 H7 |
| **Wave** | W3 |
| **Discovered by** | H-ERR (R19 Phase-3 hunter) |

### Repro
1. Point replay `data_dir` at a path that makes `CrypcodileClient(...)` raise (missing lake, corrupt, permission).
2. Enable Replay Mode → select symbol → Start.
3. Observe status bar may show `Error: Failed to open CrypcodileClient: ...`.
4. Inspect provider: `_replaying` remains `True`; worker `_running` remains `True`.
5. Press Start again: `start_replay` calls `stop_replay` because `_replaying`, but worker never entered the outer `finally` that emits `sig_finished`.

Alternate early path (same stuck provider state):
1. Import fails so `_CRYPCODILE_AVAILABLE` is False.
2. Worker `start_replay` emits error and `return`s at L261-265 without `sig_finished`.
3. Provider set `_replaying = True` at L693 before thread start → never cleared via `_on_replay_finished`.

### Expected
- Every worker exit path clears `_running` and emits `sig_finished`.
- Provider `_replaying` always returns to `False` after error.
- User can retry start without stuck state / awkward stop.

### Actual
```python
self._running = True
try:
    self._client = CrypcodileClient(data_dir=self._data_dir)
except Exception as exc:
    self.sig_error.emit(f"Failed to open CrypcodileClient: {exc}")
    return   # ← no _running=False, no sig_finished
```
The `finally` that does `self._running = False; self.sig_finished.emit()` only wraps the main loop (~L331-547). Client-open failure and crypcodile-unavailable returns skip it. Provider `_replaying` is set True before worker start and only cleared on `sig_finished` / `stop_replay`.

### Fix hint
Wrap entire `start_replay` body after setting `_running=True` in `try/finally` that always clears `_running` and emits `sig_finished`. Also emit finished (or clear `_replaying` on error path) for the `_CRYPCODILE_AVAILABLE` early return. Prefer provider-side: connect `sig_error` to a path that clears `_replaying` if not already finished.

### Evidence
- Static: early `return` at L279 vs `finally` at L545-547
- Static: `self._replaying = True` at L693 before `sig_finished` wired at L705
- Contrast: invalid time-range path L282-288 correctly clears `_running` and emits `sig_finished`
