# Wave1 RENDER/VP/UX — Static hunt report

**Agent:** Phase-3 Wave1 RENDER/VP/UX  
**Date:** 2026-07-13  
**Plans:** P2-25..34, P2-43, P2-44  
**Files:** `heatmap_widget.py`, `volume_profile.py`, `bubbles.py`, `pulse.py`, `dom_ladder.py` (+ `density_engine.resize`, `main_window` nav, README)

## Confirmation matrix (user targets)

| Target | Result | FIND |
|--------|--------|------|
| Resize blank history H15 | **CONFIRMED** | FIND-P229-01 (+ dead flag FIND-P229-02) |
| Rebuild freeze risk | **CONFIRMED** | FIND-P226-01 |
| QImage ownership | **CONFIRMED** | FIND-P228-01 |
| VP Y skew | **CONFIRMED** | FIND-P234-01 |
| Bubbles BUY-only | **CONFIRMED** | FIND-P232-01 |
| Pulse scroll desync | **CONFIRMED** | FIND-P232-02 |
| DOM not BBO-centered | **CONFIRMED** | FIND-P233-01 |
| Wheel/key conflicts | **CONFIRMED** | FIND-P244-01, FIND-P244-02 |

## Additional related finds (same wave)

| ID | Sev | Topic |
|----|-----|-------|
| FIND-P232-03 | P1 | Trade stamp before frame++ → 1-col lag |
| FIND-P243-01 | P1 | F toggle without scroll zero/rebuild |
| FIND-P243-02 | P2 | reset_view keeps scroll_offset |
| FIND-P233-02 | P2 | DOM wheel no-op |
| FIND-P225-01 | P2 | OpenGL surface-only + CI dual path |
| FIND-P227-01 | P2 | Throttle singleShot / pending races |
| FIND-P230-01 | P2 | Percentile hitch on every trade batch |
| FIND-P226-02 | P2 | rebuild omits view_changed on success |

## Counts

- **New findings this wave:** 18  
- **P0:** 2 (P229-01, P226-01)  
- **P1:** 9  
- **P2:** 7  
- Registry: `bug_hunt/phase3_execution/FINDINGS_REGISTRY.md`  
- Detail files: `bug_hunt/phase3_execution/findings/FIND-P2*.md`

## Method

Static code audit only (no GUI CUA this wave). Cross-checked Phase-1 hyps R08/R09/R11/R12/R18 and Phase-2 agent plans against current line anchors.
