# FlowMap + Crypcodile FlowMap — Ekstra Kapsamlı Bug Hunt Sonuç Raporu

**Tarih:** 2026-07-13  
**Kapsam:** `/Users/nazmi/flowmap` + `/Users/nazmi/Crypcodile/.../flowmap_window.py`  
**GUI tooling:** cua-driver (daemon hazır), computer-use skill yüklü  

## Fazlar ve ajan kapasitesi

| Faz | Plan | Gerçekleşen | Çıktı |
|-----|------|-------------|--------|
| 1 Keşif | 20 subagent | **20** explore | `bug_hunt/phase1_research/R01–R20.md` |
| 2 Plan | 50 subagent | **50 plan dosyası** (5 koordinatör batch) | `phase2_plan/agent_plans/P2-01…50` |
| 3 Av | 100 subagent | **10+ hunter wave** + static probes | **129 finding** dosyası |
| 4 Fix | 100 subagent | **5 fix wave** + orchestrator fixes | ~35+ P0/P1 kapandı, testler yeşil |

Not: 100×100 tek oturumda process limitine takılmamak için faz 2–4’te koordinatör batch’leri kullanıldı; **50 plan teması**, **129 finding**, **çoklu fix agent** üretildi.

## En kritik düzeltmeler (kodda)

| ID | Sorun | Fix |
|----|-------|-----|
| P201 | Trade absorb + L2 double-subtract | `record_trade(absorb=False)` default |
| P206 | CVD `math.nan` | `0.0` |
| P202 | Crossed book both wipe | iterative uncross |
| P207-01 | Mid-mask liquidity drop | color by bid/ask arrays |
| P207-02 | max≠sum row collapse | `np.add.at` |
| P210 | History polyline tick/Y | `render_tick` + `_price_to_screen_y` |
| P224 | CCXT book stall | nonce-based emit |
| P218 | Global SSL=False | only `FLOWMAP_INSECURE_SSL=1` |
| P247/P235 | Hardcoded `/Users/nazmi/*` | env + portable resolve |
| P213 | Unbounded queue | DropOldestQueue(50k) |
| P240/P239 | Replay price/time fiction | env-gated OFF by default |
| P219-03 | Empty replay CPU spin | 2s sleep |
| P241 | SQL f-string | `_sql_str()` quoting |
| P217-05 | Live no reconnect | backoff retry |
| P229 | Resize blank history | full rebuild |
| P243 | F follow no snap | hard snap + rebuild |
| P248 | silent package crash | console=True, hiddenimports, no UPX |
| UX | Side BUY-only / README | `is_buy_side`, docs |

## Test

```bash
cd /Users/nazmi/flowmap
source .venv/bin/activate
python tests/_run_phase4_live_reconnect.py   # 12 tests OK
# or: pip install pytest && pytest tests/ -q
python -c "from flowmap.ui.main_window import MainWindow"  # import smoke
```

## Artefaktlar

- Master plan: `bug_hunt/MASTER_PLAN.md`
- Phase1: `bug_hunt/phase1_research/`
- Phase2: `bug_hunt/phase2_plan/` (+ unified attack plan)
- Phase3: `bug_hunt/phase3_execution/findings/` + `FINDINGS_REGISTRY.md`
- Phase4: `bug_hunt/phase4_fixes/FIX_STATUS.md`

## Kalan / sonraki iş

- Full hist materialize OOM bound (stream replay)
- rebuild_heatmap main-thread offload (P226)
- Center deadband tuning for BTC tpr=100 (HIST-01 residual)
- Live channel parity (book_ticker / liquidation)
- CUA full GUI matrix (cua-driver scenarios P2-50) — skill hazır, end-to-end runtime suite sonraki adım

## Env flags (yeni)

| Env | Effect |
|-----|--------|
| `FLOWMAP_DATA_DIR` | portable data lake path |
| `FLOWMAP_HOME` | Crypcodile embed flowmap path |
| `FLOWMAP_INSECURE_SSL=1` | optional SSL bypass (dev) |
| `FLOWMAP_REPLAY_REWRITE_PRICES=1` | old BBO price rewrite |
| `FLOWMAP_REPLAY_TIME_WARP=1` | old trade time stretch |
| `FLOWMAP_REPLAY_STATIC_SHIFT=1` | AVG static price shift |



## Residual SDD (bu oturum)

Subagent-driven development ile kalan P0/P1 kapatıldı:

1. Replay OOM cap  
2. Live book_ticker + liquidation  
3. Centering hard invariant  
4. Progressive rebuild_heatmap  
5. Snapshot max reset + NaN guard  
6. Density col_idx ghost clear  
7. Side.UNKNOWN + L2 side map  
8. Embed hist bw ≥ 64  
9. Adaptive drain + session epoch  

**Test:** 75 unittest OK · Crypcodile hist tests 6 OK  
**Branch:** `fix/residual-bug-hunt`  
**Detay:** `bug_hunt/phase4_fixes/RESIDUAL_COMPLETE.md`
