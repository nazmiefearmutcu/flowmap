# FIND-HIST-03 — smooth_deadband thresholds in row-ticks allow sustained BBO off-center

| Field | Value |
|-------|-------|
| **ID** | FIND-HIST-03 |
| **Severity** | P1 |
| **Theme** | R15 Pattern B — centering jitter vs lag |
| **Zones** | Z02 |
| **Taxonomy** | correctness |
| **Taxonomy_secondary** | rendering |
| **Status** | confirmed |
| **Location** | `flowmap/engine/density_engine.py:215-233`; `flowmap/engine/config.py:22-24`; `flowmap/ui/source_manager.py:402-405` |
| **Sibling** | R15 H-01/H-04, FIND-HIST-01, test_centering_smoothness.py |
| **Wave** | W1 |
| **Created** | 2026-07-13 |
| **Discovered_by** | Phase-3 HIST hunter |
| **latent** | false |

### Mechanism (current code)

Default mode `smooth_deadband` with:

| Param | Default | Role |
|-------|---------|------|
| `centering_deadband_pct` | 0.35 | start EMA drift if `\|Δ\| > 0.35 * v_rows` |
| `centering_ema_alpha` | 0.05 | slow track while drifting |
| hard snap | `\|Δ\| > v_rows // 2` | only when mid leaves half viewport |

```215:233:flowmap/engine/density_engine.py
                    elif self.centering_mode == "smooth_deadband":
                        deadband = max(1, int(self.centering_deadband_pct * v_rows))
                        current_mid_ticks_int = int(round(mid_ticks_float))
                        delta_ticks = current_mid_ticks_int - self.center_price_ticks
                        if abs(delta_ticks) > v_rows // 2:
                            new_center_ticks = current_mid_ticks_int
                            ...
                        elif abs(delta_ticks) > deadband or self._in_recenter_drift:
                            # EMA toward mid (alpha=0.05)
                            ...
                        else:
                            self._center_price_ticks_float = float(self.center_price_ticks)
```

`mid_ticks` / `center_ticks` are in **render ticks** (`price / (tick_size * ticks_per_row)`).

### BTC scaling problem

After `update_thresholds_for_symbol` for BTC:

- `ticks_per_row = 100`, `tick_size ≈ 0.01` → `render_tick_size = 1.0` ($1 per row)
- Typical `v_rows ≈ height/row_height ≈ 557/4 ≈ 139`

| Threshold | Rows | USD (BTC) | Product impact |
|-----------|------|-----------|----------------|
| Deadband hold | 0.35×139 ≈ **48** | **~$48** | Mid can sit ≤$48 off center with **zero** recentering |
| Half-viewport snap | 139//2 = **69** | **~$69** | Hard snap only for larger jumps |
| verify 25–75% band | ±0.25×139 ≈ **35 rows** | **~$35** | Offset $36–$48 → **BBO fails 25–75% while still “following”** |

EMA α=0.05 means after drift starts, lag remains large under continuous trend (R15 Pattern B).

### Relation to gui_diag ($44)

If log state was under **tpr=100**, a ~$44 mid/center gap sits **inside deadband hold** (no EMA, no snap) → auto_follow True + sustained off-center is **by design of current thresholds**, not only a one-off race.

If log was under **tpr=1**, $44 ≫ $0.69 snap threshold → requires frozen push path (FIND-HIST-04) or corrupted center scale (FIND-HIST-05). Both classes still exist.

### Repro (unit-level)

```python
# EngineConfig centering_mode=smooth_deadband, tpr=100, tick_size=0.01
# resize vis_rows=139
# seed center at mid0
# jump mid by +40 USD without exceeding 69
# assert after push: center still ~mid0 (deadband hold)
# assert mid not in 25-75% of visible band
```

Or run `test_centering_smoothness.py` and observe `avg_dist_to_mid` with **no fail threshold** (script never fails).

### Expected

Under auto_follow, mid stays near viewport center (e.g. within deadband **and** within verify 25–75%). Lag modes must not leave BBO outside the product band for multi-dollar BTC moves that still fit in the window.

### Actual

Deadband/snap are row-count based; with BTC tpr=100 they become **tens of dollars**. Follow can report ON while BBO is off-center enough to empty the useful band and fail visual contracts.

### Fix hint

1. Express deadband/snap in **price dollars or fraction of visible price range**, not only raw row ticks — or scale pct when tpr changes.
2. Cap max lag: if `|mid-center| > k * visible_half` with k≤0.5, snap (verify-aligned).
3. Make `test_centering_smoothness` assertive (max `avg_dist_to_mid` in render-tick units).
4. Optional: on trend, raise EMA alpha or use `immediate` for crypto defaults.

### Evidence

- density_engine smooth_deadband block
- EngineConfig defaults
- source_manager BTC `ticks_per_row=100`
- R15 §3 Pattern B
- `test_centering_smoothness.py` (metrics only, no asserts)
