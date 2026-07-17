import struct

import pytest

from flowmap_server.proto import wire, events


def test_envelope_layout():
    ev = events.Ping(server_send_ns=123)
    buf = wire.encode(ev)
    t, ver, flags, plen = struct.unpack_from("<BBHI", buf, 0)
    assert (t, ver) == (0x09, wire.PROTO_VER) and plen == 8  # <q> unpadded length


def test_depth_col_roundtrip_and_alignment():
    import numpy as np
    ev = events.DepthColumn(epoch=1, col_seq=7, t0_ns=10**18, mode=0, final=True,
                            bid=np.arange(8, dtype=np.float32), ask=np.ones(8, dtype=np.float32))
    buf = wire.encode(ev)
    assert wire.payload_f32_offset(buf) % 4 == 0
    out, nxt = wire.decode(buf, 0)
    assert nxt == len(buf)
    assert out.col_seq == 7 and out.final and np.array_equal(out.bid, ev.bid)


def test_synth_profile_omits_ask():
    import numpy as np
    ev = events.DepthColumn(epoch=0, col_seq=1, t0_ns=0, mode=2, final=True,
                            bid=np.ones(4, dtype=np.float32), ask=None)
    out, _ = wire.decode(wire.encode(ev), 0)
    assert out.mode == 2 and out.ask is None and len(out.bid) == 4


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


def test_history_response_nested_roundtrip():
    import numpy as np
    d = events.DepthColumn(epoch=0, col_seq=2, t0_ns=1000, mode=0, final=True,
                           bid=np.ones(4, dtype=np.float32), ask=np.ones(4, dtype=np.float32))
    t = events.Trade(ts_ns=1001, price=10.5, size=3.0, side=0, side_src=0, venue="binance")
    hr = events.HistoryResponse(req_id=9, epoch=0, oldest_available_t_ns=500,
                                depth_cols=[d], bar_cols=[], markers=[], big_trades=[t])
    out, nxt = wire.decode(wire.encode(hr), 0)
    assert out.req_id == 9 and len(out.depth_cols) == 1 and out.big_trades[0].venue == "binance"


def test_multi_message_frame_iteration():
    import numpy as np
    msgs = [events.Ping(server_send_ns=1),
            events.BBO(ts_ns=2, bid_px=9.5, bid_sz=10.0, ask_px=9.6, ask_sz=4.0),
            events.Trade(ts_ns=3, price=9.55, size=1.0, side=1, side_src=0, venue="okx")]
    frame = b"".join(wire.encode(m) for m in msgs)
    off, seen = 0, []
    while off < len(frame):
        ev, off = wire.decode(frame, off)
        seen.append(type(ev).__name__)
    assert seen == ["Ping", "BBO", "Trade"] and off == len(frame)


def test_truncated_envelope_raises():
    buf = wire.encode(events.Ping(server_send_ns=1))
    with pytest.raises(ValueError):
        wire.decode(buf[:5], 0)


def test_truncated_payload_raises():
    buf = wire.encode(events.BBO(ts_ns=1, bid_px=1.0, bid_sz=1.0, ask_px=1.0, ask_sz=1.0))
    with pytest.raises(ValueError):
        wire.decode(buf[:12], 0)  # full envelope (plen=40), payload cut short


def test_version_mismatch_raises():
    buf = bytearray(wire.encode(events.Ping(server_send_ns=1)))
    buf[1] = wire.PROTO_VER + 1
    with pytest.raises(ValueError):
        wire.decode(bytes(buf), 0)


def test_lying_bar_plen_raises_not_neighbor_decode():
    # BAR_COL envelope claiming plen=4 in a batched frame must NOT silently
    # decode the neighboring Ping's bytes as bar fields.
    frame = (struct.pack("<BBHI", 0x04, wire.PROTO_VER, 0, 4) + b"\x00" * 4
             + wire.encode(events.Ping(server_send_ns=1)))
    with pytest.raises(ValueError):
        wire.decode(frame, 0)


def test_depth_n_rows_plen_mismatch_raises():
    # header claims n_rows=64 but plen=24: must not read 512 neighbor bytes
    hdr = struct.pack("<IIqBBHI", 0, 0, 0, 0, 1, 0, 64)
    frame = struct.pack("<BBHI", 0x03, wire.PROTO_VER, 0, 24) + hdr + b"\x00" * 512
    with pytest.raises(ValueError):
        wire.decode(frame, 0)


def test_trade_vlen_overrun_raises():
    buf = bytearray(wire.encode(events.Trade(ts_ns=1, price=1.0, size=1.0,
                                             side=0, side_src=0, venue="okx")))
    buf[36] = 200  # venue length byte (offset 8 envelope + 28 fixed header)
    with pytest.raises(ValueError):
        wire.decode(bytes(buf), 0)


def test_encoder_validations_raise():
    import numpy as np
    with pytest.raises(ValueError):  # venue > 255 UTF-8 bytes
        wire.encode(events.Trade(ts_ns=1, price=1.0, size=1.0, side=0, side_src=0,
                                 venue="v" * 256))
    with pytest.raises(ValueError):  # bid/ask length mismatch
        wire.encode(events.DepthColumn(epoch=0, col_seq=0, t0_ns=0, mode=0, final=True,
                                       bid=np.ones(4, dtype=np.float32),
                                       ask=np.ones(3, dtype=np.float32)))
    with pytest.raises(ValueError):  # SYNTH_PROFILE must not carry ask
        wire.encode(events.DepthColumn(epoch=0, col_seq=0, t0_ns=0, mode=2, final=True,
                                       bid=np.ones(4, dtype=np.float32),
                                       ask=np.ones(4, dtype=np.float32)))
    with pytest.raises(ValueError):  # non-SYNTH modes require ask
        wire.encode(events.DepthColumn(epoch=0, col_seq=0, t0_ns=0, mode=0, final=True,
                                       bid=np.ones(4, dtype=np.float32), ask=None))


def test_zero_row_depth_roundtrip():
    import numpy as np
    ev = events.DepthColumn(epoch=1, col_seq=0, t0_ns=0, mode=0, final=False,
                            bid=np.zeros(0, dtype=np.float32),
                            ask=np.zeros(0, dtype=np.float32))
    buf = wire.encode(ev)
    out, nxt = wire.decode(buf, 0)
    assert nxt == len(buf) == 32  # envelope 8 + fixed header 24, no f32 data
    assert len(out.bid) == 0 and out.ask is not None and len(out.ask) == 0 and not out.final


def test_golden_vectors_stable():
    import pathlib
    from flowmap_server.proto.wire import golden_fixture_events
    d = pathlib.Path(__file__).parent / "golden"
    for name, ev in golden_fixture_events().items():
        assert wire.encode(ev) == (d / f"{name}.bin").read_bytes(), name
