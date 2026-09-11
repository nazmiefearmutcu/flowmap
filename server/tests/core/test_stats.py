"""SessionStats (campaign contract C1) — producer shape, hooks, and wiring.

Pins:
- the FROZEN snapshot dict shape (SB's /api/health v3 renders it verbatim),
- every counter increments from its real source: BoundedFeedQueue drop-oldest,
  ClientTx lag evictions, bridge ts-gate drops, feed crash restarts, recording
  flush failures, refused subscribes,
- the EMA latency / latest-wins skew hooks,
- staleness_ms per-session semantics (ages from creation, resets on events,
  entry removed when the session leaves the manager),
- SessionManager mounting at ``.stats`` (the SB consumption point) and
  Session.conn_stats being consumed by Status broadcasts (NEEDS-CORE #1).
"""

from __future__ import annotations

import asyncio

import numpy as np
import pytest

from flowmap_server.config import Config
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.session import (
    ClientTx,
    ReplayUnavailableError,
    Session,
    SessionLimitError,
    SessionManager,
)
from flowmap_server.core.stats import SessionStats
from flowmap_server.feeds.base import BoundedFeedQueue, BookState
from flowmap_server.feeds.crypto import _BridgeSink
from flowmap_server.proto import wire
from flowmap_server.proto.events import MODE_L2, Status, Subscribe

DT = 250_000_000
ROWS = 128
TICK = 0.5
MARKET, SYMBOL = "sim", "SIM-DEMO"


def _cfg() -> GridCfg:
    return GridCfg(
        tick=TICK,
        tick_multiple=1,
        dt_ns=DT,
        p0=100.0 - ROWS * TICK / 2,
        rows=ROWS,
        ring_columns=1024,
        mode=MODE_L2,
    )


def _book(mid: float, sz: float = 5.0):
    px = np.array([mid - 1.0, mid - 0.5, mid], dtype=np.float64)
    return (px, np.full(3, sz), px + 0.5, np.full(3, sz))


class _FakeHandle:
    def __init__(self, delay_s, cb):
        self.delay_s, self.cb, self.cancelled = delay_s, cb, False

    def cancel(self):
        self.cancelled = True

    def fire(self):
        if not self.cancelled:
            self.cb()


class FakeTimer:
    def __init__(self):
        self.entries: list[_FakeHandle] = []

    def __call__(self, delay_s, cb):
        h = _FakeHandle(delay_s, cb)
        self.entries.append(h)
        return h


class DrivenFeed:
    market = MARKET
    symbol = SYMBOL
    capability: dict[str, object] = {"depth": "L2"}

    def __init__(self):
        self.q: asyncio.Queue = asyncio.Queue()

    async def events(self):
        while True:
            ev = await self.q.get()
            if ev is None:
                return
            yield ev


def _decode(frames: list[bytes]) -> list:
    out = []
    for f in frames:
        off = 0
        while off < len(f):
            ev, off = wire.decode(f, off)
            if ev is not None:
                out.append(ev)
    return out


# ---------------------------------------------------------------------------
# the frozen shape + hooks


def test_snapshot_shape_is_frozen():
    s = SessionStats()
    snap = s.snapshot()
    assert set(snap) == {
        "drops",
        "restarts",
        "sessions",
        "latency_ms",
        "staleness_ms",
        "clock_skew_ms",
        "recording",
    }
    assert set(snap["drops"]) == {"feed", "tx_lag", "snapshot"}
    assert set(snap["sessions"]) == {"active", "rejected"}
    assert set(snap["recording"]) == {"enabled", "flush_failures", "last_flush_ts"}
    assert snap == {
        "drops": {"feed": 0, "tx_lag": 0, "snapshot": 0},
        "restarts": 0,
        "sessions": {"active": 0, "rejected": 0},
        "latency_ms": 0.0,
        "staleness_ms": {},
        "clock_skew_ms": 0.0,
        "recording": {"enabled": False, "flush_failures": 0, "last_flush_ts": None},
    }


def test_record_rtt_is_ema_and_skew_is_latest():
    s = SessionStats()
    s.record_rtt(10.0)
    assert s.snapshot()["latency_ms"] == 10.0  # first sample seeds the EMA
    s.record_rtt(20.0)
    assert s.snapshot()["latency_ms"] == pytest.approx(12.5)  # 10 + 0.25*(20-10)
    s.record_clock_skew(5.0)
    s.record_clock_skew(9.0)
    assert s.snapshot()["clock_skew_ms"] == 9.0  # latest wins (resubscribe resets)
    # Hostile measurements never poison the aggregate.
    s.record_rtt(float("nan"))
    s.record_rtt(-5.0)
    s.record_rtt(float("inf"))
    s.record_clock_skew(float("nan"))
    assert s.snapshot()["latency_ms"] == pytest.approx(12.5)
    assert s.snapshot()["clock_skew_ms"] == 9.0


def test_staleness_ages_from_creation_and_resets_on_samples():
    wall = {"now": 1_000_000_000_000_000_000}
    s = SessionStats(wall_clock=lambda: wall["now"])
    s.note_session("sess-a")
    wall["now"] += 5_000_000_000  # 5 s, no event yet
    assert s.snapshot()["staleness_ms"] == {"sess-a": 5000.0}
    s.note_live_sample("sess-a")
    wall["now"] += 1_200_000_000  # 1.2 s since the last event
    assert s.snapshot()["staleness_ms"] == {"sess-a": 1200.0}
    s.forget_session("sess-a")
    assert s.snapshot()["staleness_ms"] == {}


def test_recording_notes():
    s = SessionStats()
    s.note_recording("a", True)
    s.note_recording("b", True)
    s.note_recording("a", False)
    s.note_flush()
    snap = s.snapshot()
    assert snap["recording"]["enabled"] is True  # b still records
    assert snap["recording"]["last_flush_ts"] is not None
    s.note_recording("b", False)
    assert s.snapshot()["recording"]["enabled"] is False


# ---------------------------------------------------------------------------
# counters fed from their real sources


def test_bounded_queue_drop_fires_hook():
    hits = {"n": 0}
    q = BoundedFeedQueue(maxsize=1, on_drop=lambda: hits.__setitem__("n", hits["n"] + 1))
    q.put_nowait(1)
    q.put_nowait(2)  # drops 1
    assert q.dropped == 1 and hits["n"] == 1

    # A raising hook must never break the producer.
    def boom():
        raise RuntimeError("telemetry down")

    q2 = BoundedFeedQueue(maxsize=1, on_drop=boom)
    q2.put_nowait(1)
    q2.put_nowait(2)
    assert q2.dropped == 1


def test_client_tx_lag_drops_counted_per_column():
    s = SessionStats()
    clock = {"now": 0}
    tx = ClientTx(clock=lambda: clock["now"])
    tx.on_lag_drop = s.inc_tx_lag_drops

    payload = bytes(64)  # frame content is irrelevant to the lag accounting
    # 6 finalized column frames = 3 columns (depth+bar sharing t0).
    for t0 in (10, 20, 30):
        tx.offer(payload, col_msg=True, t0_ns=t0)
        tx.offer(payload, col_msg=True, t0_ns=t0)
    # 2 stale PARTIAL frames at fresh-ish t0s: dropped silently, never counted.
    tx.offer(payload, col_msg=True, t0_ns=40, is_partial=True)
    clock["now"] = 3 * 1_000_000_000  # beyond the 2 s LAG_DROP_NS
    tx.offer(payload, col_msg=True, t0_ns=50)
    assert s.snapshot()["drops"]["tx_lag"] == 3  # real columns, partials excluded


async def test_session_attach_installs_hook_and_counts():
    stats = SessionStats()
    sess = Session("s", feed=DrivenFeed(), grid=Grid(_cfg()), timer=FakeTimer(), stats=stats)
    clock = {"now": 0}
    client = ClientTx(clock=lambda: clock["now"])
    sess.attach(client)  # installs the on_lag_drop hook
    assert client.on_lag_drop == stats.inc_tx_lag_drops  # bound-method equality
    payload = bytes(64)
    for t0 in (1, 2, 3, 4):
        client.offer(payload, col_msg=True, t0_ns=t0)
    clock["now"] = 10**12
    client.offer(payload, col_msg=True, t0_ns=5)
    assert stats.snapshot()["drops"]["tx_lag"] == 4


async def test_bridge_ts_gate_drops_feed_stats():
    """The sink's write-only dropped_ts counter now also increments the
    aggregate (drops.snapshot)."""
    stats = SessionStats()
    sink = _BridgeSink(
        lambda ev: None, stats=stats, now_ns=lambda: 2_000_000_000_000_000_000
    )

    class _Rec:
        source_ts = 0  # pre-2010: insane
        local_ts = 0

    await sink.put(_Rec())
    assert sink.dropped_ts == 1
    assert stats.snapshot()["drops"]["snapshot"] == 1


class _CrashOnceFeed(DrivenFeed):
    def __init__(self):
        super().__init__()
        self._crashed = False

    async def events(self):
        # Must be a real async GENERATOR (yield) for the Feed protocol; the
        # crash is one raise on the first call, the restart resumes the queue.
        if not self._crashed:
            self._crashed = True
            raise RuntimeError("venue socket died")
        while True:
            ev = await self.q.get()
            if ev is None:
                return
            yield ev


async def test_feed_crash_counts_restart():
    feed = _CrashOnceFeed()
    stats = SessionStats()
    sess = Session(
        "crashy",
        feed=feed,
        grid=Grid(_cfg()),
        timer=FakeTimer(),
        stats=stats,
        restart_backoff_base_s=0.001,
    )
    sess.attach(ClientTx())
    await sess.start()
    await asyncio.sleep(0.05)  # crash -> degraded -> jittered sleep -> restart
    assert stats.snapshot()["restarts"] >= 1
    feed.q.put_nowait(None)
    await asyncio.wait_for(sess.run_task, timeout=5)


async def test_manager_mounts_stats_and_counts_rejected():
    mgr = SessionManager(
        Config(max_sessions=1, ring_columns=256, max_rows=64, dt_crypto_ns=DT),
        timer=FakeTimer(),
        feed_factory=lambda sub: DrivenFeed(),
    )
    # Mount point per contract C1 / NEEDS-CORE #3: manager.stats.snapshot().
    assert isinstance(mgr.stats, SessionStats)
    assert callable(mgr.stats.snapshot)

    await mgr.subscribe(Subscribe(market=MARKET, symbol="A", mode="live"), ClientTx())
    assert mgr.stats.snapshot()["sessions"]["active"] == 1
    with pytest.raises(SessionLimitError):
        await mgr.subscribe(Subscribe(market=MARKET, symbol="B", mode="live"), ClientTx())
    assert mgr.stats.snapshot()["sessions"]["rejected"] == 1


async def test_replay_refusal_counts_rejected():
    mgr = SessionManager(
        Config(ring_columns=256, max_rows=64, dt_crypto_ns=DT),
        timer=FakeTimer(),
        feed_factory=lambda sub: DrivenFeed(),
    )
    # Replay without a recording store: refused + counted.
    with pytest.raises(ReplayUnavailableError):
        await mgr.subscribe(Subscribe(market=MARKET, symbol="A", mode="replay"), ClientTx())
    assert mgr.stats.snapshot()["sessions"]["rejected"] == 1
    assert mgr.stats.snapshot()["sessions"]["active"] == 0


async def test_manager_stats_staleness_tracks_sessions():
    wall = {"now": 1_000_000_000_000_000_000}
    timer = FakeTimer()
    mgr = SessionManager(
        Config(ring_columns=256, max_rows=ROWS, dt_crypto_ns=DT),
        timer=timer,
        feed_factory=lambda sub: DrivenFeed(),
        wall_clock=lambda: wall["now"],
    )
    sess = await mgr.subscribe(
        Subscribe(market=MARKET, symbol=SYMBOL, mode="live"), ClientTx()
    )
    key = sess.session_id
    wall["now"] += 2_000_000_000
    assert mgr.stats.snapshot()["staleness_ms"][key] == 2000.0
    # An event arrival resets the age.
    sess._feed.q.put_nowait(BookState(wall["now"], *_book(100.0)))
    await asyncio.sleep(0.02)
    assert mgr.stats.snapshot()["staleness_ms"][key] < 2000.0
    # Teardown (detach + grace) removes the entry from the aggregate.
    await mgr.unsubscribe(sess, next(iter(sess._clients)))
    timer.entries[-1].fire()
    await asyncio.gather(sess.run_task, return_exceptions=True)
    assert key not in mgr.stats.snapshot()["staleness_ms"]
    assert mgr.stats.snapshot()["sessions"]["active"] == 0


# ---------------------------------------------------------------------------
# NEEDS-CORE #1: conn_stats consumed by Status broadcasts


async def test_conn_stats_flows_into_status_frames():
    sess = Session("cs", feed=DrivenFeed(), grid=Grid(_cfg()), timer=FakeTimer())
    client = ClientTx()
    sess.attach(client)
    sess.conn_stats = lambda: {"latency_ms": 12.5, "clock_skew_ms": -3.25}
    sess._set_feed_state("degraded")
    statuses = [e for e in _decode(client.drain(1 << 30)) if isinstance(e, Status)]
    assert len(statuses) == 1
    assert statuses[0].latency_ms == 12.5
    assert statuses[0].clock_skew_ms == -3.25


async def test_status_without_conn_stats_stays_zero():
    sess = Session("cs0", feed=DrivenFeed(), grid=Grid(_cfg()), timer=FakeTimer())
    client = ClientTx()
    sess.attach(client)
    sess._set_feed_state("degraded")
    statuses = [e for e in _decode(client.drain(1 << 30)) if isinstance(e, Status)]
    assert statuses
    assert statuses[0].latency_ms == 0.0 and statuses[0].clock_skew_ms == 0.0


async def test_raising_conn_stats_does_not_kill_broadcast():
    sess = Session("csx", feed=DrivenFeed(), grid=Grid(_cfg()), timer=FakeTimer())
    client = ClientTx()
    sess.attach(client)

    def boom():
        raise RuntimeError("hook exploded")

    sess.conn_stats = boom
    sess._set_feed_state("degraded")  # must not raise
    assert client.drain(1 << 30)  # the Status frame went out with 0.0 fallback
