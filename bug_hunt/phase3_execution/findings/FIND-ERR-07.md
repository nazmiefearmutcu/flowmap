# FIND-ERR-07

| Field | Value |
|-------|-------|
| **ID** | FIND-ERR-07 |
| **Severity** | P1 |
| **Status** | CONFIRMED |
| **Title** | GUI queue drain → order book → heatmap path has no defensive exception handling |
| **Location** | flowmap/ui/main_window.py:900-973; engine/density_engine.py (no try/except); core/order_book.py (no try/except) |
| **Taxonomy** | correctness, concurrency |
| **Sibling** | R19 H11 |
| **Wave** | W3 |
| **Discovered by** | H-ERR (R19 Phase-3 hunter) |

### Repro
1. Run app with any provider feeding `SourceManager.queue`.
2. Inject a malformed message or object that makes `apply_snapshot` / `record_trades` / `push_snapshot` raise (wrong type, NaN edge already separate, unexpected None levels).
3. `_process_queue` only catches `queue.Empty` around `get_nowait` (L911-926).
4. Processing block L937-970 is unprotected; exception escapes the Qt timer slot → traceback / potential freeze or hard abort.
5. `main.py` has no `sys.excepthook` / Qt message handler (R19 H15 related).

### Expected
- Per-message or per-batch try/except: log, skip bad payload, keep timer alive.
- Optional status-bar error once per error class (rate-limited).
- Engine continues rendering last good state.

### Actual
```python
while processed < limit and not q.empty():
    try:
        msg_type, obj = q.get_nowait()
        ...
    except queue.Empty:
        break
# NO try around:
self._order_book.apply_snapshot(...)
self.heatmap.push_snapshot(...)
```
`order_book.py` and `density_engine.py` assume well-formed inputs (0 defensive handlers in engine/).

### Fix hint
Wrap apply/push block in `try/except Exception` with `logger.exception` + status message; drop only the offending batch. Consider validating `msg_type` against known set. Add process-level excepthook in `main.py` as safety net (FIND-ERR-08 adjacent / H15).

### Evidence
- Static: only `queue.Empty` caught in `_process_queue`
- Grep: `engine/*` has 0 try/except sites (R19 inventory)
