# FlowMap

**An institutional-grade, dual-market order-flow visualizer — real-time liquidity heatmap, DOM
ladder, time & sales, and order-flow overlays for crypto and US equities, in one renderer.**

FlowMap is a ground-up rebuild of an earlier PyQt6 desktop app that re-rasterized the entire visible
history on the CPU every pan/zoom frame, so scrolling back through history collapsed to ~1 fps.
FlowMap puts history in a WebGL2 texture and makes pan/zoom a pure view transform — **interaction cost
is independent of history depth**. It unifies two market-data engines
([Crypcodile](https://github.com/nazmiefearmutcu/Crypcodile) for crypto,
stockodile for US equities) behind one market-agnostic renderer.

## Highlights

- **60 fps pan/zoom at any history depth.** A column, once uploaded to the GPU, is never
  re-rasterized; pan and both zoom axes only change a uniform. Measured: draw cost is ~0.2 ms
  whether 200 or 10 000 columns are resident (history-independent — the old 1-fps bug is
  structurally gone).
- **Professional order flow:** liquidity heatmap (thermal, with correct SUM-mip zoom-out so
  walls don't dilute), DOM ladder, time & sales tape, trade bubbles, BBO, VWAP, volume profile,
  event markers, crosshair with exact liquidity readout, deep scroll-back, replay transport.
- **Two markets, one renderer, honest tiers:** crypto shows full L2 depth + tick tape; US equities
  show what their free data actually supports — a keyless volume-at-price SYNTH profile (Yahoo 1 m
  bars) that upgrades to Alpaca IEX L1 with zero code change when `ALPACA_API_KEY`/`SECRET` are
  set. Capability badges (`L2` / `L1` / `SYNTH`, `TAPE TICK` / `TAPE POLL`, `SIDE EXCHANGE` /
  `SIDE NA`) are always honest — no fabricated depth.

## Architecture

```
client/   TypeScript + React + WebGL2 renderer (Vite)
          heatmap tile-array + SUM-mips + camera + overlays + DOM/tape + UI shell
server/   Python 3.13 asyncio gateway (FastAPI, binary WebSocket, loopback-only)
          time-weighted density grid + sessions + parquet recording/replay
          feeds/  crypto (Crypcodile) · equity (stockodile) · deterministic sim
```

The client is a pure renderer of a canonical binary stream (`docs/superpowers/specs/`); the server
normalizes every market into that stream + a capability descriptor. See
`docs/superpowers/plans/m1-verification.md`, `m2-verification.md`, `m3-verification.md` for the
verification record (live Binance + live equity evidence, perf gates, parity matrix).

## Run it

Prereqs: Python 3.13 + [uv](https://docs.astral.sh/uv/), Node 22 + npm.

```bash
./scripts/dev.sh          # boots the server (:8720) + the client dev server (:5173)
# then open http://localhost:5173
```

Or manually:

```bash
# terminal 1 — server
cd server && uv sync && FLOWMAP_PORT=8720 uv run python -m flowmap_server
# terminal 2 — client
cd client && npm install && npm run dev
```

In the top-bar symbol search: pick `SIM-DEMO` (deterministic demo feed), a crypto pair
(`BTCUSDT` → live Binance), or a US ticker (`AAPL` → keyless SYNTH profile; live tick during
market hours with Alpaca keys).

**Optional live tiers** (auto-detected from the environment):
`ALPACA_API_KEY` + `ALPACA_API_SECRET` → equity L1 tick tape + quotes; `FINNHUB_API_KEY` → equity
tick tape. Without keys, equities run the honest keyless SYNTH tier.

## Tests

```bash
cd server && uv run pytest -q          # gateway: grid, protocol, sessions, feeds, recording
cd client && npm test && npm run e2e   # renderer units + Playwright (heatmap, perf gate, parity)
```

The Playwright suite includes the §10 performance gate (history-independent frame cost) and the
two-market parity matrix.

## License

Apache-2.0 — see [LICENSE](LICENSE).
