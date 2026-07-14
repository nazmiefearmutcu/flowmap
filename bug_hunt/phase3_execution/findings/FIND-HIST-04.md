# FIND-HIST-04 — auto_follow=False freezes DensityEngine (BBO/history advance, center/buffer stale)

| Field | Value |
|-------|-------|
| **ID** | FIND-HIST-04 |
| **Severity** | P1 |
| **Theme** | R15 H-01 enabler / navigation |
| **Zones** | Z02, Z16 |
| **Taxonomy** | correctness |
| **Taxonomy_secondary** | input_ux |
| **Status** | confirmed |
| **Location** | `flowmap/ui/heatmap_widget.py:345-405` |
| **Sibling** | FIND-HIST-01, FIND-P243-01, R15 H-01 |
| **Wave** | W1 |
| **Created** | 2026-07-13 |
| **Discovered_by** | Phase-3 HIST hunter |
| **latent** | false |

### Code path

```345:405:flowmap/ui/heatmap_widget.py
    def push_snapshot(...):
        ...
        self._history.append(...)          # ALWAYS advances widget history + BBO store
        self._bbo = bbo
        ...
        if vr != self._last_vis_rows or target_bw != self._last_hm_w:
            self.rebuild_heatmap()
        elif self.auto_follow:
            self._engine.push_snapshot(...)  # centering + draw live column
            ...
        else:
            self._cache_dirty = True
            self.update()                   # engine center_price_ticks UNCHANGED
```

When the user pans price (`scroll_price` sets `auto_follow=False`) or scrolls time:

| State updated | auto_follow True | auto_follow False |
|---------------|------------------|-------------------|
| `_history`, `_bbo`, `_levels` | yes | **yes** |
| `engine.center_price_ticks` | yes (modes) | **no** (unless rebuild) |
| `engine` live column draw | yes | **no** |
| paint BBO overlay | uses widget `_bbo` + **stale** engine center mapping | **desync** |

Overlay BBO lines use `_price_to_screen_y(self._bbo.*)` which depends on **engine** center (`heatmap_widget.py:1457-1458`). So widget BBO is current while Y map is frozen → lines leave the widget; heatmap history columns freeze — classic empty/wrong chart class from gui_diag.

### Repro

1. Start replay/live with follow ON; confirm BBO near mid-screen.
2. Drag price axis up/down several viewport-heights (`scroll_price` → follow OFF).
3. Let market continue (gui_tick still calls `heatmap.push_snapshot`).
4. Observe: engine center frozen; live mid moves; BBO badges/lines move off-screen or sit wrong; buffer not receiving live columns.
5. Press **F** (FIND-P243-01): flag True but **no hard snap**; next pushes only re-center via smooth_deadband rules (HIST-03), not immediate mid snap.

Contrast double-click canvas / Go Live: hard sets center to mid + rebuild (`heatmap_widget.py:2153-2166`).

### Expected

Either:

- (A) While follow off, price pan is intentional freeze — but re-enabling follow must **hard-recenter** to current mid; or  
- (B) Live edge still advances in engine with center fixed (history scroll) and BBO always mapped consistently.

### Actual

Follow off: engine completely starved of `push_snapshot`. Follow re-enable via F: no snap/rebuild. Multi-dollar mid move while panned produces H-01/H-02 symptom class identical to `gui_diag.log`.

### Fix hint

1. `set_auto_follow(True)` / F / Go Live: `_scroll_offset=0`, `center = mid`, `rebuild_heatmap()` (unify with double-click).
2. Optionally still call `engine.push_snapshot(..., auto_follow=False)` when follow off so live edge buffer stays warm (center frozen intentionally).
3. Regression: pan away → F → assert mid in visible band within 1 frame.

### Evidence

- heatmap_widget push branch 391-405
- scroll_price sets auto_follow False (1075-1097)
- FIND-P243-01 (F flag-only)
- R15 H-01 auto_follow True in log (can be sticky flag after partial recovery)
