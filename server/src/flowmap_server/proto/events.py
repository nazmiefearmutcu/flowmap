"""Canonical FlowMap v2 events (design spec §6.1).

These msgspec Structs are the **in-process representation only**. The wire
encoding lives in :mod:`flowmap_server.proto.wire`:

- Hot messages (DepthColumn, BarColumn, Trade, BBO, Ping, Pong,
  HistoryResponse) are hand-packed little-endian binary.
- Cold messages (Hello, EpochStart, Status, Marker, Subscribe, Unsubscribe,
  Seek, SetSpeed, Pause, Resume, HistoryRequest) travel as UTF-8 JSON payloads
  flagged with FLAG_JSON in the envelope.

Field order in each Struct is load-bearing for cold messages: msgspec encodes
JSON keys in struct definition order, and the golden vectors freeze that order.
"""

from __future__ import annotations

from typing import Literal

import msgspec
import numpy as np

# --- DepthColumn.mode (wire u8) ------------------------------------------------
MODE_L2 = 0
MODE_L1_BAND = 1
MODE_SYNTH_PROFILE = 2  # single-channel density: only bid[] is present

# --- Trade.side / Trade.side_src (wire u8) ------------------------------------
SIDE_BUY = 0
SIDE_SELL = 1
SIDE_UNKNOWN = 2

SIDE_SRC_EXCHANGE = 0
SIDE_SRC_INFERRED = 1
SIDE_SRC_NA = 2

MarkerKind = Literal[
    "liquidation", "halt", "luld", "gap", "session_break", "large_lot", "iceberg", "info"
]
FeedState = Literal["live", "degraded", "closed", "reconnecting"]
StreamMode = Literal["live", "replay"]


class EpochParams(msgspec.Struct):
    epoch: int
    tick: float
    tick_multiple: int
    dt_ns: int
    p0: float
    rows: int


# --- Cold (JSON) messages ------------------------------------------------------


class Hello(msgspec.Struct):
    protocol_version: int
    session_id: str
    grid_epoch: int
    epoch_params: EpochParams
    capability: dict[str, object]
    norm_seed: float


class EpochStart(msgspec.Struct):
    epoch: int
    epoch_params: EpochParams


class Marker(msgspec.Struct):
    ts_ns: int
    kind: MarkerKind
    text: str = ""
    price: float | None = None
    size: float | None = None


class Status(msgspec.Struct):
    feed_state: FeedState
    capability: dict[str, object]
    latency_ms: float
    clock_skew_ms: float
    next_open_ts: int | None = None


class Subscribe(msgspec.Struct):
    market: str
    symbol: str
    mode: StreamMode
    source: str | None = None
    start_t: int | None = None


class Unsubscribe(msgspec.Struct):
    pass


class Seek(msgspec.Struct):
    t: int


class SetSpeed(msgspec.Struct):
    x: float


class Pause(msgspec.Struct):
    pass


class Resume(msgspec.Struct):
    pass


class HistoryRequest(msgspec.Struct):
    req_id: int
    before_t: int
    n_cols: int


# --- Hot (hand-packed binary) messages -----------------------------------------


class DepthColumn(msgspec.Struct):
    epoch: int
    col_seq: int
    t0_ns: int
    mode: int  # MODE_L2 | MODE_L1_BAND | MODE_SYNTH_PROFILE
    final: bool
    bid: np.ndarray  # float32, length n_rows
    ask: np.ndarray | None  # float32, length n_rows; None iff mode == MODE_SYNTH_PROFILE


class BarColumn(msgspec.Struct, frozen=True):
    epoch: int
    col_seq: int
    t0_ns: int
    o: float
    h: float
    l: float
    c: float
    vol_buy: float
    vol_sell: float
    cvd_cum: float
    vwap_num_cum: float
    vwap_den_cum: float


class Trade(msgspec.Struct):
    ts_ns: int
    price: float
    size: float
    side: int  # SIDE_BUY | SIDE_SELL | SIDE_UNKNOWN
    side_src: int  # SIDE_SRC_EXCHANGE | SIDE_SRC_INFERRED | SIDE_SRC_NA
    venue: str  # wire: u8 length + UTF-8 bytes (<= 255 bytes)


class BBO(msgspec.Struct):
    ts_ns: int
    bid_px: float
    bid_sz: float
    ask_px: float
    ask_sz: float


class Ping(msgspec.Struct):
    server_send_ns: int


class Pong(msgspec.Struct):
    echo_ns: int
    client_recv_ns: int


class HistoryResponse(msgspec.Struct):
    req_id: int
    epoch: int
    oldest_available_t_ns: int
    depth_cols: list[DepthColumn]
    bar_cols: list[BarColumn]
    markers: list[Marker]
    big_trades: list[Trade]
