# FIND-SEC-06

| Field | Value |
|-------|-------|
| **ID** | FIND-SEC-06 |
| **Severity** | P3 |
| **Status** | CONFIRMED |
| **Title** | FeaturesDetailDialog imported but never opened |
| **Theme / Zones** | Z20 UX · secondary expand of R10 §9 / R18 UX-04 |
| **Taxonomy** | input_ux |
| **Location** | `flowmap/ui/panels/features_dialog.py`; import `flowmap/ui/main_window.py:26` |
| **Sibling** | R10 §9; R18 UX-04; CUA-40; P2_findings_schema §12 “Features dialog dead” |
| **Wave** | W secondary |
| **Discovered by** | phase3-hunter-sec |

### Problem

`FeaturesDetailDialog` is a full dark-themed QDialog (9 feature cards, ~marketing/help content). It is:

- Implemented in `panels/features_dialog.py`  
- Re-exported from `panels/__init__.py`  
- **Imported** in `MainWindow`  
- **Never constructed** — no menu action, toolbar button, or shortcut calls `.exec()` / `.show()`

Dead import adds maintenance noise and false expectation that Help → Features exists. CUA matrix (R18) lists dialog as unreachable.

### Repro

```bash
rg -n "FeaturesDetailDialog" flowmap --glob '*.py'
# main_window import only; class def; panels __init__
# No .exec(, no show(, no QAction wiring
```

Launch app → open View / menus / sidebar — no entry opens Features dialog.

### Expected

Wire Help/About → Features dialog **or** remove unused import and ship dialog only when product wants it.

### Actual

Import-only dead path; dialog unreachable in default build.

### Fix hint

Add `QAction("Features…")` under Help that does `FeaturesDetailDialog(self).exec()`, or drop import to avoid unused-code drift.

### Evidence

- `main_window.py:26` import; `_setup_ui` / menus never reference the name.  
- R10 §9: “No orchestration role. Not opened from MainWindow.”  
- R18 UX-04 P2 Features dialog dead code.
