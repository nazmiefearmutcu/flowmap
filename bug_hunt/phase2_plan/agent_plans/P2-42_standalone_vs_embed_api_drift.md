# P2-42 — Standalone vs Embed API Drift

| Field | Value |
|-------|-------|
| **Agent** | P2-42 |
| **Theme n** | 42 |
| **Track** | D/E — Integration |
| **Zones** | **Z12** (Crypcodile hist preload) |
| **Siblings** | R02, R14, R05, R20 critical path Z12 |
| **Severity prior** | **P0–P1** (dual converters → silent wrong book/trades) |
| **Focus** | Dual converters, path inject, hist vs live pipeline, test gaps |

---

## 1. Scope & linked zones / sibling hyps

### Dual codebases

| Surface | Path |
|---------|------|
| Standalone app | `/Users/nazmi/flowmap` — `MainWindow`, `SourceManager`, `crypcodile_replay._dispatch_record` |
| Embed | `/Users/nazmi/Crypcodile/src/crypcodile/gui/flowmap_window.py` — subclass + hist preload |
| Converters | Embed `dict_to_flowmap_objects` vs standalone `_dispatch_record` |
| Tests | Crypcodile `tests/test_flowmap.py`, `tests/gui/test_flowmap_window.py`, `tests/gui/test_flowmap_gui_cua.py`; FlowMap `tests/test_bbo_pipeline.py` only |

### Sibling hyp map

| Hyp | Drift type |
|-----|------------|
| R02 dual conversion | delta-as-snapshot, side maps, liquidations |
| R02 path inject | `sys.path.insert(0, "/Users/nazmi/flowmap")` |
| R02 hist bin | equal-time bins ≠ event replay columns |
| R02 gap wipe | gap ≥ bw full wipe |
| R14 gaps | no unit tests for converters / hist / SQL / import-path |
| R05 H5 | is_snapshot / delta-only books |
| P2-35–40 | siblings that own sub-slices; this theme **contracts** them |

### Scope boundary
- **Own:** contract matrix standalone ↔ embed; API surface checklist; differential harness design.
- **Delegate detail:** path inject (P2-35), hist binning (P2-36), gap wipe (P2-37), catalog empty (P2-38), time warp (P2-39), price rewrite (P2-40), SQL (P2-41).

---

## 2. Threat model

| Failure mode | User impact |
|--------------|-------------|
| Converter A maps side differently from B | CVD / bubbles / book wrong in embed only |
| Hist preload uses different Level2 semantics than replay | Visual “jump” when live connects after hist |
| `push_snapshot` signature drift | Embed crashes or no-ops silently |
| Path inject fails on other machines | Embed never loads (ImportError swallowed) |
| Auto-live 500ms races hist load | Hist wiped / partial / never shown |
| Symbol change does not re-hist | Stale columns for new symbol |

Threat actor is **code evolution**: two trees edited independently without contract tests.

---

## 3. Concrete probes

### 3.1 Static — API surface inventory

Build a table of every call embed → FlowMap:

| Call | Standalone owner | Embed caller | Signature | Notes |
|------|------------------|--------------|-----------|-------|
| `MainWindow.__init__(symbol, data_dir, historical_hours)` | main_window | FlowmapWindow | compare defaults |
| `heatmap.push_snapshot` / engine push | heatmap_widget | load_historical_data | |
| `OrderBook.apply_*` | order_book | both paths | |
| `dict_to_flowmap_objects` | embed only? | vs `_dispatch_record` | |
| Signals: on_snapshot, on_update, on_trade, on_bbo | base | wiring | |

### 3.2 Differential converter test (highest value)

```python
# Pseudo: same parquet row → both converters → assert equal events
for row in golden_rows:
    a = standalone_dispatch(row)
    b = embed_dict_to_flowmap(row)
    assert_event_equal(a, b)  # type, side, prices, is_snapshot, ts fields
```

Cover: book_snapshot, book_delta (is_snapshot T/F), trade, liquidation (if any), book_ticker.

### 3.3 Lifecycle race

1. Embed start with `historical_hours=2`.
2. Log timestamps: hist load start/end, auto `toggle_simulation` @500ms, first live snapshot.
3. Assert: hist columns not cleared unless intentional `switch_to` reset.
4. Fail if hist empty after race or full wipe.

### 3.4 Path inject failure

```bash
# On machine without /Users/nazmi/flowmap (or rename temp)
python -c "from crypcodile.gui.flowmap_window import FlowmapWindow"
# Expect: clear error path, not silent empty module
```

### 3.5 Signature freeze

```bash
python -c "import inspect; from flowmap.ui.heatmap_widget import HeatmapWidget; print(inspect.signature(HeatmapWidget.push_snapshot))"
# Compare to embed call sites
```

### 3.6 Test gap audit (R14)

List every R14 gap; mark covered by this theme’s Phase-3 tests vs other themes.

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| DRIFT-P1 | Converters produce identical event sequences on golden rows | Any side/type/price field diverges |
| DRIFT-P2 | Embed import works without hardcoded path OR documents env override | Hardcoded path only |
| DRIFT-P3 | Hist + live co-exist without undocumented wipe | Random blank after 500ms |
| DRIFT-P4 | Contract tests in CI for converter + push_snapshot | Zero automated dual-path tests |
| DRIFT-P5 | Symbol change policy documented & tested | Stale hist for new symbol undocumented |

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| Golden parquet rows (JSON serialized) | Converter equality |
| Mini lake 5 min window | Hist bin integration |
| Fake Catalog returning empty / partial channels | Coord P2-38 |
| `FLOWMAP_ROOT` env experiment fixture | Path portability |
| Screenshot baselines: embed vs standalone same symbol window | Visual drift |

---

## 6. Phase-3 agent micro-tasks

| Hunt | Work |
|------|------|
| **H-42A** | Full call-graph embed → flowmap + signature freeze file |
| **H-42B** | Implement converter differential suite (dict_to_flowmap vs _dispatch_record) |
| **H-42C** | Hist vs live race instrumentation + repro of wipe/reset |
| **H-42D** | Path inject / import failure matrix (missing path, wrong version) |
| **H-42E** | Map findings to P2-35–41 ownership; file FIND-P242 only for true drift/contract gaps |

---

## 7. Expected finding IDs — `FIND-P242-XX`

| ID | Sev | Title |
|----|-----|-------|
| FIND-P242-01 | P0/P1 | Converter field/side divergence |
| FIND-P242-02 | P0 | Hardcoded flowmap_path inject |
| FIND-P242-03 | P1 | Hist wiped by auto-start / switch_to |
| FIND-P242-04 | P1 | No re-hist on symbol change |
| FIND-P242-05 | P1 | push_snapshot / levels API mismatch |
| FIND-P242-06 | P2 | Title vs symbol field stale in embed |
| FIND-P242-07 | P2 | Test coverage gap formalized (meta) |
| FIND-P242-08 | P1 | Delta-as-snapshot semantic drift |

---

## 8. Fix strategy sketch

1. **Single converter module** owned by FlowMap; embed imports it only.
2. **Remove** parallel `dict_to_flowmap_objects` or thin-wrap shared code.
3. **`FLOWMAP_HOME` / package install** instead of `sys.path` absolute inject.
4. **Lifecycle API:** `load_historical_data` re-callable; explicit policy when live starts.
5. **Contract tests** as merge gate between the two repos (or monorepo CI job).
6. Pin flowmap version in Crypcodile deps when installed.

---

## 9. Dependencies

| Theme | Link |
|-------|------|
| P2-35 | Path inject detail |
| P2-36–38 | Hist semantics |
| P2-39–40 | Replay distortion (standalone only unless embed uses replay) |
| P2-41 | SQL sites both trees |
| P2-04, P2-05 | Mapping fidelity |
| P2-49 | Simulator oracle for shared OrderBook path |

**Critical path:** W1 mapping (Z08) + W2 Z12. Schedule converter tests early in W2.

---

## 10. Severity priors

| Cluster | Prior |
|---------|-------|
| Dual converter wrong side/price | **P0** |
| Path inject non-portable | **P0** ship/integration |
| Hist race / wipe | **P1** |
| Missing tests only | **P2** meta (still file as FIND) |
