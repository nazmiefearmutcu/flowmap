# P2-11 — Normalizer live vs rebuild divergence

| Field | Value |
|-------|-------|
| **Agent ID** | P2-11 |
| **Theme** | Normalizer live vs rebuild divergence |
| **Zones** | Z02 (Density project/scroll/rebuild) |
| **Siblings** | R07 (H4, H5, H9, H11, H14), R17 (norm edges) |
| **Finding prefix** | `FIND-P211-XX` |
| **Severity prior** | **P0–P1** (color jump / temporal scale wrong; not crash) |
| **Primary files** | `engine/normalizer.py`, `engine/density_engine.py`, `ui/heatmap_widget.py` |

---

## 1. Scope & linked zones / sibling hyps

### In scope

Prove (or refute) that **live column paint** and **full history rebuild** produce **different normalized intensities / ref trajectories** for the same underlying book history, and quantify when that becomes user-visible.

| Path | Entry | Normalizer policy |
|------|-------|-------------------|
| **Live** | `DensityEngine.push_snapshot` → `_draw_column` | Per-column: `update(active sizes)` then `normalize` one column; history RGBA **frozen** |
| **Rebuild** | `HeatmapWidget.rebuild_heatmap` | Reset refs → grid all columns → **one batch** `update(entire active mask)` → normalize whole grid |

### Out of scope (owned by siblings)

- Mid-side mask dropping opposite liquidity → P2-07  
- `ticks_per_row` max-not-sum → P2-09  
- Color LUT / gamma docs → P2-12  
- Resize blank history without rebuild → P2-29  

### Sibling anchors

| ID | Claim |
|----|-------|
| R07 H4 | Live vs rebuild: batch norm + SciPy 2D vs engine 1D convolve |
| R07 H5 | Adaptive ref + frozen history → temporal scale mismatch |
| R07 H9 | Rebuild p98 dominated by dense history cluster (single vector) |
| R07 H11 | Live `>` vs rebuild `>=` for no-mid side mask |
| R07 H14 | EngineConfig bid_ref 20000 vs DensityEngine default 3000 |
| R20 P0 cluster | Density/docs lie; live/rebuild divergence listed as visual P0/P1 |

### Absolute paths

- `/Users/nazmi/flowmap/flowmap/engine/normalizer.py`
- `/Users/nazmi/flowmap/flowmap/engine/density_engine.py`
- `/Users/nazmi/flowmap/flowmap/engine/config.py`
- `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py`
- `/Users/nazmi/flowmap/flowmap/ui/source_manager.py` (symbol `bid_ref` overrides)

---

## 2. Threat model

| Actor / trigger | Mechanism | Impact |
|-----------------|-----------|--------|
| Live stream (any source) | Each frame: `AdaptiveNormalizer.update` on **current column only**, α=0.05 EMA of p98 | Ref walks slowly; old columns keep past LUT indices |
| Resize / scroll / zoom / `ticks_per_row` change | `rebuild_heatmap()` resets `global_ref` to `config.bid_ref/ask_ref`, then one-shot p98 over **all** grid cells | Entire buffer recolors; jump vs pre-rebuild live trail |
| Symbol switch (BTC ref=5) | Init ref tiny → first p98 snap-to → saturates then dims | Flash then global recolor on rebuild |
| User “Sensitivity” slider | Mutates engine refs mid-session | Live continues from new ref; rebuild resets then batch adapts |
| Malicious / bad book sizes | Inf/huge sizes → `nan_to_num(posinf=ref)` + clip | Intensity collapse or flash; same on both paths if sizes shared |

**Invariant under test:** For a fixed history list H and fixed engine config C,  
`render_live_sequential(H,C)` should be **contractually related** to `render_rebuild(H,C)`  
(either bitwise equal under controlled flags, or documented max Δ-norm). Today: **no contract**.

---

## 3. Concrete probes (with file:line)

### 3.1 Static audit

| # | Step | Location |
|---|------|----------|
| S1 | Document module docstring vs class: claims fixed ref=8000 linear | `normalizer.py:1-15` vs class `AdaptiveNormalizer` `:20-51` |
| S2 | Live update site: only active column values | `density_engine.py:338-355` |
| S3 | Rebuild: reset refs then batch update | `heatmap_widget.py:606-608`, `:834-845` |
| S4 | Live vertical smooth: 1D `_smooth_column` | `density_engine.py:317-330`, `_smooth_column` ~555+ |
| S5 | Rebuild vertical smooth: SciPy `gaussian_filter1d` axis=0 | `heatmap_widget.py:820-832` |
| S6 | No-mid mask: live `bid_arr > ask_arr` | `density_engine.py:369-370` |
| S7 | No-mid mask: rebuild `>=` | `heatmap_widget.py:855-856` |
| S8 | Config defaults: `bid_ref=20000` | `config.py:19-20` |
| S9 | Widget constructs engine with decay only → often **3000** path | Grep `DensityEngine(` in `heatmap_widget.py` / ctor defaults |
| S10 | Symbol overrides SOL 3000 / ETH 100 / BTC 5 | `source_manager.py` ~threshold/symbol block (R07 §2.4) |

### 3.2 Unit probes (headless NumPy)

**Probe U1 — Sequential vs batch p98 trajectory**

```text
Given: N columns of synthetic sizes, same bid_arr per column
Live:  for each col: norm.update(col); store norm.global_ref; store normalize(col)
Rebuild: reset global_ref; update(concat all active); normalize(grid)
Assert: record max |ref_live_final - ref_rebuild| and max |norm_live - norm_rebuild|
```

Pass if deltas measured and thresholds agreed; **expect FAIL** (H9).

**Probe U2 — Frozen history scale drift**

```text
Col 1..50: size=100 constantly; after 50 cols ref_live ≈ p98 path
Col 51: size still 100 but ref has drifted from first-hit p98
Compare RGBA of col 1 (frozen) vs col 51 for identical size
```

Expect: **different brightness** (H5) — document as design risk vs bug.

**Probe U3 — Rebuild recolor jump**

```text
Run U1 live for 200 cols with slowly increasing p98
Capture rightmost column RGBA
Call rebuild path with same history
Compare same logical column index
```

**Probe U4 — Power curve gate**

```text
size = k * ref for k in {0.01, 0.05, 0.055, 0.1, 0.5, 1.0}
norm = (clip(k,0,1))**2.5
visibility: norm > 0.0005  → k ≳ 0.055 (R07 H6)
```

**Probe U5 — no-mid inequality**

```text
bid_arr == ask_arr on a row, mid_price=0
Live is_bid: False (strict >)
Rebuild is_bid: True (>=)
→ different LUT side for equal sizes
```

### 3.3 Dynamic / integration

| # | Steps | Expected observation |
|---|-------|----------------------|
| D1 | Replay SOLUSDT 20× for 30s; screenshot; force resize (trigger rebuild); screenshot | Global color shift of history |
| D2 | BTC symbol (ref=5); first 5s live; rebuild | Flash-saturate then post-rebuild recolor |
| D3 | Drag scroll_offset to force rebuild throttled path | Intermediate frames may mix live right edge + rebuild |

### 3.4 GUI (optional, after unit)

- cua: open FlowMap → Start → resize window width ±20% → capture heatmap  
- Compare histogram of green channel pre/post

---

## 4. Pass / fail criteria

| ID | Criterion | Pass | Fail |
|----|-----------|------|------|
| PF1 | Live/rebuild norm contract documented | Spec exists with allowed Δ | Silent dual path |
| PF2 | Same history + `update_normalizer` policy | Pixel Δ ≤ agreed ε (e.g. MAE norm ≤ 0.02) **or** intentional policy recorded | Unexplained jumps on resize |
| PF3 | No-mid side consistency | Live and rebuild same op (`>` or `>=`) | Divergent LUT side |
| PF4 | Ref reset on rebuild | Either preserves live ref **or** documents jump | Accidental reset without reason |
| PF5 | Docstrings match behavior | Module text = adaptive p98 + power 2.5 | Claims fixed 8000 linear |

---

## 5. Fixtures needed

| Fixture | Description |
|---------|-------------|
| `fixtures/norm_ladder.npz` | Columns of known sizes (geometric ladder) + expected norm under fixed_ref |
| `fixtures/book_history_synthetic.json` | List of (levels, bbo) for 64 columns, constant wall size 500 |
| `fixtures/btc_thin_book.json` | Sparse levels, huge size vs ref=5 |
| Replay lake | `/Users/nazmi/data/exchange=binance-spot/...` (if present) for D1 |
| Golden | Optional PNG pair live_vs_rebuild for SOL |

**Minimal oracle code sketch (Phase-3 implements, not Phase-2):**

```python
# tests/phase3/test_norm_live_rebuild.py
from flowmap.engine.normalizer import AdaptiveNormalizer
import numpy as np

def live_refs(columns):
    n = AdaptiveNormalizer(fixed_ref=3000)
    refs = []
    for col in columns:
        active = col[col > 0.01]
        if len(active): n.update(active)
        refs.append(n.global_ref)
    return refs

def rebuild_ref(columns):
    n = AdaptiveNormalizer(fixed_ref=3000)
    grid = np.stack(columns, axis=1)
    active = grid[grid > 0.01]
    if len(active): n.update(active)
    return n.global_ref
```

---

## 6. Phase-3 micro-tasks (3–5 executable hunts)

1. **P3-11a** — Implement U1–U5 unit tests under `tests/engine/test_normalizer_divergence.py`; open FIND tickets for measured deltas.  
2. **P3-11b** — Instrument temporary counters: log `bid_norm.global_ref` every 30 frames + on rebuild entry/exit; attach logs to FIND.  
3. **P3-11c** — Diff live `_smooth_column` vs SciPy rebuild smooth on identical 1D column; quantify H4 smooth contribution separate from norm.  
4. **P3-11d** — Align no-mid operators (`>` vs `>=`) and re-run U5.  
5. **P3-11e** — Design decision: (A) rebuild continues from live ref without reset, (B) rebuild freezes history colors and only repaints geometry, (C) document recolor-as-feature — pick one and note for fix wave.

---

## 7. Finding ID format

`FIND-P211-XX` where XX = 01, 02, …

| Suggested seed IDs | Title | Hyp |
|--------------------|-------|-----|
| FIND-P211-01 | Batch rebuild p98 ≠ sequential live refs | R07 H9 |
| FIND-P211-02 | History columns frozen under adaptive scale | R07 H5 |
| FIND-P211-03 | Rebuild resets global_ref causing color jump | code L606-608 |
| FIND-P211-04 | Live `>` vs rebuild `>=` no-mid | R07 H11 |
| FIND-P211-05 | Doc claims fixed-ref linear; code adaptive **2.5 | R07 H15 |

---

## 8. Fix strategy sketch (no code)

1. **Single normalize pipeline:** rebuild should either call engine `_draw_column` per history column with a controlled `update_normalizer` schedule, or extract shared `normalize_grids()` used by both.  
2. **Ref policy:**  
   - Option A: do **not** reset refs on rebuild; only reproject geometry.  
   - Option B: reset but also **recolor is intentional** — show brief “recalibrating” and accept jump.  
   - Option C: two-pass: first pass compute ref from all columns without paint; second pass paint with frozen ref (matches batch, no sequential drift).  
3. Unify no-mid comparator.  
4. Fix docs in `normalizer.py` header to match AdaptiveNormalizer.  
5. Align default `bid_ref` (config 20000 vs ctor 3000) once (depends P2-12/H14).

---

## 9. Dependencies

| Theme | Relationship |
|-------|----------------|
| **P2-07** mid-mask | Same paint path; run after mask correctness or isolate norm metrics ignoring side |
| **P2-08** scroll clear-right | Affects live column content before norm |
| **P2-09** ticks_per_row | Changes which sizes hit a row (max.at) → p98 inputs |
| **P2-12** color LUT | Downstream of norm indices |
| **P2-26** rebuild freeze | Rebuild cost; don’t full-rebuild just to “fix” colors |
| **P2-27** throttled rebuild | Races between live push and rebuild |

**Upstream:** Z11 book truth (Track A 01–06) should be stable so size vectors are correct.  
**Downstream:** Z01 paint golden images.

---

## 10. Severity priors (Phase-1)

| Source | Sev | Note |
|--------|-----|------|
| R07 H4/H5/H9 | P0 structure / P1 intensity | User sees jump on every resize/scroll rebuild |
| R20 | CRITICAL density stack | Z02 band P0 |
| Likelihood | High | Rebuild is frequent (resize, drag, zoom) |

**Recommended Phase-3 severity gate:** default **P1** visual; promote **P0** if rebuild changes perceived liquidity ranking (wall disappears / appears solely due to ref).

---

## 11. Code anchors (copy-paste)

```338:355:/Users/nazmi/flowmap/flowmap/engine/density_engine.py
        # Update adaptive normalizers
        if update_normalizer:
            if np.any(active_bids):
                self._bid_norm.update(bid_arr[active_bids])
            ...
            norm_bids[active_bids] = self._bid_norm.normalize(bid_arr[active_bids])
```

```606:608:/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py
        self._engine._bid_normalizer.global_ref = self._engine.config.bid_ref
        self._engine._ask_normalizer.global_ref = self._engine.config.ask_ref
```

```834:845:/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py
        # 4. Update normalizers in batch
        active_bids_mask = bid_grid > 0.01
        if np.any(active_bids_mask):
            self._engine._bid_normalizer.update(bid_grid[active_bids_mask])
        ...
        norm_bids = self._engine._bid_normalizer.normalize(bid_grid)
```

```33:51:/Users/nazmi/flowmap/flowmap/engine/normalizer.py
    def update(...): p98 EMA α=0.05
    def normalize(...): ratio ** 2.5
```
