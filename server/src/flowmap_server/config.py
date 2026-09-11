"""FlowMap server configuration.

Single env-first config source (spec §11). The server binds loopback only;
any ``FLOWMAP_HOST`` outside ``("127.0.0.1", "localhost")`` is rejected with
``ValueError`` rather than silently accepted.

Every numeric knob is range-checked in :meth:`Config.from_env` and a violation
raises ``ValueError`` naming the env var and its allowed range. This is
load-bearing, not cosmetics: the sidecar runs supervised (auto-restart), so a
typo'd env value used to become an opaque crash loop — ``np.zeros`` dying
inside ``Grid.__init__`` for ``FLOWMAP_RING_COLUMNS=1000000`` (~8 GB of ring
per session), a bind error for ``FLOWMAP_PORT=99999`` — instead of one clear
boot error. Only ABSURD values are rejected; every default and every
previously-plausible value parses exactly as before.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

import msgspec

_ALLOWED_HOSTS = ("127.0.0.1", "localhost")
_DEFAULT_DATA_DIR = "~/.flowmap/recordings"

# Inclusive ranges for the env-driven numeric knobs (see module docstring).
# Tuples of (lo, hi) so each message names the range it enforces.
_PORT_RANGE = (1, 65_535)
_RING_COLUMNS_RANGE = (256, 65_536)
_MAX_SESSIONS_RANGE = (1, 16)
_BOOK_TOP_N_RANGE = (1, 200_000)
# Column cadences: positive, at most one hour per column (anything larger is
# a unit mixup — seconds/ms pasted into an ns field — not a cadence).
_DT_NS_RANGE = (1, 3_600 * 1_000_000_000)
_RECORDING_GB_CAP_RANGE = (0.0, 1_000_000.0)
_BACKFILL_MAX_COLS_RANGE = (0, 65_536)
# Recording flush cadence (time-based, FLOWMAP_FLUSH_INTERVAL_S): a Windows
# hard-close (TerminateProcess — no lifespan shutdown, no flush_all) loses at
# most this many seconds of buffered recording per active session. Positive
# and at most one hour.
_REC_FLUSH_INTERVAL_S_RANGE = (0.001, 3_600.0)
# Minimum wall-clock interval between retention walks (per session). Default
# 60 s: the rglob+stat pass over the whole recording tree used to run after
# EVERY cadence flush (~every 16 s per session). 0 disables the gating (walk
# after every flush — the old behavior).
_RETENTION_MIN_INTERVAL_S_RANGE = (0.0, 86_400.0)
# Bounded replay load (FLOWMAP_REPLAY_MAX_COLS). A no-window replay subscribe
# used to materialize the ENTIRE recording (multi-GB RAM for long recordings)
# even though any window the client can look at is bounded by the grid ring;
# the no-window path now serves the NEWEST bounded window. 0 (default) = use
# ``ring_columns`` (the same cap the windowed path already applies); a
# positive value overrides it (deeper replay than the ring is legitimate —
# the feed replays columns through, the grid keeps only the newest ring).
# An explicit [start_t, end_t) window is NEVER trimmed by this knob; it stays
# exact apart from the pre-existing ring cap.
_REPLAY_MAX_COLS_RANGE = (0, 65_536)


def _int_in_range(env: Mapping[str, str], name: str, default: str, lo: int, hi: int) -> int:
    raw = env.get(name, default)
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(f"{name} must be an integer in [{lo}, {hi}]; got {raw!r}") from None
    if not (lo <= value <= hi):
        raise ValueError(f"{name} must be in [{lo}, {hi}]; got {raw!r}")
    return value


def _float_in_range(env: Mapping[str, str], name: str, default: str, lo: float, hi: float) -> float:
    raw = env.get(name, default)
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"{name} must be a number in [{lo}, {hi}]; got {raw!r}") from None
    # NaN fails both comparisons; +inf fails the upper bound. Name the var.
    if not (lo <= value <= hi):
        raise ValueError(f"{name} must be in [{lo}, {hi}]; got {raw!r}")
    return value


class Config(msgspec.Struct, frozen=True):
    """Immutable server configuration resolved from environment variables."""

    host: str = "127.0.0.1"
    port: int = 8720
    ring_columns: int = 32_768
    max_sessions: int = 4
    recording_gb_cap: float = 20.0
    recording_enabled: bool = True
    # Recording root (spec §7 self-recording). from_env expands "~"; direct
    # construction may carry an unexpanded default — consumers should
    # ``Path(cfg.data_dir).expanduser()`` defensively.
    data_dir: str = _DEFAULT_DATA_DIR
    alpaca_key: str | None = None
    alpaca_secret: str | None = None
    finnhub_key: str | None = None
    dt_crypto_ns: int = 250_000_000
    dt_equity_keyed_ns: int = 10**9
    # Keyless (SYNTH) equity: last-price POLL cadence (10 s) vs the grid's
    # COLUMN cadence (1 s). The grid re-asserts the resting profile every
    # dt_equity_keyless_grid_ns so the heatmap's right edge keeps advancing
    # (1 col/s) between the slow Yahoo-friendly price polls.
    dt_equity_keyless_ns: int = 10 * 10**9
    dt_equity_keyless_grid_ns: int = 10**9
    max_rows: int = 4096
    # First-launch history backfill (spec: reconstructed candle history so the
    # client's eager requestHistory returns real data instead of a cold ring).
    # ``backfill_max_cols`` bounds the span: at most this many candle-columns are
    # fetched and seeded before the first snapshot. Kept modest (not
    # ``ring_columns`` = 32768, which at 1 m candles would be ~22 days of REST
    # paging and blow past Yahoo's 7-day 1 m window) — 512 aligns with the
    # snapshot depth (SNAPSHOT_COLS) and bounds REST cost to a handful of pages.
    # Reconstructed density is candle volume-at-price, NOT resting-book L2, so
    # the session badges it ``history: 'reconstructed'`` (see core/session.py).
    backfill_enabled: bool = True
    backfill_max_cols: int = 512
    # Depth columns emitted per reconstructed candle (FLOWMAP_BACKFILL_STRETCH,
    # default 16, range 1..240). The candle's density band is repeated across
    # this many consecutive columns with t0s spread over the candle's span, so
    # scroll-back history paints as a continuous field instead of one thin bar
    # per minute. 1 restores the legacy one-column-per-candle layout.
    backfill_stretch: int = 16
    # Levels per side kept when a crypto book is emitted (see feeds/crypto.py
    # BOOK_TOP_N). The cap exists so one array build cannot blow up on a venue
    # that streams a very deep book; it is NOT a fidelity choice, and it is the
    # binding constraint on how far out the wide/full price bands can ever show
    # resting size.
    book_top_n: int = 20_000
    # Crypto grid tick override (0 = auto). The default crypto grid tick is the
    # sim-shaped 0.5, which a re-anchor scales via tick_multiple — correct for
    # majors, but a sub-cent coin collapses into 1-2 rows. A feed that knows
    # its venue tick may declare ``preferred_tick``; this env knob
    # (FLOWMAP_CRYPTO_TICK) overrides both for the whole server when neither
    # path can answer.
    crypto_tick: float = 0.0
    # Time-based recording flush cadence in seconds (FLOWMAP_FLUSH_INTERVAL_S,
    # default 10): in addition to the REC_FLUSH_COLS column-count cadence, a
    # session flushes whenever its buffers have been accumulating for this
    # long — a Windows hard app-close (TerminateProcess, no shutdown hooks)
    # therefore loses at most ~this many seconds of recording, not a whole
    # 64-column part.
    rec_flush_interval_s: float = 10.0
    # Minimum wall-clock seconds between retention walks per session
    # (FLOWMAP_RETENTION_MIN_INTERVAL_S, default 60). The rglob+stat pass over
    # the whole recording tree used to run after every cadence flush; the cap
    # moves at GB scales, so a per-minute re-walk was pure disk churn. 0
    # restores the walk-after-every-flush behavior.
    retention_min_interval_s: float = 60.0
    # Bound on the columns a NO-WINDOW replay subscribe may materialize
    # (FLOWMAP_REPLAY_MAX_COLS). 0 = follow ``ring_columns``; a positive value
    # is an explicit depth. The client's [start_t, end_t) window is never
    # affected by this knob (see _REPLAY_MAX_COLS_RANGE).
    replay_max_cols: int = 0

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Config":
        host = env.get("FLOWMAP_HOST", "127.0.0.1")
        if host not in _ALLOWED_HOSTS:
            raise ValueError(
                f"FLOWMAP_HOST must be one of {_ALLOWED_HOSTS} (loopback only, "
                f"spec §11); got {host!r}"
            )

        # Alpaca credentials are only usable as a pair.
        alpaca_key = env.get("ALPACA_API_KEY")
        alpaca_secret = env.get("ALPACA_API_SECRET")
        if not (alpaca_key and alpaca_secret):
            alpaca_key = None
            alpaca_secret = None

        # 0 = auto (feed-declared preferred_tick, else the sim-shaped fallback).
        crypto_tick = float(env.get("FLOWMAP_CRYPTO_TICK", "0.0"))
        if not (crypto_tick >= 0.0) or crypto_tick == float("inf"):
            raise ValueError(
                f"FLOWMAP_CRYPTO_TICK must be a finite tick size >= 0 "
                f"(0 = auto); got {env.get('FLOWMAP_CRYPTO_TICK')!r}"
            )

        ring_columns = _int_in_range(env, "FLOWMAP_RING_COLUMNS", "32768", *_RING_COLUMNS_RANGE)
        return cls(
            host=host,
            port=_int_in_range(env, "FLOWMAP_PORT", "8720", *_PORT_RANGE),
            ring_columns=ring_columns,
            # Column cadence for the sim + crypto grid. Overridable so the T8
            # scroll-back e2e can drive the sim fast enough to overrun the
            # client's full-res budget in seconds. Default 250 ms (4 cols/s).
            dt_crypto_ns=_int_in_range(
                env, "FLOWMAP_DT_CRYPTO_NS", str(250_000_000), *_DT_NS_RANGE
            ),
            dt_equity_keyless_ns=_int_in_range(
                env, "FLOWMAP_DT_EQUITY_KEYLESS_NS", str(10 * 10**9), *_DT_NS_RANGE
            ),
            dt_equity_keyless_grid_ns=_int_in_range(
                env, "FLOWMAP_DT_EQUITY_KEYLESS_GRID_NS", str(10**9), *_DT_NS_RANGE
            ),
            max_sessions=_int_in_range(
                env, "FLOWMAP_MAX_SESSIONS", "4", *_MAX_SESSIONS_RANGE
            ),
            recording_gb_cap=_float_in_range(
                env, "FLOWMAP_RECORDING_GB_CAP", "20.0", *_RECORDING_GB_CAP_RANGE
            ),
            recording_enabled=env.get("FLOWMAP_RECORDING_ENABLED", "1")
            not in ("0", "false", "False"),
            data_dir=str(
                Path(env.get("FLOWMAP_DATA_DIR", _DEFAULT_DATA_DIR)).expanduser()
            ),
            alpaca_key=alpaca_key,
            alpaca_secret=alpaca_secret,
            book_top_n=_int_in_range(env, "FLOWMAP_BOOK_TOP_N", "20000", *_BOOK_TOP_N_RANGE),
            crypto_tick=crypto_tick,
            finnhub_key=env.get("FINNHUB_API_KEY"),
            backfill_enabled=env.get("FLOWMAP_BACKFILL_ENABLED", "1")
            not in ("0", "false", "False"),
            backfill_max_cols=_int_in_range(
                env, "FLOWMAP_BACKFILL_MAX_COLS", "512", *_BACKFILL_MAX_COLS_RANGE
            ),
            backfill_stretch=_int_in_range(
                env, "FLOWMAP_BACKFILL_STRETCH", "16", 1, 240
            ),
            rec_flush_interval_s=_float_in_range(
                env, "FLOWMAP_FLUSH_INTERVAL_S", "10.0", *_REC_FLUSH_INTERVAL_S_RANGE
            ),
            retention_min_interval_s=_float_in_range(
                env,
                "FLOWMAP_RETENTION_MIN_INTERVAL_S",
                "60.0",
                *_RETENTION_MIN_INTERVAL_S_RANGE,
            ),
            replay_max_cols=_int_in_range(
                env, "FLOWMAP_REPLAY_MAX_COLS", "0", *_REPLAY_MAX_COLS_RANGE
            ),
        )
