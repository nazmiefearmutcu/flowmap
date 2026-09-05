"""WS receive-loop resilience unit tests (upgrade wave A2).

Malformed frames, stray text frames and dispatch errors must never kill the
connection loop: log + drop the message, keep the socket. Exercised directly
against ``_Connection`` with a fake socket so the semantics are pinned
precisely (the e2e covers one real-socket happy path).
"""

from __future__ import annotations

from flowmap_server.api import ws as ws_mod
from flowmap_server.proto import events, wire


class _FakeSocket:
    """Just enough WebSocket surface for _Connection's receive path."""

    def __init__(self, incoming: list[dict] | None = None) -> None:
        self._incoming = list(incoming or [])
        self.sent: list[bytes] = []
        self.closed: int | None = None

    async def receive(self) -> dict:
        if not self._incoming:
            return {"type": "websocket.disconnect", "code": 1000}
        return self._incoming.pop(0)

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        self.closed = code


def _conn(incoming: list[dict] | None = None):
    sock = _FakeSocket(incoming)
    # manager is only needed by Subscribe dispatch, which these tests avoid.
    return ws_mod._Connection(sock, manager=None), sock  # type: ignore[arg-type]


async def test_malformed_frame_dropped_connection_kept():
    conn, sock = _conn()
    assert await conn._handle_frame(b"\xff" * 7) is True  # truncated envelope
    assert sock.closed is None, "malformed frame must not close the socket"


async def test_next_valid_frame_dispatched_after_malformed():
    conn, sock = _conn()
    assert await conn._handle_frame(b"\xff" * 7) is True
    # The NEXT frame is processed normally (Ping with no session is a no-op).
    assert await conn._handle_frame(wire.encode(events.Ping(server_send_ns=1))) is True
    assert sock.closed is None


async def test_batched_valid_prefix_survives_malformed_tail():
    """A frame whose FIRST message decodes keeps that message even when a
    later message in the same batch is garbage: dispatch happens as we go,
    only the undecodable tail is dropped."""
    conn, sock = _conn()
    batch = wire.encode(events.Ping(server_send_ns=1)) + b"\xff" * 7
    assert await conn._handle_frame(batch) is True
    assert sock.closed is None


async def test_dispatch_error_swallowed_connection_kept(monkeypatch):
    conn, sock = _conn()

    async def boom(ev: object) -> bool:
        raise RuntimeError("handler bug")

    monkeypatch.setattr(conn, "_dispatch", boom)
    assert await conn._handle_frame(wire.encode(events.Ping(server_send_ns=1))) is True
    assert sock.closed is None, "a dispatch exception must not kill the loop"


async def test_text_frame_ignored_receive_loop_continues():
    incoming = [
        {"type": "websocket.receive", "text": "not-binary"},
        {
            "type": "websocket.receive",
            "bytes": wire.encode(events.Ping(server_send_ns=1)),
        },
    ]
    conn, sock = _conn(incoming)
    await conn._receive_loop()  # runs to the injected disconnect
    assert sock.closed is None, "a stray text frame must not close the socket"
