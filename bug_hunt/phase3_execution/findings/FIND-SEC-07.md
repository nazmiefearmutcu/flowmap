# FIND-SEC-07

| Field | Value |
|-------|-------|
| **ID** | FIND-SEC-07 |
| **Severity** | P3 |
| **Status** | CONFIRMED |
| **Title** | PriceChart module orphaned; stale MainWindow layout docs |
| **Theme / Zones** | Z04 overlays · secondary expand of R11 BH-R11-10 / R10 layout drift |
| **Taxonomy** | input_ux · rendering (if re-enabled misaligned) |
| **Location** | `flowmap/ui/price_chart.py`; docstring `flowmap/ui/main_window.py:3`, comment L65; defensive resets `source_manager.py:165–166`, `429–430` |
| **Sibling** | R11 BH-R11-10; R10 §1 layout notes |
| **Wave** | W secondary |
| **Discovered by** | phase3-hunter-sec |

### Problem

`PriceChart` is a complete mid-price line widget designed to sit above the heatmap with shared time axis. Production UI never constructs it:

- `_setup_ui` builds Heatmap + VolumeProfile + MarketPulse only  
- No `self.price_chart = PriceChart(...)`  
- `push_price` is never called from the GUI pipeline  
- `SourceManager` still has `hasattr(..., 'price_chart')` reset hooks (noop)  
- Module docstring on MainWindow still claims **“PriceChart (top 22%) + HeatmapWidget (bottom 78%)”** — false

If re-mounted without shared axis (`bw`, `frame_count`, scroll), chart X/Y will not align with heatmap columns (R11 §3.4 / §7).

### Repro

```bash
rg -n "PriceChart|price_chart|push_price" flowmap --glob '*.py'
# Class in price_chart.py; export ui/__init__; defensive hasattr in source_manager
# No instantiation in main_window._setup_ui
```

Visual: app chrome has no top price line strip above heatmap.

### Expected

Either integrate chart with shared time index and feed mid each `push_snapshot`, or remove/quarantine module and fix stale docstrings so layout docs match reality.

### Actual

Orphan module + defensive dead reset + misleading module header.

### Fix hint

Minimal doc fix: update MainWindow module docstring. Product path: construct PriceChart row 0, re-grid heatmap to row 1, call `push_price(mid)` from `_gui_tick` using engine frame index for X alignment.

### Evidence

- `main_window._setup_ui` lines 91–116 — no PriceChart.  
- R11 BH-R11-10; R10 table “Docstring PriceChart top 22% — Stale.”  
- `price_chart.py` private tick deque independent of heatmap `frame_count`.
