# P2-41 — SQL Symbol Injection / Quoting

| Field | Value |
|-------|-------|
| **Agent** | P2-41 |
| **Theme n** | 41 |
| **Track** | E (UX / security / packaging / harness) + D overlap |
| **Zones** | **Z13** (Paths / SQL / defaults) |
| **Siblings** | R05 H7, R02 §6.2, R20 P1-07, R15 H-15 |
| **Severity prior** | **P1** (local DuckDB → limited blast; still P0-class if symbol is attacker-controlled UI text) |
| **Focus** | f-string SQL with unsanitized `symbol` / `date` |

---

## 1. Scope & linked zones / sibling hyps

### In scope
- All DuckDB / Catalog SQL that interpolates **symbol** or **date** via f-string / `.format` / `%`.
- Standalone replay: `/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py`
- Crypcodile embed hist: `/Users/nazmi/Crypcodile/src/crypcodile/gui/flowmap_window.py`
- Any diagnostic scripts that copy the same pattern (`scratch/check_prices.py`, etc.)

### Out of scope
- Replay time-warp / price rewrite (P2-39, P2-40)
- Path hardcoding alone (P2-47) — except as vector that loads attacker lake + attacker symbol

### Sibling anchors

| ID | Claim | Location |
|----|-------|----------|
| R05 H7 | `WHERE symbol = '{symbol}'` fragile / injectable | `crypcodile_replay.py` ~295, 320–321, 810, 837, 865, 935, 944 |
| R02 | Embed `SELECT max(local_ts)... WHERE symbol = '{symbol}'` | `flowmap_window.py` ~110 |
| R20 P1-07 | SQL f-string symbol | prioritization |
| R15 H-15 | Known issue class | history |

### Exact code surfaces (verify line drift in Phase 3)

```text
crypcodile_replay.py
  f"SELECT MIN(local_ts), MAX(local_ts) FROM trade WHERE symbol = '{symbol}'"
  f"SELECT AVG(price) FROM trade WHERE symbol = '{symbol}'"
  f"SELECT AVG(b.price) FROM (SELECT unnest(bids)... WHERE symbol = '{symbol}')"
  f"SELECT MIN(local_ts) FROM {table} WHERE date = '{date}' AND symbol = '{symbol}'"
  f"SELECT MAX(local_ts) FROM {table} WHERE date = '{date}' AND symbol = '{symbol}'"
  f"SELECT DISTINCT symbol FROM {channel} WHERE date = '{latest_date}' LIMIT 1000"
  f"SELECT DISTINCT symbol FROM {channel} LIMIT 1000"   # channel may also be fixed enum — audit

flowmap_window.py
  f"SELECT max(local_ts) as max_t FROM trade WHERE symbol = '{symbol}'"
```

Also audit: whether `table` / `channel` / `date` are user-influenced or hard-coded enums only.

---

## 2. Threat model

| Actor | Capability | Goal |
|-------|------------|------|
| Trader typing symbol | Free-text Symbol field | Accidental `'` breaks query → empty hist / wrong range |
| Malicious plugin (if wired later) | Sets symbol programmatically | Inject SQL against local DuckDB lake |
| Shared machine / multi-tenant lake | Writes parquet + crafts symbol strings | Read other partitions if views allow |
| Embed CLI | Passes `--symbol` into FlowmapWindow | Same as UI |

**Blast radius (honest):** DuckDB is **local file**, not remote RDBMS. Risk is primarily:
1. **Correctness** — query fails or returns wrong rows silently (`except: pass` patterns).
2. **DoS** — expensive crafted SQL if injection reaches full statement control.
3. **Data exfil within lake** — if injection can UNION other tables/channels.
4. **Future** — if Catalog ever points at remote DuckDB / MotherDuck, becomes classic SQLi.

**Assumptions to break:**
- “Symbol is always `EXCHANGE:PAIR` alphanumeric” — **false** (UI free-text).
- “Exceptions swallow bad SQL safely” — leaves empty history, wrong `end_ns`, silent empty replay.

---

## 3. Concrete probes

### 3.1 Static (unit of work 1)

```bash
rg -n "WHERE symbol|f[\"'].*SELECT|query\(|\.query\(" \
  /Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py \
  /Users/nazmi/Crypcodile/src/crypcodile/gui/flowmap_window.py \
  /Users/nazmi/flowmap/scratch --glob '*.py'
```

Build inventory table: file, line, interpolated vars, catch-all try/except?, parameterized alternative available?

### 3.2 Unit — quote breakage (correctness)

```python
# tests/test_sql_symbol_quoting.py (Phase 3 create)
symbols = [
    "BTCUSDT",
    "binance-spot:SOLUSDT",
    "O'Brien",           # classic quote break
    "x'; DROP TABLE trade; --",  # injection attempt
    "SOL'; SELECT 1; --",
    "",
    "a" * 500,
    "SOL\x00USDT",
    "solusdt",           # case mismatch vs lake
]
for sym in symbols:
    # Call get_time_range / load_symbols paths with mock client
    # Assert: no uncaught exception OR controlled ValueError;
    # never multi-statement execution if DuckDB allows it
```

### 3.3 Dynamic — real lake + evil symbol in UI

1. Launch FlowMap with valid data_dir.
2. SETTINGS → Enable Replay Mode.
3. Symbol = `test';SELECT 1--` commit (Tab).
4. Start replay.
5. Observe: status error vs hang vs empty loop spin (R05 H3).

### 3.4 Embed path

1. Invoke Crypcodile flowmap with `initial_symbol` containing `'`.
2. `load_historical_data` should not leave process with corrupted Catalog connection.
3. Compare `end_ns` when query fails vs `time.time_ns()` fallback (code uses wall clock on except).

### 3.5 Differential — parameterized rewrite oracle

For each SQL site, rewrite to DuckDB prepared / `?` binding or proper escaping helper used by Catalog elsewhere. Diff result sets on golden symbols from real lake.

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| SQL-P1 | All symbol inputs either bind-parameterized or validated against `^[A-Za-z0-9_.:\-]+$` | Any f-string remains for user-influenced symbol |
| SQL-P2 | Symbol with `'` does not throw uncaught; UI shows error or rejects | Silent empty data or crash |
| SQL-P3 | Injection payload cannot change statement shape (extra SELECT/UNION) | Multi-statement / schema read beyond intended channel |
| SQL-P4 | `date`/`channel` only from enum/path scan, not UI | User can influence `channel` string |
| SQL-P5 | Embed + standalone share one sanitizer | Drift: one fixed, one not |

---

## 5. Fixtures needed

| Fixture | Source |
|---------|--------|
| Mini DuckDB lake with one trade + book_delta for `SOLUSDT` | Copy subset of `/Users/nazmi/data` or synthetic parquet |
| Symbol corpus JSON | `fixtures/evil_symbols.json` |
| Mock `CrypcodileClient.query` capturing SQL strings | Unit without lake |
| Golden expected empty-range behavior | Document: empty → no spin (coord with P2-39 empty-loop) |

---

## 6. Phase-3 agent micro-tasks (3–5 hunts)

| Hunt | Agent hint | Work |
|------|------------|------|
| **H-41A** | Static mapper | Full inventory + line table of every interpolating SQL |
| **H-41B** | Breaker | Unit tests: quote / injection / empty / long / null |
| **H-41C** | UI dynamic | CUA: type evil symbols in replay + live; screenshot status |
| **H-41D** | Embed | `flowmap_window.load_historical_data` with evil symbol + mock Catalog |
| **H-41E** | Fix prep | Propose single `quote_ident` / `bind_symbol` helper + call-site list |

---

## 7. Expected finding IDs

Format: **`FIND-P241-XX`**

| ID | Sev prior | Title |
|----|-----------|-------|
| FIND-P241-01 | P1 | Replay worker f-string symbol in MIN/MAX trade range |
| FIND-P241-02 | P1 | AVG price / unnest bid SQL f-string |
| FIND-P241-03 | P1 | `get_time_range` date+symbol f-strings |
| FIND-P241-04 | P1 | `load_symbols` DISTINCT f-string |
| FIND-P241-05 | P1 | Embed hist `max(local_ts)` f-string |
| FIND-P241-06 | P2 | Silent `except` hides SQL syntax errors → wrong end_ns |
| FIND-P241-07 | P2 | `channel`/`table` string concat if ever non-enum |

---

## 8. Fix strategy sketch (no code yet)

1. **Centralize** `safe_query(client, sql_template, params)` or Catalog API that only accepts bound params.
2. **Validate** UI symbols: reject characters outside allowlist before any SQL.
3. **Escape fallback** if binding unavailable: double-single-quote for SQL string literals only (not for identifiers).
4. **Never** interpolate `channel`/`table` from user; map enum → fixed SQL fragments.
5. **Surface** SQL failures to status bar (coord with R19 error handling).
6. Regression tests in H-41B become permanent gate.

---

## 9. Dependencies on other themes

| Theme | Relation |
|-------|----------|
| P2-38 Catalog empty/partial | Empty result after bad SQL looks like missing channel |
| P2-39/40 Replay design | Same file; don’t mix rewrite logic with SQL fix |
| P2-42 API drift | Embed vs standalone query sites must both be fixed |
| P2-47 data_dir | Which lake is queried |
| P2-04 BookDelta bootstrap | Empty range after broken symbol query |

**Blocks:** none. **Blocked by:** none (static hunt can start Day 1).

---

## 10. Severity priors (Phase 1)

| Source | Sev |
|--------|-----|
| R05 H7 | MEDIUM → treat **P1** |
| R20 P1-07 | P1 |
| Local DuckDB | Not remote RCE; still ship + correctness P1 |
| If plugins later set symbol | elevates toward **P0** with P2-46 |

**Phase-3 default severity for confirmed open f-string sites: P1; for demonstrated multi-statement: P0.**
