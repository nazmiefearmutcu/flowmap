"""Binary WebSocket endpoint (M1 T8; spec §5, §6.2–§6.3).

One connection owns one :class:`ClientTx` and at most one Session
subscription. Three concurrent pieces per connection, all torn down together
in ``finally`` (no task leaks):

- **receive loop** (the endpoint coroutine): decodes batched control
  messages with the :mod:`wire` loop — unknown types skip via payload_len;
  a MALFORMED message (or a text frame on the binary-only protocol) is
  logged and the remainder of that frame is dropped (batched bytes cannot
  be resynced mid-frame), but the connection itself SURVIVES — one bad
  message must never kill a healthy stream. A dispatch error is likewise
  logged and swallowed; the receive loop only exits on a real disconnect
  or a deliberate refusal close;
- **flush loop**: every 50 ms (20 Hz, within §6.2's 10–30 Hz band) drains
  the ClientTx queue up to 256 KiB and sends each drained frame as one
  binary WS message;
- **ping loop**: ~1 Hz ``Ping{server_send_ns}`` (§6.1 — the only clock/
  latency mechanism; the steady 1 Hz cadence doubles as the application-
  level keepalive that stops intermediate proxies from idling the socket
  out). ``Pong`` updates the connection's latency estimate; at M1 it is
  only logged (Status wiring uses it in a later task).

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
    ReplayUnavailableError,
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
# A send that cannot complete within this window means the peer is gone or
# black-holed (TCP send buffers full, no FIN ever coming): abort the connection
# rather than stalling the flush/ping loops forever.
SEND_TIMEOUT_S = 10.0
# A connection that has sent us NOTHING (not even an application Pong — the
# FlowMap client answers every server Ping) for this long is dead: without this
# check a black-holed peer pins its Session refcount + flush/ping tasks forever.
LIVENESS_TIMEOUT_S = 30.0

# WS close codes
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
        self._last_recv_ns = time.monotonic_ns()

    # -- sending ---------------------------------------------------------------

    async def _send(self, data: bytes) -> None:
        async with self._send_lock:
            await asyncio.wait_for(self._ws.send_bytes(data), SEND_TIMEOUT_S)

    async def _flush_loop(self) -> None:
        try:
            while True:
                for frame in self._client.drain(FLUSH_MAX_BYTES):
                    await self._send(frame)
                await asyncio.sleep(FLUSH_INTERVAL_S)
        except asyncio.CancelledError:
            raise
        except Exception:
            # A dead peer (send timeout / broken pipe) must not leave the
            # connection half-alive: abort so the receive loop unwinds and the
            # session is released.
            await self._abort()

    async def _ping_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(PING_INTERVAL_S)
                if time.monotonic_ns() - self._last_recv_ns > LIVENESS_TIMEOUT_S * 1e9:
                    logger.warning("ws peer silent for %.0fs: aborting", LIVENESS_TIMEOUT_S)
                    await self._abort()
                    return
                ping = events.Ping(server_send_ns=time.monotonic_ns())
                await self._send(wire.encode(ping))
        except asyncio.CancelledError:
            raise
        except Exception:
            await self._abort()

    async def _abort(self) -> None:
        """Sender-side teardown (dead peer / failed send). Closing the socket
        unwinds the receive loop; ``run``'s finally releases the session."""
        try:
            await self._ws.close()
        except Exception:  # noqa: BLE001 — already closing/closed: nothing to do
            pass

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
            self._last_recv_ns = time.monotonic_ns()
            data = message.get("bytes")
            if data is None:  # text frame on a binary-only protocol
                # Robustness, not protocol enforcement: log and keep reading.
                # The FlowMap client never sends text; a stray text frame is
                # a broken intermediary, not a peer worth killing the stream
                # for. (Any bytes present still count as liveness above.)
                logger.warning(
                    "text WS frame on binary protocol: frame dropped, connection kept"
                )
                continue
            if not await self._handle_frame(data):
                return

    async def _drop_session(self) -> None:
        if self._session is not None:
            await self._manager.unsubscribe(self._session, self._client)
            self._session = None

    # -- dispatch --------------------------------------------------------------

    async def _handle_frame(self, data: bytes) -> bool:
        """Dispatch every message batched in one frame; False = closed.

        Malformed input is LOGGED, not fatal: the offset is unrecoverable
        mid-frame, so the remainder of THIS frame is dropped and the loop
        resyncs on the next frame boundary. The connection stays up — a
        single corrupt frame (or a hostile burst) must not take a healthy
        subscription down.
        """
        offset = 0
        while offset < len(data):
            try:
                ev, offset = wire.decode(data, offset)
            except ValueError as exc:
                logger.warning(
                    "malformed client frame (%s): dropping the rest of the "
                    "frame, connection kept",
                    exc,
                )
                return True
            if ev is None:
                continue  # unknown msg_type: skipped via payload_len
            try:
                if not await self._dispatch(ev):
                    return False
            except Exception:  # noqa: BLE001 — one bad message never kills the loop
                logger.warning(
                    "dispatch error on %s: message dropped, connection kept",
                    type(ev).__name__,
                    exc_info=True,
                )
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
            # Replay transport controls: forwarded to the session's feed (the
            # recording-backed ReplayFeed consumes them; live feeds ignore).
            if self._session is None:
                logger.debug("%s before Subscribe: ignored", type(ev).__name__)
            else:
                self._session.feed_control(ev)
        return True

    async def _subscribe(self, sub: events.Subscribe) -> bool:
        # A second Subscribe on the same connection replaces the first: the
        # detach happens BEFORE the new subscribe so an over-limit refusal
        # cannot leave the client attached to two sessions.
        await self._drop_session()
        try:
            self._session = await self._manager.subscribe(sub, self._client)
        except SessionLimitError:
            logger.warning(
                "refused subscribe: session limit reached (%s:%s mode=%s) -> 1013",
                sub.market, sub.symbol, sub.mode,
            )
            await self._refuse("degraded", _CLOSE_TRY_AGAIN_LATER)
            return False
        except ReplayUnavailableError as exc:
            # Honest refusal (NOT a live feed under a replay label): the client
            # hides its Replay toggle unless a server advertises the capability.
            logger.warning(
                "refused subscribe: no replayable recording (%s:%s: %s) -> 1003",
                sub.market, sub.symbol, exc,
            )
            await self._refuse("degraded", _CLOSE_UNSUPPORTED)
            return False
        except NotImplementedError as exc:
            logger.warning(
                "refused subscribe: no feed for market (%s:%s: %s) -> 1003",
                sub.market, sub.symbol, exc,
            )
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
