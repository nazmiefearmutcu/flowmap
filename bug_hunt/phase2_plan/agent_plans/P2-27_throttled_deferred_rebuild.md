# P2-27 — Throttled deferred rebuild races

| Field | Value |
|-------|-------|
| **Agent** | P2-27 |
| **Theme n** | 27 |
| **Slug** | `throttled_deferred_rebuild` |
| **Zones** | **Z01** |
| **Sibling fuel** | **R08** throttle notes, H1 interaction, H8 blank strips; drag/zoom paths |
| **Primary module** | `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py` L159–160, L903–919, drag/zoom callers |
| **Secondary** | mouseMove/wheel paths calling `request_rebuild_throttled` |
| **Track** | C — Rendering & performance |
| **Wave** | **W3** |

---

## 1. Scope & linked zones / sibling hyps

### In scope

1. `request_rebuild_throttled` algorithm:
   - if `now - _last_rebuild_time > 0.05` → immediate `rebuild_heatmap`, clear pending;
   - else schedule **one** `QTimer.singleShot(50, _deferred_rebuild)` if not already pending.
2. Races:
   - Stale deferred rebuild after newer full rebuild / reset / destroy.
   - Pending flag cleared incorrectly → lost rebuild or double rebuild.
   - Immediate path sets `_last_rebuild_time` then long rebuild; deferred still fires.
   - Widget deleted before singleShot → RuntimeError / C++ deleted.
   - Drag uses interim `np.roll` + throttled rebuild; release also rebuilds — ordering.
3. Interaction with live `push_snapshot` updating history during deferred wait.
4. Whether 50 ms singleShot is from **schedule time** not from last rebuild end (trailing edge incomplete).

### Out of scope

| Concern | Owner |
|---------|-------|
| Rebuild duration budget | **P2-26** |
| Resize path (direct engine.resize, not throttle) | **P2-29** |
| view_changed omit on rebuild success | R08-H14 (note FIND optional) |

### Code anchors

```
heatmap_widget.py
  L159–160  _last_rebuild_time, _rebuild_pending
  L903–913  request_rebuild_throttled
  L915–919  _deferred_rebuild
  L951–969  zoom_to_height → throttled
  L1075–1101 scroll_price → roll + throttled
  Mouse drag move paths ~2011, 2042 np.roll + throttle
  L2126     mouseRelease checks _rebuild_pending
```

**Algorithm gap analysis (planning):**
- singleShot(50) always waits 50 ms from **request moment**, not “50 ms after last rebuild finished”.
- If rebuild takes 200 ms, multiple logical views may collapse to one deferred run — OK if final state rebuilt; **fail** if deferred runs with intermediate geometry then a later change sets pending False incorrectly.
- Immediate branch sets `_rebuild_pending = False` even if a singleShot is already queued → **deferred still runs** (singleShot not cancelable easily) → may rebuild twice or rebuild with flag false early in `_deferred_rebuild` (`if self._rebuild_pending` guard) — **queued callback becomes no-op** if immediate cleared pending → **lost trailing update** if no further request.

Critical race to prove:

```
t0: request (pending, singleShot scheduled)
t1: request immediate path (>50ms since last): rebuild now; pending=False
t2: singleShot fires: _deferred_rebuild sees pending False → NOOP
t3: if t1 rebuild used old scroll/zoom and t0 was for newer state without new request after t1 → STALE
```

Actually at t1 immediate rebuild uses **current** state — OK. Worse case:

```
t0: request schedules deferred for state A→B transition mid-drag
t1: before fire, another request within 50ms: pending already True, no second schedule
t2: deferred fires once — OK coalesce
```

```
t0: deferred scheduled
t1: reset() → rebuild immediate; pending not cleared? reset calls rebuild_heatmap directly NOT request_*; pending may still True
t2: deferred fires another full rebuild after reset — wasteful; or races with new data
```

---

## 2. Threat model

### Assets

| Asset | Failure |
|-------|---------|
| Final view matches last user input | Stale zoom/scroll after drag |
| No crash after close during drag | singleShot on dead widget |
| Avoid rebuild storms | Double rebuild / thrash |

### Scenarios

| # | Scenario | Risk |
|---|----------|------|
| S1 | Fast wheel zoom | Coalesce OK vs lost trailing |
| S2 | Drag pan + release rebuild | Double rebuild; interim blank (H8) |
| S3 | Deferred after `reset`/switch | Rebuild empty then late ghost |
| S4 | Close window mid-drag | RuntimeError |
| S5 | Immediate rebuild long; pending false; user change only via pending path | Edge loss |
| S6 | `_deferred_rebuild` re-entrancy if rebuild triggers events | Nested rebuild |

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| ST-1 | All callers of `request_rebuild_throttled` vs direct `rebuild_heatmap` |
| ST-2 | Any `singleShot` cancel / object-bound timer? |
| ST-3 | mouseRelease path vs pending (L2126) |

### 3.2 Unit / fake clock

| ID | Steps | Assert |
|----|-------|--------|
| U1 | Patch `time.time` + QTest `qWait`; sequence requests at 0, 10, 20 ms | Exactly one deferred rebuild; final state = last geometry |
| U2 | Request at 0; at 60 ms immediate; ensure no lost state | Final matches last request intent |
| U3 | `reset` while pending True | Deferred no-op or safe; no crash |
| U4 | `deleteLater` widget while pending | No crash (use QSignalSpy / stderr) |
| U5 | Count `rebuild_heatmap` calls under 100 requests in 40 ms | Expect ~1–2 not 100 |

### 3.3 Dynamic GUI

| ID | Action |
|----|--------|
| D1 | Aggressive trackpad zoom 2s | Final row_height matches UI; no permanent blank strips |
| D2 | Horizontal drag scrub history | On release, full consistent frame |
| D3 | Switch symbol during deferred | No old symbol pixels |

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF-1 | After input burst, ≤1 rebuild within 50 ms window OR documented N | Unbounded rebuild calls |
| PF-2 | Final pixels/geometry match last input | Stuck intermediate zoom |
| PF-3 | Pending+reset/switch safe | Crash or wrong session paint |
| PF-4 | Destroy with pending singleShot safe | RuntimeError / segfault |
| PF-5 | mouseRelease and throttle don't fight (double OK if identical outcome) | Divergent buffers |

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| HeatmapWidget harness with spy on `rebuild_heatmap` | Call counts |
| Deterministic clock or QTest waits | U1 |
| Scripted QMouseEvent/QWheelEvent sequence | D1 |
| Pending-true then `reset` sequence | U3 |

---

## 6. Phase-3 micro-tasks

### MT-27-1 — Formalize throttle state machine
Draw states: Idle / Pending / Rebuilding; transitions; open gaps as FIND.

### MT-27-2 — Coalesce unit test U1/U5
Red/green documentation.

### MT-27-3 — reset/switch/close vs pending
U3/U4; FIND if unsafe.

### MT-27-4 — Drag path integration
Trace mouseMove throttle + release rebuild; blank strip duration measure (H8).

### MT-27-5 — Fix design
Prefer `QTimer` single-shot member with `start(50)` restart (true trailing debounce) over fire-and-forget `singleShot`; clear pending on reset; cancel on close.

---

## 7. Expected finding IDs

Format: **`FIND-P227-XX`**

| ID | Title | Sev prior |
|----|-------|-----------|
| FIND-P227-01 | singleShot not canceled → lost trailing / double semantics | **P1** |
| FIND-P227-02 | reset/switch leaves _rebuild_pending true | **P1** |
| FIND-P227-03 | Destroyed widget deferred callback | **P0/P1** |
| FIND-P227-04 | Immediate vs deferred race loses update | **P1** |
| FIND-P227-05 | Drag interim blank until deferred (H8) | **P2** |
| FIND-P227-06 | No true trailing debounce (fixed 50 from first schedule) | **P2** design |

---

## 8. Fix strategy sketch

1. Replace dual flags + `QTimer.singleShot` with **one** `QTimer(self)`:
   - `setSingleShot(True)`; each request `timer.start(50)` (restarts = trailing debounce).
   - timeout → `rebuild_heatmap`.
2. On `reset` / `closeEvent` / source switch: `timer.stop(); pending=False`.
3. Optional: if last rebuild ended >50 ms ago, immediate path kept.
4. During rebuild, set `_rebuilding` guard to ignore nested requests except schedule trailing.
5. mouseRelease: stop timer and rebuild once (deterministic).

---

## 9. Dependencies

| Dep | Note |
|-----|------|
| **P2-26** | Duration makes races more visible |
| **P2-29** | Resize bypasses throttle — consistency |
| **P2-21** | Switch must cancel pending rebuild |
| **P2-28** | Rebuild mid-paint |

---

## 10. Severity priors

| Item | Prior | Source |
|------|-------|--------|
| Lost trailing zoom | **P1** | UX |
| Callback after delete | **P0/P1** | R16-like lifetime |
| Blank during drag | **P2** | R08-H8 expected? |

**Confidence:** **High** that singleShot cannot be restarted (API). **Medium** on user-visible loss rate. **High** value of member QTimer fix.
