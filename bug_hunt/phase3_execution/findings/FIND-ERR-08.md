# FIND-ERR-08

| Field | Value |
|-------|-------|
| **ID** | FIND-ERR-08 |
| **Severity** | P2 |
| **Status** | CONFIRMED |
| **Title** | Replay trade-range / price-alignment / trade-load errors are print-only (no `sig_error`) |
| **Location** | flowmap/data/crypcodile_replay.py:300-301, 328-329, 384-385 |
| **Taxonomy** | correctness, data_source |
| **Sibling** | R19 H6 |
| **Wave** | W3 |
| **Discovered by** | H-ERR (R19 Phase-3 hunter) |

### Repro
1. Replay a lake where trade table query fails or AVG(price) alignment query raises, but book replay succeeds.
2. Worker prints `[REPLAY_WORKER] Error checking trade range: ...` or price-alignment / trade-load errors to stdout only.
3. Replay continues: books paint, trades missing or unshifted → bubbles at wrong prices relative to book.
4. GUI status bar shows no error (only `sig_error` reaches `on_error` → status bar).

### Expected
- Soft-degrade is acceptable, but user must know alignment/trades failed.
- Emit `sig_error` (or a non-fatal warning channel) once so status bar shows the issue.
- Prefer logger over bare `print`.

### Actual
```python
except Exception as e:
    print(f"[REPLAY_WORKER] Error checking trade range: {e}")
# ...
except Exception as e:
    print(f"[REPLAY_WORKER] Price alignment calculation error: {e}")
# ...
except Exception as exc:
    print(f"[REPLAY_WORKER] Error loading trades: {exc}")
```
Contrast book-start failure (L343-345) which correctly uses `self.sig_error.emit(...)`.

Also: no global logging config / excepthook in `main.py` — print-only paths are invisible in packaged GUI (`console=False` builds).

### Fix hint
Use `self.sig_error.emit(...)` for these soft failures (or `sig_warning` if added). Replace `print` with `logging.getLogger(__name__).warning`. Document that missing trades is degraded mode.

### Evidence
- Static three print-only except sites vs book path using `sig_error`
- `main.py` has no logging setup / excepthook (R19 H15)
