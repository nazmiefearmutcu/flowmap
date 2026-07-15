# FIND-ERR-02

| Field | Value |
|-------|-------|
| **ID** | FIND-ERR-02 |
| **Severity** | P1 |
| **Status** | CONFIRMED |
| **Title** | EventBus swallows all handler / dispatcher exceptions with bare `pass` |
| **Location** | flowmap/core/events.py:44-47, 67-70, 76-79, 124-125 |
| **Taxonomy** | correctness |
| **Sibling** | R19 H1 |
| **Wave** | W3 |
| **Discovered by** | H-ERR (R19 Phase-3 hunter) |

### Repro
1. Subscribe a handler that raises, e.g. `bus.subscribe(EventType.SOURCE_CHANGED, lambda e: 1/0)`.
2. `bus.publish(Event(EventType.SOURCE_CHANGED, {}))`.
3. Observe: no log, no re-raise, no `EventType.ERROR` publish; other handlers continue if present.
4. Same for main-thread dispatch path: `MainThreadDispatcher._handle_dispatch` catches and `pass`es.

### Expected
- Handler failures are at least logged (`logging.exception`).
- Optionally publish `EventType.ERROR` (enum member exists) so UI/status can surface failures.
- Isolation preserved (one bad handler must not kill the bus), but not invisible.

### Actual
Four sites all use silent swallow:
```python
except Exception:
    pass  # Don't let one broken handler crash others
```
- L44-47: `_handle_dispatch`
- L67-70 / L76-79: dispatcher init failures
- L124-125: `publish()` per-handler
`EventType.ERROR` is defined (L28) but never published or subscribed anywhere under `flowmap/`.

### Fix hint
Replace `pass` with `logger.exception("EventBus handler failed: %s", handler)` (and similar for dispatch/init). Optionally `publish(Event(EventType.ERROR, {...}))` with a re-entrancy guard. Never leave production paths completely silent.

### Evidence
- Static read of `events.py` four `except Exception: pass` sites
- Package-wide grep: no `EventType.ERROR` usage outside enum definition
