"""ReplayFeed unit tests — pacing, controls, and synthesized snapshots.

The feed replays a real Recorder round-trip (SimFeed.generate_history →
parquet → load_all) so the synthesized BookState path is exercised against
genuine recorded data, not a hand-built fixture. Streaming tests drive ONE
events() generator each and ``aclose()`` it explicitly — the feed parks
forever at end-of-recording, so abandoning the generator is the exit.
"""

from __future__ import annotations

import asyncio

import numpy as np
import pytest

from flowmap_server.core.record import Recorder
from flowmap_server.feeds.replay import ReplayFeed
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto import events
from flowmap_server.proto.events import EpochParams

DT_NS = 250_000_000
MARKET, SYMBOL = "sim", "SIM-DEMO"
ROWS = 2048
P0 = round((100.0 - ROWS * 0.5 / 2.0) / 0.5) * 0.5
EPOCH0 = EpochParams(epoch=0, tick=0.5, tick_multiple=1, dt_ns=DT_NS, p0=P0, rows=ROWS)


def _make_feed(tmp_path, n_cols: int, speed: float = 1.0) -> ReplayFeed:
    cols = SimFeed.generate_history(seed=7, n_cols=n_cols)
    rec = Recorder(tmp_path / "rec", 20.0)
    s = rec.open_session(MARKET, SYMBOL)
    s.record_epoch(EPOCH0)
    for c in cols:
        s.record_column(c)
    s.flush()
    s.close()
    tail = rec.load_all(MARKET, SYMBOL)
    assert tail is not None and len(tail.columns) == n_cols
    return ReplayFeed(market=MARKET, symbol=SYMBOL, tail=tail, speed=speed)


async def test_fast_replay_delivers_every_recorded_column(tmp_path):
    feed = _make_feed(tmp_path, n_cols=10, speed=1e6)
    gen = feed.events()
    books = []
    async with asyncio.timeout(5):
        while len(books) < 10:
            ev = await gen.__anext__()
            if ev.__class__.__name__ == "BookState":
                books.append(ev)
    await gen.aclose()
    # One synthesized snapshot per recorded column, in order, at the column's t0.
    assert [b.ts_ns for b in books] == [i * DT_NS for i in range(10)]
    first = books[0]
    assert len(first.bid_px) == len(first.bid_sz) and len(first.bid_px) > 0
    assert np.all(np.isfinite(first.bid_px)) and np.all(first.bid_sz > 0)


async def test_pause_freezes_the_clock_until_resume(tmp_path):
    feed = _make_feed(tmp_path, n_cols=12, speed=1e6)
    feed.control(events.Pause())
    t1 = feed._clock.now()
    await asyncio.sleep(0.15)
    assert feed._clock.now() == t1, "a paused replay clock must not advance"

    feed.control(events.Resume())
    await asyncio.sleep(0.15)
    assert feed._clock.now() > t1, "resume releases the clock"


async def test_seek_jumps_cursor_and_streams_from_there(tmp_path):
    feed = _make_feed(tmp_path, n_cols=12, speed=1e6)
    feed.control(events.Seek(t=5 * DT_NS))
    assert feed._cursor == 5, "cursor lands on the interval containing t"

    gen = feed.events()
    ev = await asyncio.wait_for(gen.__anext__(), 5)
    assert ev.ts_ns == 5 * DT_NS
    await gen.aclose()


async def test_set_speed_accelerates_delivery(tmp_path):
    feed = _make_feed(tmp_path, n_cols=12, speed=1.0)
    gen = feed.events()
    first = await asyncio.wait_for(gen.__anext__(), 5)
    assert first.ts_ns == 0

    # At 1× the next column is 250 ms away; a 10 000× speed must make it
    # arrive near-instantly.
    feed.control(events.SetSpeed(x=10_000))
    second = await asyncio.wait_for(gen.__anext__(), 0.5)
    assert second.ts_ns == DT_NS
    await gen.aclose()


async def test_end_of_recording_parks_instead_of_ending(tmp_path):
    feed = _make_feed(tmp_path, n_cols=4, speed=1e6)
    gen = feed.events()
    got = 0
    async with asyncio.timeout(5):
        while got < 4:
            await gen.__anext__()
            got += 1
    # Past the last column the feed must NOT stop (StopAsyncIteration would
    # tear the session down) — it parks and holds.
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(gen.__anext__(), 0.4)
    await gen.aclose()
