# P2-08 — Buffer Scroll + Clear-Right Column

**Agent:** P2-08  
**Track:** A — Core correctness  
**Theme n:** 8  
**Finding ID prefix:** `FIND-P208-`  
**Severity prior:** **P1** (ghost columns / smear; P0 if clear missing → permanent visual corruption)

---

## 1. Scope & linked zones / sibling hyps

| Item | Value |
|------|-------|
| **Zones** | **Z02** |
| **Siblings** | R07 §1.1, §7; R08 rebuild/drag scroll; R20 density buffer |
| **Primary** | `density_engine.py` push_snapshot scroll :250–257 |
| **Related** | `resize`, vertical `np.roll` recenter :~220–244; heatmap drag horizontal roll; `_render_single_history_column` |

### Design intent (R07)

```text
buffer[:, :-1] = buffer[:, 1:]   # scroll left (history)
buffer[:, -1] = BG_COLOR         # clear rightmost before draw
_draw_column(...)                # paint new live edge
```

Without clear-right: vanished levels leave **stale pixels** (ghost walls).

---

## 2. Threat model

| Failure | Mechanism | Symptom |
|---------|-----------|---------|
| Missing clear | Draw without BG fill | Ghost liquidity after size→0 |
| Wrong axis scroll | Typo on rows vs cols | Time/price axis confusion |
| col_idx path skips scroll/clear | Drag fill path | Stale or partial columns |
| Resize copy wrong | Right-align history | Blank gap / smear (H15 related P2-29) |
| Vertical roll without fill | recenter | Black bands expected; wrong fill → garbage |
| Race rebind buffer | QImage lifetime | P2-28 overlap |
| auto_follow false | No engine push | Buffer frozen while history grows — by design; rebuild required |

---

## 3. Concrete probes

### 3.1 Static

1. Confirm scroll+clear only when `col_idx is None` :250–255.  
2. Trace `col_idx is not None` branch — no scroll.  
3. `ColorSystem.BG_COLOR` value (expect black opaque).  
4. heatmap `scroll_time` / drag path buffer ops.

### 3.2 Unit — ghost prevention

| Probe | Steps | Assert |
|-------|-------|--------|
| S1 | Push col with large bid wall → next push empty book same mid | Rightmost col all BG (or only BBO lines) — **no** old wall RGB |
| S2 | N consecutive pushes | Column k content equals snapshot k; left is older |
| S3 | After scroll, former col[-1] appears at col[-2] | Pixel equality |
| S4 | col_idx=5 draw | Only column 5 changes; no global scroll |
| S5 | Buffer width 1 edge case | No crash; clear works |
| S6 | Vertical recenter delta ±1 | Edge rows BG |

### 3.3 Dynamic

1. Live: cancel large wall → right edge must not leave trail for >1 frame.  
2. Rapid scroll drag then release rebuild — interim vs final (R08 H7).  
3. Resize window width — history blank? (file under P2-29 if H15).

### 3.4 Anchors

| Topic | Line |
|-------|------|
| Scroll + clear | `density_engine.py:250–255` |
| Draw | `density_engine.py:255–257, 259+` |
| Vertical roll fill | `density_engine.py` ~220–244 |
| Widget resize | `heatmap_widget.py` resizeEvent ~2333 |
| Drag column fill | `_render_single_history_column` ~877 |

---

## 4. Pass / fail criteria

| | Criteria |
|--|----------|
| **PASS** | S1–S3 green; no ghost walls when levels vanish; col_idx path isolated; BG constant |
| **FAIL** | S1 fails (stale pixels); scroll shifts wrong direction; width-1 crash |

---

## 5. Fixtures

Synthetic engine only — small `hm_width`, `vis_rows`, known BG_COLOR. Optional PNG of column before/after.

---

## 6. Phase-3 micro-tasks

### P2-08-H1 — Clear-right unit S1  
FIND-P208-01 if ghosts.

### P2-08-H2 — Scroll conservation S2–S3  
Pixel shift proof.

### P2-08-H3 — col_idx no-scroll S4  
Drag path safety.

### P2-08-H4 — Vertical roll edge fill S6  
Black band correctness.

### P2-08-H5 — Cross-check resize vs scroll  
If blank history, cross-file FIND with P2-29 prefix or dual-cite.

---

## 7. Finding ID prefix

`FIND-P208-`

| ID | Issue |
|----|-------|
| FIND-P208-01 | Ghost pixels without clear |
| FIND-P208-02 | Scroll direction/time inversion |
| FIND-P208-03 | col_idx side effects |
| FIND-P208-04 | Vertical roll garbage |
| FIND-P208-05 | Width edge crash |

---

## 8. Fix strategy sketch

1. Keep clear-right mandatory before draw on live path.  
2. Centralize `scroll_left_and_clear()` helper used by all paths.  
3. On resize, full rebuild (not single column) — coordinate P2-29.  
4. Tests lock BG_COLOR bytes.

---

## 9. Dependencies

| | |
|--|--|
| **Depends** | P2-07 for meaningful draw content |
| **Related** | P2-29 resize; P2-28 QImage; P2-09 tick for row stability |
| **Blocks** | Trust in live incremental paint |

---

## 10. Severity priors

| Issue | Prior |
|-------|-------|
| Missing clear-right | **P0** visual corruption |
| Expected black bands on recenter | **P2** |
| Resize blank | **P1→P0** (H15, other theme) |
| Drag interim diverge | **P1** |

**Wave:** W2.
