# P2-18 — Global SSL monkeypatch blast radius

| Field | Value |
|-------|-------|
| **Agent ID** | P2-18 |
| **Theme** | Global SSL monkeypatch blast radius |
| **Zones** | Z06 |
| **Siblings** | R06 H4, R16 H12, R20 P0-11 |
| **Finding prefix** | `FIND-P218-XX` |
| **Severity prior** | **P0** security (MitM); **P1** embed blast radius |
| **Primary files** | `data/crypcodile_live.py` |

---

## 1. Scope & linked zones / sibling hyps

### Code

```100:108:/Users/nazmi/flowmap/flowmap/data/crypcodile_live.py
            if not getattr(aiohttp.ClientSession, '_patched_for_flowmap', False):
                original_ws_connect = aiohttp.ClientSession.ws_connect
                async def patched_ws_connect(self_session, url, *args, **kwargs):
                    kwargs['ssl'] = False
                    return await original_ws_connect(self_session, url, *args, **kwargs)
                aiohttp.ClientSession.ws_connect = patched_ws_connect
                aiohttp.ClientSession._patched_for_flowmap = True
```

### Properties

| Property | Value |
|----------|-------|
| Scope | **Process-global** class attribute |
| Idempotent guard | `_patched_for_flowmap` |
| Reversible | **No** — original not saved for restore |
| Affects | **All** `ClientSession.ws_connect` in process after first live start |
| Forces | `ssl=False` always (overrides caller True) |
| Embed | Crypcodile GUI hosting FlowMap → entire host aiohttp WS insecure |

### Out of scope

- Teardown zombies → P2-17  
- CCXT SSL behavior → separate if any  

---

## 2. Threat model

| Threat | Impact |
|--------|--------|
| Network MitM on exchange WS | Fake book/trades → **wrong trading view** (integrity) |
| Corporate TLS inspection conflicts | Intermittent connect failures |
| Embed host uses aiohttp WS for auth APIs | Credentials/session on clear trust path |
| Multi-provider future | Patch already applied; hard to audit |
| Patch fails (exception) | Warning only; may fail WS on strict SSL envs **or** succeed with verify |

**Why it exists (hypothesis):** local/dev cert issues or exchange endpoint quirks — not documented in code.

---

## 3. Concrete probes

### 3.1 Static

| # | Probe |
|---|-------|
| S1 | Confirm patch only in crypcodile_live start |
| S2 | Grep entire monorepo for `_patched_for_flowmap` / `ssl=False` |
| S3 | Check if AiohttpWsTransport accepts ssl context param (crypcodile pkg) |
| S4 | Confirm no restore on disconnect |

### 3.2 Dynamic

**D1 — Patch presence**

```text
Before live: aiohttp.ClientSession.ws_connect is original
After live start: is patched; _patched_for_flowmap True
After disconnect: still patched
```

**D2 — Force override**

```text
Call ws_connect(..., ssl=ssl_ctx) after patch
Assert kwargs inside wrapper force False (instrument wrapper)
```

**D3 — Blast radius (embed simulation)**

```text
Second ClientSession in same process for https://example.com WS
Observe ssl verify disabled
```

**D4 — Legitimate SSL**

```text
Attempt connect with patch removed / ssl default
Does Binance public WS work on macOS? Document need for patch
```

### 3.3 Security review questions

1. Is exchange endpoint MITM-relevant for this app’s threat model? (Yes for integrity of market data.)  
2. Is there a secure alternative (certifi, custom CA)?  
3. Should opt-in env `FLOWMAP_INSECURE_SSL=1` gate the patch?

---

## 4. Pass / fail criteria

| ID | Pass | Fail |
|----|------|------|
| PF1 | Default build verifies TLS | Global ssl=False always |
| PF2 | Insecure mode explicit + logged + UI warning | Silent patch |
| PF3 | Patch not global; scoped to transport | Class monkeypatch |
| PF4 | Embed host unaffected by default | Host WS also insecure |
| PF5 | Documented why SSL disabled | Mystery |

---

## 5. Fixtures

- Unit test that imports live worker and asserts no patch at import time  
- Optional: local aiohttp WS server with self-signed cert for opt-in path  

---

## 6. Phase-3 micro-tasks

1. **P3-18a** — Confirm D1–D2; FIND-P218-01.  
2. **P3-18b** — Check crypcodile `AiohttpWsTransport` for ssl parameter support.  
3. **P3-18c** — Prototype: pass `ssl=False` only into transport ctor / connector kwargs.  
4. **P3-18d** — Gate behind env/flag; default secure.  
5. **P3-18e** — If cert issues remain, document corporate proxy setup.

---

## 7. Finding ID format

`FIND-P218-XX`

| Seed | Title | Sev |
|------|-------|-----|
| FIND-P218-01 | Process-global aiohttp ssl=False | P0 |
| FIND-P218-02 | Irreversible monkeypatch | P1 |
| FIND-P218-03 | Forces override of caller ssl= | P0 |
| FIND-P218-04 | No user-facing insecure warning | P1 |
| FIND-P218-05 | Embed blast radius | P0 if embed shipping |

---

## 8. Fix strategy sketch

1. **Remove monkeypatch.**  
2. Configure transport:

```text
ssl=False only if FLOWMAP_WS_INSECURE=1
else default SSLContext with certifi
```

3. If crypcodile connector doesn’t expose ssl, upstream PR or wrapper session factory **local** to worker (not ClientSession class).  
4. Log loud WARNING when insecure.  
5. Never set class attribute on aiohttp.

---

## 9. Dependencies

| Theme | Rel |
|-------|-----|
| **P2-17** | Same start() path; fix order: SSL then teardown |
| **P2-35/42** | Embed process shares interpreter |
| Packaging P2-48 | Env vars in shipped app |

---

## 10. Severity priors

| Source | Sev |
|--------|-----|
| R20 P0-11 | **P0** |
| R06 H4 | Security + intermittent TLS |
| R16 H12 | Low standalone / higher embed |

---

## 11. Code anchors

```100:108:/Users/nazmi/flowmap/flowmap/data/crypcodile_live.py
            if not getattr(aiohttp.ClientSession, '_patched_for_flowmap', False):
                original_ws_connect = aiohttp.ClientSession.ws_connect
                async def patched_ws_connect(self_session, url, *args, **kwargs):
                    kwargs['ssl'] = False
                    return await original_ws_connect(self_session, url, *args, **kwargs)
                aiohttp.ClientSession.ws_connect = patched_ws_connect
                aiohttp.ClientSession._patched_for_flowmap = True
```
