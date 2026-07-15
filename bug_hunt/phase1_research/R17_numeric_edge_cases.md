# R17 — Numerical / Market-Data Edge Cases

**Agent:** R17 (Phase 1 bug-hunt)  
**Scope:** `/Users/nazmi/flowmap/flowmap`  
**Focus:** div-by-zero, NaN/Inf, overflow, float equality, tick size, timestamp units, side/aggressor conventions  

---

## Executive summary

FlowMap is generally careful about some divisions (`+ 1e-9`, `max(ref, 1e-9)`, CVD range guards) but has **systematic market-data numeric fragility**:

1. **Tick size is inferred once, poorly, and inconsistently applied** (raw `tick_size` vs `render_tick_size`).
2. **Hard-coded absolute price epsilons** (`0.00005`, `0.001`, `round(..., 6)`) break across symbols (BTC tick 0.1 / 1 vs micro-priced alts).
3. **Side handling is split-brained**: core uses `is_buy_side()`; CVD/bubbles/pulse/plugins often test only `Side.BUY`.
4. **Timestamp pipeline mixes** exchange seconds, receive wall-clock, and `time.time()` for trade overlays; latency math assumes receive wall-clock.
5. **CVD can inject `math.nan`** into the render history when no trades yet.

Below: findings ordered by severity, each with **file:line** hypotheses.

---

## 1. Division-by-zero / NaN / Inf / overflow

| ID | Severity | Location | Issue |
|----|----------|----------|--------|
| N1 | **High** | `core/order_book.py:349-354` | `get_volume_delta()` returns `math.nan` when `trade_count == 0`. |
| N2 | **High** | `ui/main_window.py:958-959`, `985-996` | That NaN is pushed into heatmap CVD history and formatted as `CVD: {cvd:+.0f}` → status/`pulse` NaN pollution. |
| N3 | **Med** | `engine/normalizer.py:49-50` | `nan_to_num` then `/ self._global_ref`. Ref guarded by `max(..., 1e-9)` — OK. |
| N4 | **Low** | `engine/density_engine.py:323-328`, `ui/heatmap_widget.py:827-831` | `/(ref + 1e-9)` — safe. |
| N5 | **Low** | `ui/overlays/cvd.py:139-141`, `ui/pulse.py:419-420` | Empty CVD range padded — OK. |
| N6 | **Med** | `ui/overlays/cvd.py:203` | Zero-cross: `t = (0.0 - v1) / (v2 - v1)` only in else when signs differ; if both zero not entered. OK. If float noise makes both ~0 with opposite signs of tiny eps — still OK. |
| N7 | **Low** | `plugins/plugin_api.py:264-266` | VWAP: guarded by `_vwap_vol_sum > 0`. |
| N8 | **Low** | `ui/overlays/vwap.py:58-60` | Same guard. |
| N9 | **Med** | `core/order_book.py:340-347`, `core/__init__.py:138-143` | Imbalance divides by total with `total == 0` guard — OK. Uses exact `== 0` float equality (see F*). |
| N10 | **Med** | `data/crypcodile_replay.py:498` | `sleep_sec = (delta_ns / 1e9) / self._speed` only if `self._speed > 0` — OK. |
| N11 | **Low** | `data/crypcodile_replay.py:379`, `534` | `t_span` / `total_span` guarded. |
| N12 | **Med** | `engine/density_engine.py:183` | `mid / self.render_tick_size` with no guard; `render_tick_size = tick_size * ticks_per_row`. Default tick 0.05 ≥ 0; if `tick_size` ever set 0 → Inf/NaN rows. |
| N13 | **Med** | `ui/heatmap_widget.py:760-761` | Rebuild path guards `render_tick_size <= 0` → fallback 0.05; **live push path** in density_engine does not. |
| N14 | **Low** | `data/simulator.py:66, 600` | `_safe_base`, `_safe_tick` guards — good pattern not used elsewhere. |
| N15 | **Med** | `ui/heatmap/heatmap_renderer.py:46-49` | `ref = max(ref, 1.0)` then `/ref` — OK; **hard floor 1.0** distorts tiny-size books (ETH-style sizes after refs tuned). |
| N16 | **Low** | `engine/density_engine.py:567-568` | Gaussian kernel `/ sum(kernel)` — sum > 0 for finite sigma. |
| N17 | **Low** | Overflow of Σ(price·vol) for VWAP over long sessions is theoretical for float64; not guarded. |

### Bug hypotheses — NaN / div

- **H-N1** `order_book.py:351-353` + `main_window.py:958`: Pre-trade frames inject NaN CVD into `DensityEngine._cvd_history`; pulse filters NaNs but gaps appear; status may show `nan`.
- **H-N2** `density_engine.py:183,305,313,386,391`: If `tick_size` becomes 0 (mis-detection / config), all row mappings explode to Inf and cast to garbage `int32`.
- **H-N3** `heatmap_widget.py:1130-1137`: Latency uses wall-clock − receive_ts; if receive_ts is **exchange epoch seconds** instead of receive wall-clock, latency is huge and silently dropped (`latency < 10`), so metric stays stale/None rather than wrong — masking clock-source bugs.

---

## 2. Tick size assumptions (symbol fragility)

### 2.1 Detection is one-shot and dead-branchy

```119:131:flowmap/engine/density_engine.py
        if not getattr(self, '_tick_size_detected', False):
            prices = sorted([lv.price for lv in levels])
            if len(prices) >= 2:
                diffs = np.diff(prices)
                valid_diffs = diffs[diffs > 0.000001]
                if len(valid_diffs) > 0:
                    obs_min = round(float(np.min(valid_diffs)), 6)
                    if not getattr(self, '_tick_size_detected', False):
                        self.tick_size = obs_min
                        self._tick_size_detected = True
                    else:
                        self.tick_size = min(self.tick_size, obs_min)  # DEAD
```

| ID | Severity | Location | Issue |
|----|----------|----------|--------|
| T1 | **High** | `density_engine.py:120-131` | Outer `if not _tick_size_detected` makes the `else: min(...)` **dead code**. Tick never refined after first observation. |
| T2 | **High** | `density_engine.py:114` | Param `detect_tick_size` is **accepted but never read**. |
| T3 | **High** | `density_engine.py:124-128` | `obs_min = min(positive diffs)` is **min gap between present levels**, not exchange tick. Sparse books → inflated tick (e.g. only every 5 ticks filled → 5× true tick) → vertical collapse of heatmap. |
| T4 | **Med** | `density_engine.py:72` | Default `tick_size = 0.05` (NIFTY-ish) until first multi-level snapshot; BTC/ETH wrong for early frames. |
| T5 | **High** | `ui/source_manager.py:386-397` | Hard-coded `ticks_per_row` by substring (`SOLUSDT`→2, `ETHUSDT`→10, else BTC→100). Wrong for `BTC/USDT`, `ETH-PERP`, alt symbols, or tick-rule changes. |
| T6 | **High** | `ui/heatmap_widget.py:1408-1419` vs `297-305` | **Historical BBO line** maps with raw `engine.tick_size`; **all other overlays** use `render_tick_size = tick_size * ticks_per_row`. When `ticks_per_row != 1` (always for BTC path), bid/ask history lines are **vertically mis-scaled** vs heatmap/BBO markers. |
| T7 | **Med** | `density_engine.py:534-535` | `render_tick_size` property multiplies every frame; no validation. |
| T8 | **Med** | Price→row: `np.round(price / render_tick_size)`. Binary float of prices like `0.1` / `0.00001` can land on wrong rows at boundaries (classic off-by-one tick). |

### Bug hypotheses — tick

- **H-T1** Sparse L2 snapshot on BTC locks `tick_size` to e.g. 1.0 or 5.0 instead of 0.1 → permanent vertical distortion until reset.
- **H-T2** `source_manager` sets `ticks_per_row=100` for “else”; symbol `BTCUSDT` OK, `btcusdt` lowercase or `BTC-USDT` falls into BTC branch coincidentally only if not SOL/ETH substring — `MYETHUSDT` would get ETH settings.
- **H-T3** `heatmap_widget.py:1418` historical lines ignore `ticks_per_row` → lines drift from live BBO markers after zoom/config.

---

## 3. Hard-coded absolute price epsilons / float keying

| ID | Severity | Location | Epsilon / rule | Breaks when |
|----|----------|----------|----------------|-------------|
| F1 | **High** | `order_book.py:184-185,199-200,235-236,250-251` | `abs(k - price) < 0.00005` trade absorption | Tick ≥ 0.0001: rarely matches nearby levels under float noise; **tick ≪ 0.00005** (some alts): can match **wrong** adjacent level. |
| F2 | **High** | `ui/dom/dom_ladder.py:226-227` | `abs(price - bbo) < 0.001` BBO highlight | Micro-tick assets: many rows “are BBO”; coarse-tick: may fail to highlight true BBO under float noise. |
| F3 | **High** | `ui/overlays/volume_profile.py:95,117,224,305` | `price_key = round(price, 6)` | Prices needing >6 dp (SHIB-class) **merge distinct ticks**; very large prices OK. |
| F4 | **Med** | `ui/overlays/volume_profile.py:370,408` | POC match `abs(...) < 0.000001` | Inconsistent with round-6 keys. |
| F5 | **Med** | `ui/overlays/vwap.py:109` | `abs(level.price - vwap) < 0.001` fallback Y | Wrong row on micro/coarse ticks. |
| F6 | **Med** | `ui/bubbles.py:109` | `abs(b.price - price) < 0.000001` merge | Same class of symbol bug. |
| F7 | **Med** | `core/order_book.py:169-171` | `_trade_volume[price]` raw float keys | Same economic price as distinct float bits → fragmented volume map. |
| F8 | **Med** | `density_engine.py:135-136` | density dicts keyed by raw `lv.price` | Fragmentation / double-rows. |
| F9 | **Low** | `data/simulator.py:170,448` | `round(price, 6)` keys | Demo-only consistency. |
| F10 | **Med** | Exact float equality for sizes: `size > 0`, `total == 0`, `update.size <= 0` | Near-zero residual sizes leave ghost levels until `<= 0.000001` pop in trade path only. |

### Bug hypotheses — float equality

- **H-F1** Trade size deducted only if price within **5e-5** of a book key; crypto exchange prices often exact, but replay price-alignment (`crypcodile_replay` shifts) can leave trades slightly off → **no book absorption**, inflated resting liquidity.
- **H-F2** SVP/CVP bins via `round(6)` collapse fine ticks → wrong POC/VA on low-priced symbols.
- **H-F3** DOM BBO highlight epsilon 0.001 is not tick-relative.

---

## 4. Timestamp units (ms vs s vs ns)

### Canonical design (documented)

| Source | Conversion | Result unit |
|--------|------------|-------------|
| Crypcodile `local_ts` (ns) | `crypcodile_replay.py:71-73` `/ 1e9` | Unix **seconds** float |
| CCXT `timestamp` | `crypto.py:28-34` `/ 1000` | Unix **seconds** float |
| Core types | `core/__init__.py:55` comment | Unix seconds |
| Simulator / trade UI | `time.time()` | Wall-clock seconds |

### Mismatches / risks

| ID | Severity | Location | Issue |
|----|----------|----------|--------|
| TS1 | **High** | `ui/heatmap_widget.py:423-426` | `add_trade` stores **`time.time()`**, not `Trade.timestamp`. Replay trades get **wall-clock now**, not event time → time-axis / age / bubble max_age (`bubbles.py:96 max_age=2.5s`) is wall-clock based, OK for live, **wrong for replay scrubbing** if ever time-based. Tick index used for X; age for fade uses wall clock. |
| TS2 | **High** | `ui/pulse.py:222,235-241`, `overlays/cvd.py:83` | CVD timestamps always `time.time()`, not market ts. |
| TS3 | **Med** | Crypcodile converters set `timestamp=` only; **`receive_timestamp` defaults 0** (`core/__init__.py:61,72,85,98`). Live latency path often sees 0 → falls back in `heatmap_widget.py:372`. |
| TS4 | **Med** | `heatmap_widget.py:372` | `ts = receive_timestamp or bbo.receive_timestamp or time.time()`. Replay often ends on **wall clock** for history timestamps while event `Trade.timestamp` is historical epoch — **mixed series** in `_timestamp_history`. |
| TS5 | **Med** | `heatmap_widget.py:1130-1132` | Latency = `now - last_receive_timestamp`. Requires receive wall-clock; if code ever plugs exchange ts into receive field, metric breaks. |
| TS6 | **Low** | `main_window.py:1090` | `datetime.fromtimestamp(data['timestamp'])` assumes seconds — correct for core types; **would break if ms slipped through**. |
| TS7 | **Med** | Replay sleep uses **ns** deltas (`crypcodile_replay.py:492-498`); emitted objects use **seconds**. Consistent internally if all consumers use FlowMap types. |
| TS8 | **Med** | Trade time warping (`crypcodile_replay.py:379`): maps trade ns into book span — intentional, but then `Trade.timestamp` is **synthetic** not original exchange time. |
| TS9 | **Low** | `core/__init__.py:146-148` | `now()` docstring says “monotonic” but uses `time.time()` (wall clock, not `time.monotonic()`). |

### Bug hypotheses — time

- **H-TS1** Overlay fade/`max_age` and latency depend on wall clock; pause during replay still ages bubbles.
- **H-TS2** If any path feeds ms into `timestamp` without `/1000`, axis and `fromtimestamp` show year ~50000+ or incorrect.
- **H-TS3** `_timestamp_history` may mix 0, historical seconds, and wall-clock depending on receive fields.

---

## 5. Side / aggressor sign conventions

### Defined model

```12:42:flowmap/core/__init__.py
class Side(Enum):
    BID, ASK, BUY, SELL  # book sides + trade aggressor

def is_buy_side(side):  # BUY or BID
def is_sell_side(side):  # SELL or ASK
```

`Trade.side` documented as aggressor BUY/SELL (`core/__init__.py:82`).  
Order book correctly uses `is_buy_side` for absorption (`order_book.py:176,227`).

### Inconsistencies

| ID | Severity | Location | Behavior |
|----|----------|----------|----------|
| S1 | **High** | `ui/pulse.py:219,238` | `delta = size if side == Side.BUY else -size` — **BID counted as sell**; unknown sides → sell. |
| S2 | **High** | `ui/overlays/cvd.py:80` | Same strict `Side.BUY` only. |
| S3 | **High** | `ui/bubbles.py:111-125` | BUY→buy_size; else sell_size on merge; new bubble: SELL-only for sell_size — **BID/ASK/unknown → zero both sizes** on create path for non-BUY/SELL. |
| S4 | **Med** | `plugins/plugin_api.py:280-283` | Only `Side.BUY` / `Side.SELL` update CVD volumes; BID/ASK ignored (delta 0). |
| S5 | **Med** | `ui/heatmap_widget.py:1625,1785,1875` | Uses `is_buy_side` (good); liquidations at `1687` use `== Side.SELL` only. |
| S6 | **Med** | `data/crypcodile_replay.py:77-83` | Unknown / None side → **default `Side.BUY`** (bullish bias of CVD). |
| S7 | **Med** | `data/crypto.py:82` | Unknown side → `Side.BUY` via `.get(..., Side.BUY)`. |
| S8 | **Med** | `crypcodile_replay.py:58-68` | Maps buy/sell **and** bid/ask for trades; book deltas use BID/ASK. `_CRYP_SIDE_TO_FLOWMAP_SIDE` maps buy→BID for books — correct for L2, dangerous if applied to trades. |
| S9 | **High** | Dynamic trade align `crypcodile_replay.py:455-461` | `"buy" in side_str` → snap to best ask; `"sell"` → best bid. Substring match; empty side → mid. **Does not use FlowMap Side enum.** Aggressor semantics OK if strings correct; `"buyer"` false positives? `"buy" in "buy"` OK. |
| S10 | **Med** | Dual CVD sources: OrderBook net volume (BUY−SELL via is_buy_side) vs Pulse/CVD overlay (strict BUY). **Can diverge** if BID ever appears on trades. |
| S11 | **Low** | `main_window.py:1091` | Side string: treats `1` and `"buy"` as BUY — ad hoc. |

### Bug hypotheses — side

- **H-S1** Any feed that tags trades as BID/ASK (maker side or book side) will **invert or zero** CVD in pulse/overlay while order_book CVD stays correct (or vice versa).
- **H-S2** Default-to-BUY on unknown side systematically **overstates buy CVD**.
- **H-S3** Replay price alignment side string parse can mis-snap trade prices → wrong absorption + wrong bubble color if side still buy/sell.

---

## 6. Volume / size numeric edge cases

| ID | Severity | Location | Issue |
|----|----------|----------|--------|
| V1 | **Med** | `order_book.py:89-91` | `size <= 0` removes level; tiny positive float dust remains forever. Trade path uses `<= 0.000001` pop — **inconsistent thresholds**. |
| V2 | **Med** | `density_engine.py:334-336`, active masks `> 0.01` | Sub-0.01 size levels invisible on heatmap (bad for small-lot symbols / after size unit change). |
| V3 | **Med** | `source_manager.py:388-397` | bid/ask **refs** hard-coded per symbol family; wrong symbol → washed-out or clipped colors. Adaptive normalizer EMA may recover slowly. |
| V4 | **Low** | `normalizer.py:37-44` | p98 of empty-ish columns skipped; first non-zero can jump ref. |
| V5 | **Med** | `order_book.py:438-451` | Prune ±15% of mid: for low mid or crossed book, aggressive cull; mid from best bid/ask only. |
| V6 | **Low** | `volume_profile.py:322-325` | `max_cob = max(..., 1.0)` floors normalization — tiny books look huge relative to 1.0 floor (actually smaller bars). |
| V7 | **Med** | Replay **price_shift** average book − average trade (`crypcodile_replay.py:317-327`) then dynamic BBO snap — can move trades onto wrong levels by large offsets if books/trades from different regimes. |

---

## 7. Integer cast / overflow / row mapping

| ID | Severity | Location | Issue |
|----|----------|----------|--------|
| I1 | **Med** | `density_engine.py:305,313` | `astype(np.int32)` on row indices; absurd `price/tick` (wrong tick or bad price) → int32 overflow wrap → random pixels. |
| I2 | **Med** | `density_engine.py:172-176` | `col_idx is not None` draws **before** center/mid centering block; if `center_price_ticks is None`, `+ None` → TypeError or wrong. |
| I3 | **Low** | Color LUT index clip to 0..255 — safe. |
| I4 | **Low** | `heatmap_widget.py:303` `round(price / render_tick_size)` Python int — same boundary issues as np.round. |

---

## 8. Float equality elsewhere (non-price)

| ID | Location | Note |
|----|----------|------|
| E1 | `BBO.__post_init__` `spread == 0.0` | Only auto-fills spread if exactly 0; explicit 0 with valid bid/ask recomputed — OK. |
| E2 | `density_engine.py:230` `abs(float_center - mid) < 1.0` | Tick units; OK-ish. |
| E3 | `normalizer` `p98 > 0.01` | Absolute size threshold, not symbol-aware. |

---

## 9. Cross-cutting high-priority bug hypotheses (for Phase 2)

1. **H-T6 / H-T3 (P0):** Historical price line uses `tick_size` not `render_tick_size` — `ui/heatmap_widget.py:1408-1419`.
2. **H-N1 (P0):** NaN CVD from `get_volume_delta` before first trade — `order_book.py:351-353` → `main_window.py:958`.
3. **H-T1 (P0):** One-shot min-gap tick detection locks wrong tick — `density_engine.py:119-131`.
4. **H-F1 (P1):** Trade-to-book match epsilon `5e-5` not tick-relative — `order_book.py:184+`.
5. **H-S1/S2 (P1):** CVD/pulse/bubbles ignore `is_buy_side` / default BUY — multiple UI + data files.
6. **H-TS1 (P1):** Trade overlays stamp wall-clock not event time — `heatmap_widget.py:425`.
7. **H-T5 (P1):** Symbol→ticks_per_row/ref heuristics fragile — `source_manager.py:369-403`.
8. **H-F2 (P1):** `round(price, 6)` profile binning — `volume_profile.py`.
9. **H-F3 (P2):** DOM BBO `abs < 0.001` — `dom_ladder.py:226-227`.
10. **H-V7 (P2):** Replay price alignment can fabricate trade prices — `crypcodile_replay.py:317-472`.
11. **H-I2 (P2):** `_draw_column` with unset center — `density_engine.py:172-176`.
12. **H-TS9 (P3):** `now()` is not monotonic — `core/__init__.py:146-148`.

---

## 10. Defensive patterns already present (not bugs)

- AdaptiveNormalizer: `nan_to_num`, `max(ref, 1e-9)`.
- Density blend: `ref + 1e-9`.
- Simulator: `_safe_tick`, `_safe_base`.
- CVD UI range pad when `val_range < 0.01`.
- Replay: `total_span <= 0` reject; `t_span > 0` for scale; speed-gated sleep.
- OrderBook imbalance / BookLevel imbalance zero-total guards.
- CCXT and Crypcodile both convert to **seconds** for core timestamps (unit policy is clear; enforcement is not).

---

## 11. Suggested Phase 2 test matrix (numeric)

| Case | Expect |
|------|--------|
| Symbol tick 0.1, 1.0, 0.00001, 0.05 | Correct row spacing; no lock to sparse gap |
| `ticks_per_row` ∈ {1,10,100} | Heatmap, BBO markers, **history lines**, VWAP Y all align |
| Zero trades then paint | CVD 0 not NaN; status not `nan` |
| Trade price off book by 1e-10 vs 1 tick | Absorption uses tick-relative epsilon |
| Side ∈ {BUY, SELL, BID, ASK, None} | Consistent CVD sign via `is_buy_side` |
| Timestamp ms accidentally | Detect/reject or convert once |
| Replay pause 10s | Bubbles should not all expire if age is event-based (today they will) |
| Empty book / one-sided BBO | mid=0, no div-by-zero, no crash on center |
| Very small sizes (<0.01) | Visibility policy explicit, not silent drop |

---

## 12. File index (primary touch points)

| Area | Paths |
|------|--------|
| Core numeric | `core/order_book.py`, `core/__init__.py` |
| Engine | `engine/density_engine.py`, `engine/normalizer.py`, `engine/color_system.py` |
| Data | `data/crypto.py`, `data/crypcodile_replay.py`, `data/crypcodile_live.py`, `data/simulator.py` |
| UI map | `ui/heatmap_widget.py`, `ui/heatmap/heatmap_renderer.py` |
| Overlays | `ui/overlays/{cvd,vwap,volume_profile}.py`, `ui/pulse.py`, `ui/bubbles.py`, `ui/dom/dom_ladder.py` |
| Config by symbol | `ui/source_manager.py` |
| Plugins | `plugins/plugin_api.py` |

---

*End R17 — Phase 1 numerical / market-data edge-case research.*
