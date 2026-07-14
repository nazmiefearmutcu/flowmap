# P2-20 — Dual emit path (queue vs signals)

| Field | Value |
|-------|-------|
| **Agent ID** | P2-20 |
| **Theme** | Dual emit path queue vs signals |
| **Zones** | Z06, Z07 |
| **Siblings** | R16 §4.2, R10 H1, R06, R05 |
| **Finding prefix** | `FIND-P220-XX` |
| **Severity prior** | **P1** (dead code confusion); **P0** if both paths ever fire (double book apply) |
| **Primary files** | `data/crypcodile_live.py`, `data/crypcodile_replay.py`, `data/crypto.py`, `ui/source_manager.py`, `ui/main_window.py` |

---

## 1. Scope & linked zones / sibling hyps

### Design (mutual exclusion in workers)

```text
if self._queue is not None:
    queue.put((type, obj))
else:
    sig_*.emit(obj)
```

Live: `crypcodile_live.py:179-196`  
Replay: `crypcodile_replay.py:513-530`  
Crypto: similar in sender_loop  

### Production wiring

`SourceManager` **always** passes `queue=self._queue`:

- `_start_replay` `:256`  
- `_start_live` `:301`  

**And** still connects:

```python
provider.on_snapshot.connect(self._on_provider_snapshot)
provider.on_update.connect(...)
provider.on_trade.connect(...)
provider.on_bbo.connect(...)
```

Worker → provider signal re-emit still wired:

```python
self._worker.sig_snapshot.connect(self.on_snapshot.emit)
# etc.
```

But worker **never emits** market data when queue set → provider data signals **dead**.

Lifecycle signals still live: connected/disconnected/error/progress/finished.

### Out of scope

- Drain batching → P2-14/15  
- Teardown → P2-17/19  

---

## 2. Threat model

| Scenario | Risk |
|----------|------|
| Status quo queue mode | Dead handlers — maintenance hazard only |
| Engineer removes queue branch “cleanup” | Signals fire → SourceManager applies **and** `_gui_tick` applies → **double book** |
| Engineer removes signal connects | OK for data; may break tests using signals without queue |
| Tests construct provider queue=None | Signal path only — diverges from prod |
| Partial queue: queue set but put fails? | N/A |
| on_bbo signal dead; BBO only via queue | OK if queue carries bbo; live may not subscribe book_ticker (R06) |
| Progress/error still via signals | Required |

**Double-apply impact:** inflated trade counts, wrong density, CVD double, ghost absorption.

---

## 3. Concrete probes

### 3.1 Static matrix

For each provider (live, replay, crypto):

| Message | Queue put? | Worker sig emit if queue? | Provider on_* connected? | Consumer |
|---------|------------|---------------------------|--------------------------|----------|
| snapshot | Y | N | Y (dead) | _gui_tick |
| update | Y | N | Y (dead) | _gui_tick |
| trade | Y | N | Y (dead) | _gui_tick |
| bbo | Y | N | Y (dead; handler pass/apply) | _gui_tick |
| connected | N/A | Y | Y (live) | SourceManager |
| error | N/A | Y | Y | status |
| progress | N/A | Y | Y | status |

### 3.2 Unit probes

**U1 — Queue mode no signal fire**

```text
QSignalSpy on provider.on_snapshot
Worker with queue processes one snapshot
Assert spy.count()==0 and queue has 1 item
```

**U2 — Signal mode no queue**

```text
Worker queue=None; spy on_snapshot
Assert spy.count()==1
```

**U3 — Double-apply regression guard**

```text
Simulated future bug: force both put and emit
OrderBook should show double size if both applied — document
Add test: fail if both paths used in same provider instance
```

**U4 — SourceManager handlers**

```text
Call _on_provider_snapshot while also queue path in gui_tick
Document double apply
```

**U5 — Dead code detect**

```text
Coverage or log: _on_provider_snapshot never called in 60s live session
```

### 3.3 Dynamic

- Live 30s: instrument counters on signal handlers vs gui_tick apply.  
- Expect: signal data handlers 0; gui_tick >0.

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF1 | Exactly one market-data path active per process config | Dual fire |
| PF2 | Architecture docs match code | Confusion in R10/R16 style |
| PF3 | Tests cover **production** queue path | Only signal path tested |
| PF4 | Lifecycle signals remain | Broken connect UI |
| PF5 | Removing dead connects doesn’t break prod | Accidental break |

---

## 5. Fixtures

- Minimal QCoreApplication for QSignalSpy  
- Dummy Level2Snapshot  
- Provider with mock worker dispatch  

---

## 6. Phase-3 micro-tasks

1. **P3-20a** — Complete static matrix + U1/U2.  
2. **P3-20b** — Decision:  
   - **(A)** Remove data signal connects from SourceManager when queue mode; keep worker→provider wiring only for lifecycle, **or**  
   - **(B)** Remove queue; use signals only (Qt queued), **or**  
   - **(C)** Keep dual but assert XOR in worker debug builds.  
3. **P3-20c** — Add runtime assert: if queue is not None, worker must not emit data signals (debug).  
4. **P3-20d** — Update tests to use queue path as primary.  
5. **P3-20e** — Clean dead `_on_provider_*` book applies or repurpose for non-queue tools.

---

## 7. Finding ID format

`FIND-P220-XX`

| Seed | Title | Sev |
|------|-------|-----|
| FIND-P220-01 | Dead SourceManager data signal handlers in queue mode | P2 |
| FIND-P220-02 | Dual path double-apply hazard if branch removed | P0 latent |
| FIND-P220-03 | Worker still connects sig_snapshot unused | P3 |
| FIND-P220-04 | Tests may not match production path | P1 |
| FIND-P220-05 | on_bbo no-op handler leftover | P3 |

---

## 8. Fix strategy sketch

**Recommended (A):**

1. SourceManager: only connect lifecycle/error/progress when `queue is not None`.  
2. Keep worker mutual exclusion.  
3. Delete or `# queue-mode: unused` on `_on_provider_snapshot` book apply — or use them **only** when queue is None (DataManager legacy).  
4. Single module docstring: “Production: queue + _gui_tick; signals for control plane.”

**Alternative (B):** Qt signals only — remove queue — needs proof of throughput vs queue.

---

## 9. Dependencies

| Theme | Rel |
|-------|-----|
| **P2-14/15/16** | Queue consumer behavior |
| **P2-17/19** | Teardown of signal emitters |
| **P2-21** | Switch rewiring signals |
| **P2-23/24** | Crypto path same dual pattern |

---

## 10. Severity priors

| Source | Sev |
|--------|-----|
| R10 H1 | M (confusion) / latent double |
| R16 §4.2 | Dead dual wiring |
| Latent double-apply | **P0** if triggered |

---

## 11. Code anchors

```179:196:/Users/nazmi/flowmap/flowmap/data/crypcodile_live.py
            if self._queue is not None:
                ... put ...
            else:
                ... emit ...
```

```256:261:/Users/nazmi/flowmap/flowmap/ui/source_manager.py
            provider = CrypcodileReplayProvider(..., queue=self._queue, ...)
            provider.on_snapshot.connect(self._on_provider_snapshot)
            provider.on_update.connect(self._on_provider_update)
            provider.on_trade.connect(self._on_provider_trade)
```

```328:329:/Users/nazmi/flowmap/flowmap/ui/source_manager.py
    def _on_provider_snapshot(self, snap) -> None:
        self._window._order_book.apply_snapshot(snap)
```

```239:242:/Users/nazmi/flowmap/flowmap/data/crypcodile_live.py
        self._worker.sig_snapshot.connect(self.on_snapshot.emit)
        # wired but inactive for data when queue set
```
