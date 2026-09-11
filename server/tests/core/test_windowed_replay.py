"""Windowed replay (campaign NEEDS-CORE #2): Subscribe.start_t / end_t are
consumed by SessionManager._replay_feed through Recorder.load_tail ranged
reads, and the parked-replay freshness policy understands that a bounded
[end_t) window is immutable history.

The recordings here are built exactly the way a previous live run would leave
them (real SessionRecorder flushes into a Recorder store), mirroring
test_replay_freshness.py.
"""

from __future__ import annotations

import asyncio
import logging
import time as _time

import numpy as np
import pytest

from flowmap_server.config import Config
from flowmap_server.core.grid import FinalizedColumn
from flowmap_server.core.record import Recorder
from flowmap_server.core.session import (
    ClientTx,
    ReplayStaleError,
    ReplayUnavailableError,
    SessionManager,
)
from flowmap_server.proto.events import BarColumn, EpochParams, Subscribe

DT = 250_000_000
ROWS = 64
TICK = 0.5
P0 = 100.0 - ROWS * TICK / 2
MARKET, SYMBOL = "sim", "SIM-DEMO"
N0 = 20  # columns in the initial recording: t0 = 0..(N0-1)*DT
# Replay keys carry (start_t, end_t) as part of identity (survey-1 #2).
KEY = (MARKET, SYMBOL, "replay", None, "native", None, None)


def _col(seq: int, t0_ns: int) -> FinalizedColumn:
    bar = BarColumn(
        epoch=0, col_seq=seq, t0_ns=t0_ns,
        o=100.0, h=100.5, l=99.5, c=100.0,
        vol_buy=1.0, vol_sell=1.0, cvd_cum=0.0, vwap_num_cum=100.0, vwap_den_cum=1.0,
    )
    return FinalizedColumn(
        epoch=0, col_seq=seq, t0_ns=t0_ns,
        bid=np.full(ROWS, 5.0, dtype=np.float16),
        ask=np.full(ROWS, 2.5, dtype=np.float16),
        bar=bar,
    )


def _trade(ts_ns: int) -> object:
    from flowmap_server.proto.events import SIDE_BUY, SIDE_SRC_EXCHANGE, Trade

    return Trade(
        ts_ns=ts_ns, price=100.0, size=1.5, side=SIDE_BUY,
        side_src=SIDE_SRC_EXCHANGE, venue="sim",
    )


def _marker(ts_ns: int) -> object:
    from flowmap_server.proto.events import Marker

    return Marker(ts_ns=ts_ns, kind="test", text="m", price=100.0, size=1.0)


def _record(root: Recorder, *, t0_idx: int, n: int, start_seq: int, trades: bool = False):
    rec = root.open_session(MARKET, SYMBOL)
    rec.record_epoch(
        EpochParams(epoch=0, tick=TICK, tick_multiple=1, dt_ns=DT, p0=P0, rows=ROWS)
    )
    for i in range(n):
        rec.record_column(_col(start_seq + i, (t0_idx + i) * DT))
        if trades and i % 2 == 0:
            rec.record_trade(_trade((t0_idx + i) * DT + 7))
            rec.record_marker(_marker((t0_idx + i) * DT + 8))
    rec.close()


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


def _no_live_feed(sub: Subscribe):
    raise NotImplementedError(f"replay tests must never build a live feed: {sub!r}")


def _manager(
    root: Recorder, ring: int = 256, replay_max_cols: int = 0
) -> tuple[SessionManager, FakeTimer]:
    cfg = Config(
        max_sessions=4,
        ring_columns=ring,
        max_rows=64,
        dt_crypto_ns=DT,
        replay_max_cols=replay_max_cols,
    )
    timer = FakeTimer()
    return SessionManager(cfg, timer=timer, recorder=root, feed_factory=_no_live_feed), timer


def _sub(start_t=None, end_t=None) -> Subscribe:
    return Subscribe(
        market=MARKET, symbol=SYMBOL, mode="replay", source=None,
        start_t=start_t, end_t=end_t,
    )


async def _retire(mgr: SessionManager, timer: FakeTimer, sess) -> None:
    for c in list(sess._clients):
        await mgr.unsubscribe(sess, c)
    timer.entries[-1].fire()
    if sess.run_task is not None:
        await asyncio.gather(sess.run_task, return_exceptions=True)


# ---------------------------------------------------------------------------
# window contents


async def test_end_bounded_window_loads_only_the_window(tmp_path):
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root)

    sess = await mgr.subscribe(_sub(start_t=5 * DT, end_t=10 * DT), ClientTx())
    feed = sess._feed
    t0s = list(feed._t0s)
    assert t0s == [(5 + i) * DT for i in range(5)]  # [5*DT, 10*DT) exclusive
    assert sess.replay_tail_t0 == 9 * DT
    assert sess.replay_window_end_ns == 10 * DT
    await _retire(mgr, timer, sess)


async def test_open_ended_start_t_loads_from_start(tmp_path):
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root)

    sess = await mgr.subscribe(_sub(start_t=15 * DT), ClientTx())
    t0s = list(sess._feed._t0s)
    assert t0s == [(15 + i) * DT for i in range(5)]
    assert sess.replay_window_end_ns is None  # open-ended
    await _retire(mgr, timer, sess)


async def test_window_is_capped_at_the_ring(tmp_path):
    """A window can never serve more than ring_columns (the newest of the
    window win)."""
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root, ring=8)

    sess = await mgr.subscribe(_sub(start_t=0, end_t=20 * DT), ClientTx())
    t0s = list(sess._feed._t0s)
    assert len(t0s) == 8
    assert t0s[-1] == 19 * DT  # the NEWEST columns of the window survive
    await _retire(mgr, timer, sess)


async def test_trades_clamped_to_window(tmp_path):
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0, trades=True)
    mgr, timer = _manager(root)

    sess = await mgr.subscribe(_sub(start_t=4 * DT, end_t=10 * DT), ClientTx())
    feed = sess._feed
    trade_ts = [ev.ts_ns for evs in feed._by_t0.values() for ev in evs
                if type(ev).__name__ == "Trade"]
    assert trade_ts
    assert all(4 * DT <= ts < 10 * DT for ts in trade_ts)
    await _retire(mgr, timer, sess)


async def test_empty_window_refused(tmp_path):
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root)
    with pytest.raises(ReplayUnavailableError):
        await mgr.subscribe(_sub(start_t=10 * DT, end_t=10 * DT), ClientTx())
    with pytest.raises(ReplayUnavailableError):
        await mgr.subscribe(_sub(start_t=11 * DT, end_t=10 * DT), ClientTx())
    assert mgr._sessions == {}
    # Counted as a rejected subscribe in the C1 aggregate.
    assert mgr.stats.snapshot()["sessions"]["rejected"] == 2


async def test_window_before_any_recording_refused(tmp_path):
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root)
    with pytest.raises(ReplayUnavailableError):
        await mgr.subscribe(_sub(start_t=100 * DT, end_t=200 * DT), ClientTx())


# ---------------------------------------------------------------------------
# no-window replay is bounded (survey-1 #1)


async def test_no_window_replay_serves_newest_ring_window(tmp_path, caplog):
    """A no-window subscribe used to load the ENTIRE recording via load_all
    (multi-GB for long recordings); it now serves the NEWEST bounded window
    (default = ring_columns) and LOGS the truncation — never silently."""
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root, ring=8)

    with caplog.at_level(logging.WARNING, logger="flowmap_server.core.session"):
        sess = await mgr.subscribe(_sub(), ClientTx())
    t0s = list(sess._feed._t0s)
    assert t0s == [(N0 - 8 + i) * DT for i in range(8)]  # NEWEST 8, not all 20
    assert mgr._sessions.get(KEY) is sess  # no-window key = (None, None)
    assert any("truncated" in r.message for r in caplog.records)
    await _retire(mgr, timer, sess)


async def test_no_window_replay_short_recording_serves_all_quietly(tmp_path, caplog):
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=5, start_seq=0)
    mgr, timer = _manager(root, ring=8)

    with caplog.at_level(logging.WARNING, logger="flowmap_server.core.session"):
        sess = await mgr.subscribe(_sub(), ClientTx())
    assert list(sess._feed._t0s) == [i * DT for i in range(5)]
    assert not any("truncated" in r.message for r in caplog.records)
    await _retire(mgr, timer, sess)


async def test_replay_max_cols_knob_overrides_the_default(tmp_path):
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root, ring=256, replay_max_cols=5)

    sess = await mgr.subscribe(_sub(), ClientTx())
    assert list(sess._feed._t0s) == [(N0 - 5 + i) * DT for i in range(5)]
    await _retire(mgr, timer, sess)


async def test_explicit_window_is_never_trimmed_by_replay_max_cols(tmp_path):
    """FLOWMAP_REPLAY_MAX_COLS bounds ONLY the no-window default; a caller's
    [start_t, end_t) window keeps loading exactly the requested range (up to
    the pre-existing ring cap)."""
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root, ring=256, replay_max_cols=3)

    sess = await mgr.subscribe(_sub(start_t=0, end_t=10 * DT), ClientTx())
    assert list(sess._feed._t0s) == [i * DT for i in range(10)]
    await _retire(mgr, timer, sess)


async def test_tail_columns_truncated_flag(tmp_path):
    """The flag the session logs on is set exactly when older columns were
    left behind — and only then."""
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)

    capped = root.load_tail(MARKET, SYMBOL, max_age_ns=10**18, now_ns=10**18, limit_cols=8)
    assert capped is not None and capped.truncated
    assert [c.t0_ns for c in capped.columns] == [(N0 - 8 + i) * DT for i in range(8)]

    full = root.load_tail(MARKET, SYMBOL, max_age_ns=10**18, now_ns=10**18, limit_cols=N0)
    assert full is not None and not full.truncated
    assert len(full.columns) == N0


async def test_tapes_capped_to_newest_rows(tmp_path, monkeypatch):
    import flowmap_server.core.record as record_mod

    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0, trades=True)  # 10 trades/markers
    monkeypatch.setattr(record_mod, "_TRADES_MAX_PER_LOAD", 3)
    monkeypatch.setattr(record_mod, "_MARKERS_MAX_PER_LOAD", 2)

    tail = root.load_tail(MARKET, SYMBOL, max_age_ns=10**18, now_ns=10**18, limit_cols=100)
    assert tail is not None
    assert tail.trades_truncated and tail.markers_truncated
    # The NEWEST rows survive; the oldest were dropped.
    assert [t.ts_ns for t in tail.trades] == [i * DT + 7 for i in (14, 16, 18)]
    assert [m.ts_ns for m in tail.markers] == [i * DT + 8 for i in (16, 18)]


async def test_no_window_replay_warns_when_only_tapes_truncated(tmp_path, monkeypatch, caplog):
    """The session's honesty log must fire for EITHER cap: columns fit, tape
    capped -> still a warning (the replay cannot show the full tape)."""
    import flowmap_server.core.record as record_mod

    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0, trades=True)
    monkeypatch.setattr(record_mod, "_TRADES_MAX_PER_LOAD", 3)
    mgr, timer = _manager(root, ring=256)

    with caplog.at_level(logging.WARNING, logger="flowmap_server.core.session"):
        sess = await mgr.subscribe(_sub(), ClientTx())
    assert any("trades=True" in r.message for r in caplog.records)
    assert list(sess._feed._t0s) == [i * DT for i in range(N0)]  # columns all fit
    await _retire(mgr, timer, sess)


# ---------------------------------------------------------------------------
# windowed sessions are identity, not an accident (survey-1 #2)


async def test_reattach_with_a_different_window_is_a_distinct_session(tmp_path):
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root)

    s1 = await mgr.subscribe(_sub(start_t=0, end_t=5 * DT), ClientTx())
    s2 = await mgr.subscribe(_sub(start_t=5 * DT, end_t=10 * DT), ClientTx())
    assert s2 is not s1
    assert list(s1._feed._t0s) == [i * DT for i in range(5)]
    assert list(s2._feed._t0s) == [(5 + i) * DT for i in range(5)]
    assert len(mgr._sessions) == 2
    await _retire(mgr, timer, s1)
    await _retire(mgr, timer, s2)


async def test_unbounded_and_start_only_subscriptions_are_distinct(tmp_path):
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root)

    s1 = await mgr.subscribe(_sub(), ClientTx())  # no window
    s2 = await mgr.subscribe(_sub(start_t=0), ClientTx())  # [0, oo)
    assert s2 is not s1
    await _retire(mgr, timer, s1)
    await _retire(mgr, timer, s2)


async def test_new_window_evicts_the_idle_parked_variant(tmp_path):
    """Cycling replay windows must not pin one ring per window for the grace
    period: creating a new window tears down an idle parked variant of the
    same symbol/mode/source immediately."""
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root)

    c1 = ClientTx()
    s1 = await mgr.subscribe(_sub(start_t=0, end_t=5 * DT), c1)
    await mgr.unsubscribe(s1, c1)  # parked, grace pending
    assert s1.client_count == 0

    s2 = await mgr.subscribe(_sub(start_t=5 * DT, end_t=10 * DT), ClientTx())
    assert s2 is not s1
    assert list(mgr._sessions.values()) == [s2]
    await _retire(mgr, timer, s2)


# ---------------------------------------------------------------------------
# freshness policy with windows


async def test_end_bounded_window_not_stale_when_recording_grows_past(tmp_path):
    """A bounded window is immutable history: growth of the live recording
    past the window's end (and BEFORE start_t, equally irrelevant) must NOT
    refuse a re-attach - a rebuild would return the same window."""
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root)

    sess = await mgr.subscribe(_sub(start_t=4 * DT, end_t=10 * DT), ClientTx())
    # The recording races on: past the window end and far past it.
    _record(root, t0_idx=N0, n=40, start_seq=N0)
    _record(root, t0_idx=112, n=10, start_seq=112)

    c2 = ClientTx()
    assert await mgr.subscribe(_sub(start_t=4 * DT, end_t=10 * DT), c2) is sess
    assert sess.client_count == 2
    await _retire(mgr, timer, sess)


async def test_start_only_replay_still_tracks_recording_growth(tmp_path):
    """An open-ended [start_t, oo) window keeps the existing semantics: the
    recording growing past the session's tail means the parked replay is
    stale and the re-attach is refused."""
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root)

    sess = await mgr.subscribe(_sub(start_t=0), ClientTx())
    assert sess.replay_window_end_ns is None
    _record(root, t0_idx=112, n=60, start_seq=112)
    with pytest.raises(ReplayStaleError):
        await mgr.subscribe(_sub(start_t=0), ClientTx())
    # The refusal touched nothing: the [0, oo) key still maps to the session.
    assert mgr._sessions.get((MARKET, SYMBOL, "replay", None, "native", 0, None)) is sess
    await _retire(mgr, timer, sess)


# ---------------------------------------------------------------------------
# load_tail upper bound (unit)


def test_load_tail_end_ns_is_exclusive(tmp_path):
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=10, start_seq=0, trades=True)
    tail = root.load_tail(
        MARKET, SYMBOL, max_age_ns=5 * DT, now_ns=5 * DT, limit_cols=100, end_ns=5 * DT
    )
    assert tail is not None
    assert [c.t0_ns for c in tail.columns] == [i * DT for i in range(5)]
    assert all(t.ts_ns < 5 * DT for t in tail.trades)
    # Unbounded default is unchanged.
    full = root.load_tail(
        MARKET, SYMBOL, max_age_ns=100 * DT, now_ns=100 * DT, limit_cols=100
    )
    assert full is not None and len(full.columns) == 10


# ---------------------------------------------------------------------------
# the freshness probe runs off-loop (survey-4 L-1)


async def test_freshness_probe_runs_off_the_event_loop(tmp_path, monkeypatch):
    """Re-attach to a parked replay must not parse the newest part file on
    the loop: while the probe blocks in its executor thread, a concurrent
    event-loop task keeps ticking."""
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root)

    sess = await mgr.subscribe(_sub(), ClientTx())
    assert sess.replay_tail_t0 == (N0 - 1) * DT

    real = Recorder.newest_column_t0

    def slow_probe(self, market, symbol):
        _time.sleep(0.25)  # blocking IO stand-in
        return real(self, market, symbol)

    monkeypatch.setattr(Recorder, "newest_column_t0", slow_probe)

    ticks = 0

    async def ticker():
        nonlocal ticks
        while True:
            ticks += 1
            await asyncio.sleep(0.01)

    spawner = asyncio.create_task(ticker())
    try:
        await asyncio.sleep(0.05)
        assert await mgr.subscribe(_sub(), ClientTx()) is sess
        assert ticks >= 10, "event loop stalled while the freshness probe ran"
    finally:
        spawner.cancel()
    await _retire(mgr, timer, sess)


# ---------------------------------------------------------------------------
# wire compatibility of the end_t field (proto lives in SB's files; the
# round-trip pins belong with the consumer)


def test_end_t_wire_roundtrip_and_old_payload_compat():
    from flowmap_server.proto import wire as wire_mod
    import msgspec

    sub = Subscribe(
        market="crypto", symbol="BTCUSDT", mode="replay",
        source=None, start_t=5, end_t=9,
    )
    blob = wire_mod.encode(sub)
    ev, off = wire_mod.decode(blob, 0)
    assert off == len(blob)
    assert ev.end_t == 9 and ev.start_t == 5

    # An OLD payload (JSON without the end_t key, envelope hand-built the
    # same way wire._frame does) decodes to the default None.
    old_payload = msgspec.json.encode(
        {"market": "crypto", "symbol": "BTCUSDT", "mode": "replay",
         "source": None, "start_t": None}
    )
    old_blob = (
        wire_mod._ENVELOPE.pack(
            wire_mod.MSG_SUBSCRIBE, wire_mod.PROTO_VER, wire_mod.FLAG_JSON, len(old_payload)
        )
        + old_payload
    )
    ev2, _ = wire_mod.decode(old_blob, 0)
    assert ev2.end_t is None  # old clients keep working
