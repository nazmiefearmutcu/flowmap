# FlowMap — M1 (Server Core) Verification

**Date:** 2026-07-18 · **Branch:** `v2` · **Scope:** M1 server core (Tasks 1–11)

M1 delivers the headless Python gateway: config, binary wire protocol (golden-vector
contract for the M2 client), time-weighted density grid with epochs, deterministic sim feed,
session layer (snapshot + backpressure + lifecycle), FastAPI binary WS + REST, the Crypcodile
live-crypto bridge, and parquet self-recording with restart rehydration. Every task went
through implementer → spec-compliance review → code-quality review, with independent
byte-level / numerical / adversarial probes at each gate.

## Automated suite

```
$ cd server && uv run pytest -q
128 passed in 4.66s
```

Breakdown of the load-bearing suites: wire golden vectors + error paths, grid (31 — incl.
time-weight-invariance-across-cadence, gap cap, re-anchor, preload), sim feed (10 — determinism,
liquidity walls), session (25 — snapshot/backpressure/dedup/lifecycle/crash-backoff), session
recording (6), record (14 — round-trip/retention/corrupt-tolerance), REST (9), WS e2e (4 — incl.
the 1013 session-limit refusal), crypto bridge (10 — fixture-driven, real connector path).

## Live verification through the full server path

Real uvicorn server (`python -m flowmap_server`, loopback-only) driven by `scripts/ws_probe.py`
over the binary WebSocket — the complete path WS → SessionManager → feed → Grid → columns.

### Sim session (deterministic feed)

```
$ uv run python scripts/ws_probe.py --market sim --symbol SIM-DEMO --duration 10
--- sim:SIM-DEMO after 10s ---
  Trade            482
  DepthColumn      191
  BarColumn        191
  Ping             9
  Hello            1
  EpochStart       1
  epochs seen:        [0]
  finalized col_seq:  0..151  (partials=39)
  gap markers:        0
  decode errors:      0
PROBE PASS  (EXIT=0)
```

### Live Binance BTCUSDT (real market data, full server path)

```
$ uv run python scripts/ws_probe.py --market binance-spot --symbol BTCUSDT --duration 30
--- binance-spot:BTCUSDT after 30s ---
  BBO              1591
  DepthColumn      290
  BarColumn        290
  Trade            184
  Ping             29
  EpochStart       2
  Hello            1
  epochs seen:        [0, 1]
  finalized col_seq:  0..114  (partials=175)
  first final t0_ns:  1784323744250000000
  last column t0_ns:  1784323773000000000
  gap markers:        0
  decode errors:      0
PROBE PASS  (EXIT=0)
```

**Note the `epochs seen: [0, 1]`** — a grid re-anchor fired live as BTC's mid drifted out of
the central band, and both epochs' `EpochStart` params were announced over the wire. The
multi-epoch machinery (Grid re-anchor → per-epoch params table → snapshot/stream EpochStart)
is proven end-to-end against real market data, not just in unit tests.

The T9 fixture-plus-live evidence stands alongside this: commit `3f6ea77`'s body records a
30 s direct-`CryptoFeed` smoke (29 two-sided books, 142 trades, spread 0.01, exit 0), and the
T9 review independently reproduced a 20 s run (SMOKE PASS). This probe is the same data flowing
through the entire server rather than the feed in isolation.

### Recording + restart rehydration (spec §8.1)

The Binance session wrote parquet under the data dir:

```
$ find $FLOWMAP_DATA_DIR/binance-spot/BTCUSDT -name '*.parquet'
.../20260717-21-columns-000000.parquet
.../20260717-21-columns-000003.parquet
.../20260717-21-epochs-000002.parquet
.../20260717-21-trades-000001.parquet
.../20260717-21-trades-000004.parquet
```

Server restarted (fresh process, **same** data dir), then probed again:

```
$ uv run python scripts/ws_probe.py --port 8722 --market binance-spot --symbol BTCUSDT --duration 10
--- binance-spot:BTCUSDT after 10s ---
  ... EpochStart 2, Hello 1, Marker 1 ...
  epochs seen:        [0, 1]
  finalized col_seq:  0..184  (partials=60)
  first final t0_ns:  1784323744250000000   <-- identical to the PRE-restart run's first t0
  last column t0_ns:  1784323838000000000   <-- later than pre-restart last (…773…), i.e. live continued
  gap markers:        1                      <-- the recorded-tail → live boundary marker (§8.1)
  decode errors:      0
PROBE PASS  (EXIT=0)
```

The restarted server's snapshot begins at the **same** `t0` as the original run (the ring was
rehydrated from the recording via `load_tail` → `Grid.preload`), inserts exactly one
`Marker{kind=gap}` at the recorded-tail/live boundary, preserves both recorded epochs, and then
continues with live columns. This is the §8.1 "rehydrate if fresher than a ring span, else cold
start + gap" contract, verified against a real cross-restart recording.

## M1 acceptance criteria → evidence

| Plan Task 11 criterion | Evidence |
|---|---|
| Full suite green | 128 passed (above) |
| Real server boots + serves binary WS | health 200; both probes connect and decode cleanly |
| Hello / EpochStart / DepthColumn(final) / BarColumn / Ping all present, no decode errors | both probe histograms; 0 decode errors |
| Strictly increasing finalized col_seq + partial/final transitions | sim `0..151` (39 partials); binance `0..114` (175 partials) |
| Live crypto through the full path (not just the feed) | binance-spot BTCUSDT probe, real BBO/Trade/DepthColumn |
| Multi-epoch (re-anchor) end-to-end | `epochs seen: [0, 1]` fired live |
| HistoryRequest → HistoryResponse | `tests/api/test_ws_e2e.py::test_subscribe_live_stream_and_history` |
| Malformed frame → clean 1002 close, server survives | `test_malformed_frame_closes_1002`; T8 review lying-plen probes |
| Session limit → Status + 1013 | `test_session_limit_second_key_gets_status_and_1013` |
| Recording written for a live session | parquet listing above |
| Restart rehydration + gap marker | restart probe: identical first-t0, 1 gap marker, live continues |
| Clean shutdown | SIGINT → "Finished server process", rc 0 |

## Known follow-ups (non-blocking, carried to later milestones)

- **aiohttp "Unclosed client session" on shutdown**: the Crypcodile connector's REST session
  is not awaited during SIGINT teardown. Cosmetic (process exits cleanly); tidy in M-crypto
  hardening.
- **CryptoFeed internal queue is unbounded** (T9 review Minor): add `maxsize` + BookState
  coalesce for a stalled consumer.
- **`binance-usdm` aggTrade** delivered zero frames from this network location (venue/geo, not a
  bridge bug); the usdm trade/liquidation path is fixture-proven.
- Recording epoch files are retention-exempt (bounded-in-practice, documented in `record.py`).

## M1 status: COMPLETE

The gateway serves a live, correct, professional order-flow stream for both the sim and real
crypto markets over the binary protocol the M2 WebGL2 client will consume, with self-recording
and restart rehydration proven end-to-end. Next: **M2 — client GL renderer** (tile-array +
sum-mips + residency, the §10 60 fps perf gates on the sim feed).
