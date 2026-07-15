# P2-07 — Density Mid-Mask & Bid/Ask Projection

**Agent:** P2-07  
**Track:** A — Core correctness  
**Theme n:** 7  
**Finding ID prefix:** `FIND-P207-`  
**Severity prior:** **P0** (R07 H1 — opposite-side liquidity dropped; wrong market structure on heatmap)

---

## 1. Scope & linked zones / sibling hyps

| Item | Value |
|------|-------|
| **Zones** | **Z02** |
| **Siblings** | R07 H1, H2, H11, H12; R20 density mid-mask ship-breaker #5 |
| **Primary** | `engine/density_engine.py` `_draw_column` :259–394 |
| **Related** | rebuild path in `heatmap_widget.py` ~745–870 (same mid mask?) |
| **Inputs** | `BookLevel` bid_size/ask_size; BBO mid |

### Linked hypotheses

| ID | Claim |
|----|-------|
| R07 H1 | `active_bids = is_bid & norm_bids`; rows above mid never show bid size |
| R07 H2 | `np.maximum.at` under ticks_per_row>1 understates stacked liquidity |
| R07 H11 | Live no-mid: `bid > ask`; rebuild `>=` — diverge |
| R07 H12 | BBO overwrite removes density at TOB rows |

---

## 2. Threat model

**Projection pipeline (truth):**

```text
bid prices → rows via render_tick_size → bid_arr[row] = max sizes
ask prices → ask_arr similarly
normalize separately
is_bid[row] = (price_at_row <= mid)   # half-plane
paint bid LUT only where is_bid & norm_bid
paint ask LUT only where ~is_bid & norm_ask
BBO rows overwrite fixed RGBA
```

**Correctness threats:**

1. **Crossed-side liquidity:** Bid size resting **above** mid (or ask below mid) after stale book / cross residual → **invisible**.  
2. **Intentional product vs bug:** Bookmap-style often colors by side-of-book not mid; mid-mask is a **policy** — still user-visible “missing wall”.  
3. **Max not sum:** Multiple ticks → one row keeps max → thin walls (H2) — especially BTC ticks_per_row=100.  
4. **min_order_size / active > 0.01:** small sizes zeroed.  
5. **No mid:** fallback comparison bid_arr vs ask_arr — asymmetric live/rebuild.  
6. **BBO overwrite:** density hole at best bid/ask rows.

---

## 3. Concrete probes

### 3.1 Static

1. Read mid mask block :362–382.  
2. Compare rebuild coloring in heatmap_widget for same is_bid logic.  
3. Confirm docs claiming decay/accumulation are stale (do not test decay).

### 3.2 Unit — mid mask (engine buffer inspection)

Construct `DensityEngine` small buffer; push synthetic levels; read `_buffer` RGBA column.

| Probe | Levels / BBO | Assert |
|-------|--------------|--------|
| M1 | Bid only at mid−1 tick, ask at mid+1 | Bid green LUT below mid; ask warm above |
| M2 | Bid size at price **mid+2 ticks** (above mid) | **Pixel empty or ask-colored?** Document drop |
| M3 | Ask size at mid−2 | Drop on bid half? |
| M4 | Both bid and ask size same price | max norm; side by mid only |
| M5 | mid=0 / no BBO | fallback path; no crash |
| M6 | Crossed BBO bid>ask | mid weird; mask behavior |

### 3.3 Unit — max aggregation (H2)

| Probe | Setup | Assert |
|-------|-------|--------|
| A1 | ticks_per_row=1; two adj ticks sizes 10,100 | separate rows |
| A2 | ticks_per_row large so both map one row | buffer row size == **100** (max) not 110 |
| A3 | Desired product sum? | If sum expected → FIND |

### 3.4 Unit — BBO overwrite

| Probe | | |
|-------|--|--|
| B1 | Large density at best bid row | After draw, row equals BBO RGBA not LUT |

### 3.5 Dynamic / visual

1. Live BTC: note walls that “stop” at mid while DOM shows size across.  
2. Rebuild after resize — compare column histogram to live (H4 dual path — may defer to P2-11).

### 3.6 Anchors

| Topic | Line |
|-------|------|
| maximum.at | `density_engine.py:305–315` |
| mid mask | `density_engine.py:362–382` |
| BBO write | `density_engine.py:384–394` |
| density store | `density_engine.py:133–136` |
| render_tick_size | `density_engine.py:534–535` |

---

## 4. Pass / fail criteria

| | Criteria |
|--|----------|
| **PASS (policy A — side-of-book)** | Paint by bid_arr/ask_arr side regardless of mid; M2 shows bid color above mid |
| **PASS (policy B — mid half-plane documented)** | M2 drop is intentional; UI/docs state it; no accidental double-drop with prune |
| **FAIL** | Undocumented missing walls; live≠rebuild side paint; crash on mid=0; max aggregation silent understate without doc |

Phase-3 should **classify** H1 as intentional vs bug with product note; still file FIND if undocumented.

---

## 5. Fixtures

| Fixture | |
|---------|--|
| Synthetic BookLevel lists + BBO | mid 100, tick 0.1 |
| `ticks_per_row` ∈ {1,10,100} | for A1–A2 |
| Optional screenshot goldens | M1–M2 |

---

## 6. Phase-3 micro-tasks

### P2-07-H1 — Mid-mask unit M1–M3  
Prove drop; FIND-P207-01 with policy note.

### P2-07-H2 — Max-vs-sum aggregation  
A1–A2; FIND-P207-02 if understate.

### P2-07-H3 — No-mid fallback live vs rebuild  
M5 + rebuild code path compare; FIND-P207-03 if `>` vs `>=`.

### P2-07-H4 — BBO overwrite holes  
B1; severity P2 unless TOB walls critical.

### P2-07-H5 — Crossed mid + empty book from P2-02  
Integration: after cross wipe, density no crash.

---

## 7. Finding ID prefix

`FIND-P207-`

| ID | Issue |
|----|-------|
| FIND-P207-01 | Mid-mask drops opposite-side liquidity |
| FIND-P207-02 | maximum.at understates multi-tick rows |
| FIND-P207-03 | Live/rebuild no-mid compare diverge |
| FIND-P207-04 | BBO overwrite clears TOB density |
| FIND-P207-05 | min 0.01 / norm gate hides small size |

---

## 8. Fix strategy sketch

1. **Side-of-book paint:** `active_bids = norm_bids > thr` (ignore mid); use mid only for labels.  
2. Or **draw both** with max side wins per pixel.  
3. Aggregation: `np.add.at` for sum (Bookmap-like liquidity stack) with overflow guard.  
4. Unify live/rebuild fallback `>=`.  
5. BBO: blend or draw line in overlay paint instead of buffer poke.

---

## 9. Dependencies

| | |
|--|--|
| **Depends** | P2-01/02 for sane levels & mid |
| **P2-09** | wrong tick breaks row mapping |
| **Blocks** | Paint artifact hunts Z01; P2-08 assumes draw works |

---

## 10. Severity priors

| Issue | Prior |
|-------|-------|
| Mid-mask drop | **P0** (R07 H1, R20) |
| Max not sum | **P0/P1** (H2, BTC) |
| Fallback diverge | **P2** |
| BBO overwrite | **P2** |

**Wave:** W2 (after book truth W1).
