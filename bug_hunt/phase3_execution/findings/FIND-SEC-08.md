# FIND-SEC-08

| Field | Value |
|-------|-------|
| **ID** | FIND-SEC-08 |
| **Severity** | P2 |
| **Status** | CONFIRMED |
| **Title** | Dual data orchestration: DataManager unused; SourceManager queue path leaves signal applies latent |
| **Theme / Zones** | Z10 source lifecycle · secondary expand of R04 H6/H7; R10 H1; R03 H-R03-08; P2-20 dual emit |
| **Taxonomy** | data_source · integration · concurrency (latent multi-writer) |
| **Location** | `flowmap/data/manager.py` (entire); `flowmap/ui/source_manager.py:256–310`, `328–342`; providers queue XOR emit |
| **Sibling** | R04 H6, H7, Q2; R10 bottom line dual path; R03 H-R03-08; R05 H14; P2-20 |
| **Wave** | W secondary |
| **Discovered by** | phase3-hunter-sec |

### Problem

**Architecture dual path A — two managers**

| Component | Wired by production UI? | Providers |
|-----------|-------------------------|-----------|
| `DataManager` | **No** — only exported from `data/__init__.py` | simulator, CCXT exchanges; docstring claims replay but factory has no crypcodile |
| `SourceManager` | **Yes** — MainWindow owns it | Crypcodile LIVE/REPLAY only; residual sim/crypto imports |

Production never instantiates `DataManager`. Simulator/CCXT via manager are unreachable from the shipping MainWindow. Docs/API surface still advertise `DataManager` as the “unified interface.”

**Architecture dual path B — queue vs signals**

Providers accept `queue=`:

- `queue is not None` → put tuples; **do not** emit market data signals  
- `queue is None` → emit Qt signals  

`SourceManager` always passes `queue=self._queue` **and** still connects:

- `on_snapshot` → `_on_provider_snapshot` → `apply_snapshot`  
- `on_update` / `on_trade` → direct book mutators  
- `on_bbo` → **empty** `pass` (even if signals returned)

With queue set, market signal handlers are dead (data never emitted). Real path is `_gui_tick` drain only. Latent bugs:

1. Constructor without queue (tests, future DataManager crypto without queue) double-writes if both queue and signals ever fire.  
2. Signal-path BBO handler is a no-op — signal-only mode drops BBO.  
3. Signal-path trade apply does not call `heatmap.add_trades` / pulse / VP (those only run in `_gui_tick`) → UI desync if queue cleared.  
4. Two orchestration layers diverge on source types, pause, and backpressure (manager/sim: no queue; SourceManager: unbounded queue).

### Repro

```bash
rg -n "DataManager\\(" flowmap --glob '*.py'
# Only manager.py docstring example — no MainWindow use

rg -n "queue=self\\._queue|_on_provider_snapshot" flowmap/ui/source_manager.py
# Both queue pass and signal connect present
```

```python
# Mental: CrypcodileLiveProvider(..., queue=q)
# _on_record: only q.put — sig_* not emitted → _on_provider_* never for market data
```

### Expected

Single ownership: one manager, one delivery path (prefer queue+`_gui_tick` for workers). Signal handlers either removed when queue mode is mandatory, or exclusively used when `queue is None`. `DataManager` either drives UI or is clearly marked legacy/oracle-only.

### Actual

Parallel unused `DataManager` + production `SourceManager` with wired-but-dead market handlers and empty BBO slot on signal path.

### Fix hint

1. Deprecate or document `DataManager` as non-UI (sim oracle only).  
2. In `_start_*`, if `queue is not None`, connect only lifecycle signals (`connected`/`disconnected`/`error`/`progress`), not market apply handlers.  
3. If keeping signal path, implement `_on_provider_bbo` and share one apply helper with `_gui_tick`.  
4. Never pass queue and also emit (enforce XOR in providers — already mostly true; keep tests for dual-emit).

### Evidence

- `DataManager` grep confined to `manager.py` + `__init__.py` exports.  
- MainWindow constructs only `SourceManager` (`main_window.py:47–49`).  
- Queue put XOR emit: `crypcodile_live.py:179–196`, `crypcodile_replay.py:513–530`.  
- R04 §2 dual architecture; R10 “Data path effectively queue-only”; R03 §5 multi-writer if signals reactivated.
