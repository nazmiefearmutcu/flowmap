# Ralph Frontend Loop — Status

**Promise:** `FLOWMAP_FRONTEND_HEALTHY` — **NOT** emitted (loop continues).  
**Mode:** screenshot-first, fix-on-find, max iterations = endless.

## Iteration 1 — P0 empty heatmap / no-data (FIXED)

| Before | After |
|--------|--------|
| `iter1_before.png` — "No data — Start simulation", Ready, no chart | `iter1_after_start.png` — LIVE Bid/Ask, bubbles, CVD, LLT |

**Root cause:** Python.org 3.13 empty OpenSSL CA → Binance WS `SSLCertVerificationError` → zero market data.

**Fix:**
- `flowmap/ssl_bootstrap.py` + early call from `run_flowmap.py` / `main.py`
- certifi SSL on live `AiohttpWsTransport` (FlowMap + Crypcodile)
- unlimited reconnect while Start is active
- heatmap empty-state surfaces SSL/feed errors

## Iteration 2 — CVP/SVP empty bars (FIXED)

| Evidence |
|----------|
| Before: COB only; CVP/SVP blank despite icebergs/trades |
| After: `iter2_vp_fix.png` / `iter2_vp_fix2.png` — yellow CVP POC + cyan SVP POC |

**Root cause:** trade prices (exchange ticks) not binned onto heatmap `render_tick_size` rows → dict lookup miss.

**Fix:** `_bin_price` / `_volume_on_level` in `volume_profile.py` + unit tests.

Also: removed `DEBUG_RUNNING` stderr stack spam.

## Iteration 3 — tab/DOM/toggles (verified OK)

| Surface | Result |
|---------|--------|
| INDICATORS / SETTINGS | renders |
| DOM Ladder enable | live bid/ask ladder with sizes |
| Heatmap toggle off/on | density hides/shows; trades remain |
| Volume Profile toggle | columns hide/show |

Font: Inter → system sans resolve (`get_main_stylesheet`).

## Iteration 3 — heatmap contrast (FIXED)

**Root cause:** `AdaptiveNormalizer` used `ratio ** 2.5` + p98 including walls → mid-book intensity ~0 → near-black heatmap.

**Fix:** gamma 0.55, p90 of non-zero sizes, slightly faster EMA. Tests in `test_normalizer_contrast.py`.

Also: Inter font → resolved system sans in theme + docks/tabs/VP headers.

## Still open (next iterations)

- [ ] Decay slider permanently `n/a` (not implemented) — UX honesty OK, or implement
- [ ] Resting book heatmap left half black until history accumulates (expected?)
- [ ] Crypcodile-embedded FlowMap window parity test
- [ ] Longer soak: density fill after 60s+ live

## Iteration 4 — soak + stop/start

| Metric | Before density fix | After 40s soak |
|--------|-------------------|----------------|
| heatmap bright frac | ~0.03 | **0.24** |
| green/red bands | faint | strong walls + mid |
| Inter font warn | yes | fixed (Segoe UI cascade cleaned) |
| Stop → Start | reconnect works | LIVE resumes |

Evidence: `iter4_soak40s.png`, `iter4_start_exact.png`

## Iteration 5 — replay + a11y

| Issue | Fix / result |
|-------|----------------|
| Enable Replay Mode missing from AX | `setAccessibleName` + objectName — Ghost finds it |
| Replay empty at first screenshot | Was mid-load / accidental stop; after wait bright **0.37** |
| Live→replay `Task was destroyed pending` | Longer thread wait + transport `wait_closed()` |
| QAccessibleTable invalid index spam | still present (table clear race) — open |

Evidence: `iter5_replay_t*.png` (bright climb 0.08→0.38), Enable Replay Mode AX OK.

## Iteration 6 — a11y tables + embedded

| Item | Result |
|------|--------|
| QAccessibleTable on clear/LLT update | `setUpdatesEnabled` + `blockSignals` around churn |
| SSL bootstrap in MainWindow + Crypcodile CLI | embedded inherits certifi path |
| Embedded `FlowmapWindow` live (20s) | bright **0.21**, green/red density present |
| Sans-serif Qt warn | dropped CSS generic from font fallbacks |

Evidence: `iter6_embedded_only.png`, `iter6_embedded_20s.png`, `iter7_fresh_embedded.png` (bright ~0.13 @25s live, no SSL errors, AccessibleTable count 0 in new session)

## Do not complete until

1. Live heatmap + CVD + VP — **met**  
2. No silent SSL empty state — **met**  
3. Toggle surfaces — **met**  
4. Replay path — **met**  
5. Crypcodile-embedded FlowMap — **met** (screenshot)  
6. Longer multi-symbol soak / residual a11y noise — optional  

**Promise still NOT emitted** — endless loop continues hunting residual UI polish.

---

### Checkpoint (screenshot-first)

| Shot | Mode | bright |
|------|------|--------|
| `iter1_before.png` | empty no-data | ~0 |
| `iter4_soak40s.png` | LIVE | ~0.24 |
| `iter5_latest.png` | REPLAY | ~0.39 |
| `iter6_embedded_20s.png` | embedded LIVE | ~0.21 |  

## Screenshot index

```
bug_hunt/frontend_loop/
  iter1_before.png
  iter1_after_start.png
  iter1_after_10s.png / iter1_after_20s.png
  iter2_tab_*.png
  iter2_vp_fix.png / iter2_vp_fix2.png
  iter3_dom_ladder.png
  iter3_heatmap_off.png / on.png
  iter3_vp_hidden.png / final.png
```


## Endless loop re-activated (user: only I may stop)

### Gaps closed this wave
- VP sqrt bar scale + rebin paint cache
- Continuous idle heatmap columns (~20 Hz)
- Symbol switch: clear icebergs/LLT/DOM + window title
- Symbol field returnPressed
- COB footer shows peak depth size
- Empty-state message clear on first levels

### Screenshot proof
- `endless_audit_1.png` — dense SOL live
- `endless_btc_clean.png` — BTC switch, title BTC, icebergs empty, price ~62k

### Do NOT complete
Promise FLOWMAP_FRONTEND_HEALTHY withheld; loop continues.
