"""Parquet self-recording, size-capped retention, and tail-load.

Design spec §7 (replay column: every live session self-records) and §8.1
(restart: rehydrate the ring tail from the newest recording if fresh, else
cold start + gap marker — the *wiring* into Session is a later task; this
module only provides the storage primitives).

Layout::

    base_dir/{market}/{symbol}/{YYYYMMDD-HH}-{kind}-{part:06d}.parquet

with ``kind`` in {columns, trades, markers, epochs}. Load-bearing decisions:

- **No wall-clock reads anywhere.** Hour buckets derive from event
  timestamps (``t0_ns`` / ``ts_ns``, interpreted as UTC ns since epoch), and
  retention orders files by *filename*, never mtime: the ``YYYYMMDD-HH``
  prefix plus the zero-padded part counter make lexicographic order equal
  chronological order. Everything is deterministic under synthetic clocks.
- **Parquet cannot append.** :class:`SessionRecorder` buffers rows in memory
  and every ``flush()`` writes fresh *part files* with a monotonically
  increasing 6-digit suffix. The counter is shared across kinds/hours within
  a session and initialized past any parts already on disk, so a restarted
  session never collides with (or sorts before) its predecessor's files.
- **f16 fidelity.** Ring densities are float16; Parquet has no f16, so
  arrays are stored as ``list[f32]``. f16→f32 widening is exact, and every
  stored value *is* an exact f16 (it was cast from one in the grid), so the
  f32→f16 cast on load is bit-lossless (pinned by test 1).
- **Bar identity.** ``BarColumn.epoch/col_seq/t0_ns`` always equal the
  enclosing :class:`FinalizedColumn`'s (grid invariant: ``_snap_bar`` runs at
  finalize time), so only the payload bar fields are stored flat and the
  identity fields are rebuilt from the column row on load.
- **Epoch rows have no timestamp**, so at flush time they are bucketed into
  the hour of the newest event timestamp seen so far (falling back to hour 0
  before any timestamped event). Correctness never depends on the bucket —
  ``load_tail`` reads *all* epochs files — the choice only keeps the epochs
  file near the newest data in retention order.
- **Retention tradeoff** (kept deliberately simple): ``enforce_retention``
  deletes the lexicographically oldest ``*.parquet`` files *globally* —
  across symbols and kinds — until the total size is within the cap. It may
  therefore delete the last columns file of an idle symbol, or an epochs
  file whose columns survive; in that case ``load_tail`` degrades to
  ``None`` (cold start + gap marker per §8.1) rather than serving columns it
  cannot place on a price grid.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import msgspec
import numpy as np
import polars as pl

from flowmap_server.core.grid import FinalizedColumn
from flowmap_server.proto.events import BarColumn, EpochParams, Marker, Trade

__all__ = ["Recorder", "SessionRecorder", "TailData"]

_GB = 1_000_000_000

_COLUMNS_SCHEMA = {
    "epoch": pl.UInt32,
    "col_seq": pl.UInt32,
    "t0_ns": pl.Int64,
    "bid": pl.List(pl.Float32),
    "ask": pl.List(pl.Float32),
    "o": pl.Float64,
    "h": pl.Float64,
    "l": pl.Float64,
    "c": pl.Float64,
    "vol_buy": pl.Float64,
    "vol_sell": pl.Float64,
    "cvd_cum": pl.Float64,
    "vwap_num_cum": pl.Float64,
    "vwap_den_cum": pl.Float64,
}
_TRADES_SCHEMA = {
    "ts_ns": pl.Int64,
    "price": pl.Float64,
    "size": pl.Float64,
    "side": pl.UInt8,
    "side_src": pl.UInt8,
    "venue": pl.String,
}
_MARKERS_SCHEMA = {
    "ts_ns": pl.Int64,
    "kind": pl.String,
    "text": pl.String,
    "price": pl.Float64,
    "size": pl.Float64,
}
_EPOCHS_SCHEMA = {
    "epoch": pl.UInt32,
    "tick": pl.Float64,
    "tick_multiple": pl.Int64,
    "dt_ns": pl.Int64,
    "p0": pl.Float64,
    "rows": pl.Int64,
}


def _hour_key(ts_ns: int) -> str:
    """UTC ``YYYYMMDD-HH`` bucket for an epoch-ns timestamp."""
    return datetime.fromtimestamp(ts_ns // 1_000_000_000, tz=timezone.utc).strftime("%Y%m%d-%H")


def _safe_component(name: str) -> str:
    """Filesystem-safe path component for market/symbol (e.g. 'BTC/USDT')."""
    return "".join("_" if ch in "/\\:" else ch for ch in name) or "_"


def _by_name(p: Path) -> tuple[str, str]:
    return (p.name, str(p))


class TailData(msgspec.Struct):
    """Result of :meth:`Recorder.load_tail` — everything Session rehydration
    needs, chronological (oldest first). ``epochs`` contains exactly the
    epochs referenced by ``columns``, sorted by epoch number."""

    epochs: list[EpochParams]
    columns: list[FinalizedColumn]
    trades: list[Trade]
    markers: list[Marker]
    newest_t0_ns: int


class SessionRecorder:
    """Append-only buffered Parquet writer for ONE (market, symbol).

    ``record_*`` buffer in memory; ``flush()`` writes one part file per
    (hour, kind) that has buffered rows and clears the buffers; ``close()``
    flushes and rejects further writes. Created via
    :meth:`Recorder.open_session` — not directly.
    """

    def __init__(self, sym_dir: Path | None, *, enabled: bool) -> None:
        self._enabled = enabled and sym_dir is not None
        self._dir = sym_dir
        self._closed = False
        self._columns: list[FinalizedColumn] = []
        self._trades: list[Trade] = []
        self._markers: list[Marker] = []
        self._epochs: list[EpochParams] = []
        self._max_ts_ns = 0  # newest event timestamp seen (buckets epoch rows)
        self._part = self._scan_next_part() if self._enabled else 0

    def _scan_next_part(self) -> int:
        """Continue part numbering past anything already on disk so restarts
        never collide and lexicographic file order stays chronological."""
        assert self._dir is not None
        newest = -1
        for p in self._dir.glob("*.parquet"):
            tail = p.stem.rsplit("-", 1)[-1]
            if tail.isdigit():
                newest = max(newest, int(tail))
        return newest + 1

    def _check_open(self) -> None:
        if self._closed:
            raise RuntimeError("SessionRecorder is closed")

    # -- record ----------------------------------------------------------------

    def record_epoch(self, params: EpochParams) -> None:
        self._check_open()
        if not self._enabled:
            return
        self._epochs.append(params)

    def record_column(self, col: FinalizedColumn) -> None:
        self._check_open()
        if not self._enabled:
            return
        self._columns.append(col)
        self._max_ts_ns = max(self._max_ts_ns, col.t0_ns)

    def record_trade(self, t: Trade) -> None:
        self._check_open()
        if not self._enabled:
            return
        self._trades.append(t)
        self._max_ts_ns = max(self._max_ts_ns, t.ts_ns)

    def record_marker(self, m: Marker) -> None:
        self._check_open()
        if not self._enabled:
            return
        self._markers.append(m)
        self._max_ts_ns = max(self._max_ts_ns, m.ts_ns)

    # -- flush / close ---------------------------------------------------------

    def flush(self) -> None:
        """Write all buffered rows to new Parquet part files and clear the
        buffers. One file per (hour, kind) that has rows; nothing is written
        for empty buffers."""
        if not self._enabled:
            return
        self._flush_kind("columns", self._columns, lambda c: c.t0_ns, self._columns_frame)
        self._flush_kind("trades", self._trades, lambda t: t.ts_ns, self._trades_frame)
        self._flush_kind("markers", self._markers, lambda m: m.ts_ns, self._markers_frame)
        # Epochs carry no timestamp: bucket into the newest hour seen so far
        # (hour 0 if nothing timestamped was ever recorded). load_tail reads
        # every epochs file, so the bucket never affects correctness.
        self._flush_kind("epochs", self._epochs, lambda _e: self._max_ts_ns, self._epochs_frame)

    def _flush_kind(self, kind, rows, ts_of, to_frame) -> None:
        if not rows:
            return
        assert self._dir is not None
        groups: dict[str, list] = {}
        for r in rows:
            groups.setdefault(_hour_key(ts_of(r)), []).append(r)
        for hour in sorted(groups):
            path = self._dir / f"{hour}-{kind}-{self._part:06d}.parquet"
            self._part += 1
            to_frame(groups[hour]).write_parquet(path)
        rows.clear()

    @staticmethod
    def _columns_frame(cols: list[FinalizedColumn]) -> pl.DataFrame:
        return pl.DataFrame(
            {
                "epoch": [c.epoch for c in cols],
                "col_seq": [c.col_seq for c in cols],
                "t0_ns": [c.t0_ns for c in cols],
                # f16 -> f32 is exact; stored as list[f32] (Parquet has no f16).
                "bid": [np.asarray(c.bid, dtype=np.float32) for c in cols],
                "ask": [np.asarray(c.ask, dtype=np.float32) for c in cols],
                "o": [c.bar.o for c in cols],
                "h": [c.bar.h for c in cols],
                "l": [c.bar.l for c in cols],
                "c": [c.bar.c for c in cols],
                "vol_buy": [c.bar.vol_buy for c in cols],
                "vol_sell": [c.bar.vol_sell for c in cols],
                "cvd_cum": [c.bar.cvd_cum for c in cols],
                "vwap_num_cum": [c.bar.vwap_num_cum for c in cols],
                "vwap_den_cum": [c.bar.vwap_den_cum for c in cols],
            },
            schema=_COLUMNS_SCHEMA,
        )

    @staticmethod
    def _trades_frame(trades: list[Trade]) -> pl.DataFrame:
        return pl.DataFrame(
            {
                "ts_ns": [t.ts_ns for t in trades],
                "price": [t.price for t in trades],
                "size": [t.size for t in trades],
                "side": [t.side for t in trades],
                "side_src": [t.side_src for t in trades],
                "venue": [t.venue for t in trades],
            },
            schema=_TRADES_SCHEMA,
        )

    @staticmethod
    def _markers_frame(markers: list[Marker]) -> pl.DataFrame:
        return pl.DataFrame(
            {
                "ts_ns": [m.ts_ns for m in markers],
                "kind": [m.kind for m in markers],
                "text": [m.text for m in markers],
                "price": [m.price for m in markers],
                "size": [m.size for m in markers],
            },
            schema=_MARKERS_SCHEMA,
        )

    @staticmethod
    def _epochs_frame(epochs: list[EpochParams]) -> pl.DataFrame:
        return pl.DataFrame(
            {
                "epoch": [e.epoch for e in epochs],
                "tick": [e.tick for e in epochs],
                "tick_multiple": [e.tick_multiple for e in epochs],
                "dt_ns": [e.dt_ns for e in epochs],
                "p0": [e.p0 for e in epochs],
                "rows": [e.rows for e in epochs],
            },
            schema=_EPOCHS_SCHEMA,
        )

    def close(self) -> None:
        """Flush any buffered rows and reject further writes."""
        if self._closed:
            return
        self.flush()
        self._closed = True


class Recorder:
    """Recording root: opens per-symbol writers, loads tails, prunes."""

    def __init__(self, base_dir: Path, gb_cap: float, *, enabled: bool = True) -> None:
        self._base = Path(base_dir)
        self._cap_bytes = int(gb_cap * _GB)
        self._enabled = enabled

    def open_session(self, market: str, symbol: str) -> SessionRecorder:
        """Create the append-only writer for one (market, symbol). When
        recording is disabled the writer no-ops and touches no filesystem."""
        if not self._enabled:
            return SessionRecorder(None, enabled=False)
        d = self._symbol_dir(market, symbol)
        d.mkdir(parents=True, exist_ok=True)
        return SessionRecorder(d, enabled=True)

    def _symbol_dir(self, market: str, symbol: str) -> Path:
        return self._base / _safe_component(market) / _safe_component(symbol)

    # -- tail load -------------------------------------------------------------

    def load_tail(
        self,
        market: str,
        symbol: str,
        *,
        max_age_ns: int,
        now_ns: int,
        limit_cols: int,
    ) -> TailData | None:
        """The newest recorded columns for (market, symbol) that satisfy
        ``t0_ns >= now_ns - max_age_ns``, capped at ``limit_cols``, plus every
        epoch they reference and the trades/markers inside their time range.

        Returns ``None`` when recording is disabled, nothing fresh exists, or
        the epochs referenced by the surviving columns were pruned (the
        recording is then unusable for rehydration — spec §8.1 says cold
        start + gap marker, which is the caller's job).
        """
        if not self._enabled or limit_cols <= 0:
            return None
        d = self._symbol_dir(market, symbol)
        if not d.is_dir():
            return None
        cutoff = now_ns - max_age_ns

        # Newest -> oldest over part files (filename order == chronological);
        # stop as soon as we have limit_cols or hit an entirely-stale file.
        frames: list[pl.DataFrame] = []
        have = 0
        for path in sorted(d.glob("*-columns-*.parquet"), key=_by_name, reverse=True):
            df = pl.read_parquet(path)
            if df.height == 0:
                continue
            fresh = df.filter(pl.col("t0_ns") >= cutoff)
            if fresh.height:
                frames.append(fresh)
                have += fresh.height
                if have >= limit_cols:
                    break
            elif int(df["t0_ns"].max()) < cutoff:
                break  # older files are older still
        if not frames:
            return None
        table = pl.concat(frames).sort("col_seq").tail(limit_cols)

        columns = [self._column_from_row(row) for row in table.iter_rows(named=True)]

        # Every epoch referenced by the loaded columns must be resolvable.
        needed = {c.epoch for c in columns}
        epoch_map: dict[int, EpochParams] = {}
        for path in sorted(d.glob("*-epochs-*.parquet"), key=_by_name):
            for row in pl.read_parquet(path).iter_rows(named=True):
                epoch_map[int(row["epoch"])] = EpochParams(
                    epoch=int(row["epoch"]),
                    tick=row["tick"],
                    tick_multiple=int(row["tick_multiple"]),
                    dt_ns=int(row["dt_ns"]),
                    p0=row["p0"],
                    rows=int(row["rows"]),
                )
        if not needed.issubset(epoch_map):
            return None  # epochs pruned: recording unusable -> cold start
        epochs = [epoch_map[e] for e in sorted(needed)]

        # Trades/markers within the loaded column range [t0_min, t0_max + dt).
        t_lo = columns[0].t0_ns
        t_hi = columns[-1].t0_ns + epoch_map[columns[-1].epoch].dt_ns
        in_range = (pl.col("ts_ns") >= t_lo) & (pl.col("ts_ns") < t_hi)
        trades = [
            Trade(
                ts_ns=int(row["ts_ns"]),
                price=row["price"],
                size=row["size"],
                side=int(row["side"]),
                side_src=int(row["side_src"]),
                venue=row["venue"],
            )
            for path in sorted(d.glob("*-trades-*.parquet"), key=_by_name)
            for row in pl.read_parquet(path).filter(in_range).iter_rows(named=True)
        ]
        trades.sort(key=lambda t: t.ts_ns)
        markers = [
            Marker(
                ts_ns=int(row["ts_ns"]),
                kind=row["kind"],
                text=row["text"],
                price=row["price"],
                size=row["size"],
            )
            for path in sorted(d.glob("*-markers-*.parquet"), key=_by_name)
            for row in pl.read_parquet(path).filter(in_range).iter_rows(named=True)
        ]
        markers.sort(key=lambda m: m.ts_ns)

        return TailData(
            epochs=epochs,
            columns=columns,
            trades=trades,
            markers=markers,
            newest_t0_ns=columns[-1].t0_ns,
        )

    @staticmethod
    def _column_from_row(row: dict) -> FinalizedColumn:
        epoch = int(row["epoch"])
        col_seq = int(row["col_seq"])
        t0_ns = int(row["t0_ns"])
        # f32 -> f16 is bit-lossless here: every stored value is an exact f16.
        bid = np.asarray(row["bid"], dtype=np.float32).astype(np.float16)
        ask = np.asarray(row["ask"], dtype=np.float32).astype(np.float16)
        bar = BarColumn(
            # Identity fields equal the column's (grid invariant, see module doc).
            epoch=epoch,
            col_seq=col_seq,
            t0_ns=t0_ns,
            o=row["o"],
            h=row["h"],
            l=row["l"],
            c=row["c"],
            vol_buy=row["vol_buy"],
            vol_sell=row["vol_sell"],
            cvd_cum=row["cvd_cum"],
            vwap_num_cum=row["vwap_num_cum"],
            vwap_den_cum=row["vwap_den_cum"],
        )
        return FinalizedColumn(
            epoch=epoch, col_seq=col_seq, t0_ns=t0_ns, bid=bid, ask=ask, bar=bar
        )

    # -- retention -------------------------------------------------------------

    def enforce_retention(self) -> list[Path]:
        """Prune recordings until total ``*.parquet`` size fits the cap.

        Deletes the lexicographically oldest files first — by *filename*
        (hour prefix + part counter), globally across symbols and kinds; see
        the module docstring for the tradeoff. Never reads clocks or mtimes.
        Returns the deleted paths in deletion order.
        """
        if not self._enabled or not self._base.is_dir():
            return []
        files = sorted(self._base.rglob("*.parquet"), key=_by_name)
        sizes = [f.stat().st_size for f in files]
        total = sum(sizes)
        pruned: list[Path] = []
        for f, size in zip(files, sizes):
            if total <= self._cap_bytes:
                break
            f.unlink(missing_ok=True)
            total -= size
            pruned.append(f)
        return pruned
