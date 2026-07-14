# P2-37 — Gap ≥ bw full wipe semantics

| Field | Value |
|-------|-------|
| **Agent** | P2-37 |
| **Theme** | Gap ≥ bw full wipe semantics |
| **Zones** | Z12 |
| **Sibling hyps** | R02 §3.4 gap-fill; R20 P1-10; flowmap_window.py ~230–250 |
| **Severity prior** | **P1** (user loses entire historical preload silently) |
| **Primary files** | `/Users/nazmi/Crypcodile/src/crypcodile/gui/flowmap_window.py` lines 230–250 |

---

## 1. Scope & linked zones/sibling hyps

### In scope
Gap-fill block after equal-time bin preload:

```python
now_ns = time.time_ns()
gap_ns = now_ns - last_ts
gap_bins = int(gap_ns / bin_duration)
if gap_bins >= bw:
    # full wipe: order_book, pulse, VP, heatmap reset
else:
    # push frozen last book for k in 1..gap_bins
```

- Definitions: `last_ts = end_ns` (query window end), **not** necessarily last event
- Interaction with lake staleness (data from days ago → huge gap → always wipe)
- Interaction with `historical_hours` and wall-clock “now”
- Silent wipe: no UI toast
- Partial gap fill freezes depth into “recent” columns

### Out of scope
- Binning math itself (P2-36) except gap_bins uses `bin_duration`
- Live feed after 500ms
- Replay provider gaps (sleep cap 5s is P2-39 adjacent)

---

## 2. Threat model

| Scenario | gap_bins | Outcome |
|----------|----------|---------|
| Live lake updated minutes ago | small | Hold-forward columns; OK-ish |
| Lake last trade days ago; hist window ends at last trade | **huge** | **Wipe all hist** → blank then live |
| end_ns = time.time_ns() fallback (no trade max) | gap≈0 | no fill |
| end_ns from max trade; clock skew | variable | intermittent wipe |
| bw small (buffer 1) | gap_bins ≥ 1 often | wipe almost always |
| User wanted “show last 2h ending at last data” | N/A | product intent unclear |

**Core product bug:** Building hist for N hours then **deleting it** because wall-clock gap ≥ screen width in bin units — defeats purpose of preload for stale lakes (exactly the local `/Users/nazmi/data` situation with June data vs July “now”).

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| S1 | Confirm `last_ts = end_ns` assignment (~171) |
| S2 | `end_ns` sources: max(trade) vs time.time_ns() |
| S3 | Wipe resets list completeness vs load start resets |
| S4 | No user signal / log on wipe path |

### 3.2 Unit — gap math

| ID | Inputs | Expected branch |
|----|--------|-----------------|
| U1 | gap_ns=0 | no fill |
| U2 | gap_bins = bw-1 | hold-forward pushes bw-1 |
| U3 | gap_bins = bw | **wipe** |
| U4 | gap_bins = bw+1000 | wipe once |
| U5 | bin_duration=0 protected | `if gap_ns > 0 and bin_duration > 0` |
| U6 | Mock end_ns = now - 3 days; bw=800; hours=2 | compute gap_bins ≫ bw → wipe |

### 3.3 Integration with real layout

| ID | Steps |
|----|-------|
| I1 | Use lake dated 2026-06-16; run load with hours=2 in 2026-07 | expect wipe |
| I2 | Monkeypatch `time.time_ns` to end_ns+small | expect hold-forward |
| I3 | Monkeypatch now = end_ns | no gap |
| I4 | After wipe, book empty when live starts | blank heatmap risk |
| I5 | Hold-forward: columns show same wall until live | visual “fake present” |

### 3.4 GUI

| ID | Probe |
|----|-------|
| G1 | Launch CLI flowmap on stale data; observe whether hist flashes then clears |
| G2 | No status message “history cleared due to data gap” |
| G3 | Compare with historical_hours=0 (no load) |

---

## 4. Pass/fail criteria

| Criterion | Pass | Fail |
|-----------|------|------|
| Stale lake | Still shows binned hist ending at last data (option A) **or** explicit message before clear (option B) | Silent full wipe |
| Fresh lake | gap fill ≤ bw-1 holds book without inventing trades | OK |
| Semantics documented | Code comment + user-facing | Magic threshold |
| Clock | Deterministic under mocked now | depends on wall clock flaky tests |
| After wipe | State consistent empty; live can recover | half-reset (pulse only etc.) |

---

## 5. Fixtures needed

| Fixture | Description |
|---------|-------------|
| Controllable `time.time_ns` in tests | freezegun or inject clock |
| Synthetic events with fixed end_ns | |
| Stale real lake path | `/Users/nazmi/data` sample |
| Spies on `heatmap.reset` call count | |

---

## 6. Phase-3 agent micro-tasks

### Hunt A — Prove wipe on stale lake
I1 with instrumentation: count reset calls after bin loop. **FIND-P237-01**

### Hunt B — Boundary bw-1 vs bw
U2/U3 exact. **FIND-P237-02**

### Hunt C — Hold-forward correctness
Frozen book columns timestamps vs “now”. **FIND-P237-03**

### Hunt D — end_ns fallback paths
No trades in catalog; end_ns=now; gap 0; empty early return interactions. **FIND-P237-04**

### Hunt E — Product decision record
Recommend: disable wipe; or fill without wipe; or hist anchored to last_ts not wall now. **FIND-P237-05**

---

## 7. Expected finding IDs

Format: **`FIND-P237-XX`**

| ID | Title | Sev |
|----|-------|-----|
| FIND-P237-01 | Stale lake → gap≥bw wipes preload | **P1/P0** |
| FIND-P237-02 | last_ts is window end not last event | P2 |
| FIND-P237-03 | Silent wipe no UX | P1 |
| FIND-P237-04 | Hold-forward invents “present” depth | P2 |
| FIND-P237-05 | Threshold uses int truncation | P3 |
| FIND-P237-06 | Interaction with bw=1 | P1 |

---

## 8. Fix strategy sketch

1. **Default:** never wipe successful hist; only gap-fill up to `bw-1` **or** stop at last data column and leave left side as hist without pretending columns are “now”.
2. If wipe retained: modal/status “Data is N hours old; showing empty live canvas”.
3. Anchor “now” to `end_ns` for visualization timeline (historical mode) instead of wall clock.
4. Config flag `gap_policy = hold|wipe|none`.
5. Tests with frozen clock mandatory.

---

## 9. Dependencies

| Theme | Relation |
|-------|----------|
| **P2-36** | Runs before gap logic; wipe deletes its work |
| P2-38 | Empty channels → early return skips gap entirely |
| P2-35 | Launch required |
| P2-31 | Wipe is a reset (good for mem) |
| Live auto-start | Post-wipe empty → live fills |

---

## 10. Severity priors from phase1

| Source | Prior |
|--------|-------|
| R20 P1-10 | P1 |
| R02 gap-fill / wipe | called out as divergence risk |
| Local lake age vs now | makes wipe **likely default** |

**Verdict:** Treat as **high probability P1** on real developer data; confirm with I1 immediately in Phase-3.
