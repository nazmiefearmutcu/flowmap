# P2-31 — Density dict unbounded prices

| Field | Value |
|-------|-------|
| **Agent** | P2-31 |
| **Theme** | Density dict unbounded prices / memory growth |
| **Zones** | Z02 |
| **Sibling hyps** | R07 (density storage/docs), R16 (memory), R20 P0/P1 mem cluster, R08 history rebuild |
| **Severity prior** | **P1→P0 under multi-hour live / volatile markets** (RAM + rebuild cost) |
| **Primary files** | `/Users/nazmi/flowmap/flowmap/engine/density_engine.py`, `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py`, `/Users/nazmi/flowmap/flowmap/core/order_book.py` |

---

## 1. Scope & linked zones/sibling hyps

### In scope
- Growth of price-keyed structures over long sessions without full `reset()`:
  - `DensityEngine._bid_density` / `_ask_density` (`dict[float,float]`)
  - `HeatmapWidget._all_prices: set[float]` (append-only until reset)
  - `HeatmapWidget._history` deque(maxlen=10000) storing **full level lists + per-side numpy arrays per column**
  - `OrderBook._bids/_asks` SortedDict pruned only to ±15% mid (or depth×5 fallback)
- Interaction with rebuild: rebuild walks `_history` and reprojects all prices → cost ∝ history depth × unique prices
- Float price keys as distinct identities (near-equal floats never coalesced)

### Out of scope
- Mid-mask coloring correctness (P2-07)
- Live vs rebuild normalizer divergence (P2-11) except when rebuild cost is amplified by unbounded keys
- Queue growth (P2-13/14)

### Zone links
```
Z11 OrderBook prune ──► Z02 density / history keys ──► Z01 rebuild_heatmap freeze (P2-26)
                              │
                              └─► Z04 trade overlays (shared session length)
```

---

## 2. Threat model

| Asset | Threat | Likelihood | Impact |
|-------|--------|------------|--------|
| Process RSS | Unbounded `_all_prices` + 10k history of deep books | High on 24h live | OOM / swap thrash |
| GUI latency | Rebuild O(history × levels) | High after scroll/resize | Multi-second freeze |
| Correctness | Float key fragmentation (`100.1` vs `100.1000000001`) | Med | Ghost empty density rows / inflated dicts |
| Docs vs code | R07: density dicts claimed accumulators; code **replaces** each snapshot | High | Mis-triage (hunters chase wrong growth path) |
| OrderBook | ±15% of mid on BTC with tick 0.01 → ~thousands of levels; on alt microticks worse | High | Per-column numpy materialization |

**Attacker/operator model:** legitimate long-running live session, wide depth, trending market that walks price far from open (set grows forever), or hist preload + live without reset.

**False comfort:** `_bid_density` is reassigned each `push_snapshot` when `col_idx is None` — **not** the primary unbounded store. Hunters must measure **widget** `_all_prices` + `_history` payload + book depth.

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe | How |
|----|-------|-----|
| S1 | Map every price-keyed container | `rg '_all_prices\|_bid_density\|_ask_density|_history' flowmap/` |
| S2 | Confirm density replace vs accumulate | Read `density_engine.py` ~133–136; assert assignment not `dict.update` |
| S3 | Find prune of `_all_prices` | Only `clear()` on `reset()` (~935) — no rolling prune |
| S4 | History payload size | `append((levels, bbo, bid_prices, bid_values, ask_prices, ask_values, cvd, ts))` — levels is full list ref |
| S5 | OrderBook prune math | `_prune_book` ±15% mid; mid missing → count prune only |
| S6 | Docs claim decay/accumulation | Module docstring vs code (R07 H15) |

### 3.2 Unit

| ID | Probe | Steps | Assert |
|----|-------|-------|--------|
| U1 | Density dict size ≤ current positive levels | Feed N levels snapshot → replace → feed M levels | `len(_bid_density)+len(_ask_density) ≤ M_pos` |
| U2 | `_all_prices` grows across snapshots | 1000 snapshots walking mid +1 tick each, depth 50 | `len(_all_prices) ≥ 1000` (growth) |
| U3 | `_all_prices` never shrinks without reset | After U2, mid returns to start | set size **still** large |
| U4 | History maxlen | Push 12000 snapshots | `len(_history)==10000` but RSS may stay high due to retained arrays until GC |
| U5 | Float key split | Insert prices `1.0 + i*1e-12` | count distinct keys vs economic unique ticks |
| U6 | OrderBook wide book | Snapshot depth 5000 within ±15% | book size stays; outside band pruned |
| U7 | Mid None path | Empty BBO, depth>max_keep | count prune activates |
| U8 | Reset clears all | After growth, `heatmap.reset()` | `_all_prices` empty, density empty, history empty |

### 3.3 Dynamic / soak

| ID | Probe | Steps | Measure |
|----|-------|-------|---------|
| D1 | 2h simulated live | Simulator or replay @ high speed, deep book | RSS every 60s; plot; flag >2× baseline at 30min |
| D2 | Trending market | Mid walks 20% over session | `len(_all_prices)` vs `len(order_book levels)` |
| D3 | Rebuild cost | After 10k history, force resize | wall time `rebuild_heatmap`; target budget from P2-26 |
| D4 | Hist preload + live | Crypcodile FlowmapWindow 2h hist then live 30min | Same metrics; gap-wipe path interaction |
| D5 | Memory profiler | `tracemalloc` / `memray` top allocators | Confirm `_history` tuples / numpy arrays dominate |

### 3.4 GUI

| ID | Probe | Steps |
|----|-------|-------|
| G1 | Status/debug | After long run: optional debug overlay print `len(_all_prices)`, `len(_history)`, book len |
| G2 | Resize after soak | Expect freeze proportional to history (link P2-26) |
| G3 | Source switch reset | LIVE→REPLAY: assert containers cleared (else leak across sources) |

---

## 4. Pass/fail criteria

| Criterion | Pass | Fail |
|-----------|------|------|
| Density dicts | Size O(current snapshot positive levels) | Dict grows across ticks without prune |
| `_all_prices` | Either unused-and-deleted **or** pruned to visible/history union | Monotone growth for session lifetime |
| `_history` | Cap enforced; payload bounded (prefer store arrays only, not full BookLevel lists forever) | Unbounded list growth or RSS climb unbounded with fixed maxlen (leaked refs) |
| OrderBook | Levels outside policy pruned every apply | |dict| grows without bound when mid moves |
| Long soak | RSS plateaus within 30% of 15-min mark after warm-up | Linear RSS slope > X MB/min |
| Rebuild | Time bounded for capped history | O(unique_all_prices) path found using `_all_prices` |

---

## 5. Fixtures needed

| Fixture | Description |
|---------|-------------|
| `fix_walk_mid.jsonl` | 5k snapshots, mid += tick, 100 levels each side |
| `fix_static_deep.jsonl` | Fixed mid, depth 2000 within ±15% |
| `fix_float_noise.jsonl` | Same economic tick with float jitter 1e-12 |
| `sim_config_memory.yaml` | Simulator params for soak |
| Golden: RSS baseline on cold start (empty) |
| Optional: real lake `binance-spot:BTCUSDT` short window for hist+live |

---

## 6. Phase-3 agent micro-tasks (hunts)

### Hunt A — Inventory & size model
Instrument `push_snapshot` counters: `n_levels`, `len(_all_prices)`, `len(_history)`, `sys.getsizeof` rough. Document max observed after 10k frames. **FIND-P231-01..03**

### Hunt B — Prove primary leak path
Differential: disable `_all_prices.update` temporarily in experiment branch (or monkeypatch) vs baseline RSS. Confirm which structure dominates. **FIND-P231-04**

### Hunt C — OrderBook ±15% under extreme mid
Flash crash synthetic: mid drops 50% in one tick; verify prune and density replace. Check orphan prices in history columns still hold old arrays (expected). **FIND-P231-05**

### Hunt D — Rebuild coupling
Time rebuild with history=100 vs 10000; correlate with unique prices. Link findings to P2-26 freeze budget. **FIND-P231-06**

### Hunt E — API / design
Decide product contract: max unique prices, prune policy, whether `_all_prices` is dead. Propose fix strategy only (Phase-4). **FIND-P231-07**

---

## 7. Expected finding IDs

Format: **`FIND-P231-XX`**

| ID | Likely title | Sev |
|----|--------------|-----|
| FIND-P231-01 | `_all_prices` append-only for session | P1 |
| FIND-P231-02 | `_history` stores full level lists × 10k | P1 |
| FIND-P231-03 | Density dicts not unbounded (doc false positive) | P3 info |
| FIND-P231-04 | Float key fragmentation under noisy prices | P2 |
| FIND-P231-05 | OrderBook ±15% still allows thousands of ticks | P2 |
| FIND-P231-06 | Rebuild cost scales with history payload | P1 |
| FIND-P231-07 | No prune on source-switch partial paths | P1–P2 |
| FIND-P231-08 | Mid=None count prune insufficient for delta-only books | P1 |

---

## 8. Fix strategy sketch (no code)

1. **Delete or bound `_all_prices`** — if unused in paint, remove; else keep rolling set of prices present in `_history` only.
2. **Slim history entries** — store only `bid_prices/values`, `ask_prices/values`, bbo, cvd, ts; drop raw `levels` list if redundant.
3. **Snap prices to tick** before dict keys to avoid float identity explosion.
4. **OrderBook:** optional hard max levels + tighter band; make prune tick-aware.
5. **Telemetry:** debug counter for unique prices / RSS in diagnostics mode.
6. Align docs: density is snapshot-replace, not accumulation.

---

## 9. Dependencies on other themes

| Theme | Relation |
|-------|----------|
| P2-07 mid-mask | Shares density projection; fix order independent |
| P2-08 buffer scroll | History column count |
| P2-11 normalizer | Rebuild walks same history |
| P2-13/14 queues | Different mem path; concurrent soak |
| **P2-26 rebuild freeze** | **Hard dep for severity** of history bloat |
| P2-29 resize | Triggers rebuild after growth |
| P2-36 hist bins | Preload fills history early |

---

## 10. Severity priors from phase1

| Source | Claim | Prior |
|--------|-------|-------|
| R20 §6 Memory | “history 10k; density dicts” | P1 mem |
| R07 §1.3 | Snapshot replace, not accumulate | Density dict itself lower risk than widget history |
| R16 | Unbounded structures | P0 class if RSS unbounded |
| OrderBook prune | ±15% | Mitigates but does not cap tick count |

**Planning verdict:** Hunt **widget `_all_prices` + `_history` payload** first; treat engine density dicts as secondary (likely false primary).
