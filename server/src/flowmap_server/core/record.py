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
- **Flush is exception-safe.** Each part is written to a ``*.tmp`` name and
  atomically renamed into place (``os.replace``, same filesystem), and a
  group's rows leave the buffer the moment its file lands — so a failure on
  a later group raises WITHOUT resurrecting already-written groups on retry
  (no duplicate col_seqs on disk). As defense in depth the load path also
  dedups columns by ``col_seq`` (newest file wins). A crash mid-write leaves
  at most a ``*.tmp`` orphan, which no glob ever matches.
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
  across symbols and kinds — until the total size is within the cap, with
  two exemptions: ``*-epochs-*`` files are never deleted (they cost bytes
  against a GB-scale cap, and orphaning them would make every surviving
  column unplaceable), and the newest columns part of each symbol always
  survives (so a symbol's tail is never wiped outright). Consequence: the
  total can stay above the cap when only exempt files remain. Retention may
  still delete trades/markers out from under surviving columns; ``load_tail``
  simply returns fewer events. If columns DO end up orphaned from their
  epochs (manual deletion, corruption), ``load_tail`` degrades to ``None``
  (cold start + gap marker per §8.1) rather than serving columns it cannot
  place on a price grid.
- **Corrupt-file tolerance.** ``load_tail`` skips unreadable/truncated
  Parquet files (crash mid-write on the §8.1 restart path) with a warning
  instead of raising; if that leaves no usable fresh columns it returns
  ``None``.
- **Ranged reads.** ``load_tail`` prunes candidate files by their filename
  hour prefix before opening them: columns files entirely before the age
  cutoff, and trades/markers files outside the loaded ``[t_lo, t_hi)``
  window, are never read.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path

import msgspec
import numpy as np
import polars as pl

from flowmap_server.core.grid import FinalizedColumn
from flowmap_server.proto.events import BarColumn, EpochParams, Marker, Trade

__all__ = ["Recorder", "SessionRecorder", "TailData"]

logger = logging.getLogger(__name__)

_GB = 1_000_000_000
_HOUR_KEY_LEN = 11  # "YYYYMMDD-HH" — fixed width, so string compare == time compare

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


def _hour_prefix(p: Path) -> str:
    """The ``YYYYMMDD-HH`` filename prefix (we wrote the name; fixed width)."""
    return p.name[:_HOUR_KEY_LEN]


def _ranged_rows(d: Path, pattern: str, lo_key: str, hi_key: str, in_range: pl.Expr):
    """Yield rows matching ``in_range`` from part files whose filename hour
    prefix intersects ``[lo_key, hi_key]``; out-of-window files are never
    opened and unreadable files are skipped (warned)."""
    for path in sorted(d.glob(pattern), key=_by_name):
        if not (lo_key <= _hour_prefix(path) <= hi_key):
            continue
        df = _read_parquet_safe(path)
        if df is None:
            continue
        yield from df.filter(in_range).iter_rows(named=True)


def _read_parquet_safe(path: Path) -> pl.DataFrame | None:
    """Read a recording part file, tolerating corruption.

    A truncated/garbage file (crash mid-write predates the temp+rename flush,
    or disk damage) must not crash the §8.1 restart path: log a warning and
    skip it. Returns ``None`` when the file is unreadable.
    """
    try:
        return pl.read_parquet(path)
    except (pl.exceptions.PolarsError, OSError) as exc:
        logger.warning("skipping unreadable recording file %s: %s", path, exc)
        return None


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
        """Write all buffered rows to new Parquet part files. One file per
        (hour, kind) that has rows; nothing is written for empty buffers.

        Exception-safe, and RAISES on IO failure: each part is written to a
        ``*.tmp`` name and atomically renamed into place (``os.replace``,
        same filesystem — readers never observe a truncated ``*.parquet``),
        and a group's rows are dropped from the buffer the moment its file
        lands. A failure on a later group therefore propagates with only the
        UNWRITTEN groups still buffered — retrying flush() can never write a
        duplicate col_seq. Callers that must survive IO failure (the T11
        session feed loop) must wrap flush(): log + disable recording for
        the session; never kill the live session over a recording error.
        """
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
        try:
            for hour in sorted(groups):
                path = self._dir / f"{hour}-{kind}-{self._part:06d}.parquet"
                tmp = path.with_name(path.name + ".tmp")  # no glob matches *.tmp
                self._part += 1
                try:
                    to_frame(groups[hour]).write_parquet(tmp)
                    tmp.replace(path)  # atomic os.replace on the same fs
                except BaseException:
                    tmp.unlink(missing_ok=True)
                    raise
                groups[hour] = []  # landed: never re-written on a retry
        finally:
            # Keep only the rows of groups that did NOT land.
            rows[:] = [r for group in groups.values() for r in group]

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

        # Ranged read: a columns file whose hour prefix ends before the
        # cutoff hour cannot contain fresh rows — never open it.
        cut_key = _hour_key(max(cutoff, 0))
        candidates = [
            p for p in d.glob("*-columns-*.parquet") if _hour_prefix(p) >= cut_key
        ]
        # Newest -> oldest over part files (filename order == chronological);
        # stop as soon as we have limit_cols or hit an entirely-stale file.
        frames: list[pl.DataFrame] = []
        have = 0
        for path in sorted(candidates, key=_by_name, reverse=True):
            df = _read_parquet_safe(path)
            if df is None or df.height == 0:
                continue  # unreadable (warned) or empty: try the next-older part
            fresh = df.filter(pl.col("t0_ns") >= cutoff)
            if fresh.height:
                frames.append(fresh)
                have += fresh.height
                if have >= limit_cols:
                    break
            elif int(df["t0_ns"].max()) < cutoff:
                break  # older files are older still
        if not frames:
            return None  # nothing fresh (or every candidate unreadable)
        # Dedup by col_seq (defense in depth against overlapping recordings;
        # frames are newest-file-first, so keep="first" prefers the newest).
        table = (
            pl.concat(frames)
            .unique(subset="col_seq", keep="first", maintain_order=True)
            .sort("col_seq")
            .tail(limit_cols)
        )

        columns = [self._column_from_row(row) for row in table.iter_rows(named=True)]

        # Every epoch referenced by the loaded columns must be resolvable.
        # Epochs files are read in full (tiny, and their hour bucket is
        # heuristic — see module docstring); unreadable ones are skipped.
        needed = {c.epoch for c in columns}
        epoch_map: dict[int, EpochParams] = {}
        for path in sorted(d.glob("*-epochs-*.parquet"), key=_by_name):
            df = _read_parquet_safe(path)
            if df is None:
                continue
            for row in df.iter_rows(named=True):
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

        # Trades/markers within the loaded column range [t0_min, t0_max + dt).
        # Ranged read: only open files whose hour prefix intersects the window.
        t_lo = columns[0].t0_ns
        t_hi = columns[-1].t0_ns + epoch_map[columns[-1].epoch].dt_ns
        lo_key = _hour_key(max(t_lo, 0))
        hi_key = _hour_key(max(t_hi - 1, 0))
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
            for row in _ranged_rows(d, "*-trades-*.parquet", lo_key, hi_key, in_range)
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
            for row in _ranged_rows(d, "*-markers-*.parquet", lo_key, hi_key, in_range)
        ]
        markers.sort(key=lambda m: m.ts_ns)

        return TailData(
            epochs=[epoch_map[e] for e in sorted(needed)],
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
        (hour prefix + part counter), globally across symbols and kinds —
        with two exemptions (see module docstring): ``*-epochs-*`` files are
        never deleted, and neither is the newest columns part of any symbol.
        The total may therefore remain above the cap when only exempt files
        are left. Never reads clocks or mtimes; tolerates files deleted
        concurrently. Returns the deleted paths in deletion order.
        """
        if not self._enabled or not self._base.is_dir():
            return []
        entries: list[tuple[Path, int]] = []
        for f in sorted(self._base.rglob("*.parquet"), key=_by_name):
            try:
                entries.append((f, f.stat().st_size))
            except FileNotFoundError:
                continue  # deleted concurrently: not part of the total
        total = sum(size for _f, size in entries)
        # Protect the newest columns part per symbol dir (entries are sorted
        # ascending by name, so the last seen per parent is the newest).
        newest_columns: dict[Path, Path] = {}
        for f, _size in entries:
            if "-columns-" in f.name:
                newest_columns[f.parent] = f
        protected = set(newest_columns.values())
        pruned: list[Path] = []
        for f, size in entries:
            if total <= self._cap_bytes:
                break
            if "-epochs-" in f.name or f in protected:
                continue
            f.unlink(missing_ok=True)
            total -= size
            pruned.append(f)
        return pruned
