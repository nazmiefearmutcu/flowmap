# P2-17 — Live asyncio + quit/wait teardown

| Field | Value |
|-------|-------|
| **Agent ID** | P2-17 |
| **Theme** | Live asyncio quit wait teardown |
| **Zones** | Z06 |
| **Siblings** | R16 H1/H2/H8/H9, R06 §2.1/2.3/2.4, R20 P0-05/P0-14 |
| **Finding prefix** | `FIND-P217-XX` |
| **Severity prior** | **P0** (zombie QThread, socket leak, exit crash) |
| **Primary files** | `data/crypcodile_live.py`, `ui/source_manager.py`, `ui/main_window.py` (closeEvent) |

---

## 1. Scope & linked zones / sibling hyps

### Lifecycle (actual)

```text
connect():
  worker = _LiveWorker(...); moveToThread(thread)
  thread.started → worker.start
  start():
    SSL patch
    loop = new_event_loop()
    run_until_complete(_run())   # BLOCKS thread Qt event loop
    _run: make_connector; sig_connected; await connector.run()
disconnect():
  worker.stop()  # DIRECT cross-thread call
  thread.quit()
  thread.wait(2000)   # SHORTEST timeout among providers
  worker = None; thread = None
stop():
  _running = False
  run_coroutine_threadsafe(transport.close()) if connector.transport
```

Key lines: `crypcodile_live.py:91-133`, `:222-263`.

### Why quit() is weak (R16)

`QThread.quit()` only exits the **Qt event loop**. While `run_until_complete` holds the thread, quit does nothing until `_run` returns. Stop relies entirely on `transport.close()` unblocking `connector.run()`.

### Out of scope

- SSL monkeypatch security → **P2-18**  
- Replay teardown → **P2-19**  
- Queue after zombie → P2-13/22  

---

## 2. Threat model

| Scenario | Result |
|----------|--------|
| Network hang; close() doesn’t finish in 2s | wait timeout → refs nulled → **orphan thread + open WS** |
| Second connect while orphan alive | Two WS, two putters on same queue |
| closeEvent app exit | “QThread: Destroyed while thread is still running” / segfault |
| stop() when transport is None | Only flag; run may still block |
| stop() when loop not running yet | Flag only; race with start |
| sig_disconnected after provider None | Queued slot on deleted receiver (H9) |
| Connected before handshake | UI shows connected; fail → flicker (R06) |
| No reconnect | After error, feed dead until user restart (P0-14) |

---

## 3. Concrete probes

### 3.1 Static checklist

| # | Item | Line |
|---|------|------|
| S1 | wait(2000) | `:257-258` |
| S2 | No isRunning check after wait | `:259-260` |
| S3 | No loop.stop / task cancel | `stop` `:126-133` |
| S4 | Direct stop() not QueuedConnection | disconnect `:254-255` |
| S5 | thread.finished → deleteLater only on thread | `:250` |
| S6 | Worker not parented; may leak | create `:232` |
| S7 | closeEvent only stop_current | main_window R10 |
| S8 | No reconnect loop | `_run` except → emit error + disconnected |

### 3.2 Dynamic probes (must run carefully)

**D1 — Happy path stop**

```text
Start live → wait connected → Stop
Assert: thread not running within 2s; qsize stable; no zombie in sample of QThread
```

**D2 — Slow close simulation**

```text
Monkeypatch transport.close to asyncio.sleep(10)
Stop → measure wait return; check isRunning True after disconnect returns
Assert FIND zombie
```

**D3 — Double connect**

```text
Force timeout disconnect; connect again without process exit
Wireshark or log: two connectors? queue dual puts?
```

**D4 — App quit**

```text
Start live; immediately Cmd+Q
Capture stderr for QThread destroyed warnings
```

**D5 — Cross-thread stop**

```text
Qt log: warnings when invoking stop from main
Optional: change to QMetaObject.invokeMethod and compare reliability
```

**D6 — Failure path**

```text
Invalid symbol / offline network
Assert sig_error + disconnected; thread finished; no spin
```

### 3.3 Unit-ish

- Mock `_run` with long sleep; call stop+wait; assert timing.

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF1 | After disconnect, thread not running OR still tracked + retried | Silent orphan |
| PF2 | wait timeout → error surfaced to UI, provider not fully dropped until joined | provider=None while running |
| PF3 | closeEvent joins all workers | Exit crash/warning |
| PF4 | stop cancels connector tasks deterministically | Hang until timeout always |
| PF5 | Single connect at a time enforced | Dual WS |
| PF6 | Optional: auto-reconnect with backoff (product) | Dead feed after blip (document if wontfix) |

---

## 5. Fixtures

| Fixture | Use |
|---------|-----|
| Fake connector/transport with controllable close latency | D2 |
| Offline / bad exchange name | D6 |
| Thread tracker helper | count QThreads at start/end |

---

## 6. Phase-3 micro-tasks

1. **P3-17a** — Repro D2 with monkeypatch; FIND-P217-01.  
2. **P3-17b** — Implement robust stop: cancel `connector.run` task + `loop.call_soon_threadsafe(loop.stop)` + longer wait + log if still running.  
3. **P3-17c** — Refuse `connect()` if previous thread still running.  
4. **P3-17d** — closeEvent: wait with status “Stopping…”.  
5. **P3-17e** — Design reconnect policy (product) separate FIND.

---

## 7. Finding ID format

`FIND-P217-XX`

| Seed | Title | Sev |
|------|-------|-----|
| FIND-P217-01 | wait(2000) orphans live QThread | P0 |
| FIND-P217-02 | quit() ineffective during run_until_complete | P0 |
| FIND-P217-03 | stop lacks task cancellation | P0 |
| FIND-P217-04 | Direct cross-thread stop() | P2 |
| FIND-P217-05 | No reconnect after connector error | P0/P1 |
| FIND-P217-06 | connected before WS up | P2 |

---

## 8. Fix strategy sketch

1. Keep cooperative `_running` flag.  
2. On stop:  
   - `run_coroutine_threadsafe` a `shutdown()` that: closes transport, cancels tasks, stops loop.  
3. `wait(5000)` or until done; if still running: keep refs, show error, block new connect.  
4. Wire `stop` via `QMetaObject.invokeMethod(..., Qt.QueuedConnection)` **only if** thread event loop runs — **or** keep direct flag+threadsafe coro (current) but document.  
5. `closeEvent`: `stop_current` + assert not running.  
6. Reconnect: supervised loop with exponential backoff (new feature).

---

## 9. Dependencies

| Theme | Rel |
|-------|-----|
| **P2-18** | SSL patch during start |
| **P2-13/22** | Orphan still puts to queue |
| **P2-19** | Parallel fix pattern for replay |
| **P2-20** | Signals during teardown |
| **P2-21** | switch_to races |

---

## 10. Severity priors

| Source | Sev |
|--------|-----|
| R20 P0-05 | **P0** |
| R16 H1/H2 | High |
| R06 H2 no reconnect | P0/P1 |
| Likelihood | Medium-High on flaky net / fast switch |

---

## 11. Code anchors

```112:133:/Users/nazmi/flowmap/flowmap/data/crypcodile_live.py
        self._loop = asyncio.new_event_loop()
        ...
            self._loop.run_until_complete(self._run())
    def stop(self) -> None:
        self._running = False
        if self._loop and self._loop.is_running():
            if self._connector and self._connector.transport:
                asyncio.run_coroutine_threadsafe(
                    self._connector.transport.close(), self._loop
                )
```

```253:263:/Users/nazmi/flowmap/flowmap/data/crypcodile_live.py
    def disconnect(self) -> None:
        if self._worker:
            self._worker.stop()
        if self._thread and self._thread.isRunning():
            self._thread.quit()
            self._thread.wait(2000)
        self._worker = None
        self._thread = None
```
