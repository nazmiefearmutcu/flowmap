"""Binary WebSocket endpoint (M1 T8; spec §5, §6.2–§6.3).

One connection owns one :class:`ClientTx` and at most one Session
subscription. Three concurrent pieces per connection, all torn down together
in ``finally`` (no task leaks):

- **receive loop** (the endpoint coroutine): decodes batched control
  messages with the :mod:`wire` loop — unknown types skip via payload_len,
  ANY malformed input closes the socket with 1002 after sending nothing
  further;
- **flush loop**: every 50 ms (20 Hz, within §6.2's 10–30 Hz band) drains
  the ClientTx queue up to 256 KiB and sends each drained frame as one
  binary WS message;
- **ping loop**: ~1 Hz ``Ping{server_send_ns}`` (§6.1 — the only clock/
  latency mechanism). ``Pong`` updates the connection's latency estimate;
  at M1 it is only logged (Status wiring uses it in a later task).

All sends go through one lock so control-plane replies (HistoryResponse,
refusal Status) never interleave mid-frame with queue flushes or pings.
"""

from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from flowmap_server.core.session import (
    ClientTx,
    Session,
    SessionLimitError,
    SessionManager,
)
from flowmap_server.proto import events, wire

__all__ = ["router"]

logger = logging.getLogger(__name__)

router = APIRouter()

FLUSH_INTERVAL_S = 0.05  # 20 Hz drain cadence
FLUSH_MAX_BYTES = 256 * 1024
PING_INTERVAL_S = 1.0

# WS close codes
_CLOSE_PROTOCOL_ERROR = 1002  # malformed client frame
_CLOSE_UNSUPPORTED = 1003  # market has no feed at this milestone
_CLOSE_TRY_AGAIN_LATER = 1013  # session limit reached


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    await _Connection(ws, ws.app.state.manager).run()


class _Connection:
    """Per-connection state: send queue, current session, latency estimate."""

    def __init__(self, ws: WebSocket, manager: SessionManager) -> None:
        self._ws = ws
        self._manager = manager
        self._client = ClientTx()
        self._session: Session | None = None
        self._send_lock = asyncio.Lock()
        self.latency_ms = 0.0

    # -- sending ---------------------------------------------------------------

    async def _send(self, data: bytes) -> None:
        async with self._send_lock:
            await self._ws.send_bytes(data)

    async def _flush_loop(self) -> None:
        while True:
            for frame in self._client.drain(FLUSH_MAX_BYTES):
                await self._send(frame)
            await asyncio.sleep(FLUSH_INTERVAL_S)

    async def _ping_loop(self) -> None:
        while True:
            await asyncio.sleep(PING_INTERVAL_S)
            ping = events.Ping(server_send_ns=time.monotonic_ns())
            await self._send(wire.encode(ping))

    # -- lifecycle -------------------------------------------------------------

    async def run(self) -> None:
        tasks = (
            asyncio.create_task(self._flush_loop(), name="ws-flush"),
            asyncio.create_task(self._ping_loop(), name="ws-ping"),
        )
        try:
            await self._receive_loop()
        except WebSocketDisconnect:
            pass
        finally:
            for t in tasks:
                t.cancel()
            # Retrieve cancellations AND any send-vs-close race the loops
            # lost after our close(): swallowed here, never leaked.
            await asyncio.gather(*tasks, return_exceptions=True)
            await self._drop_session()

    async def _receive_loop(self) -> None:
        while True:
            message = await self._ws.receive()
            if message["type"] == "websocket.disconnect":
                return
            data = message.get("bytes")
            if data is None:  # text frame on a binary-only protocol
                logger.warning("text WS frame on binary protocol: closing 1002")
                await self._ws.close(code=_CLOSE_PROTOCOL_ERROR)
                return
            if not await self._handle_frame(data):
                return

    async def _drop_session(self) -> None:
        if self._session is not None:
            await self._manager.unsubscribe(self._session, self._client)
            self._session = None

    # -- dispatch --------------------------------------------------------------

    async def _handle_frame(self, data: bytes) -> bool:
        """Dispatch every message batched in one frame; False = closed."""
        offset = 0
        while offset < len(data):
            try:
                ev, offset = wire.decode(data, offset)
            except ValueError as exc:
                logger.warning("malformed client frame (%s): closing 1002", exc)
                await self._ws.close(code=_CLOSE_PROTOCOL_ERROR)
                return False
            if ev is None:
                continue  # unknown msg_type: skipped via payload_len
            if not await self._dispatch(ev):
                return False
        return True

    async def _dispatch(self, ev: object) -> bool:
        if isinstance(ev, events.Subscribe):
            return await self._subscribe(ev)
        if isinstance(ev, events.Unsubscribe):
            await self._drop_session()
        elif isinstance(ev, events.HistoryRequest):
            if self._session is None:
                logger.debug("HistoryRequest before Subscribe: ignored")
            else:
                # One pre-encoded frame ((EpochStarts +) HistoryResponse),
                # sent directly — history must not contend with the live
                # queue's lag-drop accounting.
                await self._send(self._session.handle_history(ev))
        elif isinstance(ev, events.Pong):
            rtt_ns = time.monotonic_ns() - ev.echo_ns
            self.latency_ms = rtt_ns / 2 / 1e6
            logger.debug("pong: rtt=%.2f ms", rtt_ns / 1e6)
        else:
            # Seek/SetSpeed/Pause/Resume are replay controls (M3): decodable
            # but inert at M1.
            logger.debug("ignoring %s at M1", type(ev).__name__)
        return True

    async def _subscribe(self, sub: events.Subscribe) -> bool:
        # A second Subscribe on the same connection replaces the first: the
        # detach happens BEFORE the new subscribe so an over-limit refusal
        # cannot leave the client attached to two sessions.
        await self._drop_session()
        try:
            self._session = await self._manager.subscribe(sub, self._client)
        except SessionLimitError:
            await self._refuse("degraded", _CLOSE_TRY_AGAIN_LATER)
            return False
        except NotImplementedError:
            await self._refuse("closed", _CLOSE_UNSUPPORTED)
            return False
        return True

    async def _refuse(self, feed_state: str, code: int) -> None:
        status = events.Status(
            feed_state=feed_state,  # type: ignore[arg-type]
            capability={},
            latency_ms=0.0,
            clock_skew_ms=0.0,
        )
        await self._send(wire.encode(status))
        await self._ws.close(code=code)
