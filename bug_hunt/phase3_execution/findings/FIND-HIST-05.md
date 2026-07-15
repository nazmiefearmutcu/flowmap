# FIND-HIST-05 — ticks_per_row / center_ticks scale poison + no H-01 regression lock

| Field | Value |
|-------|-------|
| **ID** | FIND-HIST-05 |
| **Severity** | P1 |
| **Theme** | R15 H-01 scale / test gap |
| **Zones** | Z02, Z03 |
| **Taxonomy** | correctness |
| **Taxonomy_secondary** | data_source |
| **Status** | confirmed |
| **Location** | `flowmap/ui/source_manager.py:391-411`; `flowmap/engine/config.py:25`; `flowmap/engine/density_engine.py:183-186,534-535` |
| **Sibling** | FIND-HIST-01, FIND-P209-01/02, R15 H-01, R14 §8.2 |
| **Wave** | W1 |
| **Created** | 2026-07-13 |
| **Discovered_by** | Phase-3 HIST hunter |
| **latent** | false |

### Issue A — center ticks not rescaled when `ticks_per_row` changes

`center_price_ticks` is stored as:

```text
center_price_ticks ≈ round(mid / render_tick_size)
render_tick_size = tick_size * ticks_per_row
```

`update_thresholds_for_symbol` mutates `engine.ticks_per_row` (SOL=2, ETH=10, else BTC=100) and normalizer refs **without**:

- rescaling `center_price_ticks` / `_center_price_ticks_float`
- calling `rebuild_heatmap()`
- resetting `_tick_size_detected`

```391:411:flowmap/ui/source_manager.py
        if hasattr(self._window, 'heatmap') and self._window.heatmap is not None:
            engine = self._window.heatmap._engine
            if "SOLUSDT" in self._symbol:
                engine.ticks_per_row = 2
                ...
            else: # BTCUSDT
                engine.ticks_per_row = 100
                ...
            engine._bid_normalizer.global_ref = engine.config.bid_ref
            ...
```

**Poison example:**

| Step | tpr | mid | center_ticks | Interpreted center price |
|------|-----|-----|--------------|---------------------------|
| 1 Live SOL-ish default | 1 | 65700.58 | 6570058 | 65700.58 ✓ |
| 2 Switch BTC thresholds | **100** | 65656 | **6570058 (stale)** | 6570058 × **$1** = millions ✗ |

Next auto_follow push computes `mid_ticks = 65656` vs center `6570058` → huge delta → snap **if** push runs. Until then (pause, follow off, rebuild with stale seed) viewport is garbage → H-01/H-02.

`price_zoom_in/out` does call `rebuild_heatmap()` after tpr change; **symbol threshold path does not** — inconsistent.

### Issue B — gui_diag numbers match “center in tick_size units”

Log: `engine_center_ticks: 6570058` with `engine_tick_size: 0.01` → price 65700.58.

That encoding is exactly `mid / tick_size` (tpr=1), **or** a leftover integer after tpr flipped without rescale. Both are live risks given defaults `ticks_per_row=1` (`EngineConfig`) until thresholds apply.

### Issue C — no automated lock for H-01 class

| Asset | Role | Gap |
|-------|------|-----|
| `gui_diag.log` | Proves failure class | Not re-run in CI |
| `test_centering_smoothness.py` | Mode metrics | **No pass/fail thresholds** |
| `verify_comprehensive.py` BBO band | 25–75% | **WARN only** (R15: should be FAIL) |
| `tests/test_centering_regression.py` | R14 proposed | **Does not exist** |
| `tests/test_bbo_pipeline.py` | Book BBO only | Does **not** cover engine center / visible range |

H-01 can regress forever without a red test.

### Repro A

1. Start session; force `engine.ticks_per_row = 1`; push until center_ticks ≈ mid/0.01.
2. Call path equivalent to `update_thresholds_for_symbol` BTC branch (`tpr=100`) without rebuild.
3. Read `_price_min`/`_price_max` before next push → absurd range or empty paint.
4. Optionally set `auto_follow=False` first so snap does not heal (HIST-04).

### Repro C

1. `rg test_centering_regression /Users/nazmi/flowmap` → no file.
2. Run `test_centering_smoothness.py` with intentional broken mode → still exits 0.

### Expected

1. Any change to `ticks_per_row` or `tick_size` rescales center:  
   `center_new = round(center_old * old_rts / new_rts)` then rebuild.
2. Symbol thresholds trigger rebuild + optional engine.reset on symbol change (reset exists on heatmap but tpr applied before/after inconsistently).
3. CI unit: after N auto_follow ticks, mid inside visible band; tpr change preserves mid on-screen.

### Actual

tpr mutation can desynchronize integer center from price; diagnostics only WARN; no regression suite for gui_diag class.

### Fix hint

```python
def set_ticks_per_row(self, new_tpr: int) -> None:
    old_rts = self.render_tick_size
    if self.center_price_ticks is not None and old_rts > 0:
        price = self.center_price_ticks * old_rts
        self.config.ticks_per_row = max(1, new_tpr)
        new_rts = self.render_tick_size
        self.center_price_ticks = int(round(price / new_rts))
        self._center_price_ticks_float = float(self.center_price_ticks)
    else:
        self.config.ticks_per_row = max(1, new_tpr)
    # caller: heatmap.rebuild_heatmap()
```

Plus `tests/test_centering_regression.py` from R14 matrix; verify BBO → FAIL.

### Evidence

- source_manager.py update_thresholds_for_symbol
- EngineConfig ticks_per_row default 1
- gui_diag.log center integer
- R14 §6 / §8.2 missing centering regression
- R15 H-01 still “Likely YES”
