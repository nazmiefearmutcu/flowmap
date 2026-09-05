"""Parked-replay freshness re-validation (handoff §6) + the disk probe.

A replay session's feed is a SNAPSHOT of the recording taken when the session
was created: it can never serve columns recorded after its tail. These tests
pin the SessionManager policy that a re-attach to an EXISTING replay session
re-validates the recording on disk and REFUSES (``ReplayStaleError``, an
honest ``ReplayUnavailableError`` subclass) when the recording has grown past
the session's tail by more than ``REPLAY_STALE_TOL_NS`` — and that the
refusal leaves the parked session (its clients, run task, registration)
untouched, with recovery once the old session retires.

The recordings here are built exactly the way a previous live run would
leave them: real ``SessionRecorder`` flushes into a ``Recorder`` store.
"""

from __future__ import annotations

import asyncio

import numpy as np
import pytest

from flowmap_server.config import Config
from flowmap_server.core.grid import FinalizedColumn
from flowmap_server.core.record import Recorder
from flowmap_server.core.session import (
    REPLAY_STALE_TOL_NS,
    ClientTx,
    ReplayStaleError,
    ReplayUnavailableError,
    SessionManager,
)
from flowmap_server.proto.events import BarColumn, EpochParams, Subscribe

DT = 250_000_000  # 250 ms — matches cfg.dt_crypto_ns below
ROWS = 64
TICK = 0.5
P0 = 100.0 - ROWS * TICK / 2  # 84.0 — the manager's sim grid for max_rows=64
MARKET, SYMBOL = "sim", "SIM-DEMO"
N0 = 12  # columns in the initial recording: t0 = 0..(N0-1)*DT

KEY = (MARKET, SYMBOL, "replay", None, "native")


# ---------------------------------------------------------------------------
# helpers


def _col(seq: int, t0_ns: int) -> FinalizedColumn:
    bar = BarColumn(
        epoch=0,
        col_seq=seq,
        t0_ns=t0_ns,
        o=100.0,
        h=100.5,
        l=99.5,
        c=100.0,
        vol_buy=1.0,
        vol_sell=1.0,
        cvd_cum=0.0,
        vwap_num_cum=100.0,
        vwap_den_cum=1.0,
    )
    return FinalizedColumn(
        epoch=0,
        col_seq=seq,
        t0_ns=t0_ns,
        bid=np.full(ROWS, 5.0, dtype=np.float16),
        ask=np.full(ROWS, 2.5, dtype=np.float16),
        bar=bar,
    )


def _record(root: Recorder, *, t0_idx: int, n: int, start_seq: int) -> None:
    """Append ``n`` columns (t0 = t0_idx.., seq = start_seq..) as a NEW live
    run would: its own SessionRecorder, epoch params, flush at close."""
    rec = root.open_session(MARKET, SYMBOL)
    rec.record_epoch(
        EpochParams(epoch=0, tick=TICK, tick_multiple=1, dt_ns=DT, p0=P0, rows=ROWS)
    )
    for i in range(n):
        rec.record_column(_col(start_seq + i, (t0_idx + i) * DT))
    rec.close()


class _FakeHandle:
    def __init__(self, delay_s: float, cb) -> None:
        self.delay_s, self.cb, self.cancelled = delay_s, cb, False

    def cancel(self) -> None:
        self.cancelled = True

    def fire(self) -> None:
        if not self.cancelled:
            self.cb()


class FakeTimer:
    def __init__(self) -> None:
        self.entries: list[_FakeHandle] = []

    def __call__(self, delay_s: float, cb) -> _FakeHandle:
        h = _FakeHandle(delay_s, cb)
        self.entries.append(h)
        return h


def _no_live_feed(sub: Subscribe):
    raise NotImplementedError(f"replay tests must never build a live feed: {sub!r}")


def _manager(root: Recorder) -> tuple[SessionManager, FakeTimer]:
    cfg = Config(max_sessions=4, ring_columns=256, max_rows=64, dt_crypto_ns=DT)
    timer = FakeTimer()
    return (
        SessionManager(cfg, timer=timer, recorder=root, feed_factory=_no_live_feed),
        timer,
    )


def _sub() -> Subscribe:
    return Subscribe(market=MARKET, symbol=SYMBOL, mode="replay", source=None, start_t=None)


async def _retire(mgr: SessionManager, timer: FakeTimer, sess) -> None:
    """Detach-everything + grace fire: the documented way a parked session
    vacates its key."""
    for c in list(sess._clients):
        await mgr.unsubscribe(sess, c)
    timer.entries[-1].fire()
    if sess.run_task is not None:
        await asyncio.gather(sess.run_task, return_exceptions=True)


# ---------------------------------------------------------------------------
# the policy


async def test_fresh_parked_replay_reattach_accepted(tmp_path):
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root)
    sub = _sub()

    sess = await mgr.subscribe(sub, ClientTx())
    assert sess.replay_tail_t0 == (N0 - 1) * DT

    # Recording unchanged since the session was built: same key -> same
    # session, no refusal.
    c2 = ClientTx()
    assert await mgr.subscribe(sub, c2) is sess
    assert sess.client_count == 2

    await _retire(mgr, timer, sess)


async def test_stale_recording_refused_and_parked_session_intact(tmp_path):
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root)
    sub = _sub()

    sess = await mgr.subscribe(sub, ClientTx())
    # A parallel live run records 60 columns FAR past the replay's tail
    # (t0 112*DT vs tail 11*DT; tolerance is 2 s = 8 columns).
    _record(root, t0_idx=112, n=60, start_seq=112)

    with pytest.raises(ReplayStaleError) as ei:
        await mgr.subscribe(sub, ClientTx())
    # Machine-readable: the reason token rides the message, and the WS layer's
    # existing honest-replay refusal catches it via the superclass.
    assert "replay_stale" in str(ei.value)
    assert isinstance(ei.value, ReplayUnavailableError)

    # The refusal touched nothing: still registered, refcount unchanged, run
    # task alive, tail position and clients exactly as before.
    assert mgr._sessions.get(KEY) is sess
    assert sess.client_count == 1
    assert sess.replay_tail_t0 == (N0 - 1) * DT
    assert sess.run_task is not None and not sess.run_task.done()

    # Still stale: the recording has not shrunk, so the next attach refuses
    # again rather than serving the outdated replay.
    with pytest.raises(ReplayStaleError):
        await mgr.subscribe(sub, ClientTx())
    assert mgr._sessions.get(KEY) is sess

    await _retire(mgr, timer, sess)


async def test_growth_within_tolerance_boundary(tmp_path):
    """The exact tolerance boundary: growth OF exactly REPLAY_STALE_TOL_NS of
    recorded time is accepted (a one-column flush race must not refuse);
    one more recorded column is refused."""
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root)
    sub = _sub()

    sess = await mgr.subscribe(sub, ClientTx())
    tol_cols = REPLAY_STALE_TOL_NS // DT  # 8 columns at 250 ms
    # disk newest t0 == tail + TOL exactly -> not stale (<=).
    _record(root, t0_idx=N0, n=tol_cols, start_seq=N0)
    assert await mgr.subscribe(sub, ClientTx()) is sess

    # One more column past the boundary -> stale.
    _record(root, t0_idx=N0 + tol_cols, n=1, start_seq=N0 + tol_cols)
    with pytest.raises(ReplayStaleError):
        await mgr.subscribe(sub, ClientTx())
    assert mgr._sessions.get(KEY) is sess

    await _retire(mgr, timer, sess)


async def test_refusal_recovers_once_old_session_retires(tmp_path):
    """After the stale parked session retires, a re-subscribe builds a FRESH
    session from the NEW tail — the policy's documented recovery path."""
    root = Recorder(tmp_path / "rec", 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    mgr, timer = _manager(root)
    sub = _sub()

    stale = await mgr.subscribe(sub, ClientTx())
    _record(root, t0_idx=112, n=60, start_seq=112)
    with pytest.raises(ReplayStaleError):
        await mgr.subscribe(sub, ClientTx())

    await _retire(mgr, timer, stale)
    assert mgr._sessions.get(KEY) is None

    fresh = await mgr.subscribe(sub, ClientTx())
    assert fresh is not stale
    assert fresh.replay_tail_t0 == (112 + 60 - 1) * DT
    assert fresh.client_count == 1

    await _retire(mgr, timer, fresh)


# ---------------------------------------------------------------------------
# the disk probe behind the policy


def test_newest_column_t0_probe(tmp_path):
    base = tmp_path / "rec"
    root = Recorder(base, 20.0)
    assert root.newest_column_t0(MARKET, SYMBOL) is None  # nothing recorded yet
    _record(root, t0_idx=0, n=N0, start_seq=0)
    assert root.newest_column_t0(MARKET, SYMBOL) == (N0 - 1) * DT
    _record(root, t0_idx=112, n=3, start_seq=112)
    # The newest part file (second run's) wins over the older run's parts.
    assert root.newest_column_t0(MARKET, SYMBOL) == 114 * DT
    disabled = Recorder(tmp_path / "rec2", 20.0, enabled=False)
    assert disabled.newest_column_t0(MARKET, SYMBOL) is None


def test_newest_column_t0_skips_corrupt_newest_part(tmp_path):
    """A garbage file under a NEWER columns name (crash mid-write) must fall
    through to the newest READABLE part, not blind the probe to None."""
    base = tmp_path / "rec"
    root = Recorder(base, 20.0)
    _record(root, t0_idx=0, n=N0, start_seq=0)
    garbage = base / "sim" / SYMBOL / "29991231-23-columns-999999.parquet"
    garbage.write_bytes(b"not parquet at all")
    assert root.newest_column_t0(MARKET, SYMBOL) == (N0 - 1) * DT
