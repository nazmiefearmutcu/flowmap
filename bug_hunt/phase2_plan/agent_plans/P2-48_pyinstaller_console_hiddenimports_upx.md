# P2-48 — PyInstaller console / hiddenimports / UPX

| Field | Value |
|-------|-------|
| **Agent** | P2-48 |
| **Theme n** | 48 |
| **Track** | E — Packaging |
| **Zones** | **Z20** |
| **Siblings** | R13-P1–P12, R13-C2–C9, R20 P0-13 |
| **Severity prior** | **P0** (silent crash-on-start) |
| **Focus** | `FlowMap.spec` hygiene, cold start, frozen resources |

---

## 1. Scope & linked zones / sibling hyps

### Spec truth (`/Users/nazmi/flowmap/FlowMap.spec`)
- Entry: `run_flowmap.py`
- `datas=[]`, `hiddenimports=[]`, `excludes=[]`
- `console=False`, `upx=True` (EXE + COLLECT)
- BUNDLE: `icon=None`, `bundle_identifier=None` → version 0.0.0

### Dist
- `dist/FlowMap.app`, onedir `dist/FlowMap/`, `FlowMap.dmg`
- Heavy transitive deps (pyarrow, numba, web3, …)

### R13 packaging IDs to verify
P1–P12, C2–C9, C1 (paths with P2-47)

### Out of scope detail
- Plugin enable (P2-46)
- data_dir content (P2-47) except binary string presence

---

## 2. Threat model

| Failure | User sees |
|---------|-----------|
| Import error at boot, console=False | Dock bounce, no message |
| UPX broken dylib | Same |
| Missing Qt platform plugin | Same |
| OpenGL context abort | Crash after window |
| Partial crypcodile | Soft “provider missing” + auto-start noop |
| Gatekeeper quarantine | Blocked open |
| Cold start bloat | Hang-like multi-second delay |

---

## 3. Concrete probes

### 3.1 Spec audit checklist

| Check | Current | Target |
|-------|---------|--------|
| console | False | True for debug build; False+log for release |
| upx | True | False on Darwin |
| hiddenimports | [] | explicit list if needed |
| datas | [] | assets, if any |
| bundle_identifier | None | `com.flowmap.app` or similar |
| version | 0.0.0 | sync setup.py 0.1.0 |
| excludes | [] | web3/eth if unused venues |

### 3.2 Cold start matrix

| Entry | Env | Expect |
|-------|-----|--------|
| `python run_flowmap.py` | dev venv | Window <5s |
| `dist/FlowMap.app` | stock | Window or log |
| `FLOWMAP_RENDERER=cpu` app | | Avoid GL crash |
| Offline network | | Live error not hang forever |
| No `/Users/nazmi/data` | | No hard crash (P2-47) |

### 3.3 Console=False diagnosis gap

1. Inject temporary `raise RuntimeError("boom")` in main (local branch only).
2. Rebuild windowed.
3. Confirm no user-visible error → FIND-P248 for missing crash log.

### 3.4 warn-FlowMap.txt review

Parse `build/FlowMap/warn-FlowMap.txt` for missing modules that are imported lazily.

### 3.5 hiddenimports experiment

```bash
# Launch frozen; force import paths:
# crypcodile, OpenGL, ccxt.pro, etc.
```

### 3.6 UPX

Compare launch reliability upx=True vs rebuild upx=False (Phase 3 may only document risk if rebuild expensive).

### 3.7 sys.frozen / _MEIPASS

```bash
rg -n "frozen|_MEIPASS|MEIPASS" /Users/nazmi/flowmap --glob '*.py'
# Expect: none → FIND
```

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PKG-P1 | Debug build has console or crash log file | Silent death only |
| PKG-P2 | UPX disabled on macOS release | UPX on |
| PKG-P3 | Bundle id + version set | None / 0.0.0 |
| PKG-P4 | Cold start matrix documented green/red | Unknown |
| PKG-P5 | Lazy imports verified present or guarded | ImportError in frozen |
| PKG-P6 | Resource paths frozen-aware when assets exist | Relative fail |

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| Existing `dist/FlowMap.app` | Non-rebuild tests |
| Optional rebuild script | Spec experiments |
| Crash log path design | `~/Library/Logs/FlowMap/flowmap.log` |
| Timing script | cold start ms |
| warn-FlowMap.txt | analysis |

---

## 6. Phase-3 micro-tasks

| Hunt | Work |
|------|------|
| **H-48A** | Spec field-by-field audit findings |
| **H-48B** | Cold start matrix (source + app) + screenshots |
| **H-48C** | Silent exception / no log FIND |
| **H-48D** | warn file + hiddenimport candidates list |
| **H-48E** | OpenGL vs CPU frozen path; FLOWMAP_RENDERER |
| **H-48F** | Gatekeeper / quarantine notes on DMG |

---

## 7. Expected finding IDs — `FIND-P248-XX`

| ID | Sev | Title |
|----|-----|-------|
| FIND-P248-01 | P0 | console=False silent crash |
| FIND-P248-02 | P1 | upx=True Darwin risk |
| FIND-P248-03 | P1 | empty hiddenimports/datas |
| FIND-P248-04 | P1 | bundle_identifier None / version 0.0.0 |
| FIND-P248-05 | P1 | no sys.frozen resource helper |
| FIND-P248-06 | P1 | dist bloat / cold start |
| FIND-P248-07 | P1 | OpenGL default crash risk |
| FIND-P248-08 | P2 | setup.py vs plist version drift |
| FIND-P248-09 | P2 | pyqtgraph unused dep |
| FIND-P248-10 | P2 | entry run_flowmap venv re-exec dead weight |

---

## 8. Fix strategy sketch

1. Split specs: `FlowMap.debug.spec` (console=True, upx=False) vs release.
2. Release: upx=False; set CFBundleIdentifier; version from setup.
3. `excludes` aggressive for unused eth/web3 if safe.
4. Install `sys.excepthook` → log file always.
5. Default `FLOWMAP_RENDERER=cpu` in Info.plist if GL flaky.
6. Document Gatekeeper: `xattr -dr com.apple.quarantine`.
7. CI smoke: launch app, wait 3s, check process alive + log.

---

## 9. Dependencies

| Theme | Link |
|-------|------|
| P2-47 | paths in binary |
| P2-46 | don’t auto-load plugins in bundle |
| P2-25 | OpenGL vs CPU |
| P2-50 | CUA on packaged app |
| P2-17 | live thread after start |

**W4 packaging wave primary; smoke W1 if ship-blocker.**

---

## 10. Severity priors

R20 P0-13, R13-P3/C2 → **P0** silent death. UPX/bloat → **P1**. Version polish → **P2**.
