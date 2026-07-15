# P2-32 — Bubbles/pulse draw cost + side bias

| Field | Value |
|-------|-------|
| **Agent** | P2-32 |
| **Theme** | Bubbles pulse draw cost side bias |
| **Zones** | Z04 (Z04b pulse/bubbles) |
| **Sibling hyps** | R11 (full), R17 H-S* side maps, R08 H19 trade deque/percentile, R20 P1-06 |
| **Severity prior** | **P1** correctness (side bias/column lag); **P1–P2** performance under tape bursts |
| **Primary files** | `/Users/nazmi/flowmap/flowmap/ui/bubbles.py`, `/Users/nazmi/flowmap/flowmap/ui/pulse.py`, `/Users/nazmi/flowmap/flowmap/ui/heatmap_widget.py` (`add_trades`, `_draw_trades`), `/Users/nazmi/flowmap/flowmap/ui/main_window.py` (`_gui_tick`) |

---

## 1. Scope & linked zones/sibling hyps

### In scope
- `VolumeBubbles` side handling (`Side.BUY` only for buy path; else sell) — **BID/ASK/string sides**
- Dual overlay cost: bubbles **+** trade dots (`_draw_trades`) + percentile on every `add_trades`
- Bubble merge O(n) reverse scan; deque maxlen 10k; **no age cull in draw** (dead `is_alive`/`alpha`)
- Bisect assumes monotonic `tick_index` after merge can raise tick (R11 A7)
- Column off-by-one: trades stamped **before** `_frame_count++` (R11 A1)
- MarketPulse: engine CVD vs local CVD; scroll ignore; width mismatch; side in sweep detection
- Pulse throttle 33ms vs heatmap cache rebuild coupling

### Out of scope
- Orphan `PriceChart` re-enable design (note only)
- Dead `CVDOverlay` deletion (R12 H08) — mention dependency
- Trade field mapping from exchange (P2-05)

---

## 2. Threat model

| Failure mode | User impact | Likelihood |
|--------------|-------------|------------|
| Side enum exhaustiveness | SELL-only drawn wrong; BID trades as sells | Med–High if feed uses BID/ASK aggressor |
| Column lag (A1) | Trades appear 1 col left of live wall | High (deterministic) |
| Merge breaks bisect order | Bubbles vanish/reappear when scrolling | Med |
| 10k bubbles + pie draw | FPS collapse on liquid symbols | High on BTC tape |
| Dual size models (log2 vs percentile) | Confusing double markers | High visual |
| Pulse ignores scroll | CVD not aligned with scrolled heatmap | High when user scrolls history |
| NaN early CVD | “Waiting for trades” until first trade | Known R17 |

**Threat actors:** market data side conventions; high-frequency trade bursts; user scroll+zoom.

---

## 3. Concrete probes

### 3.1 Static

| ID | Probe |
|----|-------|
| S1 | `rg 'Side\.BUY|is_buy_side|side ==' bubbles.py pulse.py heatmap_widget.py` |
| S2 | Trace `_gui_tick` order: `add_trades` → `push_snapshot` frame increment |
| S3 | Confirm `adjust_tick_indices` never called |
| S4 | Pulse paint: `slice_start = history_len - bw` without `_scroll_offset` |
| S5 | Import cost: `import bisect/math` inside methods |

### 3.2 Unit — side bias

| ID | Steps | Pass |
|----|-------|------|
| U1 | `add_trade(..., Side.BUY)` → buy_size | green path |
| U2 | `add_trade(..., Side.SELL)` → sell_size | red path |
| U3 | `add_trade(..., Side.BID)` | **Document actual:** currently else-branch → sell_size (bug if BID means buy aggressor) |
| U4 | `add_trade(..., Side.ASK)` | same |
| U5 | Matrix via `is_buy_side` vs raw `== Side.BUY` | Diff table for all enum members |
| U6 | Mixed merge same price | pie ratios correct |

### 3.3 Unit — time/column

| ID | Steps | Pass |
|----|-------|------|
| U7 | Mock frame_count=N; add_trade; push increments to N+1 | trade column equals live edge formula expectation (currently bw-2) |
| U8 | After merge raises tick_index of older bubble | bisect window still includes bubble |
| U9 | Non-monotonic tick sequence in deque | count dropped by bisect vs linear filter |

### 3.4 Unit / microbench — perf

| ID | Steps | Metric |
|----|-------|--------|
| P1 | 10k bubbles pure buy draw | ms/paint |
| P2 | 5k mixed pie bubbles | ms/paint vs solid |
| P3 | add_trade 1k/s with reverse merge scan full deque | ms/trade |
| P4 | `_update_trade_size_percentiles` on 10k sizes | ms |
| P5 | Disable dots OR bubbles | FPS delta |
| P6 | Age cull if enabled | draw list size drop |

### 3.5 Dynamic / GUI

| ID | Steps |
|----|-------|
| G1 | Live BTC: record FPS with bubbles on/off, dots on/off |
| G2 | Scroll history left: confirm bubbles track columns; pulse does **not** re-window |
| G3 | Screenshot pulse width vs heatmap timeline (right_margin_w) |
| G4 | Color vision menu on pulse — no crash; colors remap |
| G5 | Burst trades: UI hitch vs percentile recompute |

---

## 4. Pass/fail criteria

| Area | Pass | Fail |
|------|------|------|
| Side | All buy-like sides increment buy_size via shared helper | BUY-only; BID→sell |
| Column | Trades share column with co-batched snapshot | Systematic 1-col lag |
| Bisect | Visible set == linear filter by tick range | Missing bubbles after merge |
| Perf | Paint bubbles ≤ budget (e.g. 2ms @ 1080p for ≤500 visible) | >8ms with ≤500 visible |
| Age | Dead bubbles not drawn OR documented infinite trail | 10k full history always drawn |
| Pulse scroll | CVD window follows heatmap scroll **or** documented live-only | Silent desync |
| Dual overlay | Single size language OR clearly dual-mode UI | Conflicting sizes same trade |

---

## 5. Fixtures needed

| Fixture | Content |
|---------|---------|
| `trades_side_matrix.json` | BUY/SELL/BID/ASK/string sides |
| `trades_burst_10k.jsonl` | High rate same price |
| `trades_merge_reindex.jsonl` | Forces tick_index max-up merge |
| Synthetic `OrderBook` session for pulse CVD NaN then values |
| Screenshots baseline: bubbles+dots on SOL/BTC |

---

## 6. Phase-3 agent micro-tasks

### Hunt A — Side exhaustiveness table
Run U1–U6; produce matrix vs `is_buy_side` / R17. **FIND-P232-01**

### Hunt B — Column off-by-one proof
Instrument tick_index vs frame_count in one `_gui_tick`; screenshot live edge. **FIND-P232-02**

### Hunt C — Bisect correctness after merge
Fuzz merge sequences; compare bisect window to O(n) filter. **FIND-P232-03**

### Hunt D — Draw cost profile
cProfile / Qt paint timing; attribute cost to pie vs ellipse vs percentile. **FIND-P232-04**

### Hunt E — Pulse axis contract
Document scroll/width/CVD-source; file product bugs vs intentional live-tip CVD. **FIND-P232-05..06**

---

## 7. Expected finding IDs

Format: **`FIND-P232-XX`**

| ID | Title | Sev |
|----|-------|-----|
| FIND-P232-01 | Bubbles BUY-only side branch | P1 |
| FIND-P232-02 | Trade/bubble column off-by-one | P1 |
| FIND-P232-03 | Merge breaks bisect tick order | P1–P2 |
| FIND-P232-04 | Age fade dead code; 10k full draw | P2 |
| FIND-P232-05 | Dual size models dots vs bubbles | P2 |
| FIND-P232-06 | Percentile hitch on every batch | P1–P2 |
| FIND-P232-07 | Pulse ignores scroll_offset | P2 |
| FIND-P232-08 | Pulse width omits right_margin_w | P2 |
| FIND-P232-09 | O(n) merge scan per trade | P2 |
| FIND-P232-10 | adjust_tick_indices never wired | P3 |

---

## 8. Fix strategy sketch

1. Route all side classification through `is_buy_side` (shared with converters).
2. Stamp trades with **post-increment** frame or stamp after push with same index as column.
3. On merge, re-sort deque or use structure that keeps tick order; or linear scan for small visible windows.
4. Cull by `is_alive` / max visible ticks; draw only visible window without full 10k pie.
5. Throttle percentile (every N trades or on timer); share size scale between dots and bubbles optionally.
6. Pulse: apply `_scroll_offset` and shared `timeline_w` geometry helper from heatmap.
7. Remove dead imports-in-methods; prebind bisect.

---

## 9. Dependencies

| Theme | Why |
|-------|-----|
| P2-03 Side enum | Overlaps side exhaustiveness — **coordinate findings** |
| P2-05 Trade mapping | Bad side at ingress amplifies bias |
| P2-06 CVD NaN | Pulse empty state |
| P2-30 Trade deque percentile | Same hitch path; avoid double-fix |
| P2-10 tick/render_tick | Y alignment of bubbles |
| P2-43 Navigation/scroll | Pulse scroll contract |

---

## 10. Severity priors from phase1

| Source | Prior |
|--------|-------|
| R11 A1 column lag | P1 correctness |
| R11 A7 bisect | P1–P2 |
| R11 §6 perf | P1 under load |
| R11 side BUY | P1 with R17 |
| R20 pulse/bubbles risk 12 | HIGH band |
| R08 H19 percentile | P1 hitch |

**Verdict:** Correctness hunts (side + column + bisect) before micro-optimizing pie paths; still measure FPS for evidence.
