# Track B (tail) + Track C (head) Summary — Themes 21–30

| Field | Value |
|-------|-------|
| **Coordinator** | Phase-2 planning (P2-21 … P2-30) |
| **Date** | 2026-07-13 |
| **Coverage** | Track **B** remainder (21–24) + Track **C** start (25–30) |
| **Sources** | `themes.json`, R20, R16, R10, R08, R09, R06; source under `/Users/nazmi/flowmap/flowmap/` |
| **Plans dir** | `/Users/nazmi/flowmap/bug_hunt/phase2_plan/agent_plans/` |

---

## 1. Roster at a glance

| n | Plan file | Theme | Zones | Sev prior | Wave |
|---|-----------|-------|-------|-----------|------|
| 21 | `P2-21_source_switch_disconnect.md` | Source switch disconnect completeness | Z10 | **P0** | W1 |
| 22 | `P2-22_stale_queue_after_stop.md` | Stale queue after stop/switch | Z10, Z05 | **P0/P1** | W1 |
| 23 | `P2-23_rest_polling_gui_thread.md` | REST polling on GUI thread | Z17 | **P0** if used / **P1** latent | W1 |
| 24 | `P2-24_ccxt_book_identity_stall.md` | CCXT `is not last_ob` stall | Z17 | **P0** | W1 |
| 25 | `P2-25_opengl_vs_cpu_paint.md` | OpenGL base vs CPU paint | Z01 | **P1** (P0 packaged GL) | W3† |
| 26 | `P2-26_rebuild_heatmap_freeze.md` | `rebuild_heatmap` freeze budget | Z01, Z02 | **P0/P1** | W3† |
| 27 | `P2-27_throttled_deferred_rebuild.md` | Throttled deferred rebuild races | Z01 | **P1** | W3 |
| 28 | `P2-28_qimage_buffer_rebind.md` | QImage zero-copy buffer rebind | Z01 | **P1** (P0 if crash) | W3 |
| 29 | `P2-29_resize_blank_history.md` | Resize blank history H15 | Z01, Z02 | **P0 visual** | W3 |
| 30 | `P2-30_trade_percentile_hitch.md` | Trade deque percentile hitch | Z04 | **P2** (P1 if ms) | W3 |

† Static audit / benchmarks may start earlier; do not prioritize paint fixes before W1 data-plane signoff (R20 rule).

---

## 2. Architectural context (shared)

```
                    ┌─────────────────────────────────────┐
  Live / Replay /   │  QThread workers                     │
  (CCXT optional)   │  queue.Queue  OR  (REST: main QTimer) │
                    └──────────────┬──────────────────────┘
                                   │
                    SourceManager  │  switch_to / stop_current / _toggle_*
                    _queue (1×)    │  disconnect completeness ← P2-21
                    drain?         │  stale hygiene          ← P2-22
                                   ▼
                    MainWindow._gui_tick (≤1000, only if running)
                                   │
                    OrderBook ──► HeatmapWidget
                                   │
              push_snapshot / add_trades / rebuild_heatmap / paintEvent
                                   │
              P2-25 backend · P2-26 rebuild · P2-27 throttle
              P2-28 QImage  · P2-29 resize · P2-30 percentiles
```

**Active product path (R01/R20):** Crypcodile Live | Replay → queue → GUI.  
**CCXT (`crypto.py`):** still in tree; SourceManager `DataSource` enum is Live/Replay only — treat Z17 as **latent P0** unless re-enabled/tests/DataManager hit it.

---

## 3. Cross-theme dependency graph

```
        P2-17 / P2-19 (teardown quality)
                 │
                 ▼
   P2-21 switch disconnect ◄────► P2-22 stale queue
                 │                      │
                 └──────────┬───────────┘
                            ▼
                     Z05 gui_tick (P2-13..16)
                            │
                            ▼
              ┌─────────────┴─────────────┐
              ▼                           ▼
         Density/Book                  Heatmap view
              │                           │
              │              P2-29 resize ──► often forces P2-26 rebuild
              │              P2-27 throttle ──► schedules P2-26
              │              P2-28 QImage   ──► safety around buffer
              │              P2-25 GL/CPU   ──► test matrix for all Z01
              │              P2-30 trades   ──► ingest cost in same tick
              │
   P2-23 REST GUI block          P2-24 identity stall
   (Z17, orthogonal modes of crypto.py)
```

| Edge | Why |
|------|-----|
| **21 ↔ 22** | Hard peer: solid stop without drain still contaminates; drain without join still races late puts |
| **21 → 17/19** | Disconnect completeness depends on cooperative worker stop |
| **22 → 13/14** | Undrained + unbounded + cap interactions |
| **23 ∥ 24** | Same file, different transport modes |
| **29 → 26** | Correct resize fix ≈ full rebuild cost |
| **27 → 26** | Throttle only starts rebuilds; duration is 26 |
| **28 → 25/29** | Rebind on resize; GL upload lifetime |
| **30 → 14/26** | Stacked on gui_tick / freeze budget |

---

## 4. Theme digests (executive)

### Track B tail — concurrency / data plane

#### P2-21 Source switch disconnect completeness
- **Smell:** `stop_current` vs `_toggle_*` vs `closeEvent` incomplete/asymmetric teardown; `wait(2000|5000)` then null refs → orphan QThread; worker→provider signals not in `_disconnect_provider_signals`.
- **Anchors:** `source_manager.py` L154–203, L451–505; live `disconnect` L253–263; replay `stop_replay` L723–735; `main_window.closeEvent` L1172–1174.
- **Key probes:** stop-path matrix; rapid switch thread census; late signal after `provider=None`.
- **Fix sketch:** unified `teardown_provider`; epoch; refuse start if zombie; cancel pending UI timers.

#### P2-22 Stale queue after stop/switch
- **Smell:** **Only** `stop_current` drains; toggle stop sets `running=False` without drain; `_gui_tick` returns early without discard-drain; **one** `Queue` for process lifetime, no session epoch.
- **Anchors:** drain L194–200; `_gui_tick` L895–897; toggles L455–501.
- **Key probes:** fill queue → toggle stop → start → ghost mid; post-drain late put.
- **Fix sketch:** drain helper on all stops; discard-drain when not running; epoch or replace queue.

#### P2-23 REST polling on GUI thread
- **Smell:** `CryptoProvider._poll_tick` sync `fetch_order_book`/`fetch_trades` on `QTimer` (main affinity). Queue does not help — I/O before put.
- **Anchors:** `crypto.py` L471–534, connect fallback L387–400.
- **Key probes:** FakeCcxt sleep/hang; reachability matrix (UI dead path?).
- **Fix sketch:** REST worker thread; explicit timeouts; visible REST badge.

#### P2-24 CCXT book identity stall
- **Smell:** `if ob is not last_ob` / ticker twin; ccxt.pro mutates singleton → **no snapshots after first**.
- **Anchors:** `crypto.py` `_sender_loop` L204–246; `_watch_orderbook` L276–285.
- **Key probes:** unit same-dict mutate; live `id(ob)` trace; snapshot rate.
- **Fix sketch:** dirty flag / always emit / nonce — **not** identity.
- **R20:** top#10 / P0-12.

### Track C head — rendering & performance

#### P2-25 OpenGL base vs CPU paint
- **Smell:** `QOpenGLWidget` vs `QWidget` base only; shared `paintEvent`+QPainter; CI forces CPU; prod often GL; packaged context risk.
- **Anchors:** `heatmap_widget.py` L31–52, `render`, paintEvent.
- **Key probes:** dual-backend pixel smoke; grab parity; packaging cold start.
- **Fix sketch:** docs; CI matrix; fallback to CPU; unified capture API.

#### P2-26 rebuild_heatmap freeze budget
- **Smell:** Full O(columns×rows) rebuild on **main** thread; throttle caps **start rate** not duration; SciPy optional path.
- **Anchors:** L587–876; callers via size change / zoom / reset / go live.
- **Key probes:** benchmark matrix N×vr×smooth; phase split; queue growth during rebuild.
- **Fix sketch:** dirty columns; prealloc; import once; time-slice / double-buffer long-term.

#### P2-27 Throttled deferred rebuild races
- **Smell:** `QTimer.singleShot(50)` fire-and-forget + `_rebuild_pending`; cannot restart; reset/close may leave dangling callback; trailing updates lost edge cases.
- **Anchors:** L903–919; drag/zoom callers; mouseRelease L2126.
- **Key probes:** coalesce unit test; destroy-while-pending; reset-while-pending.
- **Fix sketch:** member `QTimer` trailing debounce; stop on reset/close.

#### P2-28 QImage zero-copy buffer rebind
- **Smell:** `QImage(buf.data, …)` non-owning; `_buffer = np.roll(...)` / `resize` rebind; re-entrancy UAF risk.
- **Anchors:** paint L1166–1172; engine resize L396–421; widget rolls L1084+.
- **Key probes:** contiguity assert; nested resize during paint; 10 min stress ± GL.
- **Fix sketch:** `.copy()` on paint; stable paint buffer; `_in_paint` guard.

#### P2-29 Resize blank history (H15) — **must not drop**
- **Smell:** `resizeEvent` updates `_last_vis_rows/_last_hm_w` + one-column `push_snapshot` → later pushes **skip** `rebuild_heatmap` → **blank history**.
- **Anchors:** L2333–2349; push L388–390; engine `_needs_rebuild` possibly dead.
- **Key probes:** synthetic colored history → resize → %BG; recovery via Go Live control.
- **Fix sketch:** throttled full rebuild on resize; honor `_needs_rebuild`; regression test.
- **R20:** top#9.

#### P2-30 Trade deque percentile hitch
- **Smell:** each `add_trades` → full-deque `np.median` + `np.percentile` (≤10k).
- **Anchors:** L574–585, L571; gui_tick batch L949–950.
- **Key probes:** bench n=10k; hitches under 20× replay.
- **Fix sketch:** throttle recompute; ring buffer; sample window.

---

## 5. Priority order for Phase-3 execution (within 21–30)

| Order | Theme | Rationale |
|------:|-------|-----------|
| 1 | **22** | Code-evident stale apply; pure logic tests; unblocks trust of book after stop |
| 2 | **21** | Pair with 22 for session isolation; teardown P0 |
| 3 | **24** | Critical if CCXT touched; unit repro in minutes |
| 4 | **23** | Same module; prove reachability then freeze |
| 5 | **29** | Visual P0; U1 repro clear; R20 never-drop list |
| 6 | **26** | Measure before optimize; informs 29 fix cost |
| 7 | **27** | Stabilizes rebuild scheduling used by 26/29 |
| 8 | **28** | Stability under resize/rebuild stress |
| 9 | **25** | Matrix wraps Z01 tests |
| 10 | **30** | Perf polish unless bench shows P1 |

**Never drop (R20 consolidating rule overlap):** 24, 29 — plus 21/22 as Z10 W1 critical path.

---

## 6. Shared fixtures & harness needs

| Fixture | Used by |
|---------|---------|
| Thread census (`QThread` children / names) | 21 |
| `RecordingQueue` + synthetic snapshot mids | 22, 21 |
| Fake / hung worker providers | 21, 17/19 |
| FakeCcxt exchange latency/hang | 23 |
| Mutable singleton OB dict sequence | 24 |
| `FLOWMAP_RENDERER=cpu|opengl` matrix | 25, 28 |
| Synthetic heatmap history (per-column color) | 29, 26 |
| Rebuild spy / perf CSV | 26, 27, 30 |
| Stress: resize + scroll + push loop | 28, 29 |
| Busy replay window (SOL) | 26, 30, 22 |

**Recommended shared helper module (Phase-3, not created here):**  
`bug_hunt/phase3_execution/harness/qt_source_heatmap.py` — offscreen `MainWindow` or widget+SourceManager stubs.

---

## 7. Finding ID namespaces

| Theme | Prefix | Example |
|------:|--------|---------|
| 21 | `FIND-P221-XX` | FIND-P221-01 orphan QThread |
| 22 | `FIND-P222-XX` | FIND-P222-01 toggle undrained |
| 23 | `FIND-P223-XX` | FIND-P223-01 REST on GUI |
| 24 | `FIND-P224-XX` | FIND-P224-01 identity stall |
| 25 | `FIND-P225-XX` | FIND-P225-02 test/prod gap |
| 26 | `FIND-P226-XX` | FIND-P226-01 freeze SLA |
| 27 | `FIND-P227-XX` | FIND-P227-01 singleShot race |
| 28 | `FIND-P228-XX` | FIND-P228-01 non-owning QImage |
| 29 | `FIND-P229-XX` | FIND-P229-01 blank history H15 |
| 30 | `FIND-P230-XX` | FIND-P230-01 full-deque percentile |

Schema fields (R20): ID, P0–P3, file:line, repro, expected/actual, fix hint, sibling cite.

---

## 8. Severity priors rollup

| Band | Themes | Drivers |
|------|--------|---------|
| **P0** | 21 (orphan/dual worker), 22 (cross-session book), 24 (frozen book if used), 29 (blank history), 23 if REST live | R20 top list, R06-H1, R08-H15, R16-H1/H4 |
| **P1** | 21 partial paths, 22 toggle stale, 23 latent, 25–28 most items, 26 freeze yellow/orange | UX / stability |
| **P2** | 30 default, 27 blank-during-drag, 25 docs | Perf polish |
| **P3** | Double stop_replay noise, maxlen mem | Hygiene |

---

## 9. Coordination notes for Phase-3 agents

1. **21 and 22 should pair-review** findings — one PR-level fix often covers both (teardown + drain + epoch).
2. **23 and 24** share `crypto.py`; avoid conflicting sender_loop refactors without coordination.
3. **29 fix without 26 measurement** risks “correct but unusable” zoom/resize — measure first or debounce.
4. **25** owns the backend matrix used by 26–29 evidence packs — run dual backend when claiming paint FINDs.
5. Do **not** start large paint refactors until W1 (incl. 21–22) says session isolation holds.
6. Upstream Track B heads **13–20** (queue bound, drain cap, live/replay quit, dual emit) remain prerequisites for interpreting 21–22 severity under load.

---

## 10. Deliverable checklist

| Deliverable | Status |
|-------------|--------|
| `P2-21_source_switch_disconnect.md` | Written |
| `P2-22_stale_queue_after_stop.md` | Written |
| `P2-23_rest_polling_gui_thread.md` | Written |
| `P2-24_ccxt_book_identity_stall.md` | Written |
| `P2-25_opengl_vs_cpu_paint.md` | Written |
| `P2-26_rebuild_heatmap_freeze.md` | Written |
| `P2-27_throttled_deferred_rebuild.md` | Written |
| `P2-28_qimage_buffer_rebind.md` | Written |
| `P2-29_resize_blank_history.md` | Written |
| `P2-30_trade_percentile_hitch.md` | Written |
| `TRACK_B_C_SUMMARY.md` (this file) | Written |

Each plan includes: Scope, Threat model, Concrete probes (file:line), Pass/fail, Fixtures, Phase-3 micro-tasks (3–5), Finding IDs, Fix sketch, Dependencies, Severity priors.

---

## 11. Sibling research citation index (21–30)

| Report | Primary consumption |
|--------|---------------------|
| **R20** | Zone map Z01/Z02/Z04/Z05/Z10/Z17; themes 21–30; P0-12; top#9–10; wave plan |
| **R16** | H1/H2/H4/H5/H9; §5.1 gui_tick gate; §6.x teardown; stop_current |
| **R10** | switch_to, stop_current, toggle, closeEvent, H2/H3 generation token |
| **R08** | H1 rebuild freeze; H6 QImage; H15 resize; H16 GL; H19 percentiles; throttle |
| **R09** | B01 cache dirty; B02 QImage ownership; rebuild cost table |
| **R06** | H1 identity; H3 REST GUI; crypto lifecycle |

---

*End of TRACK_B_C_SUMMARY for themes 21–30.*
