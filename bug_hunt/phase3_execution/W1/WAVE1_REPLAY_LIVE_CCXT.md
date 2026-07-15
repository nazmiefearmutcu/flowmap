# Wave1 — REPLAY / LIVE / CCXT bug hunt

| Field | Value |
|-------|-------|
| **Wave** | W1 |
| **Date** | 2026-07-13 |
| **Plans** | P2-23, P2-24, P2-39, P2-40, P2-41 + R05, R06 |
| **Files** | `flowmap/data/crypcodile_replay.py`, `crypcodile_live.py`, `crypto.py` |
| **Method** | Static confirmation against source (line-level) |
| **Agent** | Wave1-REPLAY/LIVE/CCXT |

---

## Confirm checklist (user targets)

| Target | Verdict | FIND |
|--------|---------|------|
| Time-warp | **CONFIRMED** | FIND-P239-01 (+ compound FIND-P240-03) |
| Price rewrite | **CONFIRMED** | FIND-P240-01, FIND-P240-02, FIND-P240-09 |
| Empty loop spin | **CONFIRMED** | FIND-P219-03 |
| SQL f-string | **CONFIRMED** | FIND-P241-01 |
| No reconnect | **CONFIRMED** | FIND-P217-05 |
| CCXT stall | **FIXED in tree** (nonce) | FIND-P224-01 → `fixed`; residual FIND-P224-04 |
| REST on GUI thread | **CONFIRMED** (latent path) | FIND-P223-01, FIND-P223-05 |
| Channels omitted | **CONFIRMED** | FIND-P217-07 |

---

## Findings filed (14)

| ID | Sev | Status | Title |
|----|-----|--------|-------|
| FIND-P239-01 | P0 | confirmed | Global trade time-warp always on |
| FIND-P239-03 | P0 | confirmed | Full-history trade materialize OOM |
| FIND-P239-08 | P2 | confirmed | Sleep cap 5s secondary warp |
| FIND-P240-01 | P0 | confirmed | Dynamic BBO/mid price rewrite |
| FIND-P240-02 | P0 | confirmed | Static full-table AVG shift |
| FIND-P240-03 | P0 | confirmed | Compound warp + rewrite fiction |
| FIND-P240-09 | P1 | confirmed | Bootstrap pollutes LocalBookTracker |
| FIND-P219-03 | P0 | confirmed | Empty auto-loop CPU spin |
| FIND-P241-01 | P1 | confirmed | SQL f-string symbol/date |
| FIND-P223-01 | P1 | confirmed | REST `_poll_tick` on GUI (latent) |
| FIND-P223-05 | P1 | confirmed | No CCXT REST timeout (latent) |
| FIND-P217-05 | P0 | confirmed | Live no reconnect after fail |
| FIND-P217-07 | P1 | confirmed | Live omits book_ticker + liquidation |
| FIND-P224-01 | P0 | **fixed** | Identity stall (nonce re-verify) |
| FIND-P224-04 | P1 | confirmed | Dual BBO OB+ticker thrash |

*(15 rows if counting update of pre-existing FIND-P224-01)*

---

## Code anchors (quick)

### Replay dual-timeline + rewrite
- Trade global MIN/MAX + scale map: `crypcodile_replay.py:290–383`
- Static AVG shift: `317–327`
- Dynamic BBO snap: `390–474`
- Bootstrap pollution: `423–434`
- Empty auto-loop: `332` + `539–541`
- Sleep cap: `499–500`
- SQL f-strings: `295`, `320–321`, `810+`, `935+`

### Live
- SSL global patch: already FIND-P218-01 (`100–108`)
- Single-shot `connector.run()`: `166–173`
- Channels subset: `151`

### CCXT
- Nonce fix (stall closed): `148–151`, `233–260`, `294–295`, `317–318`
- REST GUI: `485–488`, `496–534`
- Config no timeout: `359–366`

---

## Severity rollup

| Sev | Count (new/updated this wave) |
|-----|-------------------------------|
| P0 confirmed | 7 (239-01, 239-03, 240-01, 240-02, 240-03, 219-03, 217-05) |
| P0 fixed | 1 (224-01) |
| P1 | 6 |
| P2 | 1 |

---

## Phase-4 priority (suggested order)

1. **Kill replay fiction:** remove time-warp + price rewrite (P239/P240) — single PR if possible  
2. **Empty loop + materialize bounds** (P219-03, P239-03)  
3. **Live reconnect + channels** (P217-05, P217-07)  
4. **SQL parameterize** (P241-01)  
5. **REST off GUI + timeout** if CryptoProvider re-enabled (P223-*)  
6. **Dual BBO cleanup** (P224-04)

---

## Notes

- CryptoProvider is not in current `DataSource` enum (LIVE/REPLAY only) → REST/CCXT findings marked latent where appropriate but code still ships.
- FIND-P218-01 (SSL) pre-existed; not re-filed.
- No runtime lake GUI run in this wave; all CONFIRMED via static source truth matching R05/R06 hypotheses.
