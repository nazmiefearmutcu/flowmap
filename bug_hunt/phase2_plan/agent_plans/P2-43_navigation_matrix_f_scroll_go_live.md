# P2-43 — Navigation Matrix (F / Scroll / Go Live)

| Field | Value |
|-------|-------|
| **Agent** | P2-43 |
| **Theme n** | 43 |
| **Track** | E — UX |
| **Zones** | **Z16** (Input / navigation) |
| **Siblings** | R08 H4/H5/H12, R18 UX-*, R20 P1-11 |
| **Severity prior** | **P1** (auto-follow desync → user loses live edge) |
| **Focus** | `auto_follow`, `scroll_offset`, F key, Go Live button, drag, Esc/L |

---

## 1. Scope & linked zones / sibling hyps

### Primary files
- `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py` — `auto_follow`, `_scroll_offset`, mouse/key, Go Live hit-test
- `/Users/nazmi/flowmap/flowmap/ui/main_window.py` — `F` key, status `"Auto-follow: ON/OFF"`
- R18 §2.7, §3.1–3.2, CUA-19–21, CUA-28

### State variables (truth)

| Var | Meaning |
|-----|---------|
| `heatmap.auto_follow` | When True, stick to live edge; `_scroll_offset` forced 0 on push |
| `heatmap._scroll_offset` | Columns back from live |
| On-canvas `"↩ Go Live"` | Visible when `!auto_follow` (and scrolled) |
| MainWindow `F` | Toggles `auto_follow` only (does **not** zero scroll by itself — **verify**) |
| Heatmap `L` / `Esc` | Force go-live: auto_follow ON, scroll=0, rebuild |
| Double-click main | Go live + recenter mid |
| Double-click price axis | Recenter mid only |
| LMB drag timeline | Sets auto_follow iff scroll_offset==0 |
| LMB on Go Live | auto_follow ON, scroll=0, rebuild |

### Sibling hyps
- R08 H4/H5: auto-follow / scroll desync
- R18 UX-21: Go Live hit-test fixed geometry / HiDPI miss
- R20 P1-11: Auto-follow / F / scroll_offset desync

---

## 2. Threat model

| Bug class | Symptom |
|-----------|---------|
| F toggles flag but leaves scroll_offset > 0 | Status says ON but still viewing history |
| auto_follow True but push path increments offset | Drift from live |
| Go Live paint rect ≠ hit-test rect | Button visible but unclickable |
| Drag sets follow inconsistently | Flicker between live/history |
| Focus: F handled by MainWindow only when heatmap unfocused | User clicks heatmap, F may not reach MainWindow (or does via parent?) — **verify event propagation** |
| Reset R vs Esc/L vs Go Live | Three paths diverge on row_height / col_w |

---

## 3. Concrete probes

### 3.1 State machine unit test (headless HeatmapWidget)

```python
# For each transition, assert (auto_follow, scroll_offset, go_live_visible)
transitions = [
  ("init",),
  ("scroll_time(+50)",),
  ("press_F_via_main",),  # if can simulate
  ("force_go_live_L",),
  ("drag_left",),
  ("drag_to_zero",),
  ("double_click_main",),
  ("reset_view_R",),
]
```

### 3.2 Static audit

```bash
rg -n "auto_follow|_scroll_offset|Go Live|scroll_time|scroll_price|reset_view" \
  /Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py \
  /Users/nazmi/flowmap/flowmap/ui/main_window.py
```

Document every writer of `auto_follow` and `_scroll_offset`.

### 3.3 GUI (CUA) — R18 scenarios

| CUA | Focus |
|-----|-------|
| CUA-19 | F toggle status |
| CUA-20 | Drag history + Go Live click |
| CUA-21 | Double-click recenter variants |
| CUA-28 | Arrows + Esc/L |
| CUA-29 | R reset |

**Critical assertion set:**

| After action | auto_follow | scroll_offset | Go Live visible | Status |
|--------------|-------------|---------------|-----------------|--------|
| Launch running | True | 0 | No | — |
| Drag history left | False | >0 | Yes | — |
| Click Go Live | True | 0 | No | — |
| F once (from live) | False | 0? | ? | Auto-follow: OFF |
| F twice | True | ? | ? | ON |
| Esc from history | True | 0 | No | — |

### 3.4 HiDPI Go Live hit-test

1. Scale display 2x / Retina.
2. Screenshot Go Live location.
3. Click center of painted button vs corners.
4. Fail if paint shows button but click misses (UX-21).

### 3.5 Race: new columns while scrolled

While `scroll_offset > 0` and running, ensure history view does not jump incorrectly (auto_follow false → offset increments on push — R18 code note). Verify intended “frozen history window” semantics.

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| NAV-P1 | Single documented state machine; all writers consistent | Conflicting writers |
| NAV-P2 | F OFF + scroll=0 shows intentional non-follow without fake Go Live OR Go Live only when offset>0 | Confusing dual meaning of auto_follow |
| NAV-P3 | Go Live click always recovers live edge | Unclickable / partial |
| NAV-P4 | Esc/L/double-click main/Go Live all reach same live state | Divergent residual offsets |
| NAV-P5 | Status bar matches actual follow state | Status lies |

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| Running live or replay with continuous column advance | Scroll tests |
| Deterministic simulator if wired (P2-49) | Repeatable |
| Screenshot regions: Go Live rect | Hit-test |
| Accessibility dump of focus widget | F key routing |

---

## 6. Phase-3 micro-tasks

| Hunt | Work |
|------|------|
| **H-43A** | Static map all auto_follow / scroll_offset writers + state diagram mermaid |
| **H-43B** | Headless transition matrix unit tests |
| **H-43C** | CUA-19/20/21/28/29 automation + findings |
| **H-43D** | HiDPI / geometry Go Live hit-test |
| **H-43E** | F key focus routing (MainWindow vs Heatmap StrongFocus) |

---

## 7. Expected finding IDs — `FIND-P243-XX`

| ID | Sev | Title |
|----|-----|-------|
| FIND-P243-01 | P1 | F toggles auto_follow without clearing scroll_offset |
| FIND-P243-02 | P1 | auto_follow True with offset≠0 inconsistency |
| FIND-P243-03 | P1 | Go Live hit-test miss (HiDPI) |
| FIND-P243-04 | P2 | Status Auto-follow desync |
| FIND-P243-05 | P2 | Drag edge: follow re-enable only at 0 |
| FIND-P243-06 | P2 | R vs Esc/L residual zoom differences undocumented |
| FIND-P243-07 | P1 | Offset increment while scrolled causes wrong “history” window |

---

## 8. Fix strategy sketch

1. **Canonical go_live()** method: `auto_follow=True; scroll_offset=0; rebuild()`.
2. All entry points (button, Esc, L, double-click, F-when-ON-from-history?) call it.
3. **F semantics:** document: F only toggles follow; if enabling follow, also clear offset (recommended).
4. Go Live use **widget** or compute hit-test from same rect as paint (devicePixelRatio aware).
5. Unit tests for state machine as regression.

---

## 9. Dependencies

| Theme | Link |
|-------|------|
| P2-44 | Wheel also mutates scroll / zoom |
| P2-50 | CUA automation harness |
| P2-29 | Resize may interact with scroll |
| P2-08 | Buffer scroll clear-right |

---

## 10. Severity priors

R20 P1-11, R08 H4/H5 → **P1**. Hit-test miss → **P1** UX. Pure docs → **P3**.
