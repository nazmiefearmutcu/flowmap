/**
 * FlowMap wire types — the TypeScript mirror of the server's canonical
 * events (server/src/flowmap_server/proto/events.py) and framing constants
 * (proto/wire.py). Field names match events.py EXACTLY so the two languages
 * describe one contract; the golden vectors under tests/golden/ freeze it.
 *
 * Integer representation:
 * - u8 / u16 / u32 fields (epoch, col_seq, mode, side, counts, ...) are `number`.
 * - i64 nanosecond fields (t0_ns, ts_ns, echo_ns, ...) are `bigint`, because JS
 *   `number` cannot hold nanosecond epoch timestamps (~1.75e18) without loss.
 * - f32 / f64 payload fields are `number`.
 * - Cold (JSON) nanosecond fields are also `bigint`; the decoder parses their
 *   JSON integer literals losslessly (see decode.ts) so they survive the round
 *   trip that plain JSON.parse would corrupt.
 *
 * Every top-level message interface carries a `type: MsgType` discriminant (the
 * wire tag) so `Msg` is a discriminated union the renderer can switch on. The
 * remaining fields are the exact event fields.
 */

export const PROTO_VER = 1;
export const FLAG_JSON = 0x0001;

/** Wire message tags (envelope u8 `msg_type`). Mirrors wire.py MSG_* constants. */
export enum MsgType {
  HELLO = 0x01,
  EPOCH_START = 0x02,
  DEPTH_COL = 0x03,
  BAR_COL = 0x04,
  TRADE = 0x05,
  BBO = 0x06,
  MARKER = 0x07,
  STATUS = 0x08,
  PING = 0x09,
  HISTORY_RESP = 0x0a,
  SUBSCRIBE = 0x40,
  UNSUBSCRIBE = 0x41,
  SEEK = 0x42,
  SET_SPEED = 0x43,
  PAUSE = 0x44,
  RESUME = 0x45,
  HISTORY_REQ = 0x46,
  PONG = 0x47,
}

// --- DepthColumn.mode (wire u8) ------------------------------------------------
export const MODE_L2 = 0;
export const MODE_L1_BAND = 1;
export const MODE_SYNTH_PROFILE = 2; // single-channel density: only bid[] present

// --- Trade.side / Trade.side_src (wire u8) ------------------------------------
export const SIDE_BUY = 0;
export const SIDE_SELL = 1;
export const SIDE_UNKNOWN = 2;

export const SIDE_SRC_EXCHANGE = 0;
export const SIDE_SRC_INFERRED = 1;
export const SIDE_SRC_NA = 2;

export type MarkerKind =
  | 'liquidation'
  | 'halt'
  | 'luld'
  | 'gap'
  | 'session_break'
  | 'large_lot'
  | 'iceberg'
  | 'info';
export type FeedState = 'live' | 'degraded' | 'closed' | 'reconnecting';
export type StreamMode = 'live' | 'replay';

/**
 * Shared epoch geometry; nested inside Hello / EpochStart (never framed alone).
 *
 * The first six fields describe the LINEAR affine `price = p0 + row·step`
 * (`step = tick · tick_multiple`) and remain the whole story for every grid that
 * has not opted into a non-uniform price scale.
 *
 * The trailing seven describe a piecewise scale (gl/priceScale.ts) and are
 * OPTIONAL: the server omits them entirely for a linear epoch, so a linear
 * payload is byte-identical to before and every golden fixture is unchanged.
 * Never read them directly — go through `scaleFromEpoch`, which owns the
 * "absent or unknown kind means the legacy affine" rule.
 */
export interface EpochParams {
  epoch: number;
  tick: number;
  tick_multiple: number;
  dt_ns: number;
  p0: number;
  rows: number;
  /** 0 = linear (default/absent), 1 = hybrid. */
  scale_kind?: number;
  dn_rows?: number;
  core_rows?: number;
  core_p0?: number;
  core_step?: number;
  lo_price?: number;
  hi_price?: number;
}

// --- Hot (hand-packed binary) messages -----------------------------------------

export interface DepthColumn {
  type: MsgType.DEPTH_COL;
  epoch: number;
  col_seq: number;
  t0_ns: bigint;
  mode: number; // MODE_L2 | MODE_L1_BAND | MODE_SYNTH_PROFILE
  final: boolean;
  bid: Float32Array;
  ask: Float32Array | null; // null iff mode === MODE_SYNTH_PROFILE
}

export interface BarColumn {
  type: MsgType.BAR_COL;
  epoch: number;
  col_seq: number;
  t0_ns: bigint;
  o: number;
  h: number;
  l: number;
  c: number;
  vol_buy: number;
  vol_sell: number;
  cvd_cum: number;
  vwap_num_cum: number;
  vwap_den_cum: number;
}

export interface Trade {
  type: MsgType.TRADE;
  ts_ns: bigint;
  price: number;
  size: number;
  side: number; // SIDE_BUY | SIDE_SELL | SIDE_UNKNOWN
  side_src: number; // SIDE_SRC_EXCHANGE | SIDE_SRC_INFERRED | SIDE_SRC_NA
  venue: string;
}

export interface BBO {
  type: MsgType.BBO;
  ts_ns: bigint;
  bid_px: number;
  bid_sz: number;
  ask_px: number;
  ask_sz: number;
}

export interface Ping {
  type: MsgType.PING;
  server_send_ns: bigint;
}

export interface Pong {
  type: MsgType.PONG;
  echo_ns: bigint;
  client_recv_ns: bigint;
}

export interface HistoryResponse {
  type: MsgType.HISTORY_RESP;
  req_id: number;
  epoch: number;
  oldest_available_t_ns: bigint;
  depth_cols: DepthColumn[];
  bar_cols: BarColumn[];
  markers: Marker[];
  big_trades: Trade[];
}

// --- Cold (JSON) messages ------------------------------------------------------

export interface Hello {
  type: MsgType.HELLO;
  protocol_version: number;
  session_id: string;
  grid_epoch: number;
  epoch_params: EpochParams;
  capability: Record<string, unknown>;
  norm_seed: number;
}

export interface EpochStart {
  type: MsgType.EPOCH_START;
  epoch: number;
  epoch_params: EpochParams;
}

export interface Marker {
  type: MsgType.MARKER;
  ts_ns: bigint;
  kind: MarkerKind;
  text: string;
  price: number | null;
  size: number | null;
}

export interface Status {
  type: MsgType.STATUS;
  feed_state: FeedState;
  capability: Record<string, unknown>;
  latency_ms: number;
  clock_skew_ms: number;
  next_open_ts: bigint | null;
}

export interface Subscribe {
  type: MsgType.SUBSCRIBE;
  market: string;
  symbol: string;
  mode: StreamMode;
  source: string | null;
  start_t: bigint | null;
}

export interface Unsubscribe {
  type: MsgType.UNSUBSCRIBE;
}

export interface Seek {
  type: MsgType.SEEK;
  t: bigint;
}

export interface SetSpeed {
  type: MsgType.SET_SPEED;
  x: number;
}

export interface Pause {
  type: MsgType.PAUSE;
}

export interface Resume {
  type: MsgType.RESUME;
}

export interface HistoryRequest {
  type: MsgType.HISTORY_REQ;
  req_id: number;
  before_t: bigint;
  n_cols: number;
}

/** Any decodable message. Discriminated on `type`. */
export type Msg =
  | DepthColumn
  | BarColumn
  | Trade
  | BBO
  | Ping
  | Pong
  | HistoryResponse
  | Hello
  | EpochStart
  | Marker
  | Status
  | Subscribe
  | Unsubscribe
  | Seek
  | SetSpeed
  | Pause
  | Resume
  | HistoryRequest;
