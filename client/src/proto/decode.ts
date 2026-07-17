/**
 * FlowMap v2 wire decoder — the byte-for-byte TS mirror of
 * flowmap_server.proto.wire.decode. It MUST decode the committed golden vectors
 * identically to the server, because these bytes are the cross-language stream
 * contract.
 *
 * Envelope (little-endian, 8 bytes): struct "<BBHI"
 *   u8 msg_type, u8 ver, u16 flags, u32 payload_len
 * `payload_len` is the UNPADDED payload length; on the wire the payload is
 * zero-padded up to the next 4-byte boundary and the cursor advances by the
 * padded length: next = payload_off + ceil4(payload_len).
 *
 * FLAG_JSON (0x0001) marks a cold UTF-8 JSON payload; otherwise the payload is
 * hand-packed little-endian binary (hot). Unknown msg_types are NOT errors:
 * they are skipped via payload_len (msg === null). All malformed input
 * (truncated envelope/payload, version mismatch, payload_len inconsistent with
 * the layout, venue/count overruns, bad UTF-8/JSON) throws WireError — mirroring
 * the server's single ValueError taxonomy.
 *
 * Deliberate leniency (copied from wire.py): the decoder reads exactly
 * `payload_len` payload bytes, so a FINAL message whose trailing pad bytes were
 * stripped still decodes; in that case `next` may exceed the buffer length, and
 * frame iteration terminates naturally because next > length.
 */

import {
  FLAG_JSON,
  MsgType,
  MODE_SYNTH_PROFILE,
  PROTO_VER,
  type BarColumn,
  type BBO,
  type DepthColumn,
  type HistoryResponse,
  type Marker,
  type Msg,
  type Ping,
  type Pong,
  type Trade,
} from './types';

/** Thrown for every malformed wire input (mirrors wire.py's ValueError taxonomy). */
export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireError';
  }
}

export interface DecodeResult {
  msg: Msg | null;
  next: number;
}

const ENVELOPE_SIZE = 8;
const DEPTH_HDR = 24; // <IIqBBHI>
const BAR_SIZE = 88; // <IIqddddddddd>
const TRADE_HDR = 28; // <qddBBBB>
const BBO_SIZE = 40; // <qdddd>
const PING_SIZE = 8; // <q>
const PONG_SIZE = 16; // <qq>
const HIST_HDR = 24; // <IIqHHHH>

const utf8 = new TextDecoder('utf-8', { fatal: true });

function ceil4(n: number): number {
  return (n + 3) & ~3;
}

/** Copy `count` bytes out of `view` and view them as UTF-8; throws on bad UTF-8. */
function decodeUtf8(view: DataView, byteOff: number, len: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + byteOff, len);
  try {
    return utf8.decode(bytes);
  } catch (e) {
    throw new WireError(`invalid UTF-8 in payload: ${(e as Error).message}`);
  }
}

/**
 * Read `count` little-endian f32 into a NEW Float32Array over a COPIED slice of
 * the frame. Copying (vs. a Float32Array view onto the frame buffer) both keeps
 * bid/ask arrays from pinning the potentially large frame buffer and sidesteps
 * the alignment requirement of a direct typed-array view. The wire is
 * little-endian; hosts running this client are little-endian, so the copied
 * bytes map straight onto Float32Array.
 */
function readF32(view: DataView, byteOff: number, count: number): Float32Array {
  const start = view.byteOffset + byteOff;
  return new Float32Array(view.buffer.slice(start, start + count * 4));
}

// --- lossless cold-JSON parse --------------------------------------------------

interface JsonReviverContext {
  source: string;
}

/**
 * Parse cold JSON, promoting any integer literal that exceeds JS's safe-integer
 * range to a bigint (using the raw source text via the JSON.parse reviver
 * `context.source`, Node 21+/modern browsers). This keeps nanosecond fields
 * (e.g. Marker.ts_ns) exact where a plain JSON.parse would silently round them.
 */
/**
 * Verify the runtime can preserve i64 nanosecond precision across the cold-JSON
 * boundary — i.e. `JSON.parse`'s reviver exposes `context.source` (V8 source
 * access, Chrome 114+/Safari 17.4+/Firefox 128+/Node 21+). Without it, large ns
 * integer literals would silently round to the nearest double (a 112 ns error on
 * a real timestamp). We fail LOUDLY at module load rather than corrupt timestamps
 * silently. `encode.ts` already hard-requires `JSON.rawJSON`, so this keeps both
 * directions consistent about the runtime floor.
 */
function assertLosslessJsonSupport(): void {
  let sawSource = false;
  JSON.parse('1', (_k, v, ctx?: JsonReviverContext) => {
    if (ctx !== undefined && typeof ctx.source === 'string') sawSource = true;
    return v;
  });
  if (!sawSource || typeof (JSON as { rawJSON?: unknown }).rawJSON !== 'function') {
    throw new WireError(
      'runtime lacks lossless-JSON support (JSON.parse source access / JSON.rawJSON); ' +
        'nanosecond timestamps would be corrupted — a newer browser/runtime is required',
    );
  }
}
assertLosslessJsonSupport();

function parseJsonLossless(text: string): unknown {
  const reviver = (_key: string, value: unknown, context?: JsonReviverContext): unknown => {
    if (
      typeof value === 'number' &&
      context !== undefined &&
      typeof context.source === 'string' &&
      /^-?\d+$/.test(context.source) &&
      !Number.isSafeInteger(value)
    ) {
      return BigInt(context.source);
    }
    return value;
  };
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

// --- hot decoders ((view, payload_off, payload_len) -> Msg) --------------------

function decDepth(view: DataView, off: number, plen: number): DepthColumn {
  if (plen < DEPTH_HDR) {
    throw new WireError(`DEPTH_COL payload too short: ${plen} < ${DEPTH_HDR}`);
  }
  const epoch = view.getUint32(off, true);
  const col_seq = view.getUint32(off + 4, true);
  const t0_ns = view.getBigInt64(off + 8, true);
  const mode = view.getUint8(off + 16);
  const final = view.getUint8(off + 17);
  // off + 18: u16 pad (ignored)
  const n_rows = view.getUint32(off + 20, true);
  const channels = mode === MODE_SYNTH_PROFILE ? 1 : 2;
  const expected = DEPTH_HDR + 4 * n_rows * channels;
  if (plen !== expected) {
    throw new WireError(
      `DEPTH_COL payload_len mismatch: ${plen} != ${expected} (n_rows=${n_rows}, mode=${mode})`,
    );
  }
  const f32Off = off + DEPTH_HDR;
  const bid = readF32(view, f32Off, n_rows);
  const ask = mode === MODE_SYNTH_PROFILE ? null : readF32(view, f32Off + 4 * n_rows, n_rows);
  return { type: MsgType.DEPTH_COL, epoch, col_seq, t0_ns, mode, final: final !== 0, bid, ask };
}

function decBar(view: DataView, off: number, plen: number): BarColumn {
  if (plen !== BAR_SIZE) {
    throw new WireError(`BAR_COL payload_len mismatch: ${plen} != ${BAR_SIZE}`);
  }
  const epoch = view.getUint32(off, true);
  const col_seq = view.getUint32(off + 4, true);
  const t0_ns = view.getBigInt64(off + 8, true);
  return {
    type: MsgType.BAR_COL,
    epoch,
    col_seq,
    t0_ns,
    o: view.getFloat64(off + 16, true),
    h: view.getFloat64(off + 24, true),
    l: view.getFloat64(off + 32, true),
    c: view.getFloat64(off + 40, true),
    vol_buy: view.getFloat64(off + 48, true),
    vol_sell: view.getFloat64(off + 56, true),
    cvd_cum: view.getFloat64(off + 64, true),
    vwap_num_cum: view.getFloat64(off + 72, true),
    vwap_den_cum: view.getFloat64(off + 80, true),
  };
}

function decTrade(view: DataView, off: number, plen: number): Trade {
  if (plen < TRADE_HDR + 1) {
    throw new WireError(`TRADE payload too short: ${plen} < ${TRADE_HDR + 1}`);
  }
  const ts_ns = view.getBigInt64(off, true);
  const price = view.getFloat64(off + 8, true);
  const size = view.getFloat64(off + 16, true);
  const side = view.getUint8(off + 24);
  const side_src = view.getUint8(off + 25);
  // off + 26, off + 27: two u8 pads (ignored)
  const vlenOff = off + TRADE_HDR;
  const vlen = view.getUint8(vlenOff);
  if (TRADE_HDR + 1 + vlen > plen) {
    throw new WireError(`TRADE venue overruns payload_len: ${TRADE_HDR + 1}+${vlen} > ${plen}`);
  }
  const venue = decodeUtf8(view, vlenOff + 1, vlen);
  return { type: MsgType.TRADE, ts_ns, price, size, side, side_src, venue };
}

function decBbo(view: DataView, off: number, plen: number): BBO {
  if (plen !== BBO_SIZE) {
    throw new WireError(`BBO payload_len mismatch: ${plen} != ${BBO_SIZE}`);
  }
  return {
    type: MsgType.BBO,
    ts_ns: view.getBigInt64(off, true),
    bid_px: view.getFloat64(off + 8, true),
    bid_sz: view.getFloat64(off + 16, true),
    ask_px: view.getFloat64(off + 24, true),
    ask_sz: view.getFloat64(off + 32, true),
  };
}

function decPing(view: DataView, off: number, plen: number): Ping {
  if (plen !== PING_SIZE) {
    throw new WireError(`PING payload_len mismatch: ${plen} != ${PING_SIZE}`);
  }
  return { type: MsgType.PING, server_send_ns: view.getBigInt64(off, true) };
}

function decPong(view: DataView, off: number, plen: number): Pong {
  if (plen !== PONG_SIZE) {
    throw new WireError(`PONG payload_len mismatch: ${plen} != ${PONG_SIZE}`);
  }
  return {
    type: MsgType.PONG,
    echo_ns: view.getBigInt64(off, true),
    client_recv_ns: view.getBigInt64(off + 8, true),
  };
}

function decHistory(view: DataView, off: number, plen: number): HistoryResponse {
  if (plen < HIST_HDR) {
    throw new WireError(`HISTORY_RESP payload too short: ${plen} < ${HIST_HDR}`);
  }
  const req_id = view.getUint32(off, true);
  const epoch = view.getUint32(off + 4, true);
  const oldest = view.getBigInt64(off + 8, true);
  const nDepth = view.getUint16(off + 16, true);
  const nBar = view.getUint16(off + 18, true);
  const nMarker = view.getUint16(off + 20, true);
  const nTrade = view.getUint16(off + 22, true);
  const end = off + plen;
  let cursor = off + HIST_HDR;

  const readGroup = <T extends Msg>(count: number, expected: MsgType, name: string): T[] => {
    const group: T[] = [];
    for (let i = 0; i < count; i++) {
      // Bail BEFORE decoding: a lying count must not consume messages that
      // belong to the surrounding frame.
      if (cursor + ENVELOPE_SIZE > end) {
        throw new WireError(
          `HistoryResponse: nested counts overrun payload_len (cursor=${cursor - off}, payload_len=${plen})`,
        );
      }
      const { msg, next } = decode(view, cursor);
      cursor = next;
      if (cursor > end) {
        throw new WireError('HistoryResponse: nested message overruns payload_len');
      }
      if (msg === null || msg.type !== expected) {
        throw new WireError(
          `HistoryResponse: expected nested ${name}, got ${msg === null ? 'unknown' : MsgType[msg.type]}`,
        );
      }
      group.push(msg as T);
    }
    return group;
  };

  const depth_cols = readGroup<DepthColumn>(nDepth, MsgType.DEPTH_COL, 'DEPTH_COL');
  const bar_cols = readGroup<BarColumn>(nBar, MsgType.BAR_COL, 'BAR_COL');
  const markers = readGroup<Marker>(nMarker, MsgType.MARKER, 'MARKER');
  const big_trades = readGroup<Trade>(nTrade, MsgType.TRADE, 'TRADE');

  return {
    type: MsgType.HISTORY_RESP,
    req_id,
    epoch,
    oldest_available_t_ns: oldest,
    depth_cols,
    bar_cols,
    markers,
    big_trades,
  };
}

type HotDecoder = (view: DataView, off: number, plen: number) => Msg;

const HOT_DECODERS: Partial<Record<number, HotDecoder>> = {
  [MsgType.DEPTH_COL]: decDepth,
  [MsgType.BAR_COL]: decBar,
  [MsgType.TRADE]: decTrade,
  [MsgType.BBO]: decBbo,
  [MsgType.PING]: decPing,
  [MsgType.PONG]: decPong,
  [MsgType.HISTORY_RESP]: decHistory,
};

const COLD_IDS = new Set<number>([
  MsgType.HELLO,
  MsgType.EPOCH_START,
  MsgType.MARKER,
  MsgType.STATUS,
  MsgType.SUBSCRIBE,
  MsgType.UNSUBSCRIBE,
  MsgType.SEEK,
  MsgType.SET_SPEED,
  MsgType.PAUSE,
  MsgType.RESUME,
  MsgType.HISTORY_REQ,
]);

// --- public API ----------------------------------------------------------------

/**
 * Decode one message at `offset`; return `{ msg, next }`.
 * Unknown msg_types are skipped via payload_len → `{ msg: null, next }`.
 */
export function decode(view: DataView, offset = 0): DecodeResult {
  if (view.byteLength - offset < ENVELOPE_SIZE) {
    throw new WireError('truncated envelope');
  }
  const msgType = view.getUint8(offset);
  const ver = view.getUint8(offset + 1);
  const flags = view.getUint16(offset + 2, true);
  const plen = view.getUint32(offset + 4, true);
  if (ver !== PROTO_VER) {
    throw new WireError(`protocol version mismatch: got ${ver}, expected ${PROTO_VER}`);
  }
  const payloadOff = offset + ENVELOPE_SIZE;
  if (payloadOff + plen > view.byteLength) {
    throw new WireError('truncated payload');
  }
  const next = payloadOff + ceil4(plen);

  if (flags & FLAG_JSON) {
    if (!COLD_IDS.has(msgType)) {
      return { msg: null, next }; // unknown cold type: skip
    }
    const text = decodeUtf8(view, payloadOff, plen);
    let parsed: unknown;
    try {
      parsed = parseJsonLossless(text);
    } catch (e) {
      throw new WireError(`malformed 0x${msgType.toString(16)} JSON payload: ${(e as Error).message}`);
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new WireError(`malformed 0x${msgType.toString(16)} JSON payload: not an object`);
    }
    const msg = { type: msgType, ...(parsed as Record<string, unknown>) } as unknown as Msg;
    return { msg, next };
  }

  const dec = HOT_DECODERS[msgType];
  if (dec === undefined) {
    return { msg: null, next }; // unknown hot type: skip
  }
  return { msg: dec(view, payloadOff, plen), next };
}

/**
 * Decode a whole frame (one or more concatenated messages) into a list.
 * Unknown message types are skipped (not appended). Iteration stops when the
 * cursor reaches — or, under the stripped-pad leniency, passes — the buffer end.
 */
export function decodeFrame(buf: ArrayBuffer | Uint8Array): Msg[] {
  const view =
    buf instanceof Uint8Array
      ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      : new DataView(buf);
  const out: Msg[] = [];
  let off = 0;
  while (off < view.byteLength) {
    const { msg, next } = decode(view, off);
    if (msg !== null) {
      out.push(msg);
    }
    // decode always advances by at least the 8-byte envelope, so this strictly
    // increases; the guard is defensive against a future zero-length regression.
    if (next <= off) {
      throw new WireError('decode did not advance');
    }
    off = next;
  }
  return out;
}
