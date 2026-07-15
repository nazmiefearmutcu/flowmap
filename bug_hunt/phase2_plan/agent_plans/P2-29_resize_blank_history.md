# P2-29 — Resize blank history (H15)

| Field | Value |
|-------|-------|
| **Agent** | P2-29 |
| **Theme n** | 29 |
| **Slug** | `resize_blank_history` |
| **Zones** | **Z01**, **Z02** |
| **Sibling fuel** | **R08** H15 (detail), H8; **R09** B06 partial resize; **R20** top#9 / P1-01 |
| **Primary modules** | `heatmap_widget.py` `resizeEvent` L2333–2349; `push_snapshot` size check L388–390; `density_engine.resize` L396–421 |
| **Track** | C — Rendering & performance |
| **Wave** | **W3** — **do not skip** (visual ship-breaker) |

---

## 1. Scope & linked zones / sibling hyps

### In scope

1. `resizeEvent` path:
   - Computes `vr`, `target_bw`.
   - If size changed: `engine.resize(vr, target_bw)`; updates `_last_vis_rows` / `_last_hm_w`; **single** `engine.push_snapshot(current levels)` only; dirty cache; **no** `rebuild_heatmap()`.
2. Why blank history:
   - `engine.resize` allocates new buffer mostly BG; copies only partial old strip.
   - One column push fills **one** column (live path), not full history.
   - Next `push_snapshot` sees `vr == _last_vis_rows` and `target_bw == _last_hm_w` → **skips** `rebuild_heatmap()` → incremental only → history remains blank/garbled until something else rebuilds (zoom, Go Live, etc.).
3. Variants: width-only, height-only, maximize, DPI change, column_width interaction.
4. `auto_follow` False during resize.
5. Partial pixel copy in `engine.resize` ghosting (R09-B06).

### Out of scope

| Concern | Owner |
|---------|-------|
| Rebuild cost of fix | P2-26 (tradeoff) |
| Throttle if fix uses throttled rebuild | P2-27 |
| QImage rebind on resize | P2-28 |

### Sibling map

| ID | Claim | Sev |
|----|-------|-----|
| R08-H15 | resize partial push; may skip full rebuild | MED visual → **P1→P0** in R20 |
| R20 top#9 | Resize blank history | P1→P0 visual |
| R20 P1-01 | Resize one-column push | P1 |

### Code anchors

```
heatmap_widget.py
  L2333–2349 resizeEvent
  L388–405   push_snapshot: if vr/bw != last → rebuild_heatmap; elif auto_follow → push; else dirty only
  L127–128   _last_vis_rows/_last_hm_w init -1
density_engine.py
  L396–421   resize new buffer, partial copy, _needs_rebuild=True  # flag may be ignored by widget!
```

**Note:** `engine._needs_rebuild = True` on resize — verify whether any consumer honors it (likely **not** in widget).

---

## 2. Threat model

### Assets

| Asset | Failure |
|-------|---------|
| Historical heatmap after window chrome change | Blank / BG-only history |
| Trader muscle memory (resize to see more) | Trust break |
| Partial ghost columns | Misleading walls |

### Scenarios

| # | Scenario | Expected bug |
|---|----------|--------------|
| S1 | Grow window wider with long history, auto_follow on | Blank left history, one live column |
| S2 | Shrink height (more/fewer rows) | Vertical distortion / blank |
| S3 | After S1, wait for many live ticks without zoom | Still blank if sizes match (H15 detail) |
| S4 | After S1, press L / Go Live | Full rebuild recovers (control) |
| S5 | Resize while not auto_follow | Possibly worse (no incremental column) |
| S6 | Continuous drag resize | Many resizes; thrash vs blank |
| S7 | `_needs_rebuild` ignored | Design FIND |

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| ST-1 | Confirm resizeEvent never calls rebuild_heatmap |
| ST-2 | Confirm `_last_*` updated **before** next push can rebuild |
| ST-3 | Grep `_needs_rebuild` consumers |
| ST-4 | Compare reset/zoom paths that do rebuild |

### 3.2 Unit / widget test

| ID | Steps | Assert |
|----|-------|--------|
| U1 | Fill history with N colored synthetic columns via push_snapshot loop; `resize(w+200,h)`; grab buffer | Non-BG pixel count in left columns > threshold OR explicit rebuild called |
| U2 | After resize, one more push_snapshot; assert still blank left if bug | Documents H15 |
| U3 | After resize, call rebuild_heatmap; assert recovery | Control |
| U4 | engine.resize only; check `_needs_rebuild` | True but ignored |
| U5 | Height-only change | Row mapping intact post-fix |

### 3.3 Dynamic GUI

| ID | Action | Fail look |
|----|--------|-----------|
| G1 | Live or replay 30s; drag window corner | History wipe |
| G2 | Maximize / restore | Blank |
| G3 | Split view / DPI | Blank or stretch garbage |

### 3.4 Instrumentation

| ID | Log |
|----|-----|
| I1 | Counter: resizeEvent → rebuild? push? |
| I2 | Buffer histogram % BG after resize |

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF-1 | After resize with history len ≥ target_bw, visible history shows prior density (not all BG) | Blank history |
| PF-2 | No permanent blank until unrelated user action | Requires zoom to fix |
| PF-3 | `_needs_rebuild` honored or removed | Dead flag |
| PF-4 | Resize + live ticks don't leave ghost wrong-size columns | Garbled |
| PF-5 | Performance: resize may hitch (P2-26) but correctness first | Prefer correct rebuild over silent blank |

**Severity:** Visual ship-breaker → **P0** if blank is default after common resize; else **P1**.

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| Synthetic history painter (known non-BG pattern per column index) | U1 pixel test |
| Offscreen HeatmapWidget 800×600 → 1200×600 | U1 |
| Replay 2 min SOL | G1 realism |
| Screenshot before/after resize | Evidence pack |
| BG color constant from ColorSystem | Threshold compare |

---

## 6. Phase-3 micro-tasks

### MT-29-1 — Confirm H15 with U1/U2
Must produce FIND-P229-01 with screenshots + buffer stats.

### MT-29-2 — `_needs_rebuild` dead flag audit
FIND if set but never read.

### MT-29-3 — Call-path matrix
resize vs push size-mismatch vs zoom vs go live — which repaint full history.

### MT-29-4 — Fix validation (design)
Options: (A) `resizeEvent` → `rebuild_heatmap()`; (B) `request_rebuild_throttled()`; (C) don't update `_last_*` until rebuild done so next push rebuilds; (D) incremental re-project columns without full rebuild. Recommend A or B with P2-26 cost note.

### MT-29-5 — Regression test
Lock U1 as permanent test.

---

## 7. Expected finding IDs

Format: **`FIND-P229-XX`**

| ID | Title | Sev prior |
|----|-------|-----------|
| FIND-P229-01 | resizeEvent one-column push + last_* update skips history rebuild | **P0/P1** |
| FIND-P229-02 | engine._needs_rebuild ignored by widget | **P1** |
| FIND-P229-03 | Partial buffer copy ghosts wrong history | **P1** |
| FIND-P229-04 | auto_follow False resize leaves no columns | **P1** |
| FIND-P229-05 | Continuous resize thrash if naively full rebuild each event | **P2** (fix) |

---

## 8. Fix strategy sketch

**Primary fix:** In `resizeEvent`, after `engine.resize`, call `request_rebuild_throttled()` or `rebuild_heatmap()` if `len(self._history) > 0`.

**Do not** set `_last_vis_rows/_last_hm_w` until rebuild completes — alternative that forces next `push_snapshot` to rebuild (careful of loops).

**Throttle** resizes during interactive drag of window edge to avoid N full rebuilds (debounce 50 ms) — align with P2-27 timer.

**Honor `_needs_rebuild`:** push_snapshot checks flag → rebuild.

**Tests:** U1 regression mandatory.

---

## 9. Dependencies

| Dep | Note |
|-----|------|
| **P2-26** | Fix increases rebuild frequency |
| **P2-27** | Debounced rebuild on resize |
| **P2-28** | resize rebinds buffer |
| **P2-11** | rebuild path correctness |
| **P2-08** | buffer scroll semantics after resize |

**Blocked by:** None for proving H15. Fix may wait P2-26 budget awareness.

---

## 10. Severity priors

| Item | Prior | Source |
|------|-------|--------|
| Blank history after resize | **P0 visual / P1** | R20 top#9, R08-H15 |
| Code-evident mechanism | **Very high confidence** | resizeEvent source |
| User frequency | High (windowing) | UX |

**Phase-3 rule:** Theme incomplete without automated U1 repro. Prefer FIND with image artifacts.
