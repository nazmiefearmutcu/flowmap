# FIND-HIST-01 — H-01 BBO / engine center / visible range desync still open

| Field | Value |
|-------|-------|
| **ID** | FIND-HIST-01 |
| **Severity** | P0 |
| **Theme** | R15 historical / Pattern A vertical alignment |
| **Zones** | Z02, Z16 |
| **Taxonomy** | correctness |
| **Taxonomy_secondary** | rendering |
| **Status** | confirmed |
| **Location** | `flowmap/engine/density_engine.py:182-248`; `flowmap/ui/heatmap_widget.py:280-316,345-405` |
| **Sibling** | R15 H-01, R14 §4.1, FIND-HIST-02..05, FIND-P243-01 |
| **Wave** | W1 |
| **Created** | 2026-07-13 |
| **Discovered_by** | Phase-3 HIST hunter (gui_diag + code path audit) |
| **latent** | false |

### Artifact (smoking gun — unrebutted)

`/Users/nazmi/flowmap/gui_diag.log`:

```
bbo: bid=65656.0 ask=65656.01
engine_center_ticks: 6570058
engine_tick_size: 0.01
visible_price_range: 65699.8900 - 65701.2700
auto_follow: True
widget_size: 1300x557  row_height: 4
non_bg_pixels_total: 141
non_bg_pixels_vis: 38
levels count: 1000  (500 bid + 500 ask at BBO)
```

| Quantity | Value | Implication |
|----------|-------|-------------|
| Book mid | ~65656.005 | True market mid (levels top-of-book matches) |
| Engine center | 6570058 × 0.01 ≈ **65700.58** | ~**$44.58** above mid |
| Visible window | 65699.89 – 65701.27 (~$1.38 wide) | **Does not contain BBO** |
| auto_follow | **True** | Product contract violated |

### Current code paths (still present)

1. **Centering modes** default `smooth_deadband` (`EngineConfig.centering_mode`, config.py:22).
2. **Visible range** is pure function of `center_price_ticks` × `render_tick_size` (`heatmap_widget.py` `_price_min`/`_price_max`) — no independent BBO clamp.
3. **Live paint** maps levels with  
   `row = buf_h//2 - round(price/render_tick_size) + center_price_ticks`  
   (`density_engine.py:305-313`). Off-center mid → levels leave buffer → empty chart (H-02).
4. **No regression test** locks `mid ∈ visible` under `auto_follow` (R14 proposed `test_centering_regression.py` — **missing**).
5. **verify_comprehensive** still rates BBO-out-of-band as **WARN** only (not FAIL).

### Why still reachable (not historical-only)

| Mechanism | File | Still live? |
|-----------|------|-------------|
| smooth_deadband lag / deadband hold | density_engine.py:215-233 | YES — see FIND-HIST-03 |
| `auto_follow=False` skips engine push | heatmap_widget.py:391-405 | YES — FIND-HIST-04 |
| F / `set_auto_follow` no hard snap | heatmap_widget.py:1034-1035 | YES — FIND-P243-01 |
| Double-click hard-snaps mid; F does not | heatmap_widget.py:2135-2166 | Asymmetry still present |
| ticks_per_row change without center rescale | source_manager.py:391-405 | YES — FIND-HIST-05 |

With continuous auto_follow push and large mid jump, `abs(delta) > v_rows//2` **should** snap. The gui_diag state proves a real session reached “follow ON + BBO off-screen”; code still admits multiple ways to re-enter that class.

### Repro

1. Launch FlowMap; source Crypcodile Replay; symbol `binance-spot:BTCUSDT`; Start.
2. Manually drag price axis so center is ≥ half-viewport away from mid (or wait for lag under trend — HIST-03).
3. Press **F** to ensure status “Auto-follow: ON” (does not hard-snap).
4. Dump or assert: `heatmap._bbo` mid vs `_price_min`/`_price_max`.
5. Or re-run diagnostic that produced `gui_diag.log` and compare fields.

### Expected

With `auto_follow=True`, mid (and preferably BBO) always lies in the visible price band; verify 25–75% vertical band (or stricter deadband of center).

### Actual

Historical log + current logic: center can sit ~$44 off mid while follow is True; visible ~$1.4 band excludes BBO; heatmap empty.

### Fix hint

1. Hard invariant after every `push_snapshot` when `auto_follow`: if `|mid_ticks - center_ticks| > deadband_or_half_vis`, snap immediately (and on F/Go Live).
2. `set_auto_follow(True)` → same as double-click go-live: scroll=0, center=mid, rebuild.
3. Unit: `tests/test_centering_regression.py` — after N ticks with follow, `mid ∈ [price_min, price_max]`.
4. Upgrade verify BBO check from WARN → FAIL.

### Evidence

- `/Users/nazmi/flowmap/gui_diag.log`
- `/Users/nazmi/flowmap/bug_hunt/phase1_research/R15_known_issues_history.md` §2.1
- `/Users/nazmi/flowmap/bug_hunt/phase1_research/R14_tests_diagnostics.md` §4.1
- `/Users/nazmi/flowmap/verify_comprehensive.py` (~BBO 25–75% WARN)
