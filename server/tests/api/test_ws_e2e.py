"""The M1 acceptance e2e (plan Task 8): real uvicorn + binary WS + sim feed.

Boots an actual uvicorn server in-process (fresh per test: sessions must not
leak between tests), connects with the ``websockets`` client, and exercises
the full path: Subscribe -> Hello/EpochStart/snapshot -> live columns with
partial->final transitions -> Ping/Pong -> HistoryRequest -> malformed-frame
close -> shared-session refcounting across two connections.

The server-path sim feed is REALTIME (dt=250 ms => 4 finalized columns/s),
so "&ge;3 live columns within 3 s" holds with margin. The first connection
subscribes into a brand-new session whose grid is empty, so ITS snapshot has
no columns; snapshot depth-column delivery is asserted on the second
connection, which attaches to the warm shared session.
"""

from __future__ import annotations

import asyncio
import socket
import time

import httpx
import pytest
import uvicorn
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from flowmap_server.api.app import create_app
from flowmap_server.config import Config
from flowmap_server.proto import events, wire

DT_NS = 250_000_000  # Config.dt_crypto_ns drives the sim session cadence

SUB = events.Subscribe(market="sim", symbol="SIM-DEMO", mode="live")


def decode_frame(buf: bytes) -> list:
    """Decode every message batched into one binary WS frame (skip unknowns)."""
    out = []
    offset = 0
    while offset < len(buf):
        ev, offset = wire.decode(buf, offset)
        if ev is not None:
            out.append(ev)
    return out


@pytest.fixture
def port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
async def server(port):
    """Real in-process uvicorn over create_app(Config); readiness-polled."""
    cfg = Config(port=port)
    app = create_app(cfg)
    srv = uvicorn.Server(
        uvicorn.Config(app, host=cfg.host, port=cfg.port, log_level="warning")
    )
    task = asyncio.create_task(srv.serve(), name="uvicorn-e2e")
    async with httpx.AsyncClient() as probe:
        for _ in range(200):
            try:
                r = await probe.get(f"http://127.0.0.1:{port}/api/health")
                if r.status_code == 200:
                    break
            except httpx.TransportError:
                pass
            await asyncio.sleep(0.025)
        else:
            task.cancel()
            raise RuntimeError("uvicorn did not become ready")
    yield port
    srv.should_exit = True
    await task
    # Feed tasks outlive disconnects by the 60 s teardown grace; cancel them
    # so the test event loop closes without pending-task warnings.
    for session in list(app.state.manager._sessions.values()):
        if session.run_task is not None:
            session.run_task.cancel()
    await asyncio.sleep(0)


async def test_subscribe_live_stream_and_history(server):
    port = server
    async with connect(f"ws://127.0.0.1:{port}/ws") as ws:
        await ws.send(wire.encode(SUB))

        all_events: list = []
        finals: list[events.DepthColumn] = []
        bars: list[events.BarColumn] = []
        partial_seen = False
        pings = 0

        async with asyncio.timeout(10):
            while len(finals) < 3 or pings < 1 or not partial_seen:
                frame = await ws.recv()
                assert isinstance(frame, bytes), "protocol is binary-only"
                for ev in decode_frame(frame):
                    all_events.append(ev)
                    if isinstance(ev, events.DepthColumn):
                        if ev.final:
                            finals.append(ev)
                        else:
                            partial_seen = True
                    elif isinstance(ev, events.BarColumn):
                        bars.append(ev)
                    elif isinstance(ev, events.Ping):
                        pings += 1
                        await ws.send(
                            wire.encode(
                                events.Pong(
                                    echo_ns=ev.server_send_ns,
                                    client_recv_ns=time.monotonic_ns(),
                                )
                            )
                        )

        # FIRST decoded message overall is Hello with sane fields.
        hello = all_events[0]
        assert isinstance(hello, events.Hello)
        assert hello.protocol_version == 1
        assert hello.session_id

        # EpochStart precedes any DepthColumn.
        i_epoch = next(
            i for i, e in enumerate(all_events) if isinstance(e, events.EpochStart)
        )
        i_depth = next(
            i for i, e in enumerate(all_events) if isinstance(e, events.DepthColumn)
        )
        assert i_epoch < i_depth

        # >=3 live finalized columns, strictly increasing col_seq, and the
        # final flag transitions (>=1 partial re-emission observed).
        seqs = [c.col_seq for c in finals]
        assert len(seqs) >= 3
        assert all(b > a for a, b in zip(seqs, seqs[1:]))
        assert partial_seen

        # BarColumns present; session-cumulative vwap denominator never
        # decreases across the stream (partials included).
        assert bars
        dens = [b.vwap_den_cum for b in bars]
        assert all(d2 >= d1 for d1, d2 in zip(dens, dens[1:]))

        assert pings >= 1

        # HistoryRequest against the live right edge -> ONE frame carrying
        # (optionally EpochStarts +) the HistoryResponse.
        # before_t is the right edge rather than the first live col t0: the
        # first live column of a fresh session is t0=0 (sim start_ns=0), and
        # history(before_t) is exclusive, so the letter-of-the-plan request
        # would legally return an empty intersection — this asserts strictly
        # more (a non-empty response with the same req_id/oldest contracts).
        before_t = finals[-1].t0_ns + DT_NS
        await ws.send(
            wire.encode(events.HistoryRequest(req_id=9, before_t=before_t, n_cols=32))
        )
        resp = None
        async with asyncio.timeout(5):
            while resp is None:
                evs = decode_frame(await ws.recv())
                resp = next(
                    (e for e in evs if isinstance(e, events.HistoryResponse)), None
                )
                if resp is not None:
                    others = [e for e in evs if e is not resp]
                    assert all(isinstance(e, events.EpochStart) for e in others)
        assert resp.req_id == 9
        assert resp.oldest_available_t_ns <= before_t
        assert 1 <= len(resp.depth_cols) <= 32
        assert len(resp.bar_cols) == len(resp.depth_cols)
        assert all(c.final for c in resp.depth_cols)


async def test_malformed_frame_closes_1002(server):
    port = server
    async with connect(f"ws://127.0.0.1:{port}/ws") as ws:
        await ws.send(b"\xff" * 7)  # truncated envelope -> ValueError in decode
        with pytest.raises(ConnectionClosed) as ei:
            async with asyncio.timeout(5):
                while True:
                    await ws.recv()
    exc = ei.value
    assert exc.rcvd is not None
    assert exc.rcvd.code == 1002


async def test_shared_session_two_clients(server):
    port = server
    ws1 = await connect(f"ws://127.0.0.1:{port}/ws")
    try:
        await ws1.send(wire.encode(SUB))
        hello1: events.Hello | None = None
        finals1: list[events.DepthColumn] = []
        async with asyncio.timeout(10):
            while len(finals1) < 2:
                for ev in decode_frame(await ws1.recv()):
                    if isinstance(ev, events.Hello) and hello1 is None:
                        hello1 = ev
                    elif isinstance(ev, events.DepthColumn) and ev.final:
                        finals1.append(ev)
        assert hello1 is not None

        async with connect(f"ws://127.0.0.1:{port}/ws") as ws2:
            await ws2.send(wire.encode(SUB))
            evs2: list = []
            async with asyncio.timeout(10):
                while not any(isinstance(e, events.DepthColumn) for e in evs2):
                    evs2.extend(decode_frame(await ws2.recv()))

            # Same Session serves both connections (shared feed+grid).
            hello2 = evs2[0]
            assert isinstance(hello2, events.Hello)
            assert hello2.session_id == hello1.session_id

            # Warm-session snapshot: the FIRST depth column ws2 sees is a
            # finalized snapshot column, delivered before any live partial.
            first_depth2 = next(
                e for e in evs2 if isinstance(e, events.DepthColumn)
            )
            assert first_depth2.final

            # First client disconnects (refcount 2 -> 1): the second client
            # must keep receiving fresh live columns.
            await ws1.close()
            later: list[events.DepthColumn] = []
            async with asyncio.timeout(10):
                while len(later) < 2:
                    for ev in decode_frame(await ws2.recv()):
                        if isinstance(ev, events.DepthColumn) and ev.final:
                            later.append(ev)
            seqs = [c.col_seq for c in later]
            assert all(b > a for a, b in zip(seqs, seqs[1:]))
            assert later[-1].col_seq > finals1[-1].col_seq
    finally:
        await ws1.close()
