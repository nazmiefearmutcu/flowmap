# P2-21 — Source switch disconnect completeness

| Field | Value |
|-------|-------|
| **Agent** | P2-21 |
| **Theme n** | 21 |
| **Slug** | `source_switch_disconnect` |
| **Zones** | **Z10** (Source switch / queue hygiene) |
| **Sibling fuel** | **R16** (concurrency, H1/H2/H4/H9), **R10** (switch_to / stop_current lifecycle), **R20** P0 cluster teardown |
| **Primary modules** | `/Users/nazmi/flowmap/flowmap/ui/source_manager.py`, `/Users/nazmi/flowmap/flowmap/data/crypcodile_live.py`, `/Users/nazmi/flowmap/flowmap/data/crypcodile_replay.py` |
| **Secondary** | `/Users/nazmi/flowmap/flowmap/ui/main_window.py` (`closeEvent`, boot `switch_to`), `/Users/nazmi/flowmap/flowmap/ui/toolbar_manager.py` |
| **Track** | B — Concurrency & data plane (tail of 13–24) |
| **Wave** | **W1** (must sign off before paint hunts) |

---

## 1. Scope & linked zones / sibling hyps

### In scope

Prove or refute that **every** path which leaves a provider (source combo, symbol change, stop toggle, window close, rapid re-switch) fully:

1. Disconnects **all** Qt signals (provider + worker intermediate relays).
2. Cooperatively stops the worker and **joins** the `QThread` (or documents a hard-fail policy).
3. Nulls refs only after join (or retains ownership until `finished`).
4. Resets book / pulse / VP / heatmap **and** does not leave dual workers alive.
5. Leaves `_running` consistent with UI Start/Stop state.

### Out of scope (owned by siblings)

| Concern | Owner |
|---------|-------|
| Queue not drained on toggle stop | **P2-22** |
| Unbounded queue / drain 1000 | P2-13, P2-14 |
| Live asyncio cancel / SSL | P2-17, P2-18 |
| Replay blocking `run_replay` vs `quit` | P2-19 |
| Dual queue vs signal emit | P2-20 |
| CCXT REST/WS specifically | P2-23, P2-24 |

### Sibling hypothesis map

| ID | Claim | Role for P2-21 |
|----|-------|----------------|
| R16-H1 | Orphaned QThread after timed-out `wait()` | Core — switch after hang |
| R16-H2 | Blocking connector not interrupted by transport.close | Core — live switch |
| R16-H9 | Signal delivery after provider destruction | Core — fast switch |
| R16 §6.6 | `stop_current` order: disconnect signals → stop → drain | Audit checklist |
| R10 switch_to | stop → reset widgets → start new provider | Completeness of reset list |
| R10 closeEvent | No join beyond provider wait | Close race |
| R20 top#3 | Thread teardown P0 | Severity prior |

### Concrete code anchors

```
source_manager.py
  L45–62   _disconnect_provider_signals  (provider-level only; blanket disconnect)
  L154–181 switch_to  → stop_current → reset OB/pulse/VP/heatmap → _start_*
  L183–203 stop_current  → disconnect signals → stop_replay → disconnect → provider=None → drain → running=False
  L406–441 on_symbol_changed  → stop_current → re-start → optional toggle
  L451–505 _toggle_replay / _toggle_live  (partial stop; NO signal disconnect helper; NO drain)

crypcodile_live.py
  L253–263 disconnect: worker.stop(); quit(); wait(2000); null refs; on_disconnected
  L247–251 thread.finished → deleteLater; worker NOT parented for deleteLater

crypcodile_replay.py
  L639–644 disconnect → stop_replay
  L723–735 stop_replay: stop(); quit(); wait(5000); null worker/thread
  L684     start_replay if already replaying: stop_replay then new worker

main_window.py
  L61      boot switch_to
  L847–849 replay mode checkbox switch_to
  L1172–1174 closeEvent: stop_current + timer stop only
```

---

## 2. Threat model

### Assets

| Asset | Failure if compromised |
|-------|------------------------|
| Single active market-data worker | Double producers → wrong book / OOM / crash |
| Qt object lifetime (provider, worker, thread) | Segfault / “wrapped C++ deleted” / startTimer warnings |
| Session isolation (symbol A vs B) | Cross-symbol book contamination |
| UI truthfulness (`_running`, Start/Stop) | User thinks stopped while producer still puts |

### Adversaries / stress actors

1. **Rapid user** — spam Live↔Replay, symbol edits, Start/Stop under load.
2. **Hung worker** — network stall so `wait(2000|5000)` times out.
3. **Partial stop** — toggle stop without full `stop_current` (different code path).
4. **Close race** — close window within 500 ms of auto-start `singleShot`.
5. **Queued signals** — worker emits `sig_*` after main nulls provider.

### Attack / failure scenarios (ordered)

| # | Scenario | Expected bad outcome |
|---|----------|----------------------|
| S1 | Live running → switch_to(REPLAY) while WS hung | Orphan live thread + new replay thread |
| S2 | Replay materializing `list(book_iter)` → switch_to(LIVE) | wait 5s hang UI; possible dual threads |
| S3 | Symbol change while running | stop_current OK path; verify thresholds + no dual connect |
| S4 | `_toggle_live` stop then immediate start | Signals still wired? Worker stop incomplete? |
| S5 | closeEvent during connect | App exit with running QThread |
| S6 | Worker `sig_error` / `sig_disconnected` after `provider=None` | Slot on deleted QObject |
| S7 | `stop_current` exception swallowed (`except Exception: pass`) | Silent half-stop; `_provider` still set or not inconsistently |

### Trust boundaries

- Main thread owns: SourceManager, OrderBook, widgets, queue drain.
- Worker threads own: asyncio loop / replay iterator; may only `queue.put` or emit signals.
- **Violation:** direct `worker.stop()` from main (documented R16-H8) — in scope to inventory, not fix alone.

---

## 3. Concrete probes

### 3.1 Static (mandatory first)

| Probe | Method | File:line focus |
|-------|--------|-----------------|
| ST-1 | Enumerate **all** call sites of `stop_current`, `switch_to`, `disconnect`, `stop_replay`, `_toggle_*` | `source_manager.py`, `main_window.py`, `toolbar_manager.py` |
| ST-2 | Diff stop completeness matrix: `stop_current` vs `_toggle_replay` stop vs `_toggle_live` stop | L183–203 vs L455–461 vs L497–501 |
| ST-3 | Confirm worker→provider signal connections are **not** disconnected by `_disconnect_provider_signals` | live L239–245; replay L700–707 |
| ST-4 | Confirm `wait` timeouts and post-timeout nulling | live L258; replay L730 |
| ST-5 | Confirm `except Exception: pass` in `stop_current` can skip drain | L185–191 vs L194–200 (drain is outside try — good; but disconnect may fail mid-way) |
| ST-6 | Iceberg/LLT tables: R10 says **not** cleared on switch — inventory UI residue | main_window LLT/iceberg docks |

### 3.2 Unit / integration (headless Qt)

| Probe | Steps | Observables |
|-------|-------|-------------|
| U1 | Mock provider with `QThread` that ignores stop for > timeout | After `stop_current`, `QThread.isRunning()` still True; `_provider is None` |
| U2 | Mock provider that emits `on_snapshot` after disconnect | No crash; OrderBook unchanged after reset |
| U3 | `switch_to(LIVE)` then immediately `switch_to(REPLAY)` × 20 | At most one alive worker thread named `crypcodile-*` |
| U4 | `on_symbol_changed` SOL→ETH while running (mock connect) | Book reset; old symbol messages rejected (if generation token absent → document leak) |

### 3.3 Dynamic (live / replay)

| Probe | Steps | Tools |
|-------|-------|-------|
| D1 | Start live SOL → wait connected → switch_to REPLAY → Start | `ps`/`sample` or Python: list `QThread` via `QCoreApplication.instance().findChildren(QThread)` |
| D2 | Start replay 20× → mid-stream switch_to LIVE | Thread count; queue growth; UI status |
| D3 | Spam Start/Stop live 50× | No “Destroyed while thread is still running”; no zombie |
| D4 | close window while connecting | Exit code; console QThread warnings |

### 3.4 GUI (cua / manual matrix)

| Probe | Action | Pass visual/UX |
|-------|--------|----------------|
| G1 | Toolbar Live↔Replay | Status text matches source; no dual “Connecting…” forever |
| G2 | Symbol edit + Enter under live | Heatmap clears then new data; no flash of old prices after 2s |
| G3 | Start → Stop → Start live | Single connection; no error storm |

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF-1 | After any stop path that claims stop, no worker `QThread` remains running **or** ownership retained until finished with no second start | Second start while first still running |
| PF-2 | After `switch_to`, OrderBook empty until new data; heatmap `reset` called | Residual levels/BBO from prior source for >1 tick after new connect |
| PF-3 | All provider-level signals disconnected before nulling provider | Slot invoked on deleted SourceManager/window |
| PF-4 | `_running` False when no active feed; toolbar Start enabled | Start greyed while dead, or running True with no thread |
| PF-5 | `stop_current` exception path still drains queue and nulls provider | Provider left non-None after failed disconnect |
| PF-6 | closeEvent does not print QThread destroy warnings (release build) | Warning or abort on exit |

**Finding severity gate:** orphan thread / dual producer → **P0**; UI state desync only → **P1**; missing table clear (iceberg) → **P2**.

---

## 5. Fixtures needed

| Fixture | Purpose |
|---------|---------|
| `FakeBlockingWorker` QObject with infinite loop + cooperative `_running` flag | Force wait timeout |
| `FakeProvider` exposing same signals as CrypcodileLive/Replay | Unit tests without network |
| `RecordingQueue` wrapping `queue.Queue` with put timestamps + producer id | Prove post-stop puts |
| Thread census helper: `alive_data_threads()` | Assert ≤1 |
| Optional: short local replay parquet window (1–5 min SOL) | Dynamic D2 |
| Env: `QT_FATAL_WARNINGS=1` (if viable) | Promote Qt lifetime warnings to fail |

---

## 6. Phase-3 micro-tasks (3–5 executable hunts)

### MT-21-1 — Stop-path completeness matrix
Walk every stop entrypoint; produce table: disconnects signals? stop_replay? disconnect? drain? running=False? join timeout?  
**Exit:** Markdown matrix in finding or appendix; open FIND for each incomplete path.

### MT-21-2 — Rapid switch stress (headless)
Automated 100× Live↔Replay with mock hung/fast workers; assert thread census.  
**Exit:** Pass/fail log; FIND if dual threads.

### MT-21-3 — Toggle-stop vs stop_current divergence
Instrument `_toggle_live` stop vs `stop_current`; document missing disconnect/drain (hand-off FIND to P2-22 if only queue).  
**Exit:** Code-diff finding with line cites.

### MT-21-4 — Post-null signal race
After `provider=None`, inject late `sig_error`/`sig_disconnected` from mock worker.  
**Exit:** Crash = P0 FIND; silent = document residual risk.

### MT-21-5 — closeEvent join policy
Close during live connect and during replay load; capture process exit diagnostics.  
**Exit:** P0/P1 FIND with repro steps for packaging/CI.

---

## 7. Expected finding IDs

Format: **`FIND-P221-XX`**

| ID | Working title | Sev prior |
|----|---------------|-----------|
| FIND-P221-01 | `wait` timeout then null → orphan QThread | P0 |
| FIND-P221-02 | `_toggle_*` stop omits `_disconnect_provider_signals` | P1 |
| FIND-P221-03 | Worker→provider signals not torn down → late emit | P1 |
| FIND-P221-04 | `stop_current` broad `except` masks disconnect failure | P1 |
| FIND-P221-05 | closeEvent incomplete join / exit crash | P0 |
| FIND-P221-06 | Iceberg/LLT not cleared on switch (session residue) | P2 |
| FIND-P221-07 | Double `stop_replay` on disconnect path (noise / state) | P3 |
| FIND-P221-08 | Boot `singleShot(500, toggle)` vs early close | P1 |

---

## 8. Fix strategy sketch (no code)

1. **Unified `teardown_provider(reason)`** used by `stop_current`, toggles, symbol change, close:
   - disconnect **worker** signals first, then provider signals;
   - cooperative stop via queued slot / threadsafe cancel;
   - `wait` with policy: on timeout, **do not** start a new provider (block switch) **or** track zombie set and refuse double-start;
   - only then `provider = None` and drain (coord with P2-22).
2. **Generation / epoch token** on SourceManager incremented each switch; workers stamp puts; consumer drops stale (coord P2-22).
3. **`closeEvent`:** stop timer first, teardown, processEvents limited, then accept; optional `QThreadPool` wait.
4. **Reset checklist** include iceberg/LLT tables and any docks.
5. Do **not** `terminate()` as first resort; document last-resort only for debug builds.

---

## 9. Dependencies

| Dep | Direction | Note |
|-----|-----------|------|
| **P2-22** | Hard peer | Switch incomplete without queue hygiene |
| **P2-17** | Upstream for live cancel quality | Completeness of disconnect depends on stop() working |
| **P2-19** | Upstream for replay quit | Same |
| **P2-20** | Peer | Dead signal path still hazards if re-enabled |
| **P2-13/14** | Peer | Backlog amplifies switch races |
| **P2-16** | Soft | on_trade None during tick vs switch |

**Blocks:** Phase-3 W3 paint confidence if dual producers can corrupt history.

---

## 10. Severity priors (phase1)

| Prior | Source | Notes |
|-------|--------|-------|
| **P0** teardown / orphan thread | R20 top#3, R16-H1 | Ship-breaker |
| **P0/P1** cross-session contamination | R10 H3 generation token | User-visible wrong book |
| **P1** toggle path incomplete | R16-H4 / R16 §6.6 | Medium in R16; elevate if dual thread proven |
| **P2** table residue | R10 iceberg note | Cosmetic/session |

**Effort prior:** M–L (lifecycle refactor touches 3 providers + SourceManager).  
**Confidence prior (bug real):** **High** for timeout orphan; **High** for toggle/stop_current divergence; **Medium** for late-signal crash (environment-dependent).
