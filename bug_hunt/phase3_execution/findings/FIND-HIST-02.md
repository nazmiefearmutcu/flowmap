# FIND-HIST-02 — H-02 Near-empty heatmap (sparse pixels) still open

| Field | Value |
|-------|-------|
| **ID** | FIND-HIST-02 |
| **Severity** | P0 |
| **Theme** | R15 historical / sparse render |
| **Zones** | Z02 |
| **Taxonomy** | rendering |
| **Taxonomy_secondary** | correctness |
| **Status** | confirmed |
| **Location** | `flowmap/engine/density_engine.py:300-315` (row mask); `gui_diag.log` |
| **Sibling** | R15 H-02, FIND-HIST-01, FIND-P207-02, FIND-P209-01 |
| **Wave** | W1 |
| **Created** | 2026-07-13 |
| **Discovered_by** | Phase-3 HIST hunter |
| **latent** | false |

### Artifact

Same `gui_diag.log` as H-01:

| Metric | Value | Buffer |
|--------|-------|--------|
| `buffer_shape` | (695, 1238, 4) | vis_rows≈139 × 5 overscan |
| `non_bg_pixels_total` | **141** | of ~860k cells ≈ **0.016%** |
| `non_bg_pixels_vis` | **38** | essentially blank viewport |
| Book | 1000 levels | full L2 present |

verify contracts (still authoritative):

| Script | Sparse fail criterion |
|--------|----------------------|
| `verify_comprehensive.py` | zone non-bg ≤ 3% **FAIL**; PNG ≤ 5% **FAIL** |
| `verify_v4.py` | coverage < 1% **FAIL** |
| `verify_v2.py` | coverage > 0.2% soft |

gui_diag state would **FAIL** all of the above.

### Causal chain (still in production)

```text
center_price_ticks far from mid  (H-01)
        │
        ▼
bid/ask_rows = buf_h//2 - round(price/rts) + center
        │
        ▼
mask = (rows >= 0) & (rows < buf_h)  → almost all False
        │
        ▼
buffer stays BG_COLOR; only rare historical/ghost pixels remain
```

Numeric check for log numbers (tick 0.01, center 6570058, bid 65656.0):

```text
bid_row ≈ 347 - (6565600 - 6570058) = 347 + 4458 = 4805  ∉ [0, 694]
```

→ **entire book painted off-buffer**. Sparsity is not “missing data”; it is **wrong Y window**.

### Independent sparsity amplifiers (still present)

| Amplifier | Code | Effect |
|-----------|------|--------|
| `np.maximum.at` not sum | density_engine.py:305-315 | Thin walls when many ticks → one row (FIND-P207-02) |
| One-shot tick lock | density_engine.py:119-131 | Wrong vertical scale (FIND-P209-01) |
| `norm > 0.0005` + ratio^2.5 | normalizer + draw | Tiny sizes vanish |
| Default `bid_ref/ask_ref=20000` until symbol thresholds | config.py:19-20 | Washout before adapt (diagnose_density hypothesis) |
| BTC `ticks_per_row=100` after thresholds | source_manager.py:402-405 | Coarser rows; max-not-sum worse |

### Repro

1. Reproduce FIND-HIST-01 desync (BBO off visible range).
2. Count `np.sum(buf[:,:,:3] != BG[:3])` on engine buffer and on visible center slice.
3. Expect total non-bg ≪ 1% despite 500+500 levels.

Alternate (no desync, washed colors):

1. Simulator / small-size book with engine default ref=20000 (before adaptive p98 catch-up).
2. Run `diagnose_density.py` / `verify_v4.py` — low alpha / low coverage.

### Expected

With a populated book and auto-follow, visible heatmap non-bg coverage well above verify floors (≫5% PNG / ≫3% zones) when liquidity exists near mid.

### Actual

gui_diag: 141 total / 38 visible non-bg with full book; product appears “broken empty chart.” Root class still open via H-01 + projection math.

### Fix hint

1. Fix H-01 first (center must track mid) — primary cure for this sparse class.
2. Add assert in diag/tests: if `len(levels) > N` and auto_follow and mid in book span → `non_bg_vis > threshold` else FAIL.
3. Secondary: sum-at collision, tick refine, sane default refs for crypto sizes.

### Evidence

- `/Users/nazmi/flowmap/gui_diag.log`
- R15 §2.1, §3 Pattern C
- `verify_comprehensive.py`, `verify_v4.py`, `diagnose_density.py`
