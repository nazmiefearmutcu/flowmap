# P2-47 — Portable data_dir + No Machine Paths

| Field | Value |
|-------|-------|
| **Agent** | P2-47 |
| **Theme n** | 47 |
| **Track** | E — Ship / paths |
| **Zones** | **Z13**, **Z20** |
| **Siblings** | R13-C1, R13-P8, R02 path inject, R20 P0-06/P0-07, UX-23 |
| **Severity prior** | **P0** |
| **Focus** | Hardcoded `/Users/nazmi/data`, `/Users/nazmi/flowmap`; portable defaults |

---

## 1. Scope & linked zones / sibling hyps

### Known hardcoded paths (expand with rg)

| Path | File (approx) |
|------|----------------|
| `/Users/nazmi/data` | `main_window.py:31`, `source_manager.py:87`, `218–219` fallback list |
| `/Users/nazmi/flowmap` | Crypcodile `flowmap_window.py:7` sys.path |
| Scratch/diagnostics | many under `scratch/`, `debug_*.py` — lower sev for ship, still clean |
| Default symbol | OK as product default |

### Related behaviors
- Fallback search: `/Users/nazmi/data`, `~/data`, `.`
- Auto-start live @500ms still runs even if data_dir wrong (live ≠ replay path)
- Replay “No data dir” status when empty
- Embed hist uses same data_dir default

### Sibling
- R13-C1 P0 hardcoded data_dir
- R02 hardcoded flowmap_path
- P2-35 owns inject fragility detail; this theme owns **portable product defaults** inventory + ship checklist
- P2-48 packaging bakes these defaults into binary

---

## 2. Threat model

| Scenario | Effect |
|----------|--------|
| Another Mac runs DMG | Points at non-existent `/Users/nazmi/data` |
| CI agent | Same |
| Path exists but is **another user’s data** | Privacy / wrong lake |
| flowmap_path missing | Embed ImportError |
| Relative `plugins/` cwd | Unexpected load dir (P2-46) |

Not classic security injection — **portability / privacy / ship-blocker**.

---

## 3. Concrete probes

### 3.1 Full inventory

```bash
rg -n "/Users/nazmi|/home/|C:\\\\Users" \
  /Users/nazmi/flowmap /Users/nazmi/Crypcodile/src/crypcodile/gui \
  --glob '*.{py,spec,md,plist,sh}'
```

Classify: runtime product code vs tests vs docs vs scratch.

### 3.2 Fresh user simulation

```bash
# empty HOME sandbox
HOME=/tmp/empty_home_$$ python /Users/nazmi/flowmap/run_flowmap.py
# Assert: no dependency on /Users/nazmi/* for startup success path
# Replay may show No data dir — acceptable if message clear
```

### 3.3 Env / CLI knobs (missing)

Confirm absence of `--data-dir`, `FLOWMAP_DATA_DIR`, `FLOWMAP_HOME`.  
Finding: no override without editing code.

### 3.4 Frozen app

Launch `dist/FlowMap.app`; check defaults still nazmi paths (binary string scan):

```bash
strings dist/FlowMap.app/Contents/MacOS/FlowMap | rg "Users/nazmi" | head
```

### 3.5 Embed import

Unset path; measure FlowmapWindow import failure mode.

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PATH-P1 | Zero `/Users/nazmi` in **runtime** product paths | Any remain |
| PATH-P2 | Default data_dir = XDG/App Support or empty+picker | Machine-local |
| PATH-P3 | FLOWMAP_DATA_DIR / CLI override works | No override |
| PATH-P4 | Embed finds flowmap via package install or env | Absolute only |
| PATH-P5 | Packaged strings clean | nazmi baked in binary |
| PATH-P6 | Scratch may keep paths but not shipped | Scratch in wheel |

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| Empty HOME sandbox | Cold user |
| Temporary lake at `$TMP/lake` | Positive replay |
| `strings` scan script | Packaging gate |
| Matrix: source, app, embed CLI | Three entry points |

---

## 6. Phase-3 micro-tasks

| Hunt | Work |
|------|------|
| **H-47A** | Complete path inventory + classification table |
| **H-47B** | HOME sandbox launch + status assertions |
| **H-47C** | `strings` on FlowMap.app for nazmi paths |
| **H-47D** | Design portable default + override matrix (impl Phase 4) |
| **H-47E** | Embed path env (`FLOWMAP_ROOT`) experimental validation |

---

## 7. Expected finding IDs — `FIND-P247-XX`

| ID | Sev | Title |
|----|-----|-------|
| FIND-P247-01 | P0 | MainWindow default data_dir `/Users/nazmi/data` |
| FIND-P247-02 | P0 | SourceManager default + fallback list |
| FIND-P247-03 | P0 | Crypcodile flowmap_path inject |
| FIND-P247-04 | P0 | Paths baked into FlowMap.app strings |
| FIND-P247-05 | P1 | No CLI/env override for data_dir |
| FIND-P247-06 | P2 | Scratch/diagnostics hardcode (non-ship) |
| FIND-P247-07 | P1 | Replay discovery order prefers machine path |

---

## 8. Fix strategy sketch

1. Default `data_dir`:
   - macOS: `~/Library/Application Support/FlowMap/data`
   - else: `~/.local/share/flowmap/data` or `~/flowmap-data`
2. If dir missing: create empty **or** status “Configure data directory” without crashing.
3. Env: `FLOWMAP_DATA_DIR` overrides; CLI `--data-dir`.
4. Embed: `pip install -e` flowmap; remove sys.path hack; optional `FLOWMAP_ROOT`.
5. Packaging gate CI: fail if `strings` matches `/Users/nazmi`.
6. Keep fallbacks: `~/data`, `.` **after** portable default — never nazmi home.

---

## 9. Dependencies

| Theme | Link |
|-------|------|
| P2-35 | Embed inject detail |
| P2-48 | Spec/binary ship |
| P2-41 | SQL uses data_dir lakes |
| P2-42 | Integration defaults |
| P2-50 | CUA cold start without data |

**Must plan first (R20 critical path starts Z13).** Phase-3 W1 theme.

---

## 10. Severity priors

R20 P0-06, P0-07, R13-C1 → **P0**. Scratch-only → **P2/P3**.
