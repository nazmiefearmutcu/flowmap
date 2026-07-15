# P2-35 — Hardcoded sys.path embed fragility

| Field | Value |
|-------|-------|
| **Agent** | P2-35 |
| **Theme** | Hardcoded sys.path embed fragility |
| **Zones** | Z12, Z13 |
| **Sibling hyps** | R02 §2.1/§6.1; R20 P0-07; R13-C1 related paths |
| **Severity prior** | **P0** portability / ship-breaker on any machine ≠ developer layout |
| **Primary files** | `/Users/nazmi/Crypcodile/src/crypcodile/gui/flowmap_window.py` L6–12, `/Users/nazmi/Crypcodile/src/crypcodile/cli.py` (`run_flowmap_gui`), `/Users/nazmi/flowmap/setup.py`, Crypcodile packaging metadata |

---

## 1. Scope & linked zones/sibling hyps

### In scope
- Module-load path inject:
  ```python
  flowmap_path = "/Users/nazmi/flowmap"
  if flowmap_path not in sys.path:
      sys.path.insert(0, flowmap_path)
  ```
- Default `data_dir="/Users/nazmi/data"` on `FlowmapWindow` / MainWindow / SourceManager (overlap P2-47)
- Import failure modes: missing tree, wrong tree, shadowed package name
- `sys.path.insert(0, ...)` precedence over site-packages `flowmap`
- Multiprocessing child inherits path assumptions
- Lack of env override (`FLOWMAP_HOME`, editable install)
- Circular coupling: Crypcodile GUI → flowmap path; flowmap providers → optional crypcodile

### Out of scope
- Hist binning fidelity (P2-36)
- Replay SQL injection (P2-41) except shared hardcoded data_dir
- Full packaging PyInstaller (P2-48)

---

## 2. Threat model

| Scenario | Result |
|----------|--------|
| Another developer clones Crypcodile only | `ImportError` at import of `flowmap_window` |
| flowmap installed via pip elsewhere | **insert(0)** forces `/Users/nazmi/flowmap` over installed version if path exists |
| Path exists but wrong commit | Silent behavior skew (no pin) |
| CI runner | Always fails unless docker mirrors path |
| Symlink / rename home | Break |
| Security | Loading code from fixed absolute path — predictable; less “injection” than “deployment bomb” |

**Blast radius:** entire Crypcodile FlowMap feature dead; CLI `crypcodile flowmap` child dies after launch message.

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| S1 | `rg '/Users/nazmi' Crypcodile/src flowmap/` full inventory |
| S2 | Check Crypcodile `pyproject`/`setup` for flowmap dependency |
| S3 | Check flowmap `setup.py` install name/entry points |
| S4 | CLI `run_flowmap_gui` ImportError handling |
| S5 | Document load order: path inject before any flowmap import |

### 3.2 Unit / env matrix

| ID | Environment | Steps | Expected today |
|----|-------------|-------|----------------|
| E1 | `FLOWMAP` tree missing | import flowmap_window | ImportError |
| E2 | Empty `/Users/nazmi/flowmap` stub | import | Fail later on submodule |
| E3 | pip install -e flowmap **and** hardcoded path present | import MainWindow | Which wins? (path[0] = hardcoded) |
| E4 | Rename: only `~/src/flowmap` | import | Fail |
| E5 | Env var (if any) | none today | N/A — **gap** |
| E6 | Multiprocess child | spawn GUI | same inject |

### 3.3 Dynamic

| ID | Probe |
|----|-------|
| D1 | `python -c "from crypcodile.gui.flowmap_window import FlowmapWindow"` on clean venv without path |
| D2 | `crypcodile flowmap --symbol ...` with missing path; capture stderr |
| D3 | PYTHONPATH override competition vs insert(0) |
| D4 | Two flowmap checkouts: confirm wrong one loaded via `flowmap.__file__` |

### 3.4 GUI / product

| ID | Probe |
|----|-------|
| G1 | Launch success only on developer machine — document as P0 |
| G2 | After successful import, title string CUA tests depend on |

---

## 4. Pass/fail criteria

| Criterion | Pass (target) | Fail (current expected) |
|-----------|---------------|-------------------------|
| Import without `/Users/nazmi/flowmap` | Works via package install or env | ImportError |
| Explicit override | `FLOWMAP_HOME` / entry point documented | None |
| No absolute home paths in shipped code | 0 matches | Multiple |
| Version pin | declared dependency | floating HEAD |
| Clear error | message “install flowmap or set FLOWMAP_HOME” | raw ImportError mid-child |
| site-packages not shadowed unexpectedly | prefer installed unless override | insert(0) always wins if path exists |

---

## 5. Fixtures needed

| Fixture | Description |
|---------|-------------|
| Clean venv without flowmap path | CI job |
| Editable install script | `pip install -e /path/to/flowmap` |
| Fake `FLOWMAP_HOME` tree with minimal package | resolution unit tests |
| Negative: empty dir at hardcoded path | |
| Snapshot of `rg /Users/nazmi` allowlist |

---

## 6. Phase-3 agent micro-tasks

### Hunt A — Absolute path inventory
Full table of hardcoded paths with file:line; severity. **FIND-P235-01**

### Hunt B — Import resolution experiment
E1–E4 matrix; record `flowmap.__file__`. **FIND-P235-02**

### Hunt C — Packaging gap
Crypcodile deps vs reality; propose install story. **FIND-P235-03**

### Hunt D — CLI failure UX
Broken path launch; parent join behavior; stderr. **FIND-P235-04**

### Hunt E — Shadowing risk
Installed package vs path inject. **FIND-P235-05**

---

## 7. Expected finding IDs

Format: **`FIND-P235-XX`**

| ID | Title | Sev |
|----|-------|-----|
| FIND-P235-01 | Hardcoded `/Users/nazmi/flowmap` sys.path | **P0** |
| FIND-P235-02 | Hardcoded default data_dir (cross-link P2-47) | **P0** |
| FIND-P235-03 | No flowmap dependency in Crypcodile packaging | **P0** |
| FIND-P235-04 | insert(0) shadows site-packages | P1 |
| FIND-P235-05 | No version pin / silent drift | P1 |
| FIND-P235-06 | Poor ImportError surface in child process | P1 |
| FIND-P235-07 | Circular runtime coupling undocumented | P2 |

---

## 8. Fix strategy sketch

1. **Preferred:** `pip install -e` / declare `flowmap` as dependency; remove path hack.
2. **Interim:** 
   ```text
   FLOWMAP_HOME env → pathlib; else importlib.util.find_spec("flowmap"); else clear error
   ```
3. Never `insert(0)` over existing proper install without opt-in debug flag.
4. Pin commit/version in Crypcodile release notes.
5. CI matrix: import without developer home layout.
6. Coordinate with P2-47 for `data_dir` defaults (`~/data`, XDG, CLI only).

---

## 9. Dependencies

| Theme | Relation |
|-------|----------|
| **P2-47** portable data_dir | Same machine-path class |
| P2-42 API drift | Dual trees without pin |
| P2-36–38 hist | Only runnable if import works |
| P2-48 packaging | Standalone app different path |
| P2-50 CUA | Assumes working launch |

---

## 10. Severity priors from phase1

| Source | Prior |
|--------|-------|
| R20 P0-07 | **P0** |
| R02 exec summary | Biggest risks: hardcoded paths |
| R13-C1 data path | P0 sibling |

**Verdict:** Planning-complete when inventory + fail matrix written; fix is packaging, not heatmap math.
