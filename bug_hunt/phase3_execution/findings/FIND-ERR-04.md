# FIND-ERR-04

| Field | Value |
|-------|-------|
| **ID** | FIND-ERR-04 |
| **Severity** | P2 |
| **Status** | CONFIRMED |
| **Title** | Replay catalog / time-range queries fail silently (`pass` / empty returns, no `sig_error`) |
| **Location** | flowmap/data/crypcodile_replay.py:776-875 (`load_time_range`), 901-950 (`load_symbols`) |
| **Taxonomy** | data_source, input_ux |
| **Sibling** | R19 H3 |
| **Wave** | W3 |
| **Discovered by** | H-ERR (R19 Phase-3 hunter) |

### Repro
1. Point data_dir at a directory that opens as a client but has broken DuckDB tables / bad partitions.
2. UI calls `CrypcodileReplayProvider.load_symbols(data_dir)` or `load_time_range(data_dir, symbol)`.
3. Per-table query exceptions hit `except Exception: pass` (L819-820, 844-845, 874-875, 949-950).
4. Client open failure returns `[]` or `(None, None)` with no log (L778-779, 903-904).

### Expected
- Aggregate last error and surface once via `on_error`, status bar, or logger.
- Distinguish "no data in lake" from "query failed / corrupt catalog".

### Actual
All catalog paths degrade to empty UX with zero diagnostics:
| Path | On failure |
|------|------------|
| Client open | `(None, None)` / `[]` |
| SHOW TABLES | empty `registered` set |
| Per-table MIN/MAX/DISTINCT | `pass` |
No `sig_error`, no `print`, no logging. User concludes "no symbols / no range" when root cause is permissions, SQL, or corrupt lake.

### Fix hint
Keep soft-fail return values for API stability, but record `last_error` and log once; optional callback/`on_error` for UI. Surface a single status message: `"Catalog query failed: ..."`.

### Evidence
- Static: multiple `except Exception: pass` / silent returns in load_* static methods
