"""Pre-encoded snapshot frames (campaign item: kill the per-attach 8-16 MB
inline encode).

Finalized columns encode ONCE at finalize time; ``_snapshot_frames`` serves
attaches from that cache. These tests pin BYTE IDENTITY with the inline
encoder path (the golden/client wire tests stay the ultimate authority), the
LRU bound at the snapshot window, and cache hits never re-encoding.
"""

from __future__ import annotations

import asyncio

import numpy as np

import flowmap_server.core.session as session_mod
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.session import ClientTx, Session
from flowmap_server.feeds.base import BookState
from flowmap_server.proto import wire
from flowmap_server.proto.events import MODE_L2

DT = 250_000_000
ROWS = 64
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


async def test_snapshot_bytes_identical_to_inline_encoder():
    """The cached join is EXACTLY what the pre-cache snapshot path produced:
    wire.encode(grid.to_depth(col)) + wire.encode(col.bar), chunked 64 per
    frame after Hello+EpochStart."""
    feed = DrivenFeed()
    sess = Session("enc", feed=feed, grid=Grid(_cfg()), timer=FakeTimer())
    sess.attach(ClientTx())
    await sess.start()
    for i in range(11):
        feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
    await asyncio.sleep(0.05)

    # Independent recomputation over the grid ring (the OLD snapshot path).
    cols = sess._grid.history(2**63 - 1, session_mod.SNAPSHOT_COLS)
    assert len(cols) == 10
    expected_chunks = [
        b"".join(
            wire.encode(sess._grid.to_depth(c)) + wire.encode(c.bar)
            for c in cols[i : i + session_mod.SNAPSHOT_CHUNK_COLS]
        )
        for i in range(0, len(cols), session_mod.SNAPSHOT_CHUNK_COLS)
    ]

    frames = sess.attach(ClientTx())
    # frames[0] = Hello + EpochStarts; then one frame per <=64-column chunk;
    # then (only when non-empty) the tail frame (markers/tape/BBO) - this feed
    # emits books only, so there is no tail.
    assert frames[1 : 1 + len(expected_chunks)] == expected_chunks


async def test_second_attach_serves_cache_without_reencode():
    """A cache hit must not re-encode: after columns finalize (cache warm), a
    second attach with the encoder poisoned still serves byte-identical
    frames."""
    feed = DrivenFeed()
    sess = Session("enc2", feed=feed, grid=Grid(_cfg()), timer=FakeTimer())
    sess.attach(ClientTx())
    await sess.start()
    for i in range(6):
        feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
    await asyncio.sleep(0.05)

    first = sess.attach(ClientTx())[1]
    assert first  # the columns chunk
    assert sess._enc_cache  # finalized columns were cached at finalize time

    # Poison the encoder: any re-encode (or ring copy) would explode.
    def boom(*a, **k):
        raise AssertionError("snapshot re-encoded cached columns")

    sess._grid.to_depth = boom  # type: ignore[method-assign]
    second = sess.attach(ClientTx())[1]
    assert second == first


async def test_encode_cache_is_bounded_by_snapshot_window(monkeypatch):
    monkeypatch.setattr(session_mod, "SNAPSHOT_COLS", 4)
    feed = DrivenFeed()
    sess = Session("enc3", feed=feed, grid=Grid(_cfg()), timer=FakeTimer())
    sess.attach(ClientTx())
    await sess.start()
    for i in range(21):  # 20 finalized columns, cache capped at 4
        feed.q.put_nowait(BookState(i * DT, *_book(100.0)))
    await asyncio.sleep(0.05)
    assert len(sess._enc_cache) <= 4
    # ...and the NEWEST columns are the ones retained.
    assert max(sess._enc_cache) == 19

    # Ring-window invariant: entries beyond the cache are gone, but a snapshot
    # still serves everything - misses encode once with the stock path.
    frames = sess.attach(ClientTx())
    assert frames[1]
