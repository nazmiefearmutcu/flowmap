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
  out). ``Pong`` updates the connection's latency estimate, which feeds the
  manager's stats producer (``stats.record_rtt``, getattr-guarded) and the
  refusal Status frames; the core-side Status-broadcast seam (``Session.
  conn_stats``, see NEEDS-CORE.md) is installed defensively at subscribe.

All sends go through one lock so control-plane replies (HistoryResponse,
refusal Status) never interleave mid-frame with queue flushes or pings.
"""

from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from flowmap_server.api import _env
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
_CLOSE_POLICY = 1008  # origin violated the endpoint's policy
_CLOSE_TRY_AGAIN_LATER = 1013  # session limit reached / connection cap reached


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    """Origin gate + per-process connection cap, then the normal stream.

    Both rejections must deliver an HONEST close code to the peer, which a
    bare handshake refusal (HTTP 403) cannot — so the socket is accepted and
    immediately closed with the code (1008 policy / 1013 try-again-later)
    after a plain-language Status frame. The FlowMap webview and dev server
    origins pass the built-in policy; see :func:`api._env.origin_allowed` and
    ``FLOWMAP_WS_ALLOWED_ORIGINS`` / ``FLOWMAP_WS_MAX_CONNECTIONS``.
    """
    state = ws.app.state
    if not _env.origin_allowed(ws.headers.get("origin")):
        logger.warning("ws refused: origin %r not allowed -> 1008",
                       ws.headers.get("origin"))
        await ws.accept()
        await _reject(ws, "closed", _CLOSE_POLICY, "origin not allowed")
        return
    live = getattr(state, "ws_live_connections", 0)
    if live >= _env.ws_max_connections():
        logger.warning("ws refused: connection cap reached (%d live) -> 1013", live)
        await ws.accept()
        await _reject(ws, "degraded", _CLOSE_TRY_AGAIN_LATER,
                      "connection cap reached; try again later")
        return
    # Single event loop: the increment/decrement never span an await, so the
    # plain attribute is race-free. (Per-app == per-process in production.)
    state.ws_live_connections = live + 1
    try:
        await ws.accept()
        await _Connection(ws, state.manager).run()
    finally:
        state.ws_live_connections = getattr(state, "ws_live_connections", 1) - 1


async def _reject(ws: WebSocket, feed_state: str, code: int, reason: str) -> None:
    """Accept-then-close rejection with a plain-language Status + reason."""
    status = events.Status(
        feed_state=feed_state,  # type: ignore[arg-type]
        capability={"reason": reason},
        latency_ms=0.0,
        clock_skew_ms=0.0,
    )
    try:
        await ws.send_bytes(wire.encode(status))
    except Exception:  # noqa: BLE001 — peer may already be gone; close anyway
        pass
    try:
        await ws.close(code=code, reason=reason)
    except Exception:  # noqa: BLE001
        pass


class _Connection:
    """Per-connection state: send queue, current session, latency estimate."""

    def __init__(self, ws: WebSocket, manager: SessionManager) -> None:
        self._ws = ws
        self._manager = manager
        self._client = ClientTx()
        self._session: Session | None = None
        self._send_lock = asyncio.Lock()
        self.latency_ms = 0.0
        # Wall-clock skew of the CLIENT clock vs ours, derived from an
        # optional Subscribe.client_ts_ns (proto; campaign SB item 4).
        # Positive = client clock ahead. 0.0 until a Subscribe carries one.
        self.clock_skew_ms = 0.0
        # Bumped on every Subscribe; frames drained from the ClientTx across a
        # re-subscribe belong to the previous epoch and must never flush.
        self._sub_epoch = 0
        self._last_recv_ns = time.monotonic_ns()

    def _conn_stats(self) -> dict[str, float]:
        """Per-connection latency/skew for the Status-broadcast seam.

        Set on the Session as ``conn_stats`` when the core-side hook (a
        ``Session.conn_stats: Callable[[], dict] | None`` attribute the run
        loop would consult while building Status frames) does not exist yet —
        see campaign NEEDS-CORE.md. Defensive: a core without the hook simply
        never reads it, and we never clobber one that exists.
        """
        return {
            "latency_ms": round(self.latency_ms, 3),
            "clock_skew_ms": round(self.clock_skew_ms, 3),
        }

    def _record_rtt(self, latency_ms: float) -> None:
        """Feed the measured RTT into the server-stats producer (C1) when one
        is mounted on the manager. getattr-guarded: this file must work
        against a core that predates SessionStats."""
        stats = getattr(self._manager, "stats", None)
        record_rtt = getattr(stats, "record_rtt", None)
        if callable(record_rtt):
            try:
                record_rtt(latency_ms)
            except Exception:  # noqa: BLE001 — telemetry must never kill the stream
                logger.debug("stats.record_rtt failed", exc_info=True)

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
            self._record_rtt(self.latency_ms)
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
        # Re-subscribe hygiene (campaign SB item 3): frames still queued by
        # the OLD subscription belong to another symbol/session and must
        # never flush after the new Hello/snapshot. The session is detached
        # above (it can offer nothing more), so draining here is exact, and
        # the epoch bump marks the queue boundary. The flush loop drains
        # concurrently — drain() pops >=1 frame per call when non-empty, so
        # this terminates without a lock.
        self._sub_epoch += 1
        while len(self._client):
            self._client.drain(FLUSH_MAX_BYTES)
        # Optional client wall-clock stamp (campaign SB item 4): derive the
        # clock skew for THIS subscription. Absent (old client) -> 0.0.
        client_ts_ns = getattr(sub, "client_ts_ns", None)
        if client_ts_ns is not None:
            self.clock_skew_ms = (int(client_ts_ns) - time.time_ns()) / 1e6
        else:
            self.clock_skew_ms = 0.0
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
        except ValueError as exc:
            # e.g. a recording-path-unsafe symbol (record._safe_component).
            # The refusal contract is a Status frame + close, never a silent
            # no-op that leaves the socket open with no session.
            logger.warning(
                "refused subscribe: invalid symbol (%s:%s: %s) -> 1003",
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
        # Expose this connection's measured latency/skew to the session's
        # Status broadcasts when the core-side seam exists (NEEDS-CORE:
        # Session.conn_stats). Never clobber a hook the core installed.
        if getattr(self._session, "conn_stats", None) is None:
            try:
                self._session.conn_stats = self._conn_stats
            except Exception:  # noqa: BLE001 — a read-only core must keep working
                pass
        return True

    async def _refuse(self, feed_state: str, code: int) -> None:
        status = events.Status(
            feed_state=feed_state,  # type: ignore[arg-type]
            capability={},
            # Real measurements where the connection has any (campaign SB
            # item 4) — a refusal after live pings no longer claims 0.0.
            latency_ms=round(self.latency_ms, 3),
            clock_skew_ms=round(self.clock_skew_ms, 3),
        )
        await self._send(wire.encode(status))
        await self._ws.close(code=code)
