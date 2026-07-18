/**
 * FlowMap wire encoder — the client→server direction. Mirrors the framing in
 * flowmap_server.proto.wire so encoded control messages decode cleanly on the
 * server (and, in tests, round-trip through this module's own decoder).
 *
 * The client only ever sends:
 * - Cold control messages (Subscribe, Unsubscribe, Seek, SetSpeed, Pause,
 *   Resume, HistoryRequest) — UTF-8 JSON payloads flagged FLAG_JSON, keys in the
 *   struct definition order from events.py (msgspec encodes in that order).
 * - Pong (hot) — a heartbeat reply packed little-endian.
 *
 * bigint nanosecond fields are serialized as JSON integer literals via
 * JSON.rawJSON so they never lose precision (plain JSON.stringify throws on
 * bigint; casting through Number would round nanosecond timestamps).
 */

import { FLAG_JSON, MsgType, PROTO_VER, type StreamMode } from './types';

const ENVELOPE_SIZE = 8;

function ceil4(n: number): number {
  return (n + 3) & ~3;
}

/** Wrap a payload in the 8-byte envelope + zero padding to a 4-byte boundary. */
function frame(msgType: MsgType, payload: Uint8Array, flags = 0): Uint8Array {
  const out = new Uint8Array(ENVELOPE_SIZE + ceil4(payload.length));
  const dv = new DataView(out.buffer);
  dv.setUint8(0, msgType);
  dv.setUint8(1, PROTO_VER);
  dv.setUint16(2, flags, true);
  dv.setUint32(4, payload.length, true);
  out.set(payload, ENVELOPE_SIZE);
  return out; // remaining bytes are already zero (Uint8Array init)
}

const encoder = new TextEncoder();

/** Serialize to UTF-8 JSON, emitting bigints as bare integer literals. */
function jsonEncode(value: unknown): Uint8Array {
  const text = JSON.stringify(value, (_key, v) =>
    typeof v === 'bigint' ? JSON.rawJSON(v.toString()) : v,
  );
  return encoder.encode(text);
}

function coldFrame(msgType: MsgType, value: unknown): Uint8Array {
  return frame(msgType, jsonEncode(value), FLAG_JSON);
}

// --- cold control messages -----------------------------------------------------

export interface SubscribeInit {
  market: string;
  symbol: string;
  mode: StreamMode;
  source?: string | null;
  start_t?: bigint | null;
}

export function encodeSubscribe(s: SubscribeInit): Uint8Array {
  // Key order mirrors events.Subscribe: market, symbol, mode, source, start_t.
  return coldFrame(MsgType.SUBSCRIBE, {
    market: s.market,
    symbol: s.symbol,
    mode: s.mode,
    source: s.source ?? null,
    start_t: s.start_t ?? null,
  });
}

export function encodeUnsubscribe(): Uint8Array {
  return coldFrame(MsgType.UNSUBSCRIBE, {});
}

export function encodeSeek(t: bigint): Uint8Array {
  return coldFrame(MsgType.SEEK, { t });
}

export function encodeSetSpeed(x: number): Uint8Array {
  return coldFrame(MsgType.SET_SPEED, { x });
}

export function encodePause(): Uint8Array {
  return coldFrame(MsgType.PAUSE, {});
}

export function encodeResume(): Uint8Array {
  return coldFrame(MsgType.RESUME, {});
}

export interface HistoryRequestInit {
  req_id: number;
  before_t: bigint;
  n_cols: number;
}

export function encodeHistoryRequest(h: HistoryRequestInit): Uint8Array {
  // Key order mirrors events.HistoryRequest: req_id, before_t, n_cols.
  return coldFrame(MsgType.HISTORY_REQ, {
    req_id: h.req_id,
    before_t: h.before_t,
    n_cols: h.n_cols,
  });
}

// --- hot message ---------------------------------------------------------------

export function encodePong(echo_ns: bigint, client_recv_ns: bigint): Uint8Array {
  const payload = new Uint8Array(16);
  const dv = new DataView(payload.buffer);
  dv.setBigInt64(0, echo_ns, true);
  dv.setBigInt64(8, client_recv_ns, true);
  return frame(MsgType.PONG, payload);
}
