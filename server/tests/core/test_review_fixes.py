"""Regression tests for the 2026-09-03 review-fix wave.

One test per reviewed finding, named after it:

- A1  live density saturates at float16 max instead of casting to +inf
- B1a hybrid-scale epochs round-trip AND Grid.preload restores the hybrid scale
- B1b legacy 6-column epochs files (pre-hybrid recordings) still load, as linear
- B2  a session torn down mid-boot starts no run task; SessionManager resubscribes
- B3  a ragged (corrupt) bid/ask block degrades to cold start (None), not a crash
- C2  a degenerate candle cannot hang columns_from_candles
- C3  a failed tail still lets the candle backfill run (the session keeps history)
- C4  a banded tail spanning the first anchor (two multiples) rehydrates
"""

from __future__ import annotations

import asyncio

import numpy as np
import polars as pl

from flowmap_server.config import Config
from flowmap_server.core.backfill import Candle, columns_from_candles
from flowmap_server.core.grid import FinalizedColumn, Grid, GridCfg
from flowmap_server.core.price_scale import SCALE_HYBRID, epoch_scale_fields, make_hybrid
from flowmap_server.core.record import Recorder, _EPOCHS_SCHEMA
from flowmap_server.core.session import ClientTx, Session, SessionManager
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto.events import BarColumn, EpochParams, Subscribe

DT_NS = 250_000_000
MARKET, SYMBOL = "sim", "SIM-DEMO"
ROWS = 64


def _cfg(**over) -> GridCfg:
    base = dict(
        tick=0.5,
        tick_multiple=1,
        dt_ns=DT_NS,
        p0=90.0,
        rows=ROWS,
        ring_columns=128,
        mode=0,
    )
    base.update(over)
    return GridCfg(**base)


def _col(seq: int, epoch: int = 0, rows: int = ROWS, peak: float = 10.0) -> FinalizedColumn:
    bid = np.full(rows, peak, dtype=np.float16)
    ask = np.full(rows, peak / 2, dtype=np.float16)
    bar = BarColumn(
        epoch=epoch,
        col_seq=seq,
        t0_ns=seq * DT_NS,
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
    return FinalizedColumn(epoch=epoch, col_seq=seq, t0_ns=seq * DT_NS, bid=bid, ask=ask, bar=bar)


def _record_all(base, cols, epochs) -> None:
    rec = Recorder(base, 20.0)
    s = rec.open_session(MARKET, SYMBOL)
    for e in epochs:
        s.record_epoch(e)
    for c in cols:
        s.record_column(c)
    s.flush()
    s.close()


class IdleFeed:
    market = "sim"
    symbol = "IDLE"
    capability: dict[str, object] = {"depth": "L2"}

    async def events(self):
        await asyncio.sleep(3600)
        if False:  # pragma: no cover
            yield None


class FakeTimer:
    def __init__(self) -> None:
        self.entries: list = []

    def __call__(self, delay_s: float, cb):
        h = type("H", (), {"cancelled": False, "cancel": lambda self: None})()
        self.entries.append(h)
        return h


# A1 --------------------------------------------------------------------------


def test_a1_live_density_saturates_at_f16_max():
    g = Grid(_cfg())
    px = np.array([100.0])
    huge = np.array([1e9])
    g.on_book(0, px, huge, px + 0.5, huge)
    cols = g.on_book(2 * DT_NS, px, huge, px + 0.5, huge)
    assert cols, "interval jump must finalize at least one column"
    for c in cols:
        assert np.isfinite(c.bid).all() and np.isfinite(c.ask).all()
        assert c.bid.max() == np.float16(65504)


# B1a -------------------------------------------------------------------------


def test_b1a_hybrid_epoch_round_trips_and_preload_restores_scale(tmp_path):
    scale = make_hybrid(
        mid=100.0, rows=ROWS, core_rows=ROWS // 2, core_step=0.5, up_mult=11.0, dn_floor=0.01
    )
    assert scale is not None and scale.kind == SCALE_HYBRID
    ep = EpochParams(
        epoch=0,
        tick=0.5,
        tick_multiple=1,
        dt_ns=DT_NS,
        p0=scale.p0,
        rows=ROWS,
        **epoch_scale_fields(scale),
    )
    assert ep.scale_kind == SCALE_HYBRID

    cols = [_col(i) for i in range(5)]
    _record_all(tmp_path / "rec", cols, [ep])
    rec = Recorder(tmp_path / "rec", 20.0)
    tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15, now_ns=10 * DT_NS, limit_cols=10)
    assert tail is not None
    assert tail.epochs == [ep], "hybrid fields must survive the parquet round-trip"

    g = Grid(_cfg(band_up=9.0, band_down=0.99, band_hybrid=True, core_rows=ROWS // 2))
    g.preload(tail.columns, tail.epochs)
    assert g._scale.kind == SCALE_HYBRID, "preload must rebuild the hybrid scale (H1)"
    assert np.isclose(g._scale.core_p0, scale.core_p0)


def test_b1b_legacy_six_column_epochs_still_load(tmp_path):
    cols = SimFeed.generate_history(seed=3, n_cols=8)
    epochs = [EpochParams(epoch=0, tick=0.5, tick_multiple=1, dt_ns=DT_NS, p0=90.0, rows=2048)]
    _record_all(tmp_path / "rec", cols, epochs)

    # Replace the recorder's epochs part with a pre-hybrid (6-column) one.
    legacy = pl.DataFrame(
        {
            "epoch": [0],
            "tick": [0.5],
            "tick_multiple": [1],
            "dt_ns": [DT_NS],
            "p0": [90.0],
            "rows": [2048],
        },
        schema={k: _EPOCHS_SCHEMA[k] for k in (
            "epoch", "tick", "tick_multiple", "dt_ns", "p0", "rows",
        )},
    )
    sym_dir = tmp_path / "rec" / MARKET / SYMBOL
    for f in sym_dir.glob("*-epochs-*.parquet"):
        f.unlink()
    legacy.write_parquet(sym_dir / "0001-epochs-legacy.parquet")

    rec = Recorder(tmp_path / "rec", 20.0)
    tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15, now_ns=10 * DT_NS, limit_cols=10)
    assert tail is not None, "a legacy recording must not be rejected"
    assert tail.epochs[0].scale_kind == 0
    assert tail.epochs[0].dn_rows == 0 and tail.epochs[0].core_p0 == 0.0


# B2 --------------------------------------------------------------------------


async def test_b2_session_torn_down_mid_boot_starts_nothing():
    sess = Session("dead-boot", feed=IdleFeed(), grid=Grid(_cfg()), timer=FakeTimer())
    sess._closed = True  # teardown fired during the boot await
    assert await sess.start() is None
    assert sess.run_task is None, "no feed task may outlive a torn-down session"


async def test_b2_manager_resubscribes_after_midboot_teardown(monkeypatch):
    """First boot races a teardown: subscribe must retry ONCE onto a fresh,
    LIVE session — never hand out (or leak) the corpse (H2 + L2)."""
    cfg = Config(max_sessions=4, ring_columns=256, max_rows=64, dt_crypto_ns=DT_NS)
    mgr = SessionManager(cfg, timer=FakeTimer(), feed_factory=lambda sub: IdleFeed())
    sub = Subscribe(market="sim", symbol="IDLE", mode="live", source=None, start_t=None)

    calls = {"booted": 0}
    orig_boot = Session._boot

    async def boot_once_then_close(self):
        calls["booted"] += 1
        if calls["booted"] == 1:
            # The grace teardown wins the race while boot is awaiting.
            self._closed = True
            return
        await orig_boot(self)

    monkeypatch.setattr(Session, "_boot", boot_once_then_close)

    client = ClientTx()
    sess = await mgr.subscribe(sub, client)
    assert calls["booted"] == 2, "exactly one re-subscribe after the dead boot"
    assert not sess._closed, "the handed-out session must be alive"
    assert sess.run_task is not None
    assert all(s is not sess for s in mgr._sessions.values() if s._closed)

    # Tidy the pending IdleFeed run task.
    sess.run_task.cancel()
    try:
        await sess.run_task
    except asyncio.CancelledError:
        pass


# B3 --------------------------------------------------------------------------


def test_b3_ragged_bid_block_degrades_to_none(tmp_path):
    cols = SimFeed.generate_history(seed=3, n_cols=8)
    _record_all(tmp_path / "rec", cols, [
        EpochParams(epoch=0, tick=0.5, tick_multiple=1, dt_ns=DT_NS, p0=90.0, rows=2048)
    ])
    f = next((tmp_path / "rec" / MARKET / SYMBOL).glob("*-columns-*.parquet"))
    df = pl.read_parquet(f)
    bids = df["bid"].to_list()
    bids[0] = bids[0][:-1]  # ragged: one row lost a value
    df = df.with_columns(pl.Series("bid", bids, dtype=pl.List(pl.Float32)))
    df.write_parquet(f)

    rec = Recorder(tmp_path / "rec", 20.0)
    tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15, now_ns=10 * DT_NS, limit_cols=10)
    assert tail is None, "a corrupt block must cold-start, not crash the boot"


# C2 --------------------------------------------------------------------------


def test_c2_degenerate_candle_clamps_before_range():
    cfg = _cfg()
    candles = [
        Candle(t0_ns=0, o=100.0, h=100.5, l=99.5, c=100.0, volume=10.0),
        # Absurd high/low: row span of billions — must clamp, not hang.
        Candle(t0_ns=DT_NS, o=100.0, h=1e18, l=-1e18, c=100.0, volume=10.0),
        Candle(t0_ns=2 * DT_NS, o=100.0, h=100.5, l=99.5, c=100.0, volume=10.0),
    ]
    out = columns_from_candles(candles, cfg)
    assert out is not None
    built, ep = out
    assert len(built) == 3
    for c in built:
        assert len(c.bid) == ROWS and len(c.ask) == ROWS


# C3 --------------------------------------------------------------------------


async def test_c3_failed_tail_still_backfills(tmp_path):
    # Tail recorded under rows=64; the new session runs rows=128: preload
    # fails, and the candle backfill must STILL run (M2) so the session keeps
    # history instead of starting from a void.
    tail_rows = 64
    rec_root = Recorder(tmp_path / "rec", 20.0)
    s = rec_root.open_session(MARKET, SYMBOL)
    old_ep = EpochParams(epoch=0, tick=0.5, tick_multiple=1, dt_ns=DT_NS, p0=90.0, rows=tail_rows)
    s.record_epoch(old_ep)
    for i in range(5):
        s.record_column(_col(i, rows=tail_rows))
    s.flush()
    s.close()

    def candles(n: int) -> list[Candle]:
        return [
            Candle(
                t0_ns=i * 60 * 10**9,
                o=100.0,
                h=100.5,
                l=99.5,
                c=100.0,
                volume=10.0,
            )
            for i in range(n)
        ]

    class BF:
        def __call__(self, market, symbol, *, max_cols, now_ns):
            self.called = True
            return candles(min(max_cols, 20))

    bf = BF()
    feed = IdleFeed()
    feed.market, feed.symbol = MARKET, SYMBOL
    sess = Session(
        "cold-history",
        feed=feed,
        grid=Grid(_cfg(rows=128)),
        recorder=rec_root,
        wall_clock=lambda: 10 * DT_NS,
        timer=FakeTimer(),
        backfill_fn=bf,
        backfill_max_cols=20,
    )
    await sess.start()
    assert bf.called, "backfill must run after a failed tail (M2)"
    client = ClientTx()
    snap = sess.attach(client)
    assert snap  # session usable


# C4 --------------------------------------------------------------------------


def test_c4_tail_spanning_first_anchor_preloads():
    cfg = _cfg(band_up=9.0, band_down=0.99)
    g = Grid(cfg)
    assert g._banded
    e0 = EpochParams(epoch=0, tick=0.5, tick_multiple=1, dt_ns=DT_NS, p0=90.0, rows=ROWS)
    e1 = EpochParams(epoch=1, tick=0.5, tick_multiple=4, dt_ns=DT_NS, p0=90.0, rows=ROWS)
    cols = [_col(i, epoch=0 if i < 3 else 1) for i in range(6)]
    # Old validation rejected the mixed {1, 4} multiples outright, permanently
    # orphaning such recordings (M3).
    g.preload(cols, [e0, e1])
    assert g._tick_multiple == 4, "the NEWEST epoch's frozen multiple wins"
    assert g._count == 6
