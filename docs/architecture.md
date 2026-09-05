# FlowMap architecture

FlowMap is three processes (or two, when you run from source without the desktop shell):

1. **Tauri 2 shell** (`app/`, Rust) — spawns the sidecar on a free loopback port, injects
   `window.__FLOWMAP_SERVER__` into the webview, terminates the sidecar on quit
   (SIGTERM → SIGKILL). See [app/README.md](../app/README.md).
2. **Client** (`client/`) — React 18 + TypeScript + WebGL2. In dev, vite serves it on `:5173`
   and proxies `/api` and `/ws` to `:8720` (see `client/vite.config.ts`). In the packaged app,
   the same client is bundled static assets.
3. **Server** (`server/`) — Python 3.13, FastAPI + uvicorn, one asyncio event loop, bound to
   `127.0.0.1:8720` (non-loopback `FLOWMAP_HOST` is rejected at startup).

```
WebView (client) --HTTP /api/*--> FastAPI REST --\
                 --WS    /ws  --> WS handler ----+--> SessionManager --> Feed router
                                                        |          |           \
                                                   density grid  recorder   feeds:
                                                        |          |          sim / crypto / equity / replay
                                                   (f32 columns)  parquet        |
                                                                                v
                                                              venue public REST/WS (outbound)
```

## HTTP surface

All routes are unauthenticated, loopback-only, and read in-memory state only (no network in a
request handler):

| Route | Purpose | Source |
|---|---|---|
| `GET /api/health` | Liveness + operational snapshot: status, version, wire protocol version, uptime, recording enabled, active sessions with feed kind and live/degraded state | `api/rest.py` |
| `GET /api/symbols` | Merged symbol directory, filtered by `?q=` substring | `api/rest.py` |
| `GET /api/venues` | Subscribable venue list | `api/discovery.py` |
| `GET /api/universe` | Full bundled universe (same source as `/api/symbols`) | `api/discovery.py` |
| `GET /api/movers`, `GET /api/quote` | Network-cached market data for the symbol palette | `api/discovery.py`, `api/market_cache.py` |
| `WS /ws` | The binary event stream | `api/ws.py` |

## Wire protocol (`server/src/flowmap_server/proto/wire.py`, mirrored in `client/src/proto/decode.ts`)

**Envelope.** Every message starts with an 8-byte little-endian header
`struct.pack("<BBHI", msg_type, PROTO_VER, flags, payload_len)` (`PROTO_VER = 1`).
`FLAG_JSON (0x0001)` marks a *cold* message (UTF-8 JSON via msgspec); without it the payload is
hand-packed little-endian binary (*hot* messages). The payload is zero-padded to the next 4-byte
boundary; `payload_len` is always the **unpadded** length, so readers advance by
`8 + ceil4(payload_len)`. The padding rule keeps every message start 4-byte aligned, which puts a
`DEPTH_COL`'s f32 arrays at absolute offset 32 inside the message — aligned for zero-copy
`Float32Array` views on the client.

**Message kinds.** Tags `0x01–0x3F` are data, `0x40–0x7F` control:

| Tag | Name | Dir | Payload |
|---|---|---|---|
| `0x01` | `HELLO` | S→C | cold JSON: protocol/session id, grid epoch + `EpochParams` (tick, `dt_ns`, `p0`, rows), capability map, norm seed |
| `0x02` | `EPOCH_START` | S→C | cold JSON: grid epoch re-basing |
| `0x03` | `DEPTH_COL` | S→C | hot: `<IIqBBHI>` header (epoch, col_seq, t0_ns, mode, final, pad, n_rows) + bid `f32[n]` + ask `f32[n]` |
| `0x04` | `BAR_COL` | S→C | hot: epoch/col_seq/t0_ns + OHLC + vol_buy/sell + cvd_cum + VWAP numerators/denominator |
| `0x05` | `TRADE` | S→C | hot: ts_ns, price, size, side, side_src + length-prefixed venue string |
| `0x06` | `BBO` | S→C | hot: ts_ns + bid/ask px and sz |
| `0x07` | `MARKER` | S→C | cold JSON: liquidation / `gap` events |
| `0x08` | `STATUS` | S→C | cold JSON: degraded/error states |
| `0x09`/`0x47` | `PING`/`PONG` | both | hot: send timestamps for RTT |
| `0x0A` | `HISTORY_RESP` | S→C | hot: header (req_id, epoch, oldest_available_t_ns, four u16 counts) + that many nested complete messages |
| `0x40`–`0x46` | `SUBSCRIBE`, `UNSUBSCRIBE`, `SEEK`, `SET_SPEED`, `PAUSE`, `RESUME`, `HISTORY_REQ` | C→S | cold JSON |

**Depth tiles are f32, not f16.** A `DEPTH_COL` carries one grid column: `mode` is `L2` (true
two-sided book density), `L1_BAND`, or `SYNTH_PROFILE` (keyless equity — bid side only, the ask
array is omitted by protocol and its presence is an encoder error). Malformed input of any kind
raises a `ValueError`; unknown msg_types are skipped via `payload_len` (forward compatibility).

**History is requested in pages.** The client asks for at most `HISTORY_PAGE_COLS = 256` columns
per `HISTORY_REQ` (mirroring the server's `HISTORY_MAX_COLS` clamp) and keeps a residency budget,
evicting far-behind columns as it pages (`client/src/net/history.ts`). The server answers with a
single `HISTORY_RESP` whose nested messages are ordinary full envelopes — decoders validate that
declared counts cannot overrun the payload.

**Cross-language lockstep.** Fixed golden vectors (no randomness, no clock reads) are frozen as
`.bin` files; the Python encoder and the TypeScript decoder must agree byte-for-byte
(`wire.golden_fixture_events()`).

## Sessions, grid, and the feed router

`SUBSCRIBE {market, symbol, mode, source, start_t}` is routed by
`feeds/router.py::build_feed` with the market grammar:

- `sim` — the deterministic `SIM-DEMO` feed (no network; paced to wall time in the server).
- `<exchange>[-<segment>]` — any crypto venue the Crocodile engine reaches: hand-written
  incremental-L2 connectors (binance, bybit, coinbase, deribit, okx) and a universal
  re-read-whole-book connector for every other ccxt venue id. The segment picks a venue market
  (`binance-usdm`).
- `equity` — tier auto-selected from config: keyless two-sided SYNTH (Yahoo 1 m bars), or keyed
  Alpaca IEX L1 / Finnhub tape when credentials are present in the environment.

An unknown market raises `NotImplementedError`, which the WS layer turns into close code `1003`.

The `SessionManager` owns one session per `(market, symbol, mode, source, band)` key (bounded by
`FLOWMAP_MAX_SESSIONS`). Each session drives its feed into the **density grid**
(`core/grid.py`): a fixed-price-row, time-column ring (`FLOWMAP_RING_COLUMNS`) of time-weighted
bid/ask density, finalized column by column. Finalized columns are emitted as `DEPTH_COL`s,
recorded, and (on reconnect) re-seeded. A `Hello` on subscribe carries the epoch parameters and
the capability map the UI renders as badges — capabilities are read off the actual feed, so the
badge cannot claim more than the stream delivers.

## Recording and replay lifecycle (`core/record.py`, `feeds/replay.py`, `core/session.py`)

- **Recording** is enabled by default (`FLOWMAP_RECORDING_ENABLED=0` disables it). A
  `SessionRecorder` writes hourly part-files per event kind:
  `~/.flowmap/recordings/{market}/{symbol}/{YYYYMMDD-HH}-{kind}-{part:06d}.parquet` (overridable
  via `FLOWMAP_DATA_DIR`). Writes go through polars; a flush renames completed files into place so
  readers never see a truncated part. A global cap (`FLOWMAP_RECORDING_GB_CAP`, default 20 GB)
  deletes the lexicographically oldest parts across all symbols as it fills.
- **Replay** is a feed like any other: `SUBSCRIBE` with `mode: "replay"` (optionally `start_t`)
  builds a `ReplayFeed` over that key's recordings. The transport is driven by the client through
  `SEEK` / `SET_SPEED` / `PAUSE` / `RESUME` (1–100×).
- **Honest replay.** A subscribe to replay when no usable recording exists is refused explicitly —
  never silently served by a live feed under a replay label. And since the 2026-09 upgrade, a
  re-attach to a recording whose recorded tail lingers more than `REPLAY_STALE_TOL_NS`
  (2 seconds of *recorded* time) behind what was already handed out is refused with
  `Status{degraded}`, WS close `1003`, and a `replay_stale` token carrying both tail positions:
  a stale tail is never presented as valid replay. Where a recorded tail meets a live edge, the
  session inserts a `Marker{kind=gap}` instead of inventing continuity.

## Threading model

The server is one asyncio event loop (uvicorn). Feed I/O, grid finalization, WS fan-out and REST
handlers are all cooperative coroutines on that loop; there is no lock-based sharing. The two
places that must block — replay boot (reading + concatenating parquet parts) and other
polars-heavy work — are offloaded with `loop.run_in_executor(None, ...)` so the loop keeps
servicing pings and live columns. Parquet flushes are small, hourly, and atomic-by-rename.
On the client, the renderer is a single WebGL2 canvas driven by one `requestAnimationFrame`
loop; decoded columns are uploaded once as textures with SUM-mips, so pan/zoom is a uniform
update and its cost does not grow with history depth.
