# P2 GUI Automation Matrix — cua-driver / mac-computer-use

**Path:** `/Users/nazmi/flowmap/bug_hunt/phase2_plan/P2_gui_automation_matrix.md`  
**Primary research:** R18_ux_input_gui_matrix.md  
**Owner theme:** P2-50  
**Tooling:** cua-driver daemon + mac-computer-use MCP  
**Apps:** Standalone FlowMap; optional `dist/FlowMap.app`; Crypcodile embed  

---

## 1. Goals

1. Unattended smoke of launch / stop / quit / replay / input matrix.  
2. Evidence screenshots for Phase-3 findings.  
3. Regression gate before Phase-4 merges that touch UI.  
4. Map every user control to ≥1 automated scenario.

---

## 2. Environment

| Item | Value |
|------|-------|
| Launch | `python /Users/nazmi/flowmap/run_flowmap.py` |
| Packaged | `/Users/nazmi/flowmap/dist/FlowMap.app` |
| Display | macOS interactive session (computer-use) |
| Auto-start | LIVE connect @ t+500ms — wait ≥1–2s |
| Mutex | **One** GUI automation agent at a time per machine |
| Evidence root | `phase3_execution/cua_shots/` |

### Renderer

| Env | Effect |
|-----|--------|
| unset | Prefer OpenGL widget path |
| `FLOWMAP_RENDERER=cpu` | CPU QWidget paint — safer for CI-like |

---

## 3. Application states (assert targets)

| ID | Meaning | Start btn | Status pattern |
|----|---------|-----------|----------------|
| S0 | Idle/Ready | Start | Ready / help keys |
| S1 | Connecting Live | Start often | Connecting… |
| S2 | Running Live | Stop | `[LIVE]` Bid/Ask |
| S3 | Running Replay | Stop | `[REPLAY]` Bid/Ask / progress |
| S4 | Stopped | Start | stopped then help |
| S5 | Error | Start usually | `Error:` |
| S6 | Auto-start race 0–500ms | flipping | changing |
| S7 | Scrolled history | Stop if running | Go Live on canvas |

`_gui_tick` drains **only if** `source.running` — stopped freezes heatmap.

---

## 4. Control surface inventory → automation

### 4.1 Toolbar

| Control | Selector | Scenarios |
|---------|----------|-----------|
| Symbol | `Symbol:` field | CUA-04, 05, 36 |
| Start/Stop | `▶ Start` / `■ Stop` | CUA-02, 35, 50 |
| Sidebar | `Sidebar` | CUA-10, 11 |

**Absent (assert missing):** source combo, replay speed spinner — CUA-41.

### 4.2 View menu

| Action | Scenarios |
|--------|-----------|
| DOM Ladder | CUA-17, 34 |
| Significant Icebergs | CUA-17, 45 |
| Large Lot Tracker | CUA-17 |
| Market Pulse (CVD) | CUA-18 |

### 4.3 Sidebar tabs

| Tab | Controls | Scenarios |
|-----|----------|-----------|
| VISUALS | heatmap/BBO/trades/VP/COB/CVP/SVP | CUA-12, 13 |
| INDICATORS | LLT, iceberg, stops, pulse overlay | CUA-14–16, 18 |
| SETTINGS | docks, replay, speed, centering, filters, sliders | CUA-06–09, 31–33 |

### 4.4 Heatmap gestures

| Input | Scenarios |
|-------|-----------|
| Drag time / price axis | CUA-20, 21 |
| Wheel ± Ctrl axis/main | CUA-22–24 |
| Go Live click | CUA-20 |
| Keys +/− R L Esc ←→ | CUA-25–29 |
| Hover | CUA-44 |

### 4.5 Global keys (MainWindow)

| Key | Scenarios |
|-----|-----------|
| Space | CUA-03 |
| F | CUA-19 |
| +/− R D | CUA-25, 29, 30 |

---

## 5. Full scenario matrix (50)

| ID | Title | Precond | Primary asserts | Owner | Wave |
|----|-------|---------|-----------------|-------|------|
| CUA-01 | Cold launch auto-start | clean launch | S1/S2/S5 not stuck | 50/48 | C0 |
| CUA-02 | Start/Stop button | running | label + freeze | 50 | C0 |
| CUA-03 | Space toggle | FOCUS_MAIN | same as 02 | 50 | C2 |
| CUA-04 | Symbol commit | — | symbol+thresholds | 50 | C1 |
| CUA-05 | Empty symbol revert | — | restore | 50 | C1 |
| CUA-06 | Enable Replay | sidebar | [REPLAY] | 50 | C1 |
| CUA-07 | Replay start data | lake | BBO+columns | 50/39 | C1 |
| CUA-08 | Replay speed | S3 | rate change | 50/19 | C1 |
| CUA-09 | Replay off → live | S3 | [LIVE] | 50/21 | C1 |
| CUA-10 | Sidebar toggle | — | panel | 50 | C5 |
| CUA-11 | Sidebar hide trap | — | toolbar recover | 50 | C5 |
| CUA-12 | Hide visual layers | S2/S3 | pixels | 50/25 | C5 |
| CUA-13 | VP master/children | — | strip | 50/34 | C5 |
| CUA-14 | LLT toggle/thresh | S2 | dock rows | 45 | C5 |
| CUA-15 | LLT dual spinner | — | desync UX-07 | 45 | C4 |
| CUA-16 | Iceberg clear/filter | dock | rows | 45 | C5 |
| CUA-17 | View docks | — | bi-sync | 50 | C5 |
| CUA-18 | Pulse View vs overlay | — | UX-06 | 50 | C4 |
| CUA-19 | F auto-follow | FOCUS_MAIN | status | 43 | C2 |
| CUA-20 | Drag + Go Live | S2 | live edge | 43 | C2 |
| CUA-21 | Double-click recenter | S2 | mid/live | 43 | C2 |
| CUA-22 | Wheel price axis | — | zoom vs pan | 44 | C2 |
| CUA-23 | Wheel main TF | — | col width | 44 | C2 |
| CUA-24 | README Ctrl myth | — | pans not zoom | 44 | C3 |
| CUA-25 | +/− main focus | status focus | row_height | 44 | C2 |
| CUA-26 | +/− heatmap focus | heatmap | ticks_per_row | 44 | C2 |
| CUA-27 | Ctrl/Shift +/− | heatmap | multi-axis | 44 | C2 |
| CUA-28 | Arrows Esc/L | heatmap | scrub/live | 43 | C2 |
| CUA-29 | R reset | scrolled | defaults | 43 | C2 |
| CUA-30 | D decay | SETTINGS | 0.88 jump | 50 | C2 |
| CUA-31 | Sliders smoke | SETTINGS | no crash | 50 | C5 |
| CUA-32 | Centering combo | S2 | no throw | 50 | C5 |
| CUA-33 | Min order filter | S2 | thinner map | 50 | C5 |
| CUA-34 | DOM perf | S2 | <2s | 33 | C5 |
| CUA-35 | Start/Stop spam | — | no zombie | 21/17 | C4 |
| CUA-36 | Symbol spam | — | consistent | 21 | C6 |
| CUA-37 | Splitter | — | paint | 50 | C6 |
| CUA-38 | Resize window | — | no blank H15 | 29 | C6 |
| CUA-39 | CVD color menu | pulse | mode | 50 | C5 |
| CUA-40 | Features absent | — | not found | 50 | C3 |
| CUA-41 | Source combo absent | — | not found | 50 | C3 |
| CUA-42 | Replay no data | empty dir | error recover | 47 | C1 |
| CUA-43 | Live disconnect | live | Start not stuck | 17/06 | C4 |
| CUA-44 | Hover price | S2 | race doc | 50 | C4 |
| CUA-45 | Dock close X | — | checkbox | 50 | C5 |
| CUA-46 | Tab nav | — | access | 50 | C5 |
| CUA-47 | Quit clean | running | exit <5s | 17/19 | C0 |
| CUA-48 | Drag+Space | S7 | no crash | 43 | C6 |
| CUA-49 | Sensitivity vs symbol | — | UX-20 | 50 | C6 |
| CUA-50 | Smoke suite | — | 01,02,06,07,10,12,17,20,22,25,29,47 | 50 | C6 |

Detailed step scripts: `agent_plans/P2-50_cua_driver_gui_matrix.md` §4.

---

## 6. Automation step patterns (mac-computer-use)

```text
LAUNCH:
  run shell launch → wait title FlowMap → sleep 2 → screenshot

CLICK_TEXT "■ Stop":
  screenshot → locate → left_click center

TYPE_SYMBOL s:
  click Symbol field → hotkey cmd+a → type_text s → press_key Tab

KEY_MAIN k:
  click status bar → press_key k

WHEEL_AT (x,y, dx, dy, ctrl):
  move (x,y) → if ctrl: hold → scroll → release

ASSERT_STATUS contains substr:
  screenshot OCR / accessibility dump → fail if missing after timeout
```

### On-canvas only (no widget)

| Target | Method |
|--------|--------|
| Go Live | OCR `↩ Go Live` or fixed bottom-right of heatmap ROI |
| BBO lines / density | pixel sampling optional |
| Trade bubbles | visual |

---

## 7. CUA execution waves (ops)

| Wave | IDs | Parallelism | Exit |
|------|-----|-------------|------|
| **C0** | 01, 02, 47 | serial | Process lives; stop works; quit clean |
| **C1** | 04–09, 42 | serial | Replay path green or skip+ticket |
| **C2** | 03, 19–30 | serial | Input matrix logged |
| **C3** | 24, 40, 41 | serial | Docs FINDs filed |
| **C4** | 15, 18, 35, 43, 44 | serial | Desync FINDs |
| **C5** | 10–14, 16–17, 31–34, 39, 45–46 | serial | Visual/docks |
| **C6** | 36–38, 48–50 | serial | Edges + suite |
| **C7** | 01, 02, 42, 47 on **.app** | serial | Packaging |

**Do not** run C2–C6 before W1 data-plane signoff if live is unusable (use replay/sim).

---

## 8. Evidence & reporting

| Artifact | Path pattern |
|----------|--------------|
| Shot | `phase3_execution/cua_shots/CUA-{nn}_{slug}.png` |
| Log | `phase3_execution/cua_logs/run_{ts}.jsonl` |
| Suite summary | `phase3_execution/cua_logs/suite_latest.json` |

Suite JSON:

```json
{
  "run_id": "...",
  "results": [
    {"id": "CUA-01", "pass": true, "ms": 2400, "findings": []},
    {"id": "CUA-24", "pass": true, "ms": 800, "findings": ["FIND-P244-01"]}
  ]
}
```

Findings schema: `P2_findings_schema.md`. Product bugs → owner theme IDs.

---

## 9. Flake policy

| Observation | Action |
|-------------|--------|
| Fail 1/3 auto-start | Increase wait; FIND-P250-01 if persistent |
| OCR miss | Prefer button text match / a11y |
| Live network down | Mark skip or use replay |
| Retina coords | Scale factor from screen_info |

---

## 10. Zones covered

| Zone | Via |
|------|-----|
| Z01 Paint | screenshots CUA-12, 20, 38 |
| Z16 Input | CUA-19–30 |
| Z20 Package | C7 |
| Z15 Heuristics docks | CUA-14–16 |
| Z10 Switch | CUA-06–09, 35–36 |
| Z07 Replay | CUA-07–08 |

---

## 11. Crypcodile embed CUA (optional)

Reuse macros; window title may differ (`FlowmapWindow`). Existing:  
`/Users/nazmi/Crypcodile/tests/gui/test_flowmap_gui_cua.py`  

Add: hist visible before auto-live; symbol field ETH path — ownership P2-42.

---

## 12. Phase-3 agent assignment template

| Agent slot | Scenarios |
|------------|-----------|
| G1 | C0 |
| G2 | C1 |
| G3–G4 | C2 |
| G5 | C3–C4 |
| G6 | C5 |
| G7 | C6 |
| G8 | C7 package |
| G9 | Suite aggregator + flake triage |

All slots **serialized** on shared display calendar.
