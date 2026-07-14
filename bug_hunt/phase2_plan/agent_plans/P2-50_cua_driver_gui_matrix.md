# P2-50 — cua-driver / mac-computer-use GUI Matrix

| Field | Value |
|-------|-------|
| **Agent** | P2-50 |
| **Theme n** | 50 |
| **Track** | E — GUI automation |
| **Zones** | **Z01**, **Z16**, **Z20** |
| **Siblings** | R18 (full), MASTER_PLAN GUI tooling, Crypcodile `test_flowmap_gui_cua.py` |
| **Severity prior** | Enabler **P1**; executed scenarios surface **P0–P3** UX/ship bugs |
| **Focus** | Complete CUA-01…50 automation with steps, asserts, tooling |

---

## 1. Scope & linked zones / sibling hyps

### Purpose
Single Phase-3-ready **computer-use attack matrix** for standalone FlowMap (and optionally packaged app + embed). Consumes R18 inventory; produces FIND-P250-* for automation gaps and FIND-P24x for theme-owned bugs discovered via CUA.

### Tooling (MASTER_PLAN)
- **cua-driver** daemon
- **mac-computer-use** MCP (`screenshot`, `left_click`, `type_text`, `press_key`, `hotkey`, `scroll`, …)
- Optional: Crypcodile `tests/gui/test_flowmap_gui_cua.py` patterns

### Entry points
```bash
python /Users/nazmi/flowmap/run_flowmap.py
# or open dist/FlowMap.app
```

### Auto-start contract (critical)
```python
# main_window ~60–62
switch_to(default LIVE)
QTimer.singleShot(500, toggle_simulation)
```
**All scenarios:** wait **≥1.0s** after window visible before asserting idle state. Prefer wait **≥2.0s** for live connect.

### Cross-theme ownership when CUA fails

| Fail class | File under |
|------------|------------|
| Navigation / F / Go Live | P2-43 |
| Wheel / keys / README | P2-44 |
| Iceberg / LLT docks | P2-45 |
| Paths / No data dir | P2-47 |
| App crash silent | P2-48 |
| Converter visual only in embed | P2-42 |
| Automation infra broken | **P2-50** FIND-P250 |

---

## 2. Threat model (automation)

| Risk | Mitigation |
|------|------------|
| Auto-start races flaky tests | Fixed wait + state poll status bar |
| OCR/coordinate drift Retina | Prefer accessibility labels; scale-aware coords |
| Live network dependency | Prefer Replay when lake available; sim if wired (P2-49) |
| Focus traps (QLineEdit) | Click status bar before keys |
| On-canvas Go Live not a widget | Screenshot + coordinate click |
| Parallel CUA agents fight one display | Serialize GUI agents; one display lock |

---

## 3. Setup & automation primitives

### 3.1 Global setup (every scenario unless noted)

1. Ensure single FlowMap instance (kill stale).
2. Launch app.
3. Wait window title contains `FlowMap` (poll 10s).
4. Wait ≥1.0s (past auto-start fire).
5. Screenshot baseline `S00_launch.png`.
6. Record: Start/Stop label, status text, symbol field value.

### 3.2 Selectors cheatsheet (R18 §9)

| Target | Find by |
|--------|---------|
| Symbol | Label `Symbol:`; value `binance-spot:…` |
| Start/Stop | `▶ Start` / `■ Stop` |
| Sidebar | Button `Sidebar` |
| Tabs | `VISUALS`, `INDICATORS`, `SETTINGS` |
| Replay | Checkbox `Enable Replay Mode` |
| Speed | Spinbox near `Speed:` suffix `x` |
| Go Live | On-canvas `↩ Go Live` |
| Status | `[LIVE]`, `[REPLAY]`, `Bid:`, `Error:` |
| Docks | `DOM Ladder (DOM Pro)`, `Significant Icebergs`, `Large Lot Tracker` |
| View menu | Menu `View` |

### 3.3 Primitive macros

| Macro | Steps |
|-------|-------|
| `FOCUS_MAIN` | Click status bar center |
| `FOCUS_HEATMAP` | Click heatmap center (left 60% of window) |
| `STOP_IF_RUNNING` | If Stop visible → click Stop → wait Start |
| `GOTO_SETTINGS` | Sidebar on → click SETTINGS tab |
| `ENABLE_REPLAY` | GOTO_SETTINGS → check Enable Replay Mode |
| `WAIT_BBO` | Poll status for `Bid:` up to 15s |
| `SHOT(name)` | Screenshot → `phase3_execution/cua_shots/P250/{name}.png` |

### 3.4 Pass/fail global

- **Crash / hang >30s** → P0 FIND
- **Assertion fail** → severity per scenario table
- **Flake 2/3** → FIND-P250 infra, not product (unless consistent)

---

## 4. Complete CUA scenario list (R18 §8) + automation steps

### CUA-01 — Cold launch auto-start (Live)
| | |
|--|--|
| **State** | S6 → S1/S2 or S5 |
| **Steps** | 1. Launch 2. Wait 2s 3. SHOT `01_launch` 4. Read Start/Stop + status |
| **Assert** | Stop if live OK; status `[LIVE]` + Bid/Ask OR Connecting/Error |
| **Fail** | Start stuck + empty heatmap + no status change @10s (UX-14) |
| **Sev** | P1–P0 |

### CUA-02 — Start/Stop button
| | |
|--|--|
| **Steps** | 1. Ensure Stop 2. Click Stop 3. Assert Start + stopped message 4. Click Start 5. Assert Connecting or BBO |
| **Assert** | Button style/name flip; heatmap freezes when stopped |
| **Sev** | P0 if toggle broken |

### CUA-03 — Spacebar Start/Stop
| | |
|--|--|
| **Steps** | 1. FOCUS_MAIN 2. press_key Space 3. Assert toggle 4. Space again |
| **Fail** | No-op if focus in Symbol (document UX-24) |
| **Sev** | P1 |

### CUA-04 — Symbol edit commit
| | |
|--|--|
| **Steps** | 1. Click Symbol 2. select-all 3. type `binance-spot:BTCUSDT` 4. Tab 5. SHOT |
| **Assert** | Status symbol updates; LLT thresh → BTC path (~15); book reset |
| **Sev** | P1 |

### CUA-05 — Empty symbol revert
| | |
|--|--|
| **Steps** | Clear symbol → Tab |
| **Assert** | Previous symbol restored; field not blank |
| **Sev** | P2 |

### CUA-06 — Enable Replay Mode
| | |
|--|--|
| **Steps** | ENABLE_REPLAY → SHOT |
| **Assert** | Speed visible; status `[REPLAY]`; heatmap reset; error if no data |
| **Sev** | P1 |

### CUA-07 — Replay Start with data
| | |
|--|--|
| **Precond** | Lake at data_dir with symbols |
| **Steps** | ENABLE_REPLAY → Start → WAIT_BBO → SHOT |
| **Assert** | Stop; BBO; columns advance; optional progress |
| **Sev** | P0 if no advance with good data |

### CUA-08 — Replay speed change
| | |
|--|--|
| **Steps** | Running replay → Speed 1.0x → wait 3s → 20.0x → SHOT pair |
| **Assert** | Column advance rate changes; no crash |
| **Sev** | P2 (also worker slot lag P2-19) |

### CUA-09 — Disable Replay → Live
| | |
|--|--|
| **Steps** | Uncheck Enable Replay Mode |
| **Assert** | LIVE; speed hidden; re-init |
| **Sev** | P1 |

### CUA-10 — Sidebar toolbar toggle
| | |
|--|--|
| **Steps** | Click Sidebar off → on |
| **Assert** | Panel hide/show; SETTINGS Main Sidebar checkbox sync |
| **Sev** | P2 |

### CUA-11 — Sidebar hide trap
| | |
|--|--|
| **Steps** | Hide via toolbar → try SETTINGS re-enable (impossible) → toolbar recover |
| **Assert** | Toolbar always recovers (UX-11) |
| **Sev** | P2 doc |

### CUA-12 — VISUALS hide layers
| | |
|--|--|
| **Steps** | Uncheck Heatmap, BBO, Trades one-by-one; SHOT each |
| **Assert** | Independent visual removal; re-check restores |
| **Sev** | P1 visual |

### CUA-13 — Volume Profile master + children
| | |
|--|--|
| **Steps** | Uncheck Show VP → children grayed; re-check; toggle COB only |
| **Assert** | Strip hide; child modes |
| **Sev** | P2 |

### CUA-14 — LLT toggle + threshold
| | |
|--|--|
| **Steps** | INDICATORS uncheck LLT; set thresh 50000 then 1 |
| **Assert** | Dock row count responds while running |
| **Sev** | P2 (P2-45) |

### CUA-15 — LLT dual spinner desync
| | |
|--|--|
| **Steps** | Change INDICATORS LLT → dock matches; change dock Min → INDICATORS **does not** |
| **Assert** | Documents UX-07 |
| **Sev** | P2 |

### CUA-16 — Iceberg Clear + filter
| | |
|--|--|
| **Steps** | Clear → 0 rows; raise Min Size |
| **Assert** | Clear works; filter insert-only behavior noted |
| **Sev** | P2 |

### CUA-17 — View menu docks
| | |
|--|--|
| **Steps** | View → DOM ON; Icebergs OFF |
| **Assert** | Visibility + SETTINGS checkbox bi-sync |
| **Sev** | P2 |

### CUA-18 — Market Pulse View vs INDICATORS
| | |
|--|--|
| **Steps** | View uncheck Market Pulse; leave Overlay ON |
| **Assert** | CVD panel gone; overlay markers may remain (UX-06) |
| **Sev** | P2 |

### CUA-19 — F auto-follow
| | |
|--|--|
| **Steps** | FOCUS_MAIN → F → F |
| **Assert** | Status Auto-follow OFF then ON |
| **Sev** | P1 (P2-43) |

### CUA-20 — Drag history + Go Live
| | |
|--|--|
| **Steps** | LMB drag heatmap left → SHOT Go Live → click button |
| **Assert** | Button appears; click returns live; disappears |
| **Sev** | P1 |

### CUA-21 — Double-click recenter
| | |
|--|--|
| **Steps** | Dblclick price axis; dblclick main |
| **Assert** | Mid recenter; main also go-live |
| **Sev** | P2 |

### CUA-22 — Wheel price axis
| | |
|--|--|
| **Steps** | Hover axis; wheel no Ctrl; wheel+Ctrl |
| **Assert** | Thickness vs pan (P2-44) |
| **Sev** | P1 |

### CUA-23 — Wheel main timeframe
| | |
|--|--|
| **Steps** | Hover main; wheel; Ctrl+wheel |
| **Assert** | Column width steps; Ctrl pans time |
| **Sev** | P1 |

### CUA-24 — README Ctrl+zoom myth (negative)
| | |
|--|--|
| **Steps** | Ctrl+scroll expecting zoom |
| **Assert** | **Pans** (UX-01) |
| **Sev** | P1 docs |

### CUA-25 — Keyboard +/− main focus
| | |
|--|--|
| **Steps** | FOCUS_MAIN → + + + → - |
| **Assert** | row_height path |
| **Sev** | P1 |

### CUA-26 — Keyboard +/− heatmap focus
| | |
|--|--|
| **Steps** | FOCUS_HEATMAP → + / - |
| **Assert** | ticks_per_row path ≠ CUA-25 (UX-03) |
| **Sev** | P1 |

### CUA-27 — Heatmap Ctrl+/− Shift+/−
| | |
|--|--|
| **Steps** | Heatmap focus Ctrl+`+`, Shift+`+` |
| **Assert** | Distinct zoom axes |
| **Sev** | P2 |

### CUA-28 — Arrow scrub + Esc/L
| | |
|--|--|
| **Steps** | Heatmap ← hold; →; Esc or L |
| **Assert** | History scrub; go live |
| **Sev** | P1 |

### CUA-29 — R reset
| | |
|--|--|
| **Steps** | Zoom/scroll away → R |
| **Assert** | rh=4, col_w=1.0, follow ON; status if MainWindow |
| **Sev** | P2 |

### CUA-30 — D decay cycle
| | |
|--|--|
| **Steps** | Note 0.92 → D |
| **Assert** | Jumps 0.88 then cycle 80/85/90/95 (UX-08) |
| **Sev** | P2 |

### CUA-31 — SETTINGS sliders smoke
| | |
|--|--|
| **Steps** | Decay, Smooth, Sensitivity, Bubbles end-to-end |
| **Assert** | Labels update; no crash |
| **Sev** | P2 |

### CUA-32 — Centering mode combo
| | |
|--|--|
| **Steps** | Cycle 4 modes while BBO moves |
| **Assert** | No exception |
| **Sev** | P2 |

### CUA-33 — Min order size filter
| | |
|--|--|
| **Steps** | Large min size → thin heatmap → 0 restore |
| **Assert** | Visible density change |
| **Sev** | P2 |

### CUA-34 — DOM open performance
| | |
|--|--|
| **Steps** | View DOM ON while running |
| **Assert** | Ladder populates; freeze <2s |
| **Sev** | P1 perf |

### CUA-35 — Rapid Start/Stop spam
| | |
|--|--|
| **Steps** | Click Start/Stop 10× in 3s |
| **Assert** | No crash; final state consistent; no dual providers |
| **Sev** | P0 if crash (P2-21/17) |

### CUA-36 — Symbol spam
| | |
|--|--|
| **Steps** | Alternate SOL/ETH/BTC commits rapidly |
| **Assert** | Thresholds update; eventual consistent symbol |
| **Sev** | P1 |

### CUA-37 — Splitter drag
| | |
|--|--|
| **Steps** | Drag vertical splitter |
| **Assert** | Resize; paint continues |
| **Sev** | P2 |

### CUA-38 — Window resize min/max
| | |
|--|--|
| **Steps** | Shrink ~900×600; expand |
| **Assert** | No blank heatmap (P2-29 H15) |
| **Sev** | P1–P0 visual |

### CUA-39 — CVD color vision menu
| | |
|--|--|
| **Steps** | Right-click pulse panel → alternate mode |
| **Assert** | Colors change; checkmark moves |
| **Sev** | P3 |

### CUA-40 — Features dialog absence
| | |
|--|--|
| **Steps** | Search UI for Features/Details |
| **Assert** | **Not found** (UX-04) |
| **Sev** | P2 dead code |

### CUA-41 — Source dropdown absence
| | |
|--|--|
| **Steps** | Scan toolbar for Simulator/Replay combo |
| **Assert** | **Absent** (UX-02/19) |
| **Sev** | P1 docs |

### CUA-42 — Replay without data dir
| | |
|--|--|
| **Steps** | Empty/missing data path → ENABLE_REPLAY → Start |
| **Assert** | Error/No data; recoverable Start |
| **Sev** | P1 (P2-47) |

### CUA-43 — Live disconnect mid-session
| | |
|--|--|
| **Steps** | Start live → disrupt network if possible |
| **Assert** | running false, Start button; not stuck Stop |
| **Sev** | P1 |

### CUA-44 — Hover price status
| | |
|--|--|
| **Steps** | Move mouse over rows |
| **Assert** | `Price:` may race BBO status (document) |
| **Sev** | P2 |

### CUA-45 — Dock close [x]
| | |
|--|--|
| **Steps** | Close iceberg dock via title X |
| **Assert** | Menu + SETTINGS uncheck |
| **Sev** | P2 |

### CUA-46 — Sidebar tab navigation
| | |
|--|--|
| **Steps** | VISUALS → INDICATORS → SETTINGS → VISUALS |
| **Assert** | Tabs accessible; highlight |
| **Sev** | P3 |

### CUA-47 — App quit clean
| | |
|--|--|
| **Steps** | Close window while running |
| **Assert** | Process exits <5s; no zombie |
| **Sev** | P0 if hang (P2-17/19) |

### CUA-48 — Keyboard + drag concurrent
| | |
|--|--|
| **Steps** | Drag timeline + Space stop |
| **Assert** | No crash; running false |
| **Sev** | P1 |

### CUA-49 — Sensitivity vs symbol thresholds
| | |
|--|--|
| **Steps** | SOL → Sensitivity 100 → switch ETH |
| **Assert** | Document overwrite policy (UX-20) |
| **Sev** | P2 |

### CUA-50 — Full regression smoke suite
| | |
|--|--|
| **Steps** | Sequence: 01, 02, 06, 07, 10, 12, 17, 20, 22, 25, 29, 47 |
| **Assert** | All pass; baseline screenshot pack |
| **Sev** | Gate |

---

## 5. Execution waves for CUA (Phase 3)

| Wave | Scenarios | Goal |
|------|-----------|------|
| **C0** | 01, 02, 47 | Launch/stop/quit gate |
| **C1** | 06–09, 42 | Source/replay |
| **C2** | 19–30 | Input matrix |
| **C3** | 24, 40, 41 | Docs/lies |
| **C4** | 15, 18, 35, 43, 44 | State desync |
| **C5** | 12–14, 17, 31–34 | Visuals |
| **C6** | 36, 38, 48–50 | Edges + suite |
| **C7** | Packaged app: 01, 02, 47, 42 | Z20 |

---

## 6. Pass / fail criteria (theme-level)

| ID | Pass | Fail |
|----|------|------|
| CUA-P1 | C0 green on dev launch | Cannot launch/assert |
| CUA-P2 | CUA-50 suite runnable unattended | Manual only |
| CUA-P3 | Screenshot artifacts archived per FIND | No evidence |
| CUA-P4 | Flakes tagged infra vs product | Misfiled |
| CUA-P5 | Selectors documented if labels change | Silent break |

---

## 7. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| Display unlock / one agent mutex | Serialize |
| `phase3_execution/cua_shots/` tree | Evidence |
| Replay lake or skip marks | CUA-07 |
| Network off profile | CUA-42/43 |
| Packaged app path | C7 |
| Status bar OCR helper or accessibility dump | Asserts |

---

## 8. Phase-3 micro-tasks (execution agents)

| Hunt | Work |
|------|------|
| **H-50A** | Implement macros + C0 automation |
| **H-50B** | C1 replay path |
| **H-50C** | C2 full input matrix |
| **H-50D** | C3 docs negative tests |
| **H-50E** | C4–C6 residual |
| **H-50F** | C7 packaged app matrix |
| **H-50G** | Suite runner script + JUnit-like summary JSON |

Assign ~8–12 Phase-3 execution agents under P2-50 umbrella; product findings redirect to owner themes.

---

## 9. Expected finding IDs — `FIND-P250-XX`

| ID | Sev | Title |
|----|-----|-------|
| FIND-P250-01 | P1 | CUA flake: auto-start race |
| FIND-P250-02 | P1 | Go Live coordinate miss automation |
| FIND-P250-03 | P2 | No accessibility names on critical controls |
| FIND-P250-04 | P1 | Packaged app not automatable (no process handle) |
| FIND-P250-05 | P2 | Status OCR unreliable |
| FIND-P250-06 | P3 | Suite runner missing |

Product bugs found via CUA use **owner theme IDs** (FIND-P243-…, FIND-P244-…, etc.) with `discovered_by: CUA-NN` field.

---

## 10. Fix strategy sketch (automation)

1. Add stable `objectName` on all toolbar/sidebar controls (Phase 4).
2. Optional `--no-autostart` for tests (R13 CLI wish).
3. Headless Qt where possible for non-pixel tests; CUA only for true GUI.
4. Baseline image repo with tolerance.
5. Embed CUA reuses same macros against Crypcodile window title.

---

## 11. Dependencies

| Theme | Link |
|-------|------|
| P2-43–45 | Scenario owners |
| P2-47–48 | Path + package scenarios |
| P2-49 | Offline data source |
| All visual themes | Screenshot evidence |

**Schedule:** C0 from day 1 of Phase 3 W3/W4; C2 after W1 stability (avoid hunting paint while queue broken).

---

## 12. Severity priors

Infra gaps **P1–P2**. Individual scenario failures inherit R18/R20 priors (UX-01 P1, quit hang P0, etc.).
