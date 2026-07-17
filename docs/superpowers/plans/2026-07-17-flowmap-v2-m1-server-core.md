# FlowMap v2 — M1: Server Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running FlowMap v2 gateway server: binary WS protocol with golden vectors, the
time-weighted density grid with epochs, a deterministic sim feed, session management with
backpressure, and the Crypcodile live-crypto bridge — all tested.

**Architecture:** Python 3.13 asyncio gateway (`server/`) per the spec at
`docs/superpowers/specs/2026-07-17-flowmap-v2-bookmap-design.md` (§5, §6, §8.1, §8.2, §11).
Read the spec BEFORE starting any task. Canonical events are msgspec structs in-process,
hand-packed binary on the wire (hybrid: hot messages packed, cold messages JSON-flagged).

**Tech Stack:** Python 3.13, uv, msgspec, numpy, polars, FastAPI+uvicorn, pytest.
Data libraries via `tool.uv.sources` path deps: `/Users/nazmi/Crypcodile`, `/Users/nazmi/stockodile`.

**Working rules for every task:**
- TDD: failing test → minimal impl → pass → commit. Run tests with
  `cd /Users/nazmi/flowmap/server && uv run pytest <path> -x -q`.
- Commit prefix `feat(server):` / `test(server):` etc. NEVER add a Claude co-author trailer.
- The Opsera pre-commit hook may demand a scan; the approved procedure is:
  `touch /tmp/.opsera-pre-commit-scan-passed` in one Bash call, then `git commit` in a SEPARATE
  Bash call (flag is consumed per commit).
- All server code lives under `/Users/nazmi/flowmap/server/src/flowmap_server/`.

---

### Task 1: Upstream dep split — `crypcodile[core]`

**Files:**
- Modify: `/Users/nazmi/Crypcodile/pyproject.toml`
- Test: shell verification (import smoke in a scratch venv)

The server must not install PyQt6/streamlit/xgboost/web3/matplotlib/scipy/pyqtgraph. Move them
to optional groups; keep the core streaming set mandatory.

- [ ] **Step 1: Edit pyproject.toml.** In `[project] dependencies`, KEEP ONLY:
  `msgspec`, `websockets`, `aiohttp`, `certifi`, `polars`, `pyarrow`, `duckdb`, `numpy`,
  `typer`, `rich` (retain each entry's existing version pins verbatim). MOVE every other
  current entry (`PyQt6`, `pyqtgraph`, `streamlit`, `web3`, `fastapi`, `uvicorn`, `xgboost`,
  `scipy`, `matplotlib`, plus anything else non-core) into
  `[project.optional-dependencies]` groups: `gui = [PyQt6, pyqtgraph, matplotlib]`,
  `ml = [xgboost, scipy]`, `web = [fastapi, uvicorn, streamlit]`, `onchain = [web3]`,
  and `full = ["crypcodile[gui,ml,web,onchain]"]`. Preserve pins verbatim.
- [ ] **Step 2: Verify core import without heavy deps.**
  Run: `cd /Users/nazmi/Crypcodile && uv venv /tmp/cc-core-test --python 3.13 -q && VIRTUAL_ENV=/tmp/cc-core-test uv pip install -q -e . && /tmp/cc-core-test/bin/python -c "from crypcodile.exchanges.factory import make_connector; from crypcodile.client.collect import collect; from crypcodile.sink.base import Sink; from crypcodile.instruments.registry import InstrumentRegistry; from crypcodile.schema.records import Trade, BookDelta, BookSnapshot; print('CORE IMPORT OK')"`
  Expected: `CORE IMPORT OK`. If an import in that chain pulls a heavy module at import time
  (e.g. `crypcodile/__init__.py` touching xgboost/PyQt6), fix it upstream: guard the offending
  import (`try/except ImportError` or move it into the function that needs it) — the
  `sys.modules["xgboost"] = MagicMock()` hack in `__init__.py` must be REMOVED and replaced with
  a lazy import inside whatever analytics module needed it (find with
  `grep -rn "xgboost" src/crypcodile/ --include='*.py'`).
- [ ] **Step 3: Run crypcodile's own core test subset to prove no regression.**
  Run: `cd /Users/nazmi/Crypcodile && uv run pytest tests/exchanges tests/ingest tests/replay -x -q --timeout 120`
  Expected: PASS (pre-existing failures unrelated to your edit are acceptable ONLY if
  `git stash && uv run pytest <same> && git stash pop` shows they fail identically before the edit).
- [ ] **Step 4: Commit in /Users/nazmi/Crypcodile** —
  `git add pyproject.toml src/crypcodile/__init__.py && git commit -m "build: split optional dependency groups (core/gui/ml/web/onchain)"`
  (plus any lazy-import files). Same Opsera two-call procedure if the hook fires.

### Task 2: Upstream dep split — `stockodile[core]` + Quote forwarding groundwork check

**Files:**
- Modify: `/Users/nazmi/stockodile/pyproject.toml`
- Test: shell verification

- [ ] **Step 1: Edit pyproject.toml.** KEEP in `[project] dependencies`: `msgspec`, `polars`,
  `pyarrow`, `duckdb`, `websockets`, `aiohttp`, `certifi`, `typer`, `rich`, `yfinance`,
  `beautifulsoup4`, `numpy` (pins verbatim). MOVE to optional groups: `onchain = [web3]`,
  `web = [fastapi, uvicorn]`, `full = ["stockodile[onchain,web]"]`.
- [ ] **Step 2: Verify core import.**
  Run: `cd /Users/nazmi/stockodile && uv venv /tmp/sk-core-test --python 3.13 -q && VIRTUAL_ENV=/tmp/sk-core-test uv pip install -q -e . && /tmp/sk-core-test/bin/python -c "from stockodile.client.collect import collect; from stockodile.providers.factory import make_provider; from stockodile.schema.records import Trade, Quote, TradingStatus; from stockodile.scheduler.calendar import USMarketCalendar; from stockodile.sink.base import Sink; print('CORE IMPORT OK')"`
  Expected: `CORE IMPORT OK`. Apply the same lazy-import fixes upstream if web3/fastapi leak
  into that import chain (grep first: `grep -rn "import web3\|from web3" src/stockodile/`).
- [ ] **Step 3: Run stockodile provider tests.**
  Run: `cd /Users/nazmi/stockodile && uv run pytest tests/providers tests/store -x -q --timeout 120`
  Expected: PASS (same pre-existing-failure rule as Task 1).
- [ ] **Step 4: Commit in /Users/nazmi/stockodile** —
  `git commit -m "build: split optional dependency groups (core/onchain/web)"`.

### Task 3: Server scaffold

**Files:**
- Create: `/Users/nazmi/flowmap/server/pyproject.toml`
- Create: `/Users/nazmi/flowmap/server/src/flowmap_server/__init__.py` (`__version__ = "2.0.0a0"`)
- Create: `/Users/nazmi/flowmap/server/src/flowmap_server/config.py`
- Create: `/Users/nazmi/flowmap/server/tests/test_config.py`

- [ ] **Step 1: Write pyproject.toml:**

```toml
[project]
name = "flowmap-server"
version = "2.0.0a0"
requires-python = ">=3.13"
dependencies = [
  "crypcodile",
  "stockodile",
  "msgspec>=0.18",
  "numpy>=1.26",
  "polars>=1.0",
  "fastapi>=0.111",
  "uvicorn>=0.30",
]

[dependency-groups]
dev = ["pytest>=8", "pytest-asyncio>=0.23", "pytest-timeout>=2", "httpx>=0.27", "websockets>=12"]

[tool.uv.sources]
crypcodile = { path = "/Users/nazmi/Crypcodile", editable = true }
stockodile = { path = "/Users/nazmi/stockodile", editable = true }

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/flowmap_server"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
timeout = 60
testpaths = ["tests"]
```

- [ ] **Step 2: Write failing test `tests/test_config.py`:**

```python
import os
from flowmap_server.config import Config

def test_defaults():
    cfg = Config.from_env({})
    assert cfg.host == "127.0.0.1"          # spec §11: loopback only, asserted
    assert cfg.port == 8720
    assert cfg.ring_columns == 32_768
    assert cfg.max_sessions == 4
    assert cfg.recording_gb_cap == 20.0
    assert cfg.recording_enabled is True
    assert cfg.alpaca_key is None

def test_env_overrides_and_loopback_assertion():
    cfg = Config.from_env({"FLOWMAP_PORT": "9001", "ALPACA_API_KEY": "k", "ALPACA_API_SECRET": "s"})
    assert cfg.port == 9001 and cfg.alpaca_key == "k"
    import pytest
    with pytest.raises(ValueError):
        Config.from_env({"FLOWMAP_HOST": "0.0.0.0"})   # refuses non-loopback
```

- [ ] **Step 3: Run to verify failure** — `uv run pytest tests/test_config.py -x -q` → import error.
- [ ] **Step 4: Implement `config.py`** — frozen msgspec Struct or dataclass `Config` with
  exactly those fields plus `finnhub_key`, `dt_crypto_ns=250_000_000`, `dt_equity_keyed_ns=10**9`,
  `dt_equity_keyless_ns=10 * 10**9`, `max_rows=4096`; `from_env(env: Mapping[str,str])`
  classmethod; raise `ValueError` for any `FLOWMAP_HOST` not in `("127.0.0.1", "localhost")`.
- [ ] **Step 5: `uv sync` then run tests** — `cd /Users/nazmi/flowmap/server && uv sync -q && uv run pytest -x -q` → PASS.
  This also proves the path-dep resolution of Tasks 1–2 works (heavy deps ABSENT: verify with
  `uv pip list | grep -iE 'pyqt6|xgboost|streamlit|web3' | wc -l` → `0`).
- [ ] **Step 6: Commit** (flowmap repo, branch v2) — `git add server/ && git commit -m "feat(server): scaffold flowmap-server with core-only data-lib deps"`.

### Task 4: Canonical events + wire protocol + golden vectors

**Files:**
- Create: `server/src/flowmap_server/proto/__init__.py`
- Create: `server/src/flowmap_server/proto/events.py`
- Create: `server/src/flowmap_server/proto/wire.py`
- Create: `server/tests/proto/test_wire.py`
- Create: `server/tests/proto/golden/` (generated vector files)

**Contract (spec §6):** envelope `struct.pack("<BBHI", msg_type, PROTO_VER, flags, payload_len)`
(8 bytes). `FLAG_JSON = 0x0001` → payload is UTF-8 JSON (cold messages: Hello, EpochStart,
Status, Marker, Subscribe/Unsubscribe/Seek/SetSpeed/Pause/Resume, HistoryRequest).
Hot messages are packed little-endian, payload padded to a multiple of 4 bytes:

```
MsgType (u8): HELLO=0x01 EPOCH_START=0x02 DEPTH_COL=0x03 BAR_COL=0x04 TRADE=0x05 BBO=0x06
              MARKER=0x07 STATUS=0x08 PING=0x09 HISTORY_RESP=0x0A
              SUBSCRIBE=0x40 UNSUBSCRIBE=0x41 SEEK=0x42 SET_SPEED=0x43 PAUSE=0x44 RESUME=0x45
              HISTORY_REQ=0x46 PONG=0x47

DEPTH_COL payload: <IIqBBHI> epoch, col_seq, t0_ns, mode(0=L2,1=L1_BAND,2=SYNTH_PROFILE),
                   final(0|1), _pad(u16)=0, n_rows  → then bid f32×n_rows, ask f32×n_rows
                   (ask omitted when mode==SYNTH_PROFILE)
BAR_COL payload:   <IIq> epoch, col_seq, t0_ns → <dddd> o,h,l,c → <ddddd> vol_buy, vol_sell,
                   cvd_cum, vwap_num_cum, vwap_den_cum
TRADE payload:     <qddBBBB> ts_ns, price, size, side(0=buy,1=sell,2=unknown),
                   side_src(0=exchange,1=inferred,2=na), _pad, _pad → venue as u8-len + utf8, pad to 4
BBO payload:       <qdddd> ts_ns, bid_px, bid_sz, ask_px, ask_sz
PING/PONG payload: <q> ns  /  <qq> echo_ns, client_recv_ns
HISTORY_RESP:      <IIq> req_id, epoch, oldest_available_t_ns, then u16 counts
                   (n_depth, n_bar, n_marker, n_trade) + that many nested full messages
                   (each with its own envelope) concatenated
```

`events.py` defines the msgspec Structs mirroring spec §6.1 (in-process only). `wire.py` exposes
`encode(event) -> bytes` (envelope+payload) and `decode(buf, offset) -> (event, next_offset)`;
unknown msg_type skips via payload_len and returns `(None, next_offset)`.

- [ ] **Step 1: Write failing tests** — `tests/proto/test_wire.py`:

```python
import struct
from flowmap_server.proto import wire, events

def test_envelope_layout():
    ev = events.Ping(server_send_ns=123)
    buf = wire.encode(ev)
    t, ver, flags, plen = struct.unpack_from("<BBHI", buf, 0)
    assert (t, ver) == (0x09, wire.PROTO_VER) and plen == len(buf) - 8

def test_depth_col_roundtrip_and_alignment():
    import numpy as np
    ev = events.DepthColumn(epoch=1, col_seq=7, t0_ns=10**18, mode=0, final=True,
                            bid=np.arange(8, dtype=np.float32), ask=np.ones(8, dtype=np.float32))
    buf = wire.encode(ev)
    assert wire.payload_f32_offset(buf) % 4 == 0      # zero-copy Float32Array precondition
    out, nxt = wire.decode(buf, 0)
    assert nxt == len(buf)
    assert out.col_seq == 7 and out.final and np.array_equal(out.bid, ev.bid)

def test_unknown_type_skipped():
    fake = struct.pack("<BBHI", 0x3F, wire.PROTO_VER, 0, 4) + b"\x00" * 4
    ev = events.Ping(server_send_ns=5)
    out1, off = wire.decode(fake + wire.encode(ev), 0)
    assert out1 is None
    out2, _ = wire.decode(fake + wire.encode(ev), off)
    assert isinstance(out2, events.Ping)

def test_json_cold_message_roundtrip():
    h = events.Hello(protocol_version=1, session_id="s1", grid_epoch=0,
                     epoch_params=events.EpochParams(epoch=0, tick=0.01, tick_multiple=5,
                                                     dt_ns=250_000_000, p0=100.0, rows=2048),
                     capability={"depth": "L2"}, norm_seed=42.5)
    out, _ = wire.decode(wire.encode(h), 0)
    assert out.epoch_params.rows == 2048 and out.capability["depth"] == "L2"

def test_golden_vectors_stable():
    # encodes a fixed fixture set and compares byte-for-byte with checked-in vectors
    from flowmap_server.proto.wire import golden_fixture_events
    import pathlib
    d = pathlib.Path(__file__).parent / "golden"
    for name, ev in golden_fixture_events().items():
        assert wire.encode(ev) == (d / f"{name}.bin").read_bytes(), name
```

- [ ] **Step 2: Run to verify failure** — `uv run pytest tests/proto -x -q` → import errors.
- [ ] **Step 3: Implement `events.py` + `wire.py`** per the contract above.
  `golden_fixture_events()` returns a dict of ~10 representative events (one per hot type, two
  cold) with FIXED values (no randomness/time). Include `numpy` arrays via
  `np.ascontiguousarray(..., dtype=np.float32).tobytes()`.
- [ ] **Step 4: Generate the golden files once** —
  `uv run python -c "from flowmap_server.proto.wire import write_golden_vectors; write_golden_vectors('tests/proto/golden')"`
  (implement that helper). Re-run tests → PASS.
- [ ] **Step 5: Commit** — `feat(server): wire protocol, canonical events, golden vectors`.
  Golden files are committed; they are the cross-language contract for the client (M2).

### Task 5: Density grid — epochs, time-weighted accumulation, ring

**Files:**
- Create: `server/src/flowmap_server/core/grid.py`
- Create: `server/tests/core/test_grid.py`

**Contract (spec §8.1–8.2):**

```python
class Grid:
    def __init__(self, cfg: GridCfg): ...
    # GridCfg: tick, tick_multiple, dt_ns, p0, rows, ring_columns, mode
    def on_book(self, ts_ns: int, bid_px: np.ndarray, bid_sz: np.ndarray,
                ask_px: np.ndarray, ask_sz: np.ndarray) -> list[FinalizedColumn]:
        """Apply a book state observed at ts_ns. Time-weighted: the PREVIOUS book state is
        integrated over (ts_ns - prev_ts). May finalize 0..k columns (k>1 if ts jumps
        intervals; emit empty columns for skipped intervals). Returns finalized columns."""
    def on_trade(self, ts_ns, price, size, side) -> None: ...   # feeds BarColumn accumulators
    def current_partial(self) -> DepthColumn: ...               # progressive right-edge emit
    def maybe_reanchor(self, mid: float) -> EpochParams | None:
        """If mid outside central 70% of span: bump epoch, recenter p0 (snapped to
        tick*multiple), return new EpochParams; history in the ring is NEVER rewritten."""
    def history(self, before_t_ns: int, n: int) -> list[FinalizedColumn]: ...
```

Ring storage: `np.float16 [ring_columns, 2, rows]` + parallel `epoch u32 / t0_ns i64 /
col_seq u32` arrays. Accumulator in f32. `price→row = round((px - p0) / (tick*mult))`,
out-of-range levels dropped (they return after re-anchor).

- [ ] **Step 1: Write failing tests:**

```python
import numpy as np
from flowmap_server.core.grid import Grid, GridCfg

CFG = GridCfg(tick=0.5, tick_multiple=1, dt_ns=1_000_000_000, p0=90.0, rows=64,
              ring_columns=128, mode=0)

def book(mid, sz):  # 3-level symmetric book helper
    px = np.array([mid-1.0, mid-0.5, mid], dtype=np.float64)
    return (px - 0.0, np.full(3, sz), px + 0.5, np.full(3, sz))

def test_time_weighted_identical_across_cadence():
    """Spec §12: two update cadences over the same book → byte-identical columns."""
    g1, g2 = Grid(CFG), Grid(CFG)
    t0 = 0
    g1.on_book(t0, *book(100.0, 5.0))
    g2.on_book(t0, *book(100.0, 5.0))
    for i in range(1, 11):                      # g2 sees the same book 10x more often
        g2.on_book(t0 + i * 100_000_000, *book(100.0, 5.0))
    c1 = g1.on_book(t0 + 1_000_000_000, *book(100.0, 5.0))
    c2 = g2.on_book(t0 + 1_000_000_000, *book(100.0, 5.0))
    assert len(c1) == len(c2) == 1
    assert np.array_equal(c1[0].bid, c2[0].bid) and np.array_equal(c1[0].ask, c2[0].ask)

def test_half_interval_weighting():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 4.0))             # size 4 for first half
    g.on_book(500_000_000, *book(100.0, 8.0))   # size 8 for second half
    (col,) = g.on_book(1_000_000_000, *book(100.0, 8.0))
    row = round((100.0 - 0.5 - CFG.p0) / 0.5)   # a bid level present in both books
    assert col.bid[row] == np.float16(6.0)      # time-weighted mean 4*0.5 + 8*0.5

def test_gap_emits_empty_columns():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    cols = g.on_book(3_500_000_000, *book(100.0, 5.0))
    assert len(cols) == 3                        # intervals 0,1,2 finalized
    assert cols[1].bid.max() > 0                 # persisted book integrates through the gap

def test_reanchor_preserves_history():
    g = Grid(CFG)
    g.on_book(0, *book(100.0, 5.0))
    g.on_book(1_000_000_000, *book(100.0, 5.0))
    before = g.history(before_t_ns=2_000_000_000, n=10)
    params = g.maybe_reanchor(mid=140.0)         # far outside central 70% of [90, 122)
    assert params is not None and params.epoch == 1
    assert params.p0 % (CFG.tick * CFG.tick_multiple) == 0
    after = g.history(before_t_ns=2_000_000_000, n=10)
    assert all(np.array_equal(a.bid, b.bid) for a, b in zip(before, after))
    assert after[0].epoch == 0                   # old columns keep their epoch

def test_no_reanchor_inside_band():
    assert Grid(CFG).maybe_reanchor(mid=106.0) is None
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `grid.py`.** Keep the previous book as row-index/size arrays so the
  integration step is `acc[rows] += sizes * dt_w` via `np.add.at`. Finalize divides by `dt_ns`
  and casts f16 into the ring. BarColumn accumulators: vol_buy/vol_sell/cvd_cum/vwap sums fed by
  `on_trade` (side==unknown counts into neither vol side but does count volume for vwap).
- [ ] **Step 4: Run tests → PASS. Also add a micro-benchmark guard** (same file):

```python
def test_update_cost_under_2ms():
    import time
    g = Grid(GridCfg(tick=0.5, tick_multiple=1, dt_ns=250_000_000, p0=0.0, rows=4096,
                     ring_columns=1024, mode=0))
    rng = np.random.default_rng(0)
    px = np.sort(rng.uniform(10, 2000, 2000)); sz = rng.uniform(0.1, 50, 2000)
    g.on_book(0, px, sz, px + 0.5, sz)
    t = time.perf_counter()
    for i in range(1, 101):
        g.on_book(i * 10_000_000, px, sz, px + 0.5, sz)   # 100 updates incl. finalizes
    assert (time.perf_counter() - t) / 100 < 0.002        # spec §10: <2ms
```

- [ ] **Step 5: Commit** — `feat(server): time-weighted density grid with epochs and ring`.

### Task 6: Deterministic sim feed

**Files:**
- Create: `server/src/flowmap_server/feeds/base.py` (FeedEvent union + Feed protocol)
- Create: `server/src/flowmap_server/feeds/sim.py`
- Create: `server/tests/feeds/test_sim.py`

**Contract:** `SimFeed(seed: int, dt_ns: int, start_ns: int)` produces an async iterator of
canonical feed events (book states, trades, occasional liquidation markers) with a seeded
`np.random.default_rng`; mid follows a random walk with persistent liquidity "walls" (a few
rows keep 10× size for many intervals — needed later for visual verification of sum-mips).
Two constructions with the same seed yield identical event sequences. Also expose
`preload(n_cols: int) -> None`-style fast history generation: `SimFeed.generate_history(seed,
n_cols, ...) -> list[FinalizedColumn]` batch-vectorized (for the M2 perf harness; must build
10 000 columns in <2 s).

- [ ] **Step 1: Failing tests:** determinism (two seeds → identical first 100 events, different
  seeds → different), wall persistence (some row's density ≥5× median across ≥50 consecutive
  columns when run through a Grid), `generate_history(seed=1, n_cols=10_000)` returns 10 000
  columns in <2 s (time-guarded), trades have both sides over 1 000 events.
- [ ] **Step 2: Verify failure. Step 3: Implement. Step 4: PASS. Step 5: Commit**
  `feat(server): deterministic sim feed with liquidity walls`.

### Task 7: Session, subscriptions, backpressure

**Files:**
- Create: `server/src/flowmap_server/core/session.py`
- Create: `server/tests/core/test_session.py`

**Contract (spec §6.3, §11):**

```python
class Session:            # one per (market, symbol, mode[, source]); owns Feed task + Grid
    session_id: str
    def attach(self, client: ClientTx) -> Snapshot: ...   # refcount++, returns snapshot
    def detach(self, client) -> None                      # refcount--; teardown after 60s grace
class ClientTx:           # per-client bounded queue + lag/drop state
    def offer(self, msg_bytes: bytes, *, col_msg: bool, t0_ns: int | None) -> None
    def drain(self, max_bytes: int) -> list[bytes]
class SessionManager:
    def subscribe(self, sub: events.Subscribe, client) -> Session   # ≤ cfg.max_sessions
```

Snapshot = Hello + EpochStart(s) + last ≤512 depth+bar columns + markers-in-range + last ≤500
trades + current BBO, pre-encoded, chunked ≤64 columns per WS frame. Backpressure: when the
oldest queued column message is >2 s old, drop whole columns oldest-first and enqueue a
`Marker{kind=gap}`; depth/bar columns are never coalesced; BBO/Trade may be dropped latest-wins
beyond a 1 000-message cap.

- [ ] **Step 1: Failing tests:** snapshot shape (subscribe on a session pre-filled by SimFeed
  through Grid → Hello first, EpochStart before any column, ≤512 columns, chunk sizes ≤64);
  refcount teardown (detach → session alive during grace, gone after); backpressure (offer 5 000
  columns to a non-draining client → queue bounded, gap marker enqueued exactly at drop points,
  dropped col_seqs recoverable via `Grid.history`); max_sessions enforced (5th distinct
  subscribe raises).
- [ ] **Step 2–4: fail → implement → PASS.** Use plain asyncio, no threads; grace timer via
  `loop.call_later`, injectable clock for tests.
- [ ] **Step 5: Commit** — `feat(server): session manager with snapshot and per-client backpressure`.

### Task 8: FastAPI app — binary WS + REST

**Files:**
- Create: `server/src/flowmap_server/api/app.py` (factory `create_app(cfg) -> FastAPI`)
- Create: `server/src/flowmap_server/api/ws.py`
- Create: `server/src/flowmap_server/api/rest.py`
- Create: `server/src/flowmap_server/__main__.py` (uvicorn runner, binds cfg.host asserted loopback)
- Create: `server/tests/api/test_ws_e2e.py`, `server/tests/api/test_rest.py`

**Contract:** `GET /api/symbols?q=` → merged crypto (Crypcodile InstrumentRegistry) + equity
(static top-tickers list for M1; SEC universe deferred to M4) with per-symbol capability
descriptors. `GET /api/health`. `WS /ws`: client sends `Subscribe`; server streams snapshot then
live; `Ping` 1 Hz; flush loop 20 Hz; CORS restricted to `http://127.0.0.1:5173`.

- [ ] **Step 1: Failing e2e test** (the M1 acceptance test):

```python
async def test_ws_sim_session_end_to_end(unused_tcp_port):
    # boot uvicorn in-process (uvicorn.Server + asyncio task) with sim feed config
    # connect with `websockets`, send Subscribe{market:"sim", symbol:"SIM-DEMO", mode:"live"}
    # assert: first msg Hello (protocol_version==1); an EpochStart precedes any DepthColumn;
    # ≥1 snapshot DepthColumn arrives <1s; ≥3 live DepthColumns with strictly increasing
    # col_seq and final flags transitioning (progressive re-send then final);
    # BarColumn cvd_cum monotone-or-flat; Ping received; send HistoryRequest{req_id:9,...}
    # → HistoryResponse with req_id==9 and oldest_available_t <= requested before_t.
```

  (Write it concretely with the wire decoder from Task 4 — no JSON shortcuts on hot messages.)
- [ ] **Step 2–4: fail → implement → PASS.** Keep `ws.py` thin: decode control messages, call
  SessionManager, pump `ClientTx.drain` on the flush timer.
- [ ] **Step 5: REST tests** (httpx): `/api/health` 200; `/api/symbols?q=SIM` includes the sim
  symbol with `capability.depth == "L2"`.
- [ ] **Step 6: Commit** — `feat(server): FastAPI binary WS + REST with sim session e2e`.

### Task 9: Crypto bridge (Crypcodile → canonical)

**Files:**
- Create: `server/src/flowmap_server/feeds/crypto.py`
- Create: `server/tests/feeds/test_crypto_bridge.py` (fixture-driven, NO network)
- Create: `server/tests/feeds/fixtures/binance_btcusdt_sample.jsonl` (recorded raw messages)

**Contract:** `CryptoFeed(exchange, symbol, market, cfg)` wraps
`crypcodile.exchanges.factory.make_connector` + `AiohttpWsTransport` + a `Sink` subclass that
translates crypcodile records (`Trade`, `BookSnapshot`, `BookDelta`, `BookTicker`,
`Liquidation`) into canonical feed events; maintains the live book via
`crypcodile.replay.orderbook.OrderBook` (apply snapshot + deltas; on `BookGap` → trigger
connector resync, emit gap Marker). Trades map side directly (`side_src=exchange`);
liquidations → `Marker{kind=liquidation}`.

- [ ] **Step 1: Build the fixture** — extract ~200 representative records by instantiating the
  BINANCE connector's normalize path OFFLINE: feed it a handful of hand-written raw ws JSON
  frames (aggTrade, depthUpdate with a proper prior snapshot, bookTicker, forceOrder — copy the
  documented shapes from `crypcodile/exchanges/binance/connector.py` tests, see
  `/Users/nazmi/Crypcodile/tests/exchanges/`). Store the RAW frames in the JSONL fixture.
- [ ] **Step 2: Failing tests:** replaying the fixture through CryptoFeed's message handler
  yields: ≥1 book state whose best_bid < best_ask; a Trade with side in {buy, sell} and
  side_src == exchange; a liquidation Marker; and after an artificially corrupted delta
  (sequence jump), a gap Marker plus a resync call (assert via injected fake snapshot fetcher).
- [ ] **Step 3–4: implement → PASS.** No live network in tests.
- [ ] **Step 5: Live smoke script (manual-run, not pytest):**
  `server/scripts/live_crypto_smoke.py` — connects real Binance BTCUSDT for 30 s, prints
  columns/sec, book levels, trade count; exits 0 if ≥10 columns and a two-sided book were seen.
  Run it once and paste output into the commit message body.
- [ ] **Step 6: Commit** — `feat(server): Crypcodile live bridge with book maintenance and gap resync`.

### Task 10: Recording + ring rehydration

**Files:**
- Create: `server/src/flowmap_server/core/record.py`
- Create: `server/tests/core/test_record.py`

**Contract (spec §7, §8.1):** `Recorder(dir, gb_cap)` appends finalized canonical events
(depth/bar columns, trades, markers, epoch starts) to hourly Parquet files
(`recordings/{market}/{symbol}/{YYYYMMDD-HH}.parquet` via polars); size-capped pruning
(oldest-first) at `gb_cap`; `Recorder.load_tail(market, symbol, max_age_ns, ring_span_ns)`
returns columns for Session start rehydration; `Session.attach` gets them via SessionManager.

- [ ] **Step 1: Failing tests:** round-trip (record 100 sim columns → load_tail returns
  identical arrays/epochs); pruning (write >cap with tiny cap → oldest files deleted, newest
  kept); rehydration wiring (new Session for a previously recorded (market,symbol) starts with
  non-empty `Grid.history` and a gap Marker between recorded tail and live).
- [ ] **Step 2–4: fail → implement → PASS. Step 5: Commit**
  `feat(server): parquet self-recording with retention and ring rehydration`.

### Task 11: M1 integration gate

- [ ] **Step 1: Full suite** — `cd /Users/nazmi/flowmap/server && uv run pytest -q` → ALL PASS.
- [ ] **Step 2: Boot the real server** — `uv run python -m flowmap_server` with sim config;
  from another shell run the Task 8 e2e assertions against it manually via
  `server/scripts/ws_probe.py` (write it: subscribes, prints message-type histogram for 10 s).
  Expected: Hello/EpochStart/DepthColumn/BarColumn/Ping all present, no decode errors.
- [ ] **Step 3: Live crypto smoke** — run `server/scripts/live_crypto_smoke.py` (real Binance);
  paste its output into `docs/superpowers/plans/m1-verification.md` together with the pytest
  summary line and commit that file.
- [ ] **Step 4: Commit + update this plan's checkboxes.**
