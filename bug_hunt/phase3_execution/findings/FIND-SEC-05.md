# FIND-SEC-05

| Field | Value |
|-------|-------|
| **ID** | FIND-SEC-05 |
| **Severity** | P3 |
| **Status** | CONFIRMED |
| **Title** | EventBus is dead infrastructure; swallows all handler exceptions |
| **Theme / Zones** | Z01 architecture · secondary expand of R03 H-R03-15/16; R16 H7; R19 H1 |
| **Taxonomy** | integration (primary) · concurrency (latent) |
| **Location** | `flowmap/core/events.py:44–47`, `100–125`, `132–133`; export `flowmap/core/__init__.py:153` |
| **Sibling** | R03 H-R03-15, H-R03-16; R16 H7; R19 H1 |
| **Wave** | W secondary |
| **Discovered by** | phase3-hunter-sec |
| **Latent** | true (not on live market path today) |

### Problem

Two distinct event systems exist:

1. **Market path:** provider queue / Qt signals + `OrderBook.on_*` callbacks.  
2. **`EventBus`:** typed app lifecycle (`SOURCE_CHANGED`, `SIMULATION_*`, `SYMBOL_CHANGED`, …).

Repo-wide production usage of `bus.publish` / `bus.subscribe` is **none** outside `events.py` docstring examples. Singleton `bus = EventBus()` is still constructed at import.

If re-enabled later, hazards already present:

- `except Exception: pass` in `publish` and `MainThreadDispatcher._handle_dispatch` → silent handler failure (R19).  
- Worker publish with `main_thread=True` and no dispatcher / no `QCoreApplication` falls back to **running GUI handlers on the worker thread** (R16 H7).  
- Dual models invite future half-wiring (some modules on bus, MainWindow still on SourceManager signals).

### Repro

```bash
rg -n "bus\\.(publish|subscribe)|EventBus\\(" flowmap --glob '*.py'
# Expect: only events.py definitions/examples + core/__init__ re-export
```

```python
from flowmap.core.events import bus, Event, EventType

def boom(e):
    raise RuntimeError("handler broken")

bus.subscribe(EventType.ERROR, boom, main_thread=False)
bus.publish(Event(EventType.ERROR, {"m": "x"}))  # no raise, no log
```

### Expected

Either:

- Delete / quarantine unused EventBus until a single app event design is chosen, **or**  
- Wire lifecycle events consistently and log handler exceptions; never run `main_thread` handlers on worker fallback.

### Actual

Dead export + silent exception swallowing + unsafe cross-thread fallback.

### Fix hint

Short term: log in `except` with `logger.exception`. Medium: remove unused singleton from import path or mark deprecated. If kept: require dispatcher; drop events when main-thread dispatch impossible instead of calling handler on BG.

### Evidence

- Grep: no `bus.publish`/`subscribe` in `flowmap/ui`, `flowmap/data`, `flowmap/engine`.  
- R03 §6.4–6.5; R16 EventBus residual risk; R19 H1.  
- Import-time singleton: `events.py:133`.
