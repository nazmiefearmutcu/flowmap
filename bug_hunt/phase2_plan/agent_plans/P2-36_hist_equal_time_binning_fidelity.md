# P2-36 — Hist equal-time binning fidelity

| Field | Value |
|-------|-------|
| **Agent** | P2-36 |
| **Theme** | Hist equal-time binning fidelity / bin compress |
| **Zones** | Z12 |
| **Sibling hyps** | R02 §3.4–3.5, §6.2; R20 Z12 |
| **Severity prior** | **P0–P1** visual/historical truth (compressed history is not event replay) |
| **Primary files** | `/Users/nazmi/Crypcodile/src/crypcodile/gui/flowmap_window.py` `load_historical_data` (~100–250), `dict_to_flowmap_objects` |

---

## 1. Scope & linked zones/sibling hyps

### In scope
- Preload pipeline: Catalog.scan → merge/sort → **equal-time bins** count = `bw = heatmap buffer width`
- Per bin: apply all L2/trades in order → **single** `push_snapshot` at bin end
- Intra-bin path loss: intermediate book states never painted
- Trade aggregation into one frame stamp for all bin trades
- `bin_duration = total_span / bw` with `total_span = end_ns - start_ns` (window edges, not first/last event)
- Empty bins still push snapshot (held book)
- Comparison to standalone **event-level** `CrypcodileReplayProvider`
- Dual converter `dict_to_flowmap_objects` vs `_dispatch_record` only as it affects bin content (full dual path → P2-42)

### Out of scope
- Gap ≥ bw full wipe (P2-37) — sequential dependency after bins
- Catalog missing channels (P2-38) — inputs to this path
- Replay time-warp (P2-39) — different code path

---

## 2. Threat model

| Distortion | Mechanism | User-visible |
|------------|-----------|--------------|
| Temporal compress | Hours → ~bw columns (e.g. 2h → ~800 cols ≈ 9s/col) | “History” is summary not tape |
| Intra-bin L2 loss | Only end-of-bin book drawn | Walls appear/disappear at bin edges; max depth inside bin invisible |
| Trade clump | All bin trades same frame_count | Bubble/CVD spike at bin boundary |
| Empty bin hold | Push last book again | Fake “activity” columns with frozen depth |
| Window edges | bins from start_ns..end_ns even if no events early | Leading empty columns |
| Converter drop | liquidations/BBO not in dict path | Missing hist signals |
| NaN CVD | get_volume_delta before trades | Early columns nan CVD |

**Product risk:** Users believe CLI hist is faithful replay; it is a **lossy densified preview**.

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| S1 | Read bin loop 169–228 line-by-line |
| S2 | `bw = get_buffer().shape[1]` **before** reset — is buffer already sized? |
| S3 | `first_ts = start_ns` not first event ts |
| S4 | `bin_idx = int((ts-first_ts)/bin_duration)` clamp |
| S5 | No liquidation/book_ticker scan |

### 3.2 Unit — bin assignment

| ID | Events | Assert |
|----|--------|--------|
| U1 | Single event mid-window | lands in expected bin |
| U2 | Event at end_ns | last bin |
| U3 | Event at start_ns | bin 0 |
| U4 | total_span edge 0 | total_span forced 1; no div0 |
| U5 | N events same ns | same bin, order preserved |
| U6 | bw=1 | all events one bin, one snapshot |

### 3.3 Unit — fidelity vs event stream

| ID | Steps | Metric |
|----|-------|--------|
| F1 | Known synthetic books changing every event | count painted columns vs events |
| F2 | Wall appears mid-bin then removed before bin end | wall **absent** on heatmap (expected loss) |
| F3 | Trade prices in bin | all share one column |
| F4 | Compare final book after bins vs replaying all events without binning | books match at end; intermediate columns differ |
| F5 | CVD end-of-bin vs true end | match session totals; shape differs |

### 3.4 Integration

| ID | Steps |
|----|-------|
| I1 | Real lake 2h window: count snapshots pushed == bw (plus gap fills) |
| I2 | Resize window before load: bw changes → different compress ratio |
| I3 | historical_hours=0 skips load | |
| I4 | Empty events early return: no reset? (read code: return before reset if not events) |
| I5 | After load, 500ms live starts — first live columns append |

### 3.5 GUI

| ID | Probe |
|----|-------|
| G1 | Visual: hist looks “steppy” vs live smooth |
| G2 | Tooltip/status should disclose “binned history” (today: none) |
| G3 | Compare same symbol CLI hist vs standalone REPLAY (different path) |

---

## 4. Pass/fail criteria

| Criterion | Pass | Fail |
|-----------|------|------|
| Spec honesty | Documented lossy binning OR event-faithful mode | Silent fiction marketed as history |
| End state | Final book == sequential apply of all events in window | Drift from converter bugs |
| Snapshot count | Exactly bw pushes in main loop (before gap) | off-by-one / empty skip |
| Order | Events sorted by local_ts within bins | out-of-order apply |
| Empty window | Clean no-op | crash / partial reset |
| bw source | Stable intended width | wrong bw from 1×1 buffer |

**Critical check S2/U:** If buffer is still 1×1 at load time, **bw=1** → entire history one column → catastrophic compress. **Must verify.**

---

## 5. Fixtures needed

| Fixture | Description |
|---------|-------------|
| Synthetic Catalog (tmpdir hive) | known book_delta + trades with engineered mid-bin wall |
| `events_bin_matrix.parquet` | controlled timestamps |
| Golden final book JSON after full apply |
| Golden “lossy” column digest (optional) |
| Real short lake slice for I1 |

---

## 6. Phase-3 agent micro-tasks

### Hunt A — bw-at-load bug
Print `get_buffer().shape` at entry to load_historical_data; widget size before show. **FIND-P236-01** (potential P0)

### Hunt B — Loss model quantification
Synthetic F2 mid-bin wall experiment; screenshots. **FIND-P236-02**

### Hunt C — Empty bins / edge windows
Leading/trailing empty; frozen depth columns. **FIND-P236-03**

### Hunt D — Converter gaps in hist
Liquidation/BBO missing vs typed replay. **FIND-P236-04**

### Hunt E — Product contract
Write explicit mode matrix CLI-hist vs REPLAY; recommend UI badge. **FIND-P236-05**

---

## 7. Expected finding IDs

Format: **`FIND-P236-XX`**

| ID | Title | Sev |
|----|-------|-----|
| FIND-P236-01 | bw from undersized buffer at preload | **P0** if true |
| FIND-P236-02 | Intra-bin L2 path discarded | P1 (design) |
| FIND-P236-03 | Empty bins freeze depth | P1–P2 |
| FIND-P236-04 | Window edges not event edges | P2 |
| FIND-P236-05 | Trade clumping / frame stamp | P1–P2 |
| FIND-P236-06 | No user-facing “binned” disclosure | P2 |
| FIND-P236-07 | dict converter channel gaps | P1 |
| FIND-P236-08 | early return skips when empty without message | P3 |

---

## 8. Fix strategy sketch

1. Ensure heatmap geometry initialized (show/resize) **before** binning; or pass target_bw from screen metrics.
2. Optional modes: `bin=equal_time` (current) vs `bin=event_thin` (max events per col) vs true replay.
3. Within bin: track max size per price for display (Bookmap-style) if product wants walls.
4. Disclose in UI: “Historical preview (N min/column)”.
5. Unify converters with `_dispatch_record` (P2-42).
6. Unit tests for bin index math pure function extracted from GUI.

---

## 9. Dependencies

| Theme | Relation |
|-------|----------|
| **P2-35** | Must import first |
| **P2-37** | Gap wipe after bins |
| **P2-38** | Missing channels starve bins |
| P2-04 delta-only books | Empty mid if no snapshot |
| P2-39/40 | Different hist path (replay) |
| P2-31 history mem | Preload fills  bw columns + later live |

---

## 10. Severity priors from phase1

| Source | Prior |
|--------|-------|
| R02 hist compress | P0–P1 integration |
| R20 Z12 | P0–P1 |
| Feed comparison matrix | temporal resolution compressed |

**Verdict:** First verify **bw**, then quantify loss; design findings still ship as P1 if intentional but undisclosed.
