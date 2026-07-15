# P2-25 — OpenGL base vs CPU paint

| Field | Value |
|-------|-------|
| **Agent** | P2-25 |
| **Theme n** | 25 |
| **Slug** | `opengl_vs_cpu_paint` |
| **Zones** | **Z01** |
| **Sibling fuel** | **R08** H16, §2.1; **R09** paint stack; **R13** C4 packaged GL; **R20** Z01 |
| **Primary module** | `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py` L31–52, `paintEvent`, `render` |
| **Secondary** | Packaging `FlowMap.spec`, tests selecting backend via argv/`FLOWMAP_RENDERER` |
| **Track** | C — Rendering & performance (head of 25–34) |
| **Wave** | **W3** (after W1 data plane); can **static-audit in W1/W2** |

---

## 1. Scope & linked zones / sibling hyps

### In scope

1. Backend selection: `FLOWMAP_RENDERER=opengl|cpu`, argv heuristics (`test|verify|benchmark|profile` → CPU), default try `QOpenGLWidget`.
2. **No `paintGL` / shaders** — both backends share `paintEvent` + `QPainter` + `QImage` from NumPy.
3. Behavioral deltas: `grabFramebuffer` vs `grab` / `render()`, compositing, DPR, transparency, packaged GL context failure.
4. Test gap: CI often forces CPU; production OpenGL untested.
5. Document whether OpenGL provides any acceleration today (hypothesis: **surface only**).

### Out of scope

| Concern | Owner |
|---------|-------|
| Full rebuild freeze cost | **P2-26** |
| QImage buffer lifetime | **P2-28** |
| Resize blank history | **P2-29** |
| Real GL optimization project | Future (not this hunt) |

### Sibling map

| ID | Claim |
|----|-------|
| R08-H16 | OpenGL vs CPU test gap — MED |
| R08 §2.1 | OpenGL only changes base class |
| R13-C4 | OpenGL context fail packaged |
| R09 | paintEvent path shared |

### Code anchors

```
heatmap_widget.py
  L31–52   backend selection; BaseHeatmapWidget = QWidget | QOpenGLWidget
  L60      class HeatmapWidget(BaseHeatmapWidget)
  L1103–1125 render() compatibility (grabFramebuffer fallback expected)
  L1129+   paintEvent shared CPU painter path
```

---

## 2. Threat model

### Assets

| Asset | Failure |
|-------|---------|
| Correct pixels on user machines | Blank widget, black frame, crash on GL init |
| Test fidelity | CI green, production broken (or inverse) |
| Performance expectations | Marketing “GPU” without benefit; wrong perf tuning |
| Screenshot / automation | `grab` empty on GL |

### Scenarios

| # | Scenario | Risk |
|---|----------|------|
| S1 | Packaged app on headless/old GPU | QOpenGLWidget fails mid-import or at show |
| S2 | Tests force CPU; bug only on GL path in `render()`/`resize` | Escape hatch |
| S3 | `grabFramebuffer` vs software grab mismatch in verify scripts | False test fails |
| S4 | Mixed DPI / retina: GL FBO size ≠ widget size | Blurry or clipped heatmap |
| S5 | Parent widget over GL child: stacking/transparency | VWAP overlay mis-composite |
| S6 | `FLOWMAP_RENDERER` unset in prod → GL; in pytest → CPU | Dual behavior |

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| ST-1 | Grep `paintGL`, `initializeGL`, `QOpenGL` usage beyond base class |
| ST-2 | Document full decision tree for `use_opengl` |
| ST-3 | Find all `render(`/`grab`/`grabFramebuffer` call sites |
| ST-4 | Packaging: hiddenimports for QtOpenGLWidgets |

### 3.2 Unit / dual-backend

| ID | Steps | Assert |
|----|-------|--------|
| U1 | Instantiate under `FLOWMAP_RENDERER=cpu` and `opengl` | Class MRO contains expected base |
| U2 | Push synthetic buffer; `QTest` expose; grab image both backends | Pixel MSE < threshold (same data) |
| U3 | Force ImportError on QOpenGLWidgets | Falls back to QWidget; no crash |
| U4 | `render()` API both backends | Returns usable QImage/QPixmap |

### 3.3 Dynamic / packaged

| ID | Steps |
|----|-------|
| D1 | Run app with `FLOWMAP_RENDERER=opengl` vs `cpu` side-by-side | Visual parity |
| D2 | Packaged .app cold start on Mac without GL fallback path | Crash/black |
| D3 | Automation screenshot pipeline both modes | Non-empty frames |

### 3.4 GUI

| ID | Check |
|----|-------|
| G1 | Crosshair / overlays / VWAP child on GL parent | Alignment |
| G2 | Resize spam both backends | No blank permanent (coord P2-29) |

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF-1 | Documented: GL is FBO surface only unless shaders added | Code claims GPU path that doesn't exist without docs |
| PF-2 | CI matrix includes **both** backends for paint smoke | Only CPU tested |
| PF-3 | Packaged failure degrades to CPU or clear error | Silent black widget |
| PF-4 | Pixel parity synthetic scene GL vs CPU within tolerance | Systematic color/size skew |
| PF-5 | `render()`/grab works for diagnostics on both | One backend always empty |

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| Synthetic DensityEngine buffer (known gradient) | Pixel compare |
| Env matrix runner: `FLOWMAP_RENDERER` × offscreen platform | CI |
| Golden PNG for CPU reference | Diff |
| Offscreen `QT_QPA_PLATFORM=offscreen` notes for GL limits | Docs |

---

## 6. Phase-3 micro-tasks

### MT-25-1 — Backend decision tree + dead code audit
Write findings: no paintGL; list env/argv rules.

### MT-25-2 — Dual-backend pixel smoke
U2 automated; FIND if parity fails.

### MT-25-3 — `render()` / grab path audit
Line-level review L1103–1125; FIND for GL-only bugs.

### MT-25-4 — Packaging / context failure
Reproduce missing OpenGL; recommend fallback policy for Phase-4.

### MT-25-5 — Test policy recommendation
pytest always CPU **plus** nightly opengl job if hardware allows.

---

## 7. Expected finding IDs

Format: **`FIND-P225-XX`**

| ID | Title | Sev prior |
|----|-------|-----------|
| FIND-P225-01 | OpenGL base without GPU paint path (docs/perf smell) | **P2/P3** |
| FIND-P225-02 | Test/prod backend divergence gap | **P1** |
| FIND-P225-03 | Packaged GL context failure → blank/crash | **P0/P1** (R13) |
| FIND-P225-04 | grabFramebuffer vs CPU grab behavioral split | **P1** automation |
| FIND-P225-05 | DPR / FBO sizing skew on retina | **P1** |
| FIND-P225-06 | Child overlay compositing on QOpenGLWidget | **P2** |

---

## 8. Fix strategy sketch

1. **Docs:** README + code comment — “OpenGL backend = QOpenGLWidget surface; rendering still QPainter.”
2. **Default policy:** prefer CPU for stability **or** GL with mandatory CPU fallback on failure (catch init).
3. **CI:** parametrize backend smoke tests.
4. **render():** single abstraction `capture_widget()` handling both.
5. Future GPU work is a **new project** (texture upload of buffer) — out of Phase-3 fix scope unless trivial.

---

## 9. Dependencies

| Dep | Note |
|-----|------|
| **P2-28** | QImage path shared; GL may worsen lifetime bugs |
| **P2-26/27/29** | Perf/visual bugs must be checked both backends |
| **P2-48** | Packaging OpenGL hiddenimports |
| **P2-50** | GUI automation grab backend |

---

## 10. Severity priors

| Item | Prior | Source |
|------|-------|--------|
| Test gap | **P1** | R08-H16 |
| Packaged GL fail | **P0/P1** | R13-C4, R20 |
| “Fake GPU” docs | **P3** | Smell |
| Pixel parity unknown | **P1** until measured | — |

**Confidence:** **Very high** that no custom GL paint exists (static). **Medium** on production GL defect rate.
