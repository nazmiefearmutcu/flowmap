"""Env-var readers for the api/ layer.

``config.py`` belongs to the server-core lane, so the WS edge's own knobs are
read here directly from the environment — deliberately at CALL time (not
import time) so operators can change them per boot and tests can monkeypatch
``os.environ`` against a live server. Both helpers are total: an unusable
value falls back to the documented default instead of refusing to serve.

Knobs
-----
``FLOWMAP_WS_ALLOWED_ORIGINS``
    Overrides the built-in browser-origin allow-list with a comma-separated
    list of exact origins (the built-in loopback/tauri policy is REPLACED —
    re-list what you need). The single value ``*`` disables the origin check
    entirely (deployment escape hatch; the server still listens on loopback
    only). Absent/empty ``Origin`` (non-browser clients) is always accepted
    regardless of this setting. Unset -> the built-in policy.

``FLOWMAP_WS_MAX_CONNECTIONS``
    Per-process cap on concurrently served ``/ws`` connections (default 16).
    Over-limit clients are accepted-then-closed with WS close code 1013
    ("try again later") so a browser sees an honest, actionable signal
    instead of a hang. Values below 1 clamp to 1; unparseable values fall
    back to the default.
"""

from __future__ import annotations

import os
from urllib.parse import urlsplit

__all__ = [
    "ENV_WS_ALLOWED_ORIGINS",
    "ENV_WS_MAX_CONNECTIONS",
    "WS_MAX_CONNECTIONS_DEFAULT",
    "origin_allowed",
    "ws_max_connections",
]

ENV_WS_ALLOWED_ORIGINS = "FLOWMAP_WS_ALLOWED_ORIGINS"
ENV_WS_MAX_CONNECTIONS = "FLOWMAP_WS_MAX_CONNECTIONS"
WS_MAX_CONNECTIONS_DEFAULT = 16

# Non-loopback origins always allowed by the built-in policy: the packaged
# Tauri webview serves the SPA from these (windows/ macOS differ) and opens
# its WS from there. Matched exactly (after lowercase).
_TAURI_ORIGINS = frozenset({"tauri://localhost", "https://tauri.localhost"})
# Browser origins on the loopback hosts are trusted regardless of port (vite
# and other dev servers pick free ports). http only — the brief's policy.
# ::1 is the IPv6 loopback: a dev server bound to it (vite -6) sends
# `http://[::1]:<port>` origins that must pass the same trust.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def origin_allowed(origin: str | None, environ: dict[str, str] | None = None) -> bool:
    """The ``/ws`` origin policy (campaign SB item 2).

    Always allowed, regardless of env:

    - absent/empty ``Origin`` — non-browser clients (the Tauri sidecar
      monitor, wscat, tests) never send one; browsers ALWAYS do, so an
      origin-bearing request is the thing to gate.

    Built-in policy (env unset): ``http://127.0.0.1:<any port>``,
    ``http://localhost:<any port>``, ``http://[::1]:<any port>`` (vite and
    local tools), ``tauri://localhost`` and ``https://tauri.localhost`` (the
    packaged desktop webview).

    ``FLOWMAP_WS_ALLOWED_ORIGINS`` REPLACES that browser-origin list with
    its comma-separated entries; the single value ``*`` accepts everything.
    """
    env = os.environ if environ is None else environ
    raw = str(env.get(ENV_WS_ALLOWED_ORIGINS, "")).strip()
    if raw == "*":
        return True
    if origin is None or not origin.strip():
        return True  # non-browser client: no Origin header at all
    o = origin.strip().lower()
    if raw:
        return any(extra.strip() == o for extra in raw.split(","))
    if o in _TAURI_ORIGINS:
        return True
    try:
        parts = urlsplit(o)
    except ValueError:  # pragma: no cover — urlsplit rarely raises
        return False
    return parts.scheme == "http" and (parts.hostname or "") in _LOOPBACK_HOSTS


def ws_max_connections(environ: dict[str, str] | None = None) -> int:
    """Per-process WS connection cap (default 16; see module docstring)."""
    env = os.environ if environ is None else environ
    raw = str(env.get(ENV_WS_MAX_CONNECTIONS, "")).strip()
    if not raw:
        return WS_MAX_CONNECTIONS_DEFAULT
    try:
        value = int(raw)
    except ValueError:
        return WS_MAX_CONNECTIONS_DEFAULT
    return max(1, value)
