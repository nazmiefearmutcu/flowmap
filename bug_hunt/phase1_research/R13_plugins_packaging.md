# R13 — Plugins, Packaging, Entry Points, Dist

**Agent:** R13  
**Phase:** 1 (research)  
**Date:** 2026-07-13  
**Scope:** Plugin API/loader, setuptools, PyInstaller, empty packages, CLI, crash-on-start hypotheses  

---

## 1. Inventory

| Path | Role | Status |
|------|------|--------|
| `/Users/nazmi/flowmap/flowmap/plugins/plugin_api.py` | Public plugin surface (`PluginAPI`, `AddonState`) | Implemented, **not wired into app** |
| `/Users/nazmi/flowmap/flowmap/plugins/loader.py` | Discover + `importlib` load + `register(api)` | Implemented, **never called from UI/main** |
| `/Users/nazmi/flowmap/flowmap/plugins/__init__.py` | Re-exports `PluginAPI`, `AddonState` | OK |
| `/Users/nazmi/flowmap/plugins/example_indicator.py` | Sample CVD/VWAP plugin | Present; docs claim auto-load at startup |
| `/Users/nazmi/flowmap/plugins/__init__.py` | User-plugin package docstring | Present |
| `/Users/nazmi/flowmap/FlowMap.spec` | PyInstaller onedir + `.app` BUNDLE | Minimal / bare |
| `/Users/nazmi/flowmap/setup.py` | setuptools package + `flowmap` console script | Partial / stale deps |
| `/Users/nazmi/flowmap/run_flowmap.py` | Dev launcher (venv re-exec) | Works for source; frozen path untested |
| `/Users/nazmi/flowmap/flowmap/main.py` | Real entry: `QApplication` + `MainWindow` | No CLI flags |
| `/Users/nazmi/flowmap/dist/` | `FlowMap.app`, onedir `FlowMap/`, `FlowMap.dmg` | Built (Python 3.13, heavy dep tree) |
| `/Users/nazmi/flowmap/flowmap/indicators/` | Stub package dir | **Empty** (no `__init__.py`) |
| `/Users/nazmi/flowmap/flowmap/trading/` | Stub package dir | **Empty** |
| `/Users/nazmi/flowmap/flowmap/utils/` | Stub package dir | **Empty** |
| `/Users/nazmi/flowmap/flowmap/ui/bubbles/` | Empty dir (real code is `ui/bubbles.py`) | **Empty** |
| `/Users/nazmi/flowmap/flowmap/ui/tape/` | Stub | **Empty** |

---

## 2. Plugin API — Security Risks (Arbitrary Code Load)

### 2.1 Design

Loader model:

1. Scan a directory for `*.py` (skip `__init__.py`)
2. `importlib.util.spec_from_file_location` + `exec_module` (**full Python execution**)
3. Call top-level `register(api: PluginAPI)`

Default scan path: relative `"plugins/"` (cwd-dependent). Docs also mention `~/flowmap/plugins`.

### 2.2 Findings

| ID | Severity | Finding | Evidence |
|----|----------|---------|----------|
| **R13-S1** | **P0 (if enabled)** | **Unsandboxed arbitrary code execution** via plugin load. Any `.py` under the scan dir runs as the FlowMap process user (FS, network, subprocess, memory of host process). | `loader.py:79–93` — `spec.loader.exec_module(module)` |
| **R13-S2** | **P1** | **No trust model**: no signature, hash allowlist, API key, path allowlist, or “plugins disabled by default” gate. | Entire `loader.py` |
| **R13-S3** | **P1** | **`sys.path` mutation**: plugin parent dir is `sys.path.insert(0, …)` during load → dependency confusion / shadowing of stdlib or `flowmap.*` if a plugin ships a malicious package name. | `loader.py:89–96` |
| **R13-S4** | **P1** | **Full OrderBook reference** exposed to plugins via `AddonState.get_order_book()` / `PluginAPI.set_order_book` — not a read-only view; plugin can mutate book state if OrderBook is mutable. | `plugin_api.py:238–240`, `331–337` |
| **R13-S5** | **P2** | **Callback isolation incomplete**: runtime `notify_*` uses try/except, but **import-time** and **`register()`** only log and continue — a plugin can still hang the main thread during load (infinite loop) or fork/exec before registration returns. | `loader.py:99–107`, `148–160`; `plugin_api.py:341–399` |
| **R13-S6** | **P2** | **`register_with_app` wraps OrderBook callbacks** by reassignment (`ob.on_trade = _wrapped_on_trade`). Multiple registrations or races can clobber other wrappers; no remove/unwind. | `plugin_api.py:444–461` |
| **R13-S7** | **P3** | **Error rate-limit is process-global** `_plugin_errors` dict never reset — minor; also dumps full tracebacks to stderr (info leak in shared logs). | `plugin_api.py:472–497` |
| **R13-S8** | **P3 (latent)** | Docs say example plugin is **auto-loaded at startup**; **no call site exists** in `main.py` / `MainWindow` for `load_all_from_directory` / `discover_plugins`. Security risk is **latent until integration**; functional promise is already broken. | Grep: only hits under `flowmap/plugins/*` and `plugins/example_*` |

### 2.3 Integration gap (correctness + security)

- `PluginAPI.notify_level2` / `collect_indicator_lines` / `collect_annotations` are **never invoked** from UI pipeline.
- Heatmap rendering does not consume plugin indicator lines.
- Example plugin’s `on_level2` would never fire even if loaded via `register_with_app` alone (only trade/bbo callbacks are wrapped; **level2 is not wired** in `register_with_app`).

**Fix hints (later phases):**

- Do not auto-load from cwd/`plugins/` without explicit user opt-in + absolute allowlisted path.
- Prefer restricted execution (separate process + IPC) or at least: signature/hash, no `sys.path` mutation, read-only OB facade, timeout on load.
- If packaging: never bundle untrusted `plugins/` into the app; load only from user Application Support path after consent.

---

## 3. PyInstaller Packaging Gaps

### 3.1 `FlowMap.spec` (minimal)

```text
Analysis(['run_flowmap.py'], datas=[], hiddenimports=[], excludes=[], …)
EXE(..., console=False, upx=True, …)
COLLECT → BUNDLE name='FlowMap.app', icon=None, bundle_identifier=None
```

| ID | Severity | Gap | Impact |
|----|----------|-----|--------|
| **R13-P1** | **P0** | **`datas=[]`** — no explicit data files, assets, Qt platform plugins path overrides, cert bundles (except those hooks pull), user plugins, sample data | Missing non-Python resources if any are added; no packaged default data dir |
| **R13-P2** | **P0** | **`hiddenimports=[]`** — relies purely on static analysis | Lazy imports (`ccxt.pro`, crypcodile submodules, OpenGL, plugins) may be omitted or inconsistently included |
| **R13-P3** | **P0** | **`console=False`** on macOS windowed app | Startup exceptions produce **no terminal, hard to diagnose** crash-on-start |
| **R13-P4** | **P1** | **`upx=True`** on Darwin | Known to break some dylibs / code signing; flaky launches |
| **R13-P5** | **P1** | **`bundle_identifier=None`** → Info.plist shows `FlowMap` only; **version `0.0.0`**; generic icon | macOS privacy prompts, Gatekeeper, multi-instance confusion |
| **R13-P6** | **P1** | **No `excludes` for bloat** | Dist pulls **web3, eth_*, pyarrow headers/tests, numba, polars, duckdb, altair, PIL, …** via ccxt/crypcodile graph — huge app, longer cold start, more binary-load failure surfaces |
| **R13-P7** | **P1** | **No frozen-aware resource helper** (`sys._MEIPASS` / `sys.frozen`) **anywhere** in codebase | Any future relative path to assets fails in onedir/app |
| **R13-P8** | **P1** | **Hardcoded developer data path baked into binary** | See §6 |
| **R13-P9** | **P2** | Spec entry is `run_flowmap.py` which tries venv re-exec | When frozen, `import PyQt6` succeeds so re-exec path skipped — OK; but venv logic is dead weight and confuses analysis |
| **R13-P10** | **P2** | **`pyqtgraph`** listed in setup/requirements but **never imported** in app code | Dead dep; may or may not be in bundle; not required for start |
| **R13-P11** | **P2** | Qt OpenGL used optionally (`QOpenGLWidget`) without forced hidden import / plugin packaging notes | Headless/remote macOS may fail OpenGL; code falls back to `QWidget` if ImportError only — **runtime GL init failures may still crash** |
| **R13-P12** | **P2** | No `collect_all` / hooks for `crypcodile` if present | Replay/live optional; if partially collected → mysterious import errors |

### 3.2 Dist structure (observed)

```
dist/
├── FlowMap.app/Contents/
│   ├── MacOS/FlowMap
│   ├── Info.plist          # CFBundleIdentifier=FlowMap, version 0.0.0
│   ├── Frameworks/         # ~490 files: *.so, dylib, Qt, numpy, pyarrow, …
│   └── Resources/          # mirrors bulk of _internal + icns
├── FlowMap/                # onedir sibling
│   ├── FlowMap
│   └── _internal/          # same native stack
└── FlowMap.dmg
```

Notable: **no top-level `plugins/` or sample data** under Resources; pure Python packages live in PYZ / archive (not always visible as dirs).

### 3.3 Build warnings

`build/FlowMap/warn-FlowMap.txt` is large; mostly optional/platform stubs (winreg, many numpy/numba/polars optionals). **No flowmap-specific missing-module lines** were found. That does **not** mean runtime is complete — only that analysis resolved import graph from the venv used to build.

---

## 4. Empty / Stub Packages

| Directory | Contents | Risk |
|-----------|----------|------|
| `flowmap/indicators/` | Empty, no `__init__.py` | Not a package; future `import flowmap.indicators` fails; roadmap residue |
| `flowmap/trading/` | Empty | Same |
| `flowmap/utils/` | Empty | Same |
| `flowmap/ui/bubbles/` | Empty dir next to `bubbles.py` | Namespace ambiguity if someone adds `ui/bubbles/__init__.py` later (shadows module) |
| `flowmap/ui/tape/` | Empty | Same |

`find_packages()` does **not** include empty non-`__init__` dirs (good). However **`plugins/` at repo root** is a real package (`plugins/__init__.py`) and appears in `flowmap.egg-info/top_level.txt` as **second top-level package `plugins`** — installable name collision risk with other projects’ `plugins` namespace.

---

## 5. CLI Args / Entry Points

### 5.1 setuptools

```python
entry_points={"console_scripts": ["flowmap=flowmap.main:main"]}
```

- Version: `0.1.0` in setup.py vs **0.0.0** in bundled Info.plist.
- `install_requires`: PyQt6, numpy, **pyqtgraph (unused)**, sortedcontainers.
- Crypto deps only under extras; **`requirements.txt` always installs ccxt/aiohttp/websocket-client**.
- **`crypcodile` not listed** in setup.py or requirements.txt (optional import).
- `long_description=open("README.md").read()` — no encoding; fails if README missing at sdist build; non-UTF8 locales risk.

### 5.2 Runtime CLI

| Entry | Args |
|-------|------|
| `flowmap.main:main` | **None** — only `QApplication(sys.argv)` |
| `run_flowmap.py` | Passes `sys.argv` through on venv re-exec; no parser |
| MainWindow defaults | Hardcoded `symbol`, `data_dir`, `historical_hours` — **not overridable via CLI** |

**No argparse / click / typer.** Environment knobs found:

- `FLOWMAP_RENDERER=opengl|cpu` — heatmap backend (`heatmap_widget.py`)
- Heuristic: if `sys.argv[0]` contains `test|verify|benchmark|profile` → force CPU path

### 5.3 Autostart behavior (not CLI, but startup contract)

```python
# main_window.py ~60–62
self._source.switch_to(self._source.data_source)  # default CRYPCODILE_LIVE
QTimer.singleShot(500, self._source.toggle_simulation)
```

Comment says “Crypcodile **Replay**”; code defaults to **`DataSource.CRYPCODILE_LIVE`**. README still mentions Simulator as a toolbar option; **`DataSource` enum only has REPLAY + LIVE** — Simulator UI path is effectively gone while `MarketSimulator` / `CryptoProvider` imports remain.

---

## 6. Crash-on-Start Hypotheses (Packaged App)

Ranked for **dist/`FlowMap.app`**:

| ID | Severity | Hypothesis | Why |
|----|----------|------------|-----|
| **R13-C1** | **P0** | **Hardcoded `data_dir="/Users/nazmi/data"`** in `MainWindow` and `SourceManager` | Other machines / DMG users: path missing. May not hard-crash if crypcodile guards paths, but auto-start live/replay still runs; replay fallbacks re-list `/Users/nazmi/data` first (`source_manager.py:218–219`). |
| **R13-C2** | **P0** | **`console=False` + early exception** (import/Qt platform plugin / dyld) | User sees dock bounce then exit; no stderr. |
| **R13-C3** | **P0** | **Qt platform / rpath / signed dylib load failure** after UPX or incomplete COLLECT | Classic PyInstaller macOS one-shot death. |
| **R13-C4** | **P1** | **OpenGL context creation fails** when defaulting to `QOpenGLWidget` (non-test argv) | Import succeeds; context init can abort native. Env `FLOWMAP_RENDERER=cpu` is escape hatch but not set in bundle. |
| **R13-C5** | **P1** | **Crypcodile missing or partial** in frozen env | Import is try/except → soft failure (“provider not available”); auto `toggle_simulation` may no-op. Not always crash, but “broken start”. |
| **R13-C6** | **P1** | **Network/async init in live path at t+500ms** without crypcodile → status message only; with crypcodile → thread/WS errors | Can race GUI if exceptions escape signal handlers. |
| **R13-C7** | **P1** | **Gatekeeper / quarantine on DMG** | Unsigned/`bundle_identifier` weak; first launch blocked. |
| **R13-C8** | **P2** | **`SourceManager.simulator` property** returns `self._simulator` but **`_simulator` is never assigned** | AttributeError if anything touches property (latent). |
| **R13-C9** | **P2** | **Bloat cold-start** (pyarrow/numba/ccxt graph) | Slow start mistaken for hang; memory pressure on low-RAM Macs. |
| **R13-C10** | **P2** | **Plugin auto-load if later wired to cwd `plugins/`** | In app bundle cwd is often `/` or `Contents/MacOS` — empty or unexpected; if user places malware in scan path → RCE (R13-S1). |
| **R13-C11** | **P3** | **Debug prints to stdout** (`[DEBUG] switch_to`, heatmap backend) | Invisible with console=False; no user-facing log file. |

### High-confidence packaging bugs (code facts)

1. **Developer absolute paths** in shipped defaults (`main_window.py:31`, `source_manager.py:87`, `218–219`).
2. **No `sys.frozen` / `_MEIPASS` handling**.
3. **Spec has empty `datas` / `hiddenimports` / `excludes`**, windowed, UPX on.
4. **Plugins not integrated** — packaging them is currently moot; enabling without hardening is a security regression.
5. **Entry-point / README drift**: Simulator claimed; enum is live/replay only; setup omits crypcodile; pyqtgraph unused.

---

## 7. Dependency & Packaging Consistency Matrix

| Dependency | setup.py | requirements.txt | Used by app | In dist (observed) |
|------------|----------|------------------|-------------|--------------------|
| PyQt6 | yes | yes | yes | yes (QtCore/Gui/Widgets/OpenGL) |
| numpy | yes | yes | yes | yes |
| sortedcontainers | yes | yes | yes (`OrderBook`) | pure-py (likely in PYZ) |
| pyqtgraph | yes | yes | **no imports** | not as named folder |
| ccxt | extra only | yes | lazy in `crypto.py` | transitive (web3, eth_*, …) |
| aiohttp | extra | yes | crypcodile/ccxt | yes |
| websocket-client | extra | yes | ? | ? |
| crypcodile | **no** | **no** | optional providers | not visible as top-level dir |
| duckdb / polars / pyarrow | no | no | via crypcodile | **yes** (large) |
| numba | no | no | transitive? | **yes** |

---

## 8. Recommended Phase-2 Focus (Packaging / Plugins)

1. **P0:** Replace hardcoded `/Users/nazmi/data` with portable default (`~/Library/Application Support/FlowMap` or empty + picker); never ship machine-local paths.
2. **P0:** Spec hygiene: `console=True` for debug builds; disable UPX on macOS; set `bundle_identifier` + version; explicit `hiddenimports` for crypcodile/OpenGL if required.
3. **P0:** Decide plugin security model **before** wiring auto-load into `MainWindow`.
4. **P1:** Wire plugin pipeline fully or delete/document as experimental-only (currently half-built).
5. **P1:** Slim excludes: drop unused eth/web3 if only needed for unused ccxt venues; drop pyqtgraph from requires if unused.
6. **P1:** Add CLI: `--data-dir`, `--symbol`, `--source`, `--renderer`, `--plugins-dir`, `--no-autostart`.
7. **P2:** Remove empty stub dirs or add proper packages; stop installing root `plugins` as top-level package name (use `flowmap_user_plugins` or docs-only folder without package install).
8. **P2:** Crash log file next to app / in Application Support for windowed mode.

---

## 9. File:line Index (quick)

| Topic | Location |
|-------|----------|
| Plugin exec | `flowmap/plugins/loader.py:79–93` |
| Plugin discover default | `flowmap/plugins/loader.py:28–29` |
| OrderBook exposure | `flowmap/plugins/plugin_api.py:238–240` |
| Callback wrap | `flowmap/plugins/plugin_api.py:423–461` |
| Example register | `plugins/example_indicator.py:20+` |
| Entry main | `flowmap/main.py:10–20` |
| Dev launcher | `run_flowmap.py:1–25` |
| Hardcoded data_dir | `flowmap/ui/main_window.py:31`, `source_manager.py:87` |
| Autostart | `main_window.py:60–62` |
| Renderer env | `heatmap_widget.py:33–52` |
| Spec | `FlowMap.spec:1–50` |
| setuptools entry | `setup.py:29–33` |
| Egg entry | `flowmap.egg-info/entry_points.txt` |
| Empty stubs | `flowmap/{indicators,trading,utils}/`, `ui/{bubbles,tape}/` |

---

## 10. Summary

Plugin **infrastructure exists and is powerful (RCE-class if enabled)** but is **orphaned**: no load site, no render consumption, incomplete data wiring. Packaging is a **default PyInstaller stub** shipping a **developer machine path**, **windowed silent failures**, **unsigned/minimal bundle metadata**, and a **very large transitive dependency tree**. Empty `indicators`/`trading`/`utils` packages are placeholders only. **No real CLI** — only env/heuristic renderer switches. Highest-priority crash/broken-start risks for packaged users are **hardcoded paths**, **silent console=False exits**, **OpenGL default**, and **optional crypcodile/live autostart** without portable configuration.
