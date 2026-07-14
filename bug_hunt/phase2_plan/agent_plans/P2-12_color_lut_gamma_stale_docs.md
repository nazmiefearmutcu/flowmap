# P2-12 — Color LUT / gamma / stale docs audit

| Field | Value |
|-------|-------|
| **Agent ID** | P2-12 |
| **Theme** | Color LUT gamma stale docs |
| **Zones** | Z01 (Paint path & buffer→QImage) + engine color |
| **Siblings** | R07 §6, R09 (paint stack), R08 |
| **Finding prefix** | `FIND-P212-XX` |
| **Severity prior** | **P2–P1** (docs/dead code P2; wrong LUT if mis-selected P1) |
| **Primary files** | `engine/color_system.py`, `engine/density_engine.py`, `ui/heatmap_widget.py` |

---

## 1. Scope & linked zones / sibling hyps

### In scope

1. Inventory **all LUTs** and which code path uses each.  
2. Document **actual** intensity→RGBA math (power 2.5 + LUT index + alpha curves).  
3. Catalog **docstring lies** (gamma 0.35, alpha t^1.5, fixed ref).  
4. Confirm dead path `apply_color_lut` / green-red LUTs never hit live paint.  
5. Define golden LUT samples for regression.

### Out of scope

- Adaptive ref trajectory → P2-11  
- OpenGL vs CPU paint backend → P2-25  
- QImage buffer ownership → P2-28  

### Sibling anchors

| ID | Claim |
|----|-------|
| R07 §6 | Active = BOOKMAP_BID/ASK; build_lut legacy; HEATMAP_LUT mono unused in engine |
| R07 H15/H16 | Stale docs; dual color system confusion |
| R07 H6 | ratio**2.5 + gate 0.0005 hides medium sizes |
| Module header | `color_system.py:1-4` claims gamma 0.35 + alpha t^1.5 |

### Absolute paths

- `/Users/nazmi/flowmap/flowmap/engine/color_system.py`
- `/Users/nazmi/flowmap/flowmap/engine/density_engine.py` (LUT write ~376-382)
- `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py` (rebuild LUT write ~864-870)
- `/Users/nazmi/flowmap/flowmap/ui/heatmap/color_schemes.py` (if present — secondary)

---

## 2. Threat model

| Threat | How | Impact |
|--------|-----|--------|
| Wrong LUT selected | Future refactor wires `BID_LUT` instead of `BOOKMAP_*` | Classic green/red vs teal/amber product look change |
| Doc-driven “fix” | Engineer “fixes alpha to t^1.5” per docstring but code uses 0.6 / piecewise | Visual regression |
| Double nonlinearity ignored | Norm power 2.5 **then** LUT curve | Tuning sensitivity/ref without understanding both |
| Dead `apply_color_lut` re-enabled | Uses BID/ASK_LUT not Bookmap | Instant scheme switch |
| Embed / plugin | External code imports ColorSystem docs as API | Integration confusion |

**Security:** none (pure CPU LUTs).  
**Correctness:** intensity ranking and visibility of walls.

---

## 3. Concrete probes

### 3.1 Static inventory matrix

Build table from code (must complete Phase-3):

| Symbol | Builder | Shape | Used by engine live? | Used by rebuild? | Used by apply_color_lut? |
|--------|---------|-------|----------------------|------------------|---------------------------|
| `BG_COLOR` | constant | (4,) | Yes (clear) | Yes | No |
| `BID_LUT` | `build_lut(False)` | (256,4) | **No** | **No** | Yes |
| `ASK_LUT` | `build_lut(True)` | (256,4) | **No** | **No** | Yes |
| `HEATMAP_LUT` | `build_bookmap_lut` | (256,4) | **No** | **No** | No |
| `BOOKMAP_BID_LUT` | `build_bookmap_bid_lut` | (256,4) | **Yes** L378 | **Yes** L866 | No |
| `BOOKMAP_ASK_LUT` | `build_bookmap_ask_lut` | (256,4) | **Yes** L382 | **Yes** L870 | No |

### 3.2 Doc vs code diff (required output)

| Claim location | Claim | Actual code |
|----------------|-------|-------------|
| `color_system.py:3` | Gamma=0.35 + alpha t^1.5 | Only `build_lut` uses gamma 0.35; alpha is **t^0.6** (`:30-32`) |
| `ColorSystem` class doc `:162-164` | gamma 0.35 + alpha t^1.5 for BID/ASK | Class attributes include Bookmap LUTs that **ignore** that math |
| `build_lut` docstring `:14` | Alpha steep t^1.5 | Implementation t^0.6 |
| `normalizer.py:1-14` | Fixed ref 8000 linear | Adaptive p98 + **ratio**2.5 |
| R07 | decay accumulation | Unused in draw path |

### 3.3 Unit probes

**U1 — LUT monotonicity (alpha)**

```text
For BOOKMAP_BID_LUT, BOOKMAP_ASK_LUT, BID_LUT, ASK_LUT:
  for i in 0..255: assert alpha[i] <= alpha[i+1] + tol  (or document non-mono)
```

**U2 — Index mapping identity**

```text
norm in {0, 0.0005, 0.1, 0.5, 1.0}
idx = clip(norm*255, 0, 255).astype(int32)
assert buffer RGBA == LUT[idx]
```

**U3 — Double curve sample**

```text
size/ref = 0.5 → norm = 0.5**2.5 ≈ 0.1768 → idx ≈ 45
Document RGB at BOOKMAP_*[45] as golden
```

**U4 — Dead code reachability**

```text
rg "apply_color_lut|BID_LUT|ASK_LUT|HEATMAP_LUT" flowmap/
Confirm only color_system defines + (maybe tests/diagnostics)
```

**U5 — BBO overwrite color**

```text
density_engine.py:389-394 hard-coded [100,255,120,180] / [255,100,90,180]
Not from LUT — document as separate layer
```

### 3.4 Dynamic / GUI

- Screenshot live heatmap; verify teal bid / warm ask (Bookmap), not pure green/red (legacy).  
- If pure green/red appears → FIND wrong LUT path.

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF1 | Active path exclusively BOOKMAP_* for density | Any live use of build_lut LUTs without feature flag |
| PF2 | Module/class docs match active path | Docs describe only legacy gamma path |
| PF3 | Golden samples for idx 0,64,128,192,255 | Unstable/random colors |
| PF4 | Dead APIs marked deprecated or deleted plan | Silent dual public API |
| PF5 | BBO colors documented as hard-coded overlays | Treated as LUT bug |

---

## 5. Fixtures

| Fixture | Content |
|---------|---------|
| `fixtures/lut_golden_bookmap_bid.npy` | Full (256,4) uint8 dump at freeze date |
| `fixtures/lut_golden_bookmap_ask.npy` | Same for ask |
| `fixtures/lut_samples.json` | Selected idx → RGBA |
| Optional | Side-by-side PNG: legacy build_lut vs bookmap at same norm |

---

## 6. Phase-3 micro-tasks

1. **P3-12a** — Static call-graph of LUT usage; emit inventory table as FIND-P212-01 appendix.  
2. **P3-12b** — Unit test golden LUTs (hash or allclose); fail on accidental control-point edit.  
3. **P3-12c** — Rewrite docstrings: module header, `build_lut`, `ColorSystem`, `normalizer` (coord with P2-11).  
4. **P3-12d** — Decision: delete or quarantine `apply_color_lut` + unused LUTs; or expose scheme switcher.  
5. **P3-12e** — Document combined transfer function: size → ref → **2.5 → idx → LUT RGBA; add comment near write sites.

---

## 7. Finding ID format

`FIND-P212-XX`

| Seed | Title |
|------|-------|
| FIND-P212-01 | Active BOOKMAP vs dead build_lut dual system |
| FIND-P212-02 | Docstring alpha t^1.5 vs code t^0.6 |
| FIND-P212-03 | Class doc gamma applies only to unused LUTs |
| FIND-P212-04 | Double nonlinearity undocumented |
| FIND-P212-05 | BBO hard-coded colors not in LUT |

---

## 8. Fix strategy sketch

1. **Docs first:** single source of truth — “Active: Bookmap piecewise LUTs; intensity from AdaptiveNormalizer **2.5.”  
2. **Code hygiene:**  
   - Prefix legacy: `LEGACY_BID_LUT` or move to `color_system_legacy.py`.  
   - `apply_color_lut` raise `DeprecationWarning` or delete if unused.  
3. Optional feature: `color_scheme: bookmap|classic` with explicit tests.  
4. Keep BBO colors in config constants, not magic arrays in `_draw_column`.

---

## 9. Dependencies

| Theme | Why |
|-------|-----|
| **P2-11** | Norm produces idx; LUT consumes it — joint golden |
| **P2-07** | Side mask selects bid vs ask LUT |
| **P2-25** | Paint backend must not re-color |
| **P2-28** | QImage views same uint8 buffer |

No hard block from concurrency track.

---

## 10. Severity priors

| Item | Prior |
|------|-------|
| Stale docs only | P3/P2 |
| Wrong LUT if refactor | P1 |
| Visibility (power+gate) | P1 (shared R07 H6) |
| R20 | HIGH engine color (risk 16) |

---

## 11. Code anchors

```1:4:/Users/nazmi/flowmap/flowmap/engine/color_system.py
""" ... Gamma=0.35 linear color ramps + alpha t^1.5 curve. ... """
```

```30:32:/Users/nazmi/flowmap/flowmap/engine/color_system.py
        # Alpha: gentle t^0.6 curve for wide dynamic range
        a = int(255 * (t ** 0.6))
```

```168:173:/Users/nazmi/flowmap/flowmap/engine/color_system.py
    BID_LUT = build_lut(...)
    BOOKMAP_BID_LUT = build_bookmap_bid_lut()
    BOOKMAP_ASK_LUT = build_bookmap_ask_lut()
```

```376:382:/Users/nazmi/flowmap/flowmap/engine/density_engine.py
            self._buffer[active_bids, col, :] = ColorSystem.BOOKMAP_BID_LUT[bid_idx]
            ...
            self._buffer[active_asks, col, :] = ColorSystem.BOOKMAP_ASK_LUT[ask_idx]
```
