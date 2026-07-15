# Ralph Frontend Loop — Iteration 1

## Screenshot evidence
- `iter1_before.png` — empty: "No data — Start simulation", status Ready, no chart
- `iter1_after_start.png` — LIVE data: Bid/Ask ~75.81, trade bubbles, CVD green, LLT, icebergs
- `iter1_after_20s.png` — sustained stream

## Root cause (P0)
Python.org 3.13 macOS build has **empty OpenSSL CA store** → `SSLCertVerificationError` on Binance WS → live never delivers → UI stuck empty.

## Fixes applied
1. `flowmap/ssl_bootstrap.py` — certifi CA bootstrap + `make_ws_transport`
2. `run_flowmap.py` / `main.py` — early bootstrap
3. `crypcodile_live.py` — SSL-aware transport, unlimited reconnect while running
4. Crypcodile `AiohttpWsTransport` — certifi SSL by default, optional `ssl=`
5. Heatmap empty-state surfaces feed/SSL errors (not silent)
6. source_manager error → heatmap message

## Remaining frontend issues (next iterations)
- [ ] DEBUG_RUNNING traceback.print_stack spam on every _running set
- [ ] Missing font family "Inter" (Qt warning)
- [ ] Heatmap density often sparse / dim vs Bookmap expectations
- [ ] Volume profile COB/CVP/SVP mostly empty-looking while live
- [ ] Auto-start / connected-before-user-start semantics unclear
- [ ] Status "No data" on VP panels when book is live

## Promise
Do **not** emit FLOWMAP_FRONTEND_HEALTHY until multiple UI surfaces consistently healthy under screenshot review.
