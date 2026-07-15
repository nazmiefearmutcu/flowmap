# P2-03 — Side Enum Exhaustiveness (`is_buy_side` vs BUY-only UI)

**Agent:** P2-03  
**Track:** A — Core correctness  
**Theme n:** 3  
**Finding ID prefix:** `FIND-P203-`  
**Severity prior:** **P1** (systematic CVD/color skew; P0 if production feeds emit BID/ASK on trades)

---

## 1. Scope & linked zones / sibling hyps

| Item | Value |
|------|-------|
| **Zones** | **Z08** (record mapping), **Z04** (trade overlays) |
| **Siblings** | R17 §5 H-S1–S11; R11 bubbles/pulse; R03 H-R03-13 |
| **Core helpers** | `core/__init__.py` `Side`, `is_buy_side`, `is_sell_side` :12–42 |
| **Good consumers** | `order_book.py` absorption :176,227; `heatmap_widget.py` trade dots :1625 |
| **BUY-only / else-sell consumers** | `ui/pulse.py:219,238`; `ui/overlays/cvd.py:80`; `ui/bubbles.py:111–125`; `plugins/plugin_api.py:280–283` |
| **Default-BUY producers** | `crypcodile_replay.py:76–83`; `crypto.py:82` |

### Non-scope

- Field mapping of price/size/ts → P2-05  
- NaN CVD empty session → P2-06  

---

## 2. Threat model

**Canonical model (docs):**

- Book levels: `Side.BID` / `Side.ASK`  
- Trade aggressor: `Side.BUY` / `Side.SELL`  
- `is_buy_side` treats BUY **and** BID as buy; SELL **and** ASK as sell  

**Split-brain:**

| Layer | Behavior if trade.side = BID |
|-------|------------------------------|
| OrderBook CVD / absorb | Treats as **buy** |
| Pulse / CVDOverlay local | `side == BUY` false → **sell** (−size) |
| Bubbles new bubble | buy_size=0, sell_size=0 (**invisible volume**) |
| Bubbles merge | else branch → sell_size += |
| Plugin CVD | ignored (delta 0) |
| Heatmap dots | is_buy_side → buy color |

**Producer bias:** unknown side → `Side.BUY` (bullish CVD bias) — R17 H-S2.

**Impact:** Dual CVD series (session vs pulse local) diverge; wrong bubble colors; silent zero-size bubbles.

---

## 3. Concrete probes

### 3.1 Static exhaustiveness audit

Build a table of every `side ==` / `is_buy_side` / `is_sell_side` in `/Users/nazmi/flowmap/flowmap`:

```bash
rg -n 'Side\.(BUY|SELL|BID|ASK)|is_buy_side|is_sell_side' flowmap/
```

Classify each site: **book-side**, **aggressor**, **unknown default**.

### 3.2 Unit matrix (all Side values + None + stringy)

For each consumer function, inject trades with sides:

`{BUY, SELL, BID, ASK, None}` and sizes 1.0.

| Consumer | Method | Probe |
|----------|--------|-------|
| OrderBook | `record_trade` | buy/sell totals + which book side absorbed |
| VolumeBubbles | `add_trade` | buy_size/sell_size on new + merge |
| MarketPulse | `add_trades` / per-trade delta | sign of delta |
| CVDOverlay | `add_trade` | sign |
| PluginAPI | CVD accumulators | if test harness available |
| heatmap add_trade path | color branch | green vs red |

### 3.3 Producer default matrix

| Input side | `_get_flowmap_side` / crypto map | Result |
|------------|----------------------------------|--------|
| None | | expect BUY (document FIND if silent) |
| "buy"/"sell"/"bid"/"ask" | | |
| "BUYER" / garbage | | default BUY |
| Enum with .value | | |

### 3.4 Integration

1. Force one trade with `Side.BID` through `_gui_tick` path → compare `order_book.get_volume_delta()` vs pulse local CVD tip.  
2. Same with `Side.ASK`.  
3. Replay segment if lake tags trades with bid/ask (maker semantics).

### 3.5 Anchors

| Site | Path |
|------|------|
| Helpers | `core/__init__.py:19–42` |
| Book | `order_book.py:176–205,227–256` |
| Pulse | `pulse.py:219,238` |
| Bubbles | `bubbles.py:111–125` |
| CVD overlay | `overlays/cvd.py:80` |
| Heatmap liq | `heatmap_widget.py:1687` (`== Side.SELL` only) |
| Replay map | `crypcodile_replay.py:58–83` |
| CCXT | `crypto.py:25,82` |

---

## 4. Pass / fail criteria

| | Criteria |
|--|----------|
| **PASS** | Every trade-side consumer uses `is_buy_side`/`is_sell_side` **or** rejects non BUY/SELL with log; producers never emit BID/ASK on Trade; dual CVD series match on full enum matrix |
| **FAIL** | Any production path where BID trade flips sign between book CVD and pulse; bubbles drop size; default-BUY hides data loss |

---

## 5. Fixtures

| Fixture | Content |
|---------|---------|
| `fixtures/trades/side_matrix.json` | 5 trades, one per side + None |
| Synthetic `Trade(...)` builders in test helper | Prefer code over files |

No parquet required for unit exhaustiveness.

---

## 6. Phase-3 micro-tasks

### P2-03-H1 — Static audit table  
Produce markdown table of all side checks → attach to findings.

### P2-03-H2 — Consumer unit matrix  
Implement pytest parametrized over Side × consumer; file FINDs for mismatches.

### P2-03-H3 — Producer default-BUY bias  
Prove unknown → BUY; measure CVD bias over N random unknown; FIND-P203-0x.

### P2-03-H4 — Liquidation side path  
`heatmap_widget` liq color `== Side.SELL` only; test BID/ASK liqs.

### P2-03-H5 — End-to-end dual CVD  
_gui_tick simulation: inject BID trades → assert engine `_cvd_history` vs pulse property.

---

## 7. Finding ID prefix

`FIND-P203-`

| ID | Likely |
|----|--------|
| FIND-P203-01 | Pulse BUY-only inverts BID trades |
| FIND-P203-02 | Bubbles zero both sizes for BID/ASK on create |
| FIND-P203-03 | Unknown side default BUY bias |
| FIND-P203-04 | Liq color misses non-SELL |
| FIND-P203-05 | Plugin CVD ignores BID/ASK |

---

## 8. Fix strategy sketch

1. **Single helper policy:** All aggressor paths call `is_buy_side` / `is_sell_side`.  
2. **Strict Trade construction:** Converters map only buy/sell; bid/ask on trade channel → map to BUY/SELL by aggressor convention **or** drop with metric.  
3. **Remove default BUY:** Unknown → skip trade or Side that fails closed (no CVD).  
4. Bubbles: `if is_buy_side: buy else if is_sell_side: sell else: ignore/log`.  
5. Align liquidation coloring with `is_sell_side`.

---

## 9. Dependencies

| | |
|--|--|
| **Depends** | None for static/unit |
| **Feeds** | P2-05 (mapping should emit only BUY/SELL); P2-06 (CVD numeric); P2-32 (bubbles bias theme later) |
| **Parallel** | P2-01, P2-02 |

---

## 10. Severity priors

| Issue | Prior |
|-------|-------|
| Pulse/CVD BUY-only vs book is_buy_side | **P1** (R17 H-S1) |
| Default BUY unknown | **P1** (H-S2) |
| Bubbles zero size | **P1** |
| Plugin ignore | **P2** (plugins unwired) |
| Docs BID≡buy for trades | **P2** (H-R03-13) |

**Wave:** W1 (Z08 mapping).
