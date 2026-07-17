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
9. restart continues part numbering (no collisions, merged load)
10. orphaned epochs (pruned/deleted) -> load_tail None
11. corrupt parquet skipped with a warning; all-corrupt -> None
12. partial flush failure + retry writes no duplicate col_seqs
13. ranged reads never open files outside the hour window
14. retention exempts epochs files and the newest columns part per symbol
"""

import logging
import math
from pathlib import Path

import msgspec
import numpy as np
import polars as pl
import pytest

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


# 9. restart part-counter continuation ----------------------------------------


def test_restart_continues_part_numbering(tmp_path):
    base = tmp_path / "rec"
    rec = Recorder(base, 20.0)
    cols = SimFeed.generate_history(seed=3, n_cols=20)

    s1 = rec.open_session(MARKET, SYMBOL)
    s1.record_epoch(EPOCH0)
    for c in cols[:10]:
        s1.record_column(c)
    s1.flush()
    s1.close()
    parts1 = {int(f.stem.rsplit("-", 1)[-1]) for f in sym_dir(base).glob("*.parquet")}

    s2 = rec.open_session(MARKET, SYMBOL)  # simulated restart, same symbol
    for c in cols[10:]:
        s2.record_column(c)
    s2.flush()
    s2.close()
    parts2 = {int(f.stem.rsplit("-", 1)[-1]) for f in sym_dir(base).glob("*.parquet")} - parts1
    assert parts2 and min(parts2) > max(parts1)  # continued past disk, no collision

    tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15,
                         now_ns=20 * DT_NS, limit_cols=20)
    assert tail is not None
    assert [c.col_seq for c in tail.columns] == list(range(20))


# 10. orphaned epochs ---------------------------------------------------------


def test_orphaned_epochs_return_none(tmp_path):
    base = tmp_path / "rec"
    rec = Recorder(base, 20.0)
    record_all(rec, SimFeed.generate_history(seed=3, n_cols=10))
    (ep_file,) = sym_dir(base).glob("*-epochs-*.parquet")
    ep_file.unlink()  # columns survive but cannot be placed on a price grid

    assert rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15,
                         now_ns=10 * DT_NS, limit_cols=10) is None


# 11. corrupt parquet tolerance -----------------------------------------------


def test_corrupt_parquet_skipped_with_warning(tmp_path, caplog):
    base = tmp_path / "rec"
    rec = Recorder(base, 20.0)
    cols = SimFeed.generate_history(seed=3, n_cols=20)
    s = rec.open_session(MARKET, SYMBOL)
    s.record_epoch(EPOCH0)
    for c in cols[:10]:
        s.record_column(c)
    s.flush()
    for c in cols[10:]:
        s.record_column(c)
    s.flush()
    s.close()
    parts = sorted(sym_dir(base).glob("*-columns-*.parquet"), key=lambda p: p.name)
    assert len(parts) == 2
    parts[1].write_bytes(b"not a parquet file")  # newest part truncated/corrupt

    with caplog.at_level(logging.WARNING, logger="flowmap_server.core.record"):
        tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15,
                             now_ns=20 * DT_NS, limit_cols=20)
    assert "skipping unreadable recording file" in caplog.text
    assert tail is not None  # intact older part still served
    assert [c.col_seq for c in tail.columns] == list(range(10))

    parts[0].write_bytes(b"also garbage")  # every columns part unreadable
    assert rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15,
                         now_ns=20 * DT_NS, limit_cols=20) is None


# 12. partial flush failure ---------------------------------------------------


def test_partial_flush_failure_retry_no_duplicates(tmp_path, monkeypatch):
    hour_ns = 3_600 * 10**9
    start = hour_ns - 10 * DT_NS  # two hour-groups inside one flush
    cols = SimFeed.generate_history(seed=3, n_cols=20, start_ns=start)
    base = tmp_path / "rec"
    rec = Recorder(base, 20.0)
    s = rec.open_session(MARKET, SYMBOL)
    s.record_epoch(EPOCH0)
    for c in cols:
        s.record_column(c)

    real = pl.DataFrame.write_parquet
    calls = {"n": 0}

    def flaky(self, *a, **k):
        calls["n"] += 1
        if calls["n"] == 2:  # the second columns hour-group
            raise OSError("disk full (injected)")
        return real(self, *a, **k)

    monkeypatch.setattr(pl.DataFrame, "write_parquet", flaky)
    with pytest.raises(OSError, match="disk full"):
        s.flush()
    s.flush()  # retry (only call 2 is flaky) must write ONLY the failed group
    s.close()

    col_files = sorted(sym_dir(base).glob("*-columns-*.parquet"), key=lambda p: p.name)
    assert len(col_files) == 2  # the landed group was not rewritten
    on_disk = [seq for f in col_files for seq in pl.read_parquet(f)["col_seq"].to_list()]
    assert sorted(on_disk) == list(range(20))  # every col_seq exactly once
    assert not list(sym_dir(base).glob("*.tmp"))  # failed temp cleaned up

    tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15,
                         now_ns=start + 20 * DT_NS, limit_cols=20)
    assert tail is not None
    assert [c.col_seq for c in tail.columns] == list(range(20))


# 13. ranged reads ------------------------------------------------------------


def test_ranged_reads_skip_out_of_window_files(tmp_path, monkeypatch):
    hour_ns = 3_600 * 10**9
    start = hour_ns - 10 * DT_NS
    cols = SimFeed.generate_history(seed=3, n_cols=20, start_ns=start)
    trades = [
        Trade(ts_ns=start + DT_NS // 2, price=100.0, size=1.0,
              side=SIDE_BUY, side_src=SIDE_SRC_EXCHANGE, venue="sim"),  # hour 00
        Trade(ts_ns=hour_ns + DT_NS // 2, price=100.5, size=2.0,
              side=SIDE_SELL, side_src=SIDE_SRC_EXCHANGE, venue="sim"),  # hour 01
    ]
    base = tmp_path / "rec"
    rec = Recorder(base, 20.0)
    record_all(rec, cols, trades=trades)
    for kind in ("columns", "trades"):  # sanity: both kinds split by hour
        hours = {f.name[:11] for f in sym_dir(base).glob(f"*-{kind}-*.parquet")}
        assert hours == {"19700101-00", "19700101-01"}, kind

    opened: list[str] = []
    real = pl.read_parquet

    def counting(path, *a, **k):
        opened.append(Path(path).name)
        return real(path, *a, **k)

    monkeypatch.setattr(pl, "read_parquet", counting)
    # Age cutoff exactly at the hour boundary: hour-00 files are out of range
    # for both the columns cutoff and the trades window — never opened.
    tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=10 * DT_NS,
                         now_ns=start + 20 * DT_NS, limit_cols=20)
    assert tail is not None
    assert [c.t0_ns for c in tail.columns] == [hour_ns + i * DT_NS for i in range(10)]
    assert [t.ts_ns for t in tail.trades] == [hour_ns + DT_NS // 2]
    assert opened
    assert not any(n.startswith("19700101-00-columns") for n in opened)
    assert not any(n.startswith("19700101-00-trades") for n in opened)


# 14. retention exemptions ----------------------------------------------------


def test_retention_exempts_epochs_and_newest_columns(tmp_path):
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
    all_files = sorted(sym_dir(base).glob("*.parquet"), key=lambda p: p.name)
    col_files = [f for f in all_files if "-columns-" in f.name]
    (ep_file,) = [f for f in all_files if "-epochs-" in f.name]
    assert len(col_files) == 3

    # Cap 0 prunes everything eligible — but never epochs, never the newest
    # columns part of the symbol.
    pruned = Recorder(base, 0.0).enforce_retention()
    assert pruned == col_files[:2]
    survivors = sorted(sym_dir(base).glob("*.parquet"), key=lambda p: p.name)
    assert survivors == [col_files[2], ep_file]

    # The surviving tail is still fully loadable (no orphan pathology).
    tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=10**15,
                         now_ns=30 * DT_NS, limit_cols=30)
    assert tail is not None
    assert [c.col_seq for c in tail.columns] == list(range(20, 30))
