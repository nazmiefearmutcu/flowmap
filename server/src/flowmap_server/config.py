"""FlowMap server configuration.

Single env-first config source (spec §11). The server binds loopback only;
any ``FLOWMAP_HOST`` outside ``("127.0.0.1", "localhost")`` is rejected with
``ValueError`` rather than silently accepted.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

import msgspec

_ALLOWED_HOSTS = ("127.0.0.1", "localhost")
_DEFAULT_DATA_DIR = "~/.flowmap/recordings"


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
    dt_equity_keyless_ns: int = 10 * 10**9
    max_rows: int = 4096

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

        return cls(
            host=host,
            port=int(env.get("FLOWMAP_PORT", "8720")),
            ring_columns=int(env.get("FLOWMAP_RING_COLUMNS", "32768")),
            # Column cadence for the sim + crypto grid. Overridable so the T8
            # scroll-back e2e can drive the sim fast enough to overrun the
            # client's full-res budget in seconds. Default 250 ms (4 cols/s).
            dt_crypto_ns=int(env.get("FLOWMAP_DT_CRYPTO_NS", str(250_000_000))),
            max_sessions=int(env.get("FLOWMAP_MAX_SESSIONS", "4")),
            recording_gb_cap=float(env.get("FLOWMAP_RECORDING_GB_CAP", "20.0")),
            recording_enabled=env.get("FLOWMAP_RECORDING_ENABLED", "1")
            not in ("0", "false", "False"),
            data_dir=str(
                Path(env.get("FLOWMAP_DATA_DIR", _DEFAULT_DATA_DIR)).expanduser()
            ),
            alpaca_key=alpaca_key,
            alpaca_secret=alpaca_secret,
            finnhub_key=env.get("FINNHUB_API_KEY"),
        )
