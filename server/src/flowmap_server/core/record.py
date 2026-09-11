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
  a session and seeded past any parts (and live claims) already on disk, so a
  restarted session never collides with (or sorts before) its predecessor's
  files. CONCURRENT writers on the same (market, symbol) each claim their
  part numbers atomically at write time (an exclusive ``.claim-{n:06d}``
  marker; see :meth:`SessionRecorder._claim_part`) — two live sessions used
  to run independent counters from the same on-disk scan and silently rename
  over each other's parts.
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
import os
import re
import threading
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
# Sentinel "hour key" above every real bucket — the no-upper-bound case of the
# ranged file prune in ``load_tail``.
_HOUR_KEY_MAX = "99991231-99"

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
    # Trailing hybrid-scale fields (H1) mirror EpochParams in proto/events.py:
    # without them a recorded hybrid epoch round-trips as linear and a restart
    # re-bins every live book with the wrong row<->price map. Old recordings
    # written before these columns existed simply lack them — load_tail reads
    # them with defaults, which IS the linear state they were recorded under.
    "scale_kind": pl.Int64,
    "dn_rows": pl.Int64,
    "core_rows": pl.Int64,
    "core_p0": pl.Float64,
    "core_step": pl.Float64,
    "lo_price": pl.Float64,
    "hi_price": pl.Float64,
}


def _hour_key(ts_ns: int) -> str:
    """UTC ``YYYYMMDD-HH`` bucket for an epoch-ns timestamp."""
    return datetime.fromtimestamp(ts_ns // 1_000_000_000, tz=timezone.utc).strftime("%Y%m%d-%H")


# Hour buckets this recorder writes; anything else in a ``*-columns-`` name is
# a stray file the inventory must skip, not crash on (``strptime`` would raise).
_HOUR_KEY_RE = re.compile(r"\d{8}-\d{2}")


def _safe_component(name: str) -> str:
    """Filesystem-safe path component for market/symbol.

    Refuses — with ``ValueError``, like every other invalid input — the
    traversal names ``"."`` and ``".."``. Path separators (``/``, ``\\``,
    ``:``) are rewritten to ``_`` rather than refused: ccxt spellings like
    ``"ETH/BTC"`` and ``"BTC/USDC:USDC"`` are a documented, legitimate input
    class and must keep recording (refusing them would silently disable
    recording for the whole session). A separator-bearing name cannot become
    a traversal once its separators are gone."""
    if name in (".", ".."):
        raise ValueError(f"invalid recording path component: {name!r}")
    for ch in "/\\:":
        name = name.replace(ch, "_")
    return name or "_"


def _hour_start_ns(key: str) -> int:
    """UTC ns for the START of a ``YYYYMMDD-HH`` hour bucket (the inverse of
    :func:`_hour_key` at hour resolution)."""
    dt = datetime.strptime(key, "%Y%m%d-%H").replace(tzinfo=timezone.utc)
    return int(dt.timestamp()) * 1_000_000_000


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
        # Serializes part-number allocation between THIS recorder's threads
        # (the session flushes from an executor thread; close() may run on the
        # loop while that write is still in flight). Cross-WRITER exclusion is
        # the exclusive .claim marker, not this lock.
        self._part_lock = threading.Lock()
        self._part = self._scan_next_part() if self._enabled else 0

    def _scan_next_part(self) -> int:
        """Seed the part counter past anything already on disk — landed parts
        AND live ``.claim-*`` markers from concurrent/crashed writers — so a
        restart never collides and lexicographic file order stays
        chronological. The first actual claim re-validates exclusively (see
        :meth:`_claim_part`): a stale scan can never double-allocate."""
        assert self._dir is not None
        newest = -1
        for p in self._dir.glob("*.parquet"):
            tail = p.stem.rsplit("-", 1)[-1]
            if tail.isdigit():
                newest = max(newest, int(tail))
        for p in self._dir.glob(".claim-*"):
            tail = p.name[len(".claim-") :]
            if tail.isdigit():
                newest = max(newest, int(tail))
        return newest + 1

    def _claim_part(self, kind: str, hour: str) -> tuple[int, Path, Path, Path]:
        """Atomically claim this writer's next unused part number.

        Returns ``(n, path, tmp, marker)``. Two live recorders on the same
        (market, symbol) each scan the same directory at open and would
        otherwise count from the same number — their ``os.replace`` final
        writes silently clobber each other and a whole recording is lost.
        The claim is an exclusive ``O_CREAT|O_EXCL`` marker file, so exactly
        one writer can hold a number no matter how the open-time scans raced.
        The caller releases the marker once the part lands (the parquet then
        guards its own number) or on failure (nothing landed: the number
        returns to the pool). A crash between claim and rename leaves the
        tiny marker behind; scanners count it, so the number is never
        reused.
        """
        assert self._dir is not None
        while True:
            with self._part_lock:
                n = self._part
                path = self._dir / f"{hour}-{kind}-{n:06d}.parquet"
                marker = self._dir / f".claim-{n:06d}"
                if path.exists():
                    self._part = n + 1  # landed elsewhere: number spent
                    continue
                try:
                    fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                except FileExistsError:
                    self._part = n + 1  # another writer holds the number
                    continue
                os.close(fd)
                if path.exists():
                    # A raced writer landed this exact part between our two
                    # checks (its claim release can interleave with our
                    # marker create): give the number back untouched.
                    marker.unlink(missing_ok=True)
                    self._part = n + 1
                    continue
                tmp = path.with_name(path.name + ".tmp")  # no glob matches *.tmp
                self._part = n + 1
            return n, path, tmp, marker

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
                _n, path, tmp, marker = self._claim_part(kind, hour)
                try:
                    to_frame(groups[hour]).write_parquet(tmp)
                    tmp.replace(path)  # atomic os.replace on the same fs
                except BaseException:
                    tmp.unlink(missing_ok=True)
                    marker.unlink(missing_ok=True)  # nothing landed: number reusable
                    raise
                marker.unlink(missing_ok=True)  # landed: the part guards its number
                groups[hour] = []  # landed: never re-written on a retry
        finally:
            # Keep only the rows of groups that did NOT land.
            rows[:] = [r for group in groups.values() for r in group]

    def take_buffers(self) -> tuple[list, list, list, list] | None:
        """Detach the buffered rows for one off-loop flush.

        Called on the owner's thread (the asyncio loop): swapping the buffer
        lists out here means a flush running in an executor thread touches
        ONLY the snapshot — rows recorded while it writes stay in the live
        buffers and land in the next flush, with no shared mutable state.
        Returns ``None`` when every buffer is empty (callers skip the thread
        hop instead of writing nothing)."""
        if not (self._columns or self._trades or self._markers or self._epochs):
            return None
        bufs = (self._columns, self._trades, self._markers, self._epochs)
        self._columns, self._trades, self._markers, self._epochs = [], [], [], []
        return bufs

    def restore_buffers(self, bufs: tuple[list, list, list, list]) -> None:
        """Re-attach a FAILED flush's unwritten rows to the live buffers.

        ``flush_buffers`` leaves whatever did not land on disk in the snapshot
        lists. The owning session now RETRIES transient flush failures after
        a cooldown (session docstring) instead of disabling recording, so
        those rows must return to the FRONT of the live buffers — they are
        the OLDEST rows of the failed snapshot, and prepending keeps buffer
        order chronological. Without the restore, a retry would silently skip
        everything the failed flush was holding."""
        columns, trades, markers, epochs = bufs
        if columns:
            self._columns[:0] = columns
        if trades:
            self._trades[:0] = trades
        if markers:
            self._markers[:0] = markers
        if epochs:
            self._epochs[:0] = epochs

    def flush_buffers(self, bufs: tuple[list, list, list, list]) -> None:
        """Write a :meth:`take_buffers` snapshot to part files.

        Same per-(hour, kind) grouping, temp+rename atomicity, part-number
        progression, and exception-safety as :meth:`flush` — safe to run off
        the event loop because it touches only the snapshot lists plus the
        locked part counter. On failure the UNWRITTEN rows stay in the
        snapshot lists; the owning session restores them to the live buffers
        (:meth:`restore_buffers`) and retries after a cooldown — a transient
        IO failure delays a part, it does not end the recording."""
        columns, trades, markers, epochs = bufs
        self._flush_kind("columns", columns, lambda c: c.t0_ns, self._columns_frame)
        self._flush_kind("trades", trades, lambda t: t.ts_ns, self._trades_frame)
        self._flush_kind("markers", markers, lambda m: m.ts_ns, self._markers_frame)
        # Epochs carry no timestamp: bucket into the newest hour seen so far
        # (hour 0 if nothing timestamped was ever recorded). load_tail reads
        # every epochs file, so the bucket never affects correctness.
        self._flush_kind("epochs", epochs, lambda _e: self._max_ts_ns, self._epochs_frame)

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
                "scale_kind": [e.scale_kind for e in epochs],
                "dn_rows": [e.dn_rows for e in epochs],
                "core_rows": [e.core_rows for e in epochs],
                "core_p0": [e.core_p0 for e in epochs],
                "core_step": [e.core_step for e in epochs],
                "lo_price": [e.lo_price for e in epochs],
                "hi_price": [e.hi_price for e in epochs],
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
        # Retention walks now run in executor threads (one per flushing
        # session): the lock keeps two walks from racing each other's
        # rglob/unlink pass. Works from both loop and worker threads.
        self._retention_lock = threading.Lock()

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
        end_ns: int | None = None,
    ) -> TailData | None:
        """The newest recorded columns for (market, symbol) that satisfy
        ``t0_ns >= now_ns - max_age_ns`` (and, when *end_ns* is given,
        ``t0_ns < end_ns`` — the inclusive-exclusive upper bound a WINDOWED
        replay needs; default ``None`` keeps the open-ended behavior), capped
        at ``limit_cols``, plus every epoch they reference and the
        trades/markers inside their time range.

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
        upper = None if end_ns is None else max(0, end_ns)

        # Ranged read: a columns file whose hour prefix ends before the
        # cutoff hour cannot contain fresh rows — never open it. Symmetric on
        # the upper side: a file whose hour bucket starts at/after the end
        # bucket cannot contain ``t0 < end_ns`` rows.
        cut_key = _hour_key(max(cutoff, 0))
        hi_key = _HOUR_KEY_MAX if upper is None else _hour_key(max(upper - 1, 0))
        candidates = [
            p
            for p in d.glob("*-columns-*.parquet")
            if cut_key <= _hour_prefix(p) <= hi_key
        ]
        # Newest -> oldest over part files (filename order == chronological);
        # stop as soon as we have limit_cols or hit an entirely-stale file.
        # A file entirely ABOVE the window (possible with *end_ns*) yields no
        # fresh rows but must NOT stop the scan — older files can still hold
        # in-window rows.
        fresh_expr = (
            (pl.col("t0_ns") >= cutoff)
            if upper is None
            else (pl.col("t0_ns") >= cutoff) & (pl.col("t0_ns") < upper)
        )
        frames: list[pl.DataFrame] = []
        have = 0
        for path in sorted(candidates, key=_by_name, reverse=True):
            df = _read_parquet_safe(path)
            if df is None or df.height == 0:
                continue  # unreadable (warned) or empty: try the next-older part
            fresh = df.filter(fresh_expr)
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

        # Resolve epochs BEFORE materializing columns: the row count comes from
        # the epochs (and the vectorized bid/ask reshape below needs it).
        needed_epochs = set(table["epoch"].to_numpy().tolist())
        epoch_map: dict[int, EpochParams] = {}
        for path in sorted(d.glob("*-epochs-*.parquet"), key=_by_name):
            df = _read_parquet_safe(path)
            if df is None:
                continue
            for row in df.iter_rows(named=True):
                # .get with the linear defaults: recordings written before the
                # hybrid-scale columns existed (H1) must load as the linear
                # state they were recorded under, not crash on a missing key.
                epoch_map[int(row["epoch"])] = EpochParams(
                    epoch=int(row["epoch"]),
                    tick=row["tick"],
                    tick_multiple=int(row["tick_multiple"]),
                    dt_ns=int(row["dt_ns"]),
                    p0=row["p0"],
                    rows=int(row["rows"]),
                    scale_kind=int(row.get("scale_kind", 0) or 0),
                    dn_rows=int(row.get("dn_rows", 0) or 0),
                    core_rows=int(row.get("core_rows", 0) or 0),
                    core_p0=float(row.get("core_p0", 0.0) or 0.0),
                    core_step=float(row.get("core_step", 0.0) or 0.0),
                    lo_price=float(row.get("lo_price", 0.0) or 0.0),
                    hi_price=float(row.get("hi_price", 0.0) or 0.0),
                )
        if not needed_epochs.issubset(epoch_map):
            return None  # epochs pruned: recording unusable -> cold start

        try:
            columns = self._columns_from_table(table, epoch_map)
        except (ValueError, TypeError) as exc:
            # A ragged/corrupt column block must degrade to a cold start (§8.1)
            # like every other unusable tail — not disable recording for the
            # whole session by escaping into _boot's except.
            logger.warning("recorded column arrays unusable (%s); cold start", exc)
            return None

        # Trades/markers within the loaded column range [t0_min, t_hi), where
        # t_hi is the last column's interval end clamped by *upper* when a
        # windowed read asked for one. Ranged read: only open files whose
        # hour prefix intersects the window.
        t_lo = columns[0].t0_ns
        t_hi = columns[-1].t0_ns + epoch_map[columns[-1].epoch].dt_ns
        if upper is not None:
            t_hi = min(t_hi, upper)
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
            epochs=[epoch_map[e] for e in sorted(needed_epochs)],
            columns=columns,
            trades=trades,
            markers=markers,
            newest_t0_ns=columns[-1].t0_ns,
        )

    def newest_column_t0(self, market: str, symbol: str) -> int | None:
        """Newest recorded column ``t0_ns`` on disk — the freshness probe the
        SessionManager uses to re-validate a parked replay session on
        re-attach (a replay feed is a snapshot of the recording taken when it
        was built; growth past its tail means the parked replay is stale).

        Reads at most ONE part file: part names are chronological, so the
        newest non-empty readable ``*-columns-*`` part holds the globally
        newest ``t0_ns``. Returns ``None`` when recording is disabled or no
        readable column data exists — callers must treat "unknown" as
        not-stale rather than inventing staleness they cannot see.
        """
        if not self._enabled:
            return None
        d = self._symbol_dir(market, symbol)
        if not d.is_dir():
            return None
        for path in sorted(d.glob("*-columns-*.parquet"), key=_by_name, reverse=True):
            df = _read_parquet_safe(path)
            if df is None or df.height == 0:
                continue  # unreadable (warned) or empty: try the next-older part
            return int(df["t0_ns"].max())
        return None

    @staticmethod
    def _columns_from_table(
        table: pl.DataFrame, epoch_map: dict[int, EpochParams]
    ) -> list[FinalizedColumn]:
        """Materialize FinalizedColumns columnar-ly (H3).

        The bid/ask ``List(Float32)`` columns hold ``height × rows`` values; a
        per-row ``iter_rows`` pass materialized ~134M Python floats at a full
        32 768-column × 2048-row ring and blocked the first attach for tens of
        seconds. The two list columns flatten to one numpy f32 block each and
        reshape in C; only the 13 scalar columns walk Python. The f32 → f16
        cast is bit-lossless: every stored value is an exact f16.
        """
        height = table.height
        rows = int(epoch_map[int(table["epoch"][-1])].rows)
        bid = (
            np.ascontiguousarray(table["bid"].list.explode().to_numpy(), dtype=np.float32)
            .astype(np.float16)
            .reshape(height, rows)
        )
        ask = (
            np.ascontiguousarray(table["ask"].list.explode().to_numpy(), dtype=np.float32)
            .astype(np.float16)
            .reshape(height, rows)
        )
        out: list[FinalizedColumn] = []
        for i, row in enumerate(table.drop(["bid", "ask"]).iter_rows(named=True)):
            epoch = int(row["epoch"])
            col_seq = int(row["col_seq"])
            t0_ns = int(row["t0_ns"])
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
            out.append(
                FinalizedColumn(
                    epoch=epoch, col_seq=col_seq, t0_ns=t0_ns, bid=bid[i], ask=ask[i], bar=bar
                )
            )
        return out

    # -- retention -------------------------------------------------------------

    def load_all(self, market: str, symbol: str) -> TailData | None:
        """Every recorded column for a symbol — the replay data source.

        Same machinery/contract as :meth:`load_tail` (dedup, epoch resolution,
        corrupt-file tolerance) with the freshness window and column cap
        removed: ``cutoff`` collapses to 0 and ``limit`` to effectively
        unbounded. ``None`` when nothing usable is recorded (cold start for a
        replay subscribe is a refusal — the client gets an explicit error)."""
        return self.load_tail(
            market,
            symbol,
            max_age_ns=2**62,
            now_ns=2**62,
            limit_cols=2**31,
        )

    def inventory(self) -> list[dict[str, object]]:
        """Read-only recording inventory (backs ``GET /api/recordings``).

        One row per (market, symbol) directory holding at least one Parquet
        part: total size, part count, and the first/last recorded timestamps
        derived from the columns files' ``YYYYMMDD-HH`` name prefixes — the
        filename metadata the recorder already maintains, so the walk never
        opens a Parquet file (a multi-GB recording lists as cheaply as a
        small one). Timestamps are UTC ns: the first hour bucket's start and
        the last hour bucket's END (hour resolution is what the names
        honestly carry; ``None`` when a symbol has no columns parts)."""
        if not self._enabled or not self._base.is_dir():
            return []
        rows: list[dict[str, object]] = []
        for market_dir in sorted(self._base.iterdir(), key=lambda p: p.name):
            if not market_dir.is_dir():
                continue
            for sym_dir in sorted(market_dir.iterdir(), key=lambda p: p.name):
                if not sym_dir.is_dir():
                    continue
                files = sorted(sym_dir.glob("*.parquet"), key=_by_name)
                if not files:
                    continue
                total = 0
                for f in files:
                    try:
                        total += f.stat().st_size
                    except FileNotFoundError:
                        pass  # pruned concurrently: not part of the total
                hours = sorted(
                    {
                        h
                        for f in files
                        if "-columns-" in f.name
                        and _HOUR_KEY_RE.fullmatch(h := _hour_prefix(f))
                    }
                )
                first_ns = last_ns = None
                if hours:
                    first_ns = _hour_start_ns(hours[0])
                    last_ns = _hour_start_ns(hours[-1]) + 3_600 * 1_000_000_000
                rows.append(
                    {
                        "market": market_dir.name,
                        "symbol": sym_dir.name,
                        "path": sym_dir.relative_to(self._base).as_posix(),
                        "size_bytes": total,
                        "parts": len(files),
                        "first_ts_ns": first_ns,
                        "last_ts_ns": last_ns,
                    }
                )
        return rows

    def enforce_retention(self) -> list[Path]:
        """Prune recordings until total ``*.parquet`` size fits the cap.

        Deletes the lexicographically oldest files first — by *filename*
        (hour prefix + part counter), globally across symbols and kinds —
        with two exemptions (see module docstring): ``*-epochs-*`` files are
        never deleted, and neither is the newest columns part of any symbol.
        The total may therefore remain above the cap when only exempt files
        are left. Never reads clocks or mtimes; tolerates files deleted
        concurrently. Returns the deleted paths in deletion order.

        Serialized by an internal lock: every flushing session runs its own
        walk in an executor thread, and two overlapping rglob/unlink passes
        over the same tree are wasted work at best."""
        if not self._enabled or not self._base.is_dir():
            return []
        with self._retention_lock:
            return self._enforce_retention_locked()

    def _enforce_retention_locked(self) -> list[Path]:
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
