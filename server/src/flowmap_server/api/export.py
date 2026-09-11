"""GET /api/export — data egress for finalized columns (contract C5).

Streams the last-N FINALIZED columns of an active session's ring as CSV or
JSON, so recordings/live streams can leave the terminal for pandas, Excel or
a post-mortem. Read-only, loopback, no auth (like the whole REST surface).

Selection: ``symbol=`` narrows the candidate sessions (key symbol or the
feed's own symbol); without it the "active" session is chosen
deterministically — live mode preferred, then the freshest newest finalized
column, then the lexicographically first key. ``columns=N`` (default 240) is
clamped to the ring size — the ring IS the retention bound.

Only PUBLIC core accessors are used (grid.history / grid.to_depth / grid.cfg
/ grid.scale / price_scale.row_to_price): the core belongs to another lane.

Shape:
- CSV: one header comment line (symbol/market/tick/dt_ns/rows/columns), one
  CSV header row ``t0_ns,price_lo,price_hi,b0,a0,b1,a1,...`` and one row per
  finalized column: its t0_ns, the grid's price extent (row 0 / row N), then
  the raw bid/ask row values (f32, exactly what the wire carries).
- JSON: ``{"symbol", "tick", "columns": [{"t0", "bids": [...], "asks":
  [...]}]}``.

Both bodies are produced by a generator (nothing materializes whole) and are
size-capped: a worst-case estimate above ``EXPORT_MAX_BYTES`` is refused with
a structured 400 BEFORE any bytes stream.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from flowmap_server.core.grid import FinalizedColumn, Grid
from flowmap_server.core.price_scale import row_to_price

__all__ = ["router", "EXPORT_MAX_BYTES", "EXPORT_DEFAULT_COLUMNS"]

router = APIRouter(prefix="/api")

EXPORT_DEFAULT_COLUMNS = 240
# Hard payload bound. A worst-case estimate over this refuses the request up
# front (structured 400) — the generators themselves never exceed it.
EXPORT_MAX_BYTES = 64 * 1024 * 1024

# history()'s before_t is exclusive; this is "everything finalized so far".
_MAX_T_NS = (1 << 62) - 1
# Worst-case serialized width of one f32 value (str(float) <= ~13 chars for
# f32, json.dumps similar; margin included) for the size pre-check.
_BYTES_PER_VALUE = 26

# The session key carries the RAW Subscribe symbol (subscribe refuses only
# "."/".."; separators are rewritten only for recording paths), so quotes,
# commas, even CR/LF can reach this endpoint's ``content-disposition`` header
# (h11 refuses a header value containing CR/LF — the export would 500) and its
# CSV comment line (an embedded newline would forge data rows). Project every
# symbol/market through this before it touches a header or the CSV header.
_UNSAFE_EXPORT_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_export_name(name: str) -> str:
    """Header/filename/CSV-comment-safe projection of a market/symbol string."""
    cleaned = _UNSAFE_EXPORT_CHARS.sub("_", name).strip("._")
    return cleaned or "session"


def _session_sort_key(item: tuple[tuple, object]) -> tuple[str, ...]:
    """Deterministic sort key for the session table.

    Key elements are ``str | None`` (``source`` is None for replay/plain
    subscribes), so a bare ``sorted()`` raises ``TypeError`` (None < str) the
    moment two sessions agree on (market, symbol, mode, band) but differ in
    source. Map None to "" — deterministic, total, never raises."""
    return tuple("" if part is None else str(part) for part in item[0])


def _pick_session(manager: object, symbol: str | None):
    """The export target session, or None.

    Deterministic "active session" rule: prefer mode='live', then the
    freshest newest finalized column, then key order (defensive getattr
    throughout — health/read surfaces never 500 on an unexpected shape).
    """
    sessions = getattr(manager, "_sessions", None) or {}
    best_key = None
    best_rank: tuple[int, int] | None = None
    best = None
    for key, s in sorted(sessions.items(), key=_session_sort_key):
        feed = getattr(s, "_feed", None)
        sym = str(getattr(feed, "symbol", key[1]) if feed else key[1])
        if symbol is not None and sym != symbol:
            continue
        grid = getattr(s, "_grid", None)
        newest = 0
        if grid is not None:
            try:
                cols = grid.history(_MAX_T_NS, 1)
                newest = int(cols[-1].t0_ns) if cols else 0
            except Exception:  # noqa: BLE001 — an unreadable grid is just not a candidate
                continue
        is_live = 1 if key[2] == "live" else 0
        rank = (is_live, newest)
        if best_rank is None or rank > best_rank:
            best_key, best_rank, best = key, rank, s
    if best is None:
        return None, best_key
    return best, best_key


def _load_columns(grid: Grid, n: int) -> list[FinalizedColumn]:
    cols = grid.history(_MAX_T_NS, n)
    return list(cols)


def _csv_lines(
    grid: Grid,
    cols: list[FinalizedColumn],
    symbol: str,
    market: str,
) -> Iterator[str]:
    """CSV body, one line per finalized column (comment header first)."""
    cfg = grid.cfg
    rows = cfg.rows
    scale = grid.scale
    price_lo = row_to_price(scale, 0.0)
    price_hi = row_to_price(scale, float(rows))
    # The comment line must stay ONE line and header-safe: the symbol is raw
    # Subscribe text, so project it (see _safe_export_name).
    yield (
        f"# symbol={_safe_export_name(symbol)} market={_safe_export_name(market)} "
        f"tick={cfg.tick} "
        f"dt_ns={cfg.dt_ns} rows={rows} columns={len(cols)}\n"
    )
    names = ",".join(f"b{i},a{i}" for i in range(rows))
    yield f"t0_ns,price_lo,price_hi,{names}\n"
    for c in cols:
        depth = grid.to_depth(c)
        bid = depth.bid.tolist()
        ask = depth.ask.tolist()
        values = ",".join(
            f"{b!r},{a!r}" for b, a in zip(bid, ask)
        )
        yield f"{c.t0_ns},{price_lo!r},{price_hi!r},{values}\n"


def _json_chunks(
    grid: Grid,
    cols: list[FinalizedColumn],
    symbol: str,
) -> Iterator[str]:
    """JSON body as stream chunks: ``{"symbol","tick","columns":[...]}``."""
    yield (
        '{"symbol":' + json.dumps(symbol)
        + ',"tick":' + json.dumps(grid.cfg.tick)
        + ',"columns":['
    )
    for i, c in enumerate(cols):
        depth = grid.to_depth(c)
        chunk = json.dumps(
            {
                "t0": c.t0_ns,
                "bids": depth.bid.tolist(),
                "asks": depth.ask.tolist(),
            },
            separators=(",", ":"),
        )
        yield chunk + ("," if i + 1 < len(cols) else "")
    yield "]}"


@router.get("/export")
def export(
    request: Request,
    format: Literal["csv", "json"] = "csv",
    columns: int = EXPORT_DEFAULT_COLUMNS,
    symbol: str | None = None,
) -> StreamingResponse:
    """Stream the last-N finalized columns (C5). Sync handler ON PURPOSE:
    FastAPI serves it from the worker threadpool and Starlette iterates the
    generator there too, so a large export never blocks the event loop
    (same reasoning as /api/recordings)."""
    if columns < 1:
        raise HTTPException(
            status_code=400, detail="columns must be a positive integer"
        )
    manager = getattr(request.app.state, "manager", None)
    session, key = _pick_session(manager, symbol)
    if session is None:
        wanted = f" for symbol {symbol!r}" if symbol else ""
        raise HTTPException(
            status_code=404,
            detail=f"no active session{wanted} to export",
        )
    grid = getattr(session, "_grid", None)
    if grid is None:
        raise HTTPException(
            status_code=404,
            detail=f"session {key!r} has no grid to export",
        )
    # The ring IS the retention bound: clamp instead of erroring.
    n = min(columns, int(grid.cfg.ring_columns))
    feed = getattr(session, "_feed", None)
    sym = str(getattr(feed, "symbol", key[1]) if feed else key[1])
    market = str(getattr(feed, "market", key[0]) if feed else key[0])
    cols = _load_columns(grid, n)
    if not cols:
        raise HTTPException(
            status_code=404,
            detail=f"session for {sym!r} has no finalized columns to export",
        )
    rows = int(grid.cfg.rows)
    # Size pre-check (worst case: 3 numbers + rows*2 values per line/row).
    estimated = len(cols) * (64 + rows * 2 * _BYTES_PER_VALUE)
    if estimated > EXPORT_MAX_BYTES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"export too large: ~{estimated} bytes for {len(cols)} columns "
                f"x {rows} rows exceeds the {EXPORT_MAX_BYTES}-byte cap; "
                f"request fewer columns"
            ),
        )
    if format == "csv":
        return StreamingResponse(
            _csv_lines(grid, cols, sym, market),
            media_type="text/csv; charset=utf-8",
            headers={
                "content-disposition": (
                    f'attachment; filename="export-{_safe_export_name(sym)}.csv"'
                )
            },
        )
    return StreamingResponse(
        _json_chunks(grid, cols, sym),
        media_type="application/json",
        headers={
            "content-disposition": (
                f'attachment; filename="export-{_safe_export_name(sym)}.json"'
            )
        },
    )
