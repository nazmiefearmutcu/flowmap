# Phase 2 — 50 Planning Agent Roster

Each agent writes: `agent_plans/P2-NN_<slug>.md`

## Track A — Core correctness (01–12)
| # | Theme | Zones |
|---|-------|-------|
| 01 | L2 snapshot replace vs delta matrix | Z11 |
| 02 | Crossed book / BBO invariants / prune | Z11 |
| 03 | Side enum exhaustiveness | Z08,Z04 |
| 04 | BookDelta is_snapshot / delta-only books | Z08,Z12 |
| 05 | Trade/liquidation field mapping | Z08,Z04 |
| 06 | CVD NaN + volume delta contract | Z11,Z05 |
| 07 | Density mid-mask & bid/ask projection | Z02 |
| 08 | Buffer scroll + clear-right column | Z02 |
| 09 | One-shot tick detect + ticks_per_row | Z03 |
| 10 | tick_size vs render_tick_size polylines | Z03,Z01 |
| 11 | Normalizer live vs rebuild divergence | Z02 |
| 12 | Color LUT / gamma / stale docs | Z01 |

## Track B — Concurrency & data plane (13–24)
| 13 | Unbounded queue growth model | Z05,Z07 |
| 14 | Drain limit 1000 starvation | Z05 |
| 15 | Snapshot clears updates batching | Z05 |
| 16 | Callback disable on_trade=None | Z05 |
| 17 | Live asyncio + quit/wait teardown | Z06 |
| 18 | Global SSL monkeypatch blast radius | Z06 |
| 19 | Replay blocking slot vs QThread.quit | Z07 |
| 20 | Dual emit path queue vs signals | Z06,Z07 |
| 21 | Source switch disconnect completeness | Z10 |
| 22 | Stale queue after stop/switch | Z10,Z05 |
| 23 | REST polling on GUI thread | Z17 |
| 24 | CCXT book identity stall | Z17 |

## Track C — Rendering & performance (25–34)
| 25 | OpenGL base vs CPU paint | Z01 |
| 26 | Full rebuild_heatmap freeze budget | Z01,Z02 |
| 27 | Throttled deferred rebuild races | Z01 |
| 28 | QImage zero-copy / buffer rebind | Z01 |
| 29 | Resize blank history H15 | Z01,Z02 |
| 30 | Trade deque / percentile hitch | Z04 |
| 31 | Density dict unbounded prices | Z02 |
| 32 | Bubbles/pulse draw cost + side bias | Z04 |
| 33 | DOM refresh vs paint throttle | Z14 |
| 34 | VP row Y vs heatmap row_height | Z14 |

## Track D — Integration & Crypcodile (35–42)
| 35 | Hardcoded sys.path embed fragility | Z12,Z13 |
| 36 | Hist equal-time binning fidelity | Z12 |
| 37 | Gap ≥ bw full wipe semantics | Z12 |
| 38 | Catalog empty/partial channels | Z12 |
| 39 | Replay trade time-warp design | Z09 |
| 40 | Replay price rewrite design | Z09 |
| 41 | SQL symbol injection / quoting | Z13 |
| 42 | Standalone vs embed API drift | Z12 |

## Track E — UX, security, packaging, harness (43–50)
| 43 | Navigation matrix F/scroll/go live | Z16 |
| 44 | Wheel/Ctrl-scroll UX contract | Z16 |
| 45 | Iceberg/LLT false positive design | Z15 |
| 46 | Plugin RCE model before wiring | Z19 |
| 47 | Portable data_dir + no machine paths | Z13,Z20 |
| 48 | PyInstaller console/hiddenimports/UPX | Z20 |
| 49 | Simulator as differential oracle | Z18 |
| 50 | cua-driver GUI matrix | Z01,Z16,Z20 |
