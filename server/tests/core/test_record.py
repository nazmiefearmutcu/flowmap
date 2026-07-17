"""Recording + retention + tail-load tests (design spec §7 replay, §8.1 restart).

All data is driven by ``SimFeed.generate_history`` (deterministic, no wall
clock); files land under pytest ``tmp_path``. The tests pin:

1. round-trip bit-fidelity (f16 arrays, bar fields, epochs, newest_t0_ns)
2. age cutoff (``t0_ns >= now_ns - max_age_ns``; all-old -> None)
3. limit_cols (newest N)
4. retention (delete lexicographically-oldest first, size under cap after)
5. enabled=False no-ops
6. multi-flush part files merge in order
7. hourly file split on an hour boundary
8. columns spanning two epochs -> both epochs in TailData
"""

import math

import msgspec
import numpy as np

from flowmap_server.core.record import Recorder
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto.events import (
    SIDE_BUY,
    SIDE_SELL,
    SIDE_SRC_EXCHANGE,
    EpochParams,
    Marker,
    Trade,
)

DT_NS = 250_000_000  # generate_history default cadence
MARKET, SYMBOL = "sim", "SIM-DEMO"
ROWS = 2048  # generate_history default

# Epoch-0 params exactly as generate_history's private Grid uses them
# (mid0=100.0, tick=0.5, tick_multiple=1).
P0 = round((100.0 - ROWS * 0.5 / 2.0) / 0.5) * 0.5
EPOCH0 = EpochParams(epoch=0, tick=0.5, tick_multiple=1, dt_ns=DT_NS, p0=P0, rows=ROWS)


def feq(a: float, b: float) -> bool:
    """Float equality that treats NaN == NaN (bars carry NaN before trades)."""
    return (math.isnan(a) and math.isnan(b)) or a == b


def record_all(rec, cols, *, epochs=(EPOCH0,), trades=(), markers=()):
    s = rec.open_session(MARKET, SYMBOL)
    for e in epochs:
        s.record_epoch(e)
    for c in cols:
        s.record_column(c)
    for t in trades:
        s.record_trade(t)
    for m in markers:
        s.record_marker(m)
    s.flush()
    s.close()


def sym_dir(base):
    return base / MARKET / SYMBOL


# 1. round-trip fidelity ------------------------------------------------------


def test_round_trip_bit_identical(tmp_path):
    cols = SimFeed.generate_history(seed=3, n_cols=100)
    trades = [
        Trade(ts_ns=100_000_000, price=100.0, size=1.5,
              side=SIDE_BUY, side_src=SIDE_SRC_EXCHANGE, venue="sim"),
        Trade(ts_ns=12_600_000_000, price=99.5, size=0.25,
              side=SIDE_SELL, side_src=SIDE_SRC_EXCHANGE, venue="sim"),
        Trade(ts_ns=24_800_000_000, price=101.0, size=3.0,
              side=SIDE_BUY, side_src=SIDE_SRC_EXCHANGE, venue="sim"),
    ]
    markers = [
        Marker(ts_ns=5_000_000_000, kind="liquidation", text="liq", price=100.5, size=12.0),
        Marker(ts_ns=20_000_000_000, kind="gap"),  # price/size None round-trip
    ]
    rec = Recorder(tmp_path / "rec", 20.0)
    record_all(rec, cols, trades=trades, markers=markers)

    tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15,
                         now_ns=25_000_000_000, limit_cols=100)
    assert tail is not None
    assert len(tail.columns) == 100
    assert tail.newest_t0_ns == cols[-1].t0_ns == 99 * DT_NS
    for orig, got in zip(cols, tail.columns):
        assert got.bid.dtype == np.float16 and got.ask.dtype == np.float16
        assert np.array_equal(orig.bid, got.bid)
        assert np.array_equal(orig.ask, got.ask)
        assert (got.epoch, got.col_seq, got.t0_ns) == (orig.epoch, orig.col_seq, orig.t0_ns)
        assert (got.bar.epoch, got.bar.col_seq, got.bar.t0_ns) == (
            orig.bar.epoch, orig.bar.col_seq, orig.bar.t0_ns)
        for f in ("vol_buy", "vol_sell", "cvd_cum", "vwap_num_cum", "vwap_den_cum"):
            assert getattr(got.bar, f) == getattr(orig.bar, f), f
        for f in ("o", "h", "l", "c"):
            assert feq(getattr(got.bar, f), getattr(orig.bar, f)), f
    assert tail.epochs == [EPOCH0]
    assert tail.trades == trades
    assert tail.markers == markers
    # unknown symbol -> None
    assert rec.load_tail("nope", "NOPE", max_age_ns=10**15,
                         now_ns=0, limit_cols=10) is None


# 2. age cutoff ---------------------------------------------------------------


def test_age_cutoff_excludes_old(tmp_path):
    cols = SimFeed.generate_history(seed=3, n_cols=100)
    rec = Recorder(tmp_path / "rec", 20.0)
    record_all(rec, cols)

    now = 99 * DT_NS  # == newest t0
    tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=10 * DT_NS,
                         now_ns=now, limit_cols=100)
    assert tail is not None
    # cutoff = now - 10*dt = t0 of col 89; boundary inclusive
    assert [c.col_seq for c in tail.columns] == list(range(89, 100))
    assert tail.newest_t0_ns == 99 * DT_NS

    # everything older than max_age -> None
    assert rec.load_tail(MARKET, SYMBOL, max_age_ns=DT_NS,
                         now_ns=10**18, limit_cols=100) is None


# 3. limit_cols ---------------------------------------------------------------


def test_limit_cols_returns_newest_n(tmp_path):
    cols = SimFeed.generate_history(seed=3, n_cols=100)
    rec = Recorder(tmp_path / "rec", 20.0)
    record_all(rec, cols)

    tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15,
                         now_ns=25_000_000_000, limit_cols=10)
    assert tail is not None
    assert [c.col_seq for c in tail.columns] == list(range(90, 100))
    assert np.array_equal(tail.columns[-1].bid, cols[-1].bid)


# 4. retention ----------------------------------------------------------------


def test_retention_prunes_oldest_by_name(tmp_path):
    base = tmp_path / "rec"
    writer = Recorder(base, 20.0)
    s = writer.open_session(MARKET, SYMBOL)
    cols = SimFeed.generate_history(seed=3, n_cols=50)
    for i in range(5):
        for c in cols[i * 10:(i + 1) * 10]:
            s.record_column(c)
        s.flush()
    s.close()

    files = sorted(sym_dir(base).glob("*-columns-*.parquet"), key=lambda p: p.name)
    assert len(files) == 5

    # A generous cap prunes nothing.
    assert Recorder(base, 20.0).enforce_retention() == []
    assert sorted(sym_dir(base).glob("*.parquet"), key=lambda p: p.name) == files

    # Cap sized to hold exactly the newest two part files (+1 KiB slack so
    # GB float conversion can't round below them) -> the three oldest go.
    keep_bytes = files[3].stat().st_size + files[4].stat().st_size
    pruner = Recorder(base, (keep_bytes + 1024) / 1e9)
    pruned = pruner.enforce_retention()
    assert pruned == files[:3]
    remaining = sorted(sym_dir(base).glob("*.parquet"), key=lambda p: p.name)
    assert remaining == files[3:]
    assert sum(f.stat().st_size for f in remaining) <= keep_bytes + 1024


# 5. enabled=False ------------------------------------------------------------


def test_disabled_is_noop(tmp_path):
    base = tmp_path / "rec"
    rec = Recorder(base, 20.0, enabled=False)
    s = rec.open_session(MARKET, SYMBOL)
    s.record_epoch(EPOCH0)
    for c in SimFeed.generate_history(seed=3, n_cols=5):
        s.record_column(c)
    s.record_trade(Trade(ts_ns=1, price=100.0, size=1.0,
                         side=SIDE_BUY, side_src=SIDE_SRC_EXCHANGE, venue="sim"))
    s.record_marker(Marker(ts_ns=2, kind="info"))
    s.flush()
    s.close()

    assert not base.exists()
    assert rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15,
                         now_ns=10**12, limit_cols=10) is None
    assert rec.enforce_retention() == []


# 6. multi-flush part files ---------------------------------------------------


def test_multi_flush_parts_merge_in_order(tmp_path):
    base = tmp_path / "rec"
    rec = Recorder(base, 20.0)
    cols = SimFeed.generate_history(seed=3, n_cols=30)
    s = rec.open_session(MARKET, SYMBOL)
    s.record_epoch(EPOCH0)
    for i in range(3):
        for c in cols[i * 10:(i + 1) * 10]:
            s.record_column(c)
        s.flush()
    s.close()

    parts = sorted(sym_dir(base).glob("*-columns-*.parquet"), key=lambda p: p.name)
    assert len(parts) == 3

    tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15,
                         now_ns=30 * DT_NS, limit_cols=30)
    assert tail is not None
    assert [c.col_seq for c in tail.columns] == list(range(30))
    for orig, got in zip(cols, tail.columns):
        assert np.array_equal(orig.bid, got.bid)

    # A limit that straddles part boundaries still yields the newest N in order.
    tail2 = rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15,
                          now_ns=30 * DT_NS, limit_cols=15)
    assert tail2 is not None
    assert [c.col_seq for c in tail2.columns] == list(range(15, 30))


# 7. hourly split -------------------------------------------------------------


def test_hour_boundary_splits_files(tmp_path):
    hour_ns = 3_600 * 10**9
    start = hour_ns - 10 * DT_NS  # multiple of DT_NS; 10 cols land before 01:00
    cols = SimFeed.generate_history(seed=3, n_cols=20, start_ns=start)
    assert [c.t0_ns for c in cols] == [start + i * DT_NS for i in range(20)]

    base = tmp_path / "rec"
    rec = Recorder(base, 20.0)
    record_all(rec, cols)

    hours = {f.name.split("-columns-")[0]
             for f in sym_dir(base).glob("*-columns-*.parquet")}
    assert hours == {"19700101-00", "19700101-01"}

    tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15,
                         now_ns=start + 20 * DT_NS, limit_cols=20)
    assert tail is not None
    assert [c.t0_ns for c in tail.columns] == [start + i * DT_NS for i in range(20)]


# 8. epoch spanning -----------------------------------------------------------


def test_columns_from_two_epochs_bring_both_epochs(tmp_path):
    cols = SimFeed.generate_history(seed=3, n_cols=20)
    relabeled = []
    for c in cols:
        if c.col_seq >= 10:  # pretend a re-anchor happened at col 10
            c = msgspec.structs.replace(
                c, epoch=1, bar=msgspec.structs.replace(c.bar, epoch=1))
        relabeled.append(c)
    epoch1 = msgspec.structs.replace(EPOCH0, epoch=1, p0=P0 + 5.0)

    rec = Recorder(tmp_path / "rec", 20.0)
    record_all(rec, relabeled, epochs=(EPOCH0, epoch1))

    tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15,
                         now_ns=20 * DT_NS, limit_cols=20)
    assert tail is not None
    assert tail.epochs == [EPOCH0, epoch1]
    assert {c.epoch for c in tail.columns} == {0, 1}

    # A tail touching only epoch-1 columns carries only epoch 1.
    tail2 = rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15,
                          now_ns=20 * DT_NS, limit_cols=5)
    assert tail2 is not None
    assert tail2.epochs == [epoch1]
