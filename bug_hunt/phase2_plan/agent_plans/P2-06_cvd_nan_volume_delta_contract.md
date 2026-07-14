# P2-06 — CVD NaN + Volume Delta Contract

**Agent:** P2-06  
**Track:** A — Core correctness  
**Theme n:** 6  
**Finding ID prefix:** `FIND-P206-`  
**Severity prior:** **P0** (R20 #7, R17 H-N1 — NaN into engine history + status bar)

---

## 1. Scope & linked zones / sibling hyps

| Item | Value |
|------|-------|
| **Zones** | **Z11**, **Z05** |
| **Siblings** | R17 H-N1/H-N2; R03 H-R03-12; R11 §4 CVD accumulators; R20 P0-10 |
| **Primary** | `order_book.py:349–354` `get_volume_delta` |
| **Pipe** | `main_window.py:958–959` push cvd; `:985–996` status format |
| **Sink** | `DensityEngine.push_snapshot(..., cvd=)` → `_cvd_history` |
| **UI** | `pulse.py` NaN filter; `overlays/cvd.py` |

### Three CVD sources (R11)

| Source | Formula | Used by |
|--------|---------|---------|
| `get_volume_delta()` | buy−sell or **nan** if trade_count==0 | Engine history, status |
| Engine `_cvd_history` | append each snapshot | MarketPulse paint primary |
| Pulse local | per-trade ±size | Fallback / sweeps |

---

## 2. Threat model

**Contract ambiguity:** Is “no trades yet” a CVD of **0** or **undefined (NaN)**?

**Current code:** explicit `math.nan` when `trade_count == 0`.

**Blast radius:**

1. `heatmap.push_snapshot(..., cvd=nan)` → history contains NaNs.  
2. Status: `f"CVD: {cvd:+.0f}"` → may show `CVD: +nan` or error depending on Python/format.  
3. Pulse filters isnan for paint (“Waiting for trades…”) — partial mitigation.  
4. After first trade, finite values — **gap** at start of history.  
5. `reset()` zeros counters → next ticks NaN again until trade — reconnect flash.  
6. Side bias (P2-03) changes finite CVD magnitude/sign independently of NaN issue.

**Not the same as:** division-by-zero in normalizer (guarded).

---

## 3. Concrete probes

### 3.1 Unit — OrderBook contract

| Probe | Steps | Assert actual vs desired |
|-------|-------|--------------------------|
| V1 | Fresh book, no trades, `get_volume_delta()` | **is nan** today |
| V2 | One buy 1.0 | delta == 1.0 |
| V3 | Buy 2 sell 3 | delta == -1.0 |
| V4 | reset after trades | nan again |
| V5 | trades then snap (no trade clear) | CVD unchanged (session) |
| V6 | BID side trade (is_buy_side) | counts as buy |

### 3.2 Unit — main_window / engine pipe (headless)

| Probe | Steps |
|-------|-------|
| P1 | Call push_snapshot with cvd=nan → inspect `_cvd_history[-1]` |
| P2 | Format status string with nan |
| P3 | Pulse paint data path with all-nan history |
| P4 | Finite after trade; history prefix nans length |

### 3.3 Static

1. Grep `get_volume_delta` all call sites.  
2. Grep `math.nan` / `isnan` in cvd paths.  
3. Confirm no `nan_to_num` on cvd before append.

### 3.4 Dynamic

1. App start → live source before first trade → screenshot status + pulse.  
2. Source switch reset → same.  
3. Long session CVD continuity vs exchange buy−sell if available.

### 3.5 Anchors

| Topic | Line |
|-------|------|
| NaN return | `order_book.py:349–354` |
| Push | `main_window.py:958–959` |
| Status | `main_window.py:985–996` |
| Engine append | `density_engine.py` push_snapshot cvd param (~history append region) |
| Pulse filter | `pulse.py` isnan handling |

---

## 4. Pass / fail criteria

| | Criteria |
|--|----------|
| **PASS (strict product)** | Pre-trade CVD is **0.0** finite everywhere; status never shows nan; history all finite |
| **PASS (alt contract)** | NaN intentional but **never** reaches format/UI/history — converted at boundary |
| **FAIL** | NaN in `_cvd_history` or status string under normal startup (current R17 claim → expect FIND-P206-01) |

Recommended product contract for Phase-3: **0.0 before first trade**; session delta after.

---

## 5. Fixtures

Minimal — pure unit. Optional: recorded `_cvd_history` from startup for regression golden.

---

## 6. Phase-3 micro-tasks

### P2-06-H1 — Prove NaN return  
V1 unit + FIND-P206-01 with file:line.

### P2-06-H2 — Pipe into engine/status  
P1–P2; capture status string; FIND-P206-02 if `nan` in UI string.

### P2-06-H3 — Pulse / history gaps  
P3–P4; document filter behavior; FIND if gaps break sweeps/bisect.

### P2-06-H4 — Reset / source switch re-NaN  
V4 + source_manager reset path.

### P2-06-H5 — Contract test + fix verification  
After fix strategy, assert V1 returns 0.0; history finite; status `CVD: +0`.

---

## 7. Finding ID prefix

`FIND-P206-`

| ID | Issue |
|----|-------|
| FIND-P206-01 | get_volume_delta returns nan |
| FIND-P206-02 | Status bar formats nan |
| FIND-P206-03 | _cvd_history polluted with nan |
| FIND-P206-04 | Reset reintroduces nan window |
| FIND-P206-05 | Dual CVD diverge (link P2-03) |

---

## 8. Fix strategy sketch

1. Change `get_volume_delta` to `return self.total_buy_volume - self.total_sell_volume` always (0 when no trades).  
2. Or keep nan but coerce at MainWindow: `cvd = x if x==x else 0.0`.  
3. Prefer (1) for single contract.  
4. Add unit test locked to finite.  
5. Pulse local vs session: separate theme but ensure both finite.

---

## 9. Dependencies

| | |
|--|--|
| **Depends** | None for H1 |
| **P2-03** | Sign of finite CVD |
| **P2-01** | Session survival across snap |
| **Never drop** | R20: theme 06 is must-keep |

---

## 10. Severity priors

| Issue | Prior |
|-------|-------|
| NaN CVD API | **P0** (R20 #7, P0-10) |
| Status nan | **P0/P1** visual |
| History gaps | **P1** |
| Dual series | **P2** without BID sides |

**Wave:** W1.
