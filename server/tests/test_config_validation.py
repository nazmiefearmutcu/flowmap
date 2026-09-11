"""Config.from_env range validation (campaign item: a typo'd env var must die
at boot with one clear ValueError naming the var and its allowed range, not
become an opaque supervised crash loop inside Grid/numpy)."""

from __future__ import annotations

import pytest

from flowmap_server.config import Config

CASES = [
    # (env var, a value OUTSIDE the allowed range, range fragment of the message)
    ("FLOWMAP_PORT", "99999", "FLOWMAP_PORT"),
    ("FLOWMAP_PORT", "0", "FLOWMAP_PORT"),
    ("FLOWMAP_RING_COLUMNS", "1000000", "FLOWMAP_RING_COLUMNS"),
    ("FLOWMAP_RING_COLUMNS", "8", "FLOWMAP_RING_COLUMNS"),
    ("FLOWMAP_MAX_SESSIONS", "1000", "FLOWMAP_MAX_SESSIONS"),
    ("FLOWMAP_MAX_SESSIONS", "0", "FLOWMAP_MAX_SESSIONS"),
    ("FLOWMAP_BOOK_TOP_N", "10000000", "FLOWMAP_BOOK_TOP_N"),
    ("FLOWMAP_DT_CRYPTO_NS", "0", "FLOWMAP_DT_CRYPTO_NS"),
    ("FLOWMAP_DT_CRYPTO_NS", "-250000000", "FLOWMAP_DT_CRYPTO_NS"),
    ("FLOWMAP_DT_EQUITY_KEYLESS_NS", "0", "FLOWMAP_DT_EQUITY_KEYLESS_NS"),
    ("FLOWMAP_DT_EQUITY_KEYLESS_GRID_NS", "-1", "FLOWMAP_DT_EQUITY_KEYLESS_GRID_NS"),
    ("FLOWMAP_RECORDING_GB_CAP", "-1", "FLOWMAP_RECORDING_GB_CAP"),
    ("FLOWMAP_BACKFILL_MAX_COLS", "-5", "FLOWMAP_BACKFILL_MAX_COLS"),
    ("FLOWMAP_FLUSH_INTERVAL_S", "0", "FLOWMAP_FLUSH_INTERVAL_S"),
    ("FLOWMAP_FLUSH_INTERVAL_S", "999999", "FLOWMAP_FLUSH_INTERVAL_S"),
    ("FLOWMAP_RETENTION_MIN_INTERVAL_S", "-1", "FLOWMAP_RETENTION_MIN_INTERVAL_S"),
]


@pytest.mark.parametrize(("var", "bad", "name"), CASES)
def test_out_of_range_env_rejected_naming_var(var, bad, name):
    with pytest.raises(ValueError) as ei:
        Config.from_env({var: bad})
    # The message names the env var AND the allowed range.
    assert name in str(ei.value)
    assert "[" in str(ei.value)  # the "[lo, hi]" range fragment


@pytest.mark.parametrize(("var", "bad", "name"), CASES)
def test_range_still_admits_defaults(var, bad, name):
    """The DEFAULT value of every validated var passes its own range (the
    validation may only reject absurd input, never change behavior)."""
    default = Config().from_env({})  # noqa: F841 - sanity that defaults parse
    env_default = {
        "FLOWMAP_PORT": "8720",
        "FLOWMAP_RING_COLUMNS": "32768",
        "FLOWMAP_MAX_SESSIONS": "4",
        "FLOWMAP_BOOK_TOP_N": "20000",
        "FLOWMAP_DT_CRYPTO_NS": "250000000",
        "FLOWMAP_DT_EQUITY_KEYLESS_NS": str(10 * 10**9),
        "FLOWMAP_DT_EQUITY_KEYLESS_GRID_NS": str(10**9),
        "FLOWMAP_RECORDING_GB_CAP": "20.0",
        "FLOWMAP_BACKFILL_MAX_COLS": "512",
        "FLOWMAP_FLUSH_INTERVAL_S": "10.0",
        "FLOWMAP_RETENTION_MIN_INTERVAL_S": "60.0",
    }[var]
    cfg = Config.from_env({var: env_default})
    assert cfg is not None


def test_boundary_values_admitted():
    """Values AT the range edges parse (inclusive bounds)."""
    cfg = Config.from_env(
        {
            "FLOWMAP_PORT": "65535",
            "FLOWMAP_RING_COLUMNS": "65536",
            "FLOWMAP_MAX_SESSIONS": "16",
            "FLOWMAP_BOOK_TOP_N": "1",
            "FLOWMAP_FLUSH_INTERVAL_S": "0.001",
            "FLOWMAP_RETENTION_MIN_INTERVAL_S": "0",
        }
    )
    assert cfg.port == 65535
    assert cfg.ring_columns == 65536
    assert cfg.max_sessions == 16
    assert cfg.book_top_n == 1
    assert cfg.rec_flush_interval_s == 0.001
    assert cfg.retention_min_interval_s == 0.0  # 0 = legacy walk-per-flush


def test_non_numeric_rejected_naming_var():
    with pytest.raises(ValueError) as ei:
        Config.from_env({"FLOWMAP_RING_COLUMNS": "ten-thousand"})
    assert "FLOWMAP_RING_COLUMNS" in str(ei.value)
    with pytest.raises(ValueError) as ei:
        Config.from_env({"FLOWMAP_FLUSH_INTERVAL_S": "soon"})
    assert "FLOWMAP_FLUSH_INTERVAL_S" in str(ei.value)


def test_new_cadence_defaults():
    cfg = Config.from_env({})
    assert cfg.rec_flush_interval_s == 10.0  # FLOWMAP_FLUSH_INTERVAL_S default
    assert cfg.retention_min_interval_s == 60.0
