import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decode, decodeFrame, WireError } from './decode';
import {
  encodeHistoryRequest,
  encodePause,
  encodePong,
  encodeResume,
  encodeSeek,
  encodeSetSpeed,
  encodeSubscribe,
  encodeUnsubscribe,
} from './encode';
import {
  MODE_L1_BAND,
  MODE_L2,
  MODE_SYNTH_PROFILE,
  MsgType,
  SIDE_BUY,
  SIDE_SELL,
  SIDE_SRC_EXCHANGE,
  SIDE_SRC_INFERRED,
  type Msg,
} from './types';

// The golden .bin files are the server's committed wire vectors, synced into
// client/tests/golden/ by scripts/sync-golden.mjs. The expected values below are
// transcribed from wire.golden_fixture_events(); t0 is the fixed ns timestamp
// baked into that fixture (2025-07-17T00:00:00Z).
const T0 = 1_752_710_400_000_000_000n;

// Resolve golden files relative to this test file. Deriving the directory from
// fileURLToPath(import.meta.url) (rather than `new URL(literal, import.meta.url)`)
// deliberately avoids Vite's import-meta-url asset transform, which rewrites that
// pattern and breaks runtime path resolution.
const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'golden');

function goldenAB(name: string): ArrayBuffer {
  const b = readFileSync(join(GOLDEN_DIR, `${name}.bin`));
  // Copy into a fresh, exactly-sized ArrayBuffer: Node Buffers can be views over
  // a shared pool with a nonzero byteOffset.
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function goldenView(name: string): DataView {
  return new DataView(goldenAB(name));
}

function decodeOne(name: string): Msg {
  const { msg } = decode(goldenView(name));
  if (msg === null) throw new Error(`${name} decoded to null (skipped)`);
  return msg;
}

/** Narrow a Msg to a specific variant so field access type-checks in the test. */
function assertType<T extends MsgType>(
  msg: Msg,
  type: T,
): asserts msg is Extract<Msg, { type: T }> {
  if (msg.type !== type) {
    throw new Error(`expected ${MsgType[type]}, got ${MsgType[msg.type]}`);
  }
}

describe('golden vectors — hot messages decode byte-exact', () => {
  it('hot_depth_col_l2', () => {
    const msg = decodeOne('hot_depth_col_l2');
    assertType(msg, MsgType.DEPTH_COL);
    expect(msg.epoch).toBe(3);
    expect(msg.col_seq).toBe(41);
    expect(msg.t0_ns).toBe(T0);
    expect(msg.mode).toBe(MODE_L2);
    expect(msg.final).toBe(true);
    // Bit-exact f32 arrays (all values are exactly representable in float32).
    expect(msg.bid).toEqual(new Float32Array([0.0, 1.5, 2.25, 3.0, 4.5, 5.75, 6.0, 7.125]));
    expect(msg.ask).toEqual(new Float32Array([8.0, 7.5, 6.25, 5.0, 4.5, 3.75, 2.0, 1.125]));
  });

  it('hot_depth_col_l1_band', () => {
    const msg = decodeOne('hot_depth_col_l1_band');
    assertType(msg, MsgType.DEPTH_COL);
    expect(msg.epoch).toBe(3);
    expect(msg.col_seq).toBe(42);
    expect(msg.t0_ns).toBe(T0 + 250_000_000n);
    expect(msg.mode).toBe(MODE_L1_BAND);
    expect(msg.final).toBe(false);
    expect(msg.bid).toEqual(new Float32Array([10.5, 11.25, 12.0, 13.5]));
    expect(msg.ask).toEqual(new Float32Array([9.0, 8.25, 7.5, 6.75]));
  });

  it('hot_depth_col_synth_profile (single-channel: ask omitted)', () => {
    const msg = decodeOne('hot_depth_col_synth_profile');
    assertType(msg, MsgType.DEPTH_COL);
    expect(msg.epoch).toBe(4);
    expect(msg.col_seq).toBe(0);
    expect(msg.t0_ns).toBe(T0 + 500_000_000n);
    expect(msg.mode).toBe(MODE_SYNTH_PROFILE);
    expect(msg.final).toBe(true);
    expect(msg.bid).toEqual(new Float32Array([0.125, 0.25, 0.5, 1.0, 2.0, 4.0]));
    expect(msg.ask).toBeNull();
  });

  it('hot_bar_col', () => {
    const msg = decodeOne('hot_bar_col');
    assertType(msg, MsgType.BAR_COL);
    expect(msg.epoch).toBe(3);
    expect(msg.col_seq).toBe(41);
    expect(msg.t0_ns).toBe(T0);
    expect(msg.o).toBe(100.25);
    expect(msg.h).toBe(101.5);
    expect(msg.l).toBe(99.75);
    expect(msg.c).toBe(100.875);
    expect(msg.vol_buy).toBe(12.5);
    expect(msg.vol_sell).toBe(7.25);
    expect(msg.cvd_cum).toBe(5.25);
    expect(msg.vwap_num_cum).toBe(125031.25);
    expect(msg.vwap_den_cum).toBe(1250.0);
  });

  it('hot_trade_exchange (venue "binance", buy, exchange-tagged)', () => {
    const msg = decodeOne('hot_trade_exchange');
    assertType(msg, MsgType.TRADE);
    expect(msg.ts_ns).toBe(T0 + 1_000n);
    expect(msg.price).toBe(100.5);
    expect(msg.size).toBe(2.5);
    expect(msg.side).toBe(SIDE_BUY);
    expect(msg.side_src).toBe(SIDE_SRC_EXCHANGE);
    expect(msg.venue).toBe('binance');
  });

  it('hot_trade_inferred (venue "iex", sell, inferred)', () => {
    const msg = decodeOne('hot_trade_inferred');
    assertType(msg, MsgType.TRADE);
    expect(msg.ts_ns).toBe(T0 + 2_000n);
    expect(msg.price).toBe(100.25);
    expect(msg.size).toBe(0.75);
    expect(msg.side).toBe(SIDE_SELL);
    expect(msg.side_src).toBe(SIDE_SRC_INFERRED);
    expect(msg.venue).toBe('iex');
  });

  it('hot_bbo', () => {
    const msg = decodeOne('hot_bbo');
    assertType(msg, MsgType.BBO);
    expect(msg.ts_ns).toBe(T0 + 3_000n);
    expect(msg.bid_px).toBe(100.25);
    expect(msg.bid_sz).toBe(17.5);
    expect(msg.ask_px).toBe(100.5);
    expect(msg.ask_sz).toBe(4.25);
  });

  it('hot_ping', () => {
    const msg = decodeOne('hot_ping');
    assertType(msg, MsgType.PING);
    expect(msg.server_send_ns).toBe(T0 + 4_000n);
  });

  it('hot_pong', () => {
    const msg = decodeOne('hot_pong');
    assertType(msg, MsgType.PONG);
    expect(msg.echo_ns).toBe(T0 + 4_000n);
    expect(msg.client_recv_ns).toBe(T0 + 5_000n);
  });
});

describe('golden vectors — cold (JSON) messages decode byte-exact', () => {
  it('cold_hello (nested epoch_params + capability dict)', () => {
    const msg = decodeOne('cold_hello');
    assertType(msg, MsgType.HELLO);
    expect(msg.protocol_version).toBe(1);
    expect(msg.session_id).toBe('golden-session-0001');
    expect(msg.grid_epoch).toBe(3);
    expect(msg.epoch_params).toEqual({
      epoch: 3,
      tick: 0.01,
      tick_multiple: 5,
      dt_ns: 250_000_000,
      p0: 100.0,
      rows: 2048,
    });
    expect(msg.capability).toEqual({ depth: 'L2', trades: 'full', bbo: 'native' });
    expect(msg.norm_seed).toBe(42.5);
  });

  it('cold_subscribe (source set, start_t null)', () => {
    const msg = decodeOne('cold_subscribe');
    assertType(msg, MsgType.SUBSCRIBE);
    expect(msg.market).toBe('crypto');
    expect(msg.symbol).toBe('BTCUSDT');
    expect(msg.mode).toBe('live');
    expect(msg.source).toBe('crypcodile');
    expect(msg.start_t).toBeNull();
  });
});

describe('golden vector — HistoryResponse nested framing', () => {
  it('hot_history_resp_nested decodes header + 4 nested groups', () => {
    const msg = decodeOne('hot_history_resp_nested');
    assertType(msg, MsgType.HISTORY_RESP);
    expect(msg.req_id).toBe(7);
    expect(msg.epoch).toBe(3);
    expect(msg.oldest_available_t_ns).toBe(T0 - 86_400_000_000_000n);

    expect(msg.depth_cols).toHaveLength(1);
    expect(msg.bar_cols).toHaveLength(1);
    expect(msg.markers).toHaveLength(1);
    expect(msg.big_trades).toHaveLength(1);

    // Nested depth col == the standalone hot_depth_col_l2 golden.
    const depth = msg.depth_cols[0];
    expect(depth.col_seq).toBe(41);
    expect(depth.bid).toEqual(new Float32Array([0.0, 1.5, 2.25, 3.0, 4.5, 5.75, 6.0, 7.125]));

    // Nested bar.
    expect(msg.bar_cols[0].c).toBe(100.875);

    // Nested marker is a COLD (JSON) message with a huge ns timestamp — its
    // integer literal must survive JSON parsing losslessly (bigint).
    const marker = msg.markers[0];
    expect(marker.ts_ns).toBe(T0 + 6_000n);
    expect(marker.kind).toBe('liquidation');
    expect(marker.text).toBe('liq 2.5 @ 100.5');
    expect(marker.price).toBe(100.5);
    expect(marker.size).toBe(2.5);

    // Nested trade.
    expect(msg.big_trades[0].venue).toBe('binance');
    expect(msg.big_trades[0].ts_ns).toBe(T0 + 1_000n);
  });
});

describe('envelope parse + framing behavior', () => {
  it('parses the 8-byte little-endian envelope and advances by padded length', () => {
    // hot_trade_inferred: plen=32 (already 4-aligned), total 40.
    const view = goldenView('hot_trade_inferred');
    const { next } = decode(view, 0);
    expect(next).toBe(view.byteLength);
    expect(next).toBe(40);
  });

  it('cold envelope advances past the zero pad (plen not 4-aligned)', () => {
    // cold_hello: plen=246, total=256 -> next = 8 + ceil4(246) = 256.
    const view = goldenView('cold_hello');
    const { next } = decode(view, 0);
    expect(next).toBe(256);
    expect(next).toBe(view.byteLength);
  });

  it('unknown msg_type (0x3F) is skipped via payload_len (msg null, cursor advances)', () => {
    const buf = new Uint8Array(12);
    const dv = new DataView(buf.buffer);
    dv.setUint8(0, 0x3f); // unknown data tag
    dv.setUint8(1, 1); // PROTO_VER
    dv.setUint16(2, 0, true); // flags: hot
    dv.setUint32(4, 4, true); // payload_len = 4
    const { msg, next } = decode(dv, 0);
    expect(msg).toBeNull();
    expect(next).toBe(12); // 8 + ceil4(4)
    // decodeFrame drops the skipped message.
    expect(decodeFrame(buf)).toHaveLength(0);
  });

  it('two goldens concatenated decode as a 2-message frame ending exactly at buffer end', () => {
    const a = new Uint8Array(goldenAB('hot_ping')); // 16 bytes
    const b = new Uint8Array(goldenAB('hot_bbo')); // 48 bytes
    const cat = new Uint8Array(a.length + b.length);
    cat.set(a, 0);
    cat.set(b, a.length);

    const msgs = decodeFrame(cat);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe(MsgType.PING);
    expect(msgs[1].type).toBe(MsgType.BBO);

    // Cursor lands exactly on each boundary and on the buffer end.
    const view = new DataView(cat.buffer);
    const r1 = decode(view, 0);
    expect(r1.next).toBe(16);
    const r2 = decode(view, 16);
    expect(r2.next).toBe(64);
    expect(r2.next).toBe(cat.length);
  });

  it('DEPTH_COL bid is a bit-equal Float32Array (not a view onto the frame)', () => {
    const view = goldenView('hot_depth_col_l2');
    const msg = decode(view).msg;
    assertType(msg!, MsgType.DEPTH_COL);
    const expected = new Float32Array([0.0, 1.5, 2.25, 3.0, 4.5, 5.75, 6.0, 7.125]);
    // Byte-level equality of the underlying f32 bits.
    expect(new Uint8Array(msg.bid.buffer)).toEqual(new Uint8Array(expected.buffer));
    // And it is a copy: its buffer is not the frame buffer.
    expect(msg.bid.buffer).not.toBe(view.buffer);
    expect(msg.bid.byteLength).toBe(32);
  });
});

describe('robustness — malformed input throws WireError', () => {
  it('truncated envelope (< 8 bytes) throws', () => {
    const view = new DataView(new ArrayBuffer(4));
    expect(() => decode(view)).toThrow(WireError);
    expect(() => decode(view)).toThrow(/truncated envelope/);
  });

  it('truncated payload (buffer shorter than payload_len) throws', () => {
    const ab = goldenAB('hot_bbo').slice(0, 40); // plen says 40, only 32 payload bytes remain
    expect(() => decode(new DataView(ab))).toThrow(/truncated payload/);
  });

  it('lying payload_len inconsistent with a fixed-size layout throws', () => {
    const bytes = new Uint8Array(goldenAB('hot_ping')); // real plen = 8
    new DataView(bytes.buffer).setUint32(4, 4, true); // lie: plen = 4 (still in-buffer)
    expect(() => decode(new DataView(bytes.buffer))).toThrow(/PING payload_len mismatch/);
  });

  it('lying n_rows inconsistent with DEPTH_COL payload_len throws', () => {
    const bytes = new Uint8Array(goldenAB('hot_depth_col_l2')); // plen=88, n_rows=8
    // n_rows lives at message offset 8(env)+20(hdr) = 28.
    new DataView(bytes.buffer).setUint32(28, 9, true); // 24 + 4*9*2 = 96 != 88
    expect(() => decode(new DataView(bytes.buffer))).toThrow(/DEPTH_COL payload_len mismatch/);
  });

  it('TRADE venue length overrunning payload_len throws', () => {
    const bytes = new Uint8Array(goldenAB('hot_trade_inferred'));
    // venue-length u8 sits right after the 28-byte trade header: msg offset 8+28 = 36.
    new DataView(bytes.buffer).setUint8(36, 200); // 28 + 1 + 200 > plen(32)
    expect(() => decode(new DataView(bytes.buffer))).toThrow(/venue overruns/);
  });

  it('malformed cold JSON throws WireError (not a raw SyntaxError)', () => {
    const payload = new TextEncoder().encode('{ this is not json');
    const buf = new Uint8Array(8 + ((payload.length + 3) & ~3));
    const dv = new DataView(buf.buffer);
    dv.setUint8(0, MsgType.SUBSCRIBE);
    dv.setUint8(1, 1);
    dv.setUint16(2, 0x0001, true); // FLAG_JSON
    dv.setUint32(4, payload.length, true);
    buf.set(payload, 8);
    expect(() => decode(dv)).toThrow(WireError);
    expect(() => decode(dv)).toThrow(/JSON payload/);
  });

  it('protocol version mismatch throws', () => {
    const bytes = new Uint8Array(goldenAB('hot_ping'));
    new DataView(bytes.buffer).setUint8(1, 2); // ver = 2
    expect(() => decode(new DataView(bytes.buffer))).toThrow(/version mismatch/);
  });
});

describe('encode ↔ decode round-trip (control messages)', () => {
  function roundTrip(bytes: Uint8Array): Msg {
    const msgs = decodeFrame(bytes);
    expect(msgs).toHaveLength(1);
    return msgs[0];
  }

  it('Subscribe (source + null start_t)', () => {
    const msg = roundTrip(encodeSubscribe({ market: 'crypto', symbol: 'BTCUSDT', mode: 'live', source: 'crypcodile' }));
    assertType(msg, MsgType.SUBSCRIBE);
    expect(msg.market).toBe('crypto');
    expect(msg.symbol).toBe('BTCUSDT');
    expect(msg.mode).toBe('live');
    expect(msg.source).toBe('crypcodile');
    expect(msg.start_t).toBeNull();
  });

  it('Subscribe (replay with a large ns start_t survives as bigint)', () => {
    const start = T0 + 123_456_789n;
    const msg = roundTrip(encodeSubscribe({ market: 'equity', symbol: 'AAPL', mode: 'replay', source: null, start_t: start }));
    assertType(msg, MsgType.SUBSCRIBE);
    expect(msg.mode).toBe('replay');
    expect(msg.source).toBeNull();
    expect(msg.start_t).toBe(start);
  });

  it('Unsubscribe (empty payload)', () => {
    const msg = roundTrip(encodeUnsubscribe());
    expect(msg.type).toBe(MsgType.UNSUBSCRIBE);
  });

  it('Seek (large ns timestamp)', () => {
    const t = T0 + 999_000_000n;
    const msg = roundTrip(encodeSeek(t));
    assertType(msg, MsgType.SEEK);
    expect(msg.t).toBe(t);
  });

  it('SetSpeed', () => {
    const msg = roundTrip(encodeSetSpeed(2.5));
    assertType(msg, MsgType.SET_SPEED);
    expect(msg.x).toBe(2.5);
  });

  it('Pause / Resume', () => {
    expect(roundTrip(encodePause()).type).toBe(MsgType.PAUSE);
    expect(roundTrip(encodeResume()).type).toBe(MsgType.RESUME);
  });

  it('HistoryRequest (large ns before_t)', () => {
    const before = T0 - 60_000_000_000n;
    const msg = roundTrip(encodeHistoryRequest({ req_id: 42, before_t: before, n_cols: 500 }));
    assertType(msg, MsgType.HISTORY_REQ);
    expect(msg.req_id).toBe(42);
    expect(msg.before_t).toBe(before);
    expect(msg.n_cols).toBe(500);
  });

  it('Pong (hot) round-trips its two i64 fields', () => {
    const echo = T0 + 4_000n;
    const recv = T0 + 5_000n;
    const msg = roundTrip(encodePong(echo, recv));
    assertType(msg, MsgType.PONG);
    expect(msg.echo_ns).toBe(echo);
    expect(msg.client_recv_ns).toBe(recv);
  });

  it('encoded Pong is byte-identical to the hot_pong golden', () => {
    const encoded = encodePong(T0 + 4_000n, T0 + 5_000n);
    expect(encoded).toEqual(new Uint8Array(goldenAB('hot_pong')));
  });

  it('encoded Subscribe is byte-identical to the cold_subscribe golden', () => {
    const encoded = encodeSubscribe({ market: 'crypto', symbol: 'BTCUSDT', mode: 'live', source: 'crypcodile' });
    expect(encoded).toEqual(new Uint8Array(goldenAB('cold_subscribe')));
  });
});
