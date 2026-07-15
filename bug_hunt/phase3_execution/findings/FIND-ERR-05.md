# FIND-ERR-05

| Field | Value |
|-------|-------|
| **ID** | FIND-ERR-05 |
| **Severity** | P2 |
| **Status** | CONFIRMED |
| **Title** | CCXT liquidation stream errors fully silent (no `sig_error`) |
| **Location** | flowmap/data/crypto.py:262-283 |
| **Taxonomy** | data_source |
| **Sibling** | R19 H4 |
| **Wave** | W3 |
| **Discovered by** | H-ERR (R19 Phase-3 hunter) |

### Repro
1. Start CCXT.pro WebSocket provider on an exchange with `watchLiquidations` support.
2. Induce liquidation stream failures (unsupported market mid-session, network blip, API key/permission).
3. `_watch_liquidations` catches `Exception`, sleeps 10s, retries — never emits `sig_error`.
4. Compare: `_watch_orderbook` / `_watch_trades` / `_watch_ticker` all emit `sig_error` + sleep 5s.

### Expected
Same contract as other watchers: emit stream error string so `SourceManager._on_provider_error` shows status-bar `Error: ...`.

### Actual
```python
except Exception:
    await asyncio.sleep(10)
```
Liquidation feature can die for minutes with zero UX while book/trades still update → user thinks "no liquidations in market" rather than "stream dead".

### Fix hint
```python
except Exception as exc:
    self.sig_error.emit(f"Liquidation stream: {exc}")
    await asyncio.sleep(10)
```
Align sleep/backoff with other watchers.

### Evidence
- Static contrast L282-283 vs L292-305 (orderbook/trade/ticker emit errors)
