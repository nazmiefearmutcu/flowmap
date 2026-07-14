# P2-05 — Trade / Liquidation Field Mapping

**Agent:** P2-05  
**Track:** A — Core correctness  
**Theme n:** 5  
**Finding ID prefix:** `FIND-P205-`  
**Severity prior:** **P0–P1** (wrong price/size/side/ts → wrong CVD, absorption, overlays)

---

## 1. Scope & linked zones / sibling hyps

| Item | Value |
|------|-------|
| **Zones** | **Z08**, **Z04** |
| **Siblings** | R05, R06, R17 H-TS1, H-S*, H-F1; R11 trade stamp |
| **Converters** | `crypcodile_replay.py` `_cryp_trade_to_flowmap` :86–99, `_cryp_liquidation_to_flowmap` :102–112, `_dispatch_record` |
| **CCXT** | `crypto.py` trade/liq conversion ~25–90, ~260 |
| **Live** | `crypcodile_live.py` uses shared dispatch or parallel |
| **Consumers** | `OrderBook.record_trade*`, `HeatmapWidget.add_trade(s)`, pulse, VP, bubbles |

### Non-scope

- Side enum policy details (overlap with P2-03 — share FINDs, don’t duplicate full audit)  
- Replay time-warp / price rewrite design → P2-39/40 (note interaction)  
- Bubble column off-by-one → R11 / later Z04 hunt  

---

## 2. Threat model

**Trade dataclass contract** (`core/__init__.py:76–86`):

| Field | Unit / meaning |
|-------|----------------|
| timestamp | Unix **seconds** |
| symbol | str |
| price | float |
| size | float (amount) |
| side | aggressor BUY/SELL |
| trade_id | optional |
| is_liquidation | bool |
| receive_timestamp | receive clock seconds |

**Mapping risks:**

| Field | Failure | Impact |
|-------|---------|--------|
| amount→size | wrong field / contracts vs coin | bubble size, CVD scale |
| price | None/0; rewritten by replay align | absorption miss (5e-5 eps) |
| side | default BUY; bid/ask | P2-03 |
| local_ts ns → /1e9 | forgotten / double convert | year 50k+ or 1970 |
| liquidation flag | trade.liquidation vs separate channel | liq overlay miss/double |
| receive_timestamp | left 0 | latency HUD wrong; history ts fallback wall clock |
| trade_id | collision/None | dedupe impossible |
| symbol | mismatch book symbol | silent apply still |

**Liquidation-specific:** separate channel mapped to `Trade(is_liquidation=True)` — may also appear as normal trades → double count if both ingested.

---

## 3. Concrete probes

### 3.1 Static field map table

Build for each converter:

| Source field | Dest field | Transform |
|--------------|------------|-----------|
| rec.local_ts | timestamp | /1e9 |
| rec.amount | size | float |
| rec.price | price | float |
| rec.side | side | _get_flowmap_side |
| rec.id | trade_id | or None |
| liquidation attr | is_liquidation | |
| — | receive_timestamp | **default 0?** |

Compare live vs replay vs crypto.py for drift (dual converters — R02/R42 theme related).

### 3.2 Unit — golden conversions

| Probe | Input | Assert |
|-------|-------|--------|
| T1 | trade ns=1_700_000_000_000_000_000 | timestamp ≈ 1.7e9 seconds |
| T2 | amount=0.5, price=42000.1 | size/price exact |
| T3 | side sell/buy strings & enums | Side.SELL/BUY |
| T4 | liquidation record | is_liquidation True; size/price |
| T5 | trade with liquidation=True attr | is_liquidation True on normal trade path |
| T6 | id None / empty | trade_id None |
| T7 | crypto CCXT ms timestamp | /1000 once |
| T8 | size 0 trade | still recorded? CVD? absorption no-op |

### 3.3 Unit — consumer sensitivity

| Probe | Setup | Assert |
|-------|-------|--------|
| A1 | trade price off ask key by 1e-10 | absorb yes/no |
| A2 | trade price off by 1 tick (BTC 0.1) vs eps 5e-5 | miss absorb (FIND candidate H-F1) |
| A3 | liq vs normal same id both applied | double CVD |
| A4 | receive_timestamp=0 through heatmap | fallback time.time() in push path |

### 3.4 Dynamic

1. One real trade from replay dump raw vs converted vs OrderBook totals.  
2. Liquidation-heavy window: count liq channel events vs `is_liquidation` markers drawn.  
3. Compare CCXT vs crypcodile conversion of same conceptual trade if dual path available.

### 3.5 Anchors

| Converter | Lines |
|-----------|-------|
| Trade | `crypcodile_replay.py:86–99` |
| Liq | `crypcodile_replay.py:102–112` |
| Side default | `crypcodile_replay.py:76–83` |
| CCXT | `crypto.py:28–34, 82, ~260` |
| Absorb eps | `order_book.py:184–185` |
| Overlay wall clock | `heatmap_widget.py:423–426` (R17 H-TS1) |
| GUI add | `main_window.py:949–953` |

---

## 4. Pass / fail criteria

| | Criteria |
|--|----------|
| **PASS** | Field map documented; T1–T7 green; no double-count liq without FIND; timestamp unit consistent seconds; absorption policy documented relative to tick |
| **FAIL** | ms left as ms; size from wrong field; liqs missing is_liquidation; receive_ts always 0 with no fallback doc; dual converter disagreement |

---

## 5. Fixtures

| Fixture | Content |
|---------|---------|
| Captured crypcodile Trade/Liquidation dicts | Minimal msgspec-compatible |
| `fixtures/trades/ccxt_trade_sample.json` | CCXT shape |
| Optional: 1 min replay with known trade count | Oracle totals |

---

## 6. Phase-3 micro-tasks

### P2-05-H1 — Converter golden tests (replay)  
T1–T6.

### P2-05-H2 — CCXT converter parity  
T7 + side/size field names.

### P2-05-H3 — Liquidation double-path  
Dispatch both channels; count OrderBook trade_count vs unique ids.

### P2-05-H4 — Absorption epsilon vs tick  
A1–A2 for SOL/ETH/BTC ticks; FIND-P205-0x if 5e-5 wrong.

### P2-05-H5 — Timestamp / receive_ts pipeline  
Trace from convert → record → heatmap history; confirm H-TS1 wall-clock stamp.

---

## 7. Finding ID prefix

`FIND-P205-`

| ID | Issue |
|----|-------|
| FIND-P205-01 | Timestamp unit wrong |
| FIND-P205-02 | receive_timestamp never set |
| FIND-P205-03 | Liq double count |
| FIND-P205-04 | Epsilon absorption miss |
| FIND-P205-05 | Live vs replay converter drift |
| FIND-P205-06 | Overlay stamps time.time not Trade.timestamp |

---

## 8. Fix strategy sketch

1. Centralize `to_flowmap_trade(rec)` used by live+replay.  
2. Always set `receive_timestamp=time.time()` at ingress edge (worker).  
3. Tick-relative epsilon: `max(1e-12, 0.5 * tick_size)`.  
4. Liq: single channel or dedupe by trade_id.  
5. Heatmap `add_trade` store event timestamp for age if product wants replay-correct fade.

---

## 9. Dependencies

| | |
|--|--|
| **Depends** | P2-03 for side policy (coordinate FINDs) |
| **P2-01** | Absorption after L2 |
| **P2-39/40** | May intentionally rewrite price/time — mark expected vs bug |
| **Blocks** | Accurate Z04 overlay hunts |

---

## 10. Severity priors

| Issue | Prior |
|-------|-------|
| Wrong timestamp unit | **P0** |
| Wrong size/price field | **P0** |
| receive_ts 0 | **P1** |
| Epsilon mismatch | **P1** (H-F1) |
| Wall-clock overlay stamp | **P1** (H-TS1) |
| Default BUY | **P1** (shared P2-03) |

**Wave:** W1 (Z08).
