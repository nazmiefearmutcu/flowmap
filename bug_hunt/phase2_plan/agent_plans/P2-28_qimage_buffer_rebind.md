# P2-28 — QImage zero-copy / buffer rebind

| Field | Value |
|-------|-------|
| **Agent** | P2-28 |
| **Theme n** | 28 |
| **Slug** | `qimage_buffer_rebind` |
| **Zones** | **Z01** |
| **Sibling fuel** | **R08** H6; **R09** B02, paint notes; **R20** Z01 paint path |
| **Primary modules** | `heatmap_widget.py` paintEvent QImage wrap; `density_engine.py` `_buffer` rebind (`resize`, `np.roll` assign) |
| **Track** | C — Rendering & performance |
| **Wave** | **W3** |

---

## 1. Scope & linked zones / sibling hyps

### In scope

1. `QImage(buf.data, bw, bh, bw*4, Format_RGBA8888)` **without** `.copy()` — Qt does not own pixels.
2. Lifetime of `buf` / `engine._buffer` while QImage alive (during `drawImage` and any retained QImage).
3. Rebind sites: `density_engine.resize` → `self._buffer = new_buf`; `np.roll` results assigned to `_buffer`; possible future threads.
4. Same-thread re-entrancy: `rebuild`/`push`/`resize` triggered from nested event processing during paint.
5. OpenGL backend sensitivity (P2-25).
6. `_buf_swapped` / memoryview recycling fields (L131–133) — related zero-copy patterns.

### Out of scope

| Concern | Owner |
|---------|-------|
| Color correctness LUT | P2-12 |
| Rebuild cost | P2-26 |
| Resize visual blank (logic) | P2-29 — but buffer rebind **during** resize is in scope |

### Sibling map

| ID | Claim |
|----|-------|
| R08-H6 | QImage zero-copy + buffer rebind MED crash |
| R09-B02 | QImage wraps buf.data without ownership P2 |
| R09 paint | Short-lived wrap today |

### Code anchors

```
heatmap_widget.py
  L1157–1184  buf = engine.get_buffer(); QImage(buf.data, ...); drawImage
  L1084, 2011, 2042  engine._buffer = np.roll(...)  (widget scrolls)
density_engine.py
  L237–247  _buffer = np.roll / clear bands in push_snapshot path
  L252–254  column shift may be in-place slice assign (not rebind) — verify
  L396–421  resize: new_buf; self._buffer = new_buf
  L428–429  get_buffer returns reference
```

**Qt contract:** QImage constructed from external pointer requires buffer valid for QImage lifetime. `drawImage` may read asynchronously on some backends? Typically sync in software; GL upload may extend risk.

---

## 2. Threat model

### Assets

| Asset | Failure |
|-------|---------|
| Process stability | Segfault / heap corruption |
| Pixel integrity | Garbled frames, flicker |
| Security | Low (local crash) |

### Scenarios

| # | Scenario | Risk |
|---|----------|------|
| S1 | paintEvent builds QImage; nested `processEvents` → resize rebinds | UAF |
| S2 | Hold QImage beyond paint (bug/regression) | UAF |
| S3 | `np.roll` rebinds mid-paint | UAF / torn frame |
| S4 | Multi-thread read of buffer (future/plugin) | Data race |
| S5 | OpenGL texture upload deferred | Extended lifetime need |
| S6 | bytes non-owned: `buf.data` on non-C-contiguous array | Wrong stride / crash |

### Preconditions today

All known writers main-thread. Risk is **re-entrancy** and **contiguity**, not concurrent threads — unless proven otherwise.

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| ST-1 | All `QImage(` constructions in repo |
| ST-2 | All `_buffer =` assignments |
| ST-3 | Contiguity: dtype uint8, shape HxWx4, C-order |
| ST-4 | Any storage of QImage on self beyond paint |

### 3.2 Dynamic / stress

| ID | Steps | Tool |
|----|-------|------|
| U1 | During paint, force `engine.resize` via patched drawImage hook | ASan/UBSan if available; else watch crash |
| U2 | Spam resize + scroll + live push 60s | Crash rate |
| U3 | Assert `buf.flags['C_CONTIGUOUS']` before QImage | Fail if false |
| U4 | Replace wrap with `.copy()` temporarily; compare crash rate (control) | Mitigation proof |
| U5 | Check `bytesPerLine` = bw*4 matches numpy strides | Mismatch FIND |

### 3.3 Memory tooling

| ID | Tool |
|----|------|
| M1 | Python faulthandler + QT fatal |
| M2 | macOS lldb on crash if repro |
| M3 | Optional build with AddressSanitizer Python (hard) — document if skipped |

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF-1 | Buffer immutable for entire QImage lifetime OR QImage owns copy | Rebind while QImage alive |
| PF-2 | No crash in 10 min resize/scroll stress | Any segfault |
| PF-3 | Array contiguous uint8 RGBA | Stride wrong / non-contig wrap |
| PF-4 | No QImage field retained across events without copy | Stale pointer held |
| PF-5 | Documented ownership protocol in code comment | Tribal knowledge only |

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| Stress script: alternate resizeEvent, scroll_price, push_snapshot | U2 |
| Paint re-entrancy injector | U1 |
| Contiguity assert helper | U3 |
| Golden garbled-frame detector (optional hash) | Visual tear |

---

## 6. Phase-3 micro-tasks

### MT-28-1 — Ownership audit map
Table: producer of buffer, rebind sites, consumers, lifetime.

### MT-28-2 — Contiguity & stride assert
Add temporary asserts in paint; FIND if ever fails.

### MT-28-3 — Re-entrancy experiment
Force nested resize during paint; document crash/garbled.

### MT-28-4 — Stress harness 10 min
Both CPU and OpenGL backends (P2-25).

### MT-28-5 — Fix option cost
Compare `.copy()` (safe, alloc), `QImage` from `bytes(buf)`, double-buffer stable storage, `sip` voidptr keep-alive ref on widget.

---

## 7. Expected finding IDs

Format: **`FIND-P228-XX`**

| ID | Title | Sev prior |
|----|-------|-----------|
| FIND-P228-01 | QImage non-owning wrap of numpy buffer | **P1** (P0 if crash proven) |
| FIND-P228-02 | np.roll / resize rebinds during potential paint | **P1** |
| FIND-P228-03 | Non-contiguous buffer edge | **P2** |
| FIND-P228-04 | OpenGL path extended read lifetime | **P1** |
| FIND-P228-05 | Missing keep-alive reference protocol | **P2** design |

---

## 8. Fix strategy sketch

**Low-risk fix:**  
```text
qimg = QImage(buf.data, w, h, bytesPerLine, RGBA8888).copy()
```
or draw from `QImage` created from `buf.tobytes()` — costs one alloc per cache rebuild (already alloc QPixmap).

**Better:** Keep a stable `self._paint_buffer` uint8 array; engine writes into it without rebinding (resize = allocate new then switch **before** paint with generation counter).

**Keep-alive:** Store `self._qimg_keepalive = buf` while painting cache.

**Guard:** Forbid engine mutation during `_in_paint` flag.

Prefer copy-on-paint for cache build frequency already high (R09-B01 every tick dirty) — extra copy may be acceptable vs crash.

---

## 9. Dependencies

| Dep | Note |
|-----|------|
| **P2-25** | Backend matrix |
| **P2-26** | Long rebuild holds buffer |
| **P2-29** | resize rebinds |
| **P2-09** R09-B01 | Cache dirty every tick amplifies QImage create rate |

---

## 10. Severity priors

| Item | Prior | Source |
|------|-------|--------|
| Non-owning QImage | **P1–P0** | R08-H6, R09-B02 |
| Crash likelihood today | **Medium** same-thread | R09 “usually sequential” |
| Stress may still garble | **P1** | — |

**Confidence:** **Very high** that wrap is non-owning. **Medium** that production crashes without re-entrancy. Still **must hunt** — silent corruption worse than loud crash.
