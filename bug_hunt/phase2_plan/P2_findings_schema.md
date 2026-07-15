# P2 Findings Schema — Phase 3 Registry Contract

**Path:** `/Users/nazmi/flowmap/bug_hunt/phase2_plan/P2_findings_schema.md`  
**Consumers:** 100 Phase-3 execution agents, Phase-4 fix agents  
**Related:** MASTER_PLAN finding rules, R20 severity gates  

---

## 1. Purpose

One schema so every FIND is mergeable into a registry (JSONL or markdown table) without free-form drift.

---

## 2. Finding ID format

```text
FIND-P2{NN}-{XX}

NN  = theme number 01–50  (zero-padded in docs as P2-01 … P2-50)
XX  = sequence within theme 01–99
```

Examples: `FIND-P206-01`, `FIND-P241-03`, `FIND-P250-02`.

**Legacy Phase-1 hyp IDs** (R05 H1, R13-C1, UX-01, P0-06) go in `sibling_refs[]`, not as primary ID.

**Discovered via CUA but owned by another theme:** use **owner** theme ID; set `discovered_by`.

---

## 3. Severity (R20 / MASTER_PLAN)

| Sev | Definition | Fix SLA hint |
|-----|------------|--------------|
| **P0** | Wrong market state, crash, unbounded lag/mem, global security patch, non-portable ship path, silent package death | Immediate / wave-blocking |
| **P1** | Systematic visual/data skew, broken switch/reconnect, major UX desync, SQL fragility | Same release |
| **P2** | Rare edges, F+ heuristics, secondary overlays, spinner desync | Next pass |
| **P3** | Polish, dead code, theme, docs-only | Backlog |

**Latent security** (e.g. plugin RCE unwired): sev `P0` with `status: latent` or `P1` design debt — field `latent: true`.

---

## 4. Required fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | **yes** | `FIND-P2NN-XX` |
| `title` | string | **yes** | Short imperative title |
| `severity` | enum | **yes** | P0 \| P1 \| P2 \| P3 |
| `theme` | int | **yes** | 1–50 |
| `zones` | string[] | **yes** | e.g. `["Z13"]` |
| `taxonomy` | enum | **yes** | See §5 |
| `status` | enum | **yes** | `open` \| `confirmed` \| `wontfix` \| `duplicate` \| `fixed` \| `latent` |
| `file` | string | **yes** | Absolute or repo-relative path |
| `line` | int \| null | yes* | Best effort; null if multi-site |
| `repro` | string | **yes** | Step list; enough for third party |
| `expected` | string | **yes** | Correct behavior |
| `actual` | string | **yes** | Observed |
| `fix_hint` | string | **yes** | Direction only, not full patch |
| `sibling_refs` | string[] | no | `R05 H7`, `UX-01`, `P0-06` |
| `discovered_by` | string | no | Agent id, `CUA-24`, script name |
| `evidence` | string[] | no | Screenshot paths, logs, hashes |
| `fixtures` | string[] | no | Lake path, seed, golden file |
| `latent` | bool | no | True if not reachable in default build |
| `duplicate_of` | string | no | Other FIND id |
| `wave` | enum | no | W1–W4 when found |
| `created` | ISO date | no | |
| `notes` | string | no | |

\*If multi-site: `line: null` and list sites in `notes` or `evidence`.

---

## 5. Taxonomy (MASTER_PLAN 10 classes)

| Code | Name |
|------|------|
| `correctness` | Wrong price/volume/BBO/heatmap |
| `concurrency` | Race / queue stall / teardown |
| `memory` | Leak / unbounded growth |
| `performance` | FPS / UI freeze |
| `rendering` | Artifacts / jitter / flicker |
| `input_ux` | Keyboard / mouse / controls |
| `data_source` | Replay/live/sim edges |
| `integration` | Standalone ↔ Crypcodile |
| `packaging` | Crash on start / dist |
| `security` | Path, SQL, SSL, plugins |

Multiple tags allowed as `taxonomy_secondary[]` optional.

---

## 6. JSON schema (canonical registry line)

```json
{
  "id": "FIND-P247-01",
  "title": "MainWindow default data_dir hardcoded to /Users/nazmi/data",
  "severity": "P0",
  "theme": 47,
  "zones": ["Z13", "Z20"],
  "taxonomy": "packaging",
  "taxonomy_secondary": ["integration"],
  "status": "confirmed",
  "file": "/Users/nazmi/flowmap/flowmap/ui/main_window.py",
  "line": 31,
  "repro": "1. Fresh user HOME without /Users/nazmi/data\n2. Launch run_flowmap.py\n3. Enable Replay Mode → Start",
  "expected": "Portable default under Application Support or clear configure UX",
  "actual": "Uses /Users/nazmi/data; fails or empty on other machines",
  "fix_hint": "Default to ~/Library/Application Support/FlowMap/data; env FLOWMAP_DATA_DIR",
  "sibling_refs": ["R13-C1", "R20 P0-06", "UX-23"],
  "discovered_by": "H-47A",
  "evidence": ["phase3_execution/evidence/P247/strings_app.txt"],
  "fixtures": [],
  "latent": false,
  "wave": "W1",
  "created": "2026-07-13",
  "notes": ""
}
```

---

## 7. Markdown template (per-agent report)

```markdown
## FIND-P2NN-XX — Title

| Field | Value |
|-------|-------|
| Severity | P0 |
| Theme | P2-NN |
| Zones | Zxx |
| Taxonomy | correctness |
| Status | confirmed |
| Location | `path:line` |
| Sibling | Rxx Hy |

### Repro
1. ...

### Expected
...

### Actual
...

### Fix hint
...

### Evidence
- screenshot: `...`
```

---

## 8. Registry files (Phase 3 layout)

```text
/Users/nazmi/flowmap/bug_hunt/phase3_execution/
  findings/
    FINDINGS.jsonl          # append-only canonical
    by_theme/P2-01.md       # optional human rollup
    by_sev/P0.md
  evidence/
    P247/...
  cua_shots/
    P250/...
```

**Append rule:** never rewrite historical JSONL lines; close with `status` update as new line with same `id` and `event: status_change` **or** maintain sidecar `FINDINGS_STATE.json` map id→status. Prefer **sidecar state** + immutable first-report JSONL.

---

## 9. Dedup rules

1. Same root cause + same primary file → **one** FIND; extra repros in `notes`.  
2. Same symptom different root → **two** FINDs; cross-link.  
3. Phase-1 hyp confirmed → new FIND + `sibling_refs`.  
4. CUA discovers bug already planned → owner theme ID, `discovered_by: CUA-NN`.  

---

## 10. Pass criteria for a “complete” finding

- [ ] ID valid  
- [ ] Sev assigned with taxonomy  
- [ ] file:line or multi-site note  
- [ ] Repro ≥3 steps or unit command  
- [ ] expected ≠ actual non-empty  
- [ ] fix_hint non-empty  
- [ ] evidence path if GUI/visual  

Incomplete → status `open` with title prefix `[INCOMPLETE]`.

---

## 11. Phase-4 handoff fields (optional early)

| Field | Purpose |
|-------|---------|
| `fix_pr` | PR link |
| `regression_test` | test path |
| `fixed_in` | commit |

---

## 12. Severity gate examples (Track E)

| Example | Sev |
|---------|-----|
| `/Users/nazmi/data` default | P0 |
| console=False silent crash | P0 |
| Plugin exec if enabled | P0 latent |
| SQL f-string symbol | P1 |
| README Ctrl+scroll | P1 |
| LLT spinner desync | P2 |
| Features dialog dead | P2–P3 |
