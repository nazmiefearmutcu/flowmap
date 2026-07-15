# R04 — Data Manager + Simulator Analysis

**Scope files**
- `/Users/nazmi/flowmap/flowmap/data/base.py`
- `/Users/nazmi/flowmap/flowmap/data/manager.py`
- `/Users/nazmi/flowmap/flowmap/data/config.py`
- `/Users/nazmi/flowmap/flowmap/data/simulator.py`
- `/Users/nazmi/flowmap/flowmap/data/__init__.py`

**Related (not in scope, referenced for contrast):** `crypto.py`, `crypcodile_replay.py`, `crypcodile_live.py`, `ui/source_manager.py`

---

## 1. DataSource / DataProvider interface and lifecycle

### Naming
There is **no** class named `DataSource`. The shared interface is:

| Concept | Implementation |
|--------|----------------|
| Abstract provider | `DataProvider(QObject)` in `base.py` |
| Manager facade | `DataManager(QObject)` in `manager.py` |
| Sim concrete | `MarketSimulator(DataProvider)` |

`abc.ABC` is intentionally **not** used because PyQt6 `QObject` metaclass conflicts with `ABCMeta`. Abstract methods raise `NotImplementedError` by convention (`base.py:5–7`, `45–47`, `60–67`, `71–77`).

### Signal contract (`base.py:29–35`)

| Signal | Payload |
|--------|---------|
| `on_snapshot` | `Level2Snapshot` |
| `on_update` | `Level2Update` (incremental L2) |
| `on_trade` | `Trade` |
| `on_bbo` | `BBO` |
| `on_connected` / `on_disconnected` | void |
| `on_error` | `str` |

### Lifecycle methods

| Method | Base | Simulator | DataManager |
|--------|------|-----------|-------------|
| `connect()` | required | start `QTimer`, set `_connected`, emit `on_connected` | delegate if not connected |
| `disconnect()` | required | stop timer, emit `on_disconnected` | only if `is_connected` |
| `pause()` / `resume()` | **absent** | **absent** | **absent** |
| `subscribe` / `unsubscribe` | required | mutates `_symbols` / `symbol` | silent no-op if no provider |
| `shutdown()` | n/a | n/a | disconnect + `deleteLater` |

**Pause is not part of this layer.** Pause/resume exists only on Crypcodile replay (`crypcodile_replay.py`), outside `DataProvider` and outside `DataManager`.

### Simulator lifecycle detail (`simulator.py:703–723`)

```
connect:
  if already connected → return
  _connected = True
  _symbols = [self.symbol]
  emit on_connected
  QTimer(interval=_tick_interval_ms) → _emit_tick; start

disconnect:
  if not connected → return
  _connected = False
  stop/null timer
  emit on_disconnected
```

Notes:
- No “connecting…” intermediate state; `on_connected` is synchronous with `connect()`.
- Re-`connect()` while connected is a no-op (timer not restarted if somehow stopped without clearing flag).
- `reset()` (`746–782`) does **not** stop/start the timer or touch `_connected` — state can be mid-stream reset while ticks continue.

### Symbol subscription quirks (simulator)

- `subscribe(symbol)` appends to `_symbols` and **overwrites** `self.symbol` (`725–728`) — multi-symbol list is decorative; generation always uses single `self.symbol`.
- `unsubscribe` removes from list but does **not** clear `self.symbol` if list becomes empty; ticks keep emitting old symbol data (`730–732`).

---

## 2. Manager responsibilities and source switching

### Responsibilities (`manager.py`)

1. Own **one** active `DataProvider` (`_provider`).
2. Factory-build providers via `_build_provider`.
3. **Proxy** all data/lifecycle signals so UI can connect once to `DataManager`.
4. Expose `connect` / `disconnect` / `subscribe` / `unsubscribe` / `shutdown`.
5. Emit `on_source_changed(str)` after a successful switch.

### Known sources (`SOURCES`, `52–60`)

| Key | Built by |
|-----|----------|
| `simulator` | `MarketSimulator(...)` |
| `binance`, `coinbase`, `kraken`, `bybit`, `okx`, `bitmex` | `CryptoProvider` if in `EXCHANGE_CONFIG` |

Docstring claims “simulator, crypto, **replay**, etc.” (`manager.py:4–5`) but **replay / Crypcodile are not wired** into `DataManager`. They are exported from `__init__.py` and used elsewhere (`ui/source_manager.py`).

### `set_source` sequence (`85–122`)

1. `disconnect()` current provider (only if `is_connected`).
2. Null out `_provider` / `_source_type`.
3. `old.deleteLater()` if old existed.
4. Build new provider; on unknown type emit `on_error` and return (**no provider active**).
5. Wire 7 provider signals → manager signals with **direct** `connect(...emit)`.
6. Emit `on_source_changed`.

**Does not auto-`connect()`** after switch — caller must call `connect()`.

### Factory details (`124–152`)

**Simulator:**
```python
MarketSimulator(
    symbol=..., base_price=..., tick_size=...,
    depth_levels=kwargs.pop("depth", 20),  # note: ctor default is 100
    **kwargs,  # no parent=self
)
```

**Crypto:**
```python
depth from kwargs or EXCHANGE_CONFIG
force_rest = kwargs.pop("force_rest", not cfg.get("ws", True))
CryptoProvider(..., parent=self, **kwargs)
```

Config (`config.py`) only supplies `ws`, `rate_limit`, `depth`, `fees` — **fees/rate_limit unused by DataManager**.

### Manager gaps / risks

| Issue | Location | Effect |
|-------|----------|--------|
| No disconnect of old signal links before `deleteLater` | `99–103`, `114–120` | Usually OK after deleteLater; if delete deferred, stray emits possible |
| `disconnect()` skipped when provider thinks not connected | `164–167` | Timer/WS cleanup may not run if `_connected` false but resources still live |
| Unknown source leaves manager empty after destroying old | `106–108` | Hard cutover failure mode |
| Extra kwargs to simulator may `TypeError` | `128–134` | Uncaught in `set_source` → crash |
| Simulator not parented to manager | `128–134` | Lifetime not Qt-parented; only `deleteLater` from manager |
| No crypcodile / multi-source | whole manager | Parallel UI path (`source_manager`) can diverge |
| Dual architecture | manager vs `ui/source_manager.py` | Two “managers” — risk of inconsistent wiring |

---

## 3. Simulator market model — realism and failure modes

### Stated model vs code

Class docstring (`24–34`) advertises features; several numbers **do not match** implementation:

| Claim (docstring) | Actual code |
|-------------------|-------------|
| Burst 5–15×, 8–20 ticks | Start burst: 2–4×, 12–30 ticks (`517–519`); sweep can raise to 5–12× (`582–583`) |
| Accum multiplier 15–50× | 3–6× (`446`) |
| Zone life 400–800 | 300–800 (`120`, `781`) |
| Tight OU theta=0.01 | Matches (`65`) |
| ±3% hard clamp | Matches (`607–615`) |

### Price dynamics

1. **OU step** (`143–147`): `drift = θ(μ − S)`, `noise = σ√dt · Z`, `dt = 1/390`.
2. **Momentum** (`525–542`): 2% chance; 20–40 ticks; step `0.3–0.8 * tick_size`; **skips OU** while active.
3. **Sweep** (`548–583`): 0.4% chance; jumps 2–5 ticks; clears accum on swept side; drains icebergs 70%; forces burst.
4. **Clamp** to `[0.97, 1.03] * base_price` with small bounce.

**Realism limits:**
- No inventory, no true matching engine: **trades do not consume book liquidity**.
- Full book **regenerated every tick** → heatmap “flicker”, no true resting queue continuity except synthetic zones/icebergs/accum multipliers.
- `spread_bps` stored (`55`, `59`) but **never used** in bid/ask generation — spread is random 1–2 ticks from mid (`191`, `279`).
- Momentum + OU + clamp can fight each other; long momentum runs hit walls at ±3%.
- After tick ≥ 389, volume profile freezes on last bar (`386–387`).

### Order book generation

- Exponential size decay + lognormal jitter + min/max clamps (`153–166`).
- Random **gaps** set size to 0 (`229–231`, `317–319`) then only append if `size > 0` — good.
- BBO boost floors level 0/1 sizes (`223–227`) then gap can zero them only if level in `gap_levels` (gaps start at range `2..`, so top is safe).
- Static zones double-processed: main ladder **and** extra_prices path can both decay zone `life` / `size` in same tick (`209–215` vs `262–267`, asks similarly) → **double-decay bug**.
- Iceberg “display drain” (`184`) and replenish (`496–502`) both run every tick → net effect depends on rates; not true iceberg (no hit-by-trade).
- Extra price collection can push book **beyond** `depth_levels` without sorting guarantee for combined list (extras appended after ladder) — bids reverse-sorted extras, asks sorted, but **not re-merged by price with main list**.

### Trades / liquidations

- Poisson count from U-shaped profile (`381–388`).
- Price = mid + Gaussian slip (not constrained to book) → **off-book prints**.
- Liquidations: 2% per tick, synthetic `is_liquidation=True` (`671–687`) — not tied to leverage/margin model.
- Side bias from distance to base (`405–408`) — weak “trend” aggressor model.

### Performance / UI load failure modes

- Default `depth_levels=100` ctor (`44`) but manager passes `depth=20` (`132`).
- Each tick: O(depth × zones × icebergs) for both sides + multiple signal emits.
- `_emit_tick` emits **1 snapshot + N trades + 1 BBO** synchronously on GUI thread (`734–744`) — no batching, no `on_update`.
- `on_update` is never emitted by simulator — consumers expecting incremental L2 get nothing.

### Other implementation hazards

| Hazard | Lines | Notes |
|--------|-------|-------|
| Knuth Poisson for large λ | `369–379` | λ small here (~0.1–1); OK |
| Zone match `tick_size * 0.1` | `210` | May miss if float rounding differs from zone price |
| Accum key `round(price, 6)` vs tick rounding | `170`, `448` | Mismatch risk for weird tick sizes |
| `max_size` walls capped to 5000 | `233–234`, `642–645` | Walls up to `12 * max_size` then hard cap → walls look flat |
| Gap level `random.sample` requires `depth > 10` | `196` | Small depth → no gaps |
| `parent: QObject = None` type hint | `49`, manager `62` | Should be `Optional[QObject]` |

---

## 4. Queue design, backpressure, overflow

### In-scope modules: **no queue**

`base.py`, `manager.py`, `config.py`, `simulator.py`, `__init__.py` contain:

- **No** `queue.Queue`, `asyncio.Queue`, `collections.deque` for market data
- **No** backpressure API
- **No** drop / sample / coalesce policy
- **No** max pending events

Delivery path is **direct `pyqtSignal` emission**:

```
MarketSimulator._emit_tick
  → on_snapshot.emit / on_trade.emit* / on_bbo.emit
    → DataManager proxies (same-thread DirectConnection if same thread)
      → UI slots run immediately
```

### Implications

| Concern | Behavior |
|---------|----------|
| Producer faster than consumer | **None** — timer keeps firing; slots block next event-loop work |
| Overflow | **Qt event queue growth** under load; no app-level bound |
| Drop strategy | None (cannot skip ticks) |
| Cross-thread | Simulator uses main-thread `QTimer` → no Qt queued connection benefit/cost from worker |
| Incremental L2 | Not used; full snapshot every tick increases payload size |

### Contrast (out of scope but important)

`crypto.py` / crypcodile workers accept optional `queue=` and comment “Ingestion buffers to prevent event queue overflow”. `DataManager` **never passes a queue** when constructing `CryptoProvider` (`144–151`). Optional queue path is dead for manager-owned crypto sources unless constructor defaults create one.

Simulator has **zero** of that machinery.

### Effective backpressure surface for sim path

```
QTimer (200ms default)
  → tick() heavy CPU
  → N signal emissions
  → consumer book/heatmap updates
```

If consumer is slow, ticks **queue in Qt** as timer + signal events → UI lag, not controlled degradation. No pause to relieve pressure.

---

## 5. Bug hypotheses (file:line)

Severity: **H** high / **M** medium / **L** low / **D** design debt

### Lifecycle / manager

| ID | Sev | Hypothesis | Evidence |
|----|-----|------------|----------|
| H1 | H | `set_source` destroys previous provider before confirming new one builds; unknown source or ctor exception leaves app with **no** data source | `manager.py:97–108`, `128–134` |
| H2 | M | Simulator ctor kwargs TypeError (e.g. unknown key after pop) crashes `set_source` mid-teardown | `manager.py:128–134` |
| H3 | M | `disconnect()` only if `is_connected`; if flag false while timer still running (partial failure), resources leak | `manager.py:164–167`, `simulator.py:716–723` |
| H4 | M | Signal fan-out not disconnected before `deleteLater`; deferred deletion + late timer tick → emit on dying object / double-delivery edge cases | `manager.py:99–120` |
| H5 | L | Simulator not `parent=self` unlike crypto → lifetime solely via manual `deleteLater` | `manager.py:128–151` |
| H6 | D | Docstring advertises replay; factory does not support crypcodile | `manager.py:4–5`, `124–152` |
| H7 | D | Dual managers (`DataManager` vs `ui/source_manager.py`) can wire different provider sets | inventory grep |
| H8 | L | No `pause` on `DataProvider` — cannot freeze sim without disconnect (loses state continuity) | `base.py:58–67` |

### Simulator correctness

| ID | Sev | Hypothesis | Evidence |
|----|-----|------------|----------|
| S1 | M | Zone `life`/`size` **double-decay** when price appears in both main ladder and extra_prices path in one tick | `simulator.py:209–215` + `262–267` (asks `297–303` + `350–355`) |
| S2 | M | Full book rebuild each tick → liquidity “teleports”; heatmap continuity bugs misattributed to renderer | `638–654`, `_generate_bids/asks` |
| S3 | M | Trades ignore book → impossible prices / sizes vs BBO; downstream classifiers (CVD, liq) see inconsistent state | `390–417`, `671–687` |
| S4 | L | `spread_bps` dead config; spread not controllable | `55–59` unused in generation |
| S5 | L | Docstring/parameter lies (burst 5–15× vs 2–4×) mislead tuning | `24–34` vs `517–519` |
| S6 | M | `subscribe` changes active `symbol` mid-session without book reset → mixed-symbol stream | `725–728` |
| S7 | L | `unsubscribe` all symbols still produces data for old `self.symbol` | `730–732`, `_emit_tick` |
| S8 | M | After `_tick >= 390`, volume profile stuck; session-long volume shape wrong | `386–387` |
| S9 | L | Accum inject docstring says 15–50× / multi-side clustering; code single side 3–6× | `425–451` |
| S10 | M | BBO taken from `bids[0]`/`asks[0]` after unsorted append of extras may not be true best if main loop order broken | extras appended after loop; main is monotonic but extras only if not in existing — OK if existing covers near BBO; far extras only. **Near-BBO extras unlikely.** Lower risk. |
| S11 | M | Gap then `if size > 0` skips level, but elsewhere `max(min_size, size)` re-inflates zeros if path skips gap — inconsistency across paths | `229–237` vs `271–272` (extras never gapped) |
| S12 | L | Liquidation rate 2%/tick @ 5 Hz ≈ very high vs real markets; visual noise / false liq markers | `671–672` |
| S13 | M | GUI-thread heavy `tick()` + multi-emit → UI jank; no coalesce of trades | `711–714`, `734–744` |
| S14 | D | `on_update` never emitted — any consumer relying on incremental L2 silent-fails on sim | interface `base.py:30`, emit only snapshot path |
| S15 | L | Manager default `depth=20` vs sim default `100` — tests/direct ctor differ from app | `manager.py:132`, `simulator.py:44` |
| S16 | M | Hard size cap 5000 flattens “walls” after expensive zone math — walls disappear visually | `233–234`, `642–645` |
| S17 | L | `reset()` does not clear `_prev_trade_price` (field write-only / unused?) | `125`, `746–782` |
| S18 | L | `_prev_trade_price` never read — dead state | `125` |

### Queue / backpressure

| ID | Sev | Hypothesis | Evidence |
|----|-----|------------|----------|
| Q1 | H | **No application-level queue or backpressure** on manager/sim path; slow consumers → Qt event pile-up | entire manager/sim |
| Q2 | M | Crypto optional `queue` not supplied by `DataManager` → overflow mitigations in worker unused | `manager.py:144–151` vs crypto worker |
| Q3 | M | Timer cannot skip ticks; no “drop if previous tick still processing” guard | `simulator.py:711–714` |
| Q4 | L | Burst of many `on_trade.emit` per tick multiplies slot overhead vs single batched trades signal | `742–743` |

### Config / packaging

| ID | Sev | Hypothesis | Evidence |
|----|-----|------------|----------|
| C1 | L | `EXCHANGE_CONFIG.fees` / `rate_limit` unused by manager | `config.py`, `manager.py:140–151` |
| C2 | L | `__init__` imports crypto + optional crypcodile; import failure only soft for crypcodile | `__init__.py:13–21` |
| C3 | D | `SOURCES` human strings can drift from `EXCHANGE_CONFIG` keys | `manager.py:52–60` vs `config.py:18–55` |

---

## 6. Architecture diagram (sim path)

```
┌─────────────┐   set_source("simulator")   ┌──────────────────┐
│  UI / App   │ ──────────────────────────► │   DataManager    │
│             │   connect()                 │  signal proxy    │
│  slots      │ ◄── on_snapshot/trade/bbo ──│                  │
└─────────────┘                             └────────┬─────────┘
                                                     │ owns
                                                     ▼
                                            ┌──────────────────┐
                                            │ MarketSimulator  │
                                            │ QTimer ──► tick()│
                                            │ full L2 snapshot │
                                            │ trades, bbo      │
                                            └──────────────────┘
                                                     │
                                            NO queue / NO pause
                                            NO on_update
```

---

## 7. Summary for Phase 1 bug-hunt

**Strengths**
- Clear `DataProvider` signal contract shared by sim/crypto.
- Manager isolates consumers from concrete provider type for exchange + sim.
- Simulator is feature-rich for **visual** demos (zones, icebergs, bursts, momentum).

**Weaknesses (priority)**
1. **No pause / no queue / no backpressure** on manager+sim path (Q1, Q3, H8).
2. **Unsafe source switch** teardown-before-success (H1, H2).
3. Simulator is a **visual generator**, not a coherent market: trades ≠ book (S2, S3).
4. **Zone double-decay** and docstring/code drift (S1, S5).
5. **Dual data orchestration** (DataManager vs UI SourceManager; crypcodile outside factory) (H6, H7).
6. Full-snapshot, multi-trade emits on GUI thread risk jank (S13, Q4).

**Suggested Phase 2 probes**
- Unit-test `set_source` unknown type + bad kwargs after connected sim.
- Count zone life decrement per tick when zone price inside depth.
- Profile slot time under `depth_levels=100`, burst on, measure event-loop latency.
- Trace whether production UI uses `DataManager` or only `source_manager`.
- Verify any consumer expects `on_update` during sim mode.

---

*Research agent R04 — Phase 1. Read-only analysis of listed data modules.*
