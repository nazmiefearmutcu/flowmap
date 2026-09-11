"""WS connection unit tests (campaign SB items 3 + 4) — deterministic fakes.

- Re-subscribe stale-frame leak: subscribing a second symbol on the same
  connection must drain the shared ClientTx (and bump the subscription
  epoch) so no OLD-symbol frame can flush after the NEW session's
  Hello/snapshot. Unit-level on purpose: an e2e variant would have to race
  the 50 ms flush tick (forbidden by the campaign's no-phase-pinning rule).
- Real latency fields: the measured Pong RTT feeds the manager's stats
  producer (`record_rtt`, getattr-guarded) and the refusal Status frame;
  `Subscribe.client_ts_ns` (optional proto field) becomes the clock skew.
"""

from __future__ import annotations

import time

import pytest

from flowmap_server.api import ws as ws_mod
from flowmap_server.proto import events, wire


class FakeWS:
    """Just enough of Starlette's WebSocket for _Connection internals."""

    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self.closed: tuple[int | None, str | None] | None = None

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)

    async def close(self, code: int | None = None, reason: str | None = None) -> None:
        self.closed = (code, reason)


class FakeSession:
    def __init__(self, symbol: str) -> None:
        self.symbol = symbol
        self.conn_stats = None  # _subscribe must install the hook here


class FakeStats:
    def __init__(self) -> None:
        self.rtts: list[float] = []

    def record_rtt(self, ms: float) -> None:
        self.rtts.append(ms)


class FakeManager:
    """Emulates SessionManager.subscribe: attaches + enqueues one tagged
    column frame per subscribe (venue carries the symbol so drained bytes
    are attributable). Sessions are cached per symbol, like a real parked
    session being handed out again."""

    def __init__(self, stats: FakeStats | None = None) -> None:
        self.stats = stats
        self.subscriptions: list[events.Subscribe] = []
        self.unsubscribed: list[FakeSession] = []
        self._sessions: dict[str, FakeSession] = {}

    async def subscribe(self, sub: events.Subscribe, client) -> FakeSession:
        self.subscriptions.append(sub)
        session = self._sessions.get(sub.symbol)
        if session is None:
            session = FakeSession(sub.symbol)
            self._sessions[sub.symbol] = session
        frame = wire.encode(
            events.Trade(
                ts_ns=len(self.subscriptions),
                price=1.0,
                size=1.0,
                side=events.SIDE_BUY,
                side_src=events.SIDE_SRC_NA,
                venue=sub.symbol,
            )
        )
        client.offer(frame, col_msg=True, t0_ns=1_000 + len(self.subscriptions))
        return session

    async def unsubscribe(self, session, client) -> None:
        self.unsubscribed.append(session)


def _sub(symbol: str, client_ts_ns: int | None = None) -> events.Subscribe:
    return events.Subscribe(
        market="sim", symbol=symbol, mode="live", client_ts_ns=client_ts_ns
    )


def _venue_tags(conn: ws_mod._Connection) -> list[str]:
    drained = conn._client.drain(1 << 40)
    out = []
    for buf in drained:
        ev, _ = wire.decode(buf, 0)
        assert isinstance(ev, events.Trade)
        out.append(ev.venue)
    return out


# --- item 3: re-subscribe must not leak stale frames ------------------------


async def test_resubscribe_drains_old_symbol_frames():
    conn = ws_mod._Connection(FakeWS(), FakeManager())
    assert await conn._subscribe(_sub("AAA"))
    assert len(conn._client) > 0, "fake manager must have queued an AAA frame"
    assert await conn._subscribe(_sub("BBB"))
    tags = _venue_tags(conn)
    assert tags == ["BBB"], f"stale frames leaked across re-subscribe: {tags}"


async def test_resubscribe_bumps_epoch_each_time():
    conn = ws_mod._Connection(FakeWS(), FakeManager())
    assert conn._sub_epoch == 0
    for i, sym in enumerate(("AAA", "BBB", "CCC"), start=1):
        assert await conn._subscribe(_sub(sym))
        assert conn._sub_epoch == i


async def test_resubscribe_detaches_previous_session():
    manager = FakeManager()
    conn = ws_mod._Connection(FakeWS(), manager)
    assert await conn._subscribe(_sub("AAA"))
    first = conn._session
    assert await conn._subscribe(_sub("BBB"))
    assert manager.unsubscribed == [first]
    assert conn._session is not first


# --- item 4: real latency fields ---------------------------------------------


async def test_pong_updates_latency_and_feeds_stats_record_rtt():
    stats = FakeStats()
    conn = ws_mod._Connection(FakeWS(), FakeManager(stats=stats))
    sent_ns = time.monotonic_ns()
    await conn._dispatch(
        events.Pong(echo_ns=sent_ns, client_recv_ns=time.monotonic_ns())
    )
    assert 0.0 <= conn.latency_ms < 50.0  # in-process echo: sub-ms, honest bound
    assert stats.rtts == [conn.latency_ms]


async def test_pong_without_stats_producer_is_harmless():
    """getattr-guarded: a manager without `stats` (pre-SessionStats core)."""
    conn = ws_mod._Connection(FakeWS(), FakeManager(stats=None))
    await conn._dispatch(
        events.Pong(echo_ns=time.monotonic_ns(), client_recv_ns=0)
    )
    assert conn.latency_ms >= 0.0


async def test_client_ts_ns_becomes_clock_skew():
    ahead_by_ms = 5_000
    conn = ws_mod._Connection(FakeWS(), FakeManager())
    ts = time.time_ns() + ahead_by_ms * 1_000_000
    assert await conn._subscribe(_sub("AAA", client_ts_ns=ts))
    assert abs(conn.clock_skew_ms - ahead_by_ms) < 50.0  # wide margin, wall clock


async def test_subscribe_without_client_ts_ns_keeps_skew_zero():
    conn = ws_mod._Connection(FakeWS(), FakeManager())
    assert await conn._subscribe(_sub("AAA", client_ts_ns=time.time_ns()))
    first = conn.clock_skew_ms
    assert abs(first) > 0.0
    # A re-subscribe from an OLD client (no field) resets the skew — no stale
    # cross-subscription measurement may survive.
    assert await conn._subscribe(_sub("BBB", client_ts_ns=None))
    assert conn.clock_skew_ms == 0.0


async def test_refusal_status_carries_measured_latency():
    conn = ws_mod._Connection(FakeWS(), FakeManager())
    conn.latency_ms = 3.21
    conn.clock_skew_ms = -12.5
    await conn._refuse("degraded", ws_mod._CLOSE_UNSUPPORTED)
    fake_ws = conn._ws
    assert fake_ws.closed == (ws_mod._CLOSE_UNSUPPORTED, None)
    ev, _ = wire.decode(fake_ws.sent[-1], 0)
    assert isinstance(ev, events.Status)
    assert ev.latency_ms == pytest.approx(3.21)
    assert ev.clock_skew_ms == pytest.approx(-12.5)


async def test_subscribe_installs_conn_stats_hook_but_never_clobbers():
    conn = ws_mod._Connection(FakeWS(), FakeManager())
    assert await conn._subscribe(_sub("AAA"))
    session = conn._session
    assert callable(session.conn_stats)
    assert session.conn_stats() == {
        "latency_ms": conn.latency_ms,
        "clock_skew_ms": conn.clock_skew_ms,
    }
    # A core that already installed its own hook must not be replaced.
    sentinel = lambda: {"latency_ms": -1.0}  # noqa: E731
    session.conn_stats = sentinel
    assert await conn._subscribe(_sub("AAA"))
    assert conn._session is session
    assert session.conn_stats is sentinel
